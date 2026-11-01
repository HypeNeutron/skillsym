import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { builtinAgents, type AgentProfile } from "./agents.js";
import { SkillsymError } from "./errors.js";
import type { Hub } from "./hub.js";

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
  try {
    await fs.writeFile(file, starter, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
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
