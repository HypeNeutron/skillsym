# Changelog

## 0.1.0 — unreleased

First release: the command line tool.

### Added

- **Hub**: one folder (`~/.skillsym`, or `SKILLSYM_HOME`) holds every skill; a manifest records which agents each
  skill is assigned to, and a state file records every link skillsym created.
- **Agents**: built-in Claude Code, Codex, Cursor and the shared `~/.agents/skills` folder; add or override agents
  in the hub's `config.json`. An agent that already reads another agent's folder (Cursor) gets no second link.
- **Giving back part of it**: `eject <skill...>` and `eject -a <agents>` turn only those links into real copies of
  the latest hub version.
- **Commands**: `init`, `add`, `assign`, `list`, `status`, `check`, `sync`, `import`, `remove`, `config`, `open`, `eject`.
- **Short name**: a global install also provides `ssym`, the same command as `skillsym`.
- **Links**: junctions on Windows (no administrator rights or Developer Mode), symlinks on macOS and Linux.
- **Drift**: `status` / `check` show what needs attention and a count (`--all` lists every link); they classify every link (synced, covered, missing, dangling, replaced, blocked,
  orphaned, duplicate, source-missing) and list unmanaged skills; `sync` repairs what it can and asks about the rest
  (adopt, restore, fork, drop).
- **Choosing**: `import` and `eject` take skill names and `-a`; `list -a` shows one agent's skills. Names may be patterns
  (`'gcp-*'`). A command refuses an option it does not act on.
- **Import**: brings skills already in agents' folders into the hub; identical copies merge automatically, and for
  copies that differ you keep one, keep both, or merge with git-style markers (`import --continue` / `--abort`).
- **Your own library**: `add <folder>` copies every skill in a folder of skills; `add <folder> --link` links to it so
  the library stays the source of truth (re-run to add new skills or follow a moved library).
- **Safety**: backups before every overwrite; never touches files skillsym did not create (including those of
  `npx skills`); warns when the hub or a library is in a cloud-synced folder; warns about `SKILL.md` files with a BOM.
- **Prompts**: Enter skips, `q` skips the rest, Ctrl+C cancels without applying any answer; `-y` never asks.
- `--dry-run` for every command that changes files, `--json` everywhere, exit codes 0 / 1 / 2.
- No network calls, no telemetry.

### Known limitations

- Tested with Claude Code, Codex and Cursor on Windows. On macOS and Linux the link handling is tested in CI, but
  not yet with the agents themselves; reports are welcome.
- Cursor loads skills only when it starts: restart it after changing a skill.
- User-level skills only; project-level skills (`-p`) arrive in v0.2.
