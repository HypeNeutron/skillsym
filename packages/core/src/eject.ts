import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { builtinAgents, resolveAgents, type AgentProfile } from "./agents.js";
import { backupStamp, moveToBackup } from "./backup.js";
import { SkillsymError } from "./errors.js";
import { isDirectory, pathExists } from "./fsutil.js";
import type { Hub } from "./hub.js";
import { forgetLibrarySkill } from "./library.js";
import { readLinkTarget, removeDirLink } from "./links.js";
import { withLock, type LockOptions } from "./lock.js";
import { readManifest, writeManifest, type Manifest } from "./manifest.js";
import { readState, samePath, writeState, type State, type StateLink } from "./state.js";

export type EjectOutcome =
  /** Our link was replaced by a real copy of the skill. */
  | "ejected"
  /** Something else is at the path now; left alone. */
  | "left-in-place"
  /** Nothing is at the path any more; just forgotten. */
  | "missing"
  /** The hub has no folder to copy for this link; the link was left alone. */
  | "hub-missing"
  /** The link stays because another agent that keeps the skill reads the same folder. */
  | "kept-shared"
  /** The agent had no link of its own (it sees the skill through another folder); only unassigned. */
  | "unassigned"
  | "failed";

export interface EjectResult {
  skill: string;
  path: string;
  outcome: EjectOutcome;
  error?: string;
}

export interface EjectReport {
  results: EjectResult[];
  /** The hub folder, which eject never deletes. */
  hubHome: string;
  /** Skills that no agent uses any more after ejecting by name or agent, so they left the hub. */
  leftHub: EjectedSkill[];
}

export interface EjectedSkill {
  skill: string;
  /** Where the hub's copy went (absent on a dry run, and for --link skills). */
  backup?: string;
  /** For a skill linked from a library: the library folder, which is left untouched. */
  library?: string;
}

export interface EjectOptions {
  dryRun?: boolean;
  /** Only these skills ("*" = all). */
  skills?: string[];
  /** Only these agents' links. */
  agents?: string[];
  profiles?: AgentProfile[];
  lock?: LockOptions;
}

const STAGING_PREFIX = ".skillsym-eject-";

/**
 * Stop using skillsym without losing anything: every link skillsym created is replaced by a real
 * copy of the skill, so agents keep working even if the hub is deleted afterwards. Paths that no
 * longer hold our link are left alone. Progress is saved after every link, so an interrupted eject
 * can be run again. The hub itself is never deleted.
 *
 * Given skills or agents, only those links change and everything else stays managed. A skill no
 * agent uses afterwards leaves the hub: the real copies now hold it, and its hub folder goes to backups.
 */
export async function eject(hub: Hub, options: EjectOptions = {}): Promise<EjectReport> {
  if (options.skills?.length || options.agents?.length) return ejectSelected(hub, options);
  const run = async (): Promise<EjectReport> => {
    const state = await readState(hub.statePath);
    const results: EjectResult[] = [];
    const dirs = new Set<string>();

    for (const link of [...state.links]) {
      dirs.add(path.dirname(link.path));
      const hubCopy = path.join(hub.skillsDir, link.skill);
      const onDisk = await readLinkTarget(link.path);
      const ours = onDisk !== null && (samePath(onDisk, hubCopy) || samePath(onDisk, link.target));
      let outcome: EjectOutcome;
      if (!ours) outcome = (await pathExists(link.path)) ? "left-in-place" : "missing";
      else if (!(await isDirectory(onDisk!))) outcome = (await isDirectory(hubCopy)) ? "ejected" : "hub-missing";
      else outcome = "ejected";

      const result: EjectResult = { skill: link.skill, path: link.path, outcome };
      results.push(result);
      if (options.dryRun || outcome === "hub-missing") continue;

      try {
        if (outcome === "ejected") {
          // Resolve links (a --link skill is agent -> hub -> library) so real files are copied.
          const source = await fs.realpath((await isDirectory(onDisk!)) ? onDisk! : hubCopy);
          await replaceLinkWithCopy(link.path, source);
        }
        state.links = state.links.filter((l) => !samePath(l.path, link.path));
        await writeState(hub.statePath, state);
      } catch (err) {
        result.outcome = "failed";
        result.error = (err as Error).message;
      }
    }

    if (!options.dryRun) {
      await clearAssignments(hub, results);
      for (const dir of dirs) await removeStaleStaging(dir);
    }
    return { results, hubHome: hub.home, leftHub: [] };
  };
  // A dry run changes nothing, so it needs no lock (and must not create one in a hub that may not exist).
  return options.dryRun ? run() : withLock(hub.lockPath, run, options.lock);
}

