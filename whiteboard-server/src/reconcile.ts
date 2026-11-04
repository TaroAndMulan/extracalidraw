/**
 * Server-side reconciliation.
 *
 * Mirrors the rule Excalidraw clients use (`shouldDiscardRemoteElement`): the
 * element with the higher `version` wins; on equal versions the lower
 * `versionNonce` wins. Because every peer and the server apply the same total
 * order, everyone converges to the same state regardless of message order.
 */

import type { PageMeta, SyncedElement } from "./protocol";

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
  return element as SyncedElement;
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
