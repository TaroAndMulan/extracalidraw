/**
 * Server-side reconciliation.
 *
 * Mirrors the rule Excalidraw clients use (`shouldDiscardRemoteElement`): the
 * element with the higher `version` wins; on equal versions the lower
 * `versionNonce` wins. Because every peer and the server apply the same total
 * order, everyone converges to the same state regardless of message order.
 */

import { PATCHABLE_KEYS } from "./protocol";

import type { ElementPatch, PageMeta, SyncedElement } from "./protocol";

type Versioned = { version: number; versionNonce: number };

const MAX_ID_LENGTH = 128;
const MAX_PAGE_NAME_LENGTH = 120;
const PAGE_INDEX_RE = /^[0-9A-Za-z]{1,200}$/;
const PAGE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export const isNewer = (incoming: Versioned, existing?: Versioned | null) =>
  !existing ||
  incoming.version > existing.version ||
  (incoming.version === existing.version &&
    incoming.versionNonce < existing.versionNonce);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isPoint = (value: unknown): value is [number, number] =>
  Array.isArray(value) &&
  value.length === 2 &&
  isFiniteNumber(value[0]) &&
  isFiniteNumber(value[1]);

// -----------------------------------------------------------------------------
// compact strokes
// -----------------------------------------------------------------------------

/**
 * Stroke points are kept to 1/100 px and pressures to 1/1000. The editor
 * computes points as `clientX / zoom - scrollX`, which gives 17-digit numbers:
 * rounding them halves a page of handwriting (4× smaller compressed, on disk
 * and on the wire) without any visible difference, even zoomed in.
 */
const POINT_PRECISION = 100;
const PRESSURE_PRECISION = 1000;

const roundTo = (value: number, precision: number) =>
  Math.round(value * precision) / precision;

/** the same array when nothing changed (so callers can tell) */
const mapChanged = <T>(values: T[], map: (value: T) => T): T[] => {
  let changed = false;
  const next = values.map((value) => {
    const mapped = map(value);
    changed ||= mapped !== value;
    return mapped;
  });
  return changed ? next : values;
};

const roundPoint = <T>(value: T): T => {
  if (!isPoint(value)) {
    return value;
  }
  const x = roundTo(value[0], POINT_PRECISION);
  const y = roundTo(value[1], POINT_PRECISION);
  return x === value[0] && y === value[1] ? value : ([x, y] as T);
};

const roundPressure = <T>(value: T): T =>
  isFiniteNumber(value) ? (roundTo(value, PRESSURE_PRECISION) as T) : value;

export const roundPoints = <T>(points: T[]) => mapChanged(points, roundPoint);

export const roundPressures = <T>(pressures: T[]) =>
  mapChanged(pressures, roundPressure);

/** a stroke with rounded points; other elements (and compact strokes) as is */
export const compactElement = (element: SyncedElement): SyncedElement => {
  if (element.type !== "freedraw" || !Array.isArray(element.points)) {
    return element;
  }
  const points = roundPoints(element.points as unknown[]);
  const pressures = Array.isArray(element.pressures)
    ? roundPressures(element.pressures as unknown[])
    : element.pressures;
  return points === element.points && pressures === element.pressures
    ? element
    : { ...element, points, pressures };
};

/** validates the fields the server relies on; the rest stays opaque */
export const sanitizeElement = (value: unknown): SyncedElement | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const element = value as Record<string, unknown>;
  if (
    typeof element.id !== "string" ||
    !element.id ||
    element.id.length > MAX_ID_LENGTH ||
    typeof element.type !== "string" ||
    !isFiniteNumber(element.version) ||
    !isFiniteNumber(element.versionNonce)
  ) {
    return null;
  }
  return compactElement(element as SyncedElement);
};

export const sanitizePage = (value: unknown): PageMeta | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const page = value as Record<string, unknown>;
  if (
    typeof page.id !== "string" ||
    !PAGE_ID_RE.test(page.id) ||
    typeof page.index !== "string" ||
    !PAGE_INDEX_RE.test(page.index) ||
    !isFiniteNumber(page.version) ||
    !isFiniteNumber(page.versionNonce)
  ) {
    return null;
  }
  return {
    id: page.id,
    name:
      typeof page.name === "string"
        ? page.name.slice(0, MAX_PAGE_NAME_LENGTH)
        : "",
    index: page.index,
    version: page.version,
    versionNonce: page.versionNonce,
    updated: isFiniteNumber(page.updated) ? page.updated : Date.now(),
    isDeleted: page.isDeleted === true,
  };
};

