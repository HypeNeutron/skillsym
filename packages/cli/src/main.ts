import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  addSkill,
  assignSkills,
  loadProfiles,
  listSkills,
  openHub,
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
} from "@skillsym/core";

/** 0 = success / no drift, 1 = drift or unresolved conflict, 2 = usage error or failure. */
export type ExitCode = 0 | 1 | 2;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
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

const USAGE = `Usage: skillsym <command> [options]

Commands:
  add <path> [-a <agents>]      Copy a skill folder (with SKILL.md) into the hub, optionally assign it
  assign <skill...> -a <agents> Link hub skills into agents' skills folders
  list, ls                      List skills in the hub and their agents
  status                        Show every link's state: synced, missing, dangling, replaced, blocked, orphaned
  check                         Same as status, but exit 1 if anything is not synced (for CI and scripts)
  sync [--dry-run]              Make the agents' folders match the manifest; asks about conflicts
                                (without a terminal, or with -y, conflicts are only reported)
  import [--dry-run]            Bring skills already in agents' folders into the hub (originals backed up,
                                replaced by links); copies that differ: choose one, keep both, or merge
  import --continue | --abort   Finish or drop an open merge
  remove, rm <skill...> [-a]    With -a: unassign those agents only. Without: remove from every agent
                                and from the hub (asks first; the hub copy is moved to backups)
  eject [--dry-run]             Stop using skillsym: replace every skillsym link with a real copy (asks first;
                                the hub is kept, delete it yourself when you are sure)

Options:
  -a, --agent <ids>  Agents: claude, codex, cursor, universal; comma-separated or repeated; '*' = all installed
  -s, --skill <name> Skill names (alternative to positional names); '*' = all skills in the hub
  --all              All skills to all installed agents (same as -s '*' -a '*')
  --dry-run          Show what would change without changing anything
  -y, --yes          Never ask questions: sync/import conflicts are reported and left alone; remove and eject proceed
  --json             Machine-readable output
  -h, --help        Show this help
  -v, --version     Show version`;

class UsageError extends Error {}

export async function main(argv: string[], io: Io): Promise<ExitCode> {
  const json = argv.includes("--json");
  try {
    return await run(argv, io, json);
  } catch (err) {
    if (err instanceof PromptCancelled) {
      io.stdout("\nCancelled. None of your answers were applied; run the command again when you are ready to decide.");
      return 1;
    }
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
  const writes = ["add", "assign", "sync", "remove", "rm", "import", "eject"].includes(command) && !values["dry-run"];
  const showsPending = writes || command === "status" || command === "check";
  if (showsPending && !(command === "import" && (values.continue || values.abort))) {
    const pending = await readPendingImport(hub);
    if (pending) io.stderr(`warning: a merge of "${pending.skill}" is still open in ${pending.mergeDir}; finish it with \`skillsym import --continue\` or drop it with \`--abort\`.`);
  }
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
      if (resolutions.some((r) => r.choice === "skip")) io.stdout("\nSkipped conflicts are unchanged. Run `skillsym sync` again whenever you want to decide them.");
      if (failed || resolutions.some((r) => !r.ok)) return 2;
      return resolutions.some((r) => r.choice === "skip") ? 1 : 0;
    }
    case "import": {
      if (rest.length) throw new UsageError("import takes no arguments; it scans every agent's skills folder");
      if (values.continue && values.abort) throw new UsageError("use either --continue or --abort, not both");
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
        const plan = await planImport(hub, { profiles });
        if (json) io.stdout(JSON.stringify({ dryRun: true, ...plan }));
        else io.stdout(formatImport(plan.items, true));
        return plan.items.some((i) => i.type === "conflict") ? 1 : 0;
      }
      const result = await importSkills(hub, { profiles });
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
      const resolved = await resolveImportConflicts(hub, decisions, { profiles });
      io.stdout(formatImportDecisions(resolved));
      for (const r of resolved) if (r.mergeDir && openEditor(io, r.mergeDir)) io.stdout(`          (opened ${r.mergeDir} in your editor)`);
      if (resolved.some((r) => r.choice === "skip")) io.stdout("\nSkipped skills are unchanged. Run `skillsym import` again whenever you want to decide them.");
      if (failed || resolved.some((r) => !r.ok)) return 2;
      return resolved.some((r) => r.choice === "skip" || r.choice === "merge") ? 1 : 0;
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
      if (rest.length) throw new UsageError("eject takes no arguments; it replaces every skillsym link with a real copy");
      const dryRun = Boolean(values["dry-run"]);
      if (!dryRun && !values.yes) {
        if (!(io.interactive && io.ask && !json)) {
          throw new UsageError("eject replaces every skillsym link with a real copy; confirm with -y, or preview it with --dry-run.");
        }
        const answer = (
          await io.ask("Replace every skillsym link with a real copy of the skill, so you can stop using skillsym? [y/N] (Enter = no) ")
        )
          .trim()
          .toLowerCase();
        if (answer !== "y" && answer !== "yes") {
          io.stdout("Cancelled; nothing changed. Preview what eject would do with `skillsym eject --dry-run`.");
          return 1;
        }
      }
      const report = await eject(hub, { dryRun });
      if (json) io.stdout(JSON.stringify({ dryRun, ...report }));
      else io.stdout(formatEject(report, dryRun));
      return report.results.some((r) => r.outcome === "failed") ? 2 : 0;
    }
    default:
      throw new UsageError(`Unknown command "${command}".\n\n${USAGE}`);
  }
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
    spawn(editor, [dir], { detached: true, stdio: "ignore", shell: true }).unref();
    return true;
  } catch {
    // Opening an editor is a convenience; the printed instructions are enough.
    return false;
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
  failed: ["FAILED", "FAILED"],
};

function formatEject(report: EjectReport, dryRun: boolean): string {
  if (!report.results.length) return "Nothing to eject: skillsym has no links in your agents' folders.";
  const lines = report.results.map((r) => `${EJECT_TEXT[r.outcome][dryRun ? 0 : 1]}  ${r.skill}  (${r.path})${r.error ? `\n          ${r.error}` : ""}`);
  if (dryRun) {
    lines.push("", "Nothing was changed. Run `skillsym eject` to do this.");
  } else if (report.results.some((r) => r.outcome === "failed")) {
    lines.push("", "Some links could not be replaced and were left as they are; fix the error above and run `skillsym eject` again.");
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
        continue: { type: "boolean" },
        abort: { type: "boolean" },
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
    const choices = choicesFor(c.type);
    io.stdout(`\n${c.skill} -> ${c.agents.join(", ")} ${CONFLICT_TITLE[c.type]}\n  ${c.path}`);
    for (const choice of choices) io.stdout(`  [${choice[0]}] ${choice.padEnd(7)} ${CHOICE_HELP[choice]}`);
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
  UNKNOWN_AGENT: "Agents that are not built in can be added in config.json in the hub folder.",
  SKILL_NOT_IN_HUB: "See what is in the hub with `skillsym list`.",
  MANIFEST_CORRUPT: "Restore manifest.json from a backup, or fix the JSON by hand; skillsym will not overwrite it.",
  STATE_CORRUPT: "Fix state.json by hand, or delete it and run `skillsym sync` to rebuild it from the links on disk.",
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

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}