async function ejectSelected(hub: Hub, options: EjectOptions): Promise<EjectReport> {
  const profiles = options.profiles ?? builtinAgents();
  const chosen = options.agents?.length ? (await resolveAgents(options.agents, profiles)).map((a) => a.id) : undefined;
  const dryRun = options.dryRun ?? false;

  const run = async (): Promise<EjectReport> => {
    const manifest = await readManifest(hub.manifestPath);
    const state = await readState(hub.statePath);
    const requested = options.skills?.length ? options.skills : ["*"];
    const names = requested.includes("*") ? Object.keys(manifest.skills).sort() : [...new Set(requested)];
    for (const name of names) {
      if (!manifest.skills[name]) throw new SkillsymError("SKILL_NOT_IN_HUB", `No skill named "${name}" in the hub.`, { skill: name });
    }

    const report: EjectReport = { results: [], hubHome: hub.home, leftHub: [] };
    const stamp = backupStamp();
    for (const name of names) {
      const entry = manifest.skills[name]!;
      const drop = chosen ? entry.agents.filter((a) => chosen.includes(a)) : [...entry.agents];
      const keep = profiles.filter((p) => entry.agents.includes(p.id) && !drop.includes(p.id));
      const dropDirs = profiles.filter((p) => drop.includes(p.id)).map((p) => p.skillsDir);
      // Without -a every link of the skill goes, including any the manifest no longer lists.
      const links = state.links.filter((l) => l.skill === name && (!chosen || dropDirs.some((d) => samePath(d, path.dirname(l.path)))));
      const ejectedDirs: string[] = [];
      let failed = false;

      for (const link of links) {
        const dir = path.dirname(link.path);
        if (keep.some((p) => samePath(p.skillsDir, dir))) {
          report.results.push({ skill: name, path: link.path, outcome: "kept-shared" });
          continue;
        }
        const result = await ejectLink(hub, state, link, dryRun);
        report.results.push(result);
        if (result.outcome === "failed" || result.outcome === "hub-missing") failed = true;
        else ejectedDirs.push(dir);
      }
      for (const p of profiles.filter((a) => drop.includes(a.id) && !links.some((l) => samePath(path.dirname(l.path), a.skillsDir)))) {
        report.results.push({ skill: name, path: path.join(p.skillsDir, name), outcome: "unassigned" });
      }
      if (failed) continue;

      // An agent with no link of its own that read an ejected folder now sees the real copy there;
      // keeping it assigned would make `sync` give it a second copy.
      const satisfied = keep.filter(
        (p) => p.alsoReads.some((d) => ejectedDirs.some((e) => samePath(d, e))) && !state.links.some((l) => l.skill === name && samePath(path.dirname(l.path), p.skillsDir)),
      );
      const remaining = keep.filter((p) => !satisfied.includes(p)).map((p) => p.id);
      const touched = drop.length > 0 || links.length > 0;
      const linksLeft = state.links.some((l) => l.skill === name);
      if (touched && !remaining.length && !linksLeft) report.leftHub.push(await leaveHub(hub, manifest, name, dryRun, stamp));
      else if (!dryRun && touched) entry.agents = remaining;
    }
    if (!dryRun) {
      await writeManifest(hub.manifestPath, manifest);
      for (const dir of new Set(report.results.map((r) => path.dirname(r.path)))) await removeStaleStaging(dir);
    }
    return report;
  };
  return dryRun ? run() : withLock(hub.lockPath, run, options.lock);
}

