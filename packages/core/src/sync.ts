import { promises as fs } from "node:fs";
import path from "node:path";
import { agentDelivery, builtinAgents, type AgentProfile, type DeliveryMode } from "./agents.js";
import { copyToBackup, moveAside } from "./backup.js";
import { isDirectory, isFile } from "./fsutil.js";
import { hashSkillDir } from "./hash.js";
import type { Hub } from "./hub.js";
import { createDirLink, readLinkTarget, removeDirLink } from "./links.js";
import { withLock, type LockOptions } from "./lock.js";
import { readManifest, writeManifest, type Manifest } from "./manifest.js";
import { applySkillsJsonDelivery, generatedManifestPath } from "./skills-json.js";
import { readState, samePath, writeState, type State } from "./state.js";
import { refreshLibrarySnapshots } from "./snapshots.js";
import { filterStatus, scanStatus, type StatusEntry } from "./status.js";

export type SyncActionType =
  /** Assigned but never linked: create the link. */
  | "link"
  /** Our link points at a hub location that no longer exists: point it at the hub skill. */
  | "relink"
  /** Our link was replaced by an identical copy: back the copy up, then restore the link. */
  | "replace-identical"
  /** Our link is no longer assigned: remove the link. */
  | "unlink-orphan"
  /** Our link duplicates a skill the agent already loads from another folder: remove the link. */
  | "unlink-duplicate"
  /** A recorded link is no longer ours on disk (gone or replaced): forget it, touch nothing. */
  | "forget"
  /** A correct link to the hub that state.json does not know about: record it. */
  | "record"
  /** Write or update the agent's generated skills.json manifest + inherits ref. */
  | "update-manifest"
  /** Remove the inherits ref and generated skills.json file when no skills remain assigned. */
  | "unlink-manifest";

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
  | "hub-skill-missing"
  /** The library folder a --link skill points to is gone (moved or deleted). */
  | "source-missing";

export interface SyncConflict {
  type: SyncConflictType;
  skill: string;
  agents: string[];
  path: string;
  message: string;
  /** Delivery mode for this conflict (omitted or "link" for directory links). */
  delivery?: DeliveryMode;
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
  /** Skills whose library snapshot could not be updated. */
  snapshotFailed: string[];
}

export interface SyncOptions {
  profiles?: AgentProfile[];
  /** Only these skills (names or patterns). */
  skills?: string[];
  /** Only these agents. */
  agents?: string[];
  lock?: LockOptions;
}

/** Work out what sync would do. Read-only. */
export async function planSync(hub: Hub, options: SyncOptions = {}): Promise<SyncPlan> {
  const profiles = options.profiles ?? builtinAgents();
  const report = await scanStatus(hub, { profiles });
  const { entries } = await filterStatus(hub, report, {
    profiles,
    ...(options.skills ? { skills: options.skills } : {}),
    ...(options.agents ? { agents: options.agents } : {}),
  });
  const state = await readState(hub.statePath);
  const manifest = await readManifest(hub.manifestPath);
  const plan: SyncPlan = { actions: [], conflicts: [] };
  const linkEntries = entries.filter((e) => e.delivery !== "skills-json");
  const jsonEntries = entries.filter((e) => e.delivery === "skills-json");
  for (const e of linkEntries) await planEntry(hub, state, e, plan);
  planSkillsJsonEntries(profiles, manifest, jsonEntries, plan);
  return plan;
}

/** Plan and apply under the hub lock, so the plan cannot go stale before it runs. */
export async function sync(hub: Hub, options: SyncOptions = {}): Promise<SyncResult> {
  return withLock(
    hub.lockPath,
    async () => {
      const profiles = options.profiles ?? builtinAgents();
      const plan = await planSync(hub, options);
      const state = await readState(hub.statePath);
      const manifest = await readManifest(hub.manifestPath);
      const results: SyncActionResult[] = [];
      for (const action of plan.actions) results.push(await apply(hub, state, manifest, profiles, action));
      // Nothing to do means nothing is written, not even an identical state file.
      if (plan.actions.length) await writeState(hub.statePath, state);
      return { ...plan, results, snapshotFailed: await refreshLibrarySnapshots(hub) };
    },
    options.lock,
  );
}

