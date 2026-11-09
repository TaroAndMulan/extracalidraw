import {
  Excalidraw,
  Footer,
  MainMenu,
  Sidebar,
  languages,
  useHandleLibrary,
} from "@excalidraw/excalidraw";
import { DEFAULT_SIDEBAR, LIBRARY_SIDEBAR_TAB } from "@excalidraw/common";
import { LibraryIcon } from "@excalidraw/excalidraw/components/icons";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";
import { useI18n } from "@excalidraw/excalidraw/i18n";
import clsx from "clsx";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import type {
  ExcalidrawImageElement,
  NonDeletedExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";

import { api } from "../api";
import { ShareSettings } from "../components/ShareSettings";
import { Button, Modal, Spinner } from "../components/ui";
import { useLangCode, useTheme } from "../prefs";
import { Link, navigate } from "../router";

import {
  canFullscreen,
  toggleFullscreen,
  useIsFullscreen,
  useScreenWakeLock,
} from "./device";
import { useFitLevel } from "./fit";
import {
  backIcon,
  chevronLeft,
  chevronRight,
  fullscreenIcon,
  pagesIcon,
  plusIcon,
  printIcon,
  returnIcon,
  shareIcon,
} from "./icons";
import { LibraryIndexedDBAdapter } from "./library";
import { getMathData, placeMath } from "./math";
import { MathDialog } from "./MathDialog";
import { importIntoPaper } from "./NewPageMenu";
import { PAGES_SIDEBAR, PagesSidebar } from "./PagesSidebar";
import {
  DEFAULT_STROKE_WIDTH,
  PenTray,
  widenHighlighterStroke,
} from "./PenTray";
import { printAllPages } from "./print";
import { PaperSession, getPageLabel } from "./session";
import {
  StylePanelToggle,
  hasStylePanel,
  useStylePanelHidden,
} from "./StylePanelToggle";
import {
  getInitialPenState,
  installTabletInput,
  rememberPenMode,
  sendHistoryShortcut,
} from "./tabletInput";
import { PageThumbnails, renderPagePNG, runWhenQuiet } from "./thumbnails";
import { TopRight } from "./TopRight";

import type { SessionState } from "./session";
import type {
  GuestIdentity,
  PaperSummary,
} from "../../../whiteboard-server/src/protocol";

const COVER_UPLOAD_DELAY_MS = 6000;

const isInIframe = () => {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
};

export interface EmbedOptions {
  /** secret of the paper's public link */
  shareToken: string | null;
  /** set when joining without an account */
  guest: GuestIdentity | null;
}

/** public link & embed settings, loaded fresh when opened */
const ShareDialog = ({
  paperId,
  onClose,
}: {
  paperId: string;
  onClose: () => void;
}) => {
  const [paper, setPaper] = useState<PaperSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .getPaper(paperId)
      .then(({ paper }) => setPaper(paper))
      .catch((error) => setError(error.message));
  }, [paperId]);
  return (
    <Modal title="Share & embed" onClose={onClose} width={560}>
      {paper ? (
        <ShareSettings paper={paper} onChange={setPaper} />
      ) : error ? (
        <p className="wb-error">{error}</p>
      ) : (
        <Spinner />
      )}
    </Modal>
  );
};
const SIDEBAR_DOCKED_KEY = "whiteboard-pages-docked";

const LanguageSelect = ({ onChange }: { onChange: (code: string) => void }) => {
  const { t, langCode } = useI18n();
  return (
    <select
      className="dropdown-select dropdown-select__language"
      onChange={({ target }) => onChange(target.value)}
      value={langCode}
      aria-label={t("buttons.selectLanguage")}
      style={{ width: "100%" }}
    >
      {languages.map((lang) => (
        <option key={lang.code} value={lang.code}>
          {lang.label}
        </option>
      ))}
    </select>
  );
};

