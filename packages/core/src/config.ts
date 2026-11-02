import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { builtinAgents, type AgentProfile } from "./agents.js";
import { SkillsymError } from "./errors.js";
import { writeFileAtomic, writeFileIfAbsent } from "./fsutil.js";
import type { Hub } from "./hub.js";
import { withLock, type LockOptions } from "./lock.js";
import { readManifest } from "./manifest.js";

export const CONFIG_VERSION = 1;

/** One agent as written in config.json. Paths may start with "~" for the user's home folder. */
export interface AgentConfig {
  id: string;
  displayName?: string;
  skillsDir: string;
  alsoReads?: string[];
  detectDir?: string;
  reload?: AgentProfile["reload"];
  reserved?: string[];
}

/** User settings in <hub>/config.json. Agents here are added, or replace a built-in with the same id. */
export interface Config {
  version: number;
  agents: AgentConfig[];
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const RELOADS = ["live", "restart", "unknown"];

/**
 * Create a starter config only if none exists; never touch an existing one. It lists no agents:
 * copying the built-in ones here would pin them and hide later fixes to their folders.
 */
export async function ensureConfig(file: string): Promise<void> {
  const starter = `${JSON.stringify({ version: CONFIG_VERSION, agents: [] }, null, 2)}\n`;
  await writeFileIfAbsent(file, starter);
}

export async function readConfig(file: string): Promise<Config> {
  let raw: string;
  try {
    raw = (await fs.readFile(file, "utf8")).replace(/^﻿/, "");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: CONFIG_VERSION, agents: [] };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid(file, "not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalid(file, "expected a JSON object");
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== CONFIG_VERSION) throw invalid(file, `"version" must be ${CONFIG_VERSION}`);
  const agents = obj.agents ?? [];
  if (!Array.isArray(agents)) throw invalid(file, `"agents" must be an array`);

  const seen = new Set<string>();
  const result: AgentConfig[] = agents.map((a, i) => {
    const where = `agents[${i}]`;
    if (typeof a !== "object" || a === null) throw invalid(file, `${where} must be an object`);
    const agent = a as Record<string, unknown>;
    if (typeof agent.id !== "string" || !ID_PATTERN.test(agent.id)) throw invalid(file, `${where}.id must be letters, digits, "-" or "_"`);
    if (seen.has(agent.id)) throw invalid(file, `agent id "${agent.id}" appears twice`);
    seen.add(agent.id);
    if (typeof agent.skillsDir !== "string" || !agent.skillsDir.trim()) throw invalid(file, `${where}.skillsDir is required`);
    for (const key of ["alsoReads", "reserved"] as const) {
      const v = agent[key];
      if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== "string"))) throw invalid(file, `${where}.${key} must be a list of strings`);
    }
    for (const key of ["displayName", "detectDir"] as const) {
      if (agent[key] !== undefined && typeof agent[key] !== "string") throw invalid(file, `${where}.${key} must be a string`);
    }
    if (agent.reload !== undefined && !RELOADS.includes(agent.reload as string)) throw invalid(file, `${where}.reload must be one of ${RELOADS.join(", ")}`);
    return agent as unknown as AgentConfig;
  });
  return { version: CONFIG_VERSION, agents: result };
}

/** Add an agent to config.json, keeping everything else in the file. An id already known is refused. */
export async function addConfigAgent(hub: Hub, id: string, skillsDir: string, options: { lock?: LockOptions } = {}): Promise<AgentConfig> {
  if (!ID_PATTERN.test(id)) throw new SkillsymError("INVALID_AGENT_ID", `"${id}" is not a valid agent id (letters, digits, "-" or "_"; up to 32 characters).`, { id });
  if (!skillsDir.trim()) throw new SkillsymError("INVALID_AGENT_ID", `Agent "${id}" needs a skills folder.`, { id });
  return withLock(
    hub.lockPath,
    async () => {
      const config = await readConfig(hub.configPath);
      if (config.agents.some((a) => a.id === id)) {
        throw new SkillsymError("AGENT_EXISTS", `Agent "${id}" is already in ${hub.configPath}; edit the file to change it.`, { id });
      }
      if (builtinAgents().some((a) => a.id === id)) {
        throw new SkillsymError("AGENT_EXISTS", `"${id}" is a built-in agent. To change its folder, add it by hand in ${hub.configPath}; a new id can be added here.`, { id });
      }
      const agent: AgentConfig = { id, skillsDir };
      await writeAgents(hub.configPath, [...config.agents, agent]);
      return agent;
    },
    options.lock,
  );
}