async function planEntry(hub: Hub, state: State, e: StatusEntry, plan: SyncPlan): Promise<void> {
  const base = { skill: e.skill, agents: e.agents, path: e.path };
  const target = path.join(hub.skillsDir, e.skill);
  const conflict = (type: SyncConflictType, message: string) => plan.conflicts.push({ type, ...base, message });

  switch (e.status) {
    case "covered":
      return;
    case "source-missing":
      return void conflict(
        "source-missing",
        "the library folder this skill is linked from is gone; if you moved the library, run `skillsym add <new library path> --link`",
      );
    case "duplicate":
      return void plan.actions.push({ type: "unlink-duplicate", ...base });
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

function planSkillsJsonEntries(profiles: AgentProfile[], manifest: Manifest, entries: StatusEntry[], plan: SyncPlan): void {
  const byAgent = new Map<AgentProfile, StatusEntry[]>();
  for (const e of entries) {
    const agent = profiles.find(
      (p) =>
        agentDelivery(p) === "skills-json" &&
        p.skillsJsonPath !== undefined &&
        (samePath(p.skillsJsonPath, e.path) || e.path.toLowerCase().startsWith(`${p.skillsJsonPath.toLowerCase()}#`)),
    );
    if (!agent) continue;
    byAgent.set(agent, [...(byAgent.get(agent) ?? []), e]);
  }

  for (const [agent, group] of byAgent) {
    const skillsJsonPath = agent.skillsJsonPath!;
    for (const sm of group.filter((e) => e.status === "source-missing")) {
      plan.conflicts.push({
        type: "source-missing",
        skill: sm.skill,
        agents: [agent.id],
        path: sm.path,
        message: "the library folder this skill is linked from is gone; if you moved the library, run `skillsym add <new library path> --link`",
        delivery: "skills-json",
      });
    }

    const blocked = group.filter((e) => e.status === "blocked");
    if (blocked.length) {
      plan.conflicts.push({
        type: "blocked",
        skill: blocked.map((e) => e.skill).join(", "),
        agents: [agent.id],
        path: skillsJsonPath,
        message: `${skillsJsonPath} is not valid JSON; fix it manually before skillsym updates inherits`,
        delivery: "skills-json",
      });
      continue;
    }

    const replaced = group.filter((e) => e.status === "replaced");
    if (replaced.length) {
      if (replaced.every((e) => e.sameContent)) {
        plan.actions.push({
          type: "update-manifest",
          skill: replaced.map((e) => e.skill).join(", "),
          agents: [agent.id],
          path: skillsJsonPath,
        });
      } else {
        plan.conflicts.push({
          type: "replaced-different",
          skill: replaced.map((e) => e.skill).join(", "),
          agents: [agent.id],
          path: skillsJsonPath,
          message: "skillsym's generated skills-json manifest was modified outside skillsym",
          delivery: "skills-json",
        });
      }
      continue;
    }

    const missingOwned = group.filter((e) => e.status === "missing" && e.owned);
    if (missingOwned.length) {
      plan.conflicts.push({
        type: "missing-owned",
        skill: missingOwned.map((e) => e.skill).join(", "),
        agents: [agent.id],
        path: skillsJsonPath,
        message: "skillsym's inherits entry or generated manifest was removed; restore it or drop the assignment",
        delivery: "skills-json",
      });
      continue;
    }

    const needsSync = group.filter((e) => (e.status === "missing" && !e.owned) || e.status === "orphaned");
    if (!needsSync.length) continue;

    const assignedLeft = Object.keys(manifest.skills).some((name) => manifest.skills[name]!.agents.includes(agent.id));
    plan.actions.push({
      type: assignedLeft ? "update-manifest" : "unlink-manifest",
      skill: needsSync.map((e) => e.skill).join(", "),
      agents: [agent.id],
      path: skillsJsonPath,
    });
  }
}

async function apply(hub: Hub, state: State, manifest: Manifest, profiles: AgentProfile[], action: SyncAction): Promise<SyncActionResult> {
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
        const backup = await moveAside(hub, action.path, action.agents.join("+"), action.skill);
        await recordLink(state, action, target, await createDirLink(target, action.path));
        return { ...action, ok: true, ...(backup ? { backup } : {}) };
      }
      case "unlink-orphan":
      case "unlink-duplicate":
        await removeDirLink(action.path);
        forget(state, action.path);
        return { ...action, ok: true };
      case "forget":
        forget(state, action.path);
        return { ...action, ok: true };
      case "record":
        await recordLink(state, action, target, process.platform === "win32" ? "junction" : "symlink");
        return { ...action, ok: true };
      case "update-manifest":
      case "unlink-manifest": {
        const agent = profiles.find((p) => p.id === action.agents[0]);
        if (!agent) return { ...action, ok: false, error: `Unknown agent "${action.agents[0]}"` };
        const genPath = generatedManifestPath(hub, agent.id);
        let backup: string | undefined;
        // If generated file existed without matching state (e.g. identical manual copy), back it up first.
        const owned = (state.manifests ?? []).find((m) => m.agent === agent.id);
        if (action.type === "update-manifest" && !owned && (await isFile(genPath))) {
          backup = await copyToBackup(hub, genPath, agent.id, path.basename(genPath));
        }
        const applied = await applySkillsJsonDelivery(hub, agent, manifest, state, { forceOverwrite: true });
        if (!applied.ok) return { ...action, ok: false, error: applied.reason };
        return { ...action, ok: true, ...(backup ? { backup } : {}) };
      }
    }
  } catch (err) {
    return { ...action, ok: false, error: (err as Error).message };
  }
}

async function recordLink(state: State, action: SyncAction, target: string, kind: "junction" | "symlink"): Promise<void> {
  await recordStateLink(state, action.path, action.skill, target, kind);
}

/** Replace any record at `p` with a fresh one for a link we just created. */
export async function recordStateLink(state: State, p: string, skill: string, target: string, kind: "junction" | "symlink"): Promise<void> {
  forget(state, p);
  state.links.push({ path: p, target, skill, kind, hash: await hashSkillDir(target), createdAt: new Date().toISOString() });
}

export function forget(state: State, p: string): void {
  state.links = state.links.filter((l) => !samePath(l.path, p));
}
