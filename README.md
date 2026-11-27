# skillsym

Keep every coding agent's skills in one hub. skillsym links (or registers via `skills.json`) your skills into Claude
Code, Codex, Cursor, Gemini CLI, Antigravity and other agents, notices when something drifts, and helps you fix it,
without copying files around.

```text
~/.claude/skills/coding      ──link──┐
~/.agents/skills/coding      ──link──┼──► ~/.skillsym/skills/coding   (one real copy)
~/.gemini/config/skills.json ──inherits──► ~/.skillsym/antigravity-skills.json
~/.cursor/skills/…           (Cursor already reads ~/.claude/skills, so no second link)
```

- **One source of truth.** Edit a skill once; every agent sees the change.
- **Drift detection.** `skillsym status` tells you when a link was deleted, replaced, or points at nothing, and
  `skillsym sync` repairs what it can and asks about the rest.
- **Safe by default.** skillsym only touches links and manifests it created, backs up before overwriting, and `eject`
  returns everything to real copies if you stop using it.
- **Windows without admin rights.** Uses junctions on Windows (no Developer Mode needed), `skills-json` manifests where
  supported (Antigravity), and symlinks on macOS and Linux.
- **No telemetry, no background network calls.** `status`, `check` and `sync` stay 100% offline; `git` contacts a
  remote only when you explicitly pass one to `add` or run `update`.

