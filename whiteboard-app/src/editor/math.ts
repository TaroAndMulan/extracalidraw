/**
 * LaTeX math (like Bitpaper): formulas are rendered with MathJax to a
 * self-contained SVG (glyphs as paths, no fonts needed) and placed on the
 * board as an image. The LaTeX source is kept in the element's `customData`
 * so the formula can be edited again (double-click it).
 *
 * MathJax is only loaded when someone opens the math editor; everyone else
 * just downloads the SVG like any other image. In dark mode the editor inverts
 * SVG images, so formulas follow the theme like text does.
 */

import { CaptureUpdateAction, newElementWith } from "@excalidraw/excalidraw";
import { newImageElement } from "@excalidraw/element";

import type {
  DataURL,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  ExcalidrawImageElement,
  FileId,
} from "@excalidraw/element/types";

export interface MathSource {
  latex: string;
  color: string;
  fontSize: number;
  /** display style (larger operators, centered limits) */
  display: boolean;
}

/** what's stored in `element.customData.whiteboardMath` */
export interface MathCustomData extends MathSource {
  /** rendered width at 100%, to keep the user's resizing when editing */
  baseWidth: number;
}

export const MATH_CUSTOM_DATA_KEY = "whiteboardMath";

export const getMathData = (
  element: ExcalidrawElement | null | undefined,
): MathCustomData | null => {
  const data = element?.customData?.[MATH_CUSTOM_DATA_KEY];
  return element?.type === "image" &&
    data &&
    typeof data.latex === "string" &&
    typeof data.fontSize === "number"
    ? (data as MathCustomData)
    : null;
};

type Converter = (latex: string, display: boolean) => string;

let converter: Promise<Converter> | null = null;

/** loads MathJax (once) */
export const loadMath = () =>
  (converter ??= (async () => {
    const [
      { mathjax },
      { TeX },
      { SVG },
      { liteAdaptor },
      { RegisterHTMLHandler },
      { AllPackages },
    ] = await Promise.all([
      import("mathjax-full/js/mathjax.js"),
      import("mathjax-full/js/input/tex.js"),
      import("mathjax-full/js/output/svg.js"),
      import("mathjax-full/js/adaptors/liteAdaptor.js"),
      import("mathjax-full/js/handlers/html.js"),
      import("mathjax-full/js/input/tex/AllPackages.js"),
    ]);
    const adaptor = liteAdaptor();
    RegisterHTMLHandler(adaptor);
    const document = mathjax.document("", {
      InputJax: new TeX({
        packages: AllPackages.filter(
          // these need network access / a DOM
          (name: string) => !["require", "autoload"].includes(name),
        ),
        // report errors to the editor instead of rendering them in red
        formatError: (_jax: unknown, error: Error) => {
          throw error;
        },
      }),
      // glyphs inline as paths: the SVG works on its own as an image
      OutputJax: new SVG({ fontCache: "none" }),
    });
    return (latex: string, display: boolean) =>
      adaptor.innerHTML(document.convert(latex, { display }) as any);
  })().catch((error) => {
    converter = null;
    throw error;
  }));

const toBase64 = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return window.btoa(binary);
};

const sha1 = async (text: string) =>
  [
    ...new Uint8Array(
      await window.crypto.subtle.digest(
        "SHA-1",
        new TextEncoder().encode(text),
      ),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("") as FileId;

/** MathJax sizes in ex; 1ex ≈ half the font size */
const EX_TO_EM = 0.5;
const PADDING = 4;

export interface RenderedMath {
  svg: string;
  dataURL: DataURL;
  fileId: FileId;
  width: number;
  height: number;
}

/** renders LaTeX to an SVG image; throws on LaTeX errors */
export const renderMath = async (source: MathSource): Promise<RenderedMath> => {
  const convert = await loadMath();
  const raw = convert(source.latex, source.display);
  const doc = new DOMParser().parseFromString(raw, "image/svg+xml");
  const svg = doc.documentElement;
  if (svg.nodeName !== "svg") {
    throw new Error("Couldn't render this formula");
  }
  const exPx = source.fontSize * EX_TO_EM;
  const width = parseFloat(svg.getAttribute("width") || "0") * exPx;
  const height = parseFloat(svg.getAttribute("height") || "0") * exPx;
  if (!width || !height) {
    throw new Error("Type a formula");
  }
  // room around the glyphs, so strokes at the edges aren't clipped
  const [vx, vy, vw, vh] = (svg.getAttribute("viewBox") || "0 0 0 0")
    .split(/\s+/)
    .map(Number);
  const scale = vw / width;
  svg.setAttribute(
    "viewBox",
    [
      vx - PADDING * scale,
      vy - PADDING * scale,
      vw + PADDING * 2 * scale,
      vh + PADDING * 2 * scale,
    ].join(" "),
  );
  const outerWidth = width + PADDING * 2;
  const outerHeight = height + PADDING * 2;
  svg.setAttribute("width", `${outerWidth}`);
  svg.setAttribute("height", `${outerHeight}`);
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  // glyphs are drawn with currentColor
  svg.setAttribute("style", `color: ${source.color}`);
  svg.removeAttribute("role");
  svg.removeAttribute("focusable");

  const text = new XMLSerializer().serializeToString(svg);
  return {
    svg: text,
    dataURL: `data:image/svg+xml;base64,${toBase64(text)}` as DataURL,
    fileId: await sha1(text),
    width: outerWidth,
    height: outerHeight,
  };
};

/**
 * Puts a rendered formula on the board: a new image in the middle of the
 * view, or an update of `existing` (keeping the size the user gave it).
 */
export const placeMath = (
  excalidrawAPI: ExcalidrawImperativeAPI,
  source: MathSource,
  rendered: RenderedMath,
  existing: ExcalidrawImageElement | null,
) => {
  excalidrawAPI.addFiles([
    {
      id: rendered.fileId,
      mimeType: "image/svg+xml",
      dataURL: rendered.dataURL,
      created: Date.now(),
    },
  ]);
  const mathData: MathCustomData = { ...source, baseWidth: rendered.width };
  const customData = { [MATH_CUSTOM_DATA_KEY]: mathData };
  const elements = excalidrawAPI.getSceneElementsIncludingDeleted();

  if (existing) {
    const previous = getMathData(existing);
    const scale = previous ? existing.width / previous.baseWidth : 1;
    const width = rendered.width * scale;
    const height = rendered.height * scale;
    const updated = newElementWith(existing, {
      fileId: rendered.fileId,
      status: "pending",
      // grow/shrink around the same center
      x: existing.x + (existing.width - width) / 2,
      y: existing.y + (existing.height - height) / 2,
      width,
      height,
      customData: { ...existing.customData, ...customData },
    });
    excalidrawAPI.updateScene({
      elements: elements.map((element) =>
        element.id === existing.id ? updated : element,
      ),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    return updated;
  }

  const appState = excalidrawAPI.getAppState();
  const zoom = appState.zoom.value;
  const centerX = appState.width / 2 / zoom - appState.scrollX;
  const centerY = appState.height / 2 / zoom - appState.scrollY;
  const element = newImageElement({
    type: "image",
    x: centerX - rendered.width / 2,
    y: centerY - rendered.height / 2,
    width: rendered.width,
    height: rendered.height,
    fileId: rendered.fileId,
    status: "pending",
    customData,
  });
  excalidrawAPI.updateScene({
    elements: [...elements, element],
    appState: { selectedElementIds: { [element.id]: true } },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  return element;
};