/**
 * Merges `incoming` into `target` (mutating it) and returns the elements that
 * were accepted, i.e. the ones other clients need to hear about.
 */
export const mergeVersioned = <T extends Versioned & { id: string }>(
  target: Map<string, T>,
  incoming: readonly T[],
): T[] => {
  const accepted: T[] = [];
  for (const item of incoming) {
    if (isNewer(item, target.get(item.id))) {
      target.set(item.id, item);
      accepted.push(item);
    }
  }
  return accepted;
};

const compareIndex = (
  a: { index?: unknown; id: string },
  b: { index?: unknown; id: string },
) => {
  const ai = typeof a.index === "string" ? a.index : "";
  const bi = typeof b.index === "string" ? b.index : "";
  if (ai < bi) {
    return -1;
  }
  if (ai > bi) {
    return 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/** same ordering as Excalidraw's `orderByFractionalIndex` */
export const sortByIndex = <T extends { index?: unknown; id: string }>(
  items: Iterable<T>,
): T[] => [...items].sort(compareIndex);

/** drops elements deleted longer than `ttlMs` ago */
export const pruneTombstones = (
  elements: Map<string, SyncedElement>,
  ttlMs: number,
  now = Date.now(),
) => {
  let pruned = 0;
  for (const [id, element] of elements) {
    if (
      element.isDeleted &&
      isFiniteNumber(element.updated) &&
      now - element.updated > ttlMs
    ) {
      elements.delete(id);
      pruned++;
    }
  }
  return pruned;
};

export const getLivePages = (pages: Iterable<PageMeta>) =>
  sortByIndex([...pages].filter((page) => !page.isDeleted));

const MAX_PATCH_POINTS = 20_000;
/** a stroke can't grow beyond this through patches */
export const MAX_STROKE_POINTS = 100_000;

/** validates an untrusted patch (see `ElementPatch`) */
export const sanitizePatch = (value: unknown): ElementPatch | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const patch = value as Record<string, any>;
  if (
    typeof patch.id !== "string" ||
    !patch.id ||
    patch.id.length > MAX_ID_LENGTH ||
    !isFiniteNumber(patch.baseVersion) ||
    !isFiniteNumber(patch.baseVersionNonce) ||
    !isFiniteNumber(patch.basePointCount) ||
    !isFiniteNumber(patch.version) ||
    !isFiniteNumber(patch.versionNonce) ||
    !Array.isArray(patch.appendPoints) ||
    patch.appendPoints.length > MAX_PATCH_POINTS ||
    !patch.appendPoints.every(isPoint) ||
    !Array.isArray(patch.appendPressures ?? []) ||
    !(patch.appendPressures ?? []).every(isFiniteNumber) ||
    !patch.set ||
    typeof patch.set !== "object"
  ) {
    return null;
  }
  const set: Record<string, unknown> = {};
  for (const [key, setValue] of Object.entries(patch.set)) {
    if (!(PATCHABLE_KEYS as readonly string[]).includes(key)) {
      return null;
    }
    const isSimple =
      setValue === null ||
      ["number", "string", "boolean"].includes(typeof setValue) ||
      isPoint(setValue);
    if (!isSimple) {
      return null;
    }
    set[key] = setValue;
  }
  return {
    id: patch.id,
    baseVersion: patch.baseVersion,
    baseVersionNonce: patch.baseVersionNonce,
    basePointCount: patch.basePointCount,
    version: patch.version,
    versionNonce: patch.versionNonce,
    set,
    appendPoints: roundPoints(patch.appendPoints),
    appendPressures: roundPressures(patch.appendPressures ?? []),
  };
};

/**
 * The element a patch produces, or `null` when it doesn't apply on top of
 * `base` (missing, other version, not a stroke) — the full element is needed.
 */
export const applyPatch = (
  base: SyncedElement | undefined,
  patch: ElementPatch,
): SyncedElement | null => {
  if (
    !base ||
    base.version !== patch.baseVersion ||
    base.versionNonce !== patch.baseVersionNonce ||
    base.type !== "freedraw" ||
    !Array.isArray(base.points) ||
    base.points.length !== patch.basePointCount ||
    base.points.length + patch.appendPoints.length > MAX_STROKE_POINTS ||
    patch.version <= base.version
  ) {
    return null;
  }
  return {
    ...base,
    ...patch.set,
    points: [...(base.points as unknown[]), ...patch.appendPoints],
    pressures: [
      ...(Array.isArray(base.pressures) ? (base.pressures as unknown[]) : []),
      ...patch.appendPressures,
    ],
    version: patch.version,
    versionNonce: patch.versionNonce,
  };
};
