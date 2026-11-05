/**
 * Turns PDFs, images and page templates into pages with a locked background
 * image (like worksheets in Bitpaper): everyone can write on top, and the
 * background can't be moved by accident (right-click → Unlock to edit it).
 */

import { restoreElements } from "@excalidraw/excalidraw";
import { newImageElement } from "@excalidraw/element";

import type { BinaryFileData, DataURL } from "@excalidraw/excalidraw/types";

import type { FileId } from "@excalidraw/element/types";

import {
  TEMPLATE_HEIGHT,
  TEMPLATE_WIDTH,
  renderTemplateSVG,
} from "./templates";

import type { PageTemplate } from "./templates";

export interface BackgroundPage {
  name: string;
  file: BinaryFileData;
  /** size on the canvas */
  width: number;
  height: number;
}

/** longest side of a page on the canvas (same as templates) */
const SCENE_SIZE = TEMPLATE_WIDTH;
/** longest side of rendered PDF pages, in pixels (sharp when zoomed in) */
const RENDER_SIZE = 2200;
/** larger renders are re-encoded as JPEG */
const MAX_PNG_BYTES = 1.5 * 1024 * 1024;
/** images larger than this are downscaled before upload */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
export const MAX_IMPORT_PAGES = 100;

const toHex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** same scheme as Excalidraw: the id is a hash of the content */
const fileIdFor = async (data: ArrayBuffer) =>
  toHex(await window.crypto.subtle.digest("SHA-1", data)) as FileId;

const blobToDataURL = (blob: Blob) =>
  new Promise<DataURL>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as DataURL);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

const canvasToBlob = (
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("render failed"))),
      type,
      quality,
    ),
  );

const fitToScene = (width: number, height: number) => {
  const scale = SCENE_SIZE / Math.max(width, height);
  return { width: width * scale, height: height * scale };
};

const toBackgroundPage = async (
  name: string,
  blob: Blob,
  pixelWidth: number,
  pixelHeight: number,
): Promise<BackgroundPage> => ({
  name,
  file: {
    id: await fileIdFor(await blob.arrayBuffer()),
    mimeType: blob.type as BinaryFileData["mimeType"],
    dataURL: await blobToDataURL(blob),
    created: Date.now(),
  },
  ...fitToScene(pixelWidth, pixelHeight),
});

/** a white canvas → PNG, or JPEG when the PNG would be large (scans) */
const encodeCanvas = async (canvas: HTMLCanvasElement) => {
  const png = await canvasToBlob(canvas, "image/png");
  return png.size > MAX_PNG_BYTES
    ? canvasToBlob(canvas, "image/jpeg", 0.88)
    : png;
};

const baseName = (file: File) => file.name.replace(/\.[^.]+$/, "");

export const templatePage = async (
  template: PageTemplate,
): Promise<BackgroundPage> => {
  const svg = renderTemplateSVG(template);
  const bytes = new TextEncoder().encode(svg);
  return {
    name: "",
    file: {
      id: await fileIdFor(bytes.buffer as ArrayBuffer),
      mimeType: "image/svg+xml",
      dataURL: `data:image/svg+xml;base64,${window.btoa(svg)}` as DataURL,
      created: Date.now(),
    },
    width: TEMPLATE_WIDTH,
    height: TEMPLATE_HEIGHT,
  };
};

/** the locked image element a background page starts with */
export const createBackgroundElements = (page: BackgroundPage) =>
  restoreElements(
    [
      newImageElement({
        type: "image",
        x: 0,
        y: 0,
        width: page.width,
        height: page.height,
        fileId: page.file.id,
        status: "pending",
        locked: true,
      }),
    ],
    null,
  );

const loadPdfjs = async () => {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
};

async function* renderPdf(file: File) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
  }).promise;
  try {
    for (let number = 1; number <= doc.numPages; number++) {
      const page = await doc.getPage(number);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({
        scale: RENDER_SIZE / Math.max(base.width, base.height),
      });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const context = canvas.getContext("2d")!;
      // PDFs are often transparent: draw on white paper
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
      page.cleanup();
      yield {
        number,
        total: doc.numPages,
        page: await toBackgroundPage(
          doc.numPages > 1 ? `${baseName(file)} · ${number}` : baseName(file),
          await encodeCanvas(canvas),
          canvas.width,
          canvas.height,
        ),
      };
      canvas.width = canvas.height = 0;
    }
  } finally {
    await doc.destroy();
  }
}

const imageToBackgroundPage = async (file: File) => {
  const bitmap = await createImageBitmap(file);
  try {
    if (file.size <= MAX_IMAGE_BYTES && file.type !== "image/heic") {
      return toBackgroundPage(
        baseName(file),
        file,
        bitmap.width,
        bitmap.height,
      );
    }
    // too large to share comfortably: downscale
    const scale = Math.min(
      1,
      RENDER_SIZE / Math.max(bitmap.width, bitmap.height),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return toBackgroundPage(
      baseName(file),
      await canvasToBlob(canvas, "image/jpeg", 0.88),
      canvas.width,
      canvas.height,
    );
  } finally {
    bitmap.close();
  }
};

const isPdf = (file: File) =>
  file.type === "application/pdf" || /\.pdf$/i.test(file.name);

/**
 * Renders the files into background pages, calling `onPage` for each as soon
 * as it's ready (so pages appear progressively for big PDFs).
 */
export const importFilesAsPages = async (
  files: File[],
  onPage: (page: BackgroundPage, progress: string) => void,
) => {
  let count = 0;
  for (const file of files) {
    if (isPdf(file)) {
      for await (const { number, total, page } of renderPdf(file)) {
        if (count >= MAX_IMPORT_PAGES) {
          return { count, truncated: true };
        }
        count++;
        onPage(page, `${baseName(file)}: page ${number} of ${total}`);
      }
    } else if (file.type.startsWith("image/")) {
      if (count >= MAX_IMPORT_PAGES) {
        return { count, truncated: true };
      }
      count++;
      onPage(await imageToBackgroundPage(file), file.name);
    }
  }
  return { count, truncated: false };
};
