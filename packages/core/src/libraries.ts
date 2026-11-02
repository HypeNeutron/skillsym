import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { builtinAgents, type AgentProfile } from "./agents.js";
import { SkillsymError } from "./errors.js";
import { isDirectory } from "./fsutil.js";
import type { Hub } from "./hub.js";
import { isInGit, isInside } from "./library.js";
import { createDirLink, readLinkTarget, removeDirLink } from "./links.js";
import { withLock, type LockOptions } from "./lock.js";
import { readManifest, writeManifest, type Manifest } from "./manifest.js";
import { removeSkills, type RemoveResult } from "./remove.js";
import { hasLibrarySnapshot, librarySnapshotDir, removeLibrarySnapshot } from "./snapshots.js";
import { samePath } from "./state.js";

export interface LibraryInfo {
  /** The folder's name; what commands call the library. */
  name: string;
  path: string;
  found: boolean;
  /** Hub skills linked from it. */
  skills: string[];
  git: boolean;
}

function skillsOf(manifest: Manifest, library: string): string[] {
  return Object.keys(manifest.skills)
    .filter((name) => {
      const entry = manifest.skills[name]!;
      return entry.mode === "source-link" && entry.source !== undefined && isInside(library, entry.source);
    })
    .sort();
}

export async function listLibraries(hub: Hub): Promise<LibraryInfo[]> {
  const manifest = await readManifest(hub.manifestPath);
  const result: LibraryInfo[] = [];
  for (const library of manifest.libraries ?? []) {
    const found = await isDirectory(library);
    result.push({ name: path.basename(library), path: library, found, skills: skillsOf(manifest, library), git: found && (await isInGit(library)) });
  }
  return result;
}

/** Find a library by folder name, ignoring case, or by its path. Two with the same name need the path. */
export async function findLibrary(hub: Hub, nameOrPath: string, cwd: string = process.cwd()): Promise<LibraryInfo> {
  const libraries = await listLibraries(hub);
  const byPath = libraries.find((l) => samePath(l.path, path.resolve(cwd, nameOrPath)));
  if (byPath) return byPath;
  const named = libraries.filter((l) => l.name.toLowerCase() === nameOrPath.toLowerCase());
  if (named.length === 1) return named[0]!;
  if (named.length > 1) {
    throw new SkillsymError("LIBRARY_AMBIGUOUS", `${named.length} libraries are named "${nameOrPath}"; use the full path: ${named.map((l) => l.path).join(", ")}`, { name: nameOrPath });
  }
  const known = libraries.map((l) => l.name).join(", ");
  throw new SkillsymError("LIBRARY_NOT_FOUND", `No library named "${nameOrPath}".${known ? ` Libraries: ${known}.` : " Link one with: skillsym add <folder> --link"}`, { name: nameOrPath });
}

export interface UnlinkedSkill {
  skill: string;
  /** "copied": the hub now holds a real copy. "from-snapshot": the library was gone, so the snapshot was used. "lost": neither exists; left as it was. */
  outcome: "copied" | "from-snapshot" | "lost";
}

export interface UnlinkResult {
  library: string;
  skills: UnlinkedSkill[];
  /** False while a skill could not be saved, so the library is still remembered. */
  forgotten: boolean;
}

/**
 * Stop using a library but keep its skills: each hub link becomes a real copy, so agents, whose links
 * point at the hub, carry on. This is `add --link` in reverse. The library itself is never touched.
 */
export async function unlinkLibrary(hub: Hub, library: LibraryInfo, options: { dryRun?: boolean; lock?: LockOptions } = {}): Promise<UnlinkResult> {
  const run = async (): Promise<UnlinkResult> => {
    const manifest = await readManifest(hub.manifestPath);
    const skills: UnlinkedSkill[] = [];
    for (const name of skillsOf(manifest, library.path)) {
      const entry = manifest.skills[name]!;
      const fromLibrary = await isDirectory(entry.source!);
      const outcome: UnlinkedSkill["outcome"] = fromLibrary ? "copied" : (await hasLibrarySnapshot(hub, name)) ? "from-snapshot" : "lost";
      skills.push({ skill: name, outcome });
      if (options.dryRun || outcome === "lost") continue;

      const source = fromLibrary ? await fs.realpath(entry.source!) : librarySnapshotDir(hub, name);
      const dest = path.join(hub.skillsDir, name);
      const staging = path.join(hub.tmpDir, `${name}.${randomBytes(6).toString("hex")}`);
      await fs.cp(source, staging, { recursive: true, errorOnExist: true });
      const linked = await readLinkTarget(dest);
      if (linked !== null) await removeDirLink(dest);
      try {
        await fs.rename(staging, dest);
      } catch (err) {
        await fs.rm(staging, { recursive: true, force: true });
        if (linked !== null) await createDirLink(linked, dest);
        throw err;
      }
      entry.mode = "link";
      await writeManifest(hub.manifestPath, manifest);
      await removeLibrarySnapshot(hub, name);
    }
    const forgotten = skills.every((s) => s.outcome !== "lost");
    if (forgotten && !options.dryRun) await forget(hub, manifest, library.path);
    return { library: library.path, skills, forgotten };
  };
  return options.dryRun ? run() : withLock(hub.lockPath, run, options.lock);
}

async function forget(hub: Hub, manifest: Manifest, library: string): Promise<void> {
  manifest.libraries = (manifest.libraries ?? []).filter((l) => !samePath(l, library));
  manifest.skippedLibrarySkills = (manifest.skippedLibrarySkills ?? []).filter((s) => !isInside(library, s));
  await writeManifest(hub.manifestPath, manifest);
}

/**
 * Take a library's skills out of the hub and every agent, and stop watching it. The library keeps its files.
 */
export async function removeLibrary(hub: Hub, library: LibraryInfo, options: { dryRun?: boolean; profiles?: AgentProfile[] } = {}): Promise<RemoveResult> {
  const profiles = options.profiles ?? builtinAgents();
  const result: RemoveResult = library.skills.length
    ? await removeSkills(hub, { skills: library.skills, profiles, dryRun: options.dryRun ?? false })
    : { links: [], removedSkills: [] };
  if (!options.dryRun) {
    await withLock(hub.lockPath, async () => forget(hub, await readManifest(hub.manifestPath), library.path));
  }
  return result;
}
