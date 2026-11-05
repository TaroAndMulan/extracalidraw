/**
 * Keeps images in sync with the server.
 *
 * Image elements only reference a `fileId` (a hash of the file); the data is
 * uploaded once per paper and downloaded by everyone who needs it. While an
 * upload is in progress the element's status is "pending"; once uploaded it
 * becomes "saved".
 *
 * To make a pasted image show up for others right away, it's also pushed
 * over the live connection: small images whole, bigger ones as a quick
 * low-resolution preview first (the full file then goes over HTTP — a
 * separate connection, so it doesn't hold up drawing — and others download it
 * as soon as the server has it).
 */

import { MIME_TYPES } from "@excalidraw/common";

import type {
  BinaryFileData,
  DataURL,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";

import { api } from "../api";

import type { PaperSocket } from "./session";

const MAX_ATTEMPTS = 4;
/** images up to this size go whole over the live connection */
const INLINE_MAX_BYTES = 64 * 1024;
const PREVIEW_MAX_SIDE = 640;
const PREVIEW_QUALITY = 0.7;
const PREVIEW_MAX_BYTES = 192 * 1024;
const LIVE_ACK_TIMEOUT_MS = 20_000;
/** pictures we can shrink (not svg; gif may be animated) */
const RASTER_MIME_RE = /^image\/(png|jpeg|webp|bmp|avif)$/;

const blobToDataURL = (blob: Blob) =>
  new Promise<DataURL>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as DataURL);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

const dataURLToBlob = async (dataURL: string) => (await fetch(dataURL)).blob();

/** a small, quick version of a picture, or `null` if not worth it */
const makePreview = async (blob: Blob): Promise<Blob | null> => {
  if (typeof createImageBitmap !== "function") {
    return null;
  }
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(
      1,
      PREVIEW_MAX_SIDE / Math.max(bitmap.width, bitmap.height),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas
      .getContext("2d")
      ?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const preview = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", PREVIEW_QUALITY),
    );
    // (browsers that can't encode WebP give a PNG, often not much smaller)
    return preview && preview.size <= Math.min(PREVIEW_MAX_BYTES, blob.size / 3)
      ? preview
      : null;
  } finally {
    bitmap.close();
  }
};

export class FileSync {
  /** files known to be on the server */
  private stored = new Set<string>();
  private uploading = new Set<string>();
  private downloading = new Set<string>();
  private attempts = new Map<string, number>();
  private retryTimer: number | null = null;
  private destroyed = false;
  /** files we only have a preview of */
  private previews = new Set<string>();
  /** files received whole over the live connection (stored by the sender) */
  private relayed = new Set<string>();
  /** full files being received over the live connection */
  private incoming = new Set<string>();
  /** files the server told us it has (download without waiting) */
  private serverHas = new Set<string>();
  /** files received before their element: the scene must pick them up */
  private awaitingElement = new Set<string>();

  constructor(
    private readonly paperId: string,
    private readonly opts: {
      shareToken: string | null;
      getApi: () => ExcalidrawImperativeAPI | null;
      /** the live connection, when connected */
      getSocket: () => PaperSocket | null;
      canUpload: () => boolean;
      onImageStatusChange: (fileId: string, status: "saved" | "error") => void;
    },
  ) {}

  destroy() {
    this.destroyed = true;
    if (this.retryTimer) {
      window.clearTimeout(this.retryTimer);
    }
  }

  /** uploads new images and downloads missing ones */
  sync(elements: readonly ExcalidrawElement[]) {
    const excalidrawAPI = this.opts.getApi();
    if (!excalidrawAPI || this.destroyed) {
      return;
    }
    const files = excalidrawAPI.getFiles();
    const toDownload: string[] = [];
    let refresh = false;

    for (const element of elements) {
      if (element.type !== "image" || !element.fileId || element.isDeleted) {
        continue;
      }
      const fileId = element.fileId;
      const local = files[fileId];
      if (local && this.awaitingElement.delete(fileId)) {
        refresh = true;
      }
      if (this.relayed.has(fileId) || this.incoming.has(fileId)) {
        continue;
      }
      if (local && !this.previews.has(fileId)) {
        if (
          !this.stored.has(fileId) &&
          !this.uploading.has(fileId) &&
          this.opts.canUpload() &&
          (this.attempts.get(fileId) ?? 0) < MAX_ATTEMPTS
        ) {
          this.upload(local);
        } else if (this.stored.has(fileId) && element.status === "pending") {
          this.opts.onImageStatusChange(fileId, "saved");
        }
      } else if (
        (element.status === "saved" || this.serverHas.has(fileId)) &&
        !this.downloading.has(fileId) &&
        (this.attempts.get(fileId) ?? 0) < MAX_ATTEMPTS
      ) {
        toDownload.push(fileId);
      }
    }

    for (const fileId of new Set(toDownload)) {
      this.download(fileId);
    }
    if (refresh) {
      // adding nothing makes the scene load the images it doesn't show yet
      excalidrawAPI.addFiles([]);
    }
  }

  /** whether we have a file's full data (not just its preview) */
  private hasFull(fileId: string) {
    return (
      !!this.opts.getApi()?.getFiles()[fileId] && !this.previews.has(fileId)
    );
  }

