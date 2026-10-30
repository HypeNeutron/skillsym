import { promises as fs } from "node:fs";
import path from "node:path";
import { builtinAgents, type AgentProfile } from "./agents.js";
import { isDirectory } from "./fsutil.js";
import { hashSkillDir } from "./hash.js";
import type { Hub } from "./hub.js";
import { createDirLink, readLinkTarget, removeDirLink } from "./links.js";
import { withLock, type LockOptions } from "./lock.js";
import { readState, samePath, writeState, type State } from "./state.js";
import { scanStatus, type StatusEntry } from "./status.js";

export type SyncActionType =
  /** Assigned but never linked: create the link. */
  | "link"
  /** Our link points at a hub location that no longer exists: point it at the hub skill. */
  | "relink"
  /** Our link was replaced by an identical copy: back the copy up, then restore the link. */
  | "replace-identical"
  /** Our link is no longer assigned: remove the link. */
  | "unlink-orphan"
  /** A recorded link is no longer ours on disk (gone or replaced): forget it, touch nothing. */
  | "forget"
  /** A correct link to the hub that state.json does not know about: record it. */
  | "record";

export interface SyncAction {
  type: SyncActionType;
  skill: string;
  agents: string[];
  path: string;
}

export type SyncConflictType =
  /** Our link was deleted; it may have been deliberate (e.g. another tool's remove). */
  | "missing-owned"
  /** Our link was replaced by different content. */
  | "replaced-different"
  /** An assigned path holds something skillsym never created. */
  | "blocked"
  /** The skill's folder is gone from the hub, so there is nothing to link to. */
  | "hub-skill-missing";

export interface SyncConflict {
  type: SyncConflictType;
  skill: string;
  agents: string[];
  path: string;
  message: string;
}

export interface SyncPlan {
  actions: SyncAction[];
  /** Decisions sync will not make on its own; nothing at these paths is changed. */
  conflicts: SyncConflict[];
}

export interface SyncActionResult extends SyncAction {
  ok: boolean;
  /** Where a replaced copy was moved to, for "replace-identical". */
  backup?: string;
  error?: string;
}

export interface SyncResult extends SyncPlan {
  results: SyncActionResult[];
}

export interface SyncOptions {
  profiles?: AgentProfile[];
  lock?: LockOptions;
}

/** Work out what sync would do. Read-only. */
export async function planSync(hub: Hub, options: SyncOptions = {}): Promise<SyncPlan> {
  const report = await scanStatus(hub, { profiles: options.profiles ?? builtinAgents() });
  const state = await readState(hub.statePath);
  const plan: SyncPlan = { actions: [], conflicts: [] };
  for (const e of report.entries) await planEntry(hub, state, e, plan);
  return plan;
}

/** Plan and apply under the hub lock, so the plan cannot go stale before it runs. */
export async function sync(hub: Hub, options: SyncOptions = {}): Promise<SyncResult> {
  return withLock(
    hub.lockPath,
    async () => {
      const plan = await planSync(hub, options);
      const state = await readState(hub.statePath);
      const results: SyncActionResult[] = [];
      for (const action of plan.actions) results.push(await apply(hub, state, action));
      // Nothing to do means nothing is written, not even an identical state file.
      if (plan.actions.length) await writeState(hub.statePath, state);
      return { ...plan, results };
    },
    options.lock,
  );
}

async function planEntry(hub: Hub, state: State, e: StatusEntry, plan: SyncPlan): Promise<void> {
  const base = { skill: e.skill, agents: e.agents, path: e.path };
  const target = path.join(hub.skillsDir, e.skill);
  const conflict = (type: SyncConflictType, message: string) => plan.conflicts.push({ type, ...base, message });

  switch (e.status) {
    case "synced":
      if (!e.owned) plan.actions.push({ type: "record", ...base });
      return;
    case "missing":
      if (e.owned) return void conflict("missing-owned", "skillsym's link was removed; restore it or drop the assignment");
      if (!(await isDirectory(target))) return void conflict("hub-skill-missing", `the hub has no folder for "${e.skill}"`);
      return void plan.actions.push({ type: "link", ...base });
    case "dangling":
      if (!(await isDirectory(target))) return void conflict("hub-skill-missing", `the hub has no folder for "${e.skill}"`);
      return void plan.actions.push({ type: "relink", ...base });
    case "replaced":
      if (e.sameContent) return void plan.actions.push({ type: "replace-identical", ...base });
      return void conflict("replaced-different", "skillsym's link was replaced by different content");
    case "blocked":
      return void conflict("blocked", "occupied by something skillsym did not create; use `skillsym import`");
    case "orphaned": {
      // Only remove it if it is still our link (pointing where we created it, or at the hub skill);
      // otherwise someone else owns that path now, so just stop tracking it.
      const recorded = state.links.find((l) => samePath(l.path, e.path));
      const onDisk = await readLinkTarget(e.path);
      const ours = onDisk !== null && (samePath(onDisk, target) || (recorded !== undefined && samePath(onDisk, recorded.target)));
      return void plan.actions.push({ type: ours ? "unlink-orphan" : "forget", ...base });
    }
  }
}

async function apply(hub: Hub, state: State, action: SyncAction): Promise<SyncActionResult> {
  const target = path.join(hub.skillsDir, action.skill);
  try {
    switch (action.type) {
      case "link":
        await fs.mkdir(path.dirname(action.path), { recursive: true });
        await recordLink(state, action, target, await createDirLink(target, action.path));
        return { ...action, ok: true };
      case "relink":
        await removeDirLink(action.path);
        await recordLink(state, action, target, await createDirLink(target, action.path));
        return { ...action, ok: true };
      case "replace-identical": {
        const backup = await moveAside(hub, action);
        await recordLink(state, action, target, await createDirLink(target, action.path));
        return { ...action, ok: true, ...(backup ? { backup } : {}) };
      }
      case "unlink-orphan":
        await removeDirLink(action.path);
        forget(state, action.path);
        return { ...action, ok: true };
      case "forget":
        forget(state, action.path);
        return { ...action, ok: true };
      case "record":
        await recordLink(state, action, target, process.platform === "win32" ? "junction" : "symlink");
        return { ...action, ok: true };
    }
  } catch (err) {
    return { ...action, ok: false, error: (err as Error).message };
  }
}

/**
 * Get whatever replaced our link out of the way without losing it: a link is simply removed
 * (its target is untouched); a real folder is moved into the hub's backups.
 */
async function moveAside(hub: Hub, action: SyncAction): Promise<string | undefined> {
  if ((await readLinkTarget(action.path)) !== null) {
    await removeDirLink(action.path);
    return undefined;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(hub.backupsDir, stamp, action.agents.join("+") || "unassigned", action.skill);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.rename(action.path, dest);
  } catch (err) {
    // Different volume: copy, then remove the original only after the copy succeeded.
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await fs.cp(action.path, dest, { recursive: true, errorOnExist: true });
    await fs.rm(action.path, { recursive: true });
  }
  return dest;
}

async function recordLink(state: State, action: SyncAction, target: string, kind: "junction" | "symlink"): Promise<void> {
  forget(state, action.path);
  state.links.push({
    path: action.path,
    target,
    skill: action.skill,
    kind,
    hash: await hashSkillDir(target),
    createdAt: new Date().toISOString(),
  });
}

function forget(state: State, p: string): void {
  state.links = state.links.filter((l) => !samePath(l.path, p));
}
