import {
  compactElement,
  getLivePages,
  isNewer,
  mergeVersioned,
  pruneTombstones,
  sanitizeElement,
  sanitizePage,
  sanitizePatch,
  sortByIndex,
} from "./reconcile";

import type { PageMeta, SyncedElement } from "./protocol";

const el = (
  id: string,
  version: number,
  versionNonce: number,
  extra: Partial<SyncedElement> = {},
): SyncedElement => ({
  id,
  type: "rectangle",
  version,
  versionNonce,
  ...extra,
});

const page = (id: string, index: string, extra: Partial<PageMeta> = {}) =>
  ({
    id,
    name: "",
    index,
    version: 1,
    versionNonce: 1,
    updated: 0,
    isDeleted: false,
    ...extra,
  } as PageMeta);

describe("whiteboard-server reconcile", () => {
  it("prefers higher versions, then lower nonces (same as Excalidraw)", () => {
    expect(isNewer(el("a", 2, 5), el("a", 1, 1))).toBe(true);
    expect(isNewer(el("a", 1, 1), el("a", 2, 5))).toBe(false);
    expect(isNewer(el("a", 2, 3), el("a", 2, 5))).toBe(true);
    expect(isNewer(el("a", 2, 5), el("a", 2, 3))).toBe(false);
    // identical updates are not re-broadcast
    expect(isNewer(el("a", 2, 5), el("a", 2, 5))).toBe(false);
    expect(isNewer(el("a", 1, 1), undefined)).toBe(true);
  });

  it("merges and returns only accepted elements", () => {
    const map = new Map([
      ["a", el("a", 3, 10)],
      ["b", el("b", 1, 10)],
    ]);
    const accepted = mergeVersioned(map, [
      el("a", 2, 1), // stale
      el("b", 2, 1), // newer
      el("c", 1, 1), // new
    ]);
    expect(accepted.map((element) => element.id)).toEqual(["b", "c"]);
    expect(map.get("a")!.version).toBe(3);
    expect(map.get("b")!.version).toBe(2);
    expect(map.size).toBe(3);
  });

  it("converges regardless of the order updates arrive in", () => {
    const updates = [
      el("x", 2, 50),
      el("x", 2, 20),
      el("x", 3, 99),
      el("x", 1, 1),
    ];
    const results = [updates, [...updates].reverse()].map((order) => {
      const map = new Map<string, SyncedElement>();
      for (const update of order) {
        mergeVersioned(map, [update]);
      }
      return map.get("x");
    });
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ version: 3, versionNonce: 99 });
  });

  it("rejects malformed elements", () => {
    expect(sanitizeElement(null)).toBe(null);
    expect(sanitizeElement([])).toBe(null);
    expect(sanitizeElement({ id: "a", type: "rectangle", version: 1 })).toBe(
      null,
    );
    expect(
      sanitizeElement({ id: "", type: "x", version: 1, versionNonce: 1 }),
    ).toBe(null);
    expect(
      sanitizeElement({
        id: "a",
        type: "rectangle",
        version: Number.NaN,
        versionNonce: 1,
      }),
    ).toBe(null);
    expect(
      sanitizeElement({
        id: "a",
        type: "rectangle",
        version: 1,
        versionNonce: 1,
      }),
    ).toMatchObject({ id: "a" });
  });

  it("sanitizes pages", () => {
    expect(sanitizePage({ ...page("../etc", "a0") })).toBe(null);
    expect(sanitizePage({ ...page("p1", "a0;") })).toBe(null);
    expect(
      sanitizePage({ ...page("p1", "a0"), name: "x".repeat(500) })!.name,
    ).toHaveLength(120);
    expect(
      sanitizePage({ ...page("p1", "a0"), isDeleted: "yes" })!.isDeleted,
    ).toBe(false);
  });

  it("orders pages by fractional index and hides deleted ones", () => {
    const pages = [
      page("c", "a2"),
      page("a", "a0"),
      page("d", "a1", { isDeleted: true }),
      page("b", "a1"),
    ];
    expect(getLivePages(pages).map((p) => p.id)).toEqual(["a", "b", "c"]);
    // ties are broken by id, like Excalidraw's orderByFractionalIndex
    expect(
      sortByIndex([
        el("z", 1, 1, { index: "a0" }),
        el("y", 1, 1, { index: "a0" }),
      ]).map((element) => element.id),
    ).toEqual(["y", "z"]);
  });

  it("prunes old tombstones only", () => {
    const now = 1_000_000;
    const map = new Map([
      ["old", el("old", 2, 1, { isDeleted: true, updated: now - 5000 })],
      ["recent", el("recent", 2, 1, { isDeleted: true, updated: now - 10 })],
      ["alive", el("alive", 2, 1, { updated: now - 5000 })],
    ]);
    expect(pruneTombstones(map, 1000, now)).toBe(1);
    expect([...map.keys()]).toEqual(["recent", "alive"]);
  });

  it("rounds stroke points to 1/100 px and pressures to 1/1000", () => {
    const stroke = el("s", 3, 1, {
      type: "freedraw",
      points: [
        [0, 0],
        [12.345678901234567, -3.0049999999999],
        [277.42776459854015, 1e-9],
      ],
      pressures: [0.37109375, 0.5, 0.6669921875],
    });
    const compact = compactElement(stroke);
    expect(compact.points).toEqual([
      [0, 0],
      [12.35, -3],
      [277.43, 0],
    ]);
    expect(compact.pressures).toEqual([0.371, 0.5, 0.667]);
    // everything else is kept, and the input isn't changed
    expect(compact).toMatchObject({ id: "s", version: 3, versionNonce: 1 });
    expect((stroke.points as number[][])[1][0]).toBe(12.345678901234567);
    // already compact: the same object (nothing to save)
    expect(compactElement(compact)).toBe(compact);
    const rect = el("r", 1, 1, { points: [[0.123456, 0]] });
    expect(compactElement(rect)).toBe(rect);
    // incoming elements and patches are compacted
    expect(sanitizeElement(stroke)!.points).toEqual(compact.points);
    const patch = sanitizePatch({
      id: "s",
      baseVersion: 3,
      baseVersionNonce: 1,
      basePointCount: 3,
      version: 4,
      versionNonce: 2,
      set: {},
      appendPoints: [[1.23456, 7.891011]],
      appendPressures: [0.123456],
    })!;
    expect(patch.appendPoints).toEqual([[1.23, 7.89]]);
    expect(patch.appendPressures).toEqual([0.123]);
  });
});