  /** an image pushed over the live connection */
  async receive(
    meta: { fileId: string; mimeType: string; preview?: boolean },
    bytes: ArrayBuffer,
  ) {
    const { fileId, mimeType } = meta;
    const isPreview = meta.preview === true;
    const superseded = () =>
      this.hasFull(fileId) || (isPreview && this.incoming.has(fileId));
    if (this.destroyed || superseded()) {
      return;
    }
    if (!isPreview) {
      this.incoming.add(fileId);
    }
    try {
      const dataURL = await blobToDataURL(
        new Blob([bytes], { type: mimeType }),
      );
      const excalidrawAPI = this.opts.getApi();
      // (the full one may have arrived while reading the preview)
      if (!excalidrawAPI || this.destroyed || superseded()) {
        return;
      }
      if (isPreview) {
        this.previews.add(fileId);
      } else {
        this.previews.delete(fileId);
        this.relayed.add(fileId);
      }
      this.addFile(excalidrawAPI, fileId, mimeType, dataURL);
    } catch (error) {
      console.warn("[files] couldn't read pushed image", fileId, error);
    } finally {
      if (!isPreview) {
        this.incoming.delete(fileId);
      }
    }
  }

  /** the server has stored a file someone uploaded */
  onStored(fileId: string) {
    this.serverHas.add(fileId);
    if (!this.hasFull(fileId) && !this.incoming.has(fileId)) {
      const excalidrawAPI = this.opts.getApi();
      if (excalidrawAPI) {
        this.sync(excalidrawAPI.getSceneElementsIncludingDeleted());
      }
    }
  }

  private addFile(
    excalidrawAPI: ExcalidrawImperativeAPI,
    fileId: string,
    mimeType: string,
    dataURL: DataURL,
  ) {
    const isInScene = excalidrawAPI
      .getSceneElementsIncludingDeleted()
      .some((element) => element.type === "image" && element.fileId === fileId);
    if (!isInScene) {
      this.awaitingElement.add(fileId);
    }
    excalidrawAPI.addFiles(
      [
        {
          id: fileId as FileId,
          mimeType: (mimeType ||
            MIME_TYPES.binary) as BinaryFileData["mimeType"],
          dataURL,
          created: Date.now(),
          lastRetrieved: Date.now(),
        },
      ],
      // a preview gets replaced by the full picture
      { replace: true },
    );
  }

  /**
   * Pushes an image over the live connection. Returns whether that stored
   * it (small images); otherwise only a preview went out and the caller
   * uploads the full file.
   */
  private async sendLive(fileId: string, blob: Blob) {
    const socket = this.opts.getSocket();
    if (!socket) {
      return false;
    }
    const mimeType = blob.type;
    if (blob.size <= INLINE_MAX_BYTES) {
      const bytes = await blob.arrayBuffer();
      const result = await new Promise<{ ok: boolean } | null>((resolve) => {
        const timer = window.setTimeout(
          () => resolve(null),
          LIVE_ACK_TIMEOUT_MS,
        );
        socket.emit("paper:file", { fileId, mimeType }, bytes, (response) => {
          window.clearTimeout(timer);
          resolve(response);
        });
      });
      return !!result?.ok;
    }
    if (RASTER_MIME_RE.test(mimeType)) {
      const preview = await makePreview(blob).catch(() => null);
      if (preview && !this.destroyed) {
        socket.emit(
          "paper:file",
          { fileId, mimeType: preview.type, preview: true },
          await preview.arrayBuffer(),
        );
      }
    }
    return false;
  }

  private scheduleRetry() {
    if (this.retryTimer || this.destroyed) {
      return;
    }
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      const excalidrawAPI = this.opts.getApi();
      if (excalidrawAPI) {
        this.sync(excalidrawAPI.getSceneElementsIncludingDeleted());
      }
    }, 2000);
  }

  private async upload(file: BinaryFileData) {
    const fileId = file.id;
    this.uploading.add(fileId);
    try {
      const blob = await dataURLToBlob(file.dataURL);
      const typed = new Blob([blob], { type: file.mimeType });
      const isStored = await this.sendLive(fileId, typed).catch((error) => {
        console.warn("[files] live send failed", fileId, error);
        return false;
      });
      if (!isStored) {
        await api.uploadFile(this.paperId, fileId, typed, this.opts.shareToken);
      }
      this.stored.add(fileId);
      this.attempts.delete(fileId);
      if (!this.destroyed) {
        this.opts.onImageStatusChange(fileId, "saved");
      }
    } catch (error) {
      console.warn("[files] upload failed", fileId, error);
      const attempts = (this.attempts.get(fileId) ?? 0) + 1;
      this.attempts.set(fileId, attempts);
      if (attempts >= MAX_ATTEMPTS) {
        this.opts.onImageStatusChange(fileId, "error");
      } else {
        this.scheduleRetry();
      }
    } finally {
      this.uploading.delete(fileId);
    }
  }

  private async download(fileId: string) {
    this.downloading.add(fileId);
    try {
      const blob = await api.fetchFile(
        this.paperId,
        fileId,
        this.opts.shareToken,
      );
      if (!blob) {
        throw new Error("not found");
      }
      const dataURL = await blobToDataURL(blob);
      this.stored.add(fileId);
      this.attempts.delete(fileId);
      const excalidrawAPI = this.opts.getApi();
      if (excalidrawAPI && !this.destroyed && !this.hasFull(fileId)) {
        this.previews.delete(fileId);
        this.addFile(excalidrawAPI, fileId, blob.type, dataURL);
      }
    } catch (error) {
      const attempts = (this.attempts.get(fileId) ?? 0) + 1;
      this.attempts.set(fileId, attempts);
      if (attempts < MAX_ATTEMPTS) {
        this.scheduleRetry();
      }
    } finally {
      this.downloading.delete(fileId);
    }
  }

  /** whether images are still being uploaded */
  isUploading() {
    return this.uploading.size > 0;
  }
}