/** ‹ Page 2 / 5 › + */
const PageNav = ({
  session,
  state,
  excalidrawAPI,
  compact,
}: {
  session: PaperSession;
  state: SessionState;
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  compact?: boolean;
}) => {
  const index = state.pages.findIndex(
    (page) => page.id === state.currentPageId,
  );
  const page = state.pages[index];
  const label = page ? getPageLabel(page, index) : "";
  return (
    <div className={clsx("wb-pagenav", { "wb-pagenav--compact": compact })}>
      <button
        type="button"
        className="wb-pagenav__btn"
        disabled={index <= 0}
        onClick={() => session.goToRelativePage(-1)}
        title="Previous page (Alt+PageUp)"
        aria-label="Previous page"
      >
        {chevronLeft}
      </button>
      <button
        type="button"
        className="wb-pagenav__label"
        onClick={() => excalidrawAPI?.toggleSidebar({ name: PAGES_SIDEBAR })}
        title="Show all pages"
      >
        {compact ? (
          <>
            {pagesIcon}
            {`${index + 1}/${state.pages.length}`}
          </>
        ) : (
          <>
            <span className="wb-pagenav__name">{label}</span>
            <span className="wb-pagenav__count">
              {index + 1} / {state.pages.length}
            </span>
          </>
        )}
      </button>
      <button
        type="button"
        className="wb-pagenav__btn"
        disabled={index >= state.pages.length - 1}
        onClick={() => session.goToRelativePage(1)}
        title="Next page (Alt+PageDown)"
        aria-label="Next page"
      >
        {chevronRight}
      </button>
      {state.canEdit && (
        <button
          type="button"
          className="wb-pagenav__btn"
          onClick={() => session.addPage()}
          title="New page (Alt+N)"
          aria-label="New page"
        >
          {plusIcon}
        </button>
      )}
    </div>
  );
};

/**
 * The page bar and the pens at the bottom. On narrow screens the page bar
 * shows just "2/5", then fewer pens, then no pens (see `useFitLevel`).
 */
