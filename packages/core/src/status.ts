import { promises as fs } from "node:fs";
import path from "node:path";
import { agentDelivery, builtinAgents, groupBySkillsDir, planLinkGroups, resolveAgents, type AgentProfile, type DeliveryMode } from "./agents.js";
import { readConfig } from "./config.js";
import { SkillsymError } from "./errors.js";
import { isDirectory, isFile, isMissing } from "./fsutil.js";
import { hashSkillDir, hasUtf8Bom } from "./hash.js";
import type { Hub } from "./hub.js";
import { readLinkTarget } from "./links.js";
import { findLibrarySkills, isInGit, isInside } from "./library.js";
import { readManifest, type Manifest } from "./manifest.js";
import {
  computeSkillsJsonEntries,
  findStateManifest,
  generatedManifestPath,
  hasInheritsRef,
  hashText,
  readGeneratedFile,
  readTargetSkillsJson,
  serializeSkillsJson,
  type SkillsJsonEntry,
} from "./skills-json.js";
import { expandSkillNames, isValidSkillName, listUnregisteredSkills, type UnregisteredSkill } from "./skills.js";
import { readState, samePath, type State, type StateLink } from "./state.js";

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
  /** Delivery mechanism for this entry (omitted or "link" for directory links). */
  delivery?: DeliveryMode;
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
  code: "SKILL_MD_BOM" | "UNKNOWN_AGENT_IN_MANIFEST" | "HUB_IN_CLOUD_FOLDER" | "SKILLS_JSON_BROAD_ENTRY" | "LEGACY_GEMINI_CONFIG" | "SKILLS_JSON_INVALID";
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
  /** Every library skillsym remembers, whether it is there, and how many hub skills link into it. */
  folders: { path: string; found: boolean; skills: number; git: boolean }[];
}

export interface StatusReport {
  entries: StatusEntry[];
  unmanaged: UnmanagedEntry[];
  /** Skill folders in the hub that are not in the manifest; `sync` or `assign` registers them. */
  unregistered: UnregisteredSkill[];
  libraries: LibraryReport;
  warnings: StatusWarning[];
  /** True when every entry is synced or covered and no hub folder is unregistered (unmanaged skills do not count as drift). */
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
  const libraries: LibraryReport = { missing: [], newSkills: [], missingLibraries: [], folders: [] };

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

  await scanSkillsJsonAgents(hub, profiles, manifest, state, entries, warnings);
  await warnLegacyGeminiConfig(hub, profiles, warnings);

  for (const library of manifest.libraries ?? []) {
    const found = await isDirectory(library);
    const skills = Object.values(manifest.skills).filter((e) => e.mode === "source-link" && e.source && isInside(library, e.source)).length;
    libraries.folders.push({ path: library, found, skills, git: found && (await isInGit(library)) });
    if (!found) {
      libraries.missingLibraries.push(library);
      continue;
    }
    for (const s of await findLibrarySkills(library)) {
      if ((manifest.skippedLibrarySkills ?? []).some((p) => samePath(p, s.path))) continue;
      if (!manifest.skills[s.name] && isValidSkillName(s.name)) libraries.newSkills.push({ library, name: s.name, path: s.path });
    }
  }

