import { promises as fs } from "node:fs";
import path from "node:path";
import { agentDelivery, builtinAgents, planLinkGroups, resolveAgents, type AgentProfile } from "./agents.js";
import { SkillsymError } from "./errors.js";
import { pathExists } from "./fsutil.js";
import { hashSkillDir } from "./hash.js";
import type { Hub } from "./hub.js";
import { createDirLink, readLinkTarget } from "./links.js";
import { expandSkillNames, listUnregisteredSkills, registerHubSkillLocked } from "./skills.js";
import { applySkillsJsonDelivery, findStateManifest, hasInheritsRef, readGeneratedFile, readTargetSkillsJson } from "./skills-json.js";
import { withLock, type LockOptions } from "./lock.js";
import { readManifest, writeManifest } from "./manifest.js";
import { readState, samePath, writeState } from "./state.js";

export type LinkOutcome =
  /** A new link was created. */
  | "linked"
  /** Our link was already there and correct; nothing changed. */
  | "already-linked"
  /** Something skillsym did not create occupies the path; left untouched. */
  | "blocked"
  /** The link could not be created (e.g. permissions). */
  | "failed"
  /** No link needed: the agent already loads the skill from another assigned agent's folder. */
  | "covered";

export interface AgentLinkResult {
  skill: string;
  /** Agents served by this link. Several agents can share one folder (codex and universal). */
  agents: string[];
  path: string;
  outcome: LinkOutcome;
  reason?: string;
}

export interface AssignOptions {
  /** Skill names, or ["*"] for every skill in the hub. */
  skills: string[];
  /** Agent ids (comma-separated allowed), or ["*"] for every installed agent. */
  agents: string[];
  /** Agent profiles to use; defaults to the built-in ones for the current user. */
  profiles?: AgentProfile[];
  lock?: LockOptions;
}

export interface AssignResult {
  results: AgentLinkResult[];
}

/**
 * Link hub skills into agents' skills folders and record the assignment.
 * Only paths that are free (or already hold our own correct link) are touched; anything else is
 * reported as blocked and the agent is not added to the manifest for that skill.
 */
