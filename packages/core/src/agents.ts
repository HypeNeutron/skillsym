import os from "node:os";
import path from "node:path";
import { SkillsymError } from "./errors.js";
import { isDirectory } from "./fsutil.js";
import { samePath } from "./state.js";

export interface AgentProfile {
  id: string;
  displayName: string;
  /** Folder skillsym links skills into for this agent (user scope). */
  skillsDir: string;
  /** Other folders the agent also loads skills from; used to avoid loading a skill twice. */
  alsoReads: string[];
  /** Folder whose presence means the agent is installed. Absent = always counted as installed. */
  detectDir?: string;
  /** Whether the agent picks up edits to a skill without restarting. */
  reload: "live" | "restart" | "unknown";
  /** Entries in skillsDir the agent manages itself; skillsym never reports, imports or touches them. */
  reserved?: string[];
}

/**
 * Built-in profiles, verified on Windows in spike 01 (see the spec):
 * - Codex reads ~/.agents/skills (documented) and ~/.codex/skills (observed), not ~/.claude/skills.
 * - Cursor reads its own folder plus Claude's, Codex's and ~/.agents/skills, recursively,
 *   and only at startup.
 */
export function builtinAgents(homedir: string = os.homedir()): AgentProfile[] {
  const h = (...p: string[]) => path.join(homedir, ...p);
  return [
    {
      id: "claude",
      displayName: "Claude Code",
      skillsDir: h(".claude", "skills"),
      alsoReads: [],
      detectDir: h(".claude"),
      reload: "live",
      // Claude desktop syncs account/organization skills here.
      reserved: ["synced"],
    },
    {
      id: "codex",
      displayName: "Codex",
      skillsDir: h(".agents", "skills"),
      alsoReads: [h(".codex", "skills")],
      detectDir: h(".codex"),
      reload: "unknown",
    },
    {
      id: "cursor",
      displayName: "Cursor",
      skillsDir: h(".cursor", "skills"),
      alsoReads: [h(".claude", "skills"), h(".codex", "skills"), h(".agents", "skills")],
      detectDir: h(".cursor"),
      reload: "restart",
    },
    {
      id: "universal",
      displayName: "Universal (~/.agents/skills)",
      skillsDir: h(".agents", "skills"),
      alsoReads: [],
      reload: "unknown",
    },
  ];
}

/** Agents that share a skills folder (codex and universal) are served by one link. */
export function groupBySkillsDir(agents: AgentProfile[]): { dir: string; agents: AgentProfile[] }[] {
  const groups: { dir: string; agents: AgentProfile[] }[] = [];
  for (const agent of agents) {
    const group = groups.find((g) => samePath(g.dir, agent.skillsDir));
    if (group) group.agents.push(agent);
    else groups.push({ dir: agent.skillsDir, agents: [agent] });
  }
  return groups;
}

export interface LinkGroup {
  dir: string;
  agents: AgentProfile[];
  /**
   * Set when every agent in this group already loads the skill from another group's folder
   * (e.g. Cursor reads ~/.claude/skills). No link is made here then, so the agent does not load
   * the skill twice.
   */
  coveredBy?: { dir: string; agents: string[] };
}

/**
 * Decide which folders need a link for one skill assigned to `agents`. Agents sharing a folder
 * get one link; a group whose agents all read another linked group's folder gets none.
 * Groups that read fewer other folders come first, so coverage is deterministic, two groups can
 * never cover each other, and a covering group is always listed before the groups it covers.
 * Callers should only honour `coveredBy` when the covering group's link is actually in place.
 */
export function planLinkGroups(agents: AgentProfile[]): LinkGroup[] {
  const reads = (g: LinkGroup) => Math.max(...g.agents.map((a) => a.alsoReads.length));
  const order: LinkGroup[] = groupBySkillsDir(agents).sort((a, b) => reads(a) - reads(b));
  const linked: LinkGroup[] = [];
  for (const group of order) {
    const provider = linked.find((p) => group.agents.every((a) => a.alsoReads.some((r) => samePath(r, p.dir))));
    if (provider) group.coveredBy = { dir: provider.dir, agents: provider.agents.map((a) => a.id) };
    else linked.push(group);
  }
  return order;
}

export async function isAgentInstalled(agent: AgentProfile): Promise<boolean> {
  return agent.detectDir === undefined || (await isDirectory(agent.detectDir));
}

/**
 * Turn user-supplied agent ids (possibly comma-separated, or "*" for every installed agent)
 * into profiles. Unknown ids are an error so a typo never silently does nothing.
 */
export async function resolveAgents(requested: string[], agents: AgentProfile[]): Promise<AgentProfile[]> {
  const ids = requested.flatMap((r) => r.split(",")).map((s) => s.trim()).filter(Boolean);
  if (ids.includes("*")) {
    const installed: AgentProfile[] = [];
    for (const a of agents) if (await isAgentInstalled(a)) installed.push(a);
    return installed;
  }
  const result: AgentProfile[] = [];
  for (const id of ids) {
    const agent = agents.find((a) => a.id === id);
    if (!agent) {
      throw new SkillsymError("UNKNOWN_AGENT", `Unknown agent "${id}". Known agents: ${agents.map((a) => a.id).join(", ")}.`, {
        agent: id,
        known: agents.map((a) => a.id),
      });
    }
    if (!result.includes(agent)) result.push(agent);
  }
  return result;
}
