import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeSkill, makeTempDir, removeDir } from "../../core/test/helpers.js";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));

let root: string;
let home: string;
let user: string;

const env = (extra: Record<string, string> = {}) => ({ ...process.env, SKILLSYM_HOME: home, HOME: user, USERPROFILE: user, ...extra });
const run = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: env() });
/** Candidates for `words...` with the last word being typed, as the shell scripts ask. */
const tab = (...words: string[]) => {
  const current = words.pop()!;
  const r = run("__complete", `=${current}`, ...words);
  expect(r.status).toBe(0);
  expect(r.stderr).toBe("");
  return r.stdout.split(/\r?\n/).filter(Boolean);
};

beforeEach(async () => {
  root = await makeTempDir("skillsym-tab-");
  home = path.join(root, "hub");
  user = path.join(root, "user");
  await fs.mkdir(path.join(user, ".claude"), { recursive: true });
});

afterEach(async () => {
  await removeDir(root);
});

async function withSkills() {
  for (const n of ["web-tools", "web-search", "plan-pipeline"]) run("add", await makeSkill(path.join(root, "src"), n));
  await makeSkill(path.join(user, ".claude", "skills"), "waiting");
}

describe("what Tab offers", () => {
  it("offers commands, and options that fit the command", async () => {
    expect(tab("sy")).toEqual(["sync"]);
    expect(tab("")).toEqual(expect.arrayContaining(["assign", "completion", "eject", "help", "status"]));
    expect(tab("--v")).toEqual(["--version"]);
    expect(tab("status", "--o")).toEqual(["--only"]);
    expect(tab("status", "--")).toEqual(expect.arrayContaining(["--all", "--agent", "--json", "--help"]));
    expect(tab("sync", "--li")).toEqual([]);
    expect(tab("add", "--li")).toEqual(["--link"]);
    expect(tab("completion", "p")).toEqual(["powershell"]);
    expect(tab("help", "st")).toEqual(["status"]);
    expect(tab("config", "")).toEqual(["add", "remove"]);
  });

  it("offers hub skills to commands that act on them, and what can be imported to import", async () => {
    await withSkills();
    for (const command of ["open", "assign", "remove", "rm", "eject", "sync"]) {
      expect(tab(command, "web-").sort(), command).toEqual(["web-search", "web-tools"]);
    }
    expect(tab("open", "WE").sort()).toEqual(["web-search", "web-tools"]);
    expect(tab("import", "")).toEqual(["waiting"]);
    expect(tab("status", "w").sort()).toEqual(["waiting", "web-search", "web-tools"]);
    expect(tab("assign", "--skill", "pl")).toEqual(["plan-pipeline"]);
    expect(tab("eject", "-s", "pl")).toEqual(["plan-pipeline"]);
    expect(tab("open", "'pl")).toEqual(["plan-pipeline"]);
  });

  it("does not offer a skill twice, or a second one to a command that takes one", async () => {
    await withSkills();
    expect(tab("assign", "web-tools", "web-")).toEqual(["web-search"]);
    expect(tab("open", "web-tools", "")).toEqual([]);
  });

  it("offers agents after -a, including your own, and after a comma", async () => {
    run("config", "add", "windsurf", "~/.windsurf/skills");
    expect(tab("assign", "x", "-a", "c")).toEqual(["claude", "codex", "cursor"]);
    expect(tab("assign", "x", "--agent", "wind")).toEqual(["windsurf"]);
    expect(tab("assign", "x", "-a", "claude,c")).toEqual(["claude,codex", "claude,cursor"]);
    expect(tab("config", "remove", "")).toEqual(["windsurf"]);
  });

  it("offers statuses after --only, and after a comma", () => {
    expect(tab("status", "--only", "m")).toEqual(["missing"]);
    expect(tab("status", "--only", "missing,r")).toEqual(["missing,replaced"]);
  });

  it("offers lib's actions and library names", async () => {
    expect(tab("li")).toEqual(expect.arrayContaining(["lib", "library", "list"]));
    expect(tab("lib", "")).toEqual(["open", "unlink", "rm"]);
    const lib = path.join(root, "my-skills");
    await makeSkill(lib, "one");
    run("add", lib, "--link");
    expect(tab("lib", "open", "my")).toEqual(["my-skills"]);
    expect(tab("library", "rm", "")).toEqual(["my-skills"]);
    expect(tab("lib", "open", "my-skills", "")).toEqual([]);
  });

  it("leaves add's path and init's name to the shell", async () => {
    await withSkills();
    expect(tab("add", "web")).toEqual([]);
    expect(tab("init", "")).toEqual([]);
  });

  it("stays silent and creates nothing with no hub, or with a broken config", async () => {
    expect(tab("open", "")).toEqual([]);
    await expect(fs.access(home)).rejects.toThrow();

    await fs.mkdir(home);
    await fs.writeFile(path.join(home, "config.json"), "{ broken");
    expect(tab("assign", "x", "-a", "")).toEqual([]);
  });
});

