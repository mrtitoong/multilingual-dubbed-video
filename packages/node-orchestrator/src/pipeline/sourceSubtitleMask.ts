/**
 * Turn the project's `sourceSubtitleMask` setting into the render input that
 * hides the source video's own burned-in subtitles (see media-worker
 * hardsubs.ts).
 *
 * The renderer detects where those subtitles sit from frames grabbed while the
 * source speaks versus while it is quiet; the transcript (source.json) is what
 * says when that is, so the sample times are derived here. Both render paths —
 * the pipeline's render step and the export screen's re-render — use this, so
 * they cannot disagree about the mask.
 */
import fsp from 'node:fs/promises';
import type {
  NormalizedRect,
  ProjectSettings,
  RenderFinalVideoInput,
  RenderFinalVideoResult,
  SourceSubtitleMaskMode,
} from '@videodubber/shared';

const MODES: ReadonlySet<SourceSubtitleMaskMode> = new Set(['off', 'blur', 'box']);
/** A gap must be at least this long to count as "quiet" (no hardsub on screen). */
const MIN_QUIET_GAP_MS = 600;

/**
 * Speech/quiet sample times from transcript cues: the midpoint of every cue,
 * and the midpoint of every gap long enough that the source's subtitle has
 * likely left the screen (including a quiet lead-in before the first cue). Pure.
 */
export function maskSampleTimes(cues: readonly { startMs: number; endMs: number }[]): {
  speechTimesMs: number[];
  quietTimesMs: number[];
} {
  const sorted = [...cues].filter((c) => c.endMs > c.startMs).sort((a, b) => a.startMs - b.startMs);
  const speechTimesMs = sorted.map((c) => Math.round((c.startMs + c.endMs) / 2));
  const quietTimesMs: number[] = [];
  if (sorted.length > 0 && sorted[0]!.startMs >= MIN_QUIET_GAP_MS) quietTimesMs.push(Math.round(sorted[0]!.startMs / 2));
  for (let i = 0; i + 1 < sorted.length; i++) {
    const gap = sorted[i + 1]!.startMs - sorted[i]!.endMs;
    if (gap >= MIN_QUIET_GAP_MS) quietTimesMs.push(Math.round(sorted[i]!.endMs + gap / 2));
  }
  return { speechTimesMs, quietTimesMs };
}

/** A finite 0..1 rect, or undefined — settings arrive from a client as-is. */
function validRegion(r: unknown): NormalizedRect | undefined {
  if (!r || typeof r !== 'object') return undefined;
  const { x, y, width, height } = r as Record<string, unknown>;
  const ok = [x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1);
  return ok && (width as number) > 0 && (height as number) > 0
    ? { x: x as number, y: y as number, width: width as number, height: height as number }
    : undefined;
}

/**
 * The render input for the project's mask, or undefined when it is off/unset.
 * Detection sample times are read from source.json only when no region is set.
 */
export async function sourceSubtitleMaskInput(
  settings: ProjectSettings,
  sourceJsonPath: string,
): Promise<RenderFinalVideoInput['sourceSubtitleMask']> {
  const mask = settings.sourceSubtitleMask;
  if (!mask || !MODES.has(mask.mode) || mask.mode === 'off') return undefined;
  const region = validRegion(mask.region);
  if (region) return { mode: mask.mode, region };
  let cues: { startMs: number; endMs: number }[] = [];
  try {
    const parsed = JSON.parse(await fsp.readFile(sourceJsonPath, 'utf8')) as { segments?: typeof cues };
    cues = parsed.segments ?? [];
  } catch {
    // No transcript: the renderer falls back to its default lower band.
  }
  return { mode: mask.mode, ...maskSampleTimes(cues) };
}

/** One pipeline.log line describing what the mask covered. */
export function describeSourceMask(result: RenderFinalVideoResult, mode: SourceSubtitleMaskMode): string | undefined {
  const m = result.sourceSubtitleMask;
  if (!m) return undefined;
  const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;
  const how = m.detected ? 'detected' : 'configured/default';
  return `Source subtitles hidden (${mode}) over ${how} region: y ${pct(m.region.y)}–${pct(m.region.y + m.region.height)}, x ${pct(m.region.x)}–${pct(m.region.x + m.region.width)}.`;
}
