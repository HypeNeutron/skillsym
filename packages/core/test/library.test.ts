import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addLibrary,
  addSkill,
  findLibrarySkills,
  hashSkillDir,
  listSkills,
  openHub,
  planLibraryAdd,
  readManifest,
  SkillsymError,
  type Hub,
} from "../src/index.js";
import { listDir, makeSkill, makeTempDir, removeDir } from "./helpers.js";

let root: string;
let lib: string;
let hub: Hub;

beforeEach(async () => {
  root = await makeTempDir();
  lib = path.join(root, "my-skills");
  hub = await openHub(path.join(root, "hub"));
  // A realistic library: top-level skills, category folders, a git folder and node_modules.
  await makeSkill(lib, "coding", { "refs/a.md": "A" });
  await makeSkill(path.join(lib, "writing"), "blog-post");
  await makeSkill(path.join(lib, "writing", "nested"), "deep-skill");
  await makeSkill(path.join(lib, ".git", "objects"), "not-a-skill");
  await makeSkill(path.join(lib, "node_modules", "pkg"), "vendored");
  await fs.writeFile(path.join(lib, "README.md"), "my library");
});

afterEach(async () => {
  await removeDir(root);
});

async function libraryHashes() {
  const out: Record<string, string> = {};
  for (const s of await findLibrarySkills(lib)) out[s.name] = await hashSkillDir(s.path);
  out["README.md"] = await fs.readFile(path.join(lib, "README.md"), "utf8");
  return out;
}

describe("findLibrarySkills", () => {
  it("finds skills at any depth, skipping .git, node_modules and the inside of skills", async () => {
    await makeSkill(path.join(lib, "coding"), "inner-should-not-count");
    const names = (await findLibrarySkills(lib)).map((s) => s.name).sort();
    expect(names).toEqual(["blog-post", "coding", "deep-skill"]);
  });

  it("treats a folder with its own SKILL.md as a single skill", async () => {
    expect((await findLibrarySkills(path.join(lib, "coding"))).map((s) => s.name)).toEqual(["coding"]);
  });
});

describe("add <library> (copy)", () => {
  it("copies every skill into the hub and leaves the library untouched", async () => {
    const before = await libraryHashes();

    const { added, items } = await addLibrary(hub, lib);

    expect(added.map((s) => s.name).sort()).toEqual(["blog-post", "coding", "deep-skill"]);
    expect(items.every((i) => i.type === "add")).toBe(true);
    expect(await listDir(hub.skillsDir)).toEqual(["blog-post", "coding", "deep-skill"]);
    for (const s of await findLibrarySkills(lib)) expect(await hashSkillDir(path.join(hub.skillsDir, s.name))).toBe(await hashSkillDir(s.path));
    expect(await libraryHashes()).toEqual(before);
  });

  it("records where each skill came from, with its hash", async () => {
    await addLibrary(hub, lib);
    const entry = (await readManifest(hub.manifestPath)).skills["blog-post"]!;
    expect(entry.source).toBe(path.join(lib, "writing", "blog-post"));
    expect(entry.sourceHash).toBe(await hashSkillDir(path.join(lib, "writing", "blog-post")));
  });

  it("keeps source fields through later manifest writes, and older manifests without them still load", async () => {
    await addLibrary(hub, lib);
    await addSkill(hub, await makeSkill(path.join(root, "single"), "solo"));
    const m = await readManifest(hub.manifestPath);
    expect(m.skills.coding!.source).toBe(path.join(lib, "coding"));
    expect(m.skills.solo!.source).toBe(path.join(root, "single", "solo"));

    await fs.writeFile(hub.manifestPath, JSON.stringify({ version: 1, skills: { old: { agents: [], mode: "link", scope: "user" } } }));
    expect((await readManifest(hub.manifestPath)).skills.old).toEqual({ agents: [], mode: "link", scope: "user" });
  });

  it("skips names used twice in the library, but adds the rest", async () => {
    await makeSkill(path.join(lib, "other-category"), "coding");
    const { items, added } = await addLibrary(hub, lib);
    expect(items.filter((i) => i.type === "skip").map((i) => i.name)).toEqual(["coding", "coding"]);
    expect(items.find((i) => i.type === "skip")!.reason).toMatch(/2 skills named "coding"/);
    expect(added.map((s) => s.name).sort()).toEqual(["blog-post", "deep-skill"]);
  });

  it("skips names already in the hub and says how to resolve it", async () => {
    await addSkill(hub, await makeSkill(path.join(root, "elsewhere"), "coding"));
    const { items } = await addLibrary(hub, lib);
    const skip = items.find((i) => i.name === "coding")!;
    expect(skip.type).toBe("skip");
    expect(skip.reason).toContain("skillsym remove coding");
  });

  it("skips folders whose names are not valid skill names", async () => {
    await makeSkill(lib, "has space");
    const { items } = await addLibrary(hub, lib);
    expect(items.find((i) => i.name === "has space")).toMatchObject({ type: "skip" });
  });

  it("the plan (dry run) matches what add does, and changes nothing", async () => {
    const before = { hub: await listDir(hub.skillsDir), manifest: await fs.readFile(hub.manifestPath, "utf8") };
    const plan = await planLibraryAdd(hub, lib);
    expect({ hub: await listDir(hub.skillsDir), manifest: await fs.readFile(hub.manifestPath, "utf8") }).toEqual(before);
    const done = await addLibrary(hub, lib);
    expect(done.items).toEqual(plan.items);
  });

  it("running it again adds nothing new and reports the existing ones", async () => {
    await addLibrary(hub, lib);
    const again = await addLibrary(hub, lib);
    expect(again.added).toEqual([]);
    expect(again.items.every((i) => i.type === "skip")).toBe(true);
    expect((await listSkills(hub)).map((s) => s.name)).toEqual(["blog-post", "coding", "deep-skill"]);
  });

  it("reports a folder with no skills in it", async () => {
    const empty = path.join(root, "empty");
    await fs.mkdir(empty);
    const err = await addLibrary(hub, empty).catch((e: unknown) => e);
    expect((err as SkillsymError).code).toBe("MISSING_SKILL_MD");
  });
});
