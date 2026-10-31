import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addSkill,
  assignSkills,
  builtinAgents,
  hashSkillDir,
  openHub,
  readManifest,
  scanStatus,
  writeManifest,
  type AgentProfile,
  type Hub,
} from "../src/index.js";
import { makeSkill, makeTempDir, removeDir } from "./helpers.js";

let root: string;
let userHome: string;
let hub: Hub;
let profiles: AgentProfile[];

const claudeDir = () => path.join(userHome, ".claude", "skills");
const link = (skill: string) => path.join(claudeDir(), skill);

beforeEach(async () => {
  root = await makeTempDir();
  userHome = path.join(root, "user");
  await fs.mkdir(userHome);
  hub = await openHub(path.join(root, "hub"));
  profiles = builtinAgents(userHome);
  await addSkill(hub, await makeSkill(path.join(root, "src"), "coding", { "refs/a.md": "line1\nline2\n" }));
  await addSkill(hub, await makeSkill(path.join(root, "src"), "research"));
  await assignSkills(hub, { skills: ["coding"], agents: ["claude"], profiles });
});

afterEach(async () => {
  await removeDir(root);
});

const scan = () => scanStatus(hub, { profiles });

/** Remove a link (junction or symlink) without touching its target. */
async function removeLink(p: string) {
  try {
    await fs.unlink(p);
  } catch {
    await fs.rmdir(p);
  }
}

async function setAgents(skill: string, agents: string[]) {
  const m = await readManifest(hub.manifestPath);
  m.skills[skill]!.agents = agents;
  await writeManifest(hub.manifestPath, m);
}

async function entryFor(skill: string) {
  const report = await scan();
  return report.entries.find((e) => e.skill === skill);
}