> Status: **0.1.0**, the command line tool. See the [Roadmap](#roadmap) for what may come next.

## Requirements

Node.js 20 or later. Works on Windows, macOS and Linux.

**Tested with:** Claude Code, Codex, Cursor, Gemini CLI and Antigravity (`agy` 1.5.9) on Windows 11. On macOS and Linux, all of skillsym's link handling
is tested in CI, but it has not yet been tried with the agents themselves. If you use it there, please
[open an issue](https://github.com/HypeNeutron/skillsym/issues) and say whether your agents picked up the skills.

**Agents that do not read links:** skillsym needs an agent to follow links unless the agent supports a `skills.json`
manifest. Antigravity ignores Windows junctions (and has been reported to ignore symlinks on macOS), so the built-in
`antigravity` agent uses **`skills-json` delivery** instead: skillsym writes `<hub>/antigravity-skills.json` grouped by
source folder (`include_only`) and references it via `inherits` in `~/.gemini/config/skills.json`, keeping your own
entries untouched. For other agents that neither follow links nor read `skills.json`, give them real copies with:

```bash
npx skillsym eject -a <agent>
```

Previously configured `gemini` at `~/.gemini/config/skills`? Run `npx skillsym migrate` (or `skillsym sync` in a
terminal) to switch safely to `antigravity` with backups.

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

Installing or updating skills from a GitHub repository?

```bash
npx skillsym add vercel-labs/skills -s find-skills -a claude,antigravity
npx skillsym update --dry-run
npx skillsym update
```

Install it globally if you prefer `skillsym` over `npx skillsym`. That also gives you `ssym`, the short name for
the same command (`ssym status`, `ssym sync`):

```bash
npm install -g skillsym
```

### Tab completion

Press Tab to fill in commands, options, skill names, agents and statuses. It works with `skillsym` and `ssym` after a
global install (`npm install -g skillsym`), not with `npx`.

Turn it on once, then open a new terminal. skillsym never edits these files itself; only the command you run does.

**PowerShell**

```powershell
if (!(Test-Path $PROFILE)) { New-Item $PROFILE -ItemType File -Force | Out-Null }
skillsym completion powershell | Add-Content $PROFILE
```

PowerShell runs `$PROFILE` only if its execution policy allows scripts. If a new terminal reports that scripts are
disabled, check it with `Get-ExecutionPolicy`. `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` is the usual
setting, but it applies to every script you run, so that choice is yours.

**bash**

```bash
skillsym completion bash >> ~/.bashrc
```

**zsh** (needs `compinit`, which most setups already run)

```bash
skillsym completion zsh >> ~/.zshrc
```

Then press Tab:

```text
ssym sy<Tab>                 sync
ssym status --o<Tab>         --only
ssym open we<Tab>            web-tools
ssym assign x -a c<Tab>      claude  codex  cursor
ssym assign x -a claude,c<Tab>   claude,codex  claude,cursor
ssym status --only m<Tab>    missing
ssym config <Tab>            add  remove
```

What it offers depends on what you are typing:

| You are typing | Tab offers |
|---|---|
| A command | Every command, including `ls` and `rm` |
| `--` after a command | The options that command accepts |
| A skill for `open`, `assign`, `remove`, `eject`, `sync`, `update` | Skills in the hub, leaving out names already on the line |
| A skill for `status`, `check` | Skills in the hub and unmanaged skills |
| A skill for `import` | Skills that can be imported, not those in the hub |
| After `-a` | Agents, including your own from `config.json` |
| After `--only` | Statuses |
| After `config remove` | Agents in your `config.json` |
| A path for `add` | Your shell's usual file completion |

Tab starts Node each time, so it can take a moment: about a quarter of a second for hub skills and longer for
`import`, which scans your agents' folders. To turn it off, delete the lines it added from the same file.

Tested in Windows PowerShell 5.1 and in bash. The zsh script has not been tried by hand yet, so please
[open an issue](https://github.com/HypeNeutron/skillsym/issues) and say how it goes.

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
| `codex` | `~/.agents/skills` | Also reads `~/.codex/skills`; `import` moves skills found there into the hub and links them from `~/.agents/skills`. Rejects a `SKILL.md` that starts with a UTF-8 BOM; skillsym warns about those. |
| `cursor` | `~/.cursor/skills` | Also reads `~/.claude/skills`, `~/.codex/skills` and `~/.agents/skills`, so it is usually *covered* by another agent's link. Reloads skills only when restarted. |
| `gemini` | `~/.gemini/skills` | Gemini CLI (`@google/gemini-cli`). Also reads `~/.agents/skills`; detected when `~/.gemini/skills` exists. |
| `antigravity` | `~/.gemini/config/skills.json` | Uses `skills-json` delivery (`inherits` → `<hub>/antigravity-skills.json`) so hub and `--link` skills load without junctions; `eject` copies real folders to `~/.gemini/config/skills`. |
| `universal` | `~/.agents/skills` | The shared folder several agents read. |

Use `-a '*'` for every agent installed on this machine. `skillsym config` shows every agent and its folder.

Add or remove your own agents from the command line:

```bash
npx skillsym config add windsurf ~/.windsurf/skills
npx skillsym import -a windsurf          # bring in skills already there
npx skillsym config remove windsurf      # refused while skills are assigned to it
```

Removing an agent leaves the files in its folder alone. To change a path or set other fields, edit `config.json` in
the hub folder. skillsym creates it with an empty `agents` list, because built-in agents need no entry there:

```json
{
  "version": 1,
  "agents": [
    { "id": "windsurf", "skillsDir": "~/.windsurf/skills" },
    { "id": "reader", "skillsDir": "~/.reader/skills", "alsoReads": ["~/.claude/skills"], "reload": "restart" },
    { "id": "my-ide", "delivery": "skills-json", "skillsDir": "~/.my-ide/skills", "skillsJsonPath": "~/.my-ide/skills.json" }
  ],
  "newSkills": { "agents": ["claude", "codex"] }
}
```

An agent with the same id as a built-in one replaces it. `alsoReads` lists other folders the agent loads skills
from, so skillsym does not give it a second copy of a skill it already sees. Set `"delivery": "skills-json"` and
`"skillsJsonPath"` for any custom agent that uses an Antigravity-style `skills.json` manifest instead of folder links.

### Skills you create in the hub

A folder you create straight in the hub (`<hub>/skills/<name>/SKILL.md`) is not in the manifest yet, so no agent
sees it. skillsym notices it: `status` lists it under "Not registered" and `check` exits 1. Then either:

- `skillsym sync` registers it and links it to the agents in `newSkills.agents` of `config.json` (agent ids, or
  `"*"` for every installed agent). If that is not set, `sync` in a terminal asks which agents should get it, and can
  save your answer. With `-y`, `--json` or without a terminal it only reports the folder and exits 1.
- `skillsym assign <name> -a <agents>` registers it and links it in one step.
- `skillsym watch` does it for you as soon as you create the folder; see [Watch](#watch).

Ignored: loose files such as `.zip`, folders starting with `.` or `tmp`, folders without a `SKILL.md`, and names
that are not valid skill names. A folder whose `SKILL.md` `name:` differs from the folder name is reported and never
registered; rename one of them. A registered skill whose folder you deleted by hand is reported, never unlinked for you.

## Commands

| Command | What it does |
|---|---|
| `skillsym init [name]` | Create a `SKILL.md` template in `./<name>` (or here, named after this folder). |
| `skillsym add <path> [-a agents]` | Copy one skill folder into the hub and optionally assign it. |
| `skillsym add <owner/repo> [-s skill] [-a agents] [--dry-run]` | Clone or fetch a GitHub/git repo into `<hub>/remotes/` and copy its skills (or only `-s <skill>`) into the hub; attaches tracking if a skill already exists there. |
| `skillsym add <library> [-a agents] [--dry-run]` | A folder of skills: copy every skill in it (any depth; `.git` and `node_modules` are skipped). The library is not changed. |
| `skillsym add <library> --link [-a agents]` | Link the hub to your library instead of copying it. Run it again to pick up new skills, or to point at the library's new location after you move it. |
| `skillsym add <owner/repo> [-s skill] --upstream <skill>` | Watch an upstream repo for a combined/orchestrator skill without touching its adapted hub files. |
| `skillsym assign <skill...> -a <agents>` | Link hub skills into agents' folders. |
| `skillsym list [-a agents]` / `ls` | List hub skills, their agents, and where linked/remote skills come from. |
| `skillsym open <skill>` | Print a skill's folder and open it in `$EDITOR`, or your file manager. A `--link` skill opens in your library. |
| `skillsym status [skill...] [-a agents] [--only states] [--all]` | Show links by status: what needs attention, unmanaged skills, news from linked libraries, and a count. `--all` also lists links that are fine; `--only` and names narrow it. |
| `skillsym check` | Same as `status`, but exits 1 if anything is not in sync (for CI and scripts). |
| `skillsym sync [skill...] [-a agents] [--dry-run]` | Repair drift, optionally only for those skills or agents. Fixes what it can decide alone and asks about the rest. Also registers skill folders you created in the hub (see [Skills you create in the hub](#skills-you-create-in-the-hub)). |
| `skillsym watch [-a agents]` | Keep running; register and link skills you create in the hub's skills folder once changes settle for 2 seconds. See [Watch](#watch). |
| `skillsym update [skill...] [--dry-run]` | Fetch and update GitHub-tracked and git-backed skills in the hub (backs up existing copies, asks before overwriting local edits, and keeps skills removed upstream). |
| `skillsym import [--dry-run]` | Move skills found in agents' folders into the hub. |
| `skillsym import <skill...> [-a agents]` / `import -a <agents>` | Only those skills, or only copies in those agents' folders. Other agents' copies are not compared or touched. |
| `skillsym import --continue` / `--abort` | Finish or drop an open merge. |
| `skillsym remove <skill...> -a <agents>` | Unassign a skill from some agents. |
| `skillsym remove <skill...>` / `rm` | Remove a skill from every agent and from the hub (the hub copy is moved to backups; a linked library is never touched). |
| `skillsym lib` / `library` | List your libraries. Also `lib open <name>`, `lib unlink <name>` and `lib rm <name>`; see [Your own library](#your-own-library). |
| `skillsym completion <shell>` | Print the script that turns on Tab: `powershell`, `bash` or `zsh`. |
| `skillsym config` | Show the config file's location and every agent with its skills folder. |
| `skillsym config add <id> <folder>` / `config remove <id>` | Add an agent, or take one out (not while skills are assigned to it). |
| `skillsym eject [--dry-run]` | Stop using skillsym: replace every link with a real copy. |
| `skillsym eject <skill...> [-a agents]` / `eject -a <agents>` | Give back only these: their links become real copies of the latest hub version, and everything else stays managed. |
| `skillsym migrate [--dry-run]` | Migrate legacy Antigravity setups (`gemini` config/links and broad `skills.json` entries) to built-in `antigravity` `skills-json` delivery. |

Options:

`skillsym <command> -h` shows the details and examples for one command.

| Option | Meaning |
|---|---|
| `-a, --agent <ids>` | Agent ids, comma-separated or repeated; `'*'` = every installed agent. |
| `-s, --skill <name>` | Skill names (instead of positional names, or to filter `add`); `'*'` = every skill in the hub. |
| `--all` | `assign`: every skill, to every installed agent unless `-a` names some. `add`: every installed agent. `remove`, `update`: every skill. `status`, `check`: list every link. |
| `-dr, --dry-run` | Show what would change; change nothing. |
| `--only <states>` | `status`, `check`: only these statuses, comma-separated (see [Status at a glance](#status-at-a-glance)). |
| `--link` | With `add`: link to your library instead of copying it. |
| `--upstream <skill>` | With `add`: attach an upstream repo as a watched dependency of `<skill>` without modifying its files. |
| `--mark-reviewed` | With `update`: advance watched orchestrator upstream commits after inspecting their diff. |
| `-y, --yes` | Never ask. Conflicts are reported and left alone; `remove` and `eject` proceed. |
| `-g, --global` | User-level skills (the default). |
| `-p, --project` | Project-level skills — arrives in v0.2. |
| `--json` | Machine-readable output. |
| `-h, --help` | Show the commands and options. |
| `-v, --version` | Show the version. |

`add -s`, `assign`, `update`, `remove`, `eject` and `import` also take name patterns, where `*` means any characters and `?`
one. Keep the quotes: without them, bash and zsh replace `*` with the names of the files in the current folder.

```bash
npx skillsym assign 'gcp-*' -a claude
npx skillsym eject '0*' -a gemini --dry-run
```

A command refuses an option it does not act on, rather than ignoring it. If a skill name is missing or unknown, the
error suggests close names and lists the skills you can use.

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

Look at one status, then act on just those skills:

```bash
npx skillsym status --only missing,replaced
npx skillsym status 'gcp-*' -a codex --all
npx skillsym sync web-tools --dry-run
npx skillsym sync -a codex
```

## Answering questions

When `sync`, `update` or `import` needs a decision, it asks one question at a time:

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
| A skill you took out of the hub | | `status` no longer offers it; running `add --link` again brings it back |
| A skill the hub already holds | skipped | same content: the hub switches to your library, and agents keep working; different content: skipped and reported |

A library's name is its folder's name:

```bash
skillsym lib                      # list them: skills, whether they are there, whether they are in git
skillsym lib open my-skills       # open the folder
skillsym lib unlink my-skills     # stop using it but keep its skills: agents keep working on real hub copies
skillsym lib rm my-skills         # remove its skills from the hub and every agent; asks first
```

Neither `unlink` nor `rm` changes your library's files. `add --link` warns when a library is not in git.

**Snapshots.** The hub keeps the latest copy of each `--link` skill in `library-snapshots`, updated by `add --link` and
`sync`. It holds one version per skill, as of the last time one of those ran, so it is a safety net and does not
replace git. Everything stays on your machine, so keep your library in git and push it somewhere if you do not want to
lose it with this computer.

**If the library moves or disappears,** agents cannot read its skills until you act, and `status` shows them as
`source-missing`:

- Moved: run `skillsym add <new path> --link`. Every skill follows, and agents keep their assignments.
- Deleted: run `skillsym sync` in a terminal and choose `restore` to put each skill back from its snapshot, or `drop` to
  unassign it. Edits made since the last `sync` are not in the snapshot.

With `--link`, if you resolve a conflict by adopting an agent's version, or pick an agent's copy during import,
skillsym writes it **into your library** after backing up the library's version, so you can review it with `git diff`.

## GitHub and git skills

Add individual skills or whole skill repositories from GitHub (`owner/repo`, `owner/repo@ref`, or a `/tree/<ref>/<subpath>`
URL) or any git URL. skillsym caches clones under `~/.skillsym/remotes/` and copies the chosen skills into
`~/.skillsym/skills/` by default (pass `--link` to link into the remote cache instead):

```bash
skillsym add vercel-labs/skills -s find-skills -a claude,antigravity
skillsym add https://github.com/owner/repo/tree/main/skills/my-skill
```

- **Attach to existing hub skills:** running `skillsym add <repo> -s <skill>` when `<skill>` is already in your hub
  attaches upstream tracking without wiping its agent assignments.
- **Automatic origin detection:** `add`, `import` and `update` also detect online origins from `~/.agents/.skill-lock.json`
  (`npx skills`), `SKILL.md` frontmatter (`repository`), and local git `origin` remotes.
- **Explicit updates only:** `skillsym status` and `skillsym check` stay offline; run `skillsym update --dry-run` to
  check upstream and `skillsym update` to apply updates. Every updated skill is backed up to `~/.skillsym/backups/` first.
- **Local-edit safety:** if you edited a skill in `~/.skillsym/skills/` since it was synced, `skillsym update` never
  silently overwrites your changes — it asks whether to **overwrite** (backing up your edits first) or **keep** (`-y` and
  non-interactive runs keep your edits and exit `1`). Skills removed upstream are reported as missing upstream without
  deleting your local copy.
- **Local git folders:** skills added from a local git repository with an `origin` remote (or whose source folder changed
  locally) are also updated by `skillsym update`; local `.git` repos without an `origin` stay `local-only` when unchanged.
- **Orchestrator & combined skills (watch-and-diff):** for skills that adapt multiple upstreams (or archive raw skills
  under `_archive/`), `skillsym` never overwrites your adapted `SKILL.md` or `modules/`. Attach upstreams explicitly with
  `skillsym add <repo> [-s <skill>] --upstream <orchestrator>` (nested `_archive/` sub-skills with `repository:` or
  `.skill-lock.json` entries are also detected automatically, while `NOTICE.md` credits stay informational).
  `skillsym update` prints which upstream files changed plus the exact `git diff` command, then lets you confirm `[m]`
  or pass `--mark-reviewed` once merged.

## Watch

`skillsym watch` watches `<hub>/skills`. About 2 seconds after the changes stop, it registers new skill folders and
links them to the agents in `-a` or in `newSkills.agents`; it also syncs once when it starts, so skills made while it
was off are picked up. It never asks: with neither `-a` nor `newSkills.agents`, it prints
`new skill <name> not registered: set newSkills.agents in config.json or run skillsym sync` once per skill and does
nothing else. If another skillsym command holds the hub, it tries again shortly. Press Ctrl+C to stop.

To start it at login:

**Windows (Task Scheduler)**

```bat
schtasks /Create /SC ONLOGON /TN skillsym-watch /TR "npx skillsym watch"
```

**macOS (launchd)**: save as `~/Library/LaunchAgents/dev.skillsym.watch.plist`, then `launchctl load` it.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.skillsym.watch</string>
  <key>ProgramArguments</key><array><string>/usr/local/bin/npx</string><string>skillsym</string><string>watch</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
```

**Linux (systemd user unit)**: save as `~/.config/systemd/user/skillsym-watch.service`, then
enable it for your user with systemctl (`enable` and `start` on the `skillsym-watch` unit, in user mode).

```ini
[Unit]
Description=skillsym watch

[Service]
ExecStart=/usr/bin/npx skillsym watch
Restart=on-failure

[Install]
WantedBy=default.target
```

## Antigravity and `skills-json` delivery

Built-in `antigravity` uses `skills-json` delivery instead of folder junctions:

- Assigning or removing skills updates `<hub>/antigravity-skills.json` grouped by source folder (`include_only`) and
  maintains a single `inherits` entry in `~/.gemini/config/skills.json`, keeping your custom `entries` untouched.
- Both hub skills (`~/.skillsym/skills`) and `--link` library skills load directly from their real folders.
- Running `skillsym eject -a antigravity` removes the `inherits` reference and copies real skill folders into
  `~/.gemini/config/skills`.
- If you previously configured `gemini` at `~/.gemini/config/skills` or added broad folder entries to `skills.json`, run
  `skillsym migrate --dry-run` and `skillsym migrate` (or confirm during `skillsym sync`) to switch safely with backups.

## Using it with `npx skills`

[`npx skills`](https://github.com/vercel-labs/skills) and skillsym work side by side:

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

To give back only some of it, name the skills or the agents:

```bash
npx skillsym eject research -a claude   # Claude gets a real copy of research; other agents keep their links
npx skillsym eject -a codex             # every skill linked into Codex becomes a real copy there
```

The copy is the latest version in the hub, including edits made since you imported it. A skill no agent uses
afterwards leaves the hub: its hub copy moves to backups (a `--link` skill's library is never touched).

`eject` and `remove` differ in what the agent is left with: after `eject` it has a real copy and keeps working;
after `remove` it no longer has the skill.

## Privacy

skillsym collects no telemetry and makes no background network calls. `status`, `check`, `sync`, `import`, `remove`,
`eject` and `list` stay completely on your machine; `git` contacts a remote only when you explicitly run
`skillsym add <repo>` or `skillsym update`.

## Roadmap

What comes next depends on what people run into, so please [open an issue](https://github.com/HypeNeutron/skillsym/issues).
The ideas so far:

- Real copies for agents that neither read links nor support `skills.json`, kept up to date by `sync` (`antigravity` already uses `skills-json` delivery).
- Project-level skills (`-p`).
- Groups of skills, and choosing skills with the arrow keys.
- A background watcher that notices drift as it happens.

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
