import { Sidebar } from "@excalidraw/excalidraw";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";
import clsx from "clsx";
import { useRef } from "react";

import { useFitLevel } from "./fit";
import { lockIcon, pagesIcon, presentIcon, unlockIcon } from "./icons";
import { PAGES_SIDEBAR } from "./PagesSidebar";

import type { PaperSession, SessionState } from "./session";

/**
 * Math, Lock, Present and Pages at the top right, as much as fits next to
 * Excalidraw's toolbar and the people in the paper:
 *
 * 0. buttons with labels
 * 1. icons only (tablets in landscape, a docked panel)
 * 2. only what's on (locked, presenting, reconnecting) and Pages — tablets
 *    in portrait. Present & Lock are always in the pages panel, Math in the
 *    menu (and Alt+M).
 * 3. not even Pages (the page bar opens the panel), and Excalidraw's own
 *    Library and laser buttons go too (they're in the main menu and the
 *    toolbar's ⋮ menu) — narrow tablets in portrait, like an iPad mini.
 */
export const TopRight = ({
  session,
  state,
  docked,
  onMath,
}: {
  session: PaperSession;
  state: SessionState;
  docked: boolean;
  onMath: () => void;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const { openSidebar, collaborators } = useUIAppState();
  const locked = !!state.paper?.locked;
  const presenting = state.presenter?.socketId === state.socketId;
  const level = useFitLevel(
    ref,
    3,
    [
      state.canEdit,
      state.canManage,
      locked,
      presenting,
      state.status,
      state.followers,
      collaborators.size,
      docked && openSidebar?.name,
    ].join(),
  );
  const labels = level === 0;
  const minimal = level >= 2;
  const tight = level >= 3;
  const pill = clsx("wb-pill wb-pill--button", { "wb-pill--icon": !labels });

  return (
    <div
      ref={ref}
      className={clsx("wb-topright", { "wb-topright--tight": tight })}
    >
      {state.canEdit && !minimal && (
        <button
          type="button"
          className={pill}
          onClick={onMath}
          title="Insert a math formula (LaTeX) — Alt+M"
          aria-label="Insert math"
        >
          <span className="wb-pill__math">∑</span>
          {labels && " Math"}
        </button>
      )}
      {state.status !== "connected" && (
        <span
          className={clsx("wb-pill wb-pill--warning", {
            "wb-pill--icon": !labels,
          })}
          title="Reconnecting… changes are kept and sent when the connection is back"
        >
          <span className="wb-dot" />
          {labels && " Reconnecting…"}
        </span>
      )}
      {state.canManage
        ? (!minimal || locked) && (
            <button
              type="button"
              className={clsx(pill, { "wb-pill--active": locked })}
              onClick={() => session.setLocked(!locked)}
              aria-pressed={locked}
              title={
                locked
                  ? "Locked: only you (and admins) can draw. Click to let everyone draw."
                  : "Everyone can draw. Click to make the paper view-only for others."
              }
            >
              {locked ? lockIcon : unlockIcon}
              {labels && (locked ? "Locked" : "Lock")}
            </button>
          )
        : !state.canEdit && (
            <span
              className={clsx("wb-pill", { "wb-pill--icon": !labels })}
              title="The owner locked this paper: view only"
            >
              {lockIcon}
              {labels && " View only"}
            </span>
          )}
      {state.canManage && (!minimal || presenting) && (
        <button
          type="button"
          className={clsx(pill, { "wb-pill--active": presenting })}
          onClick={() => session.setPresenting(!presenting)}
          aria-pressed={presenting}
          title={
            presenting
              ? "Everyone follows your view and page. Click to stop."
              : "Present: everyone follows your view and page"
          }
        >
          {presentIcon}
          {labels && (presenting ? "Presenting" : "Present")}
        </button>
      )}
      {state.followers > 0 && (
        <span className="wb-pill" title="People following your view">
          👁 {state.followers}
        </span>
      )}
      {!tight && (
        <Sidebar.Trigger
          name={PAGES_SIDEBAR}
          icon={pagesIcon}
          title="Pages"
          className="wb-pages-trigger"
        >
          {labels ? "Pages" : null}
        </Sidebar.Trigger>
      )}
    </div>
  );
};
