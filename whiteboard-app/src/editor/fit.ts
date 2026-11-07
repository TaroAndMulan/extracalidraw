import { useEffect, useLayoutEffect, useState } from "react";

import type { RefObject } from "react";

/**
 * Whether the editor bar holding `element` (top bar or footer) runs past its
 * right edge. Excalidraw's bars are grids/flex rows that grow with their
 * content instead of shrinking it, so too much content pushes buttons off
 * the screen (on a tablet in portrait, Lock / Present / Pages ended up out of
 * reach).
 */
const overflows = (element: HTMLElement) => {
  const bar =
    element.closest<HTMLElement>(".App-menu_top, .App-menu_bottom") ??
    element.parentElement;
  if (!bar) {
    return false;
  }
  // the footer spans the screen with a padding, the top bar is inset
  const padding = parseFloat(getComputedStyle(bar).paddingRight) || 0;
  const limit = Math.min(
    bar.getBoundingClientRect().right - padding,
    element.ownerDocument.documentElement.clientWidth,
  );
  return [element, ...Array.from(bar.children)].some(
    (child) => child.getBoundingClientRect().right > limit + 0.5,
  );
};

/**
 * How compact `element` must render to fit its bar: 0 = everything, up to
 * `maxLevel`. Starts from 0 whenever `key` (what's shown, and anything else
 * that changes the room, like a docked sidebar) or the editor's size
 * changes, and steps up before the browser paints, so nothing flickers.
 */
export const useFitLevel = (
  ref: RefObject<HTMLElement | null>,
  maxLevel: number,
  key: string,
) => {
  const [resizes, setResizes] = useState(0);
  const fitKey = `${key}|${resizes}`;
  const [fit, setFit] = useState({ key: fitKey, level: 0 });
  const level = fit.key === fitKey ? fit.level : 0;

  // measures after every render (anything may have changed the width); it
  // can't loop: the level only goes up, to `maxLevel`, and the key syncs once
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const element = ref.current;
    if (element && level < maxLevel && overflows(element)) {
      setFit({ key: fitKey, level: level + 1 });
    } else if (fit.key !== fitKey) {
      setFit({ key: fitKey, level });
    }
  });

  useEffect(() => {
    // the editor's size comes from the page, never from the bars' content,
    // so watching it can't loop
    const editor = ref.current?.closest(".excalidraw");
    const onResize = () => setResizes((count) => count + 1);
    window.addEventListener("resize", onResize);
    const observer =
      editor && "ResizeObserver" in window
        ? new ResizeObserver(onResize)
        : null;
    if (editor && observer) {
      observer.observe(editor);
    }
    return () => {
      window.removeEventListener("resize", onResize);
      observer?.disconnect();
    };
  }, [ref]);

  return level;
};
