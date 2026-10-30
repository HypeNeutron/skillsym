import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addSkill,
  assignSkills,
  builtinAgents,
  hashSkillDir,
  openHub,
  planSync,
  readLinkTarget,
  readManifest,
  readState,
  scanStatus,
  sync,
  writeManifest,
  type AgentProfile,
  type Hub,
} from "../src/index.js";
import { listDir, makeSkill, makeTempDir, removeDir } from "./helpers.js";

let root: string;
let userHome: string;
let hub: Hub;
let profiles: AgentProfile[];

const claudeDir = () => path.join(userHome, ".claude", "skills");
const link = (skill: string) => path.join(claudeDir(), skill);
const hubSkill = (skill: string) => path.join(hub.skillsDir, skill);

beforeEach(async () => {
  root = await makeTempDir();
  userHome = path.join(root, "user");
  await fs.mkdir(userHome);
  hub = await openHub(path.join(root, "hub"));
  profiles = builtinAgents(userHome);
  await addSkill(hub, await makeSkill(path.join(root, "src"), "coding", { "refs/a.md": "A" }));
  await addSkill(hub, await makeSkill(path.join(root, "src"), "research"));
  await assignSkills(hub, { skills: ["coding"], agents: ["claude"], profiles });
});

afterEach(async () => {
  await removeDir(root);
});

const runSync = () => sync(hub, { profiles });
const plan = () => planSync(hub, { profiles });
const statuses = async () => (await scanStatus(hub, { profiles })).entries.map((e) => [e.skill, e.status]);

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

/** Everything sync could touch, for "nothing changed" assertions. */
async function snapshot() {
  const agentDir = await listDir(claudeDir());
  const contents: Record<string, string | null> = {};
  for (const name of agentDir) {
    const p = path.join(claudeDir(), name);
    contents[name] = (await readLinkTarget(p)) ?? (await hashSkillDir(p));
  }
  return { state: await fs.readFile(hub.statePath, "utf8"), agentDir, contents };
}

describe("sync applies what it can decide alone", () => {
  it("links a skill that is assigned but was never linked", async () => {
    await setAgents("research", ["claude"]);
    const result = await runSync();
    expect(result.results).toEqual([expect.objectContaining({ type: "link", skill: "research", ok: true })]);
    expect(await readLinkTarget(link("research"))).toBe(hubSkill("research"));
    expect(await statuses()).toEqual([
      ["coding", "synced"],
      ["research", "synced"],
    ]);
  });

  it("re-links every link after the hub moved", async () => {
    const moved = path.join(root, "hub-moved");
    await fs.rename(hub.home, moved);
    hub = await openHub(moved);

    const result = await runSync();

    expect(result.results.map((r) => [r.type, r.ok])).toEqual([["relink", true]]);
    expect(await readLinkTarget(link("coding"))).toBe(hubSkill("coding"));
    expect((await readState(hub.statePath)).links[0]!.target).toBe(hubSkill("coding"));
    expect(await statuses()).toEqual([["coding", "synced"]]);
  });

  it("restores the link over an identical real copy and keeps the copy as a backup", async () => {
    await removeLink(link("coding"));
    await fs.cp(hubSkill("coding"), link("coding"), { recursive: true });

    const result = await runSync();

    const r = result.results[0]!;
    expect(r).toMatchObject({ type: "replace-identical", ok: true });
    expect(await readLinkTarget(link("coding"))).toBe(hubSkill("coding"));
    expect(r.backup).toBeDefined();
    expect(await hashSkillDir(r.backup!)).toBe(await hashSkillDir(hubSkill("coding")));
    expect(r.backup!.startsWith(hub.backupsDir)).toBe(true);
  });

  it("restores the link over another link to identical content without touching that content", async () => {
    const copy = path.join(root, "copy", "coding");
    await fs.cp(hubSkill("coding"), copy, { recursive: true });
    await removeLink(link("coding"));
    await fs.symlink(copy, link("coding"), process.platform === "win32" ? "junction" : "dir");

    await runSync();

    expect(await readLinkTarget(link("coding"))).toBe(hubSkill("coding"));
    expect(await listDir(copy)).toEqual(["SKILL.md", "refs"]);
  });

  it("removes a link that is no longer assigned, leaving the hub skill alone", async () => {
    await setAgents("coding", []);
    const result = await runSync();
    expect(result.results.map((r) => r.type)).toEqual(["unlink-orphan"]);
    expect(await listDir(claudeDir())).toEqual([]);
    expect((await readState(hub.statePath)).links).toEqual([]);
    expect(await listDir(hubSkill("coding"))).toEqual(["SKILL.md", "refs"]);
  });

  it("only forgets an unassigned link whose path now holds someone else's folder", async () => {
    await setAgents("coding", []);
    await removeLink(link("coding"));
    await makeSkill(claudeDir(), "coding", { "theirs.md": "keep me" });

    const result = await runSync();

    expect(result.results.map((r) => r.type)).toEqual(["forget"]);
    expect(await fs.readFile(path.join(link("coding"), "theirs.md"), "utf8")).toBe("keep me");
    expect((await readState(hub.statePath)).links).toEqual([]);
  });

  it("records a correct link to the hub that state.json lost", async () => {
    await fs.rm(hub.statePath);
    const result = await runSync();
    expect(result.results.map((r) => r.type)).toEqual(["record"]);
    expect((await readState(hub.statePath)).links.map((l) => l.path)).toEqual([link("coding")]);
  });
});

