import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillsymError, sync, builtinAgents, openHub, readLinkTarget, type Hub } from "@skillsym/core";
import { makeSkill, makeTempDir, removeDir } from "../../core/test/helpers.js";
import { main, type Io } from "../dist/main.js";
import { SETTLE_MS, startWatching, type WatchRun } from "../dist/watch.js";

/** Timers and a watcher the test drives by hand: nothing here waits for real time. */
function harness(run: () => Promise<WatchRun>) {
  const lines: string[] = [];
  let emit = () => {};
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 1;
  let closed = false;
  const watching = startWatching({
    watch: (onEvent) => {
      emit = onEvent;
      return { close: () => void (closed = true) };
    },
    run,
    print: (l) => lines.push(l),
    setTimer: (fn, ms) => (timers.set(nextId, { fn, ms }), nextId++),
    clearTimer: (h) => void timers.delete(h as number),
  });
  const settle = async () => {
    for (const [id, t] of [...timers]) {
      timers.delete(id);
      t.fn();
    }
    // Let the run that the timer started finish.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  return { watching, lines, emit: () => emit(), settle, timers, isClosed: () => closed };
}

const quiet: WatchRun = { lines: [], unregistered: [] };

describe("watch trigger logic", () => {
  it("syncs once at start, before any event", async () => {
    let runs = 0;
    const h = harness(async () => (runs++, { lines: ["linked foo -> claude"], unregistered: [] }));
    await h.watching.started;
    expect(runs).toBe(1);
    expect(h.lines).toEqual(["linked foo -> claude"]);
    h.watching.close();
  });

  it("a burst of events is one sync, after the settle time", async () => {
    let runs = 0;
    const h = harness(async () => (runs++, quiet));
    await h.watching.started;
    for (let i = 0; i < 10; i++) h.emit();
    expect(h.timers.size).toBe(1);
    expect([...h.timers.values()][0]!.ms).toBe(SETTLE_MS);
    expect(runs).toBe(1);
    await h.settle();
    expect(runs).toBe(2);
    h.watching.close();
  });

  it("prints the not-registered hint once per skill, and again only if it comes back", async () => {
    let unregistered = [{ name: "foo" }];
    const h = harness(async () => ({ lines: [], unregistered }));
    await h.watching.started;
    h.emit();
    await h.settle();
    expect(h.lines).toEqual(["new skill foo not registered: set newSkills.agents in config.json or run skillsym sync"]);
    unregistered = [];
    h.emit();
    await h.settle();
    unregistered = [{ name: "foo" }];
    h.emit();
    await h.settle();
    expect(h.lines).toHaveLength(2);
    h.watching.close();
  });

  it("a held lock prints a line and retries at the next tick instead of crashing", async () => {
    let calls = 0;
    const h = harness(async () => {
      calls++;
      if (calls === 1) throw new SkillsymError("LOCK_TIMEOUT", "busy");
      return { lines: ["linked foo -> claude"], unregistered: [] };
    });
    await h.watching.started;
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toContain("busy");
    expect(h.timers.size).toBe(1);
    await h.settle();
    expect(calls).toBe(2);
    expect(h.lines.at(-1)).toBe("linked foo -> claude");
    h.watching.close();
  });

  it("other errors are printed and watching goes on", async () => {
    let calls = 0;
    const h = harness(async () => {
      if (calls++ === 0) throw new Error("boom");
      return quiet;
    });
    await h.watching.started;
    expect(h.lines).toEqual(["watch: boom"]);
    h.emit();
    await h.settle();
    expect(calls).toBe(2);
    h.watching.close();
  });

  it("close stops the watcher and drops a pending run", async () => {
    let runs = 0;
    const h = harness(async () => (runs++, quiet));
    await h.watching.started;
    h.emit();
    h.watching.close();
    expect(h.isClosed()).toBe(true);
    expect(h.timers.size).toBe(0);
    expect(runs).toBe(1);
  });
});

describe("watch with a real hub", () => {
  let root: string;
  let userHome: string;
  let hub: Hub;

  beforeEach(async () => {
    root = await makeTempDir("skillsym-watch-");
    userHome = path.join(root, "user");
    await fs.mkdir(path.join(userHome, ".claude"), { recursive: true });
    hub = await openHub(path.join(root, "hub"));
  });

  afterEach(async () => {
    await removeDir(root);
  });

  it("the start-up sync links a skill made while watch was off", async () => {
    await fs.writeFile(hub.configPath, JSON.stringify({ version: 1, agents: [], newSkills: { agents: ["claude"] } }));
    await makeSkill(hub.skillsDir, "foo");
    const profiles = builtinAgents(userHome);
    const h = harness(async () => {
      const r = await sync(hub, { profiles });
      return { lines: r.registrations.map((x) => `registered ${x.skill}`), unregistered: r.unregistered };
    });
    await h.watching.started;
    h.watching.close();
    expect(h.lines).toEqual(["registered foo"]);
    expect(await readLinkTarget(path.join(userHome, ".claude", "skills", "foo"))).toBe(path.join(hub.skillsDir, "foo"));
  });
});

describe("watch command line", () => {
  function io(root: string): Io {
    const userHome = path.join(root, "user");
    return {
      stdout: () => {},
      stderr: () => {},
      env: { SKILLSYM_HOME: path.join(root, "hub"), HOME: userHome, USERPROFILE: userHome },
    };
  }

  it.each([["--dry-run"], ["-y"], ["--json"]])("refuses %s", async (flag) => {
    const root = await makeTempDir("skillsym-watch-");
    try {
      expect(await main(["watch", flag], io(root))).toBe(2);
    } finally {
      await removeDir(root);
    }
  });
});
