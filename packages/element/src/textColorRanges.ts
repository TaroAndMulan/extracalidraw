/**
 * Partial text colors: a text element can color parts of its text
 * differently from its `strokeColor` (e.g. one word in red).
 *
 * `colorRanges` index into `originalText` (what the user typed, before
 * wrapping), so they survive re-wrapping when a container is resized. They're
 * kept sorted, non-overlapping, non-empty, and never equal to the element's
 * `strokeColor` (those parts just use the default color).
 */

import type { ExcalidrawTextElement, TextColorRange } from "./types";

const MAX_RANGES = 500;
const COLOR_RE =
  /^(#[0-9a-f]{3,8}|[a-z]+|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/i;

/** drops invalid ranges, clamps to the text, sorts and merges */
export const normalizeColorRanges = (
  ranges: readonly TextColorRange[] | null | undefined,
  textLength: number,
  defaultColor?: string,
): TextColorRange[] | undefined => {
  if (!Array.isArray(ranges) || !ranges.length) {
    return undefined;
  }
  const valid = ranges
    .filter(
      (range) =>
        range &&
        Number.isFinite(range.start) &&
        Number.isFinite(range.end) &&
        typeof range.color === "string" &&
        COLOR_RE.test(range.color.trim()),
    )
    .map((range) => ({
      start: Math.max(0, Math.min(textLength, Math.floor(range.start))),
      end: Math.max(0, Math.min(textLength, Math.floor(range.end))),
      color: range.color.trim(),
    }))
    .filter((range) => range.end > range.start && range.color !== defaultColor)
    .sort((a, b) => a.start - b.start)
    .slice(0, MAX_RANGES);

  // later ranges win over earlier ones where they overlap
  const result: TextColorRange[] = [];
  for (const range of valid) {
    const last = result[result.length - 1];
    if (last && range.start < last.end) {
      // trim the previous range to make room
      result[result.length - 1] = { ...last, end: range.start };
      if (result[result.length - 1].end <= result[result.length - 1].start) {
        result.pop();
      }
    }
    const previous = result[result.length - 1];
    if (
      previous &&
      previous.end === range.start &&
      previous.color === range.color
    ) {
      result[result.length - 1] = { ...previous, end: range.end };
    } else {
      result.push(range);
    }
  }
  return result.length ? result : undefined;
};

/** colors `[start, end)` with `color` (the default color removes coloring) */
export const applyColorRange = (
  ranges: readonly TextColorRange[] | null | undefined,
  start: number,
  end: number,
  color: string,
  defaultColor: string,
  textLength: number,
): TextColorRange[] | undefined => {
  const from = Math.max(0, Math.min(start, end));
  const to = Math.min(textLength, Math.max(start, end));
  const next: TextColorRange[] = [];
  for (const range of ranges ?? []) {
    // keep the parts outside [from, to)
    if (range.start < from) {
      next.push({ ...range, end: Math.min(range.end, from) });
    }
    if (range.end > to) {
      next.push({ ...range, start: Math.max(range.start, to) });
    }
  }
  if (to > from && color !== defaultColor) {
    next.push({ start: from, end: to, color });
  }
  return normalizeColorRanges(next, textLength, defaultColor);
};

/**
 * Moves ranges along with an edit of the text. Typed text takes the color of
 * the character before it (like in word processors); replacing text that
 * starts a colored range keeps its color.
 */
export const shiftColorRanges = (
  ranges: readonly TextColorRange[] | null | undefined,
  prevText: string,
  nextText: string,
): TextColorRange[] | undefined => {
  if (!ranges?.length || prevText === nextText) {
    return ranges ? normalizeColorRanges(ranges, nextText.length) : undefined;
  }
  const maxCommon = Math.min(prevText.length, nextText.length);
  let prefix = 0;
  while (prefix < maxCommon && prevText[prefix] === nextText[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < maxCommon - prefix &&
    prevText[prevText.length - 1 - suffix] ===
      nextText[nextText.length - 1 - suffix]
  ) {
    suffix++;
  }
  const deletedEnd = prevText.length - suffix;
  const inserted = nextText.length - suffix - prefix;
  const delta = nextText.length - prevText.length;
  const isPureInsertion = deletedEnd === prefix;

  const mapStart = (position: number) => {
    if (position < prefix) {
      return position;
    }
    if (position === prefix) {
      return isPureInsertion ? prefix + inserted : prefix;
    }
    if (position <= deletedEnd) {
      return prefix + inserted;
    }
    return position + delta;
  };
  const mapEnd = (position: number) => {
    if (position < prefix) {
      return position;
    }
    if (position === prefix) {
      return isPureInsertion ? prefix + inserted : prefix;
    }
    if (position < deletedEnd) {
      return prefix;
    }
    return position + delta;
  };

  return normalizeColorRanges(
    ranges.map((range) => ({
      ...range,
      start: mapStart(range.start),
      end: mapEnd(range.end),
    })),
    nextText.length,
  );
};

export type ColoredSegment = { text: string; color: string };

const isWhitespace = (char: string | undefined) =>
  char !== undefined && /\s/.test(char);

/**
 * The lines of the (wrapped) `text`, each split into segments of one color.
 * `null` when the element has no partial colors (render it the usual way).
 */
export const getColoredTextLines = (
  element: Pick<
    ExcalidrawTextElement,
    "text" | "originalText" | "strokeColor" | "colorRanges"
  >,
): ColoredSegment[][] | null => {
  const ranges = element.colorRanges;
  if (!ranges?.length) {
    return null;
  }
  const defaultColor = element.strokeColor;
  const original = element.originalText.replace(/\r\n?/g, "\n");
  const text = element.text.replace(/\r\n?/g, "\n");

  const originalColors: string[] = new Array(original.length).fill(
    defaultColor,
  );
  for (const range of ranges) {
    for (
      let index = Math.max(0, range.start);
      index < Math.min(original.length, range.end);
      index++
    ) {
      originalColors[index] = range.color;
    }
  }

  // wrapping only turns whitespace into line breaks, inserts line breaks and
  // drops whitespace around them — walk both strings to align them
  const colors: string[] = new Array(text.length);
  let i = 0;
  for (let j = 0; j < text.length; j++) {
    const char = text[j];
    if (char === original[i]) {
      colors[j] = originalColors[i];
      i++;
    } else if (char === "\n") {
      colors[j] = defaultColor;
      if (isWhitespace(original[i])) {
        i++;
      }
    } else {
      while (isWhitespace(original[i]) && original[i] !== char) {
        i++;
      }
      colors[j] = originalColors[i] ?? defaultColor;
      if (original[i] === char) {
        i++;
      }
    }
  }

  const lines: ColoredSegment[][] = [[]];
  for (let j = 0; j < text.length; j++) {
    const char = text[j];
    const line = lines[lines.length - 1];
    if (char === "\n") {
      lines.push([]);
      continue;
    }
    const last = line[line.length - 1];
    if (last && last.color === colors[j]) {
      last.text += char;
    } else {
      line.push({ text: char, color: colors[j] });
    }
  }
  return lines;
};
