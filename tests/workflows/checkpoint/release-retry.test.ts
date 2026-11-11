import { describe, expect, test } from "bun:test";
import { renameRetryingBlocked } from "../../../src/workflows/checkpoint/file-system-checkpoint-store.js";

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

  test("a release that stays blocked fails after 5 attempts", async () => {
    const step = failing([
      "EPERM",
      "EPERM",
      "EPERM",
      "EPERM",
      "EPERM",
      "EPERM",
    ]);

    await expect(release(step)).rejects.toMatchObject({
      code: "EPERM",
    });
    expect(step.calls()).toBe(5);
  });
});