const FooterBar = ({
  session,
  state,
  excalidrawAPI,
}: {
  session: PaperSession;
  state: SessionState;
  excalidrawAPI: ExcalidrawImperativeAPI | null;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const { penDetected } = useUIAppState();
  const page = state.pages.find((p) => p.id === state.currentPageId);
  const level = useFitLevel(
    ref,
    3,
    [state.canEdit, state.pages.length, page?.name, penDetected].join(),
  );
  return (
    <div ref={ref} className="wb-footerbar">
      <PageNav
        session={session}
        state={state}
        excalidrawAPI={excalidrawAPI}
        compact={level >= 1}
      />
      {state.canEdit && level < 3 && (
        <PenTray excalidrawAPI={excalidrawAPI} compact={level >= 2} />
      )}
    </div>
  );
};

const EditorView = ({
  session,
  state,
  appName,
  embed,
}: {
  session: PaperSession;
  state: SessionState;
  appName: string;
  embed: EmbedOptions | null;
}) => {
  const { theme, preference, setPreference } = useTheme();
  const [sharing, setSharing] = useState(false);
  /** the math editor: `{ element: null }` inserts a new formula */
  const [mathEditor, setMathEditor] = useState<{
    element: ExcalidrawImageElement | null;
  } | null>(null);
  const [langCode, setLangCode] = useLangCode();
  const [excalidrawAPI, setExcalidrawAPI] =
    useState<ExcalidrawImperativeAPI | null>(null);
  const [initialData] = useState(() => {
    const data = session.getInitialData();
    return {
      ...data,
      appState: {
        ...data.appState,
        currentItemStrokeWidthKey: DEFAULT_STROKE_WIDTH,
        ...getInitialPenState(),
      },
    };
  });
  const stylePanel = useStylePanelHidden();
  const toggleStylePanel = stylePanel.toggle;
  const [thumbnails] = useState(
    () => new PageThumbnails(session, () => apiRef.current),
  );
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [docked, setDocked] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_DOCKED_KEY) === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => () => thumbnails.destroy(), [thumbnails]);

  // tablets: the screen stays on while others are in the paper (a student
  // following the presenter doesn't touch the screen)
  useScreenWakeLock(
    state.presence.some((user) => user.socketId !== state.socketId),
  );
  const fullscreen = useIsFullscreen();

  // opt-in debugging handle: localStorage.setItem("whiteboard-debug", "1")
  useEffect(() => {
    try {
      if (localStorage.getItem("whiteboard-debug")) {
        (window as any).__whiteboard = { session, excalidrawAPI };
      }
    } catch {
      // ignore
    }
  }, [session, excalidrawAPI]);

  useHandleLibrary({ excalidrawAPI, adapter: LibraryIndexedDBAdapter });

  // dropping a PDF on the canvas imports it as pages (images are inserted
  // by the editor as usual)
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const onDrop = (event: DragEvent) => {
      const pdfs = [...(event.dataTransfer?.files ?? [])].filter(
        (file) => file.type === "application/pdf" || /\.pdf$/i.test(file.name),
      );
      if (!pdfs.length || !session.getState().canEdit) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      importIntoPaper(session, pdfs);
    };
    container.addEventListener("drop", onDrop, true);
    return () => container.removeEventListener("drop", onDrop, true);
  }, [session]);

  // others' strokes while they draw them (see liveStrokes.ts), and where
  // others are looking (viewBoxes.ts)
  useEffect(() => {
    const root = containerRef.current;
    if (!root) {
      return;
    }
    session.liveStrokes.mount(root);
    session.viewBoxes.mount(root);
    return () => {
      session.liveStrokes.unmount();
      session.viewBoxes.unmount();
    };
  }, [session]);

  // tablets: the pen draws, fingers move the view, a resting palm does
  // nothing (see tabletInput.ts)
  useEffect(() => {
    const root = containerRef.current;
    if (!root) {
      return;
    }
    return installTabletInput({
      root,
      getAPI: () => apiRef.current,
      // moving the view yourself stops following someone (as in Excalidraw)
      onNavigate: () => {
        if (session.getState().userToFollow) {
          session.follow(null);
        }
      },
      // two-finger tap: undo, three-finger tap: redo
      onHistory: (action) => {
        if (!session.getState().canEdit) {
          return;
        }
        sendHistoryShortcut(action);
        apiRef.current?.setToast({
          message: action === "undo" ? "Undo" : "Redo",
          duration: 900,
        });
      },
    });
  }, [session]);

  // keyboard shortcuts for pages
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        !event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        target?.closest("input, textarea, select, [contenteditable]")
      ) {
        return;
      }
      if (event.key === "PageDown" || event.key === "PageUp") {
        event.preventDefault();
        event.stopPropagation();
        session.goToRelativePage(event.key === "PageDown" ? 1 : -1);
      } else if (event.code === "KeyM" && session.getState().canEdit) {
        event.preventDefault();
        event.stopPropagation();
        setMathEditor({ element: null });
      } else if (event.code === "KeyN" && session.getState().canEdit) {
        event.preventDefault();
        event.stopPropagation();
        session.addPage();
      } else if (event.code === "KeyP" && session.getState().canEdit) {
        event.preventDefault();
        event.stopPropagation();
        toggleStylePanel();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [session, toggleStylePanel]);

  // warn before leaving with changes that didn't reach the server
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (session.hasUnsyncedChanges() || session.files.isUploading()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [session]);

  // keep the cover image on the dashboard up to date (first page)
  useEffect(() => {
    let timer: number | null = null;
    const upload = async () => {
      timer = null;
      const excalidrawAPI = apiRef.current;
      const { pages, canEdit, isGuest } = session.getState();
      if (!excalidrawAPI || !canEdit || isGuest || !pages[0]) {
        return;
      }
      const elements = session
        .getElements(pages[0].id)
        .filter(
          (element) => !element.isDeleted,
        ) as NonDeletedExcalidrawElement[];
      if (!elements.length) {
        return;
      }
      try {
        await api.uploadThumbnail(
          session.paperId,
          await renderPagePNG(excalidrawAPI, elements, 480),
        );
      } catch (error) {
        console.warn("[cover]", error);
      }
    };
    // only whoever changed the page renders the cover (not everyone in the
    // lesson), when nobody is drawing: it's a few hundred milliseconds of
    // work on a tablet
    let cancelWait: (() => void) | null = null;
    const unsubscribe = session.onPageContentChange((pageId, origin) => {
      const { pages, canEdit, isGuest } = session.getState();
      if (
        origin === "local" &&
        canEdit &&
        !isGuest &&
        pageId === pages[0]?.id
      ) {
        if (timer) {
          window.clearTimeout(timer);
        }
        cancelWait?.();
        timer = window.setTimeout(() => {
          cancelWait = runWhenQuiet(session, () => {
            cancelWait = null;
            upload();
          });
        }, COVER_UPLOAD_DELAY_MS);
      }
    });
    return () => {
      unsubscribe();
      // leaving: upload a cover that was still due
      const due = timer !== null || cancelWait !== null;
      cancelWait?.();
      if (timer) {
        window.clearTimeout(timer);
      }
      if (due) {
        upload();
      }
    };
  }, [session]);

  const onExcalidrawAPI = useCallback((api: ExcalidrawImperativeAPI | null) => {
    apiRef.current = api;
    setExcalidrawAPI(api);
  }, []);

  const paperTitle = state.paper?.title ?? appName;

  // double-clicking a formula (or Enter) edits it instead of cropping it
  const onChange = useCallback(
    (
      elements: readonly OrderedExcalidrawElement[],
      appState: AppState,
      files: BinaryFiles,
    ) => {
      session.onEditorChange(elements, appState, files);
      rememberPenMode(appState);
      if (apiRef.current) {
        widenHighlighterStroke(appState, apiRef.current);
      }
      const croppingId = appState.croppingElementId;
      if (croppingId && session.getState().canEdit) {
        const element = elements.find((el) => el.id === croppingId);
        if (getMathData(element) && apiRef.current) {
          apiRef.current.updateScene({
            appState: { croppingElementId: null },
          });
          setMathEditor({ element: element as ExcalidrawImageElement });
        }
      }
    },
    [session],
  );

  // a frame around the canvas while following someone (e.g. the
  // presenter); a way back after looking around on your own while the view
  // is shared, or after leaving a presentation
  const followed = state.userToFollow;
  const presenter = state.presenter;
  const isPresenter = !!followed && presenter?.socketId === followed.socketId;
  const backTo =
    followed || !state.paper
      ? null
      : presenter && presenter.socketId !== state.socketId
      ? `Back to ${presenter.name}'s view`
      : state.paper.viewSync !== "free" && !presenter && state.viewDetached
      ? "Back to the shared view"
      : null;
  const viewportStatusFrame = useMemo(
    () =>
      followed
        ? {
            border: "var(--color-primary-hover)",
            label: {
              label: (
                <span className="wb-follow-label" title={followed.username}>
                  {isPresenter
                    ? `${followed.username} is presenting`
                    : `Following ${followed.username}`}
                </span>
              ),
              onClose: () => session.follow(null),
            },
          }
        : backTo
        ? {
            border: false as const,
            label: {
              label: <span className="wb-follow-label">{backTo}</span>,
              icon: returnIcon,
              onClick: () => session.rejoinSharedView(),
            },
          }
        : null,
    [followed, isPresenter, backTo, session],
  );

  return (
    <div
      className={clsx("wb-editor", {
        "wb-editor--style-panel-hidden": stylePanel.hidden,
        "wb-editor--style-panel-sliding": stylePanel.sliding,
      })}
      ref={containerRef}
    >
      <Excalidraw
        onExcalidrawAPI={onExcalidrawAPI}
        onInitialize={session.attach}
        initialData={initialData}
        onChange={onChange}
        onPointerUpdate={session.onPointerUpdate}
        isCollaborating
        userToFollow={state.userToFollow}
        viewportStatusFrame={viewportStatusFrame}
        viewModeEnabled={!state.canEdit}
        theme={theme}
        onThemeChange={(next) => setPreference(next)}
        langCode={langCode}
        name={paperTitle}
        handleKeyboardGlobally
        // don't steal focus from the website an embed is on
        autoFocus={!embed}
        UIOptions={{
          canvasActions: {
            loadScene: false,
            toggleTheme: true,
          },
        }}
        // next to the menu (☰), whenever there's a style panel to show
        renderTopLeftUI={(isMobile, appState) =>
          !isMobile && hasStylePanel(appState, apiRef.current) ? (
            <StylePanelToggle
              hidden={stylePanel.hidden}
              onToggle={toggleStylePanel}
            />
          ) : null
        }
        renderTopRightUI={(isMobile) =>
          isMobile ? (
            <div className="wb-topright">
              <PageNav
                session={session}
                state={state}
                excalidrawAPI={excalidrawAPI}
                compact
              />
              <Sidebar.Trigger
                name={PAGES_SIDEBAR}
                icon={pagesIcon}
                title="Pages"
                className="wb-pages-trigger"
              />
            </div>
          ) : (
            <TopRight
              session={session}
              state={state}
              docked={docked}
              onMath={() => setMathEditor({ element: null })}
            />
          )
        }
      >
        <MainMenu>
          {!embed && (
            <MainMenu.Item icon={backIcon} onSelect={() => navigate("/")}>
              All papers
            </MainMenu.Item>
          )}
          {embed && isInIframe() && (
            <MainMenu.Item
              icon={backIcon}
              onSelect={() => window.open(window.location.href, "_blank")}
            >
              Open in a new tab
            </MainMenu.Item>
          )}
          {state.canManage && !state.isGuest && (
            <MainMenu.Item icon={shareIcon} onSelect={() => setSharing(true)}>
              Share & embed…
            </MainMenu.Item>
          )}
          <MainMenu.Separator />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.Export />
          <MainMenu.Item
            icon={printIcon}
            onSelect={() => {
              if (excalidrawAPI) {
                printAllPages(session, excalidrawAPI, paperTitle).catch(
                  (error) =>
                    excalidrawAPI.setToast({
                      message: `Couldn't print: ${error.message}`,
                    }),
                );
              }
            }}
          >
            Print / PDF (all pages)
          </MainMenu.Item>
          {state.canEdit && (
            <MainMenu.Item
              icon={<span className="wb-menu-math-icon">∑</span>}
              onSelect={() => setMathEditor({ element: null })}
              shortcut="Alt+M"
            >
              Insert math (LaTeX)
            </MainMenu.Item>
          )}
          {canFullscreen() && (
            <MainMenu.Item icon={fullscreenIcon} onSelect={toggleFullscreen}>
              {fullscreen ? "Exit full screen" : "Full screen"}
            </MainMenu.Item>
          )}
          <MainMenu.Item
            icon={LibraryIcon}
            onSelect={() =>
              excalidrawAPI?.toggleSidebar({
                name: DEFAULT_SIDEBAR.name,
                tab: LIBRARY_SIDEBAR_TAB,
              })
            }
          >
            Library
          </MainMenu.Item>
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          {state.canEdit && <MainMenu.DefaultItems.ClearCanvas />}
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ToggleTheme
            allowSystemTheme
            theme={preference}
          />
          <MainMenu.ItemCustom>
            <LanguageSelect onChange={setLangCode} />
          </MainMenu.ItemCustom>
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
        <Footer>
          <FooterBar
            session={session}
            state={state}
            excalidrawAPI={excalidrawAPI}
          />
        </Footer>
        <PagesSidebar
          session={session}
          state={state}
          thumbnails={thumbnails}
          docked={docked}
          onDock={(value) => {
            setDocked(value);
            try {
              localStorage.setItem(SIDEBAR_DOCKED_KEY, String(value));
            } catch {
              // ignore
            }
          }}
        />
      </Excalidraw>
      {mathEditor && excalidrawAPI && (
        <MathDialog
          initial={getMathData(mathEditor.element)}
          onClose={() => setMathEditor(null)}
          onSubmit={(source, rendered) => {
            placeMath(excalidrawAPI, source, rendered, mathEditor.element);
            setMathEditor(null);
          }}
        />
      )}
      {sharing && (
        <ShareDialog
          paperId={session.paperId}
          onClose={() => setSharing(false)}
        />
      )}
    </div>
  );
};

