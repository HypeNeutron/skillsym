import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emptyManifest,
  inspectLocalGitSource,
  openHub,
  parseRemoteTarget,
  readManifest,
  runGit,
  SkillsymError,
  syncRemoteClone,
  writeManifest,
  type Hub,
} from "../src/index.js";
import { makeSkill, makeTempDir, removeDir } from "./helpers.js";

let root: string;
let hub: Hub;

beforeEach(async () => {
  root = await makeTempDir("skillsym-remote-");
  hub = await openHub(path.join(root, "hub"));
});

afterEach(async () => {
  await removeDir(root);
});

async function initGitRepo(dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  await runGit(["init", "-b", "main"], dir);
  await runGit(["config", "user.email", "test@skillsym.dev"], dir);
  await runGit(["config", "user.name", "SkillSym Test"], dir);
  await makeSkill(path.join(dir, "skills"), "alpha", { "notes.md": "v1\n" });
  await runGit(["add", "."], dir);
  await runGit(["commit", "-m", "initial commit"], dir);
  return (await runGit(["rev-parse", "HEAD"], dir)).trim();
}

describe("parseRemoteTarget", () => {
  it("parses GitHub shorthand, @ref, /tree/<ref>/<subpath> URLs, SSH, and file:// URLs", async () => {
    expect(await parseRemoteTarget("vercel-labs/skills", root)).toEqual({
      url: "https://github.com/vercel-labs/skills.git",
      label: "vercel-labs/skills",
      slug: "vercel-labs--skills",
      subpath: "",
    });

    expect(await parseRemoteTarget("vercel-labs/skills@v1.2.3", root)).toEqual({
      url: "https://github.com/vercel-labs/skills.git",
      label: "vercel-labs/skills",
      slug: "vercel-labs--skills--v1.2.3",
      ref: "v1.2.3",
      subpath: "",
    });

    expect(await parseRemoteTarget("https://github.com/vercel-labs/skills/tree/main/skills/find-skills", root)).toEqual({
      url: "https://github.com/vercel-labs/skills.git",
      label: "vercel-labs/skills",
      slug: "vercel-labs--skills--main",
      ref: "main",
      subpath: "skills/find-skills",
    });

    expect(await parseRemoteTarget("git@github.com:org/repo.git", root)).toEqual({
      url: "git@github.com:org/repo.git",
      label: "org/repo",
      slug: "org--repo",
      subpath: "",
    });

    const repoUrl = pathToFileURL(path.join(root, "upstream")).toString();
    const parsedFile = await parseRemoteTarget(repoUrl, root);
    expect(parsedFile).toMatchObject({ url: repoUrl, subpath: "" });
  });

  it("defers to existing local directories matching owner/repo shorthand", async () => {
    await makeSkill(path.join(root, "org"), "my-skill");
    expect(await parseRemoteTarget("org/my-skill", root)).toBeNull();
  });

  it("rejects malformed GitHub /blob/ or incomplete URLs", async () => {
    await expect(parseRemoteTarget("https://github.com/only-owner", root)).rejects.toThrow(SkillsymError);
    await expect(parseRemoteTarget("https://github.com/owner/repo/blob/main/SKILL.md", root)).rejects.toThrow(SkillsymError);
  });
});

describe("manifest remote schema", () => {
  it("round-trips optional remote metadata cleanly in manifest.json v1", async () => {
    const manifest = emptyManifest();
    manifest.skills["alpha"] = {
      agents: ["claude"],
      mode: "link",
      scope: "user",
      source: path.join(hub.remotesDir, "owner--repo", "skills", "alpha"),
      sourceHash: "abc123",
      remote: { url: "https://github.com/owner/repo.git", ref: "main", subpath: "skills/alpha", commit: "deadbeef" },
    };
    await writeManifest(hub.manifestPath, manifest);
    const readBack = await readManifest(hub.manifestPath);
    expect(readBack.skills["alpha"]?.remote).toEqual({
      url: "https://github.com/owner/repo.git",
      ref: "main",
      subpath: "skills/alpha",
      commit: "deadbeef",
    });
  });

  it("rejects malformed remote objects inside manifest.json", async () => {
    await fs.writeFile(
      hub.manifestPath,
      JSON.stringify({
        version: 1,
        skills: { broken: { agents: [], mode: "link", scope: "user", remote: { url: "https://x" } } },
      }),
    );
    await expect(readManifest(hub.manifestPath)).rejects.toThrow(SkillsymError);
  });
});

describe("syncRemoteClone & inspectLocalGitSource", () => {
  it("clones a local git repo into remotes/, fetches new commits, and checks out tags", async () => {
    const upstream = path.join(root, "upstream");
    const c1 = await initGitRepo(upstream);
    await runGit(["tag", "v1.0.0"], upstream);

    const fileUrl = pathToFileURL(upstream).toString();
    const target = (await parseRemoteTarget(fileUrl, root))!;
    const first = await syncRemoteClone(hub, target);
    expect(first.commit).toBe(c1);
    expect(first.repoDir).toBe(path.join(hub.remotesDir, target.slug));
    expect(await fs.readFile(path.join(first.repoDir, "skills", "alpha", "notes.md"), "utf8")).toBe("v1\n");

    // Advance upstream with a second commit.
    await fs.writeFile(path.join(upstream, "skills", "alpha", "notes.md"), "v2\n");
    await runGit(["add", "."], upstream);
    await runGit(["commit", "-m", "v2 update"], upstream);
    const c2 = (await runGit(["rev-parse", "HEAD"], upstream)).trim();

    const second = await syncRemoteClone(hub, target);
    expect(second.commit).toBe(c2);
    expect(await fs.readFile(path.join(second.repoDir, "skills", "alpha", "notes.md"), "utf8")).toBe("v2\n");

    // Check out v1.0.0 tag explicitly.
    const pinnedTarget = (await parseRemoteTarget(`${fileUrl}#v1.0.0`, root))!;
    const pinned = await syncRemoteClone(hub, pinnedTarget);
    expect(pinned.commit).toBe(c1);
    expect(await fs.readFile(path.join(pinned.repoDir, "skills", "alpha", "notes.md"), "utf8")).toBe("v1\n");
  });

  it("inspects local git repositories including origin remote if present", async () => {
    const bare = path.join(root, "bare.git");
    await runGit(["init", "--bare", bare]);
    const localRepo = path.join(root, "local-repo");
    const c1 = await initGitRepo(localRepo);
    await runGit(["remote", "add", "origin", pathToFileURL(bare).toString()], localRepo);

    const info = await inspectLocalGitSource(path.join(localRepo, "skills", "alpha"));
    expect(info).toEqual({
      root: await fs.realpath(localRepo),
      url: pathToFileURL(bare).toString(),
      commit: c1,
      subpath: "skills/alpha",
    });

    const plainDir = await makeSkill(path.join(root, "plain"), "beta");
    expect(await inspectLocalGitSource(plainDir)).toBeNull();
  });
});
