import { createStore, get, set } from "idb-keyval";

import type { LibraryPersistedData } from "@excalidraw/excalidraw/data/library";

const store = createStore("whiteboard-library-db", "whiteboard-library-store");
const KEY = "libraryData";

/** keeps each user's shape library in their browser */
export const LibraryIndexedDBAdapter = {
  async load() {
    return (await get<LibraryPersistedData>(KEY, store)) ?? null;
  },
  save(data: LibraryPersistedData) {
    return set(KEY, data, store);
  },
};
