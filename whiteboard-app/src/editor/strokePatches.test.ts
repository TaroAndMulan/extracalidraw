import type { OrderedExcalidrawElement } from "@excalidraw/element/types";

import {
  applyPatch,
  sanitizePatch,
} from "../../../whiteboard-server/src/reconcile";

import { createPatch, snapshotElement } from "./strokePatches";

import type { SyncedElement } from "../../../whiteboard-server/src/protocol";

const stroke = (points: [number, number][], extra: object = {}) =>
  ({
    id: "s1",
    type: "freedraw",
    x: 10,
    y: 20,
    width: 100,
    height: 50,
    angle: 0,
    strokeColor: "#1e1e1e",
    index: "a0",
    version: points.length,
    versionNonce: 1000 + points.length,
    updated: points.length,
    isDeleted: false,
    points,
    pressures: points.map(() => 0.5),
    simulatePressure: false,
    lastCommittedPoint: null,
    strokeOptions: { variability: "variable", streamline: 0.5 },
    ...extra,
  } as unknown as OrderedExcalidrawElement);

const grow = (
  element: OrderedExcalidrawElement,
  more: [number, number][],
  extra: object = {},
) => {
  const points = [...(element as any).points, ...more];
  return {
    ...element,
    points,
    pressures: points.map(() => 0.5),
    version: element.version + more.length,
    versionNonce: element.versionNonce + 7,
    width: element.width + more.length,
    updated: element.updated + 1,
    ...extra,
  } as OrderedExcalidrawElement;
};

describe("stroke patches", () => {
  const start = stroke([
    [0, 0],
    [1, 1],
  ]);

  it("sends only the new points and rebuilds the same stroke", () => {
    const snapshot = snapshotElement(start)!;
    const next = grow(start, [
      [2, 3],
      [4, 5],
    ]);
    const patch = createPatch(next, snapshot)!;
    expect(patch.appendPoints).toEqual([
      [2, 3],
      [4, 5],
    ]);
    expect(patch.set).toEqual({ width: next.width, updated: next.updated });
    // survives validation on the server and gives the full element back
    const rebuilt = applyPatch(
      start as unknown as SyncedElement,
      sanitizePatch(JSON.parse(JSON.stringify(patch)))!,
    );
    expect(rebuilt).toEqual(JSON.parse(JSON.stringify(next)));
  });

  it("chains: each patch builds on the previous one", () => {
    let snapshot = snapshotElement(start)!;
    let element = start;
    let remote = start as unknown as SyncedElement;
    for (let i = 2; i < 30; i++) {
      element = grow(element, [[i, i * 2]]);
      remote = applyPatch(remote, createPatch(element, snapshot)!)!;
      snapshot = snapshotElement(element)!;
    }
    expect(remote).toEqual(element);
  });

  it("sends the full element for other changes", () => {
    const snapshot = snapshotElement(start)!;
    // color changed
    expect(
      createPatch(grow(start, [[2, 2]], { strokeColor: "#e03131" }), snapshot),
    ).toBe(null);
    // points rewritten instead of appended
    expect(
      createPatch(
        {
          ...grow(start, [[2, 2]]),
          points: [
            [0, 0],
            [9, 9],
            [2, 2],
          ],
        } as any,
        snapshot,
      ),
    ).toBe(null);
    // nothing new
    expect(createPatch({ ...start, version: 99 } as any, snapshot)).toBe(null);
    // not a stroke
    expect(snapshotElement({ ...start, type: "rectangle" } as any)).toBe(null);
  });

  it("doesn't apply on top of anything but its base", () => {
    const patch = createPatch(grow(start, [[2, 2]]), snapshotElement(start)!)!;
    const base = start as unknown as SyncedElement;
    expect(applyPatch(undefined, patch)).toBe(null);
    expect(applyPatch({ ...base, version: base.version + 1 }, patch)).toBe(
      null,
    );
    expect(applyPatch({ ...base, versionNonce: 1 }, patch)).toBe(null);
    expect(
      applyPatch({ ...base, points: [[0, 0]] } as SyncedElement, patch),
    ).toBe(null);
    expect(applyPatch({ ...base, type: "rectangle" }, patch)).toBe(null);
  });

  it("rejects malformed patches", () => {
    const patch = createPatch(grow(start, [[2, 2]]), snapshotElement(start)!)!;
    expect(sanitizePatch({ ...patch, set: { strokeColor: "red" } })).toBe(null);
    expect(sanitizePatch({ ...patch, set: { width: { a: 1 } } })).toBe(null);
    expect(sanitizePatch({ ...patch, appendPoints: [[1, "x"]] })).toBe(null);
    expect(sanitizePatch({ ...patch, baseVersionNonce: undefined })).toBe(null);
    expect(sanitizePatch(null)).toBe(null);
    expect(sanitizePatch(patch)).toEqual(patch);
  });
});
