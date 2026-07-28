import { SecurityError } from "./security.js";

/**
 * Coordinates concurrent agent runs with two mechanisms:
 *
 *  1. A global semaphore capping the total number of simultaneous runs
 *     (AGENT_MAX_CONCURRENCY).
 *  2. A per-directory write lock ensuring at most one write task touches a
 *     given working directory at a time. Read tasks are not locked against
 *     each other, but a write task requires exclusive access to its cwd.
 *
 * The design is intentionally simple and in-process: this MCP server is a
 * single Node process, so a Set + counter is sufficient. It is not a
 * cross-process lock.
 */
export class ConcurrencyManager {
  private readonly maxConcurrency: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly writeLocks = new Set<string>();

  constructor(maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency;
  }

  /** Number of currently running tasks (for health reporting). */
  get activeCount(): number {
    return this.active;
  }

  /** Current global limit (for health reporting). */
  get limit(): number {
    return this.maxConcurrency;
  }

  /**
   * Acquires a global concurrency slot, waiting if the limit is reached, and
   * optionally acquires an exclusive write lock on `writeDir`.
   *
   * Returns a release function that MUST be called (in a finally block) to free
   * both the slot and the write lock.
   *
   * @throws SecurityError("write_lock_conflict") immediately if a write lock is
   *   requested for a directory that is already write-locked. This is a
   *   fail-fast rather than a queue, so callers get a clear conflict error.
   */
  async acquire(writeDir?: string): Promise<() => void> {
    if (writeDir !== undefined) {
      if (this.writeLocks.has(writeDir)) {
        throw new SecurityError(
          "write_lock_conflict",
          `Another write task is already running for directory: ${writeDir}`,
        );
      }
    }

    await this.acquireSlot();

    // Re-check the write lock after acquiring the slot (another task may have
    // taken it while we waited). If it conflicts now, release the slot and fail.
    if (writeDir !== undefined) {
      if (this.writeLocks.has(writeDir)) {
        this.releaseSlot();
        throw new SecurityError(
          "write_lock_conflict",
          `Another write task is already running for directory: ${writeDir}`,
        );
      }
      this.writeLocks.add(writeDir);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (writeDir !== undefined) {
        this.writeLocks.delete(writeDir);
      }
      this.releaseSlot();
    };
  }

  private acquireSlot(): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
}
