/**
 * `rename` for the temp-file-then-rename atomic writes, retried through the
 * transient Windows sharing violations.
 *
 * On Windows, replacing a file fails with EPERM / EACCES / EBUSY while ANY other
 * process holds the destination open without FILE_SHARE_DELETE — Defender and
 * the Search indexer open a file the instant it changes. The alignment step
 * saves pipeline.json on every progress tick, so it lost that race often enough
 * that users learned "step 7 fails with EPERM … rename … pipeline.json; just
 * run it again". The handle is gone within milliseconds, so a short bounded
 * retry (the same remedy graceful-fs applies) turns the failure into a pause.
 * POSIX rename never fails this way, so there the first attempt simply wins.
 */
import fsp from 'node:fs/promises';

/** Error codes Windows reports for a destination another process holds open. */
const TRANSIENT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Injectable I/O, for tests. */
export interface RenameRetryDeps {
  rename?: (from: string, to: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** Total time budget across retries (default 2000 ms). */
  budgetMs?: number;
}

/**
 * Rename `from` over `to`, retrying transient sharing violations with a
 * growing backoff for up to `budgetMs`. On final failure the temp file is
 * removed (best-effort) and the last error is rethrown, so a failed save never
 * leaves a `.tmp` behind in the workspace.
 */
export async function renameWithRetry(from: string, to: string, deps: RenameRetryDeps = {}): Promise<void> {
  const rename = deps.rename ?? fsp.rename;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const budgetMs = deps.budgetMs ?? 2000;
  let waited = 0;
  let delay = 10;
  for (;;) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !TRANSIENT_CODES.has(code) || waited >= budgetMs) {
        await fsp.rm(from, { force: true }).catch(() => {
          /* best-effort */
        });
        throw err;
      }
      const step = Math.min(delay, budgetMs - waited);
      await sleep(step);
      waited += step;
      delay = Math.min(delay * 2, 250);
    }
  }
}
