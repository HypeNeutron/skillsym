import dns from "node:dns";
import { promises as fs } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashSkillDir } from "@skillsym/core";
import { makeSkill, makeTempDir, removeDir } from "../../core/test/helpers.js";
// The built CLI module, driven in-process so the network can be watched.
import { main, type Io } from "../dist/main.js";

let root: string;
let userHome: string;
let hubHome: string;
let out: string[];

beforeEach(async () => {
  root = await makeTempDir("skillsym-safety-");
  userHome = path.join(root, "user");
  hubHome = path.join(root, "hub");
  await fs.mkdir(path.join(userHome, ".claude"), { recursive: true });
  await fs.mkdir(path.join(userHome, ".cursor"), { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await removeDir(root);
});

function io(env: Record<string, string> = {}): Io {
  out = [];
  return {
    stdout: (t) => out.push(t),
    stderr: (t) => out.push(t),
    env: { SKILLSYM_HOME: hubHome, HOME: userHome, USERPROFILE: userHome, ...env },
    cwd: root,
    interactive: false,
  };
}

const dirLink = (target: string, at: string) => fs.symlink(target, at, process.platform === "win32" ? "junction" : "dir");

/**
 * Lay out what other tools leave behind: `npx skills` keeps a real copy in ~/.agents/skills with a
 * lock file, and links it into ~/.claude/skills; another tool links ~/.cursor/skills/ext elsewhere;
 * and a stray file sits in ~/.claude/skills.
 */
async function foreignLayout() {
  const agents = path.join(userHome, ".agents");
  await makeSkill(path.join(agents, "skills"), "vercel-skill", { "x.md": "npx skills" });
  await fs.writeFile(path.join(agents, ".skill-lock.json"), '{"version":3,"skills":{"vercel-skill":{}}}');
  await fs.mkdir(path.join(userHome, ".claude", "skills"), { recursive: true });
  await dirLink(path.join(agents, "skills", "vercel-skill"), path.join(userHome, ".claude", "skills", "vercel-skill"));
  const ext = await makeSkill(path.join(root, "elsewhere"), "ext");
  await fs.mkdir(path.join(userHome, ".cursor", "skills"), { recursive: true });
  await dirLink(ext, path.join(userHome, ".cursor", "skills", "ext"));
  await fs.writeFile(path.join(userHome, ".claude", "skills", "README.txt"), "not a skill");
}

/** Everything other tools own, captured so we can prove skillsym never changed it. */
async function foreignSnapshot() {
  const linkTarget = async (p: string) => {
    const st = await fs.lstat(p);
    return st.isSymbolicLink() ? `link:${path.resolve(path.dirname(p), await fs.readlink(p))}` : null;
  };
  const a = path.join(userHome, ".agents");
  return {
    canonical: await hashSkillDir(path.join(a, "skills", "vercel-skill")),
    canonicalIsReal: await linkTarget(path.join(a, "skills", "vercel-skill")),
    lock: await fs.readFile(path.join(a, ".skill-lock.json"), "utf8"),
    claudeLink: await linkTarget(path.join(userHome, ".claude", "skills", "vercel-skill")),
    cursorLink: await linkTarget(path.join(userHome, ".cursor", "skills", "ext")),
    ext: await hashSkillDir(path.join(root, "elsewhere", "ext")),
    readme: await fs.readFile(path.join(userHome, ".claude", "skills", "README.txt"), "utf8"),
  };
}

describe("hub in a cloud-synced folder", () => {
  it("warns before commands that write, and in status", async () => {
    hubHome = path.join(root, "OneDrive", "skillsym");
    const src = await makeSkill(path.join(root, "src"), "coding");

    await main(["add", src], io());
    expect(out.join("\n")).toMatch(/inside a OneDrive folder.*SKILLSYM_HOME/s);

    await main(["status", "--json"], io());
    expect(JSON.parse(out.join("")).warnings[0].code).toBe("HUB_IN_CLOUD_FOLDER");
  });

  it("stays quiet for an ordinary hub location", async () => {
    await main(["add", await makeSkill(path.join(root, "src"), "coding")], io());
    expect(out.join("\n")).not.toContain("warning");
  });
});

describe("-p / -g", () => {
  it.each([["add", "x"], ["assign", "x", "-a", "claude"], ["status"], ["sync"], ["import"], ["remove", "x"], ["eject"], ["init", "x"]])(
    "%s -p explains that project scope comes in v0.2 and changes nothing",
    async (...args) => {
      expect(await main([...args, "-p"], io())).toBe(2);
      expect(out.join("\n")).toContain("v0.2");
      await expect(fs.stat(hubHome)).rejects.toThrow();
    },
  );

  it("-g is accepted (user level is the default)", async () => {
    expect(await main(["status", "-g"], io())).toBe(0);
  });
});

describe("skillsym never touches what it did not create", () => {
  it("leaves npx skills' copies, links and lock file, other tools' links and stray files alone through every command", async () => {
    await foreignLayout();
    const before = await foreignSnapshot();
    const src = path.join(root, "src");

    const steps: string[][] = [
      ["add", await makeSkill(src, "mine"), "-a", "*", "-y"],
      // Same name as the npx skills copy: must be reported as blocked, not replaced.
      ["add", await makeSkill(src, "vercel-skill", { "other.md": "hub version" }), "-a", "claude,codex", "-y"],
      ["status"],
      ["check"],
      ["sync", "-y"],
      ["import", "-y"],
      ["remove", "mine", "-a", "cursor", "-y"],
      ["sync", "-y"],
      ["remove", "mine", "-y"],
      ["eject", "-y"],
      ["init", "new-skill"],
    ];
    for (const step of steps) {
      const code = await main(step, io());
      // 1 (something needs attention) is expected for some steps; 2 would mean a command broke.
      expect(code, `${step.join(" ")}\n${out.join("\n")}`).not.toBe(2);
    }

    expect(await foreignSnapshot()).toEqual(before);
  });

  it("reports npx skills' skills as unmanaged and import skips them", async () => {
    await foreignLayout();

    await main(["status", "--json"], io());
    const report = JSON.parse(out.join(""));
    expect(report.unmanaged.map((u: { name: string }) => u.name).sort()).toEqual(["ext", "vercel-skill", "vercel-skill"]);
    expect(report.clean).toBe(true);

    await main(["import", "--dry-run", "--json"], io());
    const plan = JSON.parse(out.join(""));
    expect(plan.items.every((i: { type: string }) => i.type === "skip")).toBe(true);
    expect(plan.items.map((i: { reason: string }) => i.reason).join("\n")).toContain("used by another tool");
  });
});

describe("no network access", () => {
  it("runs every command without opening a connection or resolving a name", async () => {
    const blocked = () => {
      throw new Error("network access attempted");
    };
    const spies = [
      vi.spyOn(net.Socket.prototype, "connect").mockImplementation(blocked),
      vi.spyOn(http, "request").mockImplementation(blocked),
      vi.spyOn(https, "request").mockImplementation(blocked),
      vi.spyOn(dns, "lookup").mockImplementation(blocked),
      vi.spyOn(globalThis, "fetch").mockImplementation(blocked),
    ];
    await foreignLayout();
    const src = path.join(root, "src");
    for (const step of [
      ["init", "fresh"],
      ["add", await makeSkill(src, "mine"), "-a", "claude"],
      ["status"],
      ["sync", "-y"],
      ["import", "-y"],
      ["remove", "mine", "-y"],
      ["eject", "-y"],
    ]) {
      await main(step, io());
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("commands that only look", () => {
  it("do not create the hub", async () => {
    await makeSkill(path.join(userHome, ".claude", "skills"), "mine");
    const lib = path.join(root, "lib");
    await makeSkill(lib, "from-lib");
    const steps = [
      ["status"],
      ["check"],
      ["list"],
      ["config"],
      ["sync", "--dry-run"],
      ["import", "--dry-run"],
      ["eject", "--dry-run"],
      ["add", lib, "--dry-run", "-a", "claude"],
      ["status", "--json"],
    ];
    for (const step of steps) {
      expect(await main(step, io()), step.join(" ")).toBeLessThan(2);
    }
    await expect(fs.access(hubHome)).rejects.toThrow();
    expect(out.join("\n")).toContain("mine");
  });
});
