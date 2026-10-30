import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { addSkill, listSkills, openHub, resolveHubHome, SkillsymError, type SkillInfo } from "@skillsym/core";

/** 0 = success / no drift, 1 = drift or unresolved conflict, 2 = usage error or failure. */
export type ExitCode = 0 | 1 | 2;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
}

const USAGE = `Usage: skillsym <command> [options]

Commands:
  add <path>        Copy a skill folder (with SKILL.md) into the hub
  list, ls          List skills in the hub

Options:
  --json            Machine-readable output
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
  switch (command) {
    case "add": {
      if (rest.length !== 1) throw new UsageError("add takes exactly one path: skillsym add <path>");
      const skill = await addSkill(hub, rest[0]!);
      if (json) io.stdout(JSON.stringify({ added: skill }));
      else io.stdout(`Added "${skill.name}" to the hub (${skill.path}).`);
      return 0;
    }
    case "list":
    case "ls": {
      if (rest.length) throw new UsageError(`${command} takes no arguments`);
      const skills = await listSkills(hub);
      if (json) io.stdout(JSON.stringify({ skills }));
      else io.stdout(formatList(skills));
      return 0;
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
