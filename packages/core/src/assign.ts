import { promises as fs } from "node:fs";
import path from "node:path";
import { builtinAgents, resolveAgents, type AgentProfile } from "./agents.js";
import { SkillsymError } from "./errors.js";
import { pathExists } from "./fsutil.js";
import { hashSkillDir } from "./hash.js";
import type { Hub } from "./hub.js";
import { createDirLink, readLinkTarget } from "./links.js";
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
  | "failed";

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
      const manifest = await readManifest(hub.manifestPath);
      const state = await readState(hub.statePath);
      const skillNames = options.skills.includes("*") ? Object.keys(manifest.skills).sort() : unique(options.skills);
      for (const name of skillNames) {
        if (!manifest.skills[name]) {
          throw new SkillsymError("SKILL_NOT_IN_HUB", `No skill named "${name}" in the hub. Add it first: skillsym add <path>`, {
            skill: name,
          });
        }
      }

      const results: AgentLinkResult[] = [];
      for (const name of skillNames) {
        const target = path.join(hub.skillsDir, name);
        let hash: string | undefined;
        for (const group of groupBySkillsDir(agents)) {
          const linkPath = path.join(group.dir, name);
          const ids = group.agents.map((a) => a.id);
          const ours = state.links.find((l) => samePath(l.path, linkPath));
          const onDisk = await readLinkTarget(linkPath);

          if (ours && onDisk && samePath(onDisk, target)) {
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
              results.push({ skill: name, agents: ids, path: linkPath, outcome: "linked" });
            } catch (err) {
              results.push({ skill: name, agents: ids, path: linkPath, outcome: "failed", reason: (err as Error).message });
              continue;
            }
          }
          const entry = manifest.skills[name]!;
          entry.agents = unique([...entry.agents, ...ids]).sort();
        }
      }

      await writeState(hub.statePath, state);
      await writeManifest(hub.manifestPath, manifest);
      return { results };
    },
    options.lock,
  );
}

function groupBySkillsDir(agents: AgentProfile[]): { dir: string; agents: AgentProfile[] }[] {
  const groups: { dir: string; agents: AgentProfile[] }[] = [];
  for (const agent of agents) {
    const group = groups.find((g) => samePath(g.dir, agent.skillsDir));
    if (group) group.agents.push(agent);
    else groups.push({ dir: agent.skillsDir, agents: [agent] });
  }
  return groups;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
