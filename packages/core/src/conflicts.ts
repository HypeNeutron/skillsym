import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { moveAside, moveToBackup } from "./backup.js";
import { pathExists } from "./fsutil.js";
import type { Hub } from "./hub.js";
import { createDirLink, readLinkTarget, removeDirLink } from "./links.js";
import { withLock } from "./lock.js";
import { readManifest, writeManifest, type Manifest } from "./manifest.js";
import { isValidSkillName } from "./skills.js";
import { readState, samePath, writeState, type State } from "./state.js";
import { forget, planSync, recordStateLink, type SyncConflict, type SyncConflictType, type SyncOptions } from "./sync.js";

export type ConflictChoice =
  /** Take the agent's version into the hub (the hub's version is backed up), then re-link. */
  | "adopt"
  /** Put skillsym's link back (whatever is there is backed up first). */
  | "restore"
  /** Keep the agent's version as a new hub skill for these agents; the original stays for the rest. */
  | "fork"
  /** Accept the removal: unassign the skill from these agents. */
  | "drop"
  /** Decide later; nothing changes. */
  | "skip";

const CHOICES: Record<SyncConflictType, ConflictChoice[]> = {
  "replaced-different": ["adopt", "restore", "fork", "skip"],
  "missing-owned": ["restore", "drop", "skip"],
  "hub-skill-missing": ["drop", "skip"],
  // Bringing someone else's folder into the hub is `import`'s job.
  blocked: ["skip"],
};

export function choicesFor(type: SyncConflictType): ConflictChoice[] {
  return [...CHOICES[type]];
}

/** Default name for a forked skill: the original name plus the first agent's id. */
export function defaultForkName(conflict: Pick<SyncConflict, "skill" | "agents">): string {
  return `${conflict.skill}-${conflict.agents[0] ?? "fork"}`;
}

export interface ConflictDecision {
  /** Path of the conflict, as reported by planSync/sync. */
  path: string;
  choice: ConflictChoice;
  /** Name for the new skill when choice is "fork"; defaults to defaultForkName(). */
  forkName?: string;
}

export interface ConflictResolution {
  path: string;
  choice: ConflictChoice;
  ok: boolean;
  conflict?: SyncConflict;
  /** Backups made while resolving (the agent's copy, and for "adopt" the hub's old version). */
  backups: string[];
  /** For "fork": the new skill's name. */
  newSkill?: string;
  error?: string;
}

/**
 * Apply the user's decisions to conflicts found by sync. Runs under the hub lock and re-plans first,
 * so a decision only applies if its conflict still exists. Every overwrite is preceded by a backup.
 */
export async function resolveConflicts(hub: Hub, decisions: ConflictDecision[], options: SyncOptions = {}): Promise<ConflictResolution[]> {
  return withLock(
    hub.lockPath,
    async () => {
      const { conflicts } = await planSync(hub, options);
      const manifest = await readManifest(hub.manifestPath);
      const state = await readState(hub.statePath);
      const results: ConflictResolution[] = [];

      for (const decision of decisions) {
        const conflict = conflicts.find((c) => samePath(c.path, decision.path));
        const result: ConflictResolution = { path: decision.path, choice: decision.choice, ok: false, backups: [] };
        results.push(result);
        if (!conflict) {
          result.error = "no conflict at this path any more";
          continue;
        }
        result.conflict = conflict;
        if (!CHOICES[conflict.type].includes(decision.choice)) {
          result.error = `"${decision.choice}" is not available for ${conflict.type}; choose one of: ${CHOICES[conflict.type].join(", ")}`;
          continue;
        }
        try {
          await resolveOne(hub, manifest, state, conflict, decision, result);
          result.ok = true;
        } catch (err) {
          result.error = (err as Error).message;
        }
      }

      await writeState(hub.statePath, state);
      await writeManifest(hub.manifestPath, manifest);
      return results;
    },
    options.lock,
  );
}

async function resolveOne(
  hub: Hub,
  manifest: Manifest,
  state: State,
  conflict: SyncConflict,
  decision: ConflictDecision,
  result: ConflictResolution,
): Promise<void> {
  const target = path.join(hub.skillsDir, conflict.skill);
  const label = conflict.agents.join("+");

  switch (decision.choice) {
    case "skip":
      return;

    case "restore": {
      if (await pathExists(conflict.path)) {
        const backup = await moveAside(hub, conflict.path, label, conflict.skill);
        if (backup) result.backups.push(backup);
      }
      await fs.mkdir(path.dirname(conflict.path), { recursive: true });
      await recordStateLink(state, conflict.path, conflict.skill, target, await createDirLink(target, conflict.path));
      return;
    }

    case "adopt": {
      const staged = await stageAgentCopy(hub, conflict);
      result.backups.push(await moveToBackup(hub, target, "hub", conflict.skill));
      await fs.rename(staged, target);
      const backup = await moveAside(hub, conflict.path, label, conflict.skill);
      if (backup) result.backups.push(backup);
      await recordStateLink(state, conflict.path, conflict.skill, target, await createDirLink(target, conflict.path));
      return;
    }

    case "fork": {
      const name = decision.forkName ?? defaultForkName(conflict);
      if (!isValidSkillName(name)) throw new Error(`"${name}" is not a valid skill name`);
      const newTarget = path.join(hub.skillsDir, name);
      const newPath = path.join(path.dirname(conflict.path), name);
      if (manifest.skills[name] || (await pathExists(newTarget))) throw new Error(`a skill named "${name}" is already in the hub`);
      if (await pathExists(newPath)) throw new Error(`${newPath} is already taken`);

      const staged = await stageAgentCopy(hub, conflict);
      await fs.rename(staged, newTarget);
      const backup = await moveAside(hub, conflict.path, label, conflict.skill);
      if (backup) result.backups.push(backup);
      forget(state, conflict.path);
      await recordStateLink(state, newPath, name, newTarget, await createDirLink(newTarget, newPath));

      manifest.skills[name] = { agents: [...conflict.agents].sort(), mode: "link", scope: "user" };
      unassign(manifest, conflict);
      result.newSkill = name;
      return;
    }

    case "drop": {
      const recorded = state.links.find((l) => samePath(l.path, conflict.path));
      const onDisk = await readLinkTarget(conflict.path);
      if (recorded && onDisk && (samePath(onDisk, recorded.target) || samePath(onDisk, target))) await removeDirLink(conflict.path);
      forget(state, conflict.path);
      unassign(manifest, conflict);
      return;
    }
  }
}

/** Copy what the agent has at the conflict path (following a link if it is one) into the hub's staging area. */
async function stageAgentCopy(hub: Hub, conflict: SyncConflict): Promise<string> {
  const source = (await readLinkTarget(conflict.path)) ?? conflict.path;
  const staging = path.join(hub.tmpDir, `${conflict.skill}.${randomBytes(6).toString("hex")}`);
  await fs.cp(source, staging, { recursive: true, errorOnExist: true });
  return staging;
}

function unassign(manifest: Manifest, conflict: SyncConflict): void {
  const entry = manifest.skills[conflict.skill];
  if (entry) entry.agents = entry.agents.filter((a) => !conflict.agents.includes(a));
}
