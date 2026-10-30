import os from "node:os";
import path from "node:path";
import { SkillsymError } from "./errors.js";
import { isDirectory } from "./fsutil.js";

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
