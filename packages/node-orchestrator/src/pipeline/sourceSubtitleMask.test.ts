import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectSettings } from '@videodubber/shared';
import { describeSourceMask, maskSampleTimes, sourceSubtitleMaskInput } from './sourceSubtitleMask.js';

describe('maskSampleTimes', () => {
  it('samples cue midpoints as speech and long gaps (and a quiet lead-in) as quiet', () => {
    const t = maskSampleTimes([
      { startMs: 2000, endMs: 4000 },
      { startMs: 4200, endMs: 6000 }, // 200ms gap: too short to be quiet
      { startMs: 8000, endMs: 9000 },
    ]);
    expect(t.speechTimesMs).toEqual([3000, 5100, 8500]);
    expect(t.quietTimesMs).toEqual([1000, 7000]);
  });
});

describe('sourceSubtitleMaskInput', () => {
  let dir: string;
  const settings = (mask: unknown) => ({ sourceSubtitleMask: mask }) as unknown as ProjectSettings;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vd-mask-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is undefined when off, unset, or an unknown mode', async () => {
    const src = path.join(dir, 'source.json');
    expect(await sourceSubtitleMaskInput(settings(undefined), src)).toBeUndefined();
    expect(await sourceSubtitleMaskInput(settings({ mode: 'off' }), src)).toBeUndefined();
    expect(await sourceSubtitleMaskInput(settings({ mode: 'erase' }), src)).toBeUndefined();
  });

  it('passes a valid manual region through without reading the transcript', async () => {
    const region = { x: 0, y: 0.7, width: 1, height: 0.06 };
    expect(await sourceSubtitleMaskInput(settings({ mode: 'blur', region }), path.join(dir, 'missing.json'))).toEqual({
      mode: 'blur',
      region,
    });
  });

  it('auto-detects from transcript times when no (valid) region is set', async () => {
    const src = path.join(dir, 'source.json');
    await writeFile(src, JSON.stringify({ segments: [{ startMs: 0, endMs: 2000 }, { startMs: 3000, endMs: 5000 }] }));
    expect(await sourceSubtitleMaskInput(settings({ mode: 'box', region: { x: 0, y: 2, width: 1, height: 1 } }), src)).toEqual({
      mode: 'box',
      speechTimesMs: [1000, 4000],
      quietTimesMs: [2500],
    });
  });

  it('logs the covered band', () => {
    const line = describeSourceMask(
      { outputPath: 'o', durationMs: 1, sidecarSubtitlePaths: [], sourceSubtitleMask: { region: { x: 0, y: 0.6988, width: 1, height: 0.0643 }, detected: true } },
      'blur',
    );
    expect(line).toBe('Source subtitles hidden (blur) over detected region: y 69.9%–76.3%, x 0%–100%.');
  });
});
