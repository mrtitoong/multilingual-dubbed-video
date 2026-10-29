import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renameWithRetry } from './atomicRename.js';

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
}

describe('renameWithRetry', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vd-rename-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('rides out a transient Windows sharing violation (the step-7 pipeline.json EPERM)', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    await renameWithRetry('a.tmp', 'pipeline.json', {
      rename: async () => {
        calls++;
        if (calls < 3) throw errno(calls === 1 ? 'EPERM' : 'EBUSY');
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([10, 20]);
  });

  it('gives up after its time budget, rethrows, and removes the temp file', async () => {
    const tmp = path.join(dir, '.pipeline.json.abc.tmp');
    await writeFile(tmp, '{}');
    let waited = 0;
    await expect(
      renameWithRetry(tmp, path.join(dir, 'pipeline.json'), {
        rename: async () => {
          throw errno('EACCES');
        },
        sleep: async (ms) => {
          waited += ms;
        },
        budgetMs: 500,
      }),
    ).rejects.toMatchObject({ code: 'EACCES' });
    expect(waited).toBe(500);
    expect(await readdir(dir)).toEqual([]);
  });

  it('does not retry an error that will not clear (e.g. ENOENT)', async () => {
    let calls = 0;
    await expect(
      renameWithRetry('a.tmp', 'b', {
        rename: async () => {
          calls++;
          throw errno('ENOENT');
        },
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(calls).toBe(1);
  });

  it('replaces an existing file on the real filesystem', async () => {
    const dest = path.join(dir, 'pipeline.json');
    const tmp = path.join(dir, '.pipeline.json.x.tmp');
    await writeFile(dest, 'old');
    await writeFile(tmp, 'new');
    await renameWithRetry(tmp, dest);
    expect(await readFile(dest, 'utf8')).toBe('new');
    expect(await readdir(dir)).toEqual(['pipeline.json']);
  });
});
