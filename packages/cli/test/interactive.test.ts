import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeSkill, makeTempDir, removeDir } from "../../core/test/helpers.js";
// The built CLI module, driven in-process so answers can be scripted.
import { main, PromptCancelled, type Io } from "../dist/main.js";

/** An answer that simulates the user pressing Ctrl+C at that question. */
const CTRL_C = "<ctrl-c>";

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
    ask: async () => {
      const answer = answers.shift() ?? "";
      if (answer === CTRL_C) throw new PromptCancelled();
      return answer;
    },
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

describe("remove asks before deleting a skill from the hub", () => {
  it("cancels on anything but y", async () => {
    await main(["add", await makeSkill(path.join(root, "src"), "coding"), "-a", "claude"], io());
    expect(await main(["remove", "coding"], io(["n"]))).toBe(1);
    expect((await fs.lstat(link())).isSymbolicLink()).toBe(true);
  });

  it("sync offers to restore a deleted library skill only when there is a snapshot", async () => {
    const library = path.join(root, "my-skills");
    await makeSkill(library, "coding", { "a.md": "mine\n" });
    await main(["add", library, "--link", "-a", "claude"], io());
    await removeDir(library);

    expect(await main(["sync"], io(["r"]))).toBe(0);
    expect(out.join("\n")).toContain("from skillsym's latest snapshot");
    expect(out.join("\n")).toContain("put back from the latest snapshot");
    expect(await fs.readFile(path.join(library, "coding", "a.md"), "utf8")).toBe("mine\n");
    expect(await fs.readFile(path.join(link(), "a.md"), "utf8")).toBe("mine\n");
    expect(await main(["check"], io())).toBe(0);

    await removeDir(library);
    await removeDir(path.join(root, "hub", "library-snapshots"));
    expect(await main(["sync"], io([""]))).toBe(1);
    const text = out.join("\n");
    expect(text).toContain("[d] drop");
    expect(text).not.toContain("[r] restore");
  });

  it("sync does not claim to be in sync when it is about to ask", async () => {
    await main(["add", await makeSkill(path.join(root, "src"), "coding"), "-a", "claude"], io());
    await fs.rm(link(), { recursive: false, force: true }).catch(() => fs.rmdir(link()));
    expect(await main(["sync", "coding"], io(["r"]))).toBe(0);
    expect(out.join("\n")).not.toContain("Already in sync");
    expect((await fs.lstat(link())).isSymbolicLink()).toBe(true);
    expect(await main(["sync", "coding"], io())).toBe(0);
    expect(out.join("\n")).toContain("Already in sync");
  });

  it("removes on y", async () => {
    await main(["add", await makeSkill(path.join(root, "src"), "coding"), "-a", "claude"], io());
    expect(await main(["remove", "coding"], io(["y"]))).toBe(0);
    await expect(fs.lstat(link())).rejects.toThrow();
  });
});

describe("import asks about differing copies in a terminal", () => {
  async function setupImportConflict() {
    await makeSkill(path.join(userHome, ".claude", "skills"), "coding", { "a.md": "claude\n" });
    await makeSkill(path.join(userHome, ".agents", "skills"), "coding", { "a.md": "codex\n" });
  }

  it("keeps the version the user picks", async () => {
    await setupImportConflict();
    expect(await main(["import"], io(["p", "2"]))).toBe(0);
    expect((await fs.lstat(link())).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(link(), "a.md"), "utf8")).toBe("codex\n");
  });

  it("merge: exits 1 with instructions, warns other commands, and --continue finishes it", async () => {
    await setupImportConflict();
    expect(await main(["import"], io(["m"]))).toBe(1);
    const instructions = out.join("\n");
    expect(instructions).toContain("import --continue");
    expect(instructions).toContain("import --abort");
    expect(instructions).toContain("Nothing in your agents' folders changes until you continue");
    const mergeFile = path.join(root, "hub", "merge", "coding", "a.md");

    expect(await main(["import", "--continue"], io())).toBe(2);
    expect(out.join("\n")).toMatch(/conflict markers remain in a\.md.*--abort/s);
    expect(await main(["status"], io())).toBe(0);
    expect(out.join("\n")).toContain("still open");
    expect(await main(["sync", "-y"], io())).toBe(0);
    expect(out.join("\n")).toContain("still open");

    await fs.writeFile(mergeFile, "merged\n");
    expect(await main(["import", "--continue"], io())).toBe(0);
    expect(await fs.readFile(path.join(link(), "a.md"), "utf8")).toBe("merged\n");
  });
});

