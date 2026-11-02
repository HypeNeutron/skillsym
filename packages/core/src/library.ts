import { promises as fs } from "node:fs";
import path from "node:path";
import { backupStamp, moveToBackup } from "./backup.js";
import { SkillsymError } from "./errors.js";
import { isDirectory, isFile, pathExists } from "./fsutil.js";
import type { Hub } from "./hub.js";
import { hashSkillDir } from "./hash.js";
import { createDirLink, readLinkTarget, removeDirLink } from "./links.js";
import { withLock, type LockOptions } from "./lock.js";
import { readManifest, writeManifest, type Manifest } from "./manifest.js";
import { copyIntoHub, isValidSkillName, type SkillInfo } from "./skills.js";
import { refreshLibrarySnapshots } from "./snapshots.js";
import { samePath } from "./state.js";

/** Folders never searched for skills inside a library. */
const SKIP_DIRS = new Set(["node_modules"]);

export interface LibrarySkill {
  name: string;
  path: string;
}

/**
 * Every skill folder (one containing SKILL.md) under `root`, at any depth, so libraries grouped in
 * category folders work. A skill folder is not searched further; dotfolders (.git, …),
 * node_modules and links are skipped. If `root` itself has a SKILL.md, it is the only skill.
 */
export async function findLibrarySkills(root: string): Promise<LibrarySkill[]> {
  const found: LibrarySkill[] = [];
  async function walk(dir: string): Promise<void> {
    if (await isFile(path.join(dir, "SKILL.md"))) {
      found.push({ name: path.basename(dir), path: dir });
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      // Links are not followed: a library linking into itself must not loop.
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      await walk(path.join(dir, e.name));
    }
  }
  await walk(path.resolve(root));
  return found;
}

/**
 * "add": new to the hub. "repoint" (--link only): a linked skill whose library folder moved; the hub
 * link is pointed at the new place. "adopt" (--link only): the hub holds its own copy with the same
 * content, so the hub folder becomes a link to the library and agents' links keep working.
 * "unchanged" (--link only): already linked from this library. "skip": reported, nothing done.
 */
export type LibraryItemType = "add" | "repoint" | "adopt" | "unchanged" | "skip";

export interface LibraryItem {
  name: string;
  path: string;
  type: LibraryItemType;
  reason?: string;
  /** For "adopt": where the hub's own copy went. */
  backup?: string;
}

export interface LibraryPlan {
  library: string;
  /** True for `add --link`: hub entries link to the library instead of copying it. */
  link: boolean;
  items: LibraryItem[];
}

export interface LibraryOptions {
  /** Link hub entries to the library (the library stays the source of truth) instead of copying. */
  link?: boolean;
  lock?: LockOptions;
}

export interface LibraryAddResult extends LibraryPlan {
  /** Skills whose library snapshot could not be updated. */
  snapshotFailed: string[];
  added: SkillInfo[];
}

/** Decide what adding a library would do. Read-only. */
export async function planLibraryAdd(hub: Hub, libraryPath: string, options: LibraryOptions = {}): Promise<LibraryPlan> {
  const link = Boolean(options.link);
  const library = path.resolve(libraryPath);
  if (!(await isDirectory(library))) {
    throw new SkillsymError("SKILL_NOT_FOUND_AT_PATH", `Not a folder: ${library}`, { path: library });
  }
  const skills = await findLibrarySkills(library);
  if (!skills.length) {
    throw new SkillsymError(
      "MISSING_SKILL_MD",
      `No skills found under ${library} (looked for folders containing SKILL.md, skipping dotfolders and node_modules).`,
      { path: library },
    );
  }
  const manifest = await readManifest(hub.manifestPath);
  const items: LibraryItem[] = [];
  for (const s of skills) {
    const twins = skills.filter((o) => o.name.toLowerCase() === s.name.toLowerCase());
    let reason: string | undefined;
    if (!isValidSkillName(s.name)) reason = `"${s.name}" is not a valid skill name; rename the folder (letters, digits, ".", "_", "-")`;
    else if (twins.length > 1) {
      reason = `the library has ${twins.length} skills named "${s.name}" (${twins.map((t) => path.relative(library, t.path)).join(", ")}); rename all but one`;
    } else if (manifest.skills[s.name] || (await pathExists(path.join(hub.skillsDir, s.name)))) {
      const entry = manifest.skills[s.name];
      if (link && entry?.mode === "source-link" && entry.source && samePath(entry.source, s.path)) {
        items.push({ name: s.name, path: s.path, type: "unchanged" });
        continue;
      } else if (link && entry?.mode === "source-link" && entry.source && !(await isDirectory(entry.source))) {
        items.push({ name: s.name, path: s.path, type: "repoint", reason: `was linked from ${entry.source}, which no longer exists` });
        continue;
      } else if (link && entry && entry.mode !== "source-link" && (await isDirectory(path.join(hub.skillsDir, s.name)))) {
        if ((await hashSkillDir(s.path)) === (await hashSkillDir(path.join(hub.skillsDir, s.name)))) {
          items.push({ name: s.name, path: s.path, type: "adopt" });
          continue;
        }
        reason = `differs from the hub's copy, so nothing changed; make them match and run this again, or rename the folder`;
      } else if (link && entry?.mode === "source-link") {
        reason = `already linked from ${entry.source}; rename the folder to add this one too`;
      } else {
        reason = `a skill named "${s.name}" is already in the hub; remove it first (skillsym remove ${s.name}) or rename the folder`;
      }
    }
    items.push({ name: s.name, path: s.path, type: reason ? "skip" : "add", ...(reason ? { reason } : {}) });
  }
  return { library, link, items };
}

/**
 * Copy every skill in a library into the hub (the hub becomes the source of truth). The library
 * itself is never changed. Skills that cannot be added are reported and skipped; the rest are added.
 */
