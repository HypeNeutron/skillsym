import { promises as fs } from "node:fs";
import path from "node:path";
import { builtinAgents, groupBySkillsDir, planLinkGroups, type AgentProfile } from "./agents.js";
import { isDirectory, isFile, isMissing } from "./fsutil.js";
import { hashSkillDir, hasUtf8Bom } from "./hash.js";
import type { Hub } from "./hub.js";
import { readLinkTarget } from "./links.js";
import { findLibrarySkills } from "./library.js";
import { readManifest } from "./manifest.js";
import { isValidSkillName } from "./skills.js";
import { readState, samePath, type StateLink } from "./state.js";

export type LinkStatus =
  /** Our link is there and points at the hub skill. */
  | "synced"
  /** Assigned, but nothing is at the path. */
  | "missing"
  /** Our link is there but its target no longer exists (e.g. the hub moved). */
  | "dangling"
  /** We created a link here, but now something else is at the path. */
  | "replaced"
  /** Assigned, but the path holds something skillsym never created. */
  | "blocked"
  /** We created this link, but the manifest no longer assigns it. */
  | "orphaned"
  /** No link needed: the agent loads the skill from another assigned agent's folder. */
  | "covered"
  /** Our link is here although the agent already loads the skill from another folder (loaded twice). */
  | "duplicate"
  /** The skill is linked from a library folder that no longer exists (the library moved or was deleted). */
  | "source-missing";

export interface StatusEntry {
  skill: string;
  /** Agents this path serves (several when they share a folder). Empty for orphaned links. */
  agents: string[];
  path: string;
  status: LinkStatus;
  /** True when state.json records a link skillsym created at this path. */
  owned: boolean;
  /** For "replaced": whether what is there now has the same content as the hub skill. */
  sameContent?: boolean;
  /** Where the link at this path points, if it is a link. */
  linkTarget?: string;
  /** For "covered" and "duplicate": the folder the agent already loads the skill from. */
  coveredBy?: { dir: string; agents: string[] };
}

/** A skill folder in an agent's skills folder that skillsym does not manage. */
export interface UnmanagedEntry {
  name: string;
  path: string;
  /** Agents whose skills folder holds it. */
  agents: string[];
  isLink: boolean;
}

export interface StatusWarning {
  code: "SKILL_MD_BOM" | "UNKNOWN_AGENT_IN_MANIFEST" | "HUB_IN_CLOUD_FOLDER";
  message: string;
  skill?: string;
  path?: string;
}

/** What `add --link` libraries need attention. */
export interface LibraryReport {
  /** Skills linked from a library folder that no longer exists. */
  missing: { skill: string; source: string }[];
  /** Skills in a registered library that are not in the hub yet (not drift). */
  newSkills: { library: string; name: string; path: string }[];
  /** Registered library folders that no longer exist. */
  missingLibraries: string[];
}

export interface StatusReport {
  entries: StatusEntry[];
  unmanaged: UnmanagedEntry[];
  libraries: LibraryReport;
  warnings: StatusWarning[];
  /** True when every entry is synced or covered (unmanaged skills do not count as drift). */
  clean: boolean;
}

export interface ScanOptions {
  profiles?: AgentProfile[];
}

/**
 * Observe the disk and compare it with the manifest and state. Read-only: never writes.
 */