describe("every question has a way out", () => {
  async function twoReplaced() {
    await setupReplaced();
    await main(["add", await makeSkill(path.join(root, "src"), "other"), "-a", "claude"], io());
    const other = path.join(userHome, ".claude", "skills", "other");
    try {
      await fs.unlink(other);
    } catch {
      await fs.rmdir(other);
    }
    await makeSkill(path.join(userHome, ".claude", "skills"), "other", { "edit.md": "x" });
  }

  it("prompts explain Enter, q and Ctrl+C", async () => {
    await setupReplaced();
    await main(["sync"], io([""]));
    expect(out.join("\n")).toContain("Enter = skip · q = skip all the rest · Ctrl+C = cancel without applying any answer");
  });

  it("q skips every remaining question and says how to come back", async () => {
    await twoReplaced();
    expect(await main(["sync"], io(["q"]))).toBe(1);
    const text = out.join("\n");
    expect(text.match(/skipped /g)).toHaveLength(2);
    expect(text).toContain("Run `skillsym sync` again whenever you want to decide them");
  });

  it("Ctrl+C cancels without applying answers already given", async () => {
    await twoReplaced();
    expect(await main(["sync"], io(["r", CTRL_C]))).toBe(1);
    expect(out.join("\n")).toContain("Cancelled. None of your answers were applied");
    // The first answer ("restore") was not applied either.
    expect((await fs.lstat(link())).isSymbolicLink()).toBe(false);
  });

  it("Ctrl+C at the remove confirmation changes nothing", async () => {
    await main(["add", await makeSkill(path.join(root, "src"), "coding"), "-a", "claude"], io());
    expect(await main(["remove", "coding"], io([CTRL_C]))).toBe(1);
    expect((await fs.lstat(link())).isSymbolicLink()).toBe(true);
  });

  it("eject asks first; anything but y (or Ctrl+C) changes nothing", async () => {
    await main(["add", await makeSkill(path.join(root, "src"), "coding"), "-a", "claude"], io());
    expect(await main(["eject"], io([""]))).toBe(1);
    expect(out.join("\n")).toContain("eject --dry-run");
    expect(await main(["eject"], io([CTRL_C]))).toBe(1);
    expect((await fs.lstat(link())).isSymbolicLink()).toBe(true);
    expect(await main(["eject"], io(["y"]))).toBe(0);
    expect((await fs.lstat(link())).isSymbolicLink()).toBe(false);
  });

  it("an invalid fork name is asked again", async () => {
    await setupReplaced();
    expect(await main(["sync"], io(["f", "bad name", "coding-mine"]))).toBe(0);
    expect(out.join("\n")).toContain("Names may use letters");
    expect((await fs.lstat(path.join(userHome, ".claude", "skills", "coding-mine"))).isSymbolicLink()).toBe(true);
  });

  it("Enter at 'keep which version' goes back and skips that skill", async () => {
    await makeSkill(path.join(userHome, ".claude", "skills"), "coding", { "a.md": "1\n" });
    await makeSkill(path.join(userHome, ".agents", "skills"), "coding", { "a.md": "2\n" });
    expect(await main(["import"], io(["p", ""]))).toBe(1);
    expect(out.join("\n")).toContain("Run `skillsym import` again whenever you want to decide them");
    expect((await fs.lstat(link())).isSymbolicLink()).toBe(false);
  });

  it("without a terminal, import says how to decide the conflicts", async () => {
    await makeSkill(path.join(userHome, ".claude", "skills"), "coding", { "a.md": "1\n" });
    await makeSkill(path.join(userHome, ".agents", "skills"), "coding", { "a.md": "2\n" });
    expect(await main(["import"], io([], false))).toBe(1);
    expect(out.join("\n")).toContain("keep one version, keep both, or merge");
  });

  it("usage errors point to --help", async () => {
    expect(await main(["frobnicate"], io())).toBe(2);
    expect(out.join("\n")).toContain("skillsym --help");
  });
});

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
