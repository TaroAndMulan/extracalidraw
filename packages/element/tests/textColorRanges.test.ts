import {
  applyColorRange,
  getColoredTextLines,
  normalizeColorRanges,
  shiftColorRanges,
} from "../src/textColorRanges";

import type { TextColorRange } from "../src/types";

const RED = "#e03131";
const BLUE = "#1971c2";
const BLACK = "#1e1e1e";

const range = (start: number, end: number, color = RED): TextColorRange => ({
  start,
  end,
  color,
});

describe("text color ranges", () => {
  describe("applyColorRange", () => {
    it("colors a part of the text", () => {
      expect(applyColorRange(undefined, 6, 11, RED, BLACK, 11)).toEqual([
        range(6, 11),
      ]);
    });

    it("recolors overlapping parts and keeps the rest", () => {
      // "hello world": "hello" red, then "llo w" blue
      const ranges = applyColorRange([range(0, 5)], 2, 7, BLUE, BLACK, 11);
      expect(ranges).toEqual([range(0, 2), range(2, 7, BLUE)]);
    });

    it("the default color removes coloring", () => {
      expect(applyColorRange([range(0, 5)], 1, 3, BLACK, BLACK, 11)).toEqual([
        range(0, 1),
        range(3, 5),
      ]);
      expect(applyColorRange([range(0, 5)], 0, 5, BLACK, BLACK, 11)).toBe(
        undefined,
      );
    });

    it("merges neighbours of the same color", () => {
      expect(applyColorRange([range(0, 3)], 3, 6, RED, BLACK, 10)).toEqual([
        range(0, 6),
      ]);
    });
  });

  describe("normalizeColorRanges", () => {
    it("drops invalid entries and clamps to the text", () => {
      expect(
        normalizeColorRanges(
          [
            range(-5, 3),
            range(4, 4),
            { start: 5, end: 99, color: "not a color!" },
            { start: NaN, end: 2, color: RED },
            range(8, 50, BLUE),
          ],
          10,
        ),
      ).toEqual([range(0, 3), range(8, 10, BLUE)]);
      expect(normalizeColorRanges([], 10)).toBe(undefined);
      expect(normalizeColorRanges(null, 10)).toBe(undefined);
    });
  });

  describe("shiftColorRanges", () => {
    // "the red word": "red" = [4, 7)
    const ranges = [range(4, 7)];
    const text = "the red word";

    it("moves ranges when typing before them", () => {
      expect(shiftColorRanges(ranges, text, `so ${text}`)).toEqual([
        range(7, 10),
      ]);
    });

    it("typing right after a colored word continues its color", () => {
      expect(shiftColorRanges(ranges, text, "the reddd word")).toEqual([
        range(4, 9),
      ]);
    });

    it("typing right before a colored word doesn't", () => {
      expect(shiftColorRanges(ranges, text, "the  red word")).toEqual([
        range(5, 8),
      ]);
    });

    it("typing inside grows the range", () => {
      expect(shiftColorRanges(ranges, text, "the rexd word")).toEqual([
        range(4, 8),
      ]);
    });

    it("replacing the colored word keeps its color", () => {
      expect(shiftColorRanges(ranges, text, "the blue word")).toEqual([
        range(4, 8),
      ]);
    });

    it("deleting the colored word removes the range", () => {
      expect(shiftColorRanges(ranges, text, "the  word")).toBe(undefined);
    });

    it("deleting part of it shrinks the range", () => {
      expect(shiftColorRanges(ranges, text, "the rd word")).toEqual([
        range(4, 6),
      ]);
    });

    it("edits after the range leave it alone", () => {
      expect(shiftColorRanges(ranges, text, "the red words!")).toEqual(ranges);
    });
  });

  describe("getColoredTextLines", () => {
    it("returns null without partial colors", () => {
      expect(
        getColoredTextLines({
          text: "a",
          originalText: "a",
          strokeColor: BLACK,
        }),
      ).toBe(null);
    });

    it("splits lines into colored segments", () => {
      expect(
        getColoredTextLines({
          text: "the red word\nnext",
          originalText: "the red word\nnext",
          strokeColor: BLACK,
          colorRanges: [range(4, 7), range(13, 17, BLUE)],
        }),
      ).toEqual([
        [
          { text: "the ", color: BLACK },
          { text: "red", color: RED },
          { text: " word", color: BLACK },
        ],
        [{ text: "next", color: BLUE }],
      ]);
    });

    it("follows wrapping (spaces turned into or dropped at line breaks)", () => {
      // "two three" is red, whatever the wrapping
      for (const text of [
        "one two\nthree",
        "one two \nthree",
        "one\ntwo\nthr\nee",
      ]) {
        const segments = getColoredTextLines({
          text,
          originalText: "one two three",
          strokeColor: BLACK,
          colorRanges: [range(4, 13)],
        })!.flat();
        const textIn = (color: string) =>
          segments
            .filter((segment) => segment.color === color)
            .map((segment) => segment.text)
            .join("")
            .replace(/\s/g, "");
        expect(textIn(RED)).toBe("twothree");
        expect(textIn(BLACK)).toBe("one");
      }
    });
  });
});
