import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeSkill, makeTempDir, removeDir } from "../../core/test/helpers.js";
// The built CLI module, driven in-process so answers can be scripted.
import { main, type Io } from "../dist/main.js";

let root: string;
let userHome: string;
let out: string[];

beforeEach(async () => {
  root = await makeTempDir("skillsym-int-");
  userHome = path.join(root, "user");
});

afterEach(async () => {
  await removeDir(root);
});

function io(answers: string[] = [], interactive = true): Io {
  out = [];
  return {
    stdout: (t) => out.push(t),
    stderr: (t) => out.push(t),
    env: { SKILLSYM_HOME: path.join(root, "hub"), HOME: userHome, USERPROFILE: userHome },
    interactive,
    ask: async () => answers.shift() ?? "",
  };
}

const link = () => path.join(userHome, ".claude", "skills", "coding");

async function setupReplaced() {
  await main(["add", await makeSkill(path.join(root, "src"), "coding"), "-a", "claude"], io());
  try {
    await fs.unlink(link());
  } catch {
    await fs.rmdir(link());
  }
  await makeSkill(path.join(userHome, ".claude", "skills"), "coding", { "agent.md": "edit" });
}

describe("sync asks about conflicts in a terminal", () => {
  it("restores the link when the user answers r", async () => {
    await setupReplaced();
    const code = await main(["sync"], io(["r"]));
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/\[r\] restore/);
    expect((await fs.lstat(link())).isSymbolicLink()).toBe(true);
  });

  it("re-asks on an invalid answer and forks with the typed name", async () => {
    await setupReplaced();
    const code = await main(["sync"], io(["x", "f", "coding-edit"]));
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Please answer one of");
    expect((await fs.lstat(path.join(userHome, ".claude", "skills", "coding-edit"))).isSymbolicLink()).toBe(true);
  });

  it("an empty answer skips and exits 1", async () => {
    await setupReplaced();
    expect(await main(["sync"], io([""]))).toBe(1);
    expect((await fs.lstat(link())).isSymbolicLink()).toBe(false);
  });

  it("never asks with -y or without a terminal", async () => {
    await setupReplaced();
    let asked = false;
    const quiet = { ...io(), ask: async () => ((asked = true), "r") };
    expect(await main(["sync", "-y"], quiet)).toBe(1);
    expect(await main(["sync"], { ...quiet, interactive: false })).toBe(1);
    expect(asked).toBe(false);
    expect((await fs.lstat(link())).isSymbolicLink()).toBe(false);
  });
});