export async function assignSkills(hub: Hub, options: AssignOptions): Promise<AssignResult> {
  const profiles = options.profiles ?? builtinAgents();
  const agents = await resolveAgents(options.agents, profiles);

  return withLock(
    hub.lockPath,
    async () => {
      let manifest = await readManifest(hub.manifestPath);
      const state = await readState(hub.statePath);
      // A skill folder written straight into the hub is registered first. A name-mismatch one is only
      // reached by naming it, and registering it throws; "*" and patterns skip it.
      const unregistered = await listUnregisteredSkills(hub, manifest);
      const ok = unregistered.filter((u) => !u.reason).map((u) => u.name);
      const skillNames = expandSkillNames(options.skills, [...Object.keys(manifest.skills), ...ok]);
      const toRegister = unregistered.map((u) => u.name).filter((n) => skillNames.includes(n) || options.skills.includes(n));
      for (const name of toRegister) await registerHubSkillLocked(hub, name, { profiles });
      if (toRegister.length) manifest = await readManifest(hub.manifestPath);
      for (const name of skillNames) {
        if (!manifest.skills[name]) {
          throw new SkillsymError("SKILL_NOT_IN_HUB", `No skill named "${name}" in the hub. Add it first: skillsym add <path>`, {
            skill: name,
          });
        }
      }

      const results: AgentLinkResult[] = [];
      const requested = agents.map((a) => a.id);
      const jsonAgents = agents.filter((a) => agentDelivery(a) === "skills-json");

      // Snapshot which requested skills were already delivered cleanly for each skills-json agent
      // before we mutate manifest/state, so assign reports "already-linked" vs "linked" accurately.
      const preDelivered = new Map<string, Set<string>>();
      for (const agent of jsonAgents) {
        const owned = findStateManifest(state, agent.id);
        const already = new Set<string>();
        if (owned && agent.skillsJsonPath) {
          const gen = await readGeneratedFile(owned.generatedPath);
          const target = await readTargetSkillsJson(agent.skillsJsonPath).catch(() => null);
          if (gen.exists && gen.hash === owned.generatedHash && target?.exists && hasInheritsRef(target.rawObj, agent.skillsJsonPath, owned.generatedPath)) {
            for (const s of owned.skills) already.add(s);
          }
        }
        preDelivered.set(agent.id, already);
      }

      for (const name of skillNames) {
        const target = path.join(hub.skillsDir, name);
        const entry = manifest.skills[name]!;
        // Plan over everything assigned after this call, so coverage accounts for existing agents too.
        const all = profiles.filter((p) => requested.includes(p.id) || entry.agents.includes(p.id));
        let hash: string | undefined;
        const healthy: string[] = [];
        for (const group of planLinkGroups(all)) {
          const linkPath = path.join(group.dir, name);
          const ids = group.agents.map((a) => a.id).filter((id) => requested.includes(id));
          if (!ids.length) {
            // Not part of this request, but it may cover a requested group if its link is in place.
            const onDisk = await readLinkTarget(linkPath);
            if (!group.coveredBy && onDisk && samePath(onDisk, target)) healthy.push(group.dir);
            continue;
          }
          if (group.coveredBy && healthy.some((d) => samePath(d, group.coveredBy!.dir))) {
            results.push({
              skill: name,
              agents: ids,
              path: linkPath,
              outcome: "covered",
              reason: `already loads it from ${group.coveredBy.dir} (${group.coveredBy.agents.join(", ")}); no second link, so it is not loaded twice`,
            });
            entry.agents = unique([...entry.agents, ...ids]).sort();
            continue;
          }
          const ours = state.links.find((l) => samePath(l.path, linkPath));
          const onDisk = await readLinkTarget(linkPath);

          if (ours && onDisk && samePath(onDisk, target)) {
            healthy.push(group.dir);
            results.push({ skill: name, agents: ids, path: linkPath, outcome: "already-linked" });
          } else if (await pathExists(linkPath)) {
            results.push({
              skill: name,
              agents: ids,
              path: linkPath,
              outcome: "blocked",
              reason: ours
                ? "skillsym's link here was replaced or changed; run `skillsym status` (sync will resolve it)"
                : "something skillsym did not create is already here; use `skillsym import` to bring it into the hub",
            });
            continue;
          } else {
            try {
              await fs.mkdir(group.dir, { recursive: true });
              const kind = await createDirLink(target, linkPath);
              hash ??= await hashSkillDir(target);
              state.links = state.links.filter((l) => !samePath(l.path, linkPath));
              state.links.push({ path: linkPath, target, skill: name, kind, hash, createdAt: new Date().toISOString() });
              healthy.push(group.dir);
              results.push({ skill: name, agents: ids, path: linkPath, outcome: "linked" });
            } catch (err) {
              results.push({ skill: name, agents: ids, path: linkPath, outcome: "failed", reason: (err as Error).message });
              continue;
            }
          }
          entry.agents = unique([...entry.agents, ...ids]).sort();
        }
      }

      for (const agent of jsonAgents) {
        const previousAgents = new Map<string, string[]>();
        for (const name of skillNames) {
          const entry = manifest.skills[name]!;
          previousAgents.set(name, [...entry.agents]);
          entry.agents = unique([...entry.agents, agent.id]).sort();
        }
        const applied = await applySkillsJsonDelivery(hub, agent, manifest, state);
        if (!applied.ok) {
          for (const name of skillNames) {
            manifest.skills[name]!.agents = previousAgents.get(name)!;
            results.push({
              skill: name,
              agents: [agent.id],
              path: applied.skillsJsonPath || agent.skillsDir,
              outcome: applied.outcome,
              reason: applied.reason,
            });
          }
          continue;
        }
        const already = preDelivered.get(agent.id)!;
        for (const name of skillNames) {
          const wasAssigned = previousAgents.get(name)!.includes(agent.id);
          results.push({
            skill: name,
            agents: [agent.id],
            path: applied.skillsJsonPath,
            outcome: wasAssigned && already.has(name) ? "already-linked" : "linked",
          });
        }
      }

      await writeState(hub.statePath, state);
      await writeManifest(hub.manifestPath, manifest);
      return { results };
    },
    options.lock,
  );
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