  const unmanaged = await findUnmanaged(profiles, [...expectedPaths, ...state.links.map((l) => l.path)]);
  const unregistered = await listUnregisteredSkills(hub, manifest);
  const clean = entries.every((e) => e.status === "synced" || e.status === "covered") && !libraries.missing.length && !unregistered.length;
  return { entries, unmanaged, unregistered, libraries, warnings, clean };
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

export interface StatusFilter {
  /** Skill names or patterns ("*" any characters, "?" one). */
  skills?: string[];
  /** Agent ids; "*" = every installed agent. */
  agents?: string[];
  profiles?: AgentProfile[];
}

/**
 * The part of a report about these skills and agents. An entry with no agents (an orphaned link)
 * belongs to the agents whose folder it sits in. A name in neither the hub nor the report is an error.
 */
export async function filterStatus(hub: Hub, report: StatusReport, filter: StatusFilter): Promise<Pick<StatusReport, "entries" | "unmanaged">> {
  const profiles = filter.profiles ?? builtinAgents();
  const chosen = filter.agents?.length ? await resolveAgents(filter.agents, profiles) : undefined;
  let wanted: Set<string> | undefined;
  if (filter.skills?.length) {
    const manifest = await readManifest(hub.manifestPath);
    const known = [...new Set([...Object.keys(manifest.skills), ...report.entries.map((e) => e.skill), ...report.unmanaged.map((u) => u.name), ...report.unregistered.map((u) => u.name)])];
    wanted = new Set(expandSkillNames(filter.skills, known));
    for (const name of wanted) {
      if (!known.includes(name)) throw new SkillsymError("SKILL_NOT_IN_HUB", `No skill named "${name}" in the hub or your agents' folders.`, { skill: name });
    }
  }
  const forAgent = (agents: string[], p: string) =>
    !chosen ||
    chosen.some(
      (a) =>
        agents.includes(a.id) ||
        samePath(a.skillsDir, path.dirname(p)) ||
        (a.skillsJsonPath !== undefined && (samePath(a.skillsJsonPath, p) || p.toLowerCase().startsWith(`${a.skillsJsonPath.toLowerCase()}#`))),
    );
  return {
    entries: report.entries.filter((e) => (!wanted || wanted.has(e.skill)) && forAgent(e.agents, e.path)),
    unmanaged: report.unmanaged.filter((u) => (!wanted || wanted.has(u.name)) && forAgent(u.agents, u.path)),
  };
}

async function findUnmanaged(profiles: AgentProfile[], known: string[]): Promise<UnmanagedEntry[]> {
  const found: UnmanagedEntry[] = [];
  for (const group of [...groupBySkillsDir(profiles), ...extraReadDirs(profiles)]) {
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

/**
 * Folders agents load skills from that are no agent's main folder, such as ~/.codex/skills. Skills
 * kept there count as unmanaged too, or import would miss them and agents would load them twice.
 */
function extraReadDirs(profiles: AgentProfile[]): { dir: string; agents: AgentProfile[] }[] {
  const main = profiles.map((p) => p.skillsDir);
  const extras: { dir: string; agents: AgentProfile[] }[] = [];
  for (const profile of profiles) {
    for (const dir of profile.alsoReads) {
      if (main.some((m) => samePath(m, dir))) continue;
      const known = extras.find((x) => samePath(x.dir, dir));
      if (known) known.agents.push(profile);
      else extras.push({ dir, agents: [profile] });
    }
  }
  return extras;
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

function hasExactGeneratedEntry(text: string, expectedDir: string, folderName: string): boolean {
  try {
    const parsed = JSON.parse(text) as { entries?: SkillsJsonEntry[] };
    if (!parsed || !Array.isArray(parsed.entries)) return false;
    return parsed.entries.some(
      (entry) =>
        typeof entry?.path === "string" &&
        samePath(path.resolve(entry.path), expectedDir) &&
        Array.isArray(entry.include_only) &&
        entry.include_only.includes(folderName),
    );
  } catch {
    return false;
  }
}

async function scanSkillsJsonAgents(
  hub: Hub,
  profiles: AgentProfile[],
  manifest: Manifest,
  state: State,
  entries: StatusEntry[],
  warnings: StatusWarning[],
): Promise<void> {
  const jsonAgents = profiles.filter((p) => agentDelivery(p) === "skills-json");
  for (const agent of jsonAgents) {
    const skillsJsonPath = agent.skillsJsonPath;
    if (!skillsJsonPath) continue;
    const generatedPath = generatedManifestPath(hub, agent.id);
    const owned = findStateManifest(state, agent.id);
    const assignedSkills = Object.keys(manifest.skills)
      .sort()
      .filter((name) => manifest.skills[name]!.agents.includes(agent.id));

    let targetRaw: Record<string, unknown> = {};
    let targetExists = false;
    let targetInvalid: string | undefined;
    try {
      const t = await readTargetSkillsJson(skillsJsonPath);
      targetExists = t.exists;
      targetRaw = t.rawObj;
    } catch (err) {
      targetInvalid = (err as Error).message;
      warnings.push({ code: "SKILLS_JSON_INVALID", message: targetInvalid, path: skillsJsonPath });
    }

    if (targetExists && Array.isArray(targetRaw.entries)) {
      const agyDefault = profiles.find((p) => p.id === "universal")?.skillsDir;
      const broadPaths: string[] = [];
      for (const item of targetRaw.entries) {
        if (typeof item !== "object" || item === null) continue;
        const rec = item as Record<string, unknown>;
        if (typeof rec.path !== "string" || rec.include_only !== undefined || rec.exclude !== undefined) continue;
        const resolved = path.resolve(path.dirname(skillsJsonPath), rec.path);
        if (samePath(resolved, hub.skillsDir) || (agyDefault && samePath(resolved, agyDefault))) {
          broadPaths.push(rec.path);
        }
      }
      if (broadPaths.length) {
        warnings.push({
          code: "SKILLS_JSON_BROAD_ENTRY",
          message: `${skillsJsonPath} lists whole-folder entry (${broadPaths.join(", ")}) without include_only, which bypasses skillsym filtering; run \`skillsym migrate\` to clean it up.`,
          path: skillsJsonPath,
        });
      }
    }

    const gen = await readGeneratedFile(generatedPath);
    const hasInherits = targetExists && hasInheritsRef(targetRaw, skillsJsonPath, generatedPath);

    if (!assignedSkills.length && !owned && !gen.exists && !hasInherits) continue;

    const desired = await computeSkillsJsonEntries(hub, manifest, agent.id);
    const desiredHash = hashText(serializeSkillsJson(desired.entries));
    const genChangedExternally = gen.exists && (!owned || gen.hash !== owned.generatedHash);

    for (const name of assignedSkills) {
      if (desired.missingSourceSkills.includes(name)) {
        entries.push({
          skill: name,
          agents: [agent.id],
          path: `${skillsJsonPath}#${name}`,
          status: "source-missing",
          owned: Boolean(owned?.skills.includes(name)),
          delivery: "skills-json",
        });
        continue;
      }
      if (targetInvalid) {
        entries.push({
          skill: name,
          agents: [agent.id],
          path: skillsJsonPath,
          status: "blocked",
          owned: Boolean(owned),
          delivery: "skills-json",
        });
        continue;
      }
      if (genChangedExternally) {
        entries.push({
          skill: name,
          agents: [agent.id],
          path: skillsJsonPath,
          status: "replaced",
          owned: Boolean(owned),
          sameContent: gen.hash === desiredHash,
          delivery: "skills-json",
        });
        continue;
      }
      const entry = manifest.skills[name]!;
      const expectedDir = entry.mode === "source-link" && entry.source ? path.dirname(entry.source) : hub.skillsDir;
      const folderName = entry.mode === "source-link" && entry.source ? path.basename(entry.source) : name;
      const inGen = Boolean(gen.exists && hasExactGeneratedEntry(gen.text, expectedDir, folderName));
      if (!gen.exists || !hasInherits || !inGen || gen.hash !== desiredHash) {
        const wasDelivered = Boolean(owned?.skills.includes(name));
        const deletedByUser = wasDelivered && (!gen.exists || !hasInherits);
        if (hasInherits && gen.exists && inGen && gen.hash === owned?.generatedHash) {
          entries.push({ skill: name, agents: [agent.id], path: skillsJsonPath, status: "synced", owned: true, delivery: "skills-json" });
        } else {
          entries.push({
            skill: name,
            agents: [agent.id],
            path: skillsJsonPath,
            status: "missing",
            owned: deletedByUser,
            delivery: "skills-json",
          });
        }
        continue;
      }
      entries.push({ skill: name, agents: [agent.id], path: skillsJsonPath, status: "synced", owned: true, delivery: "skills-json" });
    }

    const orphanedSkills = (owned?.skills ?? []).filter((s) => !assignedSkills.includes(s));
    if (orphanedSkills.length) {
      for (const s of orphanedSkills) {
        entries.push({ skill: s, agents: [], path: skillsJsonPath, status: "orphaned", owned: true, delivery: "skills-json" });
      }
    } else if (!assignedSkills.length && (owned || gen.exists || hasInherits)) {
      entries.push({ skill: "(skills-json)", agents: [], path: skillsJsonPath, status: "orphaned", owned: Boolean(owned), delivery: "skills-json" });
    }
  }
}

async function warnLegacyGeminiConfig(hub: Hub, profiles: AgentProfile[], warnings: StatusWarning[]): Promise<void> {
  const antigravity = profiles.find((p) => p.id === "antigravity");
  if (!antigravity) return;
  let config;
  try {
    config = await readConfig(hub.configPath);
  } catch {
    return;
  }
  const legacy = config.agents.find((a) => a.id === "gemini" && samePath(path.resolve(path.dirname(antigravity.skillsDir), path.basename(antigravity.skillsDir)), expandHome(a.skillsDir, antigravity.skillsDir)));
  if (legacy) {
    warnings.push({
      code: "LEGACY_GEMINI_CONFIG",
      message: `${hub.configPath} maps "gemini" to Antigravity's skills folder (${legacy.skillsDir}); run \`skillsym migrate\` to switch to built-in "antigravity" (skills-json delivery).`,
      path: hub.configPath,
    });
  }
}

function expandHome(p: string, antigravitySkillsDir: string): string {
  const home = path.resolve(antigravitySkillsDir, "..", "..", "..");
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(home, p.slice(2));
  return path.resolve(home, p);
}
