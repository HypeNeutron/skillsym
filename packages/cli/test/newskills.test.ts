import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeSkill, makeTempDir, removeDir } from "../../core/test/helpers.js";
// The built CLI module, driven in-process so answers can be scripted.
import { main, type Io } from "../dist/main.js";

let root: string;
let userHome: string;
let out: string[];
let prompts: string[];

beforeEach(async () => {
  root = await makeTempDir("skillsym-new-");
  userHome = path.join(root, "user");
  await fs.mkdir(path.join(userHome, ".claude"), { recursive: true });
  await fs.mkdir(path.join(userHome, ".codex"), { recursive: true });
  await main(["add", await makeSkill(path.join(root, "src"), "coding"), "-a", "claude"], io());
  await makeSkill(path.join(root, "hub", "skills"), "foo");
});

afterEach(async () => {
  await removeDir(root);
});

/** An Io that answers questions from `answers` and records every question asked. */
function io(answers: string[] = [], interactive = true): Io {
  out = [];
  prompts = [];
  return {
    stdout: (t) => out.push(t),
    stderr: (t) => out.push(t),
    env: { SKILLSYM_HOME: path.join(root, "hub"), HOME: userHome, USERPROFILE: userHome },
    interactive,
    ask: async (q) => (prompts.push(q), answers.shift() ?? ""),
  };
}

const manifestText = () => fs.readFile(path.join(root, "hub", "manifest.json"), "utf8");
const skills = async () => JSON.parse(await manifestText()).skills;
const config = async () => JSON.parse(await fs.readFile(path.join(root, "hub", "config.json"), "utf8"));

describe("sync and a new hub skill", () => {
  it("choice 1 (the default) registers for every installed agent; 'y' saves '*'", async () => {
    expect(await main(["sync"], io(["", "y"]))).toBe(0);
    expect(prompts[0]).toContain("New skill found in the hub: foo. Which agents should get it?");
    expect(prompts[0]).toContain("1) Every installed agent (claude");
    expect(prompts[0]).toContain("(default)");
    expect(prompts[0]).toContain("2) Choose agents");
    expect(prompts[0]).toContain("3) Not now — leave it unregistered and ask again next sync");
    expect(prompts[1]).toContain("Use this answer for future new skills too? (y/N)");
    expect((await skills()).foo.agents).toContain("claude");
    expect((await config()).newSkills).toEqual({ agents: ["*"] });
    expect((await config()).agents).toEqual([]);
  });

  it("choice 2 lists the registered agents and picks by number; 'n' saves nothing", async () => {
    await main(["sync"], io(["2", "99", "n"]));
    expect(prompts[1]).toContain("Agents (comma-separated numbers):");
    const claudeNo = /(\d+)\) claude/.exec(prompts[1]!)![1]!;
    expect(await manifestText()).not.toContain('"foo"');

    expect(await main(["sync"], io(["2", claudeNo, "n"]))).toBe(0);
    expect((await skills()).foo.agents).toEqual(["claude"]);
    expect(await config()).not.toHaveProperty("newSkills");
  });

  it("choice 2 with 'y' saves the picked ids and keeps the other config fields", async () => {
    await fs.writeFile(path.join(root, "hub", "config.json"), JSON.stringify({ version: 1, agents: [], other: 1 }));
    await main(["sync"], io(["2", "1", "y"]));
    const saved = await config();
    expect(saved.newSkills.agents).toHaveLength(1);
    expect(saved.other).toBe(1);
    expect((await skills()).foo.agents).toEqual(saved.newSkills.agents);
  });

  it("choice 3 leaves it unregistered, exits 1, and the next sync asks again", async () => {
    expect(await main(["sync"], io(["3"]))).toBe(1);
    expect(await skills()).not.toHaveProperty("foo");
    await main(["sync"], io(["3"]));
    expect(prompts[0]).toContain("New skill found in the hub: foo");
  });

  it("never asks with -y, --json or without a terminal: reports, exits 1, manifest unchanged", async () => {
    const before = await manifestText();
    for (const [args, interactive] of [[["sync", "-y"], true], [["sync", "--json"], true], [["sync"], false]] as const) {
      expect(await main([...args], io(["", "y"], interactive))).toBe(1);
      expect(prompts).toEqual([]);
    }
    expect(await manifestText()).toBe(before);
    await main(["sync", "-y"], io());
    expect(out.join("\n")).toContain("NOT REGISTERED  foo");
  });

  it("with newSkills.agents set it does not ask; --dry-run lists and writes nothing", async () => {
    await fs.writeFile(path.join(root, "hub", "config.json"), JSON.stringify({ version: 1, agents: [], newSkills: { agents: ["claude"] } }));
    const before = await manifestText();
    expect(await main(["sync", "--dry-run"], io())).toBe(0);
    expect(out.join("\n")).toContain("would register  foo -> claude");
    expect(await manifestText()).toBe(before);

    expect(await main(["sync"], io())).toBe(0);
    expect(prompts).toEqual([]);
    expect((await skills()).foo.agents).toEqual(["claude"]);
    expect(await main(["check"], io())).toBe(0);
  });
});
