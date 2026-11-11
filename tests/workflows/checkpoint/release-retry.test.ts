import { describe, expect, test } from "bun:test";
import { renameRetryingBlocked } from "../../../src/workflows/checkpoint/file-system-checkpoint-store.js";
import {
  BLOCKED_RENAME_BUDGET_MS,
  renameRetryingBlockedSync,
} from "../../../src/workflows/internal/blocked-rename.js";

/** A rename that fails with each code in `codes` in turn, then succeeds. */
function failing(codes: string[]): {
  run: () => Promise<void>;
  calls: () => number;
} {
  let calls = 0;
  return {
    run: async () => {
      const code = codes[calls];
      calls += 1;
      if (code) throw Object.assign(new Error(code), { code });
    },
    calls: () => calls,
  };
}

/** The store's lock release rename, with `step` as the file system's rename. */
const release = (step: ReturnType<typeof failing>) =>
  renameRetryingBlocked("lock", "lock.retired", step.run);

// On Windows a directory cannot be renamed while a waiter has it open. The
// store's lock release retries that rename; the fault fixtures retire their
// locks with the same function.
describe("checkpoint lock release rename", () => {
  test("a release blocked once by EPERM succeeds on retry", async () => {
    const step = failing(["EPERM"]);

    await release(step);
    expect(step.calls()).toBe(2);
  });

  test("EBUSY and EACCES are retried too", async () => {
    const step = failing(["EBUSY", "EACCES"]);

    await release(step);
    expect(step.calls()).toBe(3);
  });

  test("any other error is not retried", async () => {
    const step = failing(["ENOENT"]);

    await expect(release(step)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(step.calls()).toBe(1);
  });

  test("a release that stays blocked fails once the time budget is spent", async () => {
    const clock = fakeClock();
    let calls = 0;
    // A runaway retry loop must fail an assertion, not hang the run: after
    // RUNAWAY_CALLS the rename reports a different code, which is thrown at once.
    const run = async () => {
      calls += 1;
      const code = calls > RUNAWAY_CALLS ? "RUNAWAY" : "EPERM";
      throw Object.assign(new Error(code), { code });
    };

    await expect(
      renameRetryingBlocked("lock", "lock.retired", run, {
        budgetMs: 1000,
        ...clock.options,
      }),
    ).rejects.toMatchObject({ code: "EPERM" });
    // The error says how long it waited: the whole budget.
    await expect(
      renameRetryingBlocked("lock", "lock.retired", run, {
        budgetMs: 1000,
        ...fakeClock().options,
      }),
    ).rejects.toMatchObject({ code: "EPERM", waitedMs: 1000 });
    // Bounded: it stopped at the budget, not before and not long after.
    expect(clock.elapsed()).toBeGreaterThanOrEqual(1000);
    expect(clock.elapsed()).toBeLessThan(1000 + 1);
    expect(calls).toBeGreaterThan(5);
    expect(calls).toBeLessThan(1000);
  });
});

/** Calls after which a stuck rename in these tests reports `RUNAWAY`. */
const RUNAWAY_CALLS = 10_000;

/** A clock that only moves when the code under test sleeps. */
function fakeClock(random = 0.5) {
  let now = 0;
  const pauses: number[] = [];
  return {
    pauses,
    elapsed: () => now,
    options: {
      now: () => now,
      random: () => random,
      sleep: async (ms: number) => {
        pauses.push(ms);
        now += ms;
      },
      sleepSync: (ms: number) => {
        pauses.push(ms);
        now += ms;
      },
    },
  };
}

describe("blocked rename time budget and backoff", () => {
  test("a rename blocked many times within the budget succeeds", async () => {
    const clock = fakeClock();
    const step = failing(Array.from({ length: 12 }, () => "EBUSY"));

    await renameRetryingBlocked("a", "b", step.run, {
      budgetMs: 5000,
      ...clock.options,
    });
    expect(step.calls()).toBe(13);
    expect(clock.elapsed()).toBeLessThan(5000);
  });

  test("pauses grow exponentially, are capped, and never exceed the budget left", async () => {
    const clock = fakeClock(0.999);
    const step = failing(Array.from({ length: 12 }, () => "EPERM"));

    await renameRetryingBlocked("a", "b", step.run, {
      budgetMs: 100_000,
      ...clock.options,
    });
    expect(clock.pauses.slice(0, 6)).toEqual([5, 10, 20, 40, 80, 160]);
    expect(Math.max(...clock.pauses)).toBe(250);

    const tight = fakeClock(0.999);
    const never = failing(Array.from({ length: 50 }, () => "EPERM"));
    await expect(
      renameRetryingBlocked("a", "b", never.run, {
        budgetMs: 30,
        ...tight.options,
      }),
    ).rejects.toMatchObject({ code: "EPERM" });
    expect(tight.elapsed()).toBe(30);
  });

  test("pauses are jittered: the random draw scales each one, never below 1 ms", async () => {
    const low = fakeClock(0);
    await renameRetryingBlocked(
      "a",
      "b",
      failing(["EPERM", "EPERM", "EPERM"]).run,
      low.options,
    );
    expect(low.pauses).toEqual([1, 1, 1]);

    const mid = fakeClock(0.5);
    await renameRetryingBlocked(
      "a",
      "b",
      failing(["EPERM", "EPERM", "EPERM"]).run,
      mid.options,
    );
    expect(mid.pauses).toEqual([3, 5, 10]);
  });

  test("a non-blocked error is thrown at once, without a pause", async () => {
    const clock = fakeClock();
    const step = failing(["EIO"]);

    await expect(
      renameRetryingBlocked("a", "b", step.run, clock.options),
    ).rejects.toMatchObject({ code: "EIO" });
    expect(step.calls()).toBe(1);
    expect(clock.pauses).toEqual([]);
  });

  test("the default budget is five seconds", () => {
    expect(BLOCKED_RENAME_BUDGET_MS).toBe(5000);
  });

  test("the synchronous variant has the same policy", () => {
    const clock = fakeClock(0.999);
    let calls = 0;
    const blockedTwice = () => {
      calls += 1;
      if (calls <= 2)
        throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
    };
    renameRetryingBlockedSync("a", "b", blockedTwice, clock.options);
    expect(calls).toBe(3);
    expect(clock.pauses).toEqual([5, 10]);
  });

  test("the synchronous variant throws a non-blocked error at once, without a pause", () => {
    const clock = fakeClock();
    let calls = 0;
    const notBlocked = () => {
      calls += 1;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };

    expect(() =>
      renameRetryingBlockedSync("a", "b", notBlocked, clock.options),
    ).toThrow("ENOENT");
    expect(calls).toBe(1);
    expect(clock.pauses).toEqual([]);
  });

  test("the synchronous variant fails once the time budget is spent", () => {
    const clock = fakeClock();
    let calls = 0;
    // Fails an assertion, not a hang, if the budget is ignored.
    const stuck = () => {
      calls += 1;
      const code = calls > RUNAWAY_CALLS ? "RUNAWAY" : "EACCES";
      throw Object.assign(new Error(code), { code });
    };

    expect(() =>
      renameRetryingBlockedSync("a", "b", stuck, {
        budgetMs: 50,
        ...clock.options,
      }),
    ).toThrow("EACCES");
    expect(clock.elapsed()).toBe(50);
    let thrown: unknown;
    try {
      renameRetryingBlockedSync("a", "b", stuck, {
        budgetMs: 50,
        ...fakeClock().options,
      });
    } catch (error) {
      thrown = error;
    }
    // The error says how long it waited: the whole budget.
    expect(thrown).toMatchObject({ code: "EACCES", waitedMs: 50 });
    expect(calls).toBeLessThan(RUNAWAY_CALLS);
  });
});
