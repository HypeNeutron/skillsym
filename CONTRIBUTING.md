# Contributing to skillsym

Thanks for helping. skillsym changes files in people's home folders, so the bar for safety is high; the rules
below exist to keep it that way.

## Setup

```bash
pnpm install
pnpm test        # builds both packages, then runs every test
pnpm typecheck
```

Node.js 20 or later. CI runs the tests on Windows, macOS and Linux with Node 20 and 24; please make sure a change
works on all three (links and file errors differ between them).

## Layout

- `packages/core` — `@skillsym/core`, the library: manifest, state, scan, plan, apply. It has **no terminal code**
  (no prompts, no printing, no `process.exit`), so the CLI, a future background watcher and the desktop app can all
  use it. Decisions are returned to the caller as data (for example sync conflicts with their choices).
- `packages/cli` — `skillsym`, the command line: parses arguments, calls core, prints text or `--json`, asks
  questions when there is a terminal, and sets the exit code.

## Rules that keep users' files safe

1. **Only touch what skillsym created.** Every link we create is recorded in `state.json`; never remove or replace a
   path that is not recorded there. Anything else is reported (as `blocked` or `unmanaged`) and left alone.
2. **Back up before overwriting.** Anything replaced goes to the hub's `backups/` folder with a timestamp.
3. **Never delete a user's library.** Skills added with `--link` point into the user's own folder; `remove` and
   `eject` must never change it, and anything that writes into it backs it up first.
4. **Ask, don't guess.** When the right outcome depends on intent (a link someone removed, content that differs),
   return a conflict with choices. Without a terminal, report and change nothing.
5. **Every prompt has a way out**: Enter skips, `q` skips the rest, Ctrl+C cancels without applying any answer.
   Every output that leaves something undecided says which command to run next.
6. **Write UTF-8 without a BOM.** Codex rejects a `SKILL.md` that starts with one.
7. **No network calls, no telemetry.** A test checks this.
8. **Never reset a file we cannot read.** An unknown `manifest.json`/`state.json` version is an error, not a reason
   to start over.
9. **A path through a file is "missing", not an error.** macOS and Linux report `ENOTDIR`, Windows `ENOENT`; use
   `isMissing()`.

## Tests

- Test external behaviour: what ends up on disk (where links point, backups, file contents), the manifest and
  state, the status `scan` reports, and the CLI's `--json` output and exit codes. Don't test private functions.
- **Use the real filesystem** in a temporary folder (`makeTempDir`, `makeSkill` in `packages/core/test/helpers.ts`).
  Don't mock `fs`: the behaviour of junctions and symlinks across operating systems is exactly what we need to test.
- Point agents at the temporary folder with `builtinAgents(tempHome)` in core tests, and with `HOME`/`USERPROFILE`
  in the CLI's environment. Never let a test reach the real `~/.claude/skills`.
- Commands that change files need tests for: the result on disk, `--dry-run` matching the real run and changing
  nothing, running twice, and leaving other tools' files alone.

## Adding or changing a built-in agent

Built-in agents live in `builtinAgents()` in `packages/core/src/agents.ts`. Each needs:

- `skillsDir` — the user-level folder we link into;
- `alsoReads` — every other folder the agent loads skills from (this is what prevents loading a skill twice);
- `reload` — whether edits show up without a restart;
- `detectDir` — a folder whose presence means the agent is installed (for `-a '*'`);
- `reserved` — entries in the skills folder the agent manages itself, which skillsym must never touch.

Please include evidence for each value: the agent's documentation, or what you observed (agent version and OS).
Paths change between agent releases, which is why users can also override agents in `config.json`.

## Commits and pull requests

Small, focused changes with tests. Describe what changes for the user, and anything you could not test (for
example an operating system you don't have).