/** Replace one recorded link with a real copy, and stop tracking it. On a dry run `state` is a scratch copy. */
async function ejectLink(hub: Hub, state: State, link: StateLink, dryRun: boolean): Promise<EjectResult> {
  const hubCopy = path.join(hub.skillsDir, link.skill);
  const onDisk = await readLinkTarget(link.path);
  const ours = onDisk !== null && (samePath(onDisk, hubCopy) || samePath(onDisk, link.target));
  let outcome: EjectOutcome;
  if (!ours) outcome = (await pathExists(link.path)) ? "left-in-place" : "missing";
  else outcome = (await isDirectory(onDisk!)) || (await isDirectory(hubCopy)) ? "ejected" : "hub-missing";

  const result: EjectResult = { skill: link.skill, path: link.path, outcome };
  if (outcome === "hub-missing") return result;
  if (dryRun) {
    state.links = state.links.filter((l) => !samePath(l.path, link.path));
    return result;
  }
  try {
    if (outcome === "ejected") {
      // Resolve links (a --link skill is agent -> hub -> library) so real files are copied.
      const source = await fs.realpath((await isDirectory(onDisk!)) ? onDisk! : hubCopy);
      await replaceLinkWithCopy(link.path, source);
    }
    state.links = state.links.filter((l) => !samePath(l.path, link.path));
    await writeState(hub.statePath, state);
  } catch (err) {
    result.outcome = "failed";
    result.error = (err as Error).message;
  }
  return result;
}

/** No agent uses this skill through skillsym any more: take it out of the hub without deleting anything. */
async function leaveHub(hub: Hub, manifest: Manifest, name: string, dryRun: boolean, stamp: string): Promise<EjectedSkill> {
  const entry = manifest.skills[name]!;
  const target = path.join(hub.skillsDir, name);
  const left: EjectedSkill = { skill: name };
  if (entry.mode === "source-link" && entry.source) left.library = entry.source;
  if (dryRun) return left;
  if (entry.mode === "source-link") {
    if ((await readLinkTarget(target)) !== null) await removeDirLink(target);
  } else if (await isDirectory(target)) {
    left.backup = await moveToBackup(hub, target, "ejected", name, stamp);
  }
  forgetLibrarySkill(manifest, name);
  delete manifest.skills[name];
  return left;
}

/**
 * Copy first (next to the link, so the final rename stays on one volume), then swap: the link is
 * only removed once a complete copy exists.
 */
async function replaceLinkWithCopy(linkPath: string, source: string): Promise<void> {
  const staging = path.join(path.dirname(linkPath), `${STAGING_PREFIX}${randomBytes(6).toString("hex")}`);
  await fs.cp(source, staging, { recursive: true, errorOnExist: true });
  try {
    await removeDirLink(linkPath);
  } catch (err) {
    await fs.rm(staging, { recursive: true, force: true });
    throw err;
  }
  await fs.rename(staging, linkPath);
}

/**
 * Once every link of a skill is ejected, its assignments no longer mean anything; clear them so a
 * later `status` shows the agents' copies as unmanaged rather than as drift.
 */
async function clearAssignments(hub: Hub, results: EjectResult[]): Promise<void> {
  const state = await readState(hub.statePath);
  const manifest = await readManifest(hub.manifestPath);
  let changed = false;
  for (const [name, entry] of Object.entries(manifest.skills)) {
    if (!entry.agents.length || state.links.some((l) => l.skill === name)) continue;
    if (results.some((r) => r.skill === name && r.outcome === "failed")) continue;
    entry.agents = [];
    changed = true;
  }
  if (changed) await writeManifest(hub.manifestPath, manifest);
}

/** Remove half-made copies left by an eject that was interrupted. */
async function removeStaleStaging(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(STAGING_PREFIX)) await fs.rm(path.join(dir, name), { recursive: true, force: true });
  }
}
