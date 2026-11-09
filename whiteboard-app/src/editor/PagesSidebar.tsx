import { Sidebar } from "@excalidraw/excalidraw";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";
import clsx from "clsx";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Avatar } from "../components/ui";

import { lockIcon, magnetIcon, plusIcon, unlockIcon } from "./icons";
import { NewPageMenu } from "./NewPageMenu";
import { ViewMenu } from "./ViewMenu";
import { getPageLabel } from "./session";

import type { PaperSession, SessionState } from "./session";
import type { PageThumbnails } from "./thumbnails";
import type {
  PageMeta,
  PresenceUser,
} from "../../../whiteboard-server/src/protocol";

export const PAGES_SIDEBAR = "pages";

const PageItem = ({
  page,
  index,
  total,
  isCurrent,
  users,
  thumbnail,
  canEdit,
  canManage,
  session,
  draggingId,
  setDraggingId,
}: {
  page: PageMeta;
  index: number;
  total: number;
  isCurrent: boolean;
  users: PresenceUser[];
  thumbnail: string | null | undefined;
  canEdit: boolean;
  canManage: boolean;
  session: PaperSession;
  draggingId: string | null;
  setDraggingId: (id: string | null) => void;
}) => {
  const [renaming, setRenaming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropPosition, setDropPosition] = useState<"before" | "after" | null>(
    null,
  );
  const ref = useRef<HTMLDivElement>(null);
  const label = getPageLabel(page, index);

  useEffect(() => {
    if (isCurrent) {
      ref.current?.scrollIntoView({ block: "nearest" });
    }
  }, [isCurrent]);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const close = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menuOpen]);

  const menuAction = (action: () => void) => () => {
    setMenuOpen(false);
    action();
  };

  return (
    <div
      ref={ref}
      className={clsx("wb-page-item", {
        "is-current": isCurrent,
        "is-dragging": draggingId === page.id,
        "drop-before": dropPosition === "before",
        "drop-after": dropPosition === "after",
      })}
      draggable={canEdit && !renaming}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/x-page-id", page.id);
        setDraggingId(page.id);
      }}
      onDragEnd={() => setDraggingId(null)}
      onDragOver={(event) => {
        if (!draggingId || draggingId === page.id) {
          return;
        }
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        setDropPosition(
          event.clientY < rect.top + rect.height / 2 ? "before" : "after",
        );
      }}
      onDragLeave={() => setDropPosition(null)}
      onDrop={(event) => {
        event.preventDefault();
        const id = event.dataTransfer.getData("text/x-page-id") || draggingId;
        if (id && id !== page.id) {
          const pages = session.getState().pages;
          const fromIndex = pages.findIndex((p) => p.id === id);
          let toIndex = dropPosition === "after" ? index + 1 : index;
          if (fromIndex < toIndex) {
            toIndex--;
          }
          session.movePage(id, toIndex);
        }
        setDropPosition(null);
        setDraggingId(null);
      }}
    >
      <button
        type="button"
        className="wb-page-item__thumb"
        onClick={() => session.switchPage(page.id)}
        title={`Go to ${label}`}
      >
        {thumbnail ? (
          <img src={thumbnail} alt="" draggable={false} />
        ) : thumbnail === null ? (
          <span className="wb-page-item__empty">Empty</span>
        ) : (
          <span className="wb-page-item__empty">…</span>
        )}
        <span className="wb-page-item__number">{index + 1}</span>
        {users.length > 0 && (
          <span className="wb-page-item__users">
            {users.slice(0, 4).map((user) => (
              <Avatar
                key={user.socketId}
                id={user.userId}
                name={user.username}
                size={20}
                title={`${user.username} is on this page`}
              />
            ))}
            {users.length > 4 && (
              <span className="wb-page-item__more">+{users.length - 4}</span>
            )}
          </span>
        )}
      </button>
      <div className="wb-page-item__row">
        {renaming ? (
          <input
            className="wb-page-item__input"
            autoFocus
            defaultValue={page.name}
            placeholder={`Page ${index + 1}`}
            maxLength={120}
            onFocus={(event) => event.target.select()}
            onBlur={(event) => {
              session.renamePage(page.id, event.target.value.trim());
              setRenaming(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                event.currentTarget.value = page.name;
                event.currentTarget.blur();
              }
              event.stopPropagation();
            }}
          />
        ) : (
          <span
            className="wb-page-item__label"
            title={canEdit ? "Double-click to rename" : label}
            onDoubleClick={() => canEdit && setRenaming(true)}
          >
            {label}
          </span>
        )}
        {canEdit && (
          <div className="wb-page-item__menu">
            <button
              type="button"
              className="wb-page-item__menu-btn"
              aria-label={`Actions for ${label}`}
              onClick={() => setMenuOpen((open) => !open)}
            >
              ⋯
            </button>
            {menuOpen && (
              <div className="wb-page-menu" role="menu">
                <button
                  type="button"
                  onClick={menuAction(() => setRenaming(true))}
                >
                  Rename
                </button>
                <button
                  type="button"
                  onClick={menuAction(() => session.duplicatePage(page.id))}
                >
                  Duplicate
                </button>
                <button
                  type="button"
                  onClick={menuAction(() => session.addPage(page.id))}
                >
                  Insert page after
                </button>
                <button
                  type="button"
                  disabled={index === 0}
                  onClick={menuAction(() =>
                    session.movePage(page.id, index - 1),
                  )}
                >
                  Move up
                </button>
                <button
                  type="button"
                  disabled={index === total - 1}
                  onClick={menuAction(() =>
                    session.movePage(page.id, index + 1),
                  )}
                >
                  Move down
                </button>
                {canManage && (
                  <button
                    type="button"
                    className="wb-page-menu__danger"
                    disabled={total <= 1}
                    onClick={menuAction(() => {
                      if (
                        window.confirm(
                          `Delete "${label}" for everyone? This can't be undone.`,
                        )
                      ) {
                        session.deletePage(page.id);
                      }
                    })}
                  >
                    Delete
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export const PagesSidebar = ({
  session,
  state,
  thumbnails,
  docked,
  onDock,
}: {
  session: PaperSession;
  state: SessionState;
  thumbnails: PageThumbnails;
  docked: boolean;
  onDock: (docked: boolean) => void;
}) => {
  const { openSidebar } = useUIAppState();
  const isOpen = openSidebar?.name === PAGES_SIDEBAR;
  const locked = !!state.paper?.locked;
  const [draggingId, setDraggingId] = useState<string | null>(null);
  useSyncExternalStore(thumbnails.subscribe, thumbnails.getVersion);

  const pageIds = state.pages.map((page) => page.id).join(",");
  useEffect(() => {
    thumbnails.setWanted(isOpen && pageIds ? pageIds.split(",") : []);
  }, [isOpen, pageIds, thumbnails]);

  const usersByPage = new Map<string, PresenceUser[]>();
  for (const user of state.presence) {
    if (user.socketId === state.socketId || !user.pageId) {
      continue;
    }
    const list = usersByPage.get(user.pageId) ?? [];
    list.push(user);
    usersByPage.set(user.pageId, list);
  }

  return (
    <Sidebar
      name={PAGES_SIDEBAR}
      docked={docked}
      onDock={onDock}
      className="wb-pages-sidebar"
    >
      <Sidebar.Header>
        <div className="wb-pages__title">
          Pages <span className="wb-pages__count">{state.pages.length}</span>
        </div>
      </Sidebar.Header>
      <div className="wb-pages__actions">
        {state.canEdit && <NewPageMenu session={session} />}
        {state.canManage && (
          <button
            type="button"
            className="wb-pages__action"
            onClick={() => session.summonEveryone()}
            title="Move everyone to this page and your view"
          >
            {magnetIcon} Bring everyone here
          </button>
        )}
      </div>
      <div className="wb-pages__actions">
        <ViewMenu session={session} state={state} variant="panel" />
        {state.canManage && (
          <button
            type="button"
            className={clsx("wb-pages__action", { "is-active": locked })}
            onClick={() => session.setLocked(!locked)}
            aria-pressed={locked}
            title={
              locked
                ? "Only you (and admins) can draw. Click to let everyone draw."
                : "Make the paper view-only for everyone else"
            }
          >
            {locked ? lockIcon : unlockIcon} {locked ? "Unlock" : "Lock"}
          </button>
        )}
      </div>
      <div className="wb-pages__list">
        {state.pages.map((page, index) => (
          <PageItem
            key={page.id}
            page={page}
            index={index}
            total={state.pages.length}
            isCurrent={page.id === state.currentPageId}
            users={usersByPage.get(page.id) ?? []}
            thumbnail={thumbnails.get(page.id)}
            canEdit={state.canEdit}
            canManage={state.canManage}
            session={session}
            draggingId={draggingId}
            setDraggingId={setDraggingId}
          />
        ))}
        {state.canEdit && (
          <button
            type="button"
            className="wb-page-add"
            onClick={() =>
              session.addPage(state.pages[state.pages.length - 1]?.id)
            }
          >
            {plusIcon}
            <span>Add page</span>
          </button>
        )}
      </div>
    </Sidebar>
  );
};