/**
 * Take an agent out of config.json. Refused while skills are assigned to it: its links would be left
 * with nothing to say what they belong to. A built-in agent the file overrides goes back to its default.
 */
export async function removeConfigAgent(hub: Hub, id: string, options: { lock?: LockOptions } = {}): Promise<void> {
  await withLock(
    hub.lockPath,
    async () => {
      const config = await readConfig(hub.configPath);
      if (!config.agents.some((a) => a.id === id)) {
        const builtin = builtinAgents().some((a) => a.id === id);
        throw new SkillsymError(
          "AGENT_NOT_IN_CONFIG",
          builtin ? `"${id}" is a built-in agent, not one from your config, so there is nothing to remove.` : `No agent "${id}" in ${hub.configPath}.`,
          { id },
        );
      }
      const manifest = await readManifest(hub.manifestPath);
      const assigned = Object.keys(manifest.skills).filter((name) => manifest.skills[name]!.agents.includes(id));
      if (assigned.length) {
        throw new SkillsymError(
          "AGENT_IN_USE",
          `Agent "${id}" still has ${assigned.length} skill(s) assigned. First run \`skillsym eject -a ${id}\` to leave it real copies, or \`skillsym remove '*' -a ${id}\` to unlink them.`,
          { id, skills: assigned },
        );
      }
      await writeAgents(hub.configPath, config.agents.filter((a) => a.id !== id));
    },
    options.lock,
  );
}

/** Rewrite only the agents list: other fields a newer skillsym may have put in the file stay. */
async function writeAgents(file: string, agents: AgentConfig[]): Promise<void> {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse((await fs.readFile(file, "utf8")).replace(/^\ufeff/, "")) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await writeFileAtomic(file, `${JSON.stringify({ ...raw, version: CONFIG_VERSION, agents }, null, 2)}\n`);
}

/**
 * Built-in agent profiles merged with the user's config.json. A configured agent replaces the
 * built-in one with the same id; others are added.
 */
export async function loadProfiles(hub: Hub, homedir: string = os.homedir()): Promise<AgentProfile[]> {
  const config = await readConfig(hub.configPath);
  const profiles = builtinAgents(homedir);
  for (const a of config.agents) {
    const profile: AgentProfile = {
      id: a.id,
      displayName: a.displayName ?? a.id,
      skillsDir: expand(a.skillsDir, homedir),
      alsoReads: (a.alsoReads ?? []).map((p) => expand(p, homedir)),
      reload: a.reload ?? "unknown",
      ...(a.detectDir !== undefined ? { detectDir: expand(a.detectDir, homedir) } : {}),
      ...(a.reserved !== undefined ? { reserved: a.reserved } : {}),
    };
    const i = profiles.findIndex((p) => p.id === a.id);
    if (i >= 0) profiles[i] = profile;
    else profiles.push(profile);
  }
  return profiles;
}

/** "~" and "~/..." mean the home folder; other relative paths are taken relative to it too. */
function expand(p: string, homedir: string): string {
  if (p === "~") return homedir;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(homedir, p.slice(2));
  return path.resolve(homedir, p);
}

function invalid(file: string, problem: string): SkillsymError {
  return new SkillsymError("CONFIG_INVALID", `Invalid config ${file}: ${problem}. Nothing was changed.`, { file, problem });
}