describe("sync leaves decisions to the user", () => {
  it("reports our deleted link as a conflict and does not recreate it", async () => {
    await removeLink(link("coding"));
    const before = await snapshot();
    const result = await runSync();
    expect(result.conflicts).toEqual([expect.objectContaining({ type: "missing-owned", skill: "coding" })]);
    expect(await snapshot()).toEqual(before);
  });

  it("reports a replacement with different content and does not touch it", async () => {
    await removeLink(link("coding"));
    await makeSkill(claudeDir(), "coding", { "agent-edit.md": "x" });
    const before = await snapshot();
    const result = await runSync();
    expect(result.conflicts.map((c) => c.type)).toEqual(["replaced-different"]);
    expect(await snapshot()).toEqual(before);
  });

  it("reports a blocked path and does not touch it", async () => {
    await makeSkill(claudeDir(), "research");
    await setAgents("research", ["claude"]);
    const before = await snapshot();
    const result = await runSync();
    expect(result.conflicts.map((c) => c.type)).toEqual(["blocked"]);
    expect(await snapshot()).toEqual(before);
  });

  it("reports a skill whose hub folder is gone", async () => {
    await fs.rm(hubSkill("coding"), { recursive: true });
    const result = await runSync();
    expect(result.conflicts.map((c) => c.type)).toEqual(["hub-skill-missing"]);
    expect(result.results).toEqual([]);
  });

  it("never touches unmanaged skill folders", async () => {
    const mine = await makeSkill(claudeDir(), "handmade");
    const hash = await hashSkillDir(mine);
    await runSync();
    expect(await hashSkillDir(mine)).toBe(hash);
  });
});

describe("sync is safe to repeat and to preview", () => {
  it("a second run has an empty plan and writes nothing", async () => {
    await setAgents("research", ["claude"]);
    await runSync();
    const stateStat = await fs.stat(hub.statePath);
    const before = await snapshot();

    const second = await runSync();

    expect(second.actions).toEqual([]);
    expect(await snapshot()).toEqual(before);
    expect((await fs.stat(hub.statePath)).mtimeMs).toBe(stateStat.mtimeMs);
  });

  it("--dry-run shows exactly what sync then does, without changing anything", async () => {
    await setAgents("research", ["claude"]);
    await setAgents("coding", []);
    const before = await snapshot();

    const preview = await plan();
    expect(await snapshot()).toEqual(before);

    const result = await runSync();
    expect(result.actions).toEqual(preview.actions);
    expect(result.conflicts).toEqual(preview.conflicts);
  });
});
