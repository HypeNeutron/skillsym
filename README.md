# skillsym

Keep every coding agent's skills in one hub. skillsym links your skills into Claude Code, Codex, Cursor and
other agents, notices when something drifts, and helps you fix it, without copying files around.

```text
~/.claude/skills/coding  ──link──┐
~/.agents/skills/coding  ──link──┼──► ~/.skillsym/skills/coding   (one real copy)
~/.cursor/skills/…       (Cursor already reads ~/.claude/skills, so no second link)
```

- **One source of truth.** Edit a skill once; every agent sees the change.
- **Drift detection.** `skillsym status` tells you when a link was deleted, replaced, or points at nothing, and
  `skillsym sync` repairs what it can and asks about the rest.
- **Safe by default.** skillsym only touches links it created, backs up before overwriting, and `eject` returns
  everything to real copies if you stop using it.
- **Windows without admin rights.** Uses junctions on Windows (no Developer Mode needed) and symlinks on macOS and Linux.
- **No telemetry, no network calls.**

> Status: **0.1.0** — the command line tool. A background watcher and a desktop app are planned (see [Roadmap](#roadmap)).

## Requirements

Node.js 20 or later. Works on Windows, macOS and Linux.

**Tested with:** Claude Code, Codex and Cursor on Windows 11. On macOS and Linux, all of skillsym's link handling
is tested in CI, but it has not yet been tried with the agents themselves. If you use it there, please
[open an issue](https://github.com/HypeNeutron/skillsym/issues) and say whether your agents picked up the skills.

## Quickstart

Already have skills in your agents' folders? Bring them in:

```bash
npx skillsym import --dry-run   # preview: what moves into the hub, what gets backed up
npx skillsym import             # do it: originals are backed up and replaced by links
npx skillsym status             # every link should say "synced"
```

Starting fresh, or adding a skill you wrote:

```bash
npx skillsym init my-skill                    # creates my-skill/SKILL.md from a template
npx skillsym add my-skill -a claude,codex     # copy it into the hub and link it into both agents
npx skillsym list
```

Have your own library of skills (a folder or a git repo)?

```bash
npx skillsym add ~/my-skills -a claude          # copy every skill in it; the hub becomes the source of truth
npx skillsym add ~/my-skills --link -a claude   # or: link to it, so your library stays the source of truth
```

Install it globally if you prefer `skillsym` over `npx skillsym`:

```bash
npm install -g skillsym
```

## How it works

- The **hub** is a folder (`~/.skillsym`, or wherever `SKILLSYM_HOME` points). It holds the real skill folders,
  a `manifest.json` that says which skill goes to which agent, a `state.json` listing every link skillsym created,
  and a `config.json` for your own agents.
- Each agent's skills folder gets a **link** to the hub copy. A link is not a copy: the agent reads the files
  in the hub. Deleting a link never deletes the skill.
- `sync` makes the agents' folders match the manifest. It runs again safely: a second run changes nothing.

### Agents

| id | Skills folder | Notes |
|---|---|---|
| `claude` | `~/.claude/skills` | Picks up edits immediately. |
| `codex` | `~/.agents/skills` | Also reads `~/.codex/skills`. Rejects a `SKILL.md` that starts with a UTF-8 BOM; skillsym warns about those. |
| `cursor` | `~/.cursor/skills` | Also reads `~/.claude/skills`, `~/.codex/skills` and `~/.agents/skills`, so it is usually *covered* by another agent's link. Reloads skills only when restarted. |
| `universal` | `~/.agents/skills` | The shared folder several agents read. |

Use `-a '*'` for every agent installed on this machine. `skillsym config` shows every agent and its folder. To add
another agent, or change a path, edit `config.json` in the hub folder. skillsym creates it with an empty `agents`
list, because built-in agents need no entry there:

```json
{
  "version": 1,
  "agents": [
    { "id": "windsurf", "skillsDir": "~/.windsurf/skills" },
    { "id": "reader", "skillsDir": "~/.reader/skills", "alsoReads": ["~/.claude/skills"], "reload": "restart" }
  ]
}
```

An agent with the same id as a built-in one replaces it. `alsoReads` lists other folders the agent loads skills
from, so skillsym does not give it a second copy of a skill it already sees.

## Commands

| Command | What it does |
|---|---|
| `skillsym init [name]` | Create a `SKILL.md` template in `./<name>` (or here, named after this folder). |
| `skillsym add <path> [-a agents]` | Copy one skill folder into the hub and optionally assign it. |
| `skillsym add <library> [-a agents] [--dry-run]` | A folder of skills: copy every skill in it (any depth; `.git` and `node_modules` are skipped). The library is not changed. |
| `skillsym add <library> --link [-a agents]` | Link the hub to your library instead of copying it. Run it again to pick up new skills, or to point at the library's new location after you move it. |
| `skillsym assign <skill...> -a <agents>` | Link hub skills into agents' folders. |
| `skillsym list` / `ls` | List hub skills, their agents, and where linked skills come from. |
| `skillsym status` | Show the state of every link, unmanaged skills, and news from linked libraries. |
| `skillsym check` | Same as `status`, but exits 1 if anything is not in sync (for CI and scripts). |
| `skillsym sync [--dry-run]` | Repair drift. Fixes what it can decide alone and asks about the rest. |
| `skillsym import [--dry-run]` | Move skills found in agents' folders into the hub. |
| `skillsym import --continue` / `--abort` | Finish or drop an open merge. |
| `skillsym remove <skill...> -a <agents>` | Unassign a skill from some agents. |
| `skillsym remove <skill...>` / `rm` | Remove a skill from every agent and from the hub (the hub copy is moved to backups; a linked library is never touched). |
| `skillsym config` | Show the config file's location and every agent with its skills folder. |
| `skillsym eject [--dry-run]` | Stop using skillsym: replace every link with a real copy. |

Options:

| Option | Meaning |
|---|---|
| `-a, --agent <ids>` | Agent ids, comma-separated or repeated; `'*'` = every installed agent. |
| `-s, --skill <name>` | Skill names (instead of positional names); `'*'` = every skill in the hub. |
| `--all` | Every skill to every installed agent (`-s '*' -a '*'`). |
| `--dry-run` | Show what would change; change nothing. |
| `--link` | With `add`: link to your library instead of copying it. |
| `-y, --yes` | Never ask. Conflicts are reported and left alone; `remove` and `eject` proceed. |
| `-g, --global` | User-level skills (the default). |
| `-p, --project` | Project-level skills — arrives in v0.2. |
| `--json` | Machine-readable output. |
| `-h, --help` | Show the commands and options. |
| `-v, --version` | Show the version. |

Exit codes: `0` done, nothing to fix · `1` something needs your attention (drift, a conflict you skipped, a
skipped skill) · `2` an error. With `--json`, errors are printed as `{"error": {"code", "message"}}`.

## Status at a glance

| Status | Meaning | `sync` |
|---|---|---|
| `synced` | Our link is in place. | — |
| `covered` | The agent already sees the skill through another agent's folder. | — |
| `missing` | Assigned, but nothing is there. | Links it (or asks, if it was our link and someone removed it). |
| `dangling` | Our link points at a hub location that no longer exists (the hub moved). | Re-links it. |
| `replaced` | Something replaced our link. | Same content: re-links (the copy is backed up). Different: asks — adopt, restore, or fork. |
| `blocked` | An assigned path holds something skillsym did not create. | Leaves it; use `import`. |
| `orphaned` | Our link is no longer assigned. | Removes the link. |
| `duplicate` | Our link duplicates a skill the agent already sees elsewhere. | Removes the link. |
| `source-missing` | A `--link` skill's library folder is gone. | Asks — drop, or skip and run `add <new path> --link`. |
| `unmanaged` | A skill folder skillsym does not manage. | Leaves it; use `import`. |

## Answering questions

When `sync` or `import` needs a decision, it asks one question at a time:

- **Enter** skips that one, **q** skips all the rest, **Ctrl+C** cancels without applying any answer.
- Without a terminal (or with `-y`) nothing is asked: conflicts are reported and left alone.
- Every command that leaves something undecided tells you which command to run next.

### Import: copies that differ

If the same skill exists in several agents with different content, you choose:

- **primary** — keep one version; the others are backed up and replaced by links to it.
- **keep-both** — keep each version as its own skill (`research` and `research-codex`).
- **merge** — skillsym writes a merged folder with git-style markers (`<<<<<<< claude` … `>>>>>>>`) around the
  lines that differ, and opens it in `$EDITOR` if set. Edit it, then run `skillsym import --continue`, or
  `skillsym import --abort`. Nothing in your agents' folders changes until you continue. Binary files that differ
  are written as `file` and `file.<agent>`; keep one and delete the other before continuing.

## Your own library

| | `add <library>` | `add <library> --link` |
|---|---|---|
| Source of truth | the hub | your library |
| Edit skills in | `~/.skillsym/skills` | your library (and commit as usual) |
| The library afterwards | not used by skillsym; keep or delete it | still in use; skillsym never deletes anything in it |
| New skills in the library | add them again yourself | `status` lists them; run the same `add --link` again |

With `--link`, if you resolve a conflict by adopting an agent's version, or pick an agent's copy during import,
skillsym writes it **into your library** after backing up the library's version, so you can review it with `git diff`.

## Using it with `npx skills`

[`npx skills`](https://github.com/vercel-labs/skills) installs skills from the internet; skillsym manages the
skills you already have. They work side by side:

- skillsym never touches what `npx skills` created — its copies in `~/.agents/skills`, its links, or its lock file.
  They show up as `unmanaged`, and `import` skips folders another tool links to.
- `skillsym sync` is not `npx skills sync`: ours makes your agents' user-level folders match skillsym's manifest;
  theirs syncs skills shipped by npm packages into a project.

## Windows

- skillsym uses **junctions**, which need neither administrator rights nor Developer Mode. Symlinks would need one of them.
- Keep the hub out of OneDrive (including a Desktop or Documents folder that OneDrive redirects), Dropbox, Google
  Drive and iCloud Drive. Sync clients can turn links into copies. skillsym warns when the hub is inside one; move
  it and point `SKILLSYM_HOME` at the new place, then run `skillsym sync`.
- Save `SKILL.md` as UTF-8 **without** a BOM (Windows PowerShell 5.1 and old Notepad add one). Codex will not load
  a skill whose `SKILL.md` starts with a BOM; `status` warns about it.

## Leaving

```bash
npx skillsym eject --dry-run
npx skillsym eject
```

Every link skillsym created becomes a real copy, so your agents keep working. The hub stays where it is, with its
backups; delete it once you are sure.

## Privacy

skillsym makes no network calls and collects no telemetry. Everything stays on your machine.

## Roadmap

- **v0.2** — a background watcher that notices drift as it happens; project-level skills (`-p`); turning a
  `--link` skill into a hub copy.
- **v0.3** — a desktop app: tray icon, dashboard, drag-and-drop assignment.
- Later — skill version history, presets.

Teams: if you want to share a skill library across a team, see drift across everyone's machines, or roll out a new
version gradually, please tell us what you need in an issue labelled `teams`.

## Development

```bash
pnpm install
pnpm test
```

Tests run against a real filesystem in temporary folders, on Windows, macOS and Linux in CI. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
