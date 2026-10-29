/**
 * Subtitle helpers for the FFmpeg `subtitles=` filter (libass burn-in).
 *
 * The `subtitles=` filter has *two* levels of escaping to worry about:
 *   1. The filtergraph value level: characters like ':' (option separator),
 *      '\' and "'" are special and must be escaped.
 *   2. On Windows, the drive-letter colon (C:\path) collides with the
 *      filtergraph option separator and needs special handling.
 *
 * We build the value that goes after `subtitles=` and rely on the caller to
 * wrap the whole filter in single quotes when assembling the -vf string is NOT
 * done via shell (we always spawn with argv arrays, so there is no shell, but
 * libass still parses the filter value, hence the escaping below).
 *
 * All functions here are pure and unit-tested.
 */

import type { SubtitleStyle } from '@videodubber/shared';

/**
 * Escape a subtitle file path for use inside the `subtitles=<path>` filter
 * value. We do NOT add surrounding quotes; we escape the characters libass /
 * the filtergraph parser treat as special.
 *
 * ffmpeg un-escapes a `-vf` filtergraph in TWO passes — first the whole graph
 * description, then each filter's option string (split on ':'). A literal colon
 * therefore has to survive BOTH passes: written as `\:` the outer pass consumes
 * the backslash and the inner pass splits on the bare colon (the bug that put a
 * Windows path like `C:/…/sub.srt` into the `original_size` option). So a
 * literal ':' must be `\\:` — the outer pass yields `\:`, the inner yields ':'.
 *
 * Rules (matching ffmpeg's two-level filtergraph escaping):
 *   - colon      :  -> \\:       (option separator — needs BOTH levels)
 *   - single '   '  -> \'        (string delimiter)
 *   - left [     [  -> \[
 *   - right ]    ]  -> \]
 *   - comma      ,  -> \,        (filter separator)
 * On Windows we normalize backslashes in the drive path to forward slashes
 * first (libass accepts forward slashes on Windows), so the only colon left is
 * the drive colon — escaped by the rule above.
 */
export function escapeSubtitlePathForFilter(
  inputPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  let p = inputPath;

  if (platform === 'win32') {
    // Convert C:\Users\foo\sub.srt -> C:/Users/foo/sub.srt
    p = p.replace(/\\/g, '/');
    // The remaining drive colon (C:/...) is escaped for the filtergraph below.
  }

  // Backslash first (so we don't double the ones the colon rule inserts), then
  // the colon as `\\:` so the two-pass filtergraph parse keeps it literal
  // instead of splitting the path into a second filter option.
  return p
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\\\:')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,');
}

/**
 * Convert a #RRGGBB (or #RGB / RRGGBB) hex color to the libass/ASS color
 * format `&HAABBGGRR` (alpha 00 = fully opaque in ASS).
 *
 * ASS stores colors as &HAABBGGRR where AA is the *inverse* alpha (00 opaque,
 * FF transparent). We default to fully opaque (00).
 */
export function hexToAssColor(hex: string, alpha = 0x00): string {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) {
    // Expand shorthand #rgb -> #rrggbb
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    // Fall back to white on malformed input rather than producing garbage.
    h = 'FFFFFF';
  }
  const rr = h.slice(0, 2);
  const gg = h.slice(2, 4);
  const bb = h.slice(4, 6);
  const aa = clampByte(alpha).toString(16).padStart(2, '0').toUpperCase();
  // ASS order is BGR.
  return `&H${aa}${bb.toUpperCase()}${gg.toUpperCase()}${rr.toUpperCase()}`;
}

