import { exportScene } from "@excalidraw/excalidraw";

import type { ExportSceneData } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { NonDeletedExcalidrawElement } from "@excalidraw/element/types";

import { getPageLabel } from "./session";

import type { PaperSession } from "./session";

const escapeHTML = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[char]!),
  );

/**
 * Prints every page of the paper (one page per sheet). Browsers offer "Save
 * as PDF" in the print dialog, so this doubles as PDF export.
 */
export const printAllPages = async (
  session: PaperSession,
  excalidrawAPI: ExcalidrawImperativeAPI,
  title: string,
) => {
  const pages = session.getState().pages;
  const appState = excalidrawAPI.getAppState();
  const sheets: string[] = [];

  for (const [index, page] of pages.entries()) {
    const elements = session
      .getElements(page.id)
      .filter((element) => !element.isDeleted) as NonDeletedExcalidrawElement[];
    let content = `<div class="empty">(empty page)</div>`;
    if (elements.length) {
      const svg = await exportScene({
        type: "svg",
        data: {
          elements,
          appState: {
            viewBackgroundColor: appState.viewBackgroundColor,
          } as ExportSceneData["appState"],
          files: excalidrawAPI.getFiles(),
        },
        config: { padding: 24 },
      });
      svg.removeAttribute("width");
      svg.removeAttribute("height");
      content = svg.outerHTML;
    }
    sheets.push(
      `<section class="sheet"><header>${escapeHTML(
        getPageLabel(page, index),
      )}</header><div class="content">${content}</div></section>`,
    );
  }

  const html = `<!doctype html><html><head><meta charset="utf-8">
<title>${escapeHTML(title)}</title>
<style>
  @page { size: A4 landscape; margin: 10mm; }
  html, body { margin: 0; padding: 0; font-family: system-ui, sans-serif; }
  .sheet { height: calc(210mm - 20mm); display: flex; flex-direction: column;
    page-break-after: always; break-after: page; overflow: hidden; }
  .sheet:last-child { page-break-after: auto; break-after: auto; }
  header { font-size: 10pt; color: #666; padding-bottom: 4mm; }
  .content { flex: 1; min-height: 0; display: flex; align-items: center;
    justify-content: center; }
  .content svg { max-width: 100%; max-height: 100%; width: 100%; height: 100%; }
  .empty { color: #aaa; }
</style></head><body>${sheets.join("")}</body></html>`;

  // print from a hidden iframe so popup blockers don't interfere
  const iframe = document.createElement("iframe");
  iframe.style.cssText =
    "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument!;
  doc.open();
  doc.write(html);
  doc.close();

  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    await doc.fonts?.ready;
  } catch {
    // ignore
  }
  iframe.contentWindow!.focus();
  iframe.contentWindow!.print();
  // give the print dialog time to grab the document
  setTimeout(() => iframe.remove(), 60_000);
};
