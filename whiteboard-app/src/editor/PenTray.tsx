import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";
import clsx from "clsx";

import type {
  AppState,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import type { StrokeVariability } from "@excalidraw/element/types";

import { eraserIcon, fingerIcon, highlighterIcon } from "./icons";

/**
 * One tap to the pen colors a tutor switches between all the time, a
 * highlighter and the eraser — instead of tool + color panel + opacity — and,
 * once a pen was used, whether fingers draw or move the page.
 */

export const PENS = [
  { name: "Black pen", color: "#1e1e1e" },
  { name: "Red pen", color: "#e03131" },
  { name: "Blue pen", color: "#1971c2" },
  { name: "Green pen", color: "#2f9e44" },
] as const;

/** handwriting: the editor starts with the thinnest stroke (Excalidraw's
 * default is the middle one) */
export const DEFAULT_STROKE_WIDTH: AppState["currentItemStrokeWidthKey"] =
  "thin";

export const HIGHLIGHTER = {
  color: "#ffd43b",
  opacity: 50,
  /** wider than Excalidraw's widest stroke, see `widenHighlighterStroke` */
  strokeWidth: 12,
} as const;

type PenState = Pick<
  AppState,
  | "activeTool"
  | "currentItemStrokeColor"
  | "currentItemOpacity"
  | "currentItemStrokeVariability"
>;

export const isHighlighter = (appState: PenState) =>
  appState.activeTool.type === "freedraw" &&
  appState.currentItemStrokeColor === HIGHLIGHTER.color &&
  appState.currentItemOpacity === HIGHLIGHTER.opacity;

const isPen = (appState: PenState, color: string) =>
  appState.activeTool.type === "freedraw" &&
  appState.currentItemStrokeColor === color &&
  appState.currentItemOpacity === 100;

/**
 * Excalidraw's widest freehand stroke is a thin line when it's uniform (as a
 * highlighter is), so highlighter strokes are widened as they start.
 * Call with each editor change.
 */
export const widenHighlighterStroke = (
  appState: AppState,
  api: Pick<ExcalidrawImperativeAPI, "mutateElement">,
) => {
  const stroke = appState.newElement;
  if (
    stroke?.type === "freedraw" &&
    isHighlighter(appState) &&
    stroke.strokeColor === HIGHLIGHTER.color &&
    stroke.strokeWidth !== HIGHLIGHTER.strokeWidth
  ) {
    api.mutateElement(stroke, { strokeWidth: HIGHLIGHTER.strokeWidth });
  }
};

/** the pens' stroke style, kept while the highlighter is in use */
let penVariability: StrokeVariability | null = null;

export const PenTray = ({
  excalidrawAPI,
  compact,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  /** fewer colors when space is short */
  compact?: boolean;
}) => {
  const appState = useUIAppState();
  if (!excalidrawAPI) {
    return null;
  }
  const highlighter = isHighlighter(appState);

  const pickPen = (color: string) => {
    const current = excalidrawAPI.getAppState();
    excalidrawAPI.setActiveTool({ type: "freedraw" });
    excalidrawAPI.updateScene({
      appState: {
        currentItemStrokeColor: color,
        currentItemOpacity: 100,
        // back from the highlighter: the pens' own stroke style
        currentItemStrokeVariability: isHighlighter(current)
          ? penVariability ?? (current.penDetected ? "variable" : "constant")
          : current.currentItemStrokeVariability,
      },
    });
  };

  const pickHighlighter = () => {
    const current = excalidrawAPI.getAppState();
    if (!isHighlighter(current)) {
      penVariability = current.currentItemStrokeVariability;
    }
    excalidrawAPI.setActiveTool({ type: "freedraw" });
    excalidrawAPI.updateScene({
      appState: {
        currentItemStrokeColor: HIGHLIGHTER.color,
        currentItemOpacity: HIGHLIGHTER.opacity,
        currentItemStrokeVariability: "constant",
      },
    });
  };

  const pens = compact ? PENS.filter((_, i) => i < 2) : PENS;

  return (
    <div className="wb-pentray" role="toolbar" aria-label="Pens">
      {pens.map((pen) => (
        <button
          key={pen.color}
          type="button"
          className={clsx("wb-pentray__btn", {
            "is-active": isPen(appState, pen.color),
          })}
          onClick={() => pickPen(pen.color)}
          title={pen.name}
          aria-label={pen.name}
          aria-pressed={isPen(appState, pen.color)}
        >
          <span
            className="wb-pentray__swatch"
            style={{ background: pen.color }}
          />
        </button>
      ))}
      <button
        type="button"
        className={clsx("wb-pentray__btn", { "is-active": highlighter })}
        onClick={pickHighlighter}
        title="Highlighter"
        aria-label="Highlighter"
        aria-pressed={highlighter}
      >
        <span className="wb-pentray__highlighter">{highlighterIcon}</span>
      </button>
      <button
        type="button"
        className={clsx("wb-pentray__btn", {
          "is-active": appState.activeTool.type === "eraser",
        })}
        onClick={() => excalidrawAPI.setActiveTool({ type: "eraser" })}
        title="Eraser — E"
        aria-label="Eraser"
        aria-pressed={appState.activeTool.type === "eraser"}
      >
        {eraserIcon}
      </button>
      {appState.penDetected && (
        <>
          <span className="wb-pentray__divider" />
          <button
            type="button"
            className={clsx("wb-pentray__btn", {
              "is-active": !appState.penMode,
            })}
            onClick={() =>
              excalidrawAPI.updateScene({
                appState: { penMode: !appState.penMode },
              })
            }
            title={
              appState.penMode
                ? "Only the pen draws, fingers move the page. Tap to draw with a finger too."
                : "Fingers draw. Tap so that only the pen draws (fingers move the page)."
            }
            aria-label="Draw with a finger"
            aria-pressed={!appState.penMode}
          >
            {fingerIcon}
          </button>
        </>
      )}
    </div>
  );
};
