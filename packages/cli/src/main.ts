import { readFileSync } from "node:fs";
import os from "node:os";
import { parseArgs } from "node:util";
import {
  addSkill,
  assignSkills,
  loadProfiles,
  listSkills,
  openHub,
  resolveHubHome,
  choicesFor,
  defaultForkName,
  planSync,
  removeSkills,
  resolveConflicts,
  scanStatus,
  SkillsymError,
  sync,
  type AgentLinkResult,
  type AgentProfile,
  type ConflictChoice,
  type ConflictDecision,
  type ConflictResolution,
  type Hub,
  type RemoveOutcome,
  type RemoveResult,
  type SkillInfo,
  type StatusReport,
  type SyncAction,
  type SyncActionResult,
  type SyncConflict,
} from "@skillsym/core";

/** 0 = success / no drift, 1 = drift or unresolved conflict, 2 = usage error or failure. */
export type ExitCode = 0 | 1 | 2;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  /** True when a person is at the terminal and can answer questions. */
  interactive?: boolean;
  /** Ask one question and return the typed answer. */
  ask?: (question: string) => Promise<string>;
}

const USAGE = `Usage: skillsym <command> [options]

Commands:
  add <path> [-a <agents>]      Copy a skill folder (with SKILL.md) into the hub, optionally assign it
  assign <skill...> -a <agents> Link hub skills into agents' skills folders
  list, ls                      List skills in the hub and their agents
  status                        Show every link's state: synced, missing, dangling, replaced, blocked, orphaned
  check                         Same as status, but exit 1 if anything is not synced (for CI and scripts)
  sync [--dry-run]              Make the agents' folders match the manifest; asks about conflicts
                                (without a terminal, or with -y, conflicts are only reported)
  remove, rm <skill...> [-a]    With -a: unassign those agents only. Without: remove from every agent
                                and from the hub (asks first; the hub copy is moved to backups)

Options:
  -a, --agent <ids>  Agents: claude, codex, cursor, universal; comma-separated or repeated; '*' = all installed
  -s, --skill <name> Skill names (alternative to positional names); '*' = all skills in the hub
  --all              All skills to all installed agents (same as -s '*' -a '*')
  --dry-run          Show what would change without changing anything
  -y, --yes          Never ask questions (sync conflicts are reported and left alone; remove proceeds)
  --json             Machine-readable output
  -h, --help        Show this help
  -v, --version     Show version`;

class UsageError extends Error {}

export async function main(argv: string[], io: Io): Promise<ExitCode> {
  const json = argv.includes("--json");
  try {
    return await run(argv, io, json);
  } catch (err) {
    return report(err, io, json);
  }
}