export async function addLibrary(hub: Hub, libraryPath: string, options: LibraryOptions = {}): Promise<LibraryAddResult> {
  return withLock(
    hub.lockPath,
    async () => {
      const plan = await planLibraryAdd(hub, libraryPath, options);
      const added: SkillInfo[] = [];
      const snapshotFailed: string[] = [];
      const stamp = backupStamp();
      for (const item of plan.items) {
        if (item.type === "add") added.push(plan.link ? await linkIntoHub(hub, item.name, item.path) : await copyIntoHub(hub, item.name, item.path));
        else if (item.type === "repoint") added.push(await repoint(hub, item.name, item.path));
        else if (item.type === "adopt") added.push(await adopt(hub, item, stamp));
      }
      // A library none of whose skills came through is not in use: there is nothing to remember.
      if (plan.link && plan.items.some((i) => i.type !== "skip")) {
        const manifest = await readManifest(hub.manifestPath);
        const libraries = manifest.libraries ?? [];
        if (!libraries.some((l) => samePath(l, plan.library))) manifest.libraries = [...libraries, plan.library];
        // Adding the library again brings back anything taken out of the hub earlier.
        manifest.skippedLibrarySkills = (manifest.skippedLibrarySkills ?? []).filter((s) => !isInside(plan.library, s));
        // Re-pointing leaves the old place empty-handed: a library that is gone with no skills in it is over.
        const inUse = Object.values(manifest.skills).flatMap((e) => (e.mode === "source-link" && e.source ? [e.source] : []));
        const kept: string[] = [];
        for (const known of manifest.libraries ?? []) {
          if (inUse.some((s) => isInside(known, s)) || (await isDirectory(known))) kept.push(known);
        }
        manifest.libraries = kept;
        await writeManifest(hub.manifestPath, manifest);
        snapshotFailed.push(...(await refreshLibrarySnapshots(hub)));
      }
      return { ...plan, added, snapshotFailed };
    },
    options.lock,
  );
}

/** Whether a folder is in a git repository: it or a parent has .git. Looks only; never runs git. */
export async function isInGit(folder: string): Promise<boolean> {
  let dir = path.resolve(folder);
  for (;;) {
    if (await pathExists(path.join(dir, ".git"))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

export function isInside(folder: string, p: string): boolean {
  const rel = path.relative(folder, p);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Call before a --link skill leaves the manifest: `status` must not offer it as new. Once a library
 * has no skills left in the hub, skillsym stops watching it altogether.
 */
export function forgetLibrarySkill(manifest: Manifest, name: string): void {
  const entry = manifest.skills[name];
  if (entry?.mode !== "source-link" || !entry.source) return;
  const source = entry.source;
  const library = manifest.libraries?.find((l) => isInside(l, source));
  if (!library) return;
  const othersLeft = Object.entries(manifest.skills).some(
    ([other, e]) => other !== name && e.mode === "source-link" && e.source !== undefined && isInside(library, e.source),
  );
  if (othersLeft) {
    manifest.skippedLibrarySkills = [...(manifest.skippedLibrarySkills ?? []), source];
  } else {
    manifest.libraries = manifest.libraries!.filter((l) => l !== library);
    manifest.skippedLibrarySkills = (manifest.skippedLibrarySkills ?? []).filter((s) => !isInside(library, s));
  }
}

/**
 * Make `<hub>/skills/<name>` a link to a folder in the user's library. Agents then reach the library
 * through the hub (agent -> hub -> library), so editing the library is enough.
 */
async function linkIntoHub(hub: Hub, name: string, source: string): Promise<SkillInfo> {
  const dest = path.join(hub.skillsDir, name);
  await createDirLink(source, dest);
  const manifest = await readManifest(hub.manifestPath);
  manifest.skills[name] = { agents: [], mode: "source-link", scope: "user", source, sourceHash: await hashSkillDir(source) };
  try {
    await writeManifest(hub.manifestPath, manifest);
  } catch (err) {
    await removeDirLink(dest);
    throw err;
  }
  return { name, path: dest, agents: [], mode: "source-link", scope: "user" };
}

/** Point an existing linked skill at its library folder's new location; agents' links are unaffected. */
/**
 * Swap the hub's own copy for a link to the library. Agents link to the hub path, which stays the same,
 * so they need no change. The copy goes to backups, and comes back if the link cannot be made.
 */
async function adopt(hub: Hub, item: LibraryItem, stamp: string): Promise<SkillInfo> {
  const dest = path.join(hub.skillsDir, item.name);
  const backup = await moveToBackup(hub, dest, "library-adopt", item.name, stamp);
  try {
    await createDirLink(item.path, dest);
  } catch (err) {
    await fs.rename(backup, dest);
    throw err;
  }
  item.backup = backup;
  const manifest = await readManifest(hub.manifestPath);
  const entry = manifest.skills[item.name]!;
  entry.mode = "source-link";
  entry.source = item.path;
  entry.sourceHash = await hashSkillDir(item.path);
  await writeManifest(hub.manifestPath, manifest);
  return { name: item.name, path: dest, agents: [...entry.agents], mode: "source-link", scope: "user" };
}

async function repoint(hub: Hub, name: string, source: string): Promise<SkillInfo> {
  const dest = path.join(hub.skillsDir, name);
  if ((await readLinkTarget(dest)) !== null) await removeDirLink(dest);
  await createDirLink(source, dest);
  const manifest = await readManifest(hub.manifestPath);
  const entry = manifest.skills[name]!;
  entry.source = source;
  entry.sourceHash = await hashSkillDir(source);
  await writeManifest(hub.manifestPath, manifest);
  return { name, path: dest, agents: [...entry.agents], mode: "source-link", scope: "user" };
}
