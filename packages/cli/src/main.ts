import { spawn } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { complete, completionScript, COMPLETION_SHELLS } from "./completion.js";
import { commandHelp } from "./help.js";
import {
  addSkill,
  assignSkills,
  isAgentInstalled,
  resolveAgents,
  loadProfiles,
  readConfig,
  listSkills,
  openHub,
  hubPaths,
  resolveHubHome,
  choicesFor,
  isValidSkillName,
  defaultForkName,
  planSync,
  planImport,
  importSkills,
  importVersions,
  resolveImportConflicts,
  continueImport,
  abortImport,
  readPendingImport,
  removeSkills,
  eject,
  initSkill,
  hubLocationWarnings,
  cloudSyncProvider,
  isDirectory,
  isFile,
  planLibraryAdd,
  addLibrary,
  type LibraryItem,
  parseRemoteTarget,
  planRemoteAdd,
  addRemoteSkills,
  addRemoteUpstreams,
  planUpdate,
  updateSkills,
  resolveUpdateConflicts,
  markUpstreamsReviewed,
  type ParsedRemoteTarget,
  type RemoteAddItem,
  type AttachUpstreamResult,
  type UpdateDecision,
  type UpdateItem,
  type UpdateResolution,
  type UpstreamReviewDecision,
  type UpstreamReviewResult,
  resolveConflicts,
  scanStatus,
  type UnlinkResult,
  type LibraryInfo,
  readManifest,
  unlinkLibrary,
  removeLibrary,
  listLibraries,
  findLibrary,
  hasLibrarySnapshot,
  isInGit,
  addConfigAgent,
  writeNewSkillsAgents,
  removeConfigAgent,
  filterStatus,
  SkillsymError,
  sync,
  choicesForConflict,
  planAntigravityMigration,
  applyAntigravityMigration,
  type MigrationPlan,
  type MigrationResult,
  type AgentLinkResult,
  type AgentProfile,
  type ConflictChoice,
  type ConflictDecision,
  type ConflictResolution,
  type Hub,
  type BinaryConflict,
  type EjectOutcome,
  type EjectReport,
  type ImportChoice,
  type ImportDecision,
  type ImportDecisionResult,
  type ImportItem,
  type ImportItemResult,
  type RemoveOutcome,
  type RemoveResult,
  type SkillInfo,
  type StatusReport,
  type SyncAction,
  type SyncActionResult,
  type SyncConflict,
  type SyncOptions,
} from "@skillsym/core";

/** 0 = success / no drift, 1 = drift or unresolved conflict, 2 = usage error or failure. */
export type ExitCode = 0 | 1 | 2;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  /** Working directory for commands that create files (init); defaults to the process's. */
  cwd?: string;
  /** True when a person is at the terminal and can answer questions. */
  interactive?: boolean;
  /** Ask one question and return the typed answer. Rejects with PromptCancelled on Ctrl+C or end of input. */
  ask?: (question: string) => Promise<string>;
}

/** The user pressed Ctrl+C (or input ended) at a question: nothing they answered is applied. */
export class PromptCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "PromptCancelled";
  }
}

const PROMPT_KEYS = "Enter = skip · q = skip all the rest · Ctrl+C = cancel without applying any answer";

const USAGE = `Usage: skillsym <command> [options]   (ssym is the short name, once installed globally)

Commands:
  init [name]                   Create a SKILL.md template (in ./<name>, or here without a name)
  add <path|repo> [-a <agents>] Copy a skill folder, library, or GitHub/git repo into the hub, optionally assign it.
                                A folder of skills or GitHub repo adds every skill in it (or only -s <skill>); local
                                libraries stay untouched (--dry-run to preview). With --link the hub links to the source
  assign <skill...> -a <agents> Link hub skills into agents' skills folders
  list, ls [-a <agents>]        List skills in the hub and their agents (with -a, only those agents' skills)
  open <skill>                  Print a skill's folder and open it in your editor (a --link skill: in your library)
  status [skill...] [-a <agents>] [--only <states>] [--all]
                                Show what needs attention (missing, dangling, replaced, blocked, orphaned,
                                duplicate, source-missing), unmanaged skills and library news, by status, with a
                                count. --all also lists links that are fine (synced, covered); --only lists these
                                statuses, comma-separated; names and -a narrow it to those skills and agents
  check                         Same as status, but exit 1 if anything is not synced (for CI and scripts)
  sync [skill...] [-a <agents>] [--dry-run]
                                Make the agents' folders match the manifest (with names or -a, only those);
                                asks about conflicts
                                (without a terminal, or with -y, conflicts are only reported)
  update [skill...] [--dry-run] Fetch and update GitHub/git-tracked skills in the hub (backs up cleanly, asks
                                before overwriting local edits)
  import [skill...] [-a <agents>] [--dry-run]
                                Bring skills already in agents' folders into the hub (originals backed up,
                                replaced by links); copies that differ: choose one, keep both, or merge.
                                With names or -a, only those: other agents' copies are not compared or touched
  import --continue | --abort   Finish or drop an open merge
  remove, rm <skill...> [-a]    With -a: unassign those agents only. Without: remove from every agent
                                and from the hub (asks first; the hub copy is moved to backups)
  lib, library                  List your libraries: skills, whether they are there, and whether they are in git
  lib open <name>               Print a library's folder and open it
  lib unlink <name>             Stop using a library but keep its skills: agents keep working on real hub copies
  lib rm <name>                 Remove a library's skills from the hub and every agent (asks first; files stay)
  completion <shell>            Print the script that turns on Tab for skill names: powershell, bash or zsh
  config                        Show the config file's location and every agent with its skills folder
  config add <id> <folder>      Add an agent to the config file
  config remove <id>            Take an agent out of the config file (not while skills are assigned to it)
  eject [--dry-run]             Stop using skillsym: replace every skillsym link with a real copy (asks first;
                                the hub is kept, delete it yourself when you are sure)
  eject <skill...> [-a <agents>] Give back only these skills or agents: their links become real copies of the
  eject -a <agents>             latest hub version. A skill no agent uses afterwards leaves the hub (copy in backups)
  migrate [--dry-run]           Migrate legacy Antigravity config/links to built-in antigravity skills-json delivery

Options:
  -a, --agent <ids>  Agents: claude, codex, cursor, gemini, antigravity, universal; comma-separated or repeated; '*' = all installed
  -s, --skill <name> Skill names (alternative to positional names); '*' = all skills in the hub
                     Names in assign, remove, eject and import may be patterns: 'gcp-*', 'skill-?'
  --only <states>    status, check: only these statuses, comma-separated (synced, covered, missing, ...)
  --all              assign: every skill, to every installed agent unless -a names some;
                     add: every installed agent; remove: every skill;
                     status, check: list every link
  -dr, --dry-run     Show what would change without changing anything
  --link             With add: link to your library instead of copying (the library stays the source of truth)
  --upstream <skill> With add: watch a repo for an existing orchestrator skill without editing its files
  --mark-reviewed    With update: mark watched orchestrator upstream changes as reviewed
  -y, --yes          Never ask questions: sync/import conflicts are reported and left alone; remove and eject proceed
  -g, --global       User-level skills (the default; accepted for familiarity with npx skills)
  -p, --project      Project-level skills: not available until v0.2
  --json             Machine-readable output
  -h, --help        Show this help
  -v, --version     Show version

Details and examples for one command: skillsym <command> -h`;

class UsageError extends Error {}

/** The command needs a skill name and got none: the error comes with the names to choose from. */
class MissingSkillName extends UsageError {}

/** Options each command acts on. Any other is refused: silently ignoring -a once meant "every agent". */
export const COMMAND_OPTIONS: Record<string, string[]> = {
  init: [],
  // These never ask, but -y is a common habit and harmless.
  add: ["agent", "skill", "all", "dry-run", "link", "upstream", "yes"],
  assign: ["agent", "skill", "all", "yes"],
  list: ["agent"],
  ls: ["agent"],
  status: ["all", "agent", "skill", "only"],
  check: ["all", "agent", "skill", "only"],
  sync: ["agent", "skill", "dry-run", "yes"],
  update: ["skill", "all", "dry-run", "mark-reviewed", "yes"],
  import: ["agent", "skill", "dry-run", "yes", "continue", "abort"],
  remove: ["agent", "skill", "all", "dry-run", "yes"],
  rm: ["agent", "skill", "all", "dry-run", "yes"],
  eject: ["agent", "skill", "dry-run", "yes"],
  config: [],
  open: [],
  completion: [],
  lib: ["dry-run", "yes"],
  library: ["dry-run", "yes"],
  migrate: ["dry-run", "yes"],
};
const GLOBAL_OPTIONS = ["json", "help", "version", "global", "project"];

function needsSkillNames(err: unknown): boolean {
  if (err instanceof MissingSkillName) return true;
  return err instanceof SkillsymError && ["SKILL_NOT_IN_HUB", "NO_SKILL_MATCHES", "NOTHING_TO_IMPORT"].includes(err.code);
}

/** Enough to choose from without burying the error above it. */
const LIST_LIMIT = 20;

