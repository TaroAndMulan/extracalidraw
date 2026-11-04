import { exportScene, hashElementsVersion } from "@excalidraw/excalidraw";

import type { ExportSceneData } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { NonDeletedExcalidrawElement } from "@excalidraw/element/types";

import type { PaperSession } from "./session";

const THUMBNAIL_SIZE = 320;

export const renderPagePNG = async (
  excalidrawAPI: ExcalidrawImperativeAPI,
  elements: readonly NonDeletedExcalidrawElement[],
  maxSize: number,
  theme: "light" | "dark" = "light",
) =>
  exportScene({
    type: "png",
    data: {
      elements,
      appState: {
        viewBackgroundColor: excalidrawAPI.getAppState().viewBackgroundColor,
      } as ExportSceneData["appState"],
      files: excalidrawAPI.getFiles(),
    },
    config: { maxWidthOrHeight: maxSize, padding: 16, theme },
  });

/**
 * Renders small previews of pages, one at a time and only when something
 * changed, so the editor stays responsive.
 */
export class PageThumbnails {
  private cache = new Map<string, { key: number; url: string | null }>();
  private stale = new Set<string>();
  private wanted = new Set<string>();
  private running = false;
  private timer: number | null = null;
  private listeners = new Set<() => void>();
  private version = 0;
  private unsubscribe: () => void;

  constructor(
    private readonly session: PaperSession,
    private readonly getApi: () => ExcalidrawImperativeAPI | null,
  ) {
    this.unsubscribe = session.onPageContentChange((pageId) => {
      this.stale.add(pageId);
      if (this.wanted.has(pageId)) {
        this.schedule(pageId === session.getState().currentPageId ? 800 : 250);
      }
    });
  }

  destroy() {
    this.unsubscribe();
    if (this.timer) {
      window.clearTimeout(this.timer);
    }
    for (const { url } of this.cache.values()) {
      if (url) {
        URL.revokeObjectURL(url);
      }
    }
    this.cache.clear();
    this.listeners.clear();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getVersion = () => this.version;

  get(pageId: string) {
    return this.cache.get(pageId)?.url;
  }

  /** the pages whose thumbnails are on screen */
  setWanted(pageIds: string[]) {
    this.wanted = new Set(pageIds);
    if (pageIds.some((id) => !this.cache.has(id) || this.stale.has(id))) {
      this.schedule(50);
    }
  }

  private schedule(delay: number) {
    if (this.timer) {
      window.clearTimeout(this.timer);
    }
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.run();
    }, delay);
  }

  private async run() {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      for (const pageId of this.wanted) {
        const api = this.getApi();
        if (!api) {
          break;
        }
        const elements = this.session.getElements(pageId);
        const theme = api.getAppState().theme;
        // re-render when the theme changes too
        const key =
          hashElementsVersion(elements) + (theme === "dark" ? 0.5 : 0);
        const cached = this.cache.get(pageId);
        this.stale.delete(pageId);
        if (cached?.key === key) {
          continue;
        }
        const visible = elements.filter(
          (element) => !element.isDeleted,
        ) as NonDeletedExcalidrawElement[];
        let url: string | null = null;
        if (visible.length) {
          try {
            url = URL.createObjectURL(
              await renderPagePNG(api, visible, THUMBNAIL_SIZE, theme),
            );
          } catch (error) {
            console.warn("[thumbnails]", error);
          }
        }
        if (cached?.url) {
          URL.revokeObjectURL(cached.url);
        }
        this.cache.set(pageId, { key, url });
        this.version++;
        for (const listener of this.listeners) {
          listener();
        }
        // let the editor breathe between renders
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
    } finally {
      this.running = false;
    }
    if ([...this.wanted].some((id) => this.stale.has(id))) {
      this.schedule(250);
    }
  }
}
