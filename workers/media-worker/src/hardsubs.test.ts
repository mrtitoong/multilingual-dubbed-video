import { describe, expect, it } from 'vitest';
import { buildRenderArgs } from './render.js';
import {
  buildSourceMaskFilter,
  clampRegion,
  detectSubtitleBand,
  type GrayFrame,
} from './hardsubs.js';
import { marginVForBand, portraitFontSize } from './subtitles.js';

const W = 96;
const H = 170;

/** Deterministic pseudo-random scene, different per seed (smooth, low-edge). */
function scene(seed: number): GrayFrame {
  const pixels = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      pixels[y * W + x] = 90 + Math.round(40 * Math.sin((x + seed * 7) / 9) * Math.cos((y + seed * 3) / 13));
    }
  }
  return { width: W, height: H, pixels };
}

/** Draw "text": alternating bright/dark glyph strokes across [x0,x1) on rows [y0,y1). */
function drawText(f: GrayFrame, y0: number, y1: number, x0: number, x1: number, phase = 0): GrayFrame {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) f.pixels[y * W + x] = (x + phase) % 3 === 0 ? 20 : 240;
  }
  return f;
}

describe('detectSubtitleBand', () => {
  // Hardsubs at rows 120..128 (~71-75% of the height, like the reporting video),
  // a channel logo at rows 10..22 that is on screen ALL the time.
  const logo = (f: GrayFrame) => drawText(f, 10, 22, 6, 30);
  const speech = Array.from({ length: 8 }, (_, i) => logo(drawText(scene(i), 120, 128, 12 + i, 80 - i, i)));
  const quiet = Array.from({ length: 6 }, (_, i) => logo(scene(100 + i)));

  it('finds the band the text occupies while the source speaks', () => {
    const r = detectSubtitleBand(speech, quiet)!;
    expect(r).toBeDefined();
    expect(r.y).toBeLessThanOrEqual(120 / H);
    expect(r.y + r.height).toBeGreaterThanOrEqual(128 / H);
    // Tight: not the bottom quarter of the frame.
    expect(r.height).toBeLessThan(0.12);
  });

  it('ignores a static logo that is on screen whether anyone speaks or not', () => {
    const r = detectSubtitleBand(speech, quiet)!;
    expect(r.y).toBeGreaterThan(22 / H);
  });

  it('returns undefined for a video without hardsubs', () => {
    const plain = Array.from({ length: 8 }, (_, i) => scene(i));
    expect(detectSubtitleBand(plain, quiet.map((_, i) => scene(50 + i)))).toBeUndefined();
  });

  it('needs at least three speech frames of one size', () => {
    expect(detectSubtitleBand(speech.slice(0, 2), quiet)).toBeUndefined();
    expect(detectSubtitleBand([...speech, { width: 10, height: 10, pixels: new Uint8Array(100) }], quiet)).toBeUndefined();
  });
});

describe('buildSourceMaskFilter', () => {
  const band = { x: 0, y: 0.6988, width: 1, height: 0.0643 };

  it('blurs a cropped copy of the band and overlays it at the same even position', () => {
    const f = buildSourceMaskFilter('blur', band);
    expect(f).toContain('crop=w=trunc(iw*1/2)*2:h=trunc(ih*0.0643/2)*2:x=trunc(iw*0/2)*2:y=trunc(ih*0.6988/2)*2');
    expect(f).toContain('gblur=sigma=30');
    expect(f).toContain('overlay=x=trunc(main_w*0/2)*2:y=trunc(main_h*0.6988/2)*2');
  });

  it('box = blur, then a darkening band (a bare 92% box let the text show through)', () => {
    const f = buildSourceMaskFilter('box', band);
    expect(f.startsWith(buildSourceMaskFilter('blur', band))).toBe(true);
    expect(f).toMatch(/,drawbox=.*color=black@0\.6:t=fill$/);
  });

  it('clamps an out-of-frame region', () => {
    expect(clampRegion({ x: -0.2, y: 0.95, width: 2, height: 0.3 })).toEqual({ x: 0, y: 0.95, width: 1, height: 0.05 });
  });
});

describe('render with a source-subtitle mask', () => {
  const base = { inputVideoPath: '/in.mp4', audioPath: '/a.wav', outputPath: '/out.mp4', platform: 'linux' as const };
  const mask = buildSourceMaskFilter('blur', { x: 0, y: 0.7, width: 1, height: 0.06 });

  it('re-encodes through the mask in a no-subtitle mode instead of copying', () => {
    const args = buildRenderArgs({ ...base, subtitleExportMode: 'srt-file', sourceMaskFilter: mask });
    expect(args[args.indexOf('-vf') + 1]).toBe(mask);
    expect(args[args.indexOf('-c:v') + 1]).toBe('libx264');
  });

  it('draws burned-in subtitles AFTER the mask, seated in the band', () => {
    const args = buildRenderArgs({
      ...base,
      subtitleExportMode: 'burned-in',
      subtitlePath: '/subs.srt',
      sourceMaskFilter: mask,
      subtitleOverrides: { marginV: marginVForBand(0.7, 0.06), fontSize: 9 },
    });
    const vf = args[args.indexOf('-vf') + 1]!;
    expect(vf.startsWith(`${mask},subtitles=/subs.srt`)).toBe(true);
    expect(vf).toContain(`FontSize=9,MarginV=${marginVForBand(0.7, 0.06)}`);
  });

  it('sizes portrait subtitles by width, leaves landscape to libass', () => {
    // 720x1280: 5% of 720 px = 36 px = 8 script units of a 1280-high frame.
    expect(portraitFontSize(720, 1280)).toBe(8);
    expect(portraitFontSize(1920, 1080)).toBeUndefined();
    expect(portraitFontSize(0, 0)).toBeUndefined();
  });

  it('still copies the video when no mask is set', () => {
    const args = buildRenderArgs({ ...base, subtitleExportMode: 'none' });
    expect(args).not.toContain('-vf');
    expect(args[args.indexOf('-c:v') + 1]).toBe('copy');
  });

  it('marginVForBand puts the line bottom just inside the band bottom', () => {
    // Band 70%..76% of 288 script units: 24% below it -> 69, plus a 15% inset.
    expect(marginVForBand(0.7, 0.06)).toBe(Math.round((0.24 + 0.009) * 288));
  });
});