function skillChoices(skills: SkillInfo[]): string {
  const more = skills.length - LIST_LIMIT;
  const list = formatList(skills.slice(0, LIST_LIMIT), "  ");
  return `\nSkills in the hub:\n${list}${more > 0 ? `\n  ...and ${more} more: skillsym list` : ""}`;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** Up to three names close to what was typed: a typo of it, or one containing it. */
export function closestNames(typed: string, names: string[]): string[] {
  const wanted = typed.replace(/[*?]/g, "").toLowerCase();
  if (!wanted) return [];
  const allowed = Math.max(1, Math.floor(wanted.length / 3));
  return names
    .map((name) => ({ name, distance: editDistance(wanted, name.toLowerCase()), contains: wanted.length >= 3 && name.toLowerCase().includes(wanted) }))
    .filter((n) => n.distance <= allowed || n.contains)
    .sort((x, y) => x.distance - y.distance || x.name.localeCompare(y.name))
    .slice(0, 3)
    .map((n) => n.name);
}

/**
 * bash and zsh turn an unquoted * into the file names here before skillsym runs, so "assign * -a x"
 * arrives as "assign AppData Contacts ... -a x". Several names that are all files here give that away.
 */
function shellExpandedStar(argv: string[], cwd: string): boolean {
  const names = argv.filter((word, i) => !word.startsWith("-") && !["-a", "--agent", "-s", "--skill", "--only"].includes(argv[i - 1] ?? "")).slice(1);
  if (names.length < 2) return false;
  return names.every((name) => {
    try {
      lstatSync(path.resolve(cwd, name));
      return true;
    } catch {
      return false;
    }
  });
}

function didYouMean(err: unknown, names: string[]): string | undefined {
  if (!(err instanceof SkillsymError)) return undefined;
  const typed = err.details.skill ?? err.details.pattern;
  if (typeof typed !== "string") return undefined;
  const close = closestNames(typed, names);
  if (!close.length) return undefined;
  const last = close.pop()!;
  return `\nDid you mean ${close.length ? `${close.join(", ")} or ${last}` : last}?`;
}

/** After a missing or unknown skill name, show the names that would work, so nobody has to run another command. */
async function showSkillNames(err: unknown, argv: string[], io: Io): Promise<void> {
  try {
    const expanded = shellExpandedStar(argv, io.cwd ?? process.cwd());
    if (expanded) io.stderr("\nIt looks like your shell turned * into the names of the files in this folder. Put it in quotes: '*'");
    const hub = hubPaths(resolveHubHome({ env: io.env }));
    const profiles = await loadProfiles(hub, userHome(io.env));
    if (argv.find((a) => !a.startsWith("-")) === "import") {
      const { unmanaged } = await scanStatus(hub, { profiles });
      const names = [...new Set(unmanaged.map((u) => u.name))];
      if (!names.length) return io.stderr("\nNothing in your agents' folders is waiting to be imported.");
      const suggestion = expanded ? undefined : didYouMean(err, names);
      if (suggestion) io.stderr(suggestion);
      const more = names.length - LIST_LIMIT;
      io.stderr(["", "Skills you can import:", ...names.slice(0, LIST_LIMIT).map((n) => `  ${n}`), ...(more > 0 ? [`  ...and ${more} more: skillsym status --only unmanaged`] : [])].join("\n"));
      return;
    }
    const skills = await listSkills(hub);
    if (!skills.length) return io.stderr("\nThe hub has no skills yet. Add one with: skillsym add <path>");
    const suggestion = expanded ? undefined : didYouMean(err, skills.map((s) => s.name));
    if (suggestion) io.stderr(suggestion);
    io.stderr(skillChoices(skills));
  } catch {
    // The list is a courtesy; the error above already said what went wrong.
  }
}

/** What the shell scripts call on Tab: one candidate per line. Never fails loudly, and never creates anything. */
async function runComplete(argv: string[], io: Io): Promise<ExitCode> {
  try {
    const hub = hubPaths(resolveHubHome({ env: io.env }));
    const home = userHome(io.env);
    const profiles = () => loadProfiles(hub, home);
    const candidates = await complete((argv[0] ?? "=").slice(1), argv.slice(1), {
      commands: [...new Set([...Object.keys(COMMAND_OPTIONS), "help"])].sort(),
      options: COMMAND_OPTIONS,
      statuses: STATUS_ORDER,
      skills: async () => (await listSkills(hub)).map((s) => s.name),
      importable: async () => (await scanStatus(hub, { profiles: await profiles() })).unmanaged.map((u) => u.name),
      agents: async () => (await profiles()).map((p) => p.id),
      configAgents: async () => (await readConfig(hub.configPath)).agents.map((a) => a.id),
      libraries: async () => (await listLibraries(hub)).map((l) => l.name),
    });
    if (candidates.length) io.stdout(candidates.join("\n"));
  } catch {
    // A broken config must not print errors into the middle of the line being typed.
  }
  return 0;
}

export async function main(argv: string[], io: Io): Promise<ExitCode> {
  if (argv[0] === "__complete") return runComplete(argv.slice(1), io);
  const json = argv.includes("--json");
  try {
    return await run(argv, io, json);
  } catch (err) {
    if (err instanceof PromptCancelled) {
      io.stdout("\nCancelled. None of your answers were applied; run the command again when you are ready to decide.");
      return 1;
    }
    const code = report(err, io, json);
    if (!json && needsSkillNames(err)) await showSkillNames(err, argv, io);
    return code;
  }
}

async function run(argv: string[], io: Io, json: boolean): Promise<ExitCode> {
  const { values, positionals } = parseCommandLine(argv);
  if (values.version) {
    io.stdout(version());
    return 0;
  }
  const [command, ...rest] = positionals;
  // `skillsym help status` and `skillsym status -h` are the same thing.
  const helpFor = command === "help" ? rest[0] : values.help ? command : undefined;
  if (helpFor) {
    const text = commandHelp(helpFor);
    if (!text) throw new UsageError(`Unknown command "${helpFor}".\n\n${USAGE}`);
    io.stdout(text);
    return 0;
  }
  if (command === "help" || values.help || !command) {
    io.stdout(USAGE);
    return command || values.help ? 0 : 2;
  }

  const accepted = COMMAND_OPTIONS[command];
  if (accepted) {
    for (const option of Object.keys(values)) {
      if (!accepted.includes(option) && !GLOBAL_OPTIONS.includes(option)) {
        throw new UsageError(`${command} does not take --${option}. See \`skillsym --help\`.`);
      }
    }
  }

  if (values.project) {
    throw new UsageError(
      "Project scope (-p, --project) arrives in v0.2. For now skillsym manages user-level skills only (the default, -g).",
    );
  }

  if (command === "completion") {
    const script = rest.length === 1 ? completionScript(rest[0]!) : undefined;
    if (!script) throw new UsageError(`completion takes one shell: skillsym completion <${COMPLETION_SHELLS.join("|")}>`);
    io.stdout(script);
    return 0;
  }

  // init only writes a template; it must not create or touch the hub.
  if (command === "init") {
    if (rest.length > 1) throw new UsageError("init takes at most one name: skillsym init [name]");
    const created = await initSkill(io.cwd ?? process.cwd(), rest[0]);
    if (json) io.stdout(JSON.stringify({ created }));
    else {
      io.stdout(
        [
          `Created ${created.skillMd}`,
          "Next:",
          "  1. Edit SKILL.md: replace the description and instructions with your own.",
          `  2. Add it to the hub and your agents: skillsym add ${rest[0] ?? "."} -a claude   (or -a '*' for every installed agent)`,
        ].join("\n"),
      );
    }
    return 0;
  }

  const writes = (["add", "assign", "sync", "update", "remove", "rm", "import", "eject", "migrate"].includes(command) && !values["dry-run"]) || (command === "config" && rest.length > 0) || ((command === "lib" || command === "library") && ["unlink", "rm", "remove"].includes(rest[0] ?? "") && !values["dry-run"]);
  // Only commands that change something create the hub; status, list and --dry-run leave the disk alone.
  const home = resolveHubHome({ env: io.env });
  const hub = writes ? await openHub(home) : hubPaths(home);
  // Agents' folders come from the env we were given, never from process-global state.
  const profiles = await loadProfiles(hub, userHome(io.env));
  // --all fills in what was not named: "--all -a codex" is every skill, for Codex only.
  const agents = values.agent?.length ? values.agent : values.all ? ["*"] : [];
  const showsPending = writes || command === "status" || command === "check";
  const locationWarnings = hubLocationWarnings(hub, io.env);
  if (writes && !json) for (const w of locationWarnings) io.stderr(`warning: ${w.message}`);
  if (showsPending && !(command === "import" && (values.continue || values.abort))) {
    const pending = await readPendingImport(hub);
    if (pending) io.stderr(`warning: a merge of "${pending.skill}" is still open in ${pending.mergeDir}; finish it with \`skillsym import --continue\` or drop it with \`--abort\`.`);
  }
  switch (command) {
    case "add": {
      if (rest.length !== 1) throw new UsageError("add takes one path or GitHub repo: skillsym add <path|owner/repo> [-a <agents>]");
      const rawTarget = rest[0]!;
      const cwd = io.cwd ?? process.cwd();
      const remoteTarget = await parseRemoteTarget(rawTarget, cwd);
      if (values.upstream) {
        if (!remoteTarget) {
          throw new UsageError("--upstream requires a GitHub repo or git URL: skillsym add <owner/repo> [-s <skill>] --upstream <hub-skill>");
        }
        if (values.link || values.agent?.length) {
          throw new UsageError("--upstream only attaches upstream watch metadata; omit --link and -a");
        }
        const attached = await addRemoteUpstreams(hub, remoteTarget, values.upstream, {
          ...(values.skill?.length ? { skills: values.skill } : {}),
          dryRun: Boolean(values["dry-run"]),
        });
        if (json) io.stdout(JSON.stringify({ dryRun: Boolean(values["dry-run"]), ...attached }));
        else io.stdout(formatUpstreamAttach(attached, Boolean(values["dry-run"])));
        return 0;
      }
      if (remoteTarget) {
        return addFromRemote(hub, remoteTarget, values.skill ?? [], agents, profiles, io, json, Boolean(values["dry-run"]), Boolean(values.link));
      }
      const target = path.resolve(cwd, rawTarget);
      // A folder without its own SKILL.md is a library: add every skill found in it.
      if ((await isDirectory(target)) && (values.link || !(await isFile(path.join(target, "SKILL.md"))))) {
        return addFromLibrary(hub, target, values.skill ?? [], agents, profiles, io, json, Boolean(values["dry-run"]), Boolean(values.link));
      }
      if (values["dry-run"]) throw new UsageError("--dry-run with add is for repositories or libraries; adding one local skill changes only the hub");
      if (values.skill?.length) {
        // Validate explicit `-s` when pointing directly at a single skill directory.
        await planLibraryAdd(hub, target, { skills: values.skill });
      }
      const skill = await addSkill(hub, target, { profiles });
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
      if (!skills.length) throw new MissingSkillName("assign needs skill names: skillsym assign <skill...> -a <agents>");
      if (!agents.length) throw new UsageError("assign needs agents: -a claude,codex (or -a '*')");
      const { results } = await assignSkills(hub, { skills, agents, profiles });
      if (json) io.stdout(JSON.stringify({ assigned: results }));
      else io.stdout(results.length ? formatLinks(results) : "Nothing to assign: the hub has no skills yet. Add one with: skillsym add <path>");
      return exitFor(results);
    }
    case "list":
    case "ls": {
      if (rest.length) throw new UsageError(`${command} takes no arguments`);
      const ids = agents.length ? (await resolveAgents(agents, profiles)).map((a) => a.id) : undefined;
      const skills = (await listSkills(hub)).filter((s) => !ids || s.agents.some((a) => ids.includes(a)));
      if (json) io.stdout(JSON.stringify({ skills }));
      else if (ids && !skills.length) io.stdout(`No skills assigned to ${ids.join(", ")}.`);
      else io.stdout(formatList(skills, "", (await readManifest(hub.manifestPath)).libraries));
      return 0;
    }
    case "status":
    case "check": {
      const report = await scanStatus(hub, { profiles });
      report.warnings.unshift(...locationWarnings);
      const skills = [...rest, ...(values.skill ?? [])];
      const only = (values.only ?? []).flatMap((o) => o.split(",")).map((o) => o.trim().toLowerCase()).filter(Boolean);
      for (const state of only) {
        if (!STATUS_ORDER.includes(state)) throw new UsageError(`--only: unknown status "${state}". Use: ${STATUS_ORDER.join(", ")}`);
      }
      // values.agent, not `agents`: --all here means "list every link", not "every agent".
      const filtered = skills.length > 0 || Boolean(values.agent?.length);
      const chosen = await filterStatus(hub, report, { profiles, ...(skills.length ? { skills } : {}), ...(values.agent?.length ? { agents: values.agent } : {}) });
      const view: StatusReport = {
        ...report,
        entries: chosen.entries.filter((e) => !only.length || only.includes(e.status)),
        unmanaged: chosen.unmanaged.filter(() => !only.length || only.includes("unmanaged")),
        // Hub folders belong to no agent: a skill or agent filter narrows them away, --only keeps them when asked.
        unregistered: report.unregistered.filter((u) => !values.agent?.length && (!only.length || only.includes("unregistered"))).filter(
          (u) => !skills.length || skillMatches(skills, u.name),
        ),
      };
      // What is clean depends on what was asked about; a report on everything keeps its library checks.
      if (filtered || only.length) view.clean = view.entries.every((e) => e.status === "synced" || e.status === "covered") && !view.unregistered.length;
      if (json) io.stdout(JSON.stringify(view));
      else {
        io.stdout(formatStatus(view, Boolean(values.all) || only.length > 0, filtered || only.length > 0));
        // It just said "assign <skill>": show which.
        if (!report.entries.length && !filtered && !only.length) {
          const inHub = await listSkills(hub);
          if (inHub.length) io.stdout(skillChoices(inHub));
        }
      }
      return command === "check" && !view.clean ? 1 : 0;
    }
    case "sync": {
      const skills = [...rest, ...(values.skill ?? [])];
      const canAsk = Boolean(io.interactive && io.ask && !json && !values.yes);
      let activeProfiles = profiles;
      if (canAsk && !values["dry-run"] && !skills.length && !agents.length) {
        const migPlan = await planAntigravityMigration(hub, { profiles: activeProfiles, homedir: userHome(io.env) });
        if (migPlan.needed) {
          const migrated = await promptAntigravityMigration(hub, migPlan, io, activeProfiles);
          if (migrated) activeProfiles = await loadProfiles(hub, userHome(io.env));
        }
      }
      const choice: SyncOptions = { profiles: activeProfiles, ...(skills.length ? { skills } : {}), ...(agents.length ? { agents } : {}) };
      if (values["dry-run"]) {
        const plan = await planSync(hub, choice);
        if (json) io.stdout(JSON.stringify({ dryRun: true, ...plan }));
        else io.stdout(formatSync(plan.actions, plan.conflicts, true, plan.registrations, plan.unregistered));
        return plan.conflicts.length || plan.unregistered.length ? 1 : 0;
      }
      // Only the person answers for a new skill; without a saved setting and a way to ask, it is just reported.
      if (canAsk) {
        const preview = await planSync(hub, choice);
        if (preview.unregistered.some((u) => !u.reason)) {
          const answers = await askNewSkills(hub, preview.unregistered.filter((u) => !u.reason), io, activeProfiles);
          if (Object.keys(answers).length) choice.newSkillAgents = answers;
        }
      }
      const result = await sync(hub, choice);
      if (!json && result.snapshotFailed.length) io.stderr(`warning: could not update the library snapshot of ${result.snapshotFailed.join(", ")}.`);
      if (json) io.stdout(JSON.stringify({ dryRun: false, ...result }));
      // About to ask about conflicts with nothing else to report: "Already in sync" would be untrue.
      else if (result.results.length || result.registrations.length || result.unregistered.length || !result.conflicts.length || !canAsk) {
        io.stdout(formatSync(result.results, canAsk ? [] : result.conflicts, false, result.registrations, result.unregistered));
      }
      const failed = result.results.some((r) => !r.ok);
      if (!result.conflicts.length || !canAsk) return failed ? 2 : result.conflicts.length || result.unregistered.length ? 1 : 0;

      const resolutions = await askAndResolve(hub, result.conflicts, io, activeProfiles);
      io.stdout(formatResolutions(resolutions));
      if (resolutions.some((r) => r.choice === "skip")) io.stdout("\nSkipped conflicts are unchanged. Run `skillsym sync` again whenever you want to decide them.");
      if (failed || resolutions.some((r) => !r.ok)) return 2;
      return resolutions.some((r) => r.choice === "skip") || result.unregistered.length ? 1 : 0;
    }
    case "update": {
      if (agents.length && values.agent?.length) throw new UsageError("update does not take -a; agent links already point to the hub");
      if (values["dry-run"] && values["mark-reviewed"]) throw new UsageError("use either --dry-run or --mark-reviewed, not both");
      const skills = values.all ? [] : [...rest, ...(values.skill ?? [])];
      const markReviewed = Boolean(values["mark-reviewed"]);
      const choice = { profiles, ...(skills.length ? { skills } : {}), ...(markReviewed ? { markReviewed: true } : {}) };
      const canAsk = Boolean(io.interactive && io.ask && !json && !values.yes);
      if (values["dry-run"]) {
        const plan = await planUpdate(hub, choice);
        if (json) io.stdout(JSON.stringify({ dryRun: true, ...plan }));
        else io.stdout(formatUpdates(plan.items, true, Boolean(skills.length), false));
        return plan.items.some((i) => i.status === "conflict" || i.status === "upstream-missing" || i.status === "upstream-changed") ? 1 : 0;
      }
      const result = await updateSkills(hub, choice);
      const conflicts = result.items.filter((i) => i.status === "conflict");
      const watched = result.items.filter((i) => i.status === "upstream-changed");
      const missingUpstream = result.items.some((i) => i.status === "upstream-missing");
      if (!json && result.snapshotFailed.length) io.stderr(`warning: could not update the library snapshot of ${result.snapshotFailed.join(", ")}.`);
      if (json) io.stdout(JSON.stringify({ dryRun: false, ...result }));
      else if (result.items.some((i) => i.status !== "conflict" && i.status !== "upstream-changed") || (!conflicts.length && !watched.length) || !canAsk) {
        io.stdout(
          formatUpdates(
            canAsk ? result.items.filter((i) => i.status !== "conflict" && i.status !== "upstream-changed") : result.items,
            false,
            Boolean(skills.length),
            !canAsk,
          ),
        );
      }
      if ((!conflicts.length && !watched.length) || !canAsk) {
        return conflicts.length || watched.length || missingUpstream ? 1 : 0;
      }

      const conflictResolutions = conflicts.length
        ? await resolveUpdateConflicts(hub, await askUpdateDecisions(conflicts, io), choice)
        : [];
      if (conflictResolutions.length) {
        io.stdout(formatUpdateResolutions(conflictResolutions));
        if (conflictResolutions.some((r) => r.choice === "keep")) {
          io.stdout("\nKept local edits unchanged. Run `skillsym update` again whenever you want to overwrite or recheck.");
        }
      }

      const reviewResults = watched.length
        ? await markUpstreamsReviewed(hub, await askUpstreamReviews(watched, io))
        : [];
      if (reviewResults.length) {
        io.stdout(formatUpstreamReviews(reviewResults));
        if (reviewResults.some((r) => r.choice === "skip")) {
          io.stdout("\nUnreviewed upstreams remain flagged. Run `skillsym update --mark-reviewed` once you finish merging.");
        }
      }

      if (conflictResolutions.some((r) => !r.ok) || reviewResults.some((r) => !r.ok)) return 2;
      return conflictResolutions.some((r) => r.choice === "keep") || reviewResults.some((r) => r.choice === "skip") || missingUpstream ? 1 : 0;
    }
    case "import": {
      const skills = [...rest, ...(values.skill ?? [])];
      const choice = { profiles, ...(skills.length ? { skills } : {}), ...(agents.length ? { agents } : {}) };
      if (values.continue && values.abort) throw new UsageError("use either --continue or --abort, not both");
      if ((values.continue || values.abort) && (skills.length || agents.length)) {
        throw new UsageError("--continue and --abort act on the open merge; they take no skill or agent names");
      }
      if (values.continue) {
        const done = await continueImport(hub, { profiles });
        if (json) io.stdout(JSON.stringify({ continued: done }));
        else io.stdout(`Merge of "${done.name}" finished: it is now the hub version, and every agent links to it.${formatImportDecisions([done])}`);
        return 0;
      }
      if (values.abort) {
        const { skill } = await abortImport(hub);
        if (json) io.stdout(JSON.stringify({ aborted: skill }));
        else io.stdout(`Aborted the merge of "${skill}". The agents' copies were never changed.`);
        return 0;
      }
      if (values["dry-run"]) {
        const plan = await planImport(hub, choice);
        if (json) io.stdout(JSON.stringify({ dryRun: true, ...plan }));
        else io.stdout(formatImport(plan.items, true));
        return plan.items.some((i) => i.type === "conflict") ? 1 : 0;
      }
      const result = await importSkills(hub, choice);
      const conflicts = result.items.filter((i) => i.type === "conflict");
      const canAsk = Boolean(io.interactive && io.ask && !json && !values.yes);
      if (json) io.stdout(JSON.stringify({ dryRun: false, ...result }));
      else {
        io.stdout(formatImport(canAsk ? result.items.filter((i) => i.type !== "conflict") : result.items, false));
        if (conflicts.length && !canAsk) {
          io.stdout(
            `\n${conflicts.length} skill(s) have differing copies and were left untouched. ` +
              "Run `skillsym import` in a terminal (without -y) to choose for each: keep one version, keep both, or merge.",
          );
        }
      }
      const failed = result.items.some((i) => !i.ok);
      if (!conflicts.length || !canAsk) return failed ? 2 : conflicts.length ? 1 : 0;

      const decisions = await askImportDecisions(hub, conflicts, io);
      const resolved = await resolveImportConflicts(hub, decisions, choice);
      io.stdout(formatImportDecisions(resolved));
      for (const r of resolved) if (r.mergeDir && openEditor(io, r.mergeDir)) io.stdout(`          (opened ${r.mergeDir} in your editor)`);
      if (resolved.some((r) => r.choice === "skip")) io.stdout("\nSkipped skills are unchanged. Run `skillsym import` again whenever you want to decide them.");
      if (failed || resolved.some((r) => !r.ok)) return 2;
      return resolved.some((r) => r.choice === "skip" || r.choice === "merge") ? 1 : 0;
    }
    case "remove":
    case "rm": {
      const skills = values.all ? ["*"] : [...rest, ...(values.skill ?? [])];
      if (!skills.length) throw new MissingSkillName("remove needs skill names: skillsym remove <skill...> [-a <agents>]");
      // With -a only those agents are unassigned; without it the skill leaves the hub entirely.
      const dropAgents = values.agent?.length ? values.agent : undefined;
      const dryRun = Boolean(values["dry-run"]);
      if (!dropAgents && !dryRun && !values.yes) {
        const what = skills.includes("*") ? "every skill" : skills.map((s) => `"${s}"`).join(", ");
        if (!(io.interactive && io.ask && !json)) {
          throw new UsageError(`Removing ${what} from the hub needs confirmation: add -y (a backup is kept), or use -a to unassign agents only.`);
        }
        const answer = (await io.ask(`Remove ${what} from the hub and every agent? A backup is kept. [y/N] (Enter = no) `)).trim().toLowerCase();
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
    case "eject": {
      const skills = [...rest, ...(values.skill ?? [])];
      const selected = skills.length > 0 || agents.length > 0;
      const dryRun = Boolean(values["dry-run"]);
      const scope = [skills.length ? (skills.includes("*") ? "every skill" : skills.map((s) => `"${s}"`).join(", ")) : "", agents.length ? `for ${agents.join(", ")}` : ""].filter(Boolean).join(" ");
      if (!dryRun && !values.yes) {
        if (!(io.interactive && io.ask && !json)) {
          throw new UsageError(`eject replaces ${selected ? `the links of ${scope}` : "every skillsym link"} with a real copy; confirm with -y, or preview it with --dry-run.`);
        }
        const answer = (
          await io.ask(
            selected
              ? `Replace the links of ${scope} with a real copy from the hub? [y/N] (Enter = no) `
              : "Replace every skillsym link with a real copy of the skill, so you can stop using skillsym? [y/N] (Enter = no) ",
          )
        )
          .trim()
          .toLowerCase();
        if (answer !== "y" && answer !== "yes") {
          io.stdout("Cancelled; nothing changed. Preview what eject would do with `skillsym eject --dry-run`.");
          return 1;
        }
      }
      const report = await eject(hub, { dryRun, ...(skills.length ? { skills } : {}), ...(agents.length ? { agents } : {}), profiles });
      if (json) io.stdout(JSON.stringify({ dryRun, ...report }));
      else io.stdout(formatEject(report, dryRun, selected));
      return report.results.some((r) => r.outcome === "failed") ? 2 : 0;
    }
    case "open": {
      if (rest.length !== 1) throw new MissingSkillName("open takes one skill name: skillsym open <skill>");
      const skill = (await listSkills(hub)).find((s) => s.name === rest[0]);
      if (!skill) throw new SkillsymError("SKILL_NOT_IN_HUB", `No skill named "${rest[0]}" in the hub.`, { skill: rest[0] });
      // A --link skill is edited where it really lives: in the library.
      const folder = skill.mode === "source-link" && skill.source ? skill.source : skill.path;
      if (json) io.stdout(JSON.stringify({ skill: skill.name, path: folder }));
      else io.stdout(folder);
      // Printing only without a terminal, so scripts can use the path.
      if (io.interactive && !json) openFolder(io, folder);
      return 0;
    }
    case "lib":
    case "library": {
      const [action, name, ...extra] = rest;
      if (!action) {
        const libraries = await listLibraries(hub);
        if (json) io.stdout(JSON.stringify({ libraries }));
        else io.stdout(formatLibraries(libraries));
        return 0;
      }
      if (!["open", "unlink", "rm", "remove"].includes(action)) {
        throw new UsageError(`Unknown lib command "${action}". Use: skillsym lib, lib open <name>, lib unlink <name>, lib rm <name>`);
      }
      if (!name || extra.length) {
        throw new UsageError(`lib ${action} takes one library: skillsym lib ${action} <name>${await libraryNames(hub)}`);
      }
      const library = await findLibrary(hub, name, io.cwd ?? process.cwd());
      const dryRun = Boolean(values["dry-run"]);
      if (action === "open") {
        if (!library.found) throw new UsageError(`${library.path} is not there. If it moved, run: skillsym add <new path> --link`);
        if (json) io.stdout(JSON.stringify({ library: library.name, path: library.path }));
        else io.stdout(library.path);
        if (io.interactive && !json) openFolder(io, library.path);
        return 0;
      }
      if (action === "unlink") {
        const result = await unlinkLibrary(hub, library, { dryRun, profiles });
        if (json) io.stdout(JSON.stringify({ dryRun, ...result }));
        else io.stdout(formatUnlink(library, result, dryRun));
        return result.forgotten ? 0 : 1;
      }
      if (!dryRun && !values.yes) {
        const what = `the ${library.skills.length} skill(s) of ${library.name} from the hub and every agent`;
        if (!(io.interactive && io.ask && !json)) {
          throw new UsageError(`lib rm removes ${what}; confirm with -y, preview it with --dry-run, or keep the skills with \`skillsym lib unlink\`.`);
        }
        const answer = (await io.ask(`Remove ${what}? Your library's files stay. To keep the skills, use lib unlink instead. [y/N] (Enter = no) `)).trim().toLowerCase();
        if (answer !== "y" && answer !== "yes") {
          io.stdout("Cancelled; nothing changed.");
          return 1;
        }
      }
      const removed = await removeLibrary(hub, library, { dryRun, profiles });
      if (json) io.stdout(JSON.stringify({ dryRun, library: library.path, ...removed }));
      else {
        io.stdout(
          [
            `${dryRun ? "Would remove" : "Removed"} ${removed.removedSkills.length} skill(s) of ${library.name} from the hub and every agent.`,
            ...removed.removedSkills.map((r) => `  ${r.skill}`),
            `Your library's files ${dryRun ? "stay" : "are untouched"}: ${library.path}${dryRun ? "" : "; skillsym no longer uses it."}`,
          ].join("\n"),
        );
      }
      return 0;
    }
    case "config": {
      if (rest[0] === "add") {
        const [, id, folder, ...extra] = rest;
        if (!id || !folder || extra.length) throw new UsageError("config add takes an agent id and its skills folder: skillsym config add <id> <folder>");
        // "~" stays as written, so the file works if the home folder moves; anything else is from here, not from home.
        const skillsDir = folder === "~" || folder.startsWith("~/") || folder.startsWith("~\\") ? folder : path.resolve(io.cwd ?? process.cwd(), folder);
        const agent = await addConfigAgent(hub, id, skillsDir);
        if (json) io.stdout(JSON.stringify({ added: agent }));
        else {
          io.stdout(
            [
              `Added agent "${agent.id}": ${agent.skillsDir}`,
              "Next:",
              `  Bring in skills already there: skillsym import -a ${agent.id}`,
              `  Or link one from the hub:      skillsym assign <skill> -a ${agent.id}`,
              `If it also loads skills from other folders, add "alsoReads" in ${hub.configPath}.`,
            ].join("\n"),
          );
          const inHub = await listSkills(hub);
          if (inHub.length) io.stdout(skillChoices(inHub));
        }
        return 0;
      }
      if (rest[0] === "remove" || rest[0] === "rm") {
        const [, id, ...extra] = rest;
        if (!id || extra.length) throw new UsageError("config remove takes one agent id: skillsym config remove <id>");
        await removeConfigAgent(hub, id);
        if (json) io.stdout(JSON.stringify({ removed: id }));
        else io.stdout(`Removed agent "${id}" from ${hub.configPath}. Files in its skills folder were not touched.`);
        return 0;
      }
      if (rest.length) throw new UsageError(`Unknown config command "${rest[0]}". Use: skillsym config, config add <id> <folder>, config remove <id>`);
      const customIds = new Set((await readConfig(hub.configPath)).agents.map((a) => a.id));
      const rows = await Promise.all(
        profiles.map(async (p) => ({
          id: p.id,
          delivery: p.delivery ?? "link",
          skillsDir: p.skillsDir,
          ...(p.skillsJsonPath ? { skillsJsonPath: p.skillsJsonPath } : {}),
          source: customIds.has(p.id) ? ("config" as const) : ("built-in" as const),
          installed: await isAgentInstalled(p),
        })),
      );
      const exists = await isFile(hub.configPath);
      if (json) io.stdout(JSON.stringify({ configPath: hub.configPath, exists, agents: rows }));
      else io.stdout(formatConfig(hub.configPath, exists, rows));
      return 0;
    }
    case "migrate": {
      if (rest.length) throw new UsageError("migrate takes no positional arguments: skillsym migrate [--dry-run] [-y]");
      const dryRun = Boolean(values["dry-run"]);
      const homedir = userHome(io.env);
      const plan = await planAntigravityMigration(hub, { profiles, homedir });
      if (dryRun) {
        if (json) io.stdout(JSON.stringify({ dryRun: true, ...plan }));
        else io.stdout(formatMigrationPlan(plan));
        return 0;
      }
      if (!plan.needed) {
        if (json) io.stdout(JSON.stringify({ dryRun: false, ...plan, applied: false, backups: [], unlinkedCount: 0, removedBroadEntries: 0 }));
        else io.stdout("Nothing to migrate.");
        return 0;
      }
      if (!values.yes) {
        if (!(io.interactive && io.ask && !json)) {
          throw new UsageError("Migration edits config.json, skills.json, and removes old junctions (with backups). Confirm with -y, or preview with `skillsym migrate --dry-run`.");
        }
        const ok = await askMigrationConfirm(plan, io);
        if (!ok) {
          io.stdout("Skipped migration; nothing changed.");
          return 1;
        }
      }
      const migrated = await applyAntigravityMigration(hub, { profiles, homedir });
      if (json) io.stdout(JSON.stringify({ dryRun: false, ...migrated }));
      else io.stdout(formatMigrationResult(migrated));
      return 0;
    }
    default:
      throw new UsageError(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

/** `add <library>`: copy every skill in a folder of skills into the hub, then optionally assign them. */
async function addFromLibrary(
  hub: Hub,
  library: string,
  skills: string[],
  agents: string[],
  profiles: AgentProfile[],
  io: Io,
  json: boolean,
  dryRun: boolean,
  link: boolean,
): Promise<ExitCode> {
  const provider = cloudSyncProvider(library, io.env);
  if (provider && !json) {
    io.stderr(
      link
        ? `warning: the library ${library} is inside a ${provider} folder. With --link every agent reads the library through links, and sync clients can turn links into copies or keep files online-only; move the library out of ${provider} if skills go missing.`
        : `warning: the library ${library} is inside a ${provider} folder; that is fine for copying, but keep the hub itself out of synced folders.`,
    );
  }
  if (link && !json && !(await isInGit(library))) {
    io.stderr(
      `warning: ${library} is not in git. With --link it holds the only real copy of its skills, and skillsym keeps just one snapshot of each (restored by \`skillsym sync\` if the library is lost). For history, run \`git init\` there.`,
    );
  }
  if (dryRun) {
    const plan = await planLibraryAdd(hub, library, { link, ...(skills.length ? { skills } : {}) });
    if (json) io.stdout(JSON.stringify({ dryRun: true, ...plan }));
    else io.stdout(formatLibrary(plan.items, library, true, link));
    return plan.items.some((i) => i.type === "skip") ? 1 : 0;
  }
  const result = await addLibrary(hub, library, { link, profiles, ...(skills.length ? { skills } : {}) });
  // -a applies to every skill now linked from the library, including ones already linked earlier.
  const names = result.items.filter((i) => i.type !== "skip").map((i) => i.name);
  const assigned = agents.length && names.length ? (await assignSkills(hub, { skills: names, agents, profiles })).results : [];
  if (json) io.stdout(JSON.stringify({ dryRun: false, ...result, assigned }));
  else {
    if (result.snapshotFailed.length) io.stderr(`warning: could not update the library snapshot of ${result.snapshotFailed.join(", ")}.`);
    io.stdout(formatLibrary(result.items, library, false, link));
    if (assigned.length) io.stdout(formatLinks(assigned));
    if (link && !names.length) {
      io.stdout(`\nNothing is linked from ${library}, so skillsym is not using it; edit these skills in ${hub.skillsDir} as before.`);
    } else if (link) {
      const unassigned = !agents.length && result.added.some((s) => !s.agents.length);
      io.stdout(
        `\nYour library stays the source of truth: edit skills in ${library}, and every agent sees the change.` +
          "\n`skillsym status` lists skills you add there later; run this command again to add them. skillsym never deletes anything in the library." +
          (unassigned ? "\nAssign them to agents with: skillsym assign <skill...> -a <agents>" : ""),
      );
    } else if (names.length) {
      io.stdout(
        `\nThe hub is now the source of truth for these skills; edit them in ${hub.skillsDir}.` +
          `\nskillsym does not use ${library} any more: keep it as an archive or delete it yourself.` +
          (agents.length ? "" : "\nAssign them to agents with: skillsym assign <skill...> -a <agents>   (or -s '*' -a claude)"),
      );
    }
  }
  if (assigned.some((r) => r.outcome === "failed")) return 2;
  return result.items.some((i) => i.type === "skip") || assigned.some((r) => r.outcome === "blocked") ? 1 : 0;
}

/** `add <owner/repo|url>`: sync cached remote clone, copy or link skills into hub, and optionally assign them. */
async function addFromRemote(
  hub: Hub,
  target: ParsedRemoteTarget,
  skills: string[],
  agents: string[],
  profiles: AgentProfile[],
  io: Io,
  json: boolean,
  dryRun: boolean,
  link: boolean,
): Promise<ExitCode> {
  if (dryRun) {
    const plan = await planRemoteAdd(hub, target, { link, ...(skills.length ? { skills } : {}) });
    if (json) io.stdout(JSON.stringify({ dryRun: true, ...plan }));
    else io.stdout(formatRemoteAdd(plan.items, target.label, plan.commit, true, link));
    return plan.items.some((i) => i.type === "skip" || i.type === "conflict") ? 1 : 0;
  }
  const result = await addRemoteSkills(hub, target, { link, profiles, ...(skills.length ? { skills } : {}) });
  const assignable = result.items.filter((i) => i.type !== "skip" && i.type !== "conflict").map((i) => i.name);
  const assigned = agents.length && assignable.length ? (await assignSkills(hub, { skills: assignable, agents, profiles })).results : [];
  if (json) io.stdout(JSON.stringify({ dryRun: false, ...result, assigned }));
  else {
    if (result.snapshotFailed.length) io.stderr(`warning: could not update the library snapshot of ${result.snapshotFailed.join(", ")}.`);
    io.stdout(formatRemoteAdd(result.items, target.label, result.commit, false, link));
    if (assigned.length) io.stdout(formatLinks(assigned));
    if (!agents.length && result.added.length) {
      io.stdout("\nAssign them to agents with: skillsym assign <skill...> -a <agents>");
    }
  }
  if (assigned.some((r) => r.outcome === "failed")) return 2;
  return result.items.some((i) => i.type === "skip" || i.type === "conflict") || assigned.some((r) => r.outcome === "blocked") ? 1 : 0;
}

function formatRemoteAdd(items: RemoteAddItem[], label: string, commit: string, dryRun: boolean, link: boolean): string {
  const shortCommit = commit.slice(0, 7);
  const lines: string[] = [];
  const width = Math.max(1, ...items.map((i) => i.name.length));
  const groups: [RemoteAddItem["type"], string][] = [
    ["add", `${dryRun ? "Would add" : "Added"} from ${label} (${shortCommit}, ${link ? "linked to remote cache" : "copied into hub"}):`],
    ["adopt-remote", `${dryRun ? "Would attach" : "Attached"} remote tracking to existing hub skill(s):`],
    ["update", `${dryRun ? "Would update" : "Updated"} from ${label} (${shortCommit}):`],
  ];
  for (const [kind, heading] of groups) {
    const matched = items.filter((i) => i.type === kind);
    if (!matched.length) continue;
    lines.push(heading);
    for (const i of matched) {
      const extra = i.attachedAgents?.length ? `  (kept agents: ${i.attachedAgents.join(", ")})` : "";
      lines.push(`  ${i.name.padEnd(width)}  ${i.subpath || "."}${extra}`);
      if (i.backup) lines.push(`  ${"".padEnd(width)}  backup: ${i.backup}`);
    }
  }
  const unchanged = items.filter((i) => i.type === "unchanged");
  if (unchanged.length) lines.push(`Already up to date from ${label} (${shortCommit}): ${unchanged.map((i) => i.name).join(", ")}`);
  const conflicts = items.filter((i) => i.type === "conflict");
  if (conflicts.length) {
    lines.push(`Conflicts (local edits kept; run \`skillsym update\` to decide):`);
    for (const i of conflicts) lines.push(`  ${i.name.padEnd(width)}  ${i.reason}`);
  }
  const skipped = items.filter((i) => i.type === "skip");
  if (skipped.length) {
    lines.push(`Skipped ${skipped.length}:`);
    for (const i of skipped) lines.push(`  ${i.name.padEnd(width)}  ${i.reason}`);
  }
  if (dryRun) lines.push("", "Nothing was changed. Run the same command without --dry-run to apply.");
  return lines.join("\n");
}

function formatUpstreamAttach(res: AttachUpstreamResult, dryRun: boolean): string {
  const shortCommit = res.commit.slice(0, 7);
  const lines = [`${dryRun ? "Would watch" : "Watching"} ${res.items.length} upstream(s) for "${res.hostSkill}" from ${res.target.label} (${shortCommit}):`];
  for (const item of res.items) {
    lines.push(`  [${item.type}] ${item.subpath || "."}`);
  }
  lines.push(`Files inside "${res.hostSkill}" were not touched.`);
  if (dryRun) lines.push("", "Nothing was changed. Run the same command without --dry-run to save.");
  return lines.join("\n");
}

function formatUpstreamChangeDetail(skill: string, c: NonNullable<UpdateItem["upstreamChanges"]>[number]): string[] {
  const repoLabel = c.url.replace(/\.git$/i, "");
  const scope = c.subpath || ".";
  const diffCmd = `git -C "${c.repoDir}" diff ${c.oldCommit.slice(0, 7)}..${c.newCommit.slice(0, 7)}${c.subpath ? ` -- "${c.subpath}"` : ""}`;
  const out = [
    `  ${skill}: ${repoLabel} (${scope})  ${c.oldCommit.slice(0, 7)} -> ${c.newCommit.slice(0, 7)}`,
    ...c.changedFiles.slice(0, 10).map((f) => `    ${f}`),
  ];
  if (c.changedFiles.length > 10) out.push(`    ...and ${c.changedFiles.length - 10} more file(s)`);
  out.push(`    diff: ${diffCmd}`);
  return out;
}

function formatUpdates(items: UpdateItem[], dryRun: boolean, explicitSkills: boolean, reportConflicts: boolean): string {
  if (!items.length) return "Nothing in the hub to update.";
  const lines: string[] = [];
  const updated = items.filter((i) => i.status === "updated");
  const reviewed = items.filter((i) => i.status === "up-to-date" && i.reviewed);
  const upToDate = items.filter((i) => i.status === "up-to-date" && !i.reviewed);
  const missing = items.filter((i) => i.status === "upstream-missing");
  const watched = items.filter((i) => i.status === "upstream-changed");
  const conflicts = items.filter((i) => i.status === "conflict");
  const localOnly = items.filter((i) => i.status === "local-only");
  const width = Math.max(1, ...items.map((i) => i.skill.length));

  if (updated.length) {
    for (const u of updated) {
      const revs = u.oldCommit && u.newCommit ? ` (${u.oldCommit.slice(0, 7)} -> ${u.newCommit.slice(0, 7)})` : "";
      lines.push(`${dryRun ? "would update" : "updated     "}  ${u.skill.padEnd(width)}${revs}`);
      if (u.backup) lines.push(`              backup: ${u.backup}`);
    }
  }
  if (reviewed.length) {
    for (const r of reviewed) lines.push(`reviewed    ${r.skill.padEnd(width)}  upstream baseline(s) marked reviewed`);
  }
  if (watched.length) {
    lines.push(`UPSTREAM CHANGED (${watched.length}) — hub orchestrator files left untouched:`);
    for (const w of watched) {
      for (const ch of w.upstreamChanges ?? []) lines.push(...formatUpstreamChangeDetail(w.skill, ch));
    }
  }
  if (missing.length) {
    for (const m of missing) lines.push(`UPSTREAM MISSING  ${m.skill.padEnd(width)}  ${m.reason ?? "missing upstream (hub copy kept)"}`);
  }
  if (conflicts.length) {
    for (const c of conflicts) lines.push(`CONFLICT  ${c.skill.padEnd(width)}  ${c.reason ?? "modified locally and upstream"}`);
  }
  if (explicitSkills && localOnly.length) {
    for (const l of localOnly) lines.push(`local-only  ${l.skill.padEnd(width)}  ${l.reason ?? "not git-tracked"}`);
  }
  if (upToDate.length) {
    if (!updated.length && !reviewed.length && !watched.length && !missing.length && !conflicts.length && !(explicitSkills && localOnly.length)) {
      lines.push(`Everything tracked (${upToDate.length}) is up to date.`);
    } else {
      lines.push(`Up to date: ${upToDate.map((u) => u.skill).join(", ")}`);
    }
  }
  if (!explicitSkills && localOnly.length && !updated.length && !reviewed.length && !upToDate.length && !watched.length && !missing.length && !conflicts.length) {
    lines.push(`Checked ${localOnly.length} skill(s): none are linked to GitHub or a git source.`);
  } else if (!explicitSkills && localOnly.length) {
    lines.push(`${localOnly.length} local skill(s) skipped (not git-tracked).`);
  }
  if (dryRun) {
    if (conflicts.length) lines.push("", `${conflicts.length} conflict(s) would ask whether to overwrite (with backup) or keep local edits.`);
    if (watched.length) lines.push("", `${watched.length} orchestrator upstream change(s) ready to inspect; run \`skillsym update\` to review or \`--mark-reviewed\`.`);
    lines.push("", "Nothing was changed in your hub skills. Run `skillsym update` to apply.");
  } else if (reportConflicts) {
    if (conflicts.length) lines.push("", `${conflicts.length} conflict(s) left untouched. Run \`skillsym update\` in a terminal (without -y) to overwrite or keep.`);
    if (watched.length) lines.push("", `Run \`skillsym update --mark-reviewed\` once you finish reviewing/merging the upstream diff.`);
  }
  return lines.join("\n").trimStart();
}

async function askUpstreamReviews(watched: UpdateItem[], io: Io): Promise<UpstreamReviewDecision[]> {
  const decisions: UpstreamReviewDecision[] = [];
  let quit = false;
  for (const item of watched) {
    if (quit) {
      decisions.push({ skill: item.skill, choice: "skip" });
      continue;
    }
    io.stdout(`\nUPSTREAM CHANGED: ${item.skill} (hub files untouched)`);
    for (const ch of item.upstreamChanges ?? []) {
      for (const line of formatUpstreamChangeDetail(item.skill, ch)) io.stdout(line);
    }
    io.stdout("  [m] mark-reviewed  record these upstream commit(s) as reviewed");
    io.stdout("  [s] skip           keep flagged until you finish merging");
    const answer = await askOne(io, ["mark-reviewed", "skip"]);
    if (answer === "quit") {
      quit = true;
      decisions.push({ skill: item.skill, choice: "skip" });
      continue;
    }
    decisions.push({ skill: item.skill, choice: answer, changes: item.upstreamChanges });
  }
  return decisions;
}

function formatUpstreamReviews(results: UpstreamReviewResult[]): string {
  const lines = results.map((r) => {
    if (!r.ok) return `FAILED     ${r.choice} ${r.skill}: ${r.error}`;
    return r.choice === "mark-reviewed" ? `reviewed   ${r.skill}` : `skipped    ${r.skill}`;
  });
  return ["", ...lines].join("\n");
}

async function askUpdateDecisions(conflicts: UpdateItem[], io: Io): Promise<UpdateDecision[]> {
  const decisions: UpdateDecision[] = [];
  let quit = false;
  for (const item of conflicts) {
    if (quit) {
      decisions.push({ skill: item.skill, choice: "keep" });
      continue;
    }
    io.stdout(`\n${item.skill}: ${item.reason ?? "modified locally and upstream"}`);
    io.stdout("  [o] overwrite  replace the hub copy with upstream (local hub copy is backed up first)");
    io.stdout("  [k] keep       leave local hub edits untouched");
    const answer = await askOne(io, ["overwrite", "keep"]);
    if (answer === "quit") {
      quit = true;
      decisions.push({ skill: item.skill, choice: "keep" });
      continue;
    }
    decisions.push({ skill: item.skill, choice: answer });
  }
  return decisions;
}

function formatUpdateResolutions(results: UpdateResolution[]): string {
  const lines = results.map((r) => {
    if (!r.ok) return `FAILED     ${r.choice} ${r.skill}: ${r.error}`;
    if (r.choice === "keep") return `kept       ${r.skill}`;
    return `overwrote  ${r.skill}${r.backup ? `\n           backup: ${r.backup}` : ""}`;
  });
  return ["", ...lines].join("\n");
}

function formatLibrary(items: LibraryItem[], library: string, dryRun: boolean, link = false): string {
  const add = items.filter((i) => i.type === "add");
  const repoint = items.filter((i) => i.type === "repoint");
  const adopt = items.filter((i) => i.type === "adopt");
  const unchanged = items.filter((i) => i.type === "unchanged");
  const skip = items.filter((i) => i.type === "skip");
  const how = link ? "linked to the library" : "copied into the hub";
  const lines: string[] = [];
  const width = Math.max(...items.map((i) => i.name.length));
  // Keep the first line even at 0 when nothing else happened, so the result is never blank.
  if (add.length || (!repoint.length && !adopt.length && !unchanged.length)) {
    lines.push(`${dryRun ? "Would add" : "Added"} ${add.length} skill(s) from ${library} (${how}):`);
    for (const i of add) lines.push(`  ${i.name.padEnd(width)}  ${path.relative(library, i.path) || "."}`);
  }
  if (repoint.length) {
    lines.push(`${dryRun ? "Would re-point" : "Re-pointed"} ${repoint.length} skill(s) whose library folder moved:`);
    for (const i of repoint) lines.push(`  ${i.name.padEnd(width)}  ${path.relative(library, i.path) || "."}`);
  }
  if (adopt.length) {
    lines.push(`${dryRun ? "Would switch" : "Switched"} ${adopt.length} skill(s) to ${library}; they had the same content, and agents keep working:`);
    for (const i of adopt) lines.push(`  ${i.name}`);
    // One operation shares one backup folder: say it once.
    const backup = adopt[0]?.backup;
    if (backup) lines.push(`Hub copies backed up in ${path.dirname(backup)}`);
  }
  if (unchanged.length) lines.push(`Already linked from this library: ${unchanged.map((i) => i.name).join(", ")}`);
  if (skip.length) {
    lines.push(`Skipped ${skip.length}:`);
    for (const i of skip) lines.push(`  ${i.name.padEnd(width)}  ${i.reason}`);
  }
  if (dryRun) lines.push("", "Nothing was changed. Run the same command without --dry-run to add them.");
  return lines.join("\n");
}

const IMPORT_CHOICE_HELP: Record<ImportChoice, string> = {
  primary: "keep one version; the others are backed up and replaced by links to it",
  "keep-both": "keep every version as its own skill (e.g. research and research-codex)",
  merge: "write a merge with conflict markers to edit, then run `skillsym import --continue`",
  skip: "decide later; change nothing",
};

async function askImportDecisions(hub: Hub, conflicts: ImportItem[], io: Io): Promise<ImportDecision[]> {
  const decisions: ImportDecision[] = [];
  let merging = Boolean(await readPendingImport(hub));
  let quit = false;
  for (const item of conflicts) {
    if (quit) {
      decisions.push({ name: item.name, choice: "skip" });
      continue;
    }
    const versions = await importVersions(hub, item);
    io.stdout(`\n${item.name}: ${item.reason}`);
    versions.forEach((v, i) => io.stdout(`  ${i + 1}) ${v.label.padEnd(10)} ${v.path}`));
    // Only one merge can be open at a time.
    const choices: ImportChoice[] = merging ? ["primary", "keep-both", "skip"] : ["primary", "keep-both", "merge", "skip"];
    for (const c of choices) io.stdout(`  [${c[0]}] ${c.padEnd(9)} ${IMPORT_CHOICE_HELP[c]}`);
    if (merging) io.stdout("  (merge is not offered: another merge is already open)");
    const answer = await askOne(io, choices);
    if (answer === "quit") {
      quit = true;
      decisions.push({ name: item.name, choice: "skip" });
      continue;
    }
    const decision: ImportDecision = { name: item.name, choice: answer };
    if (answer === "primary") {
      const picked = await askNumber(io, `  Keep which version? 1-${versions.length} (Enter = go back and skip this skill): `, versions.length);
      if (picked === null) decision.choice = "skip";
      else decision.primary = versions[picked - 1]!.path;
    }
    if (decision.choice === "merge") merging = true;
    decisions.push(decision);
  }
  return decisions;
}

/** Ask for one of `choices` (or its first letter). Enter = skip, q = skip all the rest. */
async function askOne<T extends string>(io: Io, choices: T[]): Promise<T | "quit"> {
  io.stdout(`  (${PROMPT_KEYS})`);
  const prompt = `  Choose ${choices.map((c) => c[0]).join("/")}: `;
  for (;;) {
    const answer = (await io.ask!(prompt)).trim().toLowerCase();
    if (!answer) return (choices.find((c) => c === "skip") ?? choices[choices.length - 1])!;
    if (answer === "q" || answer === "quit") return "quit";
    const match = choices.find((c) => c === answer || c[0] === answer);
    if (match) return match;
    io.stdout(`  Please answer one of: ${choices.join(", ")} (or q, or Enter to skip)`);
  }
}

/** Ask for a number from 1 to max; Enter returns null. */
async function askNumber(io: Io, prompt: string, max: number): Promise<number | null> {
  for (;;) {
    const answer = (await io.ask!(prompt)).trim();
    if (!answer) return null;
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= max) return n;
    io.stdout(`  Please answer a number from 1 to ${max}, or press Enter to skip`);
  }
}

function formatImportDecisions(results: ImportDecisionResult[]): string {
  const lines: string[] = [""];
  for (const r of results) {
    if (!r.ok) {
      lines.push(`FAILED    ${r.choice} ${r.name}: ${r.error}`);
      continue;
    }
    if (r.choice === "skip") lines.push(`skipped   ${r.name}`);
    else if (r.mergeDir) lines.push(...mergeInstructions(r.name, r.mergeDir, r.conflictedFiles ?? [], r.binaryConflicts ?? []));
    else {
      lines.push(`${r.choice.padEnd(9)} ${r.name}${r.newSkills?.length ? ` (+ new skills: ${r.newSkills.join(", ")})` : ""}`);
      if (r.library) lines.push(`          wrote the result into your library: ${r.library} (review it with git diff)`);
      for (const b of r.backups) lines.push(`          backup: ${b}`);
    }
  }
  return lines.join("\n");
}

function mergeInstructions(skill: string, dir: string, conflicted: string[], binary: BinaryConflict[]): string[] {
  const binaryFiles = new Set(binary.map((b) => b.file));
  const text = conflicted.filter((f) => !binaryFiles.has(f));
  const lines = [`merging   ${skill}: the merged copy is in ${dir}`];
  if (text.length) {
    lines.push("          1. Edit these files; between <<<<<<< and >>>>>>> keep the lines you want and delete the marker lines:");
    for (const f of text) lines.push(`               ${f}`);
  }
  if (binary.length) {
    lines.push(`          ${text.length ? 2 : 1}. These binary files differ; keep one version of each under the original name and delete the other(s):`);
    for (const b of binary) lines.push(`               ${b.file} (now the ${b.kept} version)  vs  ${b.extras.join(", ")}`);
  }
  if (!text.length && !binary.length) lines.push("          The versions only differ by files that exist on one side; review the folder if you like.");
  lines.push("          Then run `skillsym import --continue` to finish, or `skillsym import --abort` to drop the merge.");
  lines.push("          Nothing in your agents' folders changes until you continue.");
  return lines;
}

/** Open $EDITOR (or $VISUAL) on the merge folder without waiting for it. Returns whether it was launched. */
function openEditor(io: Io, dir: string): boolean {
  const editor = io.env.VISUAL || io.env.EDITOR;
  if (!editor) return false;
  try {
    // The shell joins arguments with spaces, so a path containing one must be quoted here.
    spawn(editor, [`"${dir}"`], { detached: true, stdio: "ignore", shell: true })
      .on("error", () => {})
      .unref();
    return true;
  } catch {
    // Opening an editor is a convenience; the printed instructions are enough.
    return false;
  }
}

/** Open a folder in the user's editor, or the system's file manager if they have not set one. */
function openFolder(io: Io, dir: string): void {
  if (openEditor(io, dir)) return;
  const opener = process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open";
  try {
    spawn(opener, [dir], { detached: true, stdio: "ignore" })
      .on("error", () => {})
      .unref();
  } catch {
    // The path is already printed.
  }
}

function formatImport(items: (ImportItem | ImportItemResult)[], dryRun: boolean): string {
  if (!items.length) return "Nothing to import: every skill in the agents' folders is already managed.";
  const lines: string[] = [];
  for (const item of items) {
    const where = item.sources.map((s) => s.agents.join("+")).join(", ");
    const result = "ok" in item ? item : undefined;
    if (result && !result.ok) {
      lines.push(`FAILED    ${item.name}: ${result.error}`);
      continue;
    }
    switch (item.type) {
      case "import":
      case "link-existing": {
        const verb = item.type === "import" ? (dryRun ? "would import" : "imported") : dryRun ? "would link (already in hub)" : "linked (already in hub)";
        lines.push(`${verb}  ${item.name} from ${where}`);
        if (dryRun) for (const s of item.sources) lines.push(`          back up and replace with a link: ${s.path}`);
        for (const b of result?.backups ?? []) lines.push(`          backup: ${b}`);
        break;
      }
      case "conflict":
        lines.push(`CONFLICT  ${item.name} in ${where}: ${item.reason}`);
        break;
      case "skip":
        lines.push(`skipped   ${item.name}: ${item.reason}`);
        break;
    }
    for (const s of item.sources.filter((x) => x.bom)) lines.push(`          warning: ${s.path}${path.sep}SKILL.md has a UTF-8 BOM; Codex will not load it`);
  }
  return lines.join("\n");
}

const EJECT_TEXT: Record<EjectOutcome, [string, string]> = {
  ejected: ["would replace link with a real copy", "replaced link with a real copy"],
  "left-in-place": ["would leave (no longer skillsym's link)", "left in place (no longer skillsym's link)"],
  missing: ["would forget (nothing there)", "forgot (nothing there)"],
  "hub-missing": ["cannot copy (skill folder missing from the hub)", "skipped (skill folder missing from the hub)"],
  "kept-shared": ["would keep shared link (another agent still uses it)", "kept shared link (another agent still uses it)"],
  unassigned: ["would unassign (no link of its own)", "unassigned (no link of its own)"],
  failed: ["FAILED", "FAILED"],
};

function formatEject(report: EjectReport, dryRun: boolean, selected: boolean): string {
  if (!report.results.length) return selected ? "Nothing to eject: those skills are not linked to those agents." : "Nothing to eject: skillsym has no links in your agents' folders.";
  const lines = report.results.map((r) => `${EJECT_TEXT[r.outcome][dryRun ? 0 : 1]}  ${r.skill}  (${r.path})${r.error ? `\n          ${r.error}` : ""}`);
  for (const s of report.leftHub) {
    const where = s.library ? `your library folder ${s.library} is left untouched` : s.backup ? `the hub copy is in ${s.backup}` : "the hub copy goes to backups";
    lines.push(`${dryRun ? "would leave" : "left"} the hub  ${s.skill}  (no agent uses it through skillsym now; ${where})`);
  }
  if (dryRun) {
    lines.push("", "Nothing was changed. Run the same command without --dry-run to do this.");
  } else if (report.results.some((r) => r.outcome === "failed")) {
    lines.push("", "Some links could not be replaced and were left as they are; fix the error above and run `skillsym eject` again.");
  } else if (selected) {
    lines.push("", "Done. Those agents now hold real copies; everything else is still managed by skillsym.");
  } else {
    lines.push(
      "",
      "Done. Your agents now hold real copies and no longer depend on skillsym.",
      `The hub is still at ${report.hubHome} (with its backups); delete it whenever you are sure you no longer need it.`,
    );
  }
  return lines.join("\n");
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
    if (r.library) {
      lines.push(`${dryRun ? "would remove" : "removed"} "${r.skill}" from the hub; your library folder ${r.library} is left untouched`);
    } else {
      lines.push(dryRun ? `would remove "${r.skill}" from the hub (backed up)` : `removed "${r.skill}" from the hub${r.backup ? `; backup: ${r.backup}` : ""}`);
    }
  }
  if (!lines.length) return "Nothing to remove.";
  const skills = [...new Set(result.links.filter((l) => l.outcome === "unlinked").map((l) => l.skill))];
  if (skills.length) lines.push("", `${dryRun ? "Those agents would no longer have" : "Those agents no longer have"} ${skills.join(", ")}. To leave them a real copy instead, use \`skillsym eject\` with the same names and -a.`);
  return lines.join("\n");
}

function parseCommandLine(argv: string[]) {
  try {
    return parseArgs({
      // parseArgs takes only one-letter short options, and would read -dr as -d -r.
      args: argv.map((a) => (a === "-dr" ? "--dry-run" : a)),
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "boolean" },
        agent: { type: "string", short: "a", multiple: true },
        skill: { type: "string", short: "s", multiple: true },
        only: { type: "string", multiple: true },
        all: { type: "boolean" },
        "dry-run": { type: "boolean" },
        link: { type: "boolean" },
        upstream: { type: "string" },
        "mark-reviewed": { type: "boolean" },
        continue: { type: "boolean" },
        abort: { type: "boolean" },
        yes: { type: "boolean", short: "y" },
        global: { type: "boolean", short: "g" },
        project: { type: "boolean", short: "p" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

function formatList(skills: SkillInfo[], indent = "", libraries: string[] = []): string {
  if (!skills.length) return "No skills in the hub yet. Add one with: skillsym add <path>";
  const agentsOf = (s: SkillInfo) => (s.agents.length ? s.agents.join(", ") : "(not assigned)");
  const width = Math.max(...skills.map((s) => s.name.length));
  const agentWidth = Math.max(...skills.map((s) => agentsOf(s).length));
  // One note per library or remote source, said once; each tracked skill points at it.
  const notes: string[] = [];
  const mark = (s: SkillInfo) => {
    let note: string | undefined;
    if (s.mode === "source-link" && s.source) {
      const from = libraries.find((l) => !path.relative(l, s.source!).startsWith("..")) ?? path.dirname(s.source);
      note = `linked from ${from}`;
    } else if (s.remote) {
      const repo = s.remote.url.replace(/\.git$/i, "");
      note = `from ${repo}${s.remote.ref ? `@${s.remote.ref}` : ""}`;
    } else if (s.upstreams?.length) {
      const repos = [...new Set(s.upstreams.map((u) => u.url.replace(/\.git$/i, "")))];
      note = `watches ${repos.join(", ")}`;
    }
    if (!note) return "";
    if (!notes.includes(note)) notes.push(note);
    return `[${notes.indexOf(note) + 1}]`;
  };
  const lines = skills.map((s) => `${indent}${s.name.padEnd(width)}  ${agentsOf(s).padEnd(agentWidth)}  ${mark(s)}`.trimEnd());
  if (notes.length) lines.push("", ...notes.map((note, i) => `${indent}[${i + 1}] ${note}`));
  return lines.join("\n");
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

async function libraryNames(hub: Hub): Promise<string> {
  const names = (await listLibraries(hub)).map((l) => l.name);
  return names.length ? `\nLibraries: ${names.join(", ")}` : "\nNo libraries yet. Link one with: skillsym add <folder> --link";
}

function formatLibraries(libraries: LibraryInfo[]): string {
  if (!libraries.length) return "No libraries yet. Link one with: skillsym add <folder> --link";
  const width = Math.max(...libraries.map((l) => l.name.length));
  return libraries
    .map((l) => `${l.name.padEnd(width)}  ${l.skills.length} skill(s)  ${l.found ? (l.git ? "in git" : "not in git") : "NOT FOUND"}\n${" ".repeat(width)}  ${l.path}`)
    .join("\n");
}

function formatUnlink(library: LibraryInfo, result: UnlinkResult, dryRun: boolean): string {
  if (!result.skills.length) return dryRun ? `${library.name} has no skills linked; it would be forgotten.` : `Forgot ${library.name}; no skills were linked from it.`;
  const kept = result.skills.filter((s) => s.outcome !== "lost");
  const lost = result.skills.filter((s) => s.outcome === "lost");
  const lines = [`${dryRun ? "Would keep" : "Kept"} ${kept.length} skill(s) from ${library.name} as real copies in the hub; agents keep working:`];
  for (const s of kept) lines.push(`  ${s.skill}${s.outcome === "from-snapshot" ? "  (from its latest snapshot; the library is gone)" : ""}`);
  if (lost.length) {
    lines.push(`Could not keep ${lost.length}, with no library and no snapshot; left as they are:`);
    for (const s of lost) lines.push(`  ${s.skill}`);
    lines.push("Restore the library, or remove them with: skillsym remove <skill>");
  } else if (!dryRun) {
    lines.push(`skillsym no longer uses ${library.path}, and did not change it. Edit these skills in the hub from now on.`);
  }
  if (dryRun) lines.push("", "Nothing was changed. Run the same command without --dry-run to do this.");
  return lines.join("\n");
}

function formatConfig(
  file: string,
  exists: boolean,
  rows: { id: string; delivery: string; skillsDir: string; skillsJsonPath?: string; source: string; installed: boolean }[],
): string {
  const width = Math.max(...rows.map((r) => r.id.length));
  return [
    `Config file: ${file}${exists ? "" : "  (not created yet; it appears the first time a command changes something)"}`,
    "",
    "Agents:",
    ...rows.map((r) => {
      const target = r.skillsJsonPath ? `${r.skillsJsonPath}  [skills-json]` : r.skillsDir;
      return `  ${r.id.padEnd(width)}  ${target}  (${r.source}${r.installed ? "" : ", not installed"})`;
    }),
    "",
    "Add an agent with `skillsym config add <id> <folder>`; to change a folder, edit the config file (see the README).",
  ].join("\n");
}

const STATUS_HINT: Record<StatusReport["entries"][number]["status"], string> = {
  synced: "",
  missing: "nothing at this path; `skillsym sync` will link it",
  dangling: "link points to a hub location that no longer exists; `skillsym sync` will re-link it",
  replaced: "skillsym's link was replaced",
  blocked: "occupied by something skillsym did not create; use `skillsym import`",
  orphaned: "no longer assigned in the manifest; `skillsym sync` will remove the link",
  covered: "",
  "source-missing": "the library folder it is linked from is gone, so agents cannot read it; if you moved the library, run `skillsym add <new library path> --link`",
  duplicate: "the agent also loads this skill from another folder, so it is loaded twice; `skillsym sync` will remove this link",
};

/** Fine first, so what needs attention ends up next to the summary. */
const STATUS_ORDER = ["synced", "covered", "missing", "dangling", "replaced", "blocked", "orphaned", "duplicate", "source-missing", "unmanaged", "unregistered"];

function entryHint(e: StatusReport["entries"][number]): string {
  let hint = STATUS_HINT[e.status];
  if (e.delivery === "skills-json") {
    if (e.status === "missing") {
      hint = e.owned
        ? "skillsym's inherits entry or manifest was removed; `skillsym sync` will ask whether to restore it or drop the assignment"
        : "not yet in the agent's skills-json manifest; `skillsym sync` will update it";
    } else if (e.status === "replaced") {
      hint = e.sameContent
        ? "generated skills-json file matches the hub but is not tracked; `skillsym sync` will record it"
        : "generated skills-json file was modified outside skillsym; `skillsym sync` will ask";
    } else if (e.status === "orphaned") {
      hint = "no longer assigned in the manifest; `skillsym sync` will update the skills-json manifest";
    } else if (e.status === "blocked") {
      hint = "skills.json is not valid JSON; fix it before syncing";
    }
    return hint;
  }
  if (e.status === "covered" && e.coveredBy) hint = `loads it from ${e.coveredBy.dir} (${e.coveredBy.agents.join(", ")}); no second link needed`;
  if (e.status === "missing" && e.owned) hint = "skillsym's link was removed; `skillsym sync` will ask whether to restore it or drop the assignment";
  if (e.status === "replaced") hint += e.sameContent ? " by an identical copy; `skillsym sync` will re-link it" : " by different content; `skillsym sync` will ask";
  return hint;
}

/** Whether `name` is one of the skill names or patterns ("*" any characters, "?" one); unlike expandSkillNames, no match is not an error. */
function skillMatches(requested: string[], name: string): boolean {
  return requested.some((r) => {
    const source = r.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    return new RegExp(`^${source}$`).test(name);
  });
}

function formatStatus(report: StatusReport, showAll: boolean, filtered: boolean): string {
  const lines: string[] = [];
  if (!report.entries.length && !filtered) lines.push("No skills assigned yet. Assign one with: skillsym assign <skill> -a <agents>");
  if (!report.entries.length && !report.unmanaged.length && !report.unregistered.length && filtered) lines.push("Nothing matches.");
  const healthy = (s: string) => s === "synced" || s === "covered";
  for (const status of STATUS_ORDER) {
    if (!showAll && healthy(status)) continue;
    const group = report.entries.filter((e) => e.status === status);
    if (!group.length) continue;
    if (lines.length) lines.push("");
    lines.push(`${healthy(status) ? status : status.toUpperCase()} (${group.length})`);
    const hints = new Set(group.map(entryHint));
    // The same advice for all of them reads once, under the heading.
    const shared = hints.size === 1 && group.length > 1;
    if (shared && [...hints][0]) lines.push(`  ${[...hints][0]}`);
    const width = Math.max(...group.map((e) => e.skill.length));
    for (const e of group) {
      const who = e.agents.length ? e.agents.join(", ") : "(unassigned)";
      const hint = entryHint(e);
      lines.push(`  ${e.skill.padEnd(width)} -> ${who}  (${e.path})${hint && !shared ? `\n      ${hint}` : ""}`);
    }
  }
  if (report.unmanaged.length) {
    if (lines.length) lines.push("");
    lines.push(`unmanaged (${report.unmanaged.length})`);
    const byFolder = new Map<string, typeof report.unmanaged>();
    for (const u of report.unmanaged) byFolder.set(path.dirname(u.path), [...(byFolder.get(path.dirname(u.path)) ?? []), u]);
    const listNames = showAll || filtered;
    for (const [folder, skills] of byFolder) {
      const where = `${folder} (${skills[0]!.agents.join(", ")})`;
      if (listNames) lines.push(`  ${where}`, ...skills.map((u) => `    ${u.name}`));
      else lines.push(`  ${skills.length} in ${where}`);
    }
    lines.push(`  bring them in with \`skillsym import\`${listNames ? "" : "; `skillsym status --only unmanaged` lists them"}`);
  }
  if (report.unregistered.length) {
    if (lines.length) lines.push("");
    lines.push(`NOT REGISTERED (${report.unregistered.length})`);
    const width = Math.max(...report.unregistered.map((u) => u.name.length));
    for (const u of report.unregistered) {
      lines.push(`  ${u.name.padEnd(width)}  (${u.path})${u.reason === "name-mismatch" ? "\n      SKILL.md names it differently than its folder; rename one so they match" : ""}`);
    }
    lines.push("  in the hub but not in the manifest; register and link with `skillsym sync` or `skillsym assign <name> -a <agents>`");
  }
  if (lines.length) lines.push("");
  const libraries = filtered ? { missing: [], newSkills: [], missingLibraries: [], folders: [] } : report.libraries;
  for (const m of libraries.missing.filter((m) => !report.entries.some((e) => e.skill === m.skill))) {
    lines.push(`SOURCE-MISSING  ${m.skill} (not assigned)  library folder ${m.source || "(unknown)"} is gone; run \`skillsym add <new library path> --link\` if it moved`);
  }
  const byLibrary = new Map<string, string[]>();
  for (const n of libraries.newSkills) byLibrary.set(n.library, [...(byLibrary.get(n.library) ?? []), n.name]);
  for (const [library, names] of byLibrary) {
    lines.push(`new in library ${library}: ${names.join(", ")} — add them with \`skillsym add "${library}" --link\``);
  }
  for (const l of libraries.missingLibraries) {
    lines.push(`library not found: ${l} — if it moved, run \`skillsym add <new path> --link\`; if it was deleted, \`skillsym sync\` can restore its skills from their latest snapshots or drop them`);
  }
  if (showAll && libraries.folders.length) {
    lines.push("", `libraries (${libraries.folders.length})`);
    for (const f of libraries.folders) lines.push(`  ${f.path}  ${f.found ? "found" : "NOT FOUND"}, ${f.skills} skill(s) linked${f.found && !f.git ? ", not in git" : ""}`);
  }
  for (const w of report.warnings) lines.push(`warning: ${w.message}`);

  const counts = new Map<string, number>();
  for (const e of report.entries) counts.set(e.status, (counts.get(e.status) ?? 0) + 1);
  const summary = [...counts].map(([s, n]) => `${n} ${s}`);
  if (report.unmanaged.length) summary.push(`${report.unmanaged.length} unmanaged`);
  if (report.unregistered.length) summary.push(`${report.unregistered.length} not registered`);
  const hidden = !showAll && report.entries.some((e) => healthy(e.status));
  if (summary.length) lines.push("", `${summary.join(", ")}.${report.clean ? "" : " Drift found."}${hidden ? " `skillsym status --all` lists every link." : ""}`);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimStart();
}

const ACTION_TEXT: Record<SyncAction["type"], [string, string]> = {
  link: ["would link", "linked"],
  relink: ["would re-link", "re-linked"],
  "replace-identical": ["would restore link over identical copy", "restored link over identical copy"],
  "unlink-orphan": ["would remove unassigned link", "removed unassigned link"],
  "unlink-duplicate": ["would remove duplicate link", "removed duplicate link"],
  forget: ["would stop tracking", "stopped tracking"],
  record: ["would record existing link", "recorded existing link"],
  "update-manifest": ["would update skills-json manifest", "updated skills-json manifest"],
  "unlink-manifest": ["would remove skills-json manifest", "removed skills-json manifest"],
};

/**
 * Ask, per new hub skill, which agents get it. Returns the agents chosen by skill name; a skill the
 * person skips ("not now") is left out and stays unregistered. A saved answer applies to later skills too.
 */
async function askNewSkills(hub: Hub, found: { name: string }[], io: Io, profiles: AgentProfile[]): Promise<Record<string, string[]>> {
  const answers: Record<string, string[]> = {};
  const configIds = (await readConfig(hub.configPath)).agents.map((a) => a.id);
  const installed: string[] = [];
  const registered: string[] = [];
  for (const p of profiles) {
    const here = await isAgentInstalled(p);
    if (here) installed.push(p.id);
    if (here || configIds.includes(p.id)) registered.push(p.id);
  }
  for (const u of found) {
    if (answers[u.name]) continue;
    const choice = (
      await io.ask!(
        [
          `New skill found in the hub: ${u.name}. Which agents should get it?`,
          `1) Every installed agent (${installed.join(", ")})  (default)`,
          "2) Choose agents",
          "3) Not now — leave it unregistered and ask again next sync",
          "> ",
        ].join("\n"),
      )
    ).trim();
    if (choice === "3") continue;
    let picked: string[];
    if (choice === "2") {
      const list = registered.map((id, i) => `${i + 1}) ${id}`).join("  ");
      const reply = await io.ask!(`Agents (comma-separated numbers): ${list}\n> `);
      picked = [...new Set(reply.split(",").map((s) => registered[Number(s.trim()) - 1]).filter((id): id is string => id !== undefined))];
      if (!picked.length) {
        io.stdout("No agent chosen; leaving it unregistered.");
        continue;
      }
    } else if (choice === "" || choice === "1") picked = ["*"];
    else {
      io.stdout(`"${choice}" is not one of the choices; leaving it unregistered.`);
      continue;
    }
    const future = (await io.ask!("Use this answer for future new skills too? (y/N) ")).trim().toLowerCase();
    if (future === "y" || future === "yes") await writeNewSkillsAgents(hub, picked);
    for (const f of found) if (future === "y" || future === "yes" || f.name === u.name) answers[f.name] = picked;
  }
  return answers;
}

function formatSync(
  actions: (SyncAction | SyncActionResult)[],
  conflicts: SyncConflict[],
  dryRun: boolean,
  registrations: { skill: string; agents: string[] }[] = [],
  unregistered: { name: string; path: string; reason?: string }[] = [],
): string {
  const lines: string[] = [];
  for (const r of registrations) lines.push(`${dryRun ? "would register" : "registered"}  ${r.skill} -> ${r.agents.join(", ")}  (new hub skill)`);
  for (const u of unregistered) {
    lines.push(
      `NOT REGISTERED  ${u.name}  (${u.path})\n          ${
        u.reason === "name-mismatch"
          ? "SKILL.md names it differently than its folder; rename one so they match"
          : `set newSkills.agents in config.json, run \`skillsym sync\` in a terminal to choose agents, or \`skillsym assign ${u.name} -a <agents>\``
      }`,
    );
  }
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
  if (!actions.length && !conflicts.length && !registrations.length && !unregistered.length) return "Already in sync.";
  if (conflicts.length) {
    lines.push(
      "",
      dryRun
        ? `${conflicts.length} conflict(s) would need your decision; \`skillsym sync\` in a terminal asks about each.`
        : `${conflicts.length} conflict(s) left untouched. Run \`skillsym sync\` in a terminal (without -y) to choose what to do for each.`,
    );
  }
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
  "source-missing": "is linked from a library folder that is gone (if you moved the library, choose skip and run `skillsym add <new path> --link`)",
};

/** Ask about each conflict in turn, then apply all decisions in one locked pass. */
async function askAndResolve(hub: Hub, conflicts: SyncConflict[], io: Io, profiles: AgentProfile[]): Promise<ConflictResolution[]> {
  const decisions: ConflictDecision[] = [];
  let quit = false;
  for (const c of conflicts) {
    if (quit) {
      decisions.push({ path: c.path, choice: "skip" });
      continue;
    }
    // A missing library skill can only come back from a snapshot, if there is one.
    const fromSnapshot = c.type === "source-missing";
    const canRestore = !fromSnapshot || (await hasLibrarySnapshot(hub, c.skill));
    const choices = choicesForConflict(c).filter((choice) => choice !== "restore" || canRestore);
    const title =
      c.delivery === "skills-json" && c.type === "missing-owned"
        ? "skills-json inherits or generated file was removed"
        : c.delivery === "skills-json" && c.type === "replaced-different"
          ? "generated skills-json file was modified outside skillsym"
          : CONFLICT_TITLE[c.type];
    io.stdout(`\n${c.skill} -> ${c.agents.join(", ")} ${title}\n  ${c.path}`);
    for (const choice of choices) {
      const help = fromSnapshot && choice === "restore" ? "put the skill back in your library from skillsym's latest snapshot" : CHOICE_HELP[choice];
      io.stdout(`  [${choice[0]}] ${choice.padEnd(7)} ${help}`);
    }
    const answer = await askOne(io, choices);
    if (answer === "quit") {
      quit = true;
      decisions.push({ path: c.path, choice: "skip" });
      continue;
    }
    const decision: ConflictDecision = { path: c.path, choice: answer };
    if (answer === "fork") {
      const suggested = defaultForkName(c);
      for (;;) {
        const name = (await io.ask!(`  New skill name [${suggested}] (Enter = use it): `)).trim() || suggested;
        if (isValidSkillName(name)) {
          decision.forkName = name;
          break;
        }
        io.stdout('  Names may use letters, digits, ".", "_" and "-" (up to 64 characters).');
      }
    }
    decisions.push(decision);
  }
  return resolveConflicts(hub, decisions, { profiles });
}

function formatResolutions(results: ConflictResolution[]): string {
  const lines = results.map((r) => {
    const skill = r.conflict?.skill ?? r.path;
    if (!r.ok) return `FAILED  ${r.choice} ${skill}: ${r.error}`;
    if (r.choice === "skip") return `skipped ${skill}`;
    let line = `${r.choice.padEnd(7)} ${skill}${r.newSkill ? ` -> new skill "${r.newSkill}"` : ""}`;
    if (r.library) line += r.choice === "restore" ? `\n        put back from the latest snapshot: ${r.library}` : `\n        wrote the new version into your library: ${r.library} (review it with git diff)`;
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

/** What the user can do next, for errors whose message does not already say. */
const NEXT_STEP: Record<string, string> = {
  USAGE: "Run `skillsym --help` to see the commands and options.",
  LOCK_TIMEOUT: "Another skillsym command is running; wait for it and try again. A lock left by a crashed run is cleared automatically.",
  CONFIG_INVALID: "Fix the file, or delete it to use only the built-in agents.",
  UNKNOWN_AGENT: "Add another agent with `skillsym config add <id> <folder>`.",
  INVALID_SKILL_NAME: "Use only letters, digits, \".\", \"_\" and \"-\", starting with a letter or digit.",
  MANIFEST_CORRUPT: "Restore manifest.json from a backup, or fix the JSON by hand; skillsym will not overwrite it.",
  STATE_CORRUPT: "Fix state.json by hand, or delete it and run `skillsym sync` to rebuild it from the links on disk.",
  SKILLS_JSON_INVALID: "Fix the agent's skills.json syntax (or back it up and replace with `{\"entries\": []}`).",
  REMOTE_INVALID: "Use `owner/repo[@ref]`, `https://github.com/owner/repo/tree/<ref>/<subpath>`, or a valid git URL.",
  REMOTE_FETCH_FAILED: "Check the repository URL, ref name, git installation, and network/SSH credentials.",
};

function report(err: unknown, io: Io, json: boolean): ExitCode {
  const error =
    err instanceof SkillsymError
      ? { code: err.code, message: err.message, details: err.details }
      : err instanceof UsageError
        ? { code: "USAGE", message: err.message, details: {} }
        : { code: "INTERNAL", message: (err as Error)?.message ?? String(err), details: {} };
  if (json) io.stdout(JSON.stringify({ error }));
  else {
    io.stderr(`skillsym: ${error.message}`);
    const next = NEXT_STEP[error.code];
    if (next) io.stderr(`  ${next}`);
  }
  return 2;
}

/** The user's home directory as the given environment defines it (what os.homedir() reads). */
function userHome(env: NodeJS.ProcessEnv): string {
  const fromEnv = process.platform === "win32" ? env.USERPROFILE : env.HOME;
  return fromEnv?.trim() || os.homedir();
}

function formatMigrationPlan(plan: MigrationPlan): string {
  if (!plan.needed) return "Nothing to migrate.";
  const lines = ["Migration preview (dry run — nothing changed):"];
  if (plan.legacyConfigAgent) lines.push(`  - remove legacy "gemini" override from ${plan.configPath} (backed up first)`);
  if (plan.manifestSkillsToMove.length) lines.push(`  - move ${plan.manifestSkillsToMove.length} skill assignment(s) from gemini to antigravity`);
  if (plan.ownedLinksToRemove.length) lines.push(`  - remove ${plan.ownedLinksToRemove.length} skillsym-owned link(s) in Antigravity's skills folder`);
  if (plan.broadSkillsJsonEntries.length) lines.push(`  - remove broad entry/entries (${plan.broadSkillsJsonEntries.join(", ")}) from ${plan.skillsJsonPath} (backed up first)`);
  lines.push("  - write skills-json manifest + inherits for built-in antigravity", "", "Run `skillsym migrate` to apply.");
  return lines.join("\n");
}

function formatMigrationResult(res: MigrationResult): string {
  const lines = [
    `Migrated to built-in "antigravity" (skills-json delivery):`,
    `  - moved ${res.manifestSkillsToMove.length} skill assignment(s)`,
    `  - removed ${res.unlinkedCount} legacy link(s) and ${res.removedBroadEntries} broad skills.json entry/entries`,
    ...res.backups.map((b) => `  - backup: ${b}`),
  ];
  return lines.join("\n");
}

async function askMigrationConfirm(plan: MigrationPlan, io: Io): Promise<boolean> {
  const details: string[] = [];
  if (plan.legacyConfigAgent) details.push(`legacy "gemini" config pointing at Antigravity's folder`);
  if (plan.ownedLinksToRemove.length) details.push(`${plan.ownedLinksToRemove.length} legacy link(s)`);
  if (plan.broadSkillsJsonEntries.length) details.push(`whole-folder entries (${plan.broadSkillsJsonEntries.join(", ")}) in ${plan.skillsJsonPath}`);
  io.stdout(
    `\nskillsym now supports Antigravity directly via skills.json.\nFound: ${details.join("; ")}.\n  [1] Migrate to built-in antigravity (backs up files, keeps custom entries and real folders)\n  [2] Skip for now (Enter = skip)`,
  );
  const answer = (await io.ask!("Choose [1/2] (Enter = skip): ")).trim().toLowerCase();
  return answer === "1" || answer === "y" || answer === "yes";
}

async function promptAntigravityMigration(hub: Hub, plan: MigrationPlan, io: Io, profiles: AgentProfile[]): Promise<boolean> {
  if (!(await askMigrationConfirm(plan, io))) {
    io.stdout("Skipped migration; continuing with sync.\n");
    return false;
  }
  const migrated = await applyAntigravityMigration(hub, { profiles, homedir: path.dirname(path.dirname(path.dirname(plan.skillsJsonPath))) });
  io.stdout(formatMigrationResult(migrated) + "\n");
  return migrated.applied;
}

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}
