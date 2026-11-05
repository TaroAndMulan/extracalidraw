/**
 * While someone draws a stroke, it grows by a point per pointer move. Sending
 * the whole stroke every time (all its points so far) wastes bandwidth and
 * delays everything on slower connections, so the session sends only the
 * points added since the last send (`ElementPatch`), building on a snapshot
 * of what was sent.
 */

import type { OrderedExcalidrawElement } from "@excalidraw/element/types";

import {
  PATCHABLE_KEYS,
  type ElementPatch,
} from "../../../whiteboard-server/src/protocol";

/** what was last sent of a stroke (strokes are mutated in place) */
export interface SentSnapshot {
  version: number;
  versionNonce: number;
  pointsLength: number;
  firstPoint: readonly [number, number];
  lastPoint: readonly [number, number];
  pressuresLength: number;
  /** every other property, by reference */
  props: Record<string, unknown>;
}

const SKIPPED = new Set(["points", "pressures", "version", "versionNonce"]);

type Stroke = OrderedExcalidrawElement & {
  points: readonly (readonly [number, number])[];
  pressures: readonly number[];
};

const isStroke = (element: OrderedExcalidrawElement): element is Stroke =>
  element.type === "freedraw" &&
  Array.isArray((element as Stroke).points) &&
  (element as Stroke).points.length > 0;

const samePoint = (
  a: readonly [number, number] | undefined,
  b: readonly [number, number] | undefined,
) => !!a && !!b && a[0] === b[0] && a[1] === b[1];

const isSimpleValue = (value: unknown) =>
  value === null ||
  ["number", "string", "boolean"].includes(typeof value) ||
  (Array.isArray(value) &&
    value.length === 2 &&
    value.every((n) => typeof n === "number"));

export const snapshotElement = (
  element: OrderedExcalidrawElement,
): SentSnapshot | null => {
  if (!isStroke(element)) {
    return null;
  }
  const props: Record<string, unknown> = {};
  for (const key of Object.keys(element)) {
    if (!SKIPPED.has(key)) {
      props[key] = (element as any)[key];
    }
  }
  return {
    version: element.version,
    versionNonce: element.versionNonce,
    pointsLength: element.points.length,
    firstPoint: element.points[0],
    lastPoint: element.points[element.points.length - 1],
    pressuresLength: element.pressures?.length ?? 0,
    props,
  };
};

/**
 * A patch taking the stroke from `snapshot` to `element`, or `null` when the
 * change isn't just "more points" (then the full element is sent).
 */
export const createPatch = (
  element: OrderedExcalidrawElement,
  snapshot: SentSnapshot | undefined,
): ElementPatch | null => {
  if (
    !snapshot ||
    !isStroke(element) ||
    element.version <= snapshot.version ||
    element.points.length <= snapshot.pointsLength ||
    !samePoint(element.points[0], snapshot.firstPoint) ||
    !samePoint(element.points[snapshot.pointsLength - 1], snapshot.lastPoint) ||
    (element.pressures?.length ?? 0) < snapshot.pressuresLength
  ) {
    return null;
  }
  const set: Record<string, unknown> = {};
  const keys = new Set([
    ...Object.keys(element),
    ...Object.keys(snapshot.props),
  ]);
  for (const key of keys) {
    if (SKIPPED.has(key)) {
      continue;
    }
    const value = (element as any)[key];
    if (Object.is(value, snapshot.props[key])) {
      continue;
    }
    if (
      !(PATCHABLE_KEYS as readonly string[]).includes(key) ||
      !isSimpleValue(value)
    ) {
      return null;
    }
    set[key] = value;
  }
  return {
    id: element.id,
    baseVersion: snapshot.version,
    baseVersionNonce: snapshot.versionNonce,
    basePointCount: snapshot.pointsLength,
    version: element.version,
    versionNonce: element.versionNonce,
    set,
    appendPoints: element.points
      .slice(snapshot.pointsLength)
      .map((point) => [point[0], point[1]] as [number, number]),
    appendPressures: (element.pressures ?? []).slice(snapshot.pressuresLength),
  };
};
