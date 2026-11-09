import clsx from "clsx";
import { useEffect, useRef, useState } from "react";

import {
  magnetIcon,
  pagesIcon,
  presentIcon,
  returnIcon,
  togetherIcon,
  viewIcon,
} from "./icons";

import type { PaperSession, SessionState } from "./session";
import type { ViewSync } from "../../../whiteboard-server/src/protocol";

/** how the view is shared, in words */
export const VIEW_MODES: Record<
  ViewSync,
  { label: string; hint: string; icon: React.ReactNode }
> = {
  free: {
    label: "On their own",
    hint: "Everyone moves around the paper on their own",
    icon: viewIcon,
  },
  page: {
    label: "Same page",
    hint: "Page turns are shared; everyone zooms and scrolls on their own",
    icon: pagesIcon,
  },
  view: {
    label: "Together",
    hint: "One view for everyone: whoever moves it moves it for all",
    icon: togetherIcon,
  },
};

const PRESENT_HINT = "Everyone follows your page and view; only you move it";

/** what the View button says and shows */
export const getViewStatus = (state: SessionState) => {
  const mode = state.paper?.viewSync ?? "free";
  const presenter = state.presenter;
  if (presenter) {
    const mine = presenter.socketId === state.socketId;
    return {
      label: mine ? "Presenting" : `${presenter.name} presents`,
      icon: presentIcon,
      active: true,
    };
  }
  return {
    label: mode === "free" ? "View" : VIEW_MODES[mode].label,
    icon: VIEW_MODES[mode].icon,
    active: mode !== "free",
  };
};

/**
 * "View": how everyone's view is shared (owners & admins choose: on their
 * own, same page, together, follow me) and what you do yourself (look
 * around on your own / come back, see where others are looking).
 *
 * `pill` at the top right, `panel` in the pages panel.
 */
export const ViewMenu = ({
  session,
  state,
  variant,
  labels = true,
}: {
  session: PaperSession;
  state: SessionState;
  variant: "pill" | "panel";
  labels?: boolean;
}) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const close = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  const mode = state.paper?.viewSync ?? "free";
  const presenter = state.presenter;
  const presenting = presenter?.socketId === state.socketId;
  const selected: ViewSync | "present" = presenter ? "present" : mode;
  const status = getViewStatus(state);
  const shared = mode !== "free" && !presenter;
  const onShared = shared && !state.viewDetached && !state.userToFollow;
  const backToPresenter =
    !!presenter &&
    !presenting &&
    state.userToFollow?.socketId !== presenter.socketId;
  const act = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  const option = (
    key: ViewSync | "present",
    label: string,
    hint: string,
    icon: React.ReactNode,
    onSelect: () => void,
  ) => (
    <button
      key={key}
      type="button"
      role="menuitemradio"
      aria-checked={selected === key}
      className={clsx("wb-viewmenu__option", {
        "is-selected": selected === key,
      })}
      onClick={act(onSelect)}
    >
      <span className="wb-viewmenu__icon">{icon}</span>
      <span className="wb-viewmenu__text">
        <span className="wb-viewmenu__label">{label}</span>
        <span className="wb-viewmenu__hint">{hint}</span>
      </span>
    </button>
  );

  return (
    <div className={clsx("wb-viewmenu", `wb-viewmenu--${variant}`)} ref={ref}>
      <button
        type="button"
        className={
          variant === "pill"
            ? clsx("wb-pill wb-pill--button", {
                "wb-pill--icon": !labels,
                "wb-pill--active": status.active,
              })
            : clsx("wb-pages__action", { "is-active": status.active })
        }
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`View: ${status.label}`}
        title="How everyone's view is shared"
      >
        {status.icon}
        {labels && <span className="wb-viewmenu__status">{status.label}</span>}
        {variant === "panel" && <span aria-hidden>▾</span>}
      </button>
      {open && (
        <div className="wb-page-menu wb-viewmenu__menu" role="menu">
          <div className="wb-viewmenu__heading">Everyone</div>
          {state.canManage ? (
            <>
              {(Object.keys(VIEW_MODES) as ViewSync[]).map((key) =>
                option(
                  key,
                  VIEW_MODES[key].label,
                  VIEW_MODES[key].hint,
                  VIEW_MODES[key].icon,
                  () => session.setViewSync(key),
                ),
              )}
              {option(
                "present",
                presenter && !presenting
                  ? `Follow me (instead of ${presenter.name})`
                  : "Follow me",
                PRESENT_HINT,
                presentIcon,
                () => session.setPresenting(!presenting),
              )}
              <button
                type="button"
                role="menuitem"
                className="wb-viewmenu__action"
                onClick={act(() => session.summonEveryone())}
              >
                {magnetIcon} Bring everyone here, once
              </button>
            </>
          ) : (
            <div className="wb-viewmenu__current">
              <span className="wb-viewmenu__icon">{status.icon}</span>
              <span className="wb-viewmenu__text">
                <span className="wb-viewmenu__label">
                  {presenter
                    ? `${presenter.name} is presenting`
                    : VIEW_MODES[mode].label}
                </span>
                <span className="wb-viewmenu__hint">
                  {presenter
                    ? "Everyone follows their page and view"
                    : VIEW_MODES[mode].hint}
                </span>
              </span>
            </div>
          )}
          <div className="wb-page-menu__separator" />
          <div className="wb-viewmenu__heading">You</div>
          {backToPresenter && (
            <button
              type="button"
              role="menuitem"
              className="wb-viewmenu__action"
              onClick={act(() => session.rejoinSharedView())}
            >
              {returnIcon} Back to {presenter!.name}'s view
            </button>
          )}
          {shared && !onShared && (
            <button
              type="button"
              role="menuitem"
              className="wb-viewmenu__action"
              onClick={act(() => session.rejoinSharedView())}
            >
              {returnIcon} Back to the shared view
            </button>
          )}
          {onShared && (
            <button
              type="button"
              role="menuitem"
              className="wb-viewmenu__action"
              onClick={act(() => session.lookAround())}
              title="Move around without moving the others; come back any time"
            >
              {viewIcon} Look around on my own
            </button>
          )}
          <label className="wb-viewmenu__toggle">
            <input
              type="checkbox"
              checked={state.showViewBoxes}
              onChange={(event) =>
                session.setShowViewBoxes(event.target.checked)
              }
            />
            Show where others are looking
          </label>
        </div>
      )}
    </div>
  );
};