function clampByte(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

/**
 * Map our SubtitleStyle.alignment to the ASS numpad alignment code.
 * ASS numpad layout (libass `Alignment`):
 *   7 8 9   (top:    left/center/right)
 *   4 5 6   (center: left/center/right)
 *   1 2 3   (bottom: left/center/right)
 * We use horizontally-centered values:
 *   bottom -> 2, center -> 5, top -> 8
 */
export function alignmentToAssCode(alignment: SubtitleStyle['alignment']): number {
  switch (alignment) {
    case 'top':
      return 8;
    case 'center':
      return 5;
    case 'bottom':
    default:
      return 2;
  }
}

/**
 * Build the `force_style` string for the subtitles filter from a SubtitleStyle.
 * Example: "FontName=Arial,FontSize=24,PrimaryColour=&H00FFFFFF,Outline=2,Alignment=2"
 *
 * Note: force_style values themselves should not contain commas/colons; font
 * names with spaces are fine. We sanitize the font name by stripping commas.
 */
export function buildBurnSubtitlesStyle(style: SubtitleStyle): string {
  const fontName = (style.fontFamily || 'Arial').replace(/,/g, ' ').trim();
  const fontSize = Number.isFinite(style.fontSize) ? Math.round(style.fontSize) : 24;
  const primary = hexToAssColor(style.primaryColor || '#FFFFFF');
  const outlineColor = hexToAssColor(style.outlineColor || '#000000');
  const outlineWidth = Number.isFinite(style.outlineWidth)
    ? Math.max(0, style.outlineWidth)
    : 2;
  const alignment = alignmentToAssCode(style.alignment);

  return [
    `FontName=${fontName}`,
    `FontSize=${fontSize}`,
    `PrimaryColour=${primary}`,
    `OutlineColour=${outlineColor}`,
    `BorderStyle=1`,
    `Outline=${outlineWidth}`,
    `Alignment=${alignment}`,
  ].join(',');
}

/**
 * Build the full `subtitles=...` filter value (path + optional force_style).
 * Returns just the filter string (no `-vf`); render.ts inserts it.
 */
export function buildSubtitlesFilter(
  subtitlePath: string,
  style?: SubtitleStyle,
  platform: NodeJS.Platform = process.platform,
  /** Placement/size overrides in ASS script units (see marginVForBand, portraitFontSize). */
  overrides: { marginV?: number; fontSize?: number } = {},
): string {
  const escaped = escapeSubtitlePathForFilter(subtitlePath, platform);
  let filter = `subtitles=${escaped}`;
  const { marginV, fontSize } = overrides;
  const fields = [
    ...(style ? [buildBurnSubtitlesStyle(style)] : []),
    ...(fontSize !== undefined ? [`FontSize=${Math.max(1, Math.round(fontSize))}`] : []),
    ...(marginV !== undefined ? [`MarginV=${Math.max(0, Math.round(marginV))}`] : []),
  ];
  if (fields.length > 0) {
    // force_style is itself passed as a single value; wrap in single quotes so
    // its internal commas are treated as style fields, not filter separators.
    filter += `:force_style='${fields.join(',')}'`;
  }
  return filter;
}

/** libass's script height for an SRT input (its default PlayResY). */
const SRT_PLAY_RES_Y = 288;

/**
 * Font size (ASS units) for a PORTRAIT frame, or undefined for landscape.
 *
 * libass scales an SRT's default 18-unit font by the frame HEIGHT, which suits
 * 16:9 (~3.5% of the width) but on a 720x1280 short drew ~80 px glyphs across a
 * 720 px frame: a two-line cue re-wrapped to four lines and buried the picture.
 * Portrait frames get a font sized to the WIDTH instead (~5% of it). Pure.
 */
export function portraitFontSize(width: number, height: number): number | undefined {
  if (!(width > 0 && height > 0) || width >= height) return undefined;
  return Math.max(6, Math.round((0.05 * width * SRT_PLAY_RES_Y) / height));
}

/**
 * Bottom margin that seats a bottom-aligned subtitle inside a band given as
 * fractions of the frame height — used to put the dub's subtitles where the
 * source's hidden hardsubs were, instead of on a fresh strip of picture. Pure.
 */
export function marginVForBand(bandY: number, bandHeight: number): number {
  const below = Math.max(0, 1 - (bandY + bandHeight));
  return Math.round((below + bandHeight * 0.15) * SRT_PLAY_RES_Y);
}
