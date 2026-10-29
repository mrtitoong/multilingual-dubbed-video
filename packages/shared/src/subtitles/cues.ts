/**
 * Subtitle cue type and adapters from transcript segments.
 */

import type { TranscriptSegment } from '../models/domain.js';
import { DEFAULT_MAX_CHARS_PER_LINE, DEFAULT_MAX_LINES, splitSubtitleLines } from './lines.js';

/** A minimal timed subtitle cue. Timestamps are integer milliseconds. */
export interface SubtitleCue {
  /** Cue start time in ms. */
  startMs: number;
  /** Cue end time in ms. */
  endMs: number;
  /** Cue text (single string; may contain newlines). */
  text: string;
}

/** Optional index alias used by the SRT/VTT writers. */
export interface IndexedCue extends SubtitleCue {
  /** 1-based display index (optional). */
  index?: number;
}

/**
 * Convert transcript segments to subtitle cues.
 *
 * For each segment, the cue text is `translatedText` when present and
 * non-empty, otherwise `sourceText`. Segments whose chosen text is empty are
 * skipped.
 *
 * A segment too long for one on-screen cue is split into several, sentence by
 * sentence, with its time shared out by text length — see {@link splitLongCue}.
 *
 * @param segments Ordered transcript segments.
 * @returns Cues in segment order. Indices are the segment `index + 1` while no
 *          segment was split, and renumbered sequentially once one was (SRT
 *          players need 1, 2, 3… — and nothing reads a cue index back).
 */
export function transcriptSegmentsToCues(segments: TranscriptSegment[]): IndexedCue[] {
  const cues = segmentsToWholeCues(segments);
  const split = cues.flatMap((cue) => splitLongCue(cue));
  if (split.length === cues.length) return cues;
  return split.map((cue, i) => ({ ...cue, index: i + 1 }));
}

/** Sentence ends (Latin + CJK), then clause breaks — the split points in order of preference. */
const SENTENCE_BREAK = /(?<=[.!?…。！？])\s+/u;
const CLAUSE_BREAK = /(?<=[,;:，；：、])\s+/u;

/**
 * Split one cue whose text needs more than `maxLines` wrapped lines into
 * consecutive cues that each fit, timed proportionally to their text length.
 *
 * Whisper segments are timing units of the SOURCE speech and routinely hold two
 * or three sentences; written whole, one Vietnamese cue filled five lines and sat
 * on screen for its entire window while the voice read it sentence by sentence.
 * Pieces break at sentence ends first, then at clause punctuation, then between
 * words — and adjacent short pieces are packed back together while they still
 * fit, so a split never produces a flurry of one-word cues. Pure; a cue that
 * already fits is returned unchanged.
 */
export function splitLongCue(
  cue: IndexedCue,
  maxCharsPerLine: number = DEFAULT_MAX_CHARS_PER_LINE,
  maxLines: number = DEFAULT_MAX_LINES,
): IndexedCue[] {
  const fits = (text: string) => splitSubtitleLines(text, maxCharsPerLine, maxLines, 'wrap').length <= maxLines;
  const text = cue.text.replace(/\s+/g, ' ').trim();
  if (fits(text)) return [cue];

  // Finest pieces: sentences, broken further at clauses / word windows when needed.
  const pieces = text.split(SENTENCE_BREAK).flatMap((sentence) => {
    if (fits(sentence)) return [sentence];
    return sentence.split(CLAUSE_BREAK).flatMap((clause) => {
      if (fits(clause)) return [clause];
      // Word windows: one cue's worth of wrapped lines at a time.
      const lines = splitSubtitleLines(clause, maxCharsPerLine, maxLines, 'wrap');
      const windows: string[] = [];
      for (let i = 0; i < lines.length; i += maxLines) windows.push(lines.slice(i, i + maxLines).join(' '));
      return windows;
    });
  });

  // Pack neighbours back together while the result still fits.
  const chunks: string[] = [];
  for (const piece of pieces) {
    const last = chunks[chunks.length - 1];
    if (last !== undefined && fits(`${last} ${piece}`)) chunks[chunks.length - 1] = `${last} ${piece}`;
    else chunks.push(piece);
  }
  if (chunks.length < 2) return [cue];

  // Share the cue's window out by character count; the last chunk ends exactly
  // at the cue's end so rounding never drifts the track.
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const span = cue.endMs - cue.startMs;
  let before = 0;
  return chunks.map((chunk, i) => {
    const startMs = cue.startMs + Math.round((before / total) * span);
    before += chunk.length;
    const endMs = i === chunks.length - 1 ? cue.endMs : cue.startMs + Math.round((before / total) * span);
    return { ...cue, startMs, endMs, text: chunk };
  });
}

function segmentsToWholeCues(segments: TranscriptSegment[]): IndexedCue[] {
  const cues: IndexedCue[] = [];
  for (const seg of segments) {
    const translated = (seg.translatedText ?? '').trim();
    const source = (seg.sourceText ?? '').trim();
    const text = translated !== '' ? translated : source;
    if (text === '') continue;
    cues.push({
      index: seg.index + 1,
      startMs: seg.startMs,
      endMs: seg.endMs,
      text,
    });
  }
  return cues;
}