describe("skillsym completion", () => {
  it("prints a script for each shell, naming both commands, and refuses others", () => {
    for (const shell of ["powershell", "bash", "zsh"]) {
      const r = run("completion", shell);
      expect(r.status, shell).toBe(0);
      expect(r.stdout).toContain("skillsym __complete");
      expect(r.stdout).toContain("ssym");
    }
    expect(run("completion").status).toBe(2);
    expect(run("completion", "fish").status).toBe(2);
    expect(run("completion", "bash", "--link").status).toBe(2);
    expect(run("completion", "bash").stdout).not.toContain("\r");
  });
});

/** A `skillsym` on PATH for the shell scripts to call, wherever the test runs. */
async function shimDir(): Promise<string> {
  const bin = path.join(root, "bin");
  await fs.mkdir(bin);
  if (process.platform === "win32") {
    await fs.writeFile(path.join(bin, "skillsym.cmd"), `@"${process.execPath}" "${BIN}" %*\r\n`);
  }
  await fs.writeFile(path.join(bin, "skillsym"), `#!/bin/sh\nexec "${process.execPath.replace(/\\/g, "/")}" "${BIN.replace(/\\/g, "/")}" "$@"\n`, { mode: 0o755 });
  return bin;
}
const has = (shell: string, flag: string) => spawnSync(shell, [flag, "exit 0"], { encoding: "utf8" }).status === 0;

describe("in a real shell", () => {
  it.skipIf(process.platform !== "win32")("PowerShell completes through TabExpansion2", async () => {
    await withSkills();
    const bin = await shimDir();
    const script = path.join(root, "tab.ps1");
    await fs.writeFile(
      script,
      [
        "$ErrorActionPreference = 'Stop'",
        "skillsym completion powershell | Out-String | Invoke-Expression",
        "foreach ($line in @('ssym open web-t', 'skillsym import ', 'ssym assign x -a cl')) {",
        "  $r = TabExpansion2 $line $line.Length",
        "  ($r.CompletionMatches | ForEach-Object { $_.CompletionText }) -join ','",
        "}",
      ].join("\r\n"),
    );
    const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
      encoding: "utf8",
      env: env({ PATH: `${bin}${path.delimiter}${process.env.PATH}` }),
    });
    expect(r.stderr).toBe("");
    expect(r.stdout.split(/\r?\n/).filter(Boolean)).toEqual(["web-tools", "waiting", "claude"]);
  }, 60_000);

  it.skipIf(!has("bash", "-c") || process.platform === "win32")("bash fills COMPREPLY", async () => {
    await withSkills();
    const bin = await shimDir();
    const script = [
      'eval "$(skillsym completion bash)"',
      'COMP_WORDS=(ssym open web-t); COMP_CWORD=2; _skillsym_complete; echo "${COMPREPLY[*]}"',
      'COMP_WORDS=(ssym import ""); COMP_CWORD=2; _skillsym_complete; echo "${COMPREPLY[*]}"',
      "complete -p ssym",
    ].join("\n");
    const r = spawnSync("bash", ["-c", script], { encoding: "utf8", env: env({ PATH: `${bin}${path.delimiter}${process.env.PATH}` }) });
    expect(r.stderr).toBe("");
    expect(r.stdout.split("\n").slice(0, 2)).toEqual(["web-tools", "waiting"]);
    expect(r.stdout).toContain("_skillsym_complete");
  });

  it.skipIf(!has("zsh", "-c"))("the zsh script parses", () => {
    const r = spawnSync("zsh", ["-n"], { input: run("completion", "zsh").stdout, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });
});
