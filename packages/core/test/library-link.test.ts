import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addLibrary,
  addSkill,
  assignSkills,
  builtinAgents,
  continueImport,
  eject,
  hashSkillDir,
  openHub,
  planLibraryAdd,
  readLinkTarget,
  readManifest,
  removeSkills,
  resolveConflicts,
  resolveImportConflicts,
  scanStatus,
  sync,
  type AgentProfile,
  type Hub,
} from "../src/index.js";
import { listDir, makeSkill, makeTempDir, removeDir } from "./helpers.js";

let root: string;
let lib: string;
let userHome: string;
let hub: Hub;
let profiles: AgentProfile[];

const claude = (skill = "coding") => path.join(userHome, ".claude", "skills", skill);
const libSkill = (skill = "coding") => path.join(lib, skill);

beforeEach(async () => {
  root = await makeTempDir();
  lib = path.join(root, "my-skills");
  userHome = path.join(root, "user");
  await fs.mkdir(userHome);
  hub = await openHub(path.join(root, "hub"));
  profiles = builtinAgents(userHome);
  await makeSkill(lib, "coding", { "a.md": "library v1\n" });
  await makeSkill(path.join(lib, "writing"), "blog-post");
});

afterEach(async () => {
  await removeDir(root);
});

async function linkLibrary(agents = ["claude"]) {
  const result = await addLibrary(hub, lib, { link: true });
  await assignSkills(hub, { skills: result.added.map((s) => s.name), agents, profiles });
  return result;
}

const status = () => scanStatus(hub, { profiles });

async function removeLink(p: string) {
  try {
    await fs.unlink(p);
  } catch {
    await fs.rmdir(p);
  }
}

describe("add --link", () => {
  it("makes each hub skill a link into the library, and remembers the library", async () => {
    const { added } = await linkLibrary();

    expect(added.map((s) => s.name).sort()).toEqual(["blog-post", "coding"]);
    expect(await readLinkTarget(path.join(hub.skillsDir, "coding"))).toBe(libSkill("coding"));
    const manifest = await readManifest(hub.manifestPath);
    expect(manifest.skills.coding).toMatchObject({ mode: "source-link", source: libSkill("coding") });
    expect(manifest.libraries).toEqual([lib]);
    expect((await status()).clean).toBe(true);
  });

  it("an edit in the library is what every agent sees (agent -> hub -> library)", async () => {
    await linkLibrary();
    await fs.writeFile(path.join(libSkill("coding"), "a.md"), "library v2\n");
    expect(await fs.readFile(path.join(claude(), "a.md"), "utf8")).toBe("library v2\n");
  });

  it("running it again changes nothing and reports the skills as already linked", async () => {
    await linkLibrary();
    const manifestBefore = await fs.readFile(hub.manifestPath, "utf8");
    const again = await addLibrary(hub, lib, { link: true });
    expect(again.items.map((i) => i.type)).toEqual(["unchanged", "unchanged"]);
    expect(await fs.readFile(hub.manifestPath, "utf8")).toBe(manifestBefore);
  });

  it("skips a name that is already in the hub as a copy", async () => {
    await addSkill(hub, await makeSkill(path.join(root, "other"), "coding"));
    const { items } = await addLibrary(hub, lib, { link: true });
    expect(items.find((i) => i.name === "coding")).toMatchObject({ type: "skip" });
  });

  it("--dry-run changes nothing", async () => {
    const before = await listDir(hub.skillsDir);
    const plan = await planLibraryAdd(hub, lib, { link: true });
    expect(plan.items.map((i) => i.type)).toEqual(["add", "add"]);
    expect(await listDir(hub.skillsDir)).toEqual(before);
  });
});

describe("the library is never deleted or moved by skillsym", () => {
  it("remove -a and remove leave the library byte-for-byte unchanged", async () => {
    await linkLibrary(["claude", "codex"]);
    const before = await hashSkillDir(libSkill());

    await removeSkills(hub, { skills: ["coding"], agents: ["codex"], profiles });
    const { removedSkills } = await removeSkills(hub, { skills: ["coding"], profiles });

    expect(removedSkills).toEqual([{ skill: "coding", library: libSkill() }]);
    expect(await hashSkillDir(libSkill())).toBe(before);
    expect(await listDir(hub.skillsDir)).toEqual(["blog-post"]);
    await expect(fs.lstat(claude())).rejects.toThrow();
  });

  it("eject gives agents a real copy of the library version and leaves the library alone", async () => {
    await linkLibrary();
    const before = await hashSkillDir(libSkill());
    await eject(hub);
    expect(await readLinkTarget(claude())).toBeNull();
    expect(await hashSkillDir(claude())).toBe(before);
    expect(await hashSkillDir(libSkill())).toBe(before);
    // The agent's copy is independent of the library now.
    await fs.rm(lib, { recursive: true });
    expect(await fs.readFile(path.join(claude(), "a.md"), "utf8")).toBe("library v1\n");
  });
});

