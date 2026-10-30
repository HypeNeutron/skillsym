# skillsym

Keep every coding agent's skills in one hub, linked into Claude Code, Codex, Cursor and others, and checked for drift.

> Status: pre-release (v0.1 in progress). Only `add` and `list` work so far.

```bash
npx skillsym add ./my-skill
npx skillsym list
```

- The hub lives in `~/.skillsym` (override with `SKILLSYM_HOME`).
- Every command accepts `--json`. Exit codes: `0` success, `1` drift, `2` error.
- No telemetry, no network calls.

## Development

```bash
pnpm install
pnpm test
```

Tests run against a real filesystem in a temp directory, on Windows, macOS and Linux in CI.

## License

MIT