async function run(argv: string[], io: Io, json: boolean): Promise<ExitCode> {
  const { values, positionals } = parseCommandLine(argv);
  if (values.version) {
    io.stdout(version());
    return 0;
  }
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    io.stdout(USAGE);
    return command || values.help ? 0 : 2;
  }

  const hub = await openHub(resolveHubHome({ env: io.env }));
  // Agents' folders come from the env we were given, never from process-global state.
  const profiles = await loadProfiles(hub, userHome(io.env));
  const agents = values.all ? ["*"] : (values.agent ?? []);
  switch (command) {
    case "add": {
      if (rest.length !== 1) throw new UsageError("add takes exactly one path: skillsym add <path> [-a <agents>]");
      const skill = await addSkill(hub, rest[0]!);
      if (!agents.length) {
        if (json) io.stdout(JSON.stringify({ added: skill }));
        else io.stdout(`Added "${skill.name}" to the hub (${skill.path}).`);
        return 0;
      }
      const { results } = await assignSkills(hub, { skills: [skill.name], agents, profiles });
      if (json) io.stdout(JSON.stringify({ added: skill, assigned: results }));
      else io.stdout(`Added "${skill.name}" to the hub (${skill.path}).\n${formatLinks(results)}`);
      return exitFor(results);
    }
    case "assign": {
      const skills = values.all ? ["*"] : [...rest, ...(values.skill ?? [])];
      if (!skills.length) throw new UsageError("assign needs skill names: skillsym assign <skill...> -a <agents>");
      if (!agents.length) throw new UsageError("assign needs agents: -a claude,codex (or -a '*')");
      const { results } = await assignSkills(hub, { skills, agents, profiles });
      if (json) io.stdout(JSON.stringify({ assigned: results }));
      else io.stdout(formatLinks(results));
      return exitFor(results);
    }
    case "list":
    case "ls": {
      if (rest.length) throw new UsageError(`${command} takes no arguments`);
      const skills = await listSkills(hub);
      if (json) io.stdout(JSON.stringify({ skills }));
      else io.stdout(formatList(skills));
      return 0;
    }
    case "status":
    case "check": {
      if (rest.length) throw new UsageError(`${command} takes no arguments`);
      const report = await scanStatus(hub, { profiles });
      if (json) io.stdout(JSON.stringify(report));
      else io.stdout(formatStatus(report));
      return command === "check" && !report.clean ? 1 : 0;
    }
    case "sync": {
      if (rest.length) throw new UsageError("sync takes no arguments");
      if (values["dry-run"]) {
        const plan = await planSync(hub, { profiles });
        if (json) io.stdout(JSON.stringify({ dryRun: true, ...plan }));
        else io.stdout(formatSync(plan.actions, plan.conflicts, true));
        return plan.conflicts.length ? 1 : 0;
      }
      const result = await sync(hub, { profiles });
      const canAsk = Boolean(io.interactive && io.ask && !json && !values.yes);
      if (json) io.stdout(JSON.stringify({ dryRun: false, ...result }));
      else io.stdout(formatSync(result.results, canAsk ? [] : result.conflicts, false));
      const failed = result.results.some((r) => !r.ok);
      if (!result.conflicts.length || !canAsk) return failed ? 2 : result.conflicts.length ? 1 : 0;

      const resolutions = await askAndResolve(hub, result.conflicts, io, profiles);
      io.stdout(formatResolutions(resolutions));
      if (failed || resolutions.some((r) => !r.ok)) return 2;
      return resolutions.some((r) => r.choice === "skip") ? 1 : 0;
    }
    case "remove":
    case "rm": {
      const skills = values.all ? ["*"] : [...rest, ...(values.skill ?? [])];
      if (!skills.length) throw new UsageError("remove needs skill names: skillsym remove <skill...> [-a <agents>]");
      // With -a only those agents are unassigned; without it the skill leaves the hub entirely.
      const dropAgents = values.agent?.length ? values.agent : undefined;
      const dryRun = Boolean(values["dry-run"]);
      if (!dropAgents && !dryRun && !values.yes) {
        const what = skills.includes("*") ? "every skill" : skills.map((s) => `"${s}"`).join(", ");
        if (!(io.interactive && io.ask && !json)) {
          throw new UsageError(`Removing ${what} from the hub needs confirmation: add -y (a backup is kept), or use -a to unassign agents only.`);
        }
        const answer = (await io.ask(`Remove ${what} from the hub and every agent? A backup is kept. [y/N] `)).trim().toLowerCase();
        if (answer !== "y" && answer !== "yes") {
          io.stdout("Cancelled; nothing changed.");
          return 1;
        }
      }
      const result = await removeSkills(hub, { skills, ...(dropAgents ? { agents: dropAgents } : {}), profiles, dryRun });
      if (json) io.stdout(JSON.stringify({ dryRun, ...result }));
      else io.stdout(formatRemove(result, dryRun));
      return 0;
    }
    default:
      throw new UsageError(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

const REMOVE_TEXT: Record<RemoveOutcome, [string, string]> = {
  unlinked: ["would unlink", "unlinked"],
  "kept-shared": ["would keep shared link", "kept shared link"],
  "left-in-place": ["would leave (not skillsym's)", "left in place (not skillsym's)"],
  "not-linked": ["no link", "no link"],
  "not-assigned": ["not assigned", "not assigned"],
};

function formatRemove(result: RemoveResult, dryRun: boolean): string {
  const lines = result.links.map((l) => {
    const who = l.agents.length ? l.agents.join(", ") : "(unassigned)";
    return `${REMOVE_TEXT[l.outcome][dryRun ? 0 : 1]}  ${l.skill} -> ${who}${l.path ? `  (${l.path})` : ""}`;
  });
  for (const r of result.removedSkills) {
    lines.push(dryRun ? `would remove "${r.skill}" from the hub (backed up)` : `removed "${r.skill}" from the hub${r.backup ? `; backup: ${r.backup}` : ""}`);
  }
  return lines.length ? lines.join("\n") : "Nothing to remove.";
}

function parseCommandLine(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "boolean" },
        agent: { type: "string", short: "a", multiple: true },
        skill: { type: "string", short: "s", multiple: true },
        all: { type: "boolean" },
        "dry-run": { type: "boolean" },
        yes: { type: "boolean", short: "y" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

function formatList(skills: SkillInfo[]): string {
  if (!skills.length) return "No skills in the hub yet. Add one with: skillsym add <path>";
  const width = Math.max(...skills.map((s) => s.name.length));
  return skills.map((s) => `${s.name.padEnd(width)}  ${s.agents.length ? s.agents.join(", ") : "(not assigned)"}`).join("\n");
}

const OUTCOME_MARK: Record<AgentLinkResult["outcome"], string> = {
  linked: "linked        ",
  "already-linked": "already linked",
  blocked: "BLOCKED       ",
  failed: "FAILED        ",
  covered: "covered       ",
};

function formatLinks(results: AgentLinkResult[]): string {
  if (!results.length) return "Nothing to assign.";
  return results
    .map((r) => {
      const line = `${OUTCOME_MARK[r.outcome]}  ${r.skill} -> ${r.agents.join(", ")}  (${r.path})`;
      return r.reason ? `${line}\n                ${r.reason}` : line;
    })
    .join("\n");
}

const STATUS_HINT: Record<StatusReport["entries"][number]["status"], string> = {
  synced: "",
  missing: "nothing at this path; `skillsym sync` will link it",
  dangling: "link points to a hub location that no longer exists; `skillsym sync` will re-link it",
  replaced: "skillsym's link was replaced",
  blocked: "occupied by something skillsym did not create; use `skillsym import`",
  orphaned: "no longer assigned in the manifest; `skillsym sync` will remove the link",
  covered: "",
  duplicate: "the agent also loads this skill from another folder, so it is loaded twice; `skillsym sync` will remove this link",
};

function formatStatus(report: StatusReport): string {
  const lines: string[] = [];
  if (!report.entries.length) lines.push("No skills assigned yet. Assign one with: skillsym assign <skill> -a <agents>");
  for (const e of report.entries) {
    const label = e.status === "synced" || e.status === "covered" ? e.status.padEnd(8) : e.status.toUpperCase().padEnd(8);
    const who = e.agents.length ? e.agents.join(", ") : "(unassigned)";
    let hint = STATUS_HINT[e.status];
    if (e.status === "covered" && e.coveredBy) hint = `loads it from ${e.coveredBy.dir} (${e.coveredBy.agents.join(", ")}); no second link needed`;
    if (e.status === "replaced") hint += e.sameContent ? " by an identical copy; `skillsym sync` will re-link it" : " by different content; `skillsym sync` will ask";
    lines.push(`${label}  ${e.skill} -> ${who}  (${e.path})${hint ? `\n          ${hint}` : ""}`);
  }
  for (const u of report.unmanaged) {
    lines.push(`unmanaged ${u.name} in ${u.agents.join(", ")}  (${u.path})  — bring it in with \`skillsym import\``);
  }
  for (const w of report.warnings) lines.push(`warning: ${w.message}`);

  const counts = new Map<string, number>();
  for (const e of report.entries) counts.set(e.status, (counts.get(e.status) ?? 0) + 1);
  const summary = [...counts].map(([s, n]) => `${n} ${s}`);
  if (report.unmanaged.length) summary.push(`${report.unmanaged.length} unmanaged`);
  if (summary.length) lines.push("", `${summary.join(", ")}.${report.clean ? "" : " Drift found."}`);
  return lines.join("\n");
}

const ACTION_TEXT: Record<SyncAction["type"], [string, string]> = {
  link: ["would link", "linked"],
  relink: ["would re-link", "re-linked"],
  "replace-identical": ["would restore link over identical copy", "restored link over identical copy"],
  "unlink-orphan": ["would remove unassigned link", "removed unassigned link"],
  "unlink-duplicate": ["would remove duplicate link", "removed duplicate link"],
  forget: ["would stop tracking", "stopped tracking"],
  record: ["would record existing link", "recorded existing link"],
};

function formatSync(actions: (SyncAction | SyncActionResult)[], conflicts: SyncConflict[], dryRun: boolean): string {
  const lines: string[] = [];
  for (const a of actions) {
    const failed = "ok" in a && !a.ok;
    const verb = failed ? "FAILED" : ACTION_TEXT[a.type][dryRun ? 0 : 1];
    const who = a.agents.length ? a.agents.join(", ") : "(unassigned)";
    let line = `${verb}  ${a.skill} -> ${who}  (${a.path})`;
    if ("backup" in a && a.backup) line += `\n          backup: ${a.backup}`;
    if (failed) line += `\n          ${(a as SyncActionResult).error}`;
    lines.push(line);
  }
  for (const c of conflicts) {
    lines.push(`CONFLICT  ${c.skill} -> ${c.agents.join(", ") || "(unassigned)"}  (${c.path})\n          ${c.message}`);
  }
  if (!actions.length && !conflicts.length) return "Already in sync.";
  if (conflicts.length) lines.push("", `${conflicts.length} conflict(s) left untouched.`);
  return lines.join("\n");
}

const CHOICE_HELP: Record<ConflictChoice, string> = {
  adopt: "use the agent's version as the hub version (hub version backed up)",
  restore: "put skillsym's link back (what is there now is backed up)",
  fork: "keep the agent's version as a new skill for this agent only",
  drop: "accept the removal and unassign the skill from this agent",
  skip: "decide later; change nothing",
};

const CONFLICT_TITLE: Record<SyncConflict["type"], string> = {
  "replaced-different": "was replaced by different content",
  "missing-owned": "link was removed",
  blocked: "is occupied by something skillsym did not create (use `skillsym import`)",
  "hub-skill-missing": "has no folder in the hub any more",
};

/** Ask about each conflict in turn, then apply all decisions in one locked pass. */
async function askAndResolve(hub: Hub, conflicts: SyncConflict[], io: Io, profiles: AgentProfile[]): Promise<ConflictResolution[]> {
  const decisions: ConflictDecision[] = [];
  for (const c of conflicts) {
    const choices = choicesFor(c.type);
    io.stdout(`\n${c.skill} -> ${c.agents.join(", ")} ${CONFLICT_TITLE[c.type]}\n  ${c.path}`);
    for (const choice of choices) io.stdout(`  [${choice[0]}] ${choice.padEnd(7)} ${CHOICE_HELP[choice]}`);
    const choice = await askChoice(io, choices);
    const decision: ConflictDecision = { path: c.path, choice };
    if (choice === "fork") {
      const suggested = defaultForkName(c);
      const name = (await io.ask!(`  New skill name [${suggested}]: `)).trim();
      decision.forkName = name || suggested;
    }
    decisions.push(decision);
  }
  return resolveConflicts(hub, decisions, { profiles });
}

async function askChoice(io: Io, choices: ConflictChoice[]): Promise<ConflictChoice> {
  const prompt = `  Choose ${choices.map((c) => c[0]).join("/")} (default s): `;
  for (;;) {
    const answer = (await io.ask!(prompt)).trim().toLowerCase();
    if (!answer) return "skip";
    const match = choices.find((c) => c === answer || c[0] === answer);
    if (match) return match;
    io.stdout(`  Please answer one of: ${choices.join(", ")}`);
  }
}

function formatResolutions(results: ConflictResolution[]): string {
  const lines = results.map((r) => {
    const skill = r.conflict?.skill ?? r.path;
    if (!r.ok) return `FAILED  ${r.choice} ${skill}: ${r.error}`;
    if (r.choice === "skip") return `skipped ${skill}`;
    let line = `${r.choice.padEnd(7)} ${skill}${r.newSkill ? ` -> new skill "${r.newSkill}"` : ""}`;
    for (const b of r.backups) line += `\n        backup: ${b}`;
    return line;
  });
  return ["", ...lines].join("\n");
}

/** A link we could not create is an error (2); a path occupied by something else is a conflict (1). */
function exitFor(results: AgentLinkResult[]): ExitCode {
  if (results.some((r) => r.outcome === "failed")) return 2;
  if (results.some((r) => r.outcome === "blocked")) return 1;
  return 0;
}

function report(err: unknown, io: Io, json: boolean): ExitCode {
  const error =
    err instanceof SkillsymError
      ? { code: err.code, message: err.message, details: err.details }
      : err instanceof UsageError
        ? { code: "USAGE", message: err.message, details: {} }
        : { code: "INTERNAL", message: (err as Error)?.message ?? String(err), details: {} };
  if (json) io.stdout(JSON.stringify({ error }));
  else io.stderr(`skillsym: ${error.message}`);
  return 2;
}

/** The user's home directory as the given environment defines it (what os.homedir() reads). */
function userHome(env: NodeJS.ProcessEnv): string {
  const fromEnv = process.platform === "win32" ? env.USERPROFILE : env.HOME;
  return fromEnv?.trim() || os.homedir();
}

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}