describe("changes chosen by the user land in the library", () => {
  it("sync 'adopt' writes the agent's version into the library and backs up the old one", async () => {
    await linkLibrary();
    await removeLink(claude());
    await makeSkill(path.join(userHome, ".claude", "skills"), "coding", { "a.md": "agent edit\n" });
    const { conflicts } = await sync(hub, { profiles });

    const [r] = await resolveConflicts(hub, [{ path: conflicts[0]!.path, choice: "adopt" }], { profiles });

    expect(r).toMatchObject({ ok: true, library: libSkill() });
    expect(await fs.readFile(path.join(libSkill(), "a.md"), "utf8")).toBe("agent edit\n");
    const libBackup = r!.backups.find((b) => b.split(path.sep).includes("library"))!;
    expect(await fs.readFile(path.join(libBackup, "a.md"), "utf8")).toBe("library v1\n");
    expect(await readLinkTarget(path.join(hub.skillsDir, "coding"))).toBe(libSkill());
    expect((await status()).clean).toBe(true);
  });

  it("import 'primary' and 'merge' with a linked skill write the result into the library", async () => {
    await addLibrary(hub, lib, { link: true });
    await makeSkill(path.join(userHome, ".claude", "skills"), "coding", { "a.md": "claude copy\n" });

    const [primary] = await resolveImportConflicts(hub, [{ name: "coding", choice: "primary", primary: claude() }], { profiles });
    expect(primary).toMatchObject({ ok: true, library: libSkill() });
    expect(await fs.readFile(path.join(libSkill(), "a.md"), "utf8")).toBe("claude copy\n");
    expect(await readLinkTarget(claude())).toBe(path.join(hub.skillsDir, "coding"));

    // A second agent with a different copy: merge it into the library.
    await makeSkill(path.join(userHome, ".agents", "skills"), "coding", { "a.md": "codex copy\n" });
    const [merge] = await resolveImportConflicts(hub, [{ name: "coding", choice: "merge" }], { profiles });
    await fs.writeFile(path.join(merge!.mergeDir!, "a.md"), "merged\n");
    const done = await continueImport(hub, { profiles });
    expect(done.library).toBe(libSkill());
    expect(await fs.readFile(path.join(libSkill(), "a.md"), "utf8")).toBe("merged\n");
  });
});

describe("library moved, and new skills in the library", () => {
  it("reports source-missing, and add <new path> --link re-points without touching agents' links", async () => {
    await linkLibrary();
    const agentLinkBefore = await readLinkTarget(claude());
    const moved = path.join(root, "moved-skills");
    await fs.rename(lib, moved);

    const report = await status();
    expect(report.entries.find((e) => e.skill === "coding")!.status).toBe("source-missing");
    expect(report.libraries.missingLibraries).toEqual([lib]);
    expect(report.clean).toBe(false);
    expect((await sync(hub, { profiles })).conflicts.map((c) => c.type)).toContain("source-missing");

    const again = await addLibrary(hub, moved, { link: true });
    expect(again.items.map((i) => i.type)).toEqual(["repoint", "repoint"]);
    expect(await readLinkTarget(path.join(hub.skillsDir, "coding"))).toBe(path.join(moved, "coding"));
    expect(await readLinkTarget(claude())).toBe(agentLinkBefore);
    expect((await status()).entries.every((e) => e.status === "synced")).toBe(true);
  });

  it("lists skills added to the library later, and add --link again adds only those", async () => {
    await linkLibrary();
    await makeSkill(path.join(lib, "writing"), "newsletter");

    const report = await status();
    expect(report.libraries.newSkills).toEqual([{ library: lib, name: "newsletter", path: path.join(lib, "writing", "newsletter") }]);
    expect(report.clean).toBe(true);

    const again = await addLibrary(hub, lib, { link: true });
    expect(again.added.map((s) => s.name)).toEqual(["newsletter"]);
    expect((await status()).libraries.newSkills).toEqual([]);
  });

  it("drop for a source-missing skill unassigns it and removes the agent link", async () => {
    await linkLibrary();
    await fs.rm(libSkill(), { recursive: true });
    const { conflicts } = await sync(hub, { profiles });
    const c = conflicts.find((x) => x.skill === "coding")!;
    const [r] = await resolveConflicts(hub, [{ path: c.path, choice: "drop" }], { profiles });
    expect(r!.ok).toBe(true);
    await expect(fs.lstat(claude())).rejects.toThrow();
    expect((await readManifest(hub.manifestPath)).skills.coding!.agents).toEqual([]);
  });
});
