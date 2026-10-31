import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addSkill, initSkill, listSkills, openHub, SkillsymError } from "../src/index.js";
import { listDir, makeTempDir, removeDir } from "./helpers.js";

let root: string;

beforeEach(async () => {
  root = await makeTempDir();
});

afterEach(async () => {
  await removeDir(root);
});

async function expectCode(promise: Promise<unknown>, code: string) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SkillsymError);
  expect((err as SkillsymError).code).toBe(code);
}

/** The frontmatter fields every agent needs: a --- block first, with name and description. */
function frontmatter(text: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error("no frontmatter");
  return Object.fromEntries(match[1]!.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
}

describe("init", () => {
  it("creates <name>/SKILL.md with the frontmatter agents need, without a BOM", async () => {
    const { dir, skillMd, name } = await initSkill(root, "my-skill");

    expect(name).toBe("my-skill");
    expect(dir).toBe(path.join(root, "my-skill"));
    const bytes = await fs.readFile(skillMd);
    expect([...bytes.subarray(0, 3)]).toEqual([0x2d, 0x2d, 0x2d]);
    const fields = frontmatter(bytes.toString("utf8"));
    expect(fields.name).toBe("my-skill");
    expect(fields.description!.length).toBeGreaterThan(10);
  });

  it("without a name, writes SKILL.md in the current folder, named after it", async () => {
    const here = path.join(root, "research");
    await fs.mkdir(here);
    const { skillMd } = await initSkill(here);
    expect(skillMd).toBe(path.join(here, "SKILL.md"));
    expect(frontmatter(await fs.readFile(skillMd, "utf8")).name).toBe("research");
  });

  it("produces a folder that add accepts right away", async () => {
    const { dir } = await initSkill(root, "fresh");
    const hub = await openHub(path.join(root, "hub"));
    await addSkill(hub, dir);
    expect((await listSkills(hub)).map((s) => s.name)).toEqual(["fresh"]);
  });

  it("never overwrites an existing folder", async () => {
    await fs.mkdir(path.join(root, "taken"));
    await fs.writeFile(path.join(root, "taken", "notes.md"), "keep");
    await expectCode(initSkill(root, "taken"), "SKILL_EXISTS");
    expect(await listDir(path.join(root, "taken"))).toEqual(["notes.md"]);
  });

  it("never overwrites an existing SKILL.md", async () => {
    const here = path.join(root, "existing");
    await fs.mkdir(here);
    await fs.writeFile(path.join(here, "SKILL.md"), "mine");
    await expectCode(initSkill(here), "SKILL_EXISTS");
    expect(await fs.readFile(path.join(here, "SKILL.md"), "utf8")).toBe("mine");
  });

  it("rejects names that are not valid skill names and creates nothing", async () => {
    await expectCode(initSkill(root, "has space"), "INVALID_SKILL_NAME");
    await expectCode(initSkill(root, "-leading"), "INVALID_SKILL_NAME");
    expect(await listDir(root)).toEqual([]);
  });
});