describe("status", () => {
  it("synced: our link points at the hub skill", async () => {
    const report = await scan();
    expect(report.entries).toEqual([
      expect.objectContaining({ skill: "coding", agents: ["claude"], path: link("coding"), status: "synced", owned: true }),
    ]);
    expect(report.clean).toBe(true);
  });

  it("missing: our link was deleted", async () => {
    await removeLink(link("coding"));
    expect(await entryFor("coding")).toMatchObject({ status: "missing", owned: true });
    expect((await scan()).clean).toBe(false);
  });

  it("missing: assigned in the manifest but never linked", async () => {
    await setAgents("research", ["claude"]);
    expect(await entryFor("research")).toMatchObject({ status: "missing", owned: false });
  });

  it("dangling: the hub moved and the link points at the old location", async () => {
    const moved = path.join(root, "hub-moved");
    await fs.rename(hub.home, moved);
    hub = await openHub(moved);
    expect(await entryFor("coding")).toMatchObject({ status: "dangling", owned: true, linkTarget: path.join(root, "hub", "skills", "coding") });
  });

  it("dangling: the hub skill folder was deleted", async () => {
    await fs.rm(path.join(hub.skillsDir, "coding"), { recursive: true });
    expect(await entryFor("coding")).toMatchObject({ status: "dangling" });
  });

  it("replaced: a real folder with identical content took the link's place", async () => {
    await removeLink(link("coding"));
    await fs.cp(path.join(hub.skillsDir, "coding"), link("coding"), { recursive: true });
    expect(await entryFor("coding")).toMatchObject({ status: "replaced", owned: true, sameContent: true });
  });

  it("replaced: identical apart from CRLF line endings and a BOM still counts as same content", async () => {
    await removeLink(link("coding"));
    await fs.cp(path.join(hub.skillsDir, "coding"), link("coding"), { recursive: true });
    await fs.writeFile(path.join(link("coding"), "refs", "a.md"), "﻿line1\r\nline2\r\n");
    expect(await entryFor("coding")).toMatchObject({ status: "replaced", sameContent: true });
  });

  it("replaced: a real folder with different content", async () => {
    await removeLink(link("coding"));
    await makeSkill(claudeDir(), "coding", { "extra.md": "agent edit" });
    expect(await entryFor("coding")).toMatchObject({ status: "replaced", owned: true, sameContent: false });
  });

  it("replaced: our link now points somewhere else", async () => {
    const elsewhere = await makeSkill(path.join(root, "other"), "coding");
    await removeLink(link("coding"));
    await fs.symlink(elsewhere, link("coding"), process.platform === "win32" ? "junction" : "dir");
    expect(await entryFor("coding")).toMatchObject({ status: "replaced", owned: true, linkTarget: elsewhere });
  });

  it("blocked: an assigned path holds something skillsym never created", async () => {
    await makeSkill(claudeDir(), "research");
    await setAgents("research", ["claude"]);
    expect(await entryFor("research")).toMatchObject({ status: "blocked", owned: false });
  });

  it("orphaned: our link is no longer assigned in the manifest", async () => {
    await setAgents("coding", []);
    const report = await scan();
    expect(report.entries).toEqual([expect.objectContaining({ skill: "coding", agents: [], status: "orphaned", owned: true })]);
    expect(report.clean).toBe(false);
  });

  it("unmanaged: lists other skill folders but skips dotfolders, reserved folders and non-skills", async () => {
    await makeSkill(claudeDir(), "handmade");
    await makeSkill(path.join(claudeDir(), ".trash", "x"), "old");
    await makeSkill(path.join(claudeDir(), "synced", "account-id"), "docs");
    await fs.mkdir(path.join(claudeDir(), "not-a-skill"));
    await makeSkill(path.join(userHome, ".agents", "skills"), "from-npx-skills");

    const report = await scan();

    expect(report.unmanaged.map((u) => [u.name, u.agents])).toEqual([
      ["handmade", ["claude"]],
      ["from-npx-skills", ["codex", "universal"]],
    ]);
    expect(report.clean).toBe(true);
  });

  it("ignores plain files in an agent's skills folder (ENOTDIR on macOS/Linux)", async () => {
    await fs.writeFile(path.join(claudeDir(), "README.txt"), "not a skill");
    const report = await scan();
    expect(report.unmanaged).toEqual([]);
    expect(report.clean).toBe(true);
  });

  it("warns when a hub skill's SKILL.md has a BOM (Codex rejects it)", async () => {
    const file = path.join(hub.skillsDir, "research", "SKILL.md");
    await fs.writeFile(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), await fs.readFile(file)]));
    expect((await scan()).warnings).toEqual([expect.objectContaining({ code: "SKILL_MD_BOM", skill: "research" })]);
  });

  it("is read-only", async () => {
    await removeLink(link("coding"));
    await makeSkill(claudeDir(), "coding", { "x.md": "y" });
    const snapshot = async () => ({
      manifest: await fs.readFile(hub.manifestPath, "utf8"),
      state: await fs.readFile(hub.statePath, "utf8"),
      agentDir: (await fs.readdir(claudeDir())).sort(),
      content: await hashSkillDir(link("coding")),
    });
    const before = await snapshot();
    await scan();
    expect(await snapshot()).toEqual(before);
  });
});

describe("hashSkillDir", () => {
  it("ignores CRLF vs LF, a leading BOM and OS clutter, but not real changes", async () => {
    const a = await makeSkill(path.join(root, "h1"), "s", { "n.md": "a\nb\n" });
    const b = await makeSkill(path.join(root, "h2"), "s", { "n.md": "﻿a\r\nb\r\n", ".DS_Store": "junk", "Thumbs.db": "junk" });
    const c = await makeSkill(path.join(root, "h3"), "s", { "n.md": "a\nB\n" });
    expect(await hashSkillDir(a)).toBe(await hashSkillDir(b));
    expect(await hashSkillDir(a)).not.toBe(await hashSkillDir(c));
  });

  it("hashes binary files byte for byte", async () => {
    const a = path.join(root, "bin1");
    const b = path.join(root, "bin2");
    await fs.mkdir(a);
    await fs.mkdir(b);
    await fs.writeFile(path.join(a, "x.bin"), Buffer.from([0, 13, 10, 1]));
    await fs.writeFile(path.join(b, "x.bin"), Buffer.from([0, 10, 1]));
    expect(await hashSkillDir(a)).not.toBe(await hashSkillDir(b));
  });
});