export async function scanStatus(hub: Hub, options: ScanOptions = {}): Promise<StatusReport> {
  const profiles = options.profiles ?? builtinAgents();
  const manifest = await readManifest(hub.manifestPath);
  const state = await readState(hub.statePath);
  const entries: StatusEntry[] = [];
  const warnings: StatusWarning[] = [];
  const expectedPaths: string[] = [];
  const libraries: LibraryReport = { missing: [], newSkills: [], missingLibraries: [] };

  for (const name of Object.keys(manifest.skills).sort()) {
    const target = path.join(hub.skillsDir, name);
    const assigned: AgentProfile[] = [];
    for (const id of manifest.skills[name]!.agents) {
      const profile = profiles.find((p) => p.id === id);
      if (profile) assigned.push(profile);
      else
        warnings.push({
          code: "UNKNOWN_AGENT_IN_MANIFEST",
          message: `Skill "${name}" is assigned to unknown agent "${id}"; it is ignored.`,
          skill: name,
        });
    }
    const entry = manifest.skills[name]!;
    const sourceMissing = entry.mode === "source-link" && !(entry.source && (await isDirectory(entry.source)));
    if (sourceMissing) libraries.missing.push({ skill: name, source: entry.source ?? "" });
    const synced: string[] = [];
    for (const group of planLinkGroups(assigned)) {
      const linkPath = path.join(group.dir, name);
      const ids = group.agents.map((a) => a.id);
      expectedPaths.push(linkPath);
      const owned = state.links.find((l) => samePath(l.path, linkPath));
      if (sourceMissing) {
        entries.push({ skill: name, agents: ids, path: linkPath, status: "source-missing", owned: Boolean(owned) });
        continue;
      }
      // Coverage only counts when the covering link is really there.
      if (group.coveredBy && synced.some((d) => samePath(d, group.coveredBy!.dir))) {
        const onDisk = await readLinkTarget(linkPath);
        const ourLink = Boolean(owned && onDisk && (samePath(onDisk, target) || samePath(onDisk, owned.target)));
        entries.push({
          skill: name,
          agents: ids,
          path: linkPath,
          status: ourLink ? "duplicate" : "covered",
          owned: Boolean(owned),
          coveredBy: group.coveredBy,
          ...(onDisk ? { linkTarget: onDisk } : {}),
        });
        continue;
      }
      const entry = await classify(name, ids, linkPath, target, owned);
      if (entry.status === "synced") synced.push(group.dir);
      entries.push(entry);
    }
    if (await hasBom(path.join(target, "SKILL.md"))) {
      warnings.push({
        code: "SKILL_MD_BOM",
        message: `SKILL.md of "${name}" starts with a UTF-8 BOM; Codex will not load it. Re-save it as UTF-8 without BOM.`,
        skill: name,
        path: path.join(target, "SKILL.md"),
      });
    }
  }

  for (const link of state.links) {
    if (expectedPaths.some((p) => samePath(p, link.path))) continue;
    const onDisk = await readLinkTarget(link.path);
    entries.push({
      skill: link.skill,
      agents: [],
      path: link.path,
      status: "orphaned",
      owned: true,
      ...(onDisk ? { linkTarget: onDisk } : {}),
    });
  }

  for (const library of manifest.libraries ?? []) {
    if (!(await isDirectory(library))) {
      libraries.missingLibraries.push(library);
      continue;
    }
    for (const s of await findLibrarySkills(library)) {
      if ((manifest.skippedLibrarySkills ?? []).some((p) => samePath(p, s.path))) continue;
      if (!manifest.skills[s.name] && isValidSkillName(s.name)) libraries.newSkills.push({ library, name: s.name, path: s.path });
    }
  }

  const unmanaged = await findUnmanaged(profiles, [...expectedPaths, ...state.links.map((l) => l.path)]);
  const clean = entries.every((e) => e.status === "synced" || e.status === "covered") && !libraries.missing.length;
  return { entries, unmanaged, libraries, warnings, clean };
}

async function classify(
  skill: string,
  agents: string[],
  linkPath: string,
  target: string,
  owned: StateLink | undefined,
): Promise<StatusEntry> {
  const base = { skill, agents, path: linkPath, owned: Boolean(owned) };
  let stat;
  try {
    stat = await fs.lstat(linkPath);
  } catch (err) {
    if (isMissing(err)) return { ...base, status: "missing" };
    throw err;
  }

  if (stat.isSymbolicLink()) {
    const linkTarget = (await readLinkTarget(linkPath))!;
    const targetExists = await isDirectory(linkTarget);
    if (samePath(linkTarget, target)) {
      return { ...base, status: targetExists ? "synced" : "dangling", linkTarget };
    }
    if (owned && samePath(linkTarget, owned.target)) {
      // Still our link, aimed at where the hub skill used to be (e.g. after SKILLSYM_HOME moved).
      return { ...base, status: "dangling", linkTarget };
    }
    if (owned) {
      return { ...base, status: "replaced", linkTarget, sameContent: targetExists && (await sameContent(linkTarget, target)) };
    }
    return { ...base, status: "blocked", linkTarget };
  }

  if (!owned) return { ...base, status: "blocked" };
  const same = stat.isDirectory() && (await sameContent(linkPath, target));
  return { ...base, status: "replaced", sameContent: same };
}

async function sameContent(a: string, b: string): Promise<boolean> {
  if (!(await isDirectory(a)) || !(await isDirectory(b))) return false;
  return (await hashSkillDir(a)) === (await hashSkillDir(b));
}

async function findUnmanaged(profiles: AgentProfile[], known: string[]): Promise<UnmanagedEntry[]> {
  const found: UnmanagedEntry[] = [];
  for (const group of groupBySkillsDir(profiles)) {
    let names: string[];
    try {
      names = await fs.readdir(group.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    const reserved = new Set(group.agents.flatMap((a) => a.reserved ?? []));
    for (const name of names.sort()) {
      if (name.startsWith(".") || reserved.has(name)) continue;
      const p = path.join(group.dir, name);
      if (known.some((k) => samePath(k, p))) continue;
      if (!(await isFile(path.join(p, "SKILL.md")))) continue;
      found.push({ name, path: p, agents: group.agents.map((a) => a.id), isLink: (await readLinkTarget(p)) !== null });
    }
  }
  return found;
}

async function hasBom(file: string): Promise<boolean> {
  try {
    const handle = await fs.open(file, "r");
    try {
      const buf = Buffer.alloc(3);
      await handle.read(buf, 0, 3, 0);
      return hasUtf8Bom(buf);
    } finally {
      await handle.close();
    }
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}
