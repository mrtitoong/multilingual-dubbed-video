/**
 * Hide the subtitles already burned into a source video (hardsubs).
 *
 * Dubbing a Chinese short drew the Vietnamese subtitles under a picture that
 * still carried the Chinese ones — two languages stacked on screen. This module
 * finds the band the source subtitles occupy and builds the ffmpeg filter that
 * blurs or covers it, applied BEFORE the dub's own subtitles are burned.
 *
 * Where the band is cannot be assumed: in the reporting video (720x1280
 * portrait) the hardsubs sat at ~72% of the height, well above the bottom edge
 * a fixed "lower fifth" default would have covered. So the band is detected:
 *
 *   - frames are sampled while the source SPEAKS (its subtitles are on screen)
 *     and while it is QUIET (they usually are not), as small grayscale images;
 *   - each row is scored by how many sharp horizontal edges it has — text is
 *     the densest edge texture in a frame, and subtitle text sits in the same
 *     rows cue after cue while the scene behind it keeps changing;
 *   - the per-row MEDIAN over speech frames, minus the median over quiet ones,
 *     keeps the rows that are text only while people talk, which removes static
 *     overlays (channel logos, watermarks) that are there all the time.
 *
 * Detection is pure ({@link detectSubtitleBand}) and unit-tested on synthetic
 * frames; only {@link resolveSourceSubtitleRegion} touches ffmpeg.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedRect, SourceSubtitleMaskMode } from '@videodubber/shared';
import { runFfmpeg, type RunOptions } from './exec.js';

/** A grayscale frame, one byte per pixel, row-major. */
export interface GrayFrame {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** Used when detection finds nothing convincing: the conventional lower band. */
export const DEFAULT_SOURCE_SUBTITLE_REGION: NormalizedRect = { x: 0.04, y: 0.8, width: 0.92, height: 0.14 };

/** Width the sampled frames are scaled to (height follows the aspect ratio). */
const SAMPLE_WIDTH = 192;
/** Neighbouring-pixel difference that counts as a "sharp" edge (0..255). */
const EDGE_THRESHOLD = 48;
/** Most frames sampled per class — enough for a stable median, cheap to grab. */
const MAX_SAMPLES = 24;

/** Fraction of each row's pixels that sit on a sharp horizontal edge. */
function rowEdgeDensity(f: GrayFrame): Float64Array {
  const out = new Float64Array(f.height);
  for (let y = 0; y < f.height; y++) {
    const row = y * f.width;
    let n = 0;
    for (let x = 0; x + 1 < f.width; x++) {
      if (Math.abs(f.pixels[row + x]! - f.pixels[row + x + 1]!) > EDGE_THRESHOLD) n++;
    }
    out[y] = n / Math.max(1, f.width - 1);
  }
  return out;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Per-row median of edge density across frames (all must share dimensions). */
function medianProfile(frames: readonly GrayFrame[], height: number): Float64Array {
  const profiles = frames.map(rowEdgeDensity);
  const out = new Float64Array(height);
  for (let y = 0; y < height; y++) out[y] = median(profiles.map((p) => p[y]!));
  return out;
}

/**
 * Find the hardsub band from frames sampled while the source speaks, against
 * frames sampled while it is quiet. Returns the region padded for blur/cover,
 * or undefined when no row band stands out (a video without hardsubs). Pure.
 */
export function detectSubtitleBand(
  speech: readonly GrayFrame[],
  quiet: readonly GrayFrame[] = [],
): NormalizedRect | undefined {
  if (speech.length < 3) return undefined;
  const { width, height } = speech[0]!;
  const same = (f: GrayFrame) => f.width === width && f.height === height;
  if (!speech.every(same) || !quiet.every(same)) return undefined;

  const talk = medianProfile(speech, height);
  const base = quiet.length >= 3 ? medianProfile(quiet, height) : new Float64Array(height);
  // Text-only-while-talking score, lightly smoothed over 3 rows.
  const raw = talk.map((v, y) => Math.max(0, v - base[y]!));
  const score = raw.map((_, y) => (raw[Math.max(0, y - 1)]! + raw[y]! + raw[Math.min(height - 1, y + 1)]!) / 3);

  let peak = 0;
  for (let y = 1; y < height; y++) if (score[y]! > score[peak]!) peak = y;
  const peakScore = score[peak]!;
  // Subtitle text turns well over a tenth of its row's pixels into edges, and
  // must stand clearly above the frame's typical row.
  if (peakScore < 0.08 || peakScore < 3 * median([...score]) + 0.02) return undefined;

  const floor = peakScore * 0.35;
  let top = peak;
  let bottom = peak;
  while (top > 0 && score[top - 1]! >= floor) top--;
  while (bottom < height - 1 && score[bottom + 1]! >= floor) bottom++;
  const bandRows = bottom - top + 1;
  // A subtitle band is a line or two of text — not a sliver, not the picture.
  if (bandRows < height * 0.012 || bandRows > height * 0.22) return undefined;

  // Horizontal extent: where the band's edges fall, over all speech frames.
  const cols = new Float64Array(width);
  for (const f of speech) {
    for (let y = top; y <= bottom; y++) {
      const row = y * width;
      for (let x = 0; x + 1 < width; x++) {
        if (Math.abs(f.pixels[row + x]! - f.pixels[row + x + 1]!) > EDGE_THRESHOLD) cols[x] = cols[x]! + 1;
      }
    }
  }
  const total = cols.reduce((a, b) => a + b, 0);
  let left = 0;
  let right = width - 1;
  for (let acc = 0; left < width && acc + cols[left]! <= total * 0.01; left++) acc += cols[left]!;
  for (let acc = 0; right > 0 && acc + cols[right]! <= total * 0.01; right--) acc += cols[right]!;

  // Pad: glyph outlines/shadows reach past the edge rows, and the next cue may
  // be a little longer than any sampled one.
  // The score only catches the dense core of the glyphs: on the reporting video
  // a 0.45x pad stopped exactly at the text's bottom edge and left the glyph
  // feet and drop shadow visible under the blur.
  const padY = Math.max(2, Math.round(bandRows * 0.8));
  const padX = Math.round(width * 0.04);
  const y0 = Math.max(0, top - padY);
  const y1 = Math.min(height, bottom + 1 + padY);
  const x0 = Math.max(0, left - padX);
  const x1 = Math.min(width, right + 1 + padX);
  return round4({ x: x0 / width, y: y0 / height, width: (x1 - x0) / width, height: (y1 - y0) / height });
}

function round4(r: NormalizedRect): NormalizedRect {
  const q = (n: number) => Math.round(n * 1e4) / 1e4;
  return { x: q(r.x), y: q(r.y), width: q(r.width), height: q(r.height) };
}

/** Clamp a user/detected rect into the frame with a usable minimum size. */
export function clampRegion(r: NormalizedRect): NormalizedRect {
  const c = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
  const x = c(r.x);
  const y = c(r.y);
  return round4({ x, y, width: Math.max(0.01, Math.min(1 - x, c(r.width))), height: Math.max(0.01, Math.min(1 - y, c(r.height))) });
}

/**
 * The ffmpeg filter chain (one input, one output) that hides `region`. Pure.
 * Coordinates are expressions of the frame size, rounded down to even pixels
 * so the crop and the overlay land on the same chroma-aligned position.
 */
export function buildSourceMaskFilter(mode: Exclude<SourceSubtitleMaskMode, 'off'>, region: NormalizedRect): string {
  const { x, y, width, height } = clampRegion(region);
  const even = (dim: 'iw' | 'ih' | 'main_w' | 'main_h', f: number) => `trunc(${dim}*${f}/2)*2`;
  // Blur a copy of the region and lay it back over the original.
  const blur =
    `split[vdmsrc][vdmreg];` +
    `[vdmreg]crop=w=${even('iw', width)}:h=${even('ih', height)}:x=${even('iw', x)}:y=${even('ih', y)},gblur=sigma=30:steps=3[vdmblur];` +
    `[vdmsrc][vdmblur]overlay=x=${even('main_w', x)}:y=${even('main_h', y)}`;
  if (mode === 'blur') return blur;
  // box: a dark band on its own let bright text show through even at 92%
  // opacity (measured on a real hardsub), so the band is blurred first and
  // then darkened — the text is gone and the dub's white subtitles read well.
  return `${blur},drawbox=x=${even('iw', x)}:y=${even('ih', y)}:w=${even('iw', width)}:h=${even('ih', height)}:color=black@0.6:t=fill`;
}

/** Pick at most `max` times spread evenly through `times`. */
function spread(times: readonly number[], max: number): number[] {
  if (times.length <= max) return [...times];
  return Array.from({ length: max }, (_, i) => times[Math.floor((i * times.length) / max)]!);
}

/** Run `fn` over `items` with at most `limit` in flight; drops undefined results. */
async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R | undefined>): Promise<R[]> {
  const out: (R | undefined)[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out.filter((r): r is R => r !== undefined);
}

/** Grab one scaled grayscale frame at `ms` (undefined past the end / on error). */
async function grabFrame(videoPath: string, ms: number, dir: string, opts: RunOptions): Promise<GrayFrame | undefined> {
  const out = join(dir, `f${ms}.gray`);
  try {
    await runFfmpeg(
      [
        '-y',
        '-ss',
        (ms / 1000).toFixed(3),
        '-i',
        videoPath,
        '-frames:v',
        '1',
        '-vf',
        `scale=${SAMPLE_WIDTH}:-2:flags=area,format=gray`,
        '-f',
        'rawvideo',
        out,
      ],
      opts,
    );
    const pixels = new Uint8Array(await readFile(out));
    const height = Math.floor(pixels.length / SAMPLE_WIDTH);
    return height > 0 ? { width: SAMPLE_WIDTH, height, pixels: pixels.subarray(0, height * SAMPLE_WIDTH) } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The region to hide: the caller's, else the detected band, else the default
 * lower band. `detected` reports which, for the pipeline log.
 */
export async function resolveSourceSubtitleRegion(
  videoPath: string,
  mask: { region?: NormalizedRect; speechTimesMs?: number[]; quietTimesMs?: number[] },
  opts: RunOptions = {},
): Promise<{ region: NormalizedRect; detected: boolean }> {
  if (mask.region) return { region: clampRegion(mask.region), detected: false };
  const speechTimes = spread(mask.speechTimesMs ?? [], MAX_SAMPLES);
  if (speechTimes.length >= 3) {
    const dir = await mkdtemp(join(tmpdir(), 'vd-hardsubs-'));
    try {
      const grab = (t: number) => grabFrame(videoPath, t, dir, opts);
      const speech = await mapLimited(speechTimes, 4, grab);
      const quiet = await mapLimited(spread(mask.quietTimesMs ?? [], MAX_SAMPLES), 4, grab);
      const band = detectSubtitleBand(speech, quiet);
      if (band) return { region: band, detected: true };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return { region: DEFAULT_SOURCE_SUBTITLE_REGION, detected: false };
}
