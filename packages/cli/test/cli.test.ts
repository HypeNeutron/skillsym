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

async function removeDirLink(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch {
    await fs.rmdir(p);
  }
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
    // Our own link was removed: say what sync really does (it asks), not "will link it".
    expect(status.stdout).toContain("`skillsym sync` will ask whether to restore it");
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

  it("creates a starter config once and never overwrites it; config lists every agent", async () => {
    const file = path.join(home, "config.json");
    expect(run(["config"]).stdout).toContain("not created yet");
    await expect(fs.access(file)).rejects.toThrow();

    expect(run(["add", await makeSkill(path.join(root, "src"), "coding")]).code).toBe(0);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ version: 1, agents: [] });

    const custom = JSON.stringify({ version: 1, agents: [{ id: "windsurf", skillsDir: "~/.windsurf/skills" }] });
    await fs.writeFile(file, custom);
    run(["add", await makeSkill(path.join(root, "src"), "other")]);
    expect(await fs.readFile(file, "utf8")).toBe(custom);

    const report = JSON.parse(run(["config", "--json"]).stdout);
    expect(report).toMatchObject({ configPath: file, exists: true });
    expect(report.agents.find((a: { id: string }) => a.id === "claude").source).toBe("built-in");
    expect(report.agents.find((a: { id: string }) => a.id === "windsurf")).toMatchObject({
      source: "config",
      skillsDir: path.join(root, "user", ".windsurf", "skills"),
    });
    expect(run(["config", "extra"]).code).toBe(2);
    expect(run(["config", "add"]).code).toBe(2);
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

  it("assign, eject, remove and import take name patterns; one that matches nothing changes nothing", async () => {
    for (const n of ["gcp-spark", "gcp-dataflow", "dbt", "a.b"]) run(["add", await makeSkill(path.join(root, "src"), n)]);
    const agentsOf = async (name: string) => {
      const skills = JSON.parse(run(["list", "--json"]).stdout).skills as { name: string; agents: string[] }[];
      return skills.find((s) => s.name === name)?.agents;
    };

    expect(run(["assign", "gcp-*", "-a", "claude"]).code).toBe(0);
    expect(await agentsOf("gcp-spark")).toEqual(["claude"]);
    expect(await agentsOf("gcp-dataflow")).toEqual(["claude"]);
    expect(await agentsOf("dbt")).toEqual([]);

    // "." is literal and "?" is one character.
    expect(run(["assign", "a?b", "-a", "claude"]).code).toBe(0);
    expect(await agentsOf("a.b")).toEqual(["claude"]);
    expect(run(["assign", "a.?", "dbt", "-a", "codex"]).code).toBe(0);
    expect(await agentsOf("dbt")).toEqual(["codex"]);
    expect(run(["assign", "gcp.spark", "-a", "codex"]).code).toBe(2);

    const none = run(["assign", "nope-*", "-a", "claude"]);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain('No skill matches "nope-*"');

    const claudeLink = path.join(root, "user", ".claude", "skills", "gcp-spark");
    expect(run(["eject", "gcp-*", "-a", "claude", "--dry-run"]).stdout).toContain("gcp-spark");
    expect((await fs.lstat(claudeLink)).isSymbolicLink()).toBe(true);
    expect(run(["eject", "gcp-s*", "-a", "claude", "-y"]).code).toBe(0);
    expect((await fs.lstat(claudeLink)).isSymbolicLink()).toBe(false);

    expect(run(["remove", "gcp-d*", "-y"]).code).toBe(0);
    expect(await agentsOf("gcp-dataflow")).toBeUndefined();
    expect(await agentsOf("dbt")).toEqual(["codex"]);
  });

  it("import patterns match only what the chosen agents hold", async () => {
    const claudeDir = path.join(root, "user", ".claude", "skills");
    await makeSkill(claudeDir, "gcp-spark");
    await makeSkill(claudeDir, "gcp-flow");
    await makeSkill(claudeDir, "dbt");

    expect(run(["import", "gcp-*", "-a", "codex"]).code).toBe(2);
    expect(run(["import", "gcp-s*"]).code).toBe(0);
    expect((await fs.lstat(path.join(claudeDir, "gcp-spark"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(claudeDir, "gcp-flow"))).isSymbolicLink()).toBe(false);
    expect((await fs.lstat(path.join(claudeDir, "dbt"))).isSymbolicLink()).toBe(false);
  });

  it("refuses an option the command does not act on, changing nothing", async () => {
    run(["add", await makeSkill(path.join(root, "src"), "coding"), "-a", "claude"]);
    for (const args of [["sync", "--link"], ["status", "--dry-run"], ["list", "--link"], ["eject", "--all"], ["config", "-y"]]) {
      const r = run(args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.stderr).toContain(`does not take --`);
    }
    expect(run(["check"]).code).toBe(0);
    expect(run(["add", await makeSkill(path.join(root, "src"), "other"), "-y"]).code).toBe(0);
  });

  it("status shows what needs attention and a count; --all lists every link; --json stays complete", async () => {
    run(["add", await makeSkill(path.join(root, "src"), "coding"), "-a", "claude"]);
    run(["add", await makeSkill(path.join(root, "src"), "other"), "-a", "claude"]);
    const quiet = run(["status"]).stdout;
    expect(quiet).not.toContain("coding");
    expect(quiet).toContain("2 synced.");
    expect(quiet).toContain("status --all");
    expect(run(["status", "--all"]).stdout).toContain("coding -> claude");
    expect(JSON.parse(run(["status", "--json"]).stdout).entries).toHaveLength(2);

    await removeDirLink(path.join(root, "user", ".claude", "skills", "other"));
    const drift = run(["status"]).stdout;
    expect(drift).toContain("MISSING (1)");
    expect(drift).toContain("other -> claude");
    expect(drift).not.toContain("coding");
  });

  it("status groups by state and narrows by status, skill and agent", async () => {
    for (const n of ["coding", "gcp-a", "gcp-b"]) run(["add", await makeSkill(path.join(root, "src"), n), "-a", "claude,codex"]);
    await removeDirLink(path.join(root, "user", ".claude", "skills", "gcp-a"));
    await removeDirLink(path.join(root, "user", ".claude", "skills", "gcp-b"));
    await makeSkill(path.join(root, "user", ".claude", "skills"), "stray");

    const all = run(["status", "--all"]).stdout;
    expect(all.indexOf("synced (4)")).toBeLessThan(all.indexOf("MISSING (2)"));
    expect(all.indexOf("MISSING (2)")).toBeLessThan(all.indexOf("unmanaged (1)"));
    // Advice shared by the whole group reads once.
    expect(all.split("will ask whether to restore it").length).toBe(2);

    const entries = (args: string[]) => JSON.parse(run([...args, "--json"]).stdout).entries as { skill: string; agents: string[]; status: string }[];
    expect(entries(["status", "--only", "missing"]).map((e) => e.skill)).toEqual(["gcp-a", "gcp-b"]);
    const synced = run(["status", "--only", "synced"]).stdout;
    expect(synced).toContain("synced (4)");
    expect(synced).not.toContain("MISSING");
    expect(synced).not.toContain("stray");
    expect(run(["status", "--only", "unmanaged"]).stdout).toContain("stray");
    expect(run(["status"]).stdout).not.toContain("stray");
    expect(run(["status", "--only", "synced,MISSING"]).stdout).toContain("MISSING (2)");
    expect(run(["status", "--only", "nope"]).code).toBe(2);

    expect(new Set(entries(["status", "gcp-*"]).map((e) => e.skill))).toEqual(new Set(["gcp-a", "gcp-b"]));
    expect(entries(["status", "-a", "codex"]).every((e) => e.agents.includes("codex"))).toBe(true);
    expect(entries(["status", "gcp-a", "-a", "claude"]).map((e) => e.status)).toEqual(["missing"]);
    expect(run(["status", "nope"]).code).toBe(2);
    expect(run(["status", "--only", "dangling"]).stdout).toContain("Nothing matches");

    // --all still means "every link" here, never "every agent".
    expect(entries(["status", "--all"]).length).toBe(6);

    // check answers for what was asked about.
    expect(run(["check"]).code).toBe(1);
    expect(run(["check", "coding"]).code).toBe(0);
    expect(run(["check", "gcp-a"]).code).toBe(1);
    expect(run(["check", "-a", "codex"]).code).toBe(0);
  });

  it("status gives unmanaged skills as a count per folder; --only unmanaged, --all and names list them", async () => {
    const claudeDir = path.join(root, "user", ".claude", "skills");
    const codexDir = path.join(root, "user", ".agents", "skills");
    for (const n of ["u-one", "u-two"]) await makeSkill(claudeDir, n);
    await makeSkill(codexDir, "u-three");

    const short = run(["status"]).stdout;
    expect(short).toContain("unmanaged (3)");
    expect(short).toContain(`2 in ${claudeDir} (claude)`);
    expect(short).toContain(`1 in ${codexDir} (`);
    expect(short).toContain("skillsym status --only unmanaged");
    expect(short.split(claudeDir).length).toBe(2);
    expect(short).not.toContain("u-one");

    for (const args of [["status", "--only", "unmanaged"], ["status", "--all"], ["status", "u-*"]]) {
      const long = run(args).stdout;
      expect(long, args.join(" ")).toContain("u-one");
      expect(long.split(claudeDir).length).toBe(2);
    }
    expect(JSON.parse(run(["status", "--json"]).stdout).unmanaged).toHaveLength(3);
  });

  it("config add and remove change only the agents list, and the agent is usable at once", async () => {
    const file = path.join(home, "config.json");
    const added = run(["config", "add", "windsurf", "~/.windsurf/skills"]);
    expect(added.code).toBe(0);
    expect(added.stdout).toContain("import -a windsurf");
    expect(JSON.parse(await fs.readFile(file, "utf8")).agents).toEqual([{ id: "windsurf", skillsDir: "~/.windsurf/skills" }]);

    const report = JSON.parse(run(["config", "--json"]).stdout);
    expect(report.agents.find((a: { id: string }) => a.id === "windsurf").skillsDir).toBe(path.join(root, "user", ".windsurf", "skills"));

    // Other fields in the file stay.
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    await fs.writeFile(file, JSON.stringify({ ...raw, future: 1 }));
    expect(run(["config", "add", "other", path.join(root, "elsewhere")]).code).toBe(0);
    const after = JSON.parse(await fs.readFile(file, "utf8"));
    expect(after.future).toBe(1);
    expect(after.agents[1]).toEqual({ id: "other", skillsDir: path.join(root, "elsewhere") });

    expect(run(["config", "add", "windsurf", "~/x"]).code).toBe(2);
    expect(run(["config", "add", "claude", "~/x"]).stderr).toContain("built-in");
    expect(run(["config", "add", "bad id", "~/x"]).code).toBe(2);
    expect(run(["config", "add", "only-id"]).code).toBe(2);
    expect(run(["config", "nope"]).code).toBe(2);

    // In use: refused, with what to do; afterwards the agent's files stay.
    run(["add", await makeSkill(path.join(root, "src"), "coding"), "-a", "windsurf"]);
    const inUse = run(["config", "remove", "windsurf"]);
    expect(inUse.code).toBe(2);
    expect(inUse.stderr).toContain("eject -a windsurf");
    expect(run(["eject", "-a", "windsurf", "-y"]).code).toBe(0);
    expect(run(["config", "remove", "windsurf"]).code).toBe(0);
    await fs.access(path.join(root, "user", ".windsurf", "skills", "coding", "SKILL.md"));
    expect(JSON.parse(await fs.readFile(file, "utf8")).agents.map((a: { id: string }) => a.id)).toEqual(["other"]);

    expect(run(["config", "remove", "claude"]).stderr).toContain("built-in");
    expect(run(["config", "remove", "nope"]).code).toBe(2);
  });

  it("config add makes a relative folder absolute, from where you are", async () => {
    const work = path.join(root, "work");
    await fs.mkdir(work);
    const r = spawnSync(process.execPath, [BIN, "config", "add", "here", "skills"], { encoding: "utf8", env: env(), cwd: work });
    expect(r.status).toBe(0);
    expect(JSON.parse(await fs.readFile(path.join(home, "config.json"), "utf8")).agents[0].skillsDir).toBe(path.join(await fs.realpath(work), "skills"));
  });

  it("sync acts only on the skills and agents named", async () => {
    run(["add", await makeSkill(path.join(root, "src"), "coding"), "-a", "claude,codex"]);
    run(["add", await makeSkill(path.join(root, "src"), "other"), "-a", "claude"]);
    const movedHome = path.join(root, "hub-moved");
    await fs.rename(home, movedHome);
    home = movedHome;
    const dangling = () => JSON.parse(run(["status", "--only", "dangling", "--json"]).stdout).entries.map((e: { skill: string; agents: string[] }) => `${e.skill}:${e.agents[0]}`);
    expect(dangling()).toEqual(["coding:claude", "coding:codex", "other:claude"]);

    const preview = JSON.parse(run(["sync", "other", "--dry-run", "--json"]).stdout);
    expect(preview.actions).toMatchObject([{ type: "relink", skill: "other" }]);
    expect(dangling()).toHaveLength(3);

    expect(run(["sync", "other"]).code).toBe(0);
    expect(dangling()).toEqual(["coding:claude", "coding:codex"]);
    expect(run(["sync", "-a", "codex"]).code).toBe(0);
    expect(dangling()).toEqual(["coding:claude"]);
    expect(run(["sync", "c*", "-a", "claude"]).code).toBe(0);
    expect(dangling()).toEqual([]);
    expect(run(["sync", "nope"]).code).toBe(2);
    expect(run(["sync", "nope-*"]).code).toBe(2);
  });

  it("selective sync reports only the conflicts it was asked about", async () => {
    run(["add", await makeSkill(path.join(root, "src"), "coding"), "-a", "claude"]);
    run(["add", await makeSkill(path.join(root, "src"), "other"), "-a", "claude"]);
    await removeDirLink(path.join(root, "user", ".claude", "skills", "other"));

    expect(run(["sync", "coding"]).code).toBe(0);
    const asked = run(["sync", "other", "--json"]);
    expect(asked.code).toBe(1);
    expect(JSON.parse(asked.stdout).conflicts).toMatchObject([{ skill: "other", type: "missing-owned" }]);
  });

  it("list -a shows one agent's skills", async () => {
    run(["add", await makeSkill(path.join(root, "src"), "coding"), "-a", "claude"]);
    run(["add", await makeSkill(path.join(root, "src"), "other"), "-a", "codex"]);
    const names = (args: string[]) => JSON.parse(run(args).stdout).skills.map((s: { name: string }) => s.name);
    expect(names(["list", "--json"])).toEqual(["coding", "other"]);
    expect(names(["list", "-a", "codex", "--json"])).toEqual(["other"]);
    expect(run(["list", "-a", "universal"]).stdout).toContain("No skills assigned to universal");
    expect(run(["list", "-a", "nope"]).code).toBe(2);
  });

  it("open prints the skill's folder without a terminal, and the library for a --link skill", async () => {
    run(["add", await makeSkill(path.join(root, "src"), "coding")]);
    expect(run(["open", "coding"]).stdout.trim()).toBe(path.join(home, "skills", "coding"));
    expect(run(["open", "nope"]).code).toBe(2);
    expect(run(["open"]).code).toBe(2);

    const library = path.join(root, "lib");
    const linked = await makeSkill(library, "linked");
    run(["add", library, "--link"]);
    expect(JSON.parse(run(["open", "linked", "--json"]).stdout)).toEqual({ skill: "linked", path: linked });
  });

  describe("import, choosing what", () => {
    const claudeDir = () => path.join(root, "user", ".claude", "skills");
    const agentsDir = () => path.join(root, "user", ".agents", "skills");
    const isLink = async (p: string) => (await fs.lstat(p)).isSymbolicLink();

    it("takes skill names and leaves the rest alone", async () => {
      await makeSkill(claudeDir(), "one");
      await makeSkill(claudeDir(), "two");
      expect(run(["import", "one"]).code).toBe(0);
      expect(await isLink(path.join(claudeDir(), "one"))).toBe(true);
      expect(await isLink(path.join(claudeDir(), "two"))).toBe(false);
      const missing = run(["import", "nope"]);
      expect(missing.code).toBe(2);
      expect(missing.stderr).toContain("nope");
    });

    it("-a imports only that agent's copy: the other copy is not compared or touched", async () => {
      await makeSkill(claudeDir(), "shared", { "a.md": "claude" });
      await makeSkill(agentsDir(), "shared", { "a.md": "codex" });
      expect(run(["import", "--dry-run"]).code).toBe(1);

      const r = run(["import", "-a", "claude", "--json"]);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout).items).toMatchObject([{ name: "shared", type: "import", ok: true }]);
      expect(await isLink(path.join(claudeDir(), "shared"))).toBe(true);
      expect(await isLink(path.join(agentsDir(), "shared"))).toBe(false);
      expect(await fs.readFile(path.join(agentsDir(), "shared", "a.md"), "utf8")).toBe("codex");
      expect(await fs.readFile(path.join(home, "skills", "shared", "a.md"), "utf8")).toBe("claude");
    });

    it("refuses names with --continue or --abort", () => {
      expect(run(["import", "one", "--abort"]).code).toBe(2);
      expect(run(["import", "--continue", "-a", "claude"]).code).toBe(2);
    });

    it("keeps one import's backups in one folder", async () => {
      for (const n of ["one", "two", "three"]) await makeSkill(claudeDir(), n);
      expect(run(["import"]).code).toBe(0);
      const stamps = await fs.readdir(path.join(home, "backups"));
      expect(stamps).toHaveLength(1);
      expect((await fs.readdir(path.join(home, "backups", stamps[0]!, "import-claude"))).sort()).toEqual(["one", "three", "two"]);
    });

    it("finds skills kept in ~/.codex/skills, skips .system, and links them from ~/.agents/skills", async () => {
      const codexDir = path.join(root, "user", ".codex", "skills");
      await makeSkill(codexDir, "mine", { "a.md": "x" });
      await makeSkill(codexDir, ".system");
      expect(run(["status"]).stdout).toContain("unmanaged (1)");
      expect(run(["status", "--only", "unmanaged"]).stdout).toContain("mine");

      expect(run(["import"]).code).toBe(0);
      await expect(fs.lstat(path.join(codexDir, "mine"))).rejects.toThrow();
      expect(await isLink(path.join(agentsDir(), "mine"))).toBe(true);
      expect(await fs.readFile(path.join(home, "skills", "mine", "a.md"), "utf8")).toBe("x");
      await fs.access(path.join(codexDir, ".system", "SKILL.md"));
      expect(run(["check"]).code).toBe(0);
    });

    it("a copy in ~/.codex/skills identical to the hub's is replaced without a second link", async () => {
      run(["add", await makeSkill(path.join(root, "src"), "mine", { "a.md": "same" }), "-a", "codex"]);
      await makeSkill(path.join(root, "user", ".codex", "skills"), "mine", { "a.md": "same" });

      expect(run(["import"]).code).toBe(0);
      await expect(fs.lstat(path.join(root, "user", ".codex", "skills", "mine"))).rejects.toThrow();
      expect(await isLink(path.join(agentsDir(), "mine"))).toBe(true);
      expect(run(["check"]).code).toBe(0);
    });
  });

  it("eject by skill or agent changes only those links; -a is never ignored", async () => {
    run(["add", await makeSkill(path.join(root, "src"), "coding"), "-a", "claude,codex"]);
    run(["add", await makeSkill(path.join(root, "src"), "other"), "-a", "claude"]);
    const claude = path.join(root, "user", ".claude", "skills");
    const codex = path.join(root, "user", ".agents", "skills", "coding");

    const refused = run(["eject", "-a", "codex"]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("for codex");
    expect((await fs.lstat(codex)).isSymbolicLink()).toBe(true);

    const preview = run(["eject", "-a", "codex", "--dry-run"]);
    expect(preview.stdout).toContain("without --dry-run");
    expect((await fs.lstat(codex)).isSymbolicLink()).toBe(true);

    const done = run(["eject", "-a", "codex", "-y"]);
    expect(done.code).toBe(0);
    expect(done.stdout).toContain("still managed");
    expect((await fs.lstat(codex)).isSymbolicLink()).toBe(false);
    expect((await fs.lstat(path.join(claude, "coding"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(claude, "other"))).isSymbolicLink()).toBe(true);
    expect(run(["check"]).code).toBe(0);

    const left = run(["eject", "other", "-y"]);
    expect(left.stdout).toContain("the hub  other");
    expect((await fs.lstat(path.join(claude, "other"))).isSymbolicLink()).toBe(false);
    expect(JSON.parse(run(["list", "--json"]).stdout).skills.map((s: { name: string }) => s.name)).toEqual(["coding"]);
    expect(run(["eject", "nope", "-y"]).code).toBe(2);
  });

  it("remove says what the agent lost and how to keep a copy", async () => {
    run(["add", await makeSkill(path.join(root, "src"), "coding"), "-a", "claude"]);
    const r = run(["remove", "coding", "-a", "claude"]);
    expect(r.stdout).toContain("no longer have coding");
    expect(r.stdout).toContain("skillsym eject");
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
    // Enough processes to hit first-use races: half-written hub files, and Windows' EPERM on a lock being deleted.
    const names = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"];
    const srcs = await Promise.all(names.map((n) => makeSkill(path.join(root, "src"), n)));
    const results = await Promise.all(srcs.map((s) => runAsync(["add", s, "--json"])));
    expect(results.map((r) => r.code)).toEqual(names.map(() => 0));
    const listed = JSON.parse(run(["list", "--json"]).stdout).skills.map((s: { name: string }) => s.name);
    expect(listed).toEqual(names);
  });
});
