import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addSkill,
  builtinAgents,
  hashSkillDir,
  importSkills,
  openHub,
  planImport,
  readLinkTarget,
  readManifest,
  scanStatus,
  type AgentProfile,
  type Hub,
} from "../src/index.js";
import { listDir, makeSkill, makeTempDir, removeDir } from "./helpers.js";

let root: string;
let userHome: string;
let hub: Hub;
let profiles: AgentProfile[];

const claude = () => path.join(userHome, ".claude", "skills");
const agentsDir = () => path.join(userHome, ".agents", "skills");
const cursor = () => path.join(userHome, ".cursor", "skills");
const hubSkill = (name: string) => path.join(hub.skillsDir, name);

beforeEach(async () => {
  root = await makeTempDir();
  userHome = path.join(root, "user");
  await fs.mkdir(userHome);
  hub = await openHub(path.join(root, "hub"));
  profiles = builtinAgents(userHome);
});

afterEach(async () => {
  await removeDir(root);
});

const runImport = () => importSkills(hub, { profiles });
const plan = () => planImport(hub, { profiles });
const statuses = async () => (await scanStatus(hub, { profiles })).entries.map((e) => `${e.skill}:${e.agents.join("+")}:${e.status}`);

describe("import", () => {
  it("moves an agent's skill into the hub, backs up the original and leaves a link", async () => {
    const original = await makeSkill(claude(), "research", { "notes.md": "mine" });
    const hash = await hashSkillDir(original);

    const { items } = await runImport();

    expect(items).toEqual([expect.objectContaining({ name: "research", type: "import", ok: true, linked: [original] })]);
    expect(await hashSkillDir(hubSkill("research"))).toBe(hash);
    expect(await readLinkTarget(original)).toBe(hubSkill("research"));
    expect(await hashSkillDir(items[0]!.backups[0]!)).toBe(hash);
    expect((await readManifest(hub.manifestPath)).skills.research!.agents).toEqual(["claude"]);
    expect(await statuses()).toEqual(["research:claude:synced"]);
  });

  it("merges identical copies found in several agents into one hub skill", async () => {
    await makeSkill(claude(), "coding");
    await makeSkill(agentsDir(), "coding");

    const { items } = await runImport();

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "import", ok: true });
    expect(items[0]!.backups).toHaveLength(2);
    expect(await listDir(hub.skillsDir)).toEqual(["coding"]);
    expect((await readManifest(hub.manifestPath)).skills.coding!.agents).toEqual(["claude", "codex", "universal"]);
    expect(await statuses()).toEqual(["coding:claude:synced", "coding:codex+universal:synced"]);
  });

  it("does not give Cursor a second link when it already sees the skill through Claude's folder", async () => {
    await makeSkill(claude(), "coding");
    await makeSkill(cursor(), "coding");

    await runImport();

    expect(await listDir(cursor())).toEqual([]);
    expect(await statuses()).toEqual(["coding:claude:synced", "coding:cursor:covered"]);
  });

  it("links copies of a skill that is already in the hub with the same content", async () => {
    await addSkill(hub, await makeSkill(path.join(root, "src"), "coding"));
    await makeSkill(claude(), "coding");

    const { items } = await runImport();

    expect(items[0]).toMatchObject({ type: "link-existing", ok: true });
    expect(await readLinkTarget(path.join(claude(), "coding"))).toBe(hubSkill("coding"));
  });

  it("can simply be run again after an interruption", async () => {
    // As if an earlier import put the skill in the hub but stopped before replacing the copy.
    await addSkill(hub, await makeSkill(path.join(root, "src"), "coding"));
    const m = await readManifest(hub.manifestPath);
    m.skills.coding!.agents = ["claude"];
    await fs.writeFile(hub.manifestPath, JSON.stringify(m));
    await makeSkill(claude(), "coding");

    await runImport();

    expect(await statuses()).toEqual(["coding:claude:synced"]);
  });

  it("skips dotfolders, reserved folders and folders without SKILL.md", async () => {
    await makeSkill(path.join(claude(), ".trash", "x"), "old");
    await makeSkill(path.join(claude(), "synced", "account"), "docs");
    await fs.mkdir(path.join(claude(), "not-a-skill"), { recursive: true });
    expect((await plan()).items).toEqual([]);
  });

  it("flags a SKILL.md with a BOM", async () => {
    const dir = await makeSkill(claude(), "bommy");
    const file = path.join(dir, "SKILL.md");
    await fs.writeFile(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), await fs.readFile(file)]));
    expect((await plan()).items[0]!.sources[0]!.bom).toBe(true);
  });
});

describe("import leaves what it cannot decide untouched", () => {
  it("reports copies that differ between agents as a conflict", async () => {
    await makeSkill(claude(), "coding", { "a.md": "claude version" });
    await makeSkill(agentsDir(), "coding", { "a.md": "codex version" });

    const { items } = await runImport();

    expect(items[0]).toMatchObject({ type: "conflict", ok: true, backups: [] });
    expect(await listDir(hub.skillsDir)).toEqual([]);
    expect(await fs.readFile(path.join(claude(), "coding", "a.md"), "utf8")).toBe("claude version");
  });

  it("reports a copy that differs from the hub's version as a conflict", async () => {
    await addSkill(hub, await makeSkill(path.join(root, "src"), "coding"));
    await makeSkill(claude(), "coding", { "extra.md": "x" });
    expect((await runImport()).items[0]).toMatchObject({ type: "conflict", reason: "differs from the hub's version" });
    expect(await readLinkTarget(path.join(claude(), "coding"))).toBeNull();
  });

  it("skips links created by other tools", async () => {
    const elsewhere = await makeSkill(path.join(root, "npx-skills-store"), "from-npx");
    await fs.mkdir(agentsDir(), { recursive: true });
    await fs.symlink(elsewhere, path.join(agentsDir(), "from-npx"), process.platform === "win32" ? "junction" : "dir");

    const { items } = await runImport();

    expect(items[0]).toMatchObject({ name: "from-npx", type: "skip" });
    expect(await readLinkTarget(path.join(agentsDir(), "from-npx"))).toBe(elsewhere);
    expect(await listDir(hub.skillsDir)).toEqual([]);
  });

  it("skips folders whose names are not valid skill names", async () => {
    await makeSkill(claude(), "has space");
    expect((await runImport()).items[0]).toMatchObject({ type: "skip" });
    expect(await listDir(claude())).toEqual(["has space"]);
  });

  it("--dry-run shows the same plan and changes nothing", async () => {
    await makeSkill(claude(), "research");
    await makeSkill(claude(), "coding", { "a.md": "1" });
    await makeSkill(agentsDir(), "coding", { "a.md": "2" });
    const before = { claude: await listDir(claude()), hub: await listDir(hub.skillsDir), manifest: await fs.readFile(hub.manifestPath, "utf8") };

    const preview = await plan();

    expect(preview.items.map((i) => `${i.name}:${i.type}`)).toEqual(["coding:conflict", "research:import"]);
    expect({ claude: await listDir(claude()), hub: await listDir(hub.skillsDir), manifest: await fs.readFile(hub.manifestPath, "utf8") }).toEqual(before);
    const { items } = await runImport();
    expect(items.map((i) => `${i.name}:${i.type}`)).toEqual(["coding:conflict", "research:import"]);
  });
});
