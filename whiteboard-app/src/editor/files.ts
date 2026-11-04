/**
 * Keeps images in sync with the server.
 *
 * Image elements only reference a `fileId` (a hash of the file); the data is
 * uploaded once per paper and downloaded by everyone who needs it. While an
 * upload is in progress the element's status is "pending" (others see a
 * placeholder); once uploaded it becomes "saved" and others fetch it.
 */

import { MIME_TYPES } from "@excalidraw/common";

import type {
  BinaryFileData,
  DataURL,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";

import { api } from "../api";

const MAX_ATTEMPTS = 4;

const blobToDataURL = (blob: Blob) =>
  new Promise<DataURL>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as DataURL);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

const dataURLToBlob = async (dataURL: string) => (await fetch(dataURL)).blob();

export class FileSync {
  /** files known to be on the server */
  private stored = new Set<string>();
  private uploading = new Set<string>();
  private downloading = new Set<string>();
  private attempts = new Map<string, number>();
  private retryTimer: number | null = null;
  private destroyed = false;

  constructor(
    private readonly paperId: string,
    private readonly opts: {
      shareToken: string | null;
      getApi: () => ExcalidrawImperativeAPI | null;
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

    for (const element of elements) {
      if (element.type !== "image" || !element.fileId || element.isDeleted) {
        continue;
      }
      const fileId = element.fileId;
      const local = files[fileId];
      if (local) {
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
        element.status === "saved" &&
        !this.downloading.has(fileId) &&
        (this.attempts.get(fileId) ?? 0) < MAX_ATTEMPTS
      ) {
        toDownload.push(fileId);
      }
    }

    for (const fileId of new Set(toDownload)) {
      this.download(fileId);
    }
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
      await api.uploadFile(
        this.paperId,
        fileId,
        new Blob([blob], { type: file.mimeType }),
        this.opts.shareToken,
      );
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
      if (excalidrawAPI && !this.destroyed) {
        excalidrawAPI.addFiles([
          {
            id: fileId as FileId,
            mimeType: (blob.type ||
              MIME_TYPES.binary) as BinaryFileData["mimeType"],
            dataURL,
            created: Date.now(),
            lastRetrieved: Date.now(),
          },
        ]);
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