const noopSubscribe = () => () => {};
const getNull = () => null;

export const PaperEditor = ({
  paperId,
  appName,
  embed = null,
}: {
  paperId: string;
  appName: string;
  embed?: EmbedOptions | null;
}) => {
  const [session, setSession] = useState<PaperSession | null>(null);
  const shareToken = embed?.shareToken ?? null;
  const guestId = embed?.guest?.id;
  const guestName = embed?.guest?.name;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const instance = new PaperSession(paperId, {
      initialPageId: params.get("page"),
      shareToken,
      guest: guestId && guestName ? { id: guestId, name: guestName } : null,
      onPageChange: (pageId) => {
        const url = new URL(window.location.href);
        if (url.searchParams.get("page") !== pageId) {
          url.searchParams.set("page", pageId);
          // keeps the #token of embeds
          window.history.replaceState({}, "", url);
        }
      },
      // the live connection was refused: if the session expired, show the
      // login screen; otherwise it's a proxy problem (cookies not forwarded)
      onUnauthorized: async () => {
        const { user } = await api.me().catch(() => ({ user: null }));
        if (!user && !shareToken) {
          window.location.reload();
        }
      },
    });
    instance.connect();
    setSession(instance);
    return () => {
      instance.destroy();
      setSession(null);
    };
  }, [paperId, shareToken, guestId, guestName]);

  const state = useSyncExternalStore(
    session?.subscribe ?? noopSubscribe,
    session?.getState ?? getNull,
  );

  if (state?.removedReason) {
    return (
      <div className="wb-center-message">
        <h2>Paper closed</h2>
        <p className="wb-muted">{state.removedReason}</p>
        {!embed && <Link to="/">← Back to papers</Link>}
      </div>
    );
  }

  if (state?.status === "failed") {
    return (
      <div className="wb-center-message">
        <h2>Can't open this paper</h2>
        <p className="wb-muted">
          {state.error ??
            "It may have been deleted, or it isn't shared with you."}
        </p>
        {!embed && (
          <Button variant="primary" onClick={() => navigate("/")}>
            Back to papers
          </Button>
        )}
      </div>
    );
  }

  if (!session || !state?.paper) {
    return <Spinner label="Opening paper…" />;
  }

  return (
    <EditorView
      session={session}
      state={state}
      appName={appName}
      embed={embed}
    />
  );
};
