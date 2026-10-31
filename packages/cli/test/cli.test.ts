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

/** Agents' folders resolve from the user's home dir, so point it at the temp dir too. */
function env() {
  const userHome = path.join(root, "user");
  return { ...process.env, SKILLSYM_HOME: home, HOME: userHome, USERPROFILE: userHome };
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

  it("assign links a skill and list shows the agent", async () => {
    run(["add", await makeSkill(path.join(root, "src"), "coding")]);
    const r = run(["assign", "coding", "-a", "claude", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).assigned).toEqual([
      { skill: "coding", agents: ["claude"], path: path.join(root, "user", ".claude", "skills", "coding"), outcome: "linked" },
    ]);
    expect(JSON.parse(run(["ls", "--json"]).stdout).skills[0].agents).toEqual(["claude"]);
  });

  it("add -a adds and assigns in one step", async () => {
    const r = run(["add", await makeSkill(path.join(root, "src"), "coding"), "-a", "claude", "-a", "cursor", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).assigned.map((x: { agents: string[] }) => x.agents[0])).toEqual(["claude", "cursor"]);
  });

  it("assign exits 1 when a target path is occupied", async () => {
    run(["add", await makeSkill(path.join(root, "src"), "coding")]);
    await makeSkill(path.join(root, "user", ".claude", "skills"), "coding");
    const r = run(["assign", "coding", "-a", "claude", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).assigned[0].outcome).toBe("blocked");
  });

  it("assign without agents is a usage error", async () => {
    run(["add", await makeSkill(path.join(root, "src"), "coding")]);
    expect(run(["assign", "coding"]).code).toBe(2);
  });

  it("--all assigns every skill to every installed agent", async () => {
    await fs.mkdir(path.join(root, "user", ".claude"), { recursive: true });
    run(["add", await makeSkill(path.join(root, "src"), "a")]);
    run(["add", await makeSkill(path.join(root, "src"), "b")]);
    const r = run(["assign", "--all", "--json"]);
    expect(r.code).toBe(0);
    const pairs = JSON.parse(r.stdout).assigned.map((x: { skill: string; agents: string[] }) => `${x.skill}:${x.agents.join("+")}`);
    expect(pairs).toEqual(["a:claude", "a:universal", "b:claude", "b:universal"]);
  });

  it("check exits 0 when synced and 1 on drift; status always exits 0", async () => {
    run(["add", await makeSkill(path.join(root, "src"), "coding"), "-a", "claude"]);
    expect(run(["check"]).code).toBe(0);

    const link = path.join(root, "user", ".claude", "skills", "coding");
    try {
      await fs.unlink(link);
    } catch {
      await fs.rmdir(link);
    }

    const check = run(["check", "--json"]);
    expect(check.code).toBe(1);
    const report = JSON.parse(check.stdout);
    expect(report.clean).toBe(false);
    expect(report.entries[0]).toMatchObject({ skill: "coding", status: "missing" });

    const status = run(["status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("MISSING");
    expect(status.stdout).toContain("Drift found");
  });

  it("sync fixes what it can, --dry-run previews, conflicts exit 1", async () => {
    run(["add", await makeSkill(path.join(root, "src"), "coding"), "-a", "claude"]);
    const movedHome = path.join(root, "hub-moved");
    await fs.rename(home, movedHome);
    home = movedHome;

    const preview = run(["sync", "--dry-run", "--json"]);
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.stdout).actions.map((a: { type: string }) => a.type)).toEqual(["relink"]);
    expect(run(["check"]).code).toBe(1);

    const applied = run(["sync"]);
    expect(applied.code).toBe(0);
    expect(applied.stdout).toContain("re-linked");
    expect(run(["check"]).code).toBe(0);
    expect(run(["sync"]).stdout).toBe("Already in sync.");

    // Our link deleted by someone else: sync reports it and does not recreate it.
    const link = path.join(root, "user", ".claude", "skills", "coding");
    try {
      await fs.unlink(link);
    } catch {
      await fs.rmdir(link);
    }
    const conflict = run(["sync", "--json"]);
    expect(conflict.code).toBe(1);
    expect(JSON.parse(conflict.stdout).conflicts[0].type).toBe("missing-owned");
    await expect(fs.lstat(link)).rejects.toThrow();
  });

  it("remove -a unassigns; full remove needs -y without a terminal", async () => {
    run(["add", await makeSkill(path.join(root, "src"), "coding"), "-a", "claude,codex"]);

    const partial = run(["remove", "coding", "-a", "codex", "--json"]);
    expect(partial.code).toBe(0);
    expect(JSON.parse(partial.stdout).links[0].outcome).toBe("unlinked");

    const refused = run(["rm", "coding"]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("-y");
    expect(JSON.parse(run(["ls", "--json"]).stdout).skills.map((s: { name: string }) => s.name)).toEqual(["coding"]);

    const removed = run(["rm", "coding", "-y", "--json"]);
    expect(removed.code).toBe(0);
    expect(JSON.parse(removed.stdout).removedSkills[0].skill).toBe("coding");
    expect(JSON.parse(run(["ls", "--json"]).stdout).skills).toEqual([]);
  });

  it("uses custom agents from config.json, and a broken config stops every command", async () => {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, "config.json"), JSON.stringify({ version: 1, agents: [{ id: "windsurf", skillsDir: "~/.windsurf/skills" }] }));
    const r = run(["add", await makeSkill(path.join(root, "src"), "coding"), "-a", "windsurf", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).assigned[0].path).toBe(path.join(root, "user", ".windsurf", "skills", "coding"));

    await fs.writeFile(path.join(home, "config.json"), "{ broken");
    const broken = run(["status", "--json"]);
    expect(broken.code).toBe(2);
    expect(JSON.parse(broken.stdout).error.code).toBe("CONFIG_INVALID");
  });

  it("import brings existing skills in; differing copies exit 1", async () => {
    const claudeSkills = path.join(root, "user", ".claude", "skills");
    await makeSkill(claudeSkills, "research");

    const preview = run(["import", "--dry-run", "--json"]);
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.stdout).items[0]).toMatchObject({ name: "research", type: "import" });

    const done = run(["import"]);
    expect(done.code).toBe(0);
    expect(done.stdout).toContain("imported  research from claude");
    expect(run(["check"]).code).toBe(0);

    await makeSkill(claudeSkills, "coding", { "a.md": "1" });
    await makeSkill(path.join(root, "user", ".agents", "skills"), "coding", { "a.md": "2" });
    const conflict = run(["import"]);
    expect(conflict.code).toBe(1);
    expect(conflict.stdout).toContain("CONFLICT  coding");
  });

  it("eject needs -y without a terminal, then leaves real copies and says the hub can go", async () => {
    run(["add", await makeSkill(path.join(root, "src"), "coding"), "-a", "claude"]);
    const link = path.join(root, "user", ".claude", "skills", "coding");

    const refused = run(["eject"]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("--dry-run");
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);

    const preview = run(["eject", "--dry-run"]);
    expect(preview.code).toBe(0);
    expect(preview.stdout).toContain("Nothing was changed");

    const done = run(["eject", "-y"]);
    expect(done.code).toBe(0);
    expect(done.stdout).toContain("no longer depend on skillsym");
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(false);
  });

  it("init creates a template in the current folder, says what to do next, and leaves the hub alone", async () => {
    const work = path.join(root, "work");
    await fs.mkdir(work);
    const r = spawnSync(process.execPath, [BIN, "init", "my-skill"], { encoding: "utf8", env: env(), cwd: work });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("skillsym add my-skill -a");
    expect((await fs.readFile(path.join(work, "my-skill", "SKILL.md"), "utf8")).startsWith("---\nname: my-skill\n")).toBe(true);
    await expect(fs.stat(home)).rejects.toThrow();

    const again = spawnSync(process.execPath, [BIN, "init", "my-skill"], { encoding: "utf8", env: env(), cwd: work });
    expect(again.status).toBe(2);
  });

  it("add <library> previews with --dry-run, then copies every skill and assigns them", async () => {
    const lib = path.join(root, "my-skills");
    await makeSkill(lib, "coding");
    await makeSkill(path.join(lib, "writing"), "blog-post");

    const preview = run(["add", lib, "--dry-run"]);
    expect(preview.code).toBe(0);
    expect(preview.stdout).toContain("Would add 2 skill(s)");
    expect(preview.stdout).toContain("Nothing was changed");

    const done = run(["add", lib, "-a", "claude", "--json"]);
    expect(done.code).toBe(0);
    const out = JSON.parse(done.stdout);
    expect(out.added.map((s: { name: string }) => s.name).sort()).toEqual(["blog-post", "coding"]);
    expect(out.assigned.map((r: { outcome: string }) => r.outcome)).toEqual(["linked", "linked"]);

    const text = run(["add", lib]);
    expect(text.code).toBe(1);
    expect(text.stdout).toContain("already in the hub");
  });

  it("add --link links the library, list shows it, and status points out new skills in it", async () => {
    const lib = path.join(root, "my-skills");
    await makeSkill(lib, "coding");
    const r = run(["add", lib, "--link", "-a", "claude"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("linked to the library");
    expect(r.stdout).toContain("Your library stays the source of truth");
    expect(run(["ls"]).stdout).toContain(`[linked from ${path.join(lib, "coding")}]`);

    await makeSkill(lib, "fresh");
    const status = run(["status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain(`new in library ${lib}: fresh`);

    const again = run(["add", lib, "--link", "--json"]);
    expect(JSON.parse(again.stdout).items.map((i: { type: string }) => i.type).sort()).toEqual(["add", "unchanged"]);
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
