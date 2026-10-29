import { describe, it, expect } from 'vitest';
import { splitLongCue, transcriptSegmentsToCues } from './cues.js';
import { splitSubtitleLines } from './lines.js';
import type { TranscriptSegment } from '../models/domain.js';

function seg(partial: Partial<TranscriptSegment> & { index: number }): TranscriptSegment {
  return {
    id: `seg_${String(partial.index + 1).padStart(4, '0')}`,
    index: partial.index,
    startMs: partial.startMs ?? partial.index * 1000,
    endMs: partial.endMs ?? partial.index * 1000 + 900,
    sourceText: partial.sourceText ?? '',
    translatedText: partial.translatedText,
  };
}

describe('transcriptSegmentsToCues', () => {
  it('prefers translatedText when present', () => {
    const cues = transcriptSegmentsToCues([
      seg({ index: 0, sourceText: 'Hello', translatedText: 'Xin chào' }),
    ]);
    expect(cues[0]?.text).toBe('Xin chào');
  });

  it('falls back to sourceText when translatedText is absent', () => {
    const cues = transcriptSegmentsToCues([seg({ index: 0, sourceText: 'Hello' })]);
    expect(cues[0]?.text).toBe('Hello');
  });

  it('falls back to sourceText when translatedText is empty/whitespace', () => {
    const cues = transcriptSegmentsToCues([
      seg({ index: 0, sourceText: 'Hello', translatedText: '   ' }),
    ]);
    expect(cues[0]?.text).toBe('Hello');
  });

  it('assigns a 1-based index from the segment index', () => {
    const cues = transcriptSegmentsToCues([
      seg({ index: 0, sourceText: 'A' }),
      seg({ index: 1, sourceText: 'B' }),
    ]);
    expect(cues[0]?.index).toBe(1);
    expect(cues[1]?.index).toBe(2);
  });

  it('skips segments with no usable text', () => {
    const cues = transcriptSegmentsToCues([
      seg({ index: 0, sourceText: '' }),
      seg({ index: 1, sourceText: 'Keep me' }),
    ]);
    expect(cues).toHaveLength(1);
    expect(cues[0]?.text).toBe('Keep me');
  });

  it('preserves timing', () => {
    const cues = transcriptSegmentsToCues([
      seg({ index: 0, sourceText: 'A', startMs: 100, endMs: 200 }),
    ]);
    expect(cues[0]?.startMs).toBe(100);
    expect(cues[0]?.endMs).toBe(200);
  });
});

describe('splitLongCue', () => {
  // The real cue from a Chinese->Vietnamese dub: two sentences, five lines.
  const long =
    'Anh em sửa mainboard hỏng hôm nay, boss yêu cầu phải đảm bảo mainboard nguyên bản. ' +
    'Được, không vấn đề gì, dùng được hay không tao không quan tâm, nhưng chắc chắn nguyên bản.';

  it('returns a cue that already fits unchanged', () => {
    const cue = { index: 1, startMs: 0, endMs: 1000, text: 'Xin chào các bạn.' };
    expect(splitLongCue(cue)).toEqual([cue]);
  });

  it('splits a multi-sentence cue so every piece fits in two lines', () => {
    const parts = splitLongCue({ index: 1, startMs: 20, endMs: 7694, text: long });
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(splitSubtitleLines(p.text, 42, Infinity, 'wrap').length).toBeLessThanOrEqual(2);
    // No word is lost or reordered.
    expect(parts.map((p) => p.text).join(' ')).toBe(long);
    // The first piece ends on the sentence boundary.
    expect(parts[0]!.text.endsWith('nguyên bản.')).toBe(true);
  });

  it('shares the window out contiguously, ending exactly at the cue end', () => {
    const parts = splitLongCue({ index: 1, startMs: 20, endMs: 7694, text: long });
    expect(parts[0]!.startMs).toBe(20);
    expect(parts[parts.length - 1]!.endMs).toBe(7694);
    for (let i = 1; i < parts.length; i++) expect(parts[i]!.startMs).toBe(parts[i - 1]!.endMs);
  });

  it('falls back to word windows for an unpunctuated run-on', () => {
    const words = Array.from({ length: 40 }, (_, i) => `từ${i}`).join(' ');
    const parts = splitLongCue({ startMs: 0, endMs: 4000, text: words });
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((p) => p.text).join(' ')).toBe(words);
  });
});

describe('transcriptSegmentsToCues with long segments', () => {
  it('renumbers sequentially once a segment is split', () => {
    const cues = transcriptSegmentsToCues([
      seg({
        index: 0,
        startMs: 0,
        endMs: 8000,
        sourceText: 'x',
        translatedText:
          'Câu thứ nhất này khá dài để chắc chắn phải xuống dòng. Câu thứ hai cũng dài không kém để vượt quá hai dòng.',
      }),
      seg({ index: 1, startMs: 9000, endMs: 10000, sourceText: 'y', translatedText: 'Ngắn.' }),
    ]);
    expect(cues.map((c) => c.index)).toEqual(cues.map((_, i) => i + 1));
    expect(cues[cues.length - 1]!.text).toBe('Ngắn.');
  });
});
