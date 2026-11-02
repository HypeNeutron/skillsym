import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMMAND_HELP } from "../dist/help.js";
import { COMMAND_OPTIONS } from "../dist/main.js";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const README = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
const HELP = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8" }).stdout;

/** Commands named in the help's "Commands:" section. */
function helpCommands(): Set<string> {
  const section = HELP.split("Commands:")[1]!.split("Options:")[0]!;
  const names = new Set<string>();
  for (const line of section.split("\n")) {
    const m = /^ {2}([a-z]+)(?:, ([a-z]+))?/.exec(line);
    if (m) {
      names.add(m[1]!);
      if (m[2]) names.add(m[2]);
    }
  }
  return names;
}

/** Long options named in the help's "Options:" section. */
function helpOptions(): Set<string> {
  return new Set([...HELP.split("Options:")[1]!.matchAll(/--([a-z-]+)/g)].map((m) => m[1]!));
}

describe("each command's help", () => {
  const help = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
  const commands = Object.keys(COMMAND_HELP);

  it("exists for every command, and for every command in the main help", () => {
    for (const c of helpCommands()) {
      const name = ({ ls: "list", rm: "remove" } as Record<string, string>)[c] ?? c;
      expect(commands, c).toContain(name);
    }
    expect(new Set(Object.keys(COMMAND_OPTIONS).map((c) => ({ ls: "list", rm: "remove" } as Record<string, string>)[c] ?? c))).toEqual(new Set(commands));
  });

  it.each(Object.keys(COMMAND_OPTIONS))("%s -h documents exactly the options it accepts", (command) => {
    const r = help(command, "-h");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage: skillsym");
    // Option lines only: prose may mention another command's option ("a --link skill").
    const named = [...r.stdout.matchAll(/^ {2}(?:-[a-z], )?--([a-z][a-z-]*)/gm)].map((m) => m[1]!);
    expect(named.sort()).toEqual([...COMMAND_OPTIONS[command]!].sort());
  });

  it.each(commands)("%s examples use the command and its real options", (command) => {
    const examples = COMMAND_HELP[command]!.split("Examples:")[1] ?? "";
    expect(examples.trim(), command).not.toBe("");
    const known = helpCommands();
    for (const m of examples.matchAll(/skillsym ([a-z]+)/g)) expect(known.has(m[1]!), m[0]).toBe(true);
  });

  it("help <command>, aliases and a short -h all work; an unknown command says so", () => {
    expect(help("help", "status").stdout).toBe(help("status", "-h").stdout);
    expect(help("status", "--help").stdout).toContain("--only");
    expect(help("ls", "-h").stdout).toBe(help("list", "-h").stdout);
    expect(help("rm", "-h").stdout).toBe(help("remove", "-h").stdout);
    expect(help("help").stdout).toBe(HELP);
    expect(help("--help").stdout).toContain("skillsym <command> -h");
    expect(help("nope", "-h").status).toBe(2);
    expect(help("help", "nope").status).toBe(2);
  });

  it("does not create the hub", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "skillsym-help-"));
    const hub = path.join(dir, "hub");
    const r = spawnSync(process.execPath, [BIN, "assign", "-h"], { encoding: "utf8", env: { ...process.env, SKILLSYM_HOME: hub } });
    expect(r.status).toBe(0);
    expect(existsSync(hub)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("README matches the real CLI", () => {
  it("ssym is the same program as skillsym", () => {
    const { bin } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(bin.ssym).toBe(bin.skillsym);
    expect(README).toContain("`ssym`");
    expect(HELP).toContain("ssym");
  });

  it("every `skillsym <command>` in the README's code is a real command", () => {
    const commands = helpCommands();
    // Commands appear in code blocks and inline code; "skillsym" in prose is the product name.
    const code = [...README.matchAll(/```[\s\S]*?```|`[^`\n]+`/g)].map((m) => m[0]).join("\n");
    const used = new Set([...code.matchAll(/skillsym ([a-z]+)/g)].map((m) => m[1]!));
    const unknown = [...used].filter((c) => !commands.has(c));
    expect(unknown).toEqual([]);
    // And every command in the help is documented (aliases may appear on their own, as `ls`).
    for (const c of commands) expect(README.includes(`skillsym ${c}`) || README.includes(`\`${c}\``), c).toBe(true);
  });

  it("every --option in the README exists, and every option in the help is documented", () => {
    const options = helpOptions();
    const used = new Set([...README.matchAll(/(?<![\w-])--([a-z][a-z-]+)/g)].map((m) => m[1]!));
    const unknown = [...used].filter((o) => !options.has(o) && !["continue", "abort"].includes(o));
    expect(unknown).toEqual([]);
    for (const o of options) expect(README).toContain(`--${o}`);
  });
});
