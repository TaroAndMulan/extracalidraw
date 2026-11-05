import { useEffect, useRef, useState } from "react";

import { plusIcon } from "./icons";
import {
  MAX_IMPORT_PAGES,
  importFilesAsPages,
  templatePage,
} from "./importPages";
import { TEMPLATE_LABELS } from "./templates";

import type { PaperSession } from "./session";
import type { PageTemplate } from "./templates";

/** imports PDFs / images as pages after the current page */
export const importIntoPaper = async (session: PaperSession, files: File[]) => {
  let afterPageId = session.getState().currentPageId;
  let firstPageId: string | null = null;
  try {
    const { count, truncated } = await importFilesAsPages(
      files,
      (background, progress) => {
        session.toast(`Importing ${progress}…`);
        const page = session.addBackgroundPage(background, {
          afterPageId,
          // show the first page right away, add the rest behind it
          switchTo: firstPageId === null,
        });
        if (page) {
          afterPageId = page.id;
          firstPageId ??= page.id;
        }
      },
    );
    session.toast(
      count === 0
        ? "Nothing imported — choose PDF or image files"
        : `Imported ${count} ${count === 1 ? "page" : "pages"}${
            truncated ? ` (only the first ${MAX_IMPORT_PAGES})` : ""
          }`,
    );
  } catch (error: any) {
    console.error(error);
    session.toast(`Couldn't import: ${error?.message ?? error}`);
  }
};

export const NewPageMenu = ({ session }: { session: PaperSession }) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const close = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const addTemplate = async (template: PageTemplate) => {
    setOpen(false);
    session.addBackgroundPage(await templatePage(template));
  };

  return (
    <div className="wb-newpage" ref={ref}>
      <button
        type="button"
        className="wb-pages__action"
        onClick={() => setOpen((value) => !value)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Add a page after the current one"
      >
        {plusIcon} {busy ? "Importing…" : "New page"} <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className="wb-page-menu wb-newpage__menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              session.addPage();
            }}
          >
            Blank <span className="wb-page-menu__hint">Alt+N</span>
          </button>
          {(Object.keys(TEMPLATE_LABELS) as PageTemplate[]).map((template) => (
            <button
              key={template}
              type="button"
              role="menuitem"
              onClick={() => addTemplate(template)}
            >
              {TEMPLATE_LABELS[template]} paper
            </button>
          ))}
          <div className="wb-page-menu__separator" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              fileInput.current?.click();
            }}
          >
            Import PDF or images…
          </button>
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        hidden
        multiple
        accept="application/pdf,.pdf,image/*"
        onChange={async (event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          if (files.length) {
            setBusy(true);
            await importIntoPaper(session, files);
            setBusy(false);
          }
        }}
      />
    </div>
  );
};
