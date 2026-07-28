import { describe, it, expect } from "vitest";
import { ConcurrencyManager } from "../src/concurrency.js";
import { SecurityError } from "../src/security.js";

/**
 * Concurrency tests: global slot limit and per-directory write lock.
 */

describe("ConcurrencyManager - global limit", () => {
  it("reports active count and limit", async () => {
    const cm = new ConcurrencyManager(2);
    expect(cm.limit).toBe(2);
    expect(cm.activeCount).toBe(0);
    const r1 = await cm.acquire();
    expect(cm.activeCount).toBe(1);
    r1();
    expect(cm.activeCount).toBe(0);
  });

  it("queues acquisitions beyond the limit and releases in order", async () => {
    const cm = new ConcurrencyManager(1);
    const r1 = await cm.acquire();
    expect(cm.activeCount).toBe(1);

    let secondAcquired = false;
    const p2 = cm.acquire().then((release) => {
      secondAcquired = true;
      return release;
    });

    // The second acquire must not resolve while the slot is held.
    await new Promise((r) => setTimeout(r, 20));
    expect(secondAcquired).toBe(false);

    r1(); // free the slot
    const r2 = await p2;
    expect(secondAcquired).toBe(true);
    r2();
  });

  it("never exceeds the configured limit under load", async () => {
    const cm = new ConcurrencyManager(3);
    let current = 0;
    let peak = 0;
    const task = async () => {
      const release = await cm.acquire();
      current++;
      peak = Math.max(peak, current);
      await new Promise((r) => setTimeout(r, 10));
      current--;
      release();
    };
    await Promise.all(Array.from({ length: 20 }, task));
    expect(peak).toBeLessThanOrEqual(3);
    expect(cm.activeCount).toBe(0);
  });
});

describe("ConcurrencyManager - write lock", () => {
  it("rejects a second write task for the same directory", async () => {
    const cm = new ConcurrencyManager(5);
    const release = await cm.acquire("/work/dir");
    await expect(cm.acquire("/work/dir")).rejects.toBeInstanceOf(SecurityError);
    await expect(cm.acquire("/work/dir")).rejects.toMatchObject({
      code: "write_lock_conflict",
    });
    release();
    // After release the lock is free again.
    const release2 = await cm.acquire("/work/dir");
    release2();
  });

  it("allows concurrent writes to different directories", async () => {
    const cm = new ConcurrencyManager(5);
    const r1 = await cm.acquire("/work/a");
    const r2 = await cm.acquire("/work/b");
    expect(cm.activeCount).toBe(2);
    r1();
    r2();
  });

  it("allows read tasks (no writeDir) to run concurrently on same dir", async () => {
    const cm = new ConcurrencyManager(5);
    const r1 = await cm.acquire();
    const r2 = await cm.acquire();
    expect(cm.activeCount).toBe(2);
    r1();
    r2();
  });

  it("release is idempotent", async () => {
    const cm = new ConcurrencyManager(2);
    const release = await cm.acquire("/x");
    release();
    release(); // second call must be a no-op
    expect(cm.activeCount).toBe(0);
  });
});
