import path from "node:path";
import { builtinAgents, groupBySkillsDir, resolveAgents, type AgentProfile } from "./agents.js";
import { moveToBackup } from "./backup.js";
import { SkillsymError } from "./errors.js";
import { isDirectory, pathExists } from "./fsutil.js";
import type { Hub } from "./hub.js";
import { readLinkTarget, removeDirLink } from "./links.js";
import { withLock, type LockOptions } from "./lock.js";
import { readManifest, writeManifest, type Manifest } from "./manifest.js";
import { readState, samePath, writeState, type State } from "./state.js";

export type RemoveOutcome =
  /** Our link was removed. */
  | "unlinked"
  /** The link stays because another still-assigned agent reads the same folder (codex/universal). */
  | "kept-shared"
  /** Something skillsym did not create is at the path now; it was left alone and is no longer tracked. */
  | "left-in-place"
  /** Assigned, but there was no link on disk. */
  | "not-linked"
  /** The agent was not assigned this skill. */
  | "not-assigned";

export interface RemoveLinkResult {
  skill: string;
  agents: string[];
  path?: string;
  outcome: RemoveOutcome;
}

export interface RemovedSkill {
  skill: string;
  /** Where the hub's copy of the skill was moved (absent on a dry run, and for --link skills). */
  backup?: string;
  /** For a skill linked from a library: the library folder, which is left untouched. */
  library?: string;
}

export interface RemoveOptions {
  /** Skill names, or ["*"] for every skill in the hub. */
  skills: string[];
  /** Agents to unassign. Omit to remove the skills from every agent and from the hub. */
  agents?: string[];
  profiles?: AgentProfile[];
  /** Work out what would happen without changing anything. */
  dryRun?: boolean;
  lock?: LockOptions;
}

export interface RemoveResult {
  links: RemoveLinkResult[];
  /** Skills deleted from the hub (only when no agents were given). */
  removedSkills: RemovedSkill[];
}

/**
 * Unassign skills from some agents (`agents` given), or remove them entirely: every link, the
 * manifest entry and the hub folder, which is moved to backups rather than deleted.
 * Only links skillsym created are removed.
 */
export async function removeSkills(hub: Hub, options: RemoveOptions): Promise<RemoveResult> {
  const profiles = options.profiles ?? builtinAgents();
  const full = options.agents === undefined;
  const dropIds = full ? undefined : (await resolveAgents(options.agents!, profiles)).map((a) => a.id);

  return withLock(
    hub.lockPath,
    async () => {
      const manifest = await readManifest(hub.manifestPath);
      const state = await readState(hub.statePath);
      const names = options.skills.includes("*") ? Object.keys(manifest.skills).sort() : [...new Set(options.skills)];
      for (const name of names) {
        if (!manifest.skills[name]) throw new SkillsymError("SKILL_NOT_IN_HUB", `No skill named "${name}" in the hub.`, { skill: name });
      }

      const result: RemoveResult = { links: [], removedSkills: [] };
      for (const name of names) {
        await removeOne(hub, manifest, state, profiles, name, dropIds, options.dryRun ?? false, result);
      }
      if (!options.dryRun) {
        await writeState(hub.statePath, state);
        await writeManifest(hub.manifestPath, manifest);
      }
      return result;
    },
    options.lock,
  );
}

async function removeOne(
  hub: Hub,
  manifest: Manifest,
  state: State,
  profiles: AgentProfile[],
  name: string,
  dropIds: string[] | undefined,
  dryRun: boolean,
  result: RemoveResult,
): Promise<void> {
  const entry = manifest.skills[name]!;
  const target = path.join(hub.skillsDir, name);
  const drop = dropIds ?? entry.agents;
  const assigned = profiles.filter((p) => entry.agents.includes(p.id));

  for (const id of drop) {
    if (!entry.agents.includes(id)) result.links.push({ skill: name, agents: [id], outcome: "not-assigned" });
  }

  const handled: string[] = [];
  for (const group of groupBySkillsDir(assigned)) {
    const ids = group.agents.map((a) => a.id);
    const dropped = ids.filter((id) => drop.includes(id));
    if (!dropped.length) continue;
    const linkPath = path.join(group.dir, name);
    handled.push(linkPath);
    if (ids.length > dropped.length) {
      result.links.push({ skill: name, agents: dropped, path: linkPath, outcome: "kept-shared" });
      continue;
    }
    result.links.push({ skill: name, agents: dropped, path: linkPath, outcome: await unlinkIfOurs(state, linkPath, target, dryRun) });
  }

  if (!dropIds) {
    // Removing the whole skill: also clean up any of its links the manifest no longer lists.
    for (const link of state.links.filter((l) => l.skill === name && !handled.some((h) => samePath(h, l.path)))) {
      result.links.push({ skill: name, agents: [], path: link.path, outcome: await unlinkIfOurs(state, link.path, target, dryRun) });
    }
    const removed: RemovedSkill = { skill: name };
    if (entry.mode === "source-link" && entry.source) removed.library = entry.source;
    if (!dryRun) {
      if (entry.mode === "source-link") {
        // The hub entry is only a link into the user's library: remove the link, never the library.
        if ((await readLinkTarget(target)) !== null) await removeDirLink(target);
      } else if (await isDirectory(target)) removed.backup = await moveToBackup(hub, target, "removed", name);
      delete manifest.skills[name];
    }
    result.removedSkills.push(removed);
  } else if (!dryRun) {
    entry.agents = entry.agents.filter((a) => !dropIds.includes(a));
  }
}

/** Remove the link at `p` only if it is still the one skillsym created; always stop tracking it. */
async function unlinkIfOurs(state: State, p: string, target: string, dryRun: boolean): Promise<RemoveOutcome> {
  const recorded = state.links.find((l) => samePath(l.path, p));
  const onDisk = await readLinkTarget(p);
  let outcome: RemoveOutcome;
  if (recorded && onDisk && (samePath(onDisk, target) || samePath(onDisk, recorded.target))) outcome = "unlinked";
  else if (await pathExists(p)) outcome = "left-in-place";
  else outcome = "not-linked";

  if (!dryRun) {
    if (outcome === "unlinked") await removeDirLink(p);
    state.links = state.links.filter((l) => !samePath(l.path, p));
  }
  return outcome;
}
