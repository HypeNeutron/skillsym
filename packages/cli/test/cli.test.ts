import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeSkill, makeTempDir, removeDir } from "../../core/test/helpers.js";

// Runs the built binary, so `pnpm test` builds first.
const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));

let root: string;
let home: string;

beforeEach(async () => {
  root = await makeTempDir("skillsym-cli-");
  home = path.join(root, "hub");
});

afterEach(async () => {
  await removeDir(root);
});

function env() {
  return { ...process.env, SKILLSYM_HOME: home };
}

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: env() });
  return { code: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

function runAsync(args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: env() });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", (code) => resolve({ code, stdout: stdout.trim() }));
  });
}

describe("skillsym CLI", () => {
  it("creates the hub on first run and lists nothing", () => {
    const r = run(["list", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ skills: [] });
  });

  it("add then list shows the skill (ls alias too)", async () => {
    const src = await makeSkill(path.join(root, "src"), "coding");
    const added = run(["add", src, "--json"]);
    expect(added.code).toBe(0);
    expect(JSON.parse(added.stdout).added.name).toBe("coding");

    for (const cmd of ["list", "ls"]) {
      const r = run([cmd, "--json"]);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout).skills.map((s: { name: string }) => s.name)).toEqual(["coding"]);
    }
  });

  it("prints human-readable output without --json", async () => {
    const src = await makeSkill(path.join(root, "src"), "coding");
    expect(run(["add", src]).stdout).toContain('Added "coding"');
    expect(run(["list"]).stdout).toMatch(/coding\s+\(not assigned\)/);
  });

  it("reports a missing SKILL.md as JSON with exit code 2", async () => {
    const dir = path.join(root, "empty");
    await fs.mkdir(dir, { recursive: true });
    const r = run(["add", dir, "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).error.code).toBe("MISSING_SKILL_MD");
  });

  it("exits 2 on unknown commands and flags", () => {
    expect(run(["frobnicate"]).code).toBe(2);
    const r = run(["list", "--nope", "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).error.code).toBe("USAGE");
  });

  it("prints the version", () => {
    const r = run(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("serializes concurrent adds from separate processes", async () => {
    const names = ["a1", "a2", "a3", "a4"];
    const srcs = await Promise.all(names.map((n) => makeSkill(path.join(root, "src"), n)));
    const results = await Promise.all(srcs.map((s) => runAsync(["add", s, "--json"])));
    expect(results.map((r) => r.code)).toEqual([0, 0, 0, 0]);
    const listed = JSON.parse(run(["list", "--json"]).stdout).skills.map((s: { name: string }) => s.name);
    expect(listed).toEqual(names);
  });
});
