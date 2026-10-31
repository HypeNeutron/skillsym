import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

describe("README matches the real CLI", () => {
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
