import { showSelectedShapeActions } from "@excalidraw/element";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ExcalidrawImperativeAPI,
  UIAppState,
} from "@excalidraw/excalidraw/types";

import { panelLeftCloseIcon, panelLeftOpenIcon } from "./icons";

/**
 * Excalidraw's style panel (stroke, background, stroke width, pressure,
 * opacity… at the top left) takes a column of the page while writing, and
 * the pen bar is all most people need (a student, mostly). So it starts
 * tucked away; a button next to the menu (☰) brings it out and back, and
 * the choice is remembered on the device.
 */

const HIDDEN_KEY = "whiteboard-style-panel-hidden";
export const STYLE_PANEL_SHORTCUT = "Alt+P";

/** how long the panel slides after a toggle (see styles.scss) */
const SLIDE_MS = 400;

/** whether Excalidraw shows its style panel right now */
export const hasStylePanel = (
  appState: UIAppState,
  api: Pick<ExcalidrawImperativeAPI, "getSceneElements"> | null,
) =>
  showSelectedShapeActions(
    appState,
    // the elements only matter when something is selected
    api && Object.keys(appState.selectedElementIds).length
      ? api.getSceneElements()
      : [],
  );

export const useStylePanelHidden = () => {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(HIDDEN_KEY) !== "false";
    } catch {
      return true;
    }
  });
  // the panel slides only when toggled, not each time it comes with a tool
  const [sliding, setSliding] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    try {
      localStorage.setItem(HIDDEN_KEY, String(hidden));
    } catch {
      // private mode etc.
    }
  }, [hidden]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const toggle = useCallback(() => {
    setHidden((value) => !value);
    setSliding(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setSliding(false), SLIDE_MS);
  }, []);

  return { hidden, sliding, toggle };
};

/** ‹ while the panel is out, › while it's tucked away */
export const StylePanelToggle = ({
  hidden,
  onToggle,
}: {
  hidden: boolean;
  onToggle: () => void;
}) => (
  <button
    type="button"
    className="wb-style-toggle"
    // doesn't take the focus: a text being edited stays in editing, with the
    // words selected (to color them in the panel)
    onMouseDown={(event) => event.preventDefault()}
    onClick={onToggle}
    title={`${
      hidden ? "Show" : "Hide"
    } the style panel (${STYLE_PANEL_SHORTCUT})`}
    aria-label="Style panel"
    aria-pressed={!hidden}
    aria-keyshortcuts={STYLE_PANEL_SHORTCUT}
  >
    {hidden ? panelLeftOpenIcon : panelLeftCloseIcon}
  </button>
);
