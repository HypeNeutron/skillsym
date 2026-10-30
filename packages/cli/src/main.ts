import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  addSkill,
  assignSkills,
  listSkills,
  openHub,
  resolveHubHome,
  scanStatus,
  SkillsymError,
  type AgentLinkResult,
  type SkillInfo,
  type StatusReport,
} from "@skillsym/core";

/** 0 = success / no drift, 1 = drift or unresolved conflict, 2 = usage error or failure. */
export type ExitCode = 0 | 1 | 2;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
}

const USAGE = `Usage: skillsym <command> [options]

Commands:
  add <path> [-a <agents>]      Copy a skill folder (with SKILL.md) into the hub, optionally assign it
  assign <skill...> -a <agents> Link hub skills into agents' skills folders
  list, ls                      List skills in the hub and their agents
  status                        Show every link's state: synced, missing, dangling, replaced, blocked, orphaned
  check                         Same as status, but exit 1 if anything is not synced (for CI and scripts)

Options:
  -a, --agent <ids>  Agents: claude, codex, cursor, universal; comma-separated or repeated; '*' = all installed
  -s, --skill <name> Skill names (alternative to positional names); '*' = all skills in the hub
  --all              All skills to all installed agents (same as -s '*' -a '*')
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
      const { results } = await assignSkills(hub, { skills: [skill.name], agents });
      if (json) io.stdout(JSON.stringify({ added: skill, assigned: results }));
      else io.stdout(`Added "${skill.name}" to the hub (${skill.path}).\n${formatLinks(results)}`);
      return exitFor(results);
    }
    case "assign": {
      const skills = values.all ? ["*"] : [...rest, ...(values.skill ?? [])];
      if (!skills.length) throw new UsageError("assign needs skill names: skillsym assign <skill...> -a <agents>");
      if (!agents.length) throw new UsageError("assign needs agents: -a claude,codex (or -a '*')");
      const { results } = await assignSkills(hub, { skills, agents });
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
      const report = await scanStatus(hub);
      if (json) io.stdout(JSON.stringify(report));
      else io.stdout(formatStatus(report));
      return command === "check" && !report.clean ? 1 : 0;
    }
    default:
      throw new UsageError(`Unknown command "${command}".\n\n${USAGE}`);
  }
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
};

function formatStatus(report: StatusReport): string {
  const lines: string[] = [];
  if (!report.entries.length) lines.push("No skills assigned yet. Assign one with: skillsym assign <skill> -a <agents>");
  for (const e of report.entries) {
    const label = e.status === "synced" ? "synced  " : e.status.toUpperCase().padEnd(8);
    const who = e.agents.length ? e.agents.join(", ") : "(unassigned)";
    let hint = STATUS_HINT[e.status];
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

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}
