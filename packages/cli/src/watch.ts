import { SkillsymError } from "@skillsym/core";

/** How long the hub's skills folder must be quiet before watch acts. */
export const SETTLE_MS = 2000;

/** What one sync run left to say: lines to print, and hub folders still not registered. */
export interface WatchRun {
  lines: string[];
  unregistered: { name: string; reason?: string }[];
}

/** Everything watch needs from the outside, so tests can drive it with fake events and timers. */
export interface WatchDeps {
  /** Start watching the hub's skills folder; call `onEvent` for every change. Returns a handle to stop it. */
  watch: (onEvent: () => void) => { close: () => void };
  /** Sync once, never asking. */
  run: () => Promise<WatchRun>;
  print: (line: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  settleMs?: number;
}

export interface Watching {
  /** Resolves when the start-up sync has finished. */
  started: Promise<void>;
  close: () => void;
}

/**
 * Sync once at start, then again after the folder has been quiet for `settleMs`: a burst of events
 * (a skill being copied in) is one run. A busy hub (lock held by another command) is retried at the
 * next tick rather than treated as a failure.
 */
export function startWatching(deps: WatchDeps): Watching {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  const settleMs = deps.settleMs ?? SETTLE_MS;
  let timer: unknown;
  let running: Promise<void> | undefined;
  let again = false;
  let closed = false;
  // Names already told about, so an unchanged skill is not repeated every tick.
  const hinted = new Set<string>();

  const schedule = () => {
    if (closed) return;
    if (timer !== undefined) clearTimer(timer);
    timer = setTimer(() => {
      timer = undefined;
      void trigger();
    }, settleMs);
  };

  async function once(): Promise<void> {
    try {
      const result = await deps.run();
      for (const line of result.lines) deps.print(line);
      const now = new Set(result.unregistered.map((u) => u.name));
      for (const name of hinted) if (!now.has(name)) hinted.delete(name);
      for (const u of result.unregistered) {
        if (hinted.has(u.name)) continue;
        hinted.add(u.name);
        deps.print(
          u.reason === "name-mismatch"
            ? `new skill ${u.name} not registered: its SKILL.md name differs from the folder name`
            : `new skill ${u.name} not registered: set newSkills.agents in config.json or run skillsym sync`,
        );
      }
    } catch (err) {
      if (err instanceof SkillsymError && err.code === "LOCK_TIMEOUT") {
        deps.print("hub is busy (another skillsym command is running); will retry shortly");
        schedule();
      } else deps.print(`watch: ${(err as Error).message}`);
    }
  }

  function trigger(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await once();
      } while (again && !closed);
    })().finally(() => {
      running = undefined;
    });
    return running;
  }

  const handle = deps.watch(schedule);
  const started = trigger();
  return {
    started,
    close: () => {
      closed = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      handle.close();
    },
  };
}
