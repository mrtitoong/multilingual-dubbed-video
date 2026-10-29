import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineManager } from '../../engines/engineManager.js';
import { WhisperCppProvider } from './whisperCppProvider.js';

describe('WhisperCppProvider', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vd-wcpp-'));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it('asks for verbose_json and maps its segments (regression: `json` has no segments)', async () => {
    const audio = path.join(dir, 'a.wav');
    await writeFile(audio, 'RIFF');
    let sentFormat: FormDataEntryValue | null = null;
    vi.stubGlobal('fetch', async (_url: string, init: { body: FormData }) => {
      sentFormat = init.body.get('response_format');
      // Shape returned by whisper-server v1.8.6 for response_format=verbose_json.
      return new Response(
        JSON.stringify({
          task: 'transcribe',
          language: 'chinese',
          text: '兄弟们今天修复个烧坏的主板。我们用打磨机打磨干净。',
          segments: [
            { text: '兄弟们今天修复个烧坏的主板。', start: 0.0, end: 9.0 },
            { text: '我们用打磨机打磨干净。', start: 9.0, end: 20.0 },
          ],
        }),
        { status: 200 },
      );
    });
    const engines = { ensureRunning: async () => 'http://127.0.0.1:1' } as unknown as EngineManager;
    const provider = new WhisperCppProvider(engines, async () => 'whisper-cpp-cuda', 5000);

    const result = await provider.transcribe({ audioPath: audio, language: 'zh' } as never);

    expect(sentFormat).toBe('verbose_json');
    expect(result.segments.map((s) => [s.startMs, s.endMs, s.sourceText])).toEqual([
      [0, 9000, '兄弟们今天修复个烧坏的主板。'],
      [9000, 20000, '我们用打磨机打磨干净。'],
    ]);
  });
});
