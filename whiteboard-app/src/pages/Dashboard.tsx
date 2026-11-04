import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "../api";
import { useAuth } from "../auth";
import { ShareSettings } from "../components/ShareSettings";
import {
  Avatar,
  Button,
  ErrorText,
  Field,
  Modal,
  Spinner,
  timeAgo,
} from "../components/ui";
import { Link, navigate } from "../router";

import { AppHeader } from "./AppHeader";

import type {
  PaperSummary,
  PublicUser,
} from "../../../whiteboard-server/src/protocol";

const MemberPicker = ({
  users,
  selected,
  onChange,
}: {
  users: PublicUser[];
  selected: Set<string>;
  onChange: (selected: Set<string>) => void;
}) => {
  const [query, setQuery] = useState("");
  const candidates = users.filter((user) => !user.disabled);
  const filtered = candidates.filter((user) =>
    `${user.displayName} ${user.username}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const allSelected =
    candidates.length > 0 && candidates.every((user) => selected.has(user.id));

  if (!candidates.length) {
    return (
      <p className="wb-muted">
        No members yet. <Link to="/admin/users">Add people</Link> first.
      </p>
    );
  }

  return (
    <div className="wb-picker">
      <div className="wb-picker__toolbar">
        <input
          placeholder="Search people…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            onChange(
              allSelected
                ? new Set()
                : new Set(candidates.map((user) => user.id)),
            )
          }
        >
          {allSelected ? "Select none" : "Select all"}
        </Button>
      </div>
      <div className="wb-picker__list">
        {filtered.map((user) => (
          <label key={user.id} className="wb-picker__item">
            <input
              type="checkbox"
              checked={selected.has(user.id)}
              onChange={(event) => {
                const next = new Set(selected);
                if (event.target.checked) {
                  next.add(user.id);
                } else {
                  next.delete(user.id);
                }
                onChange(next);
              }}
            />
            <Avatar id={user.id} name={user.displayName} size={24} />
            <span>{user.displayName}</span>
            <span className="wb-muted wb-small">@{user.username}</span>
            {user.role === "admin" && <span className="wb-badge">admin</span>}
          </label>
        ))}
      </div>
    </div>
  );
};

const PaperDialog = ({
  mode,
  paper,
  users,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit" | "duplicate";
  paper?: PaperSummary;
  users: PublicUser[];
  onClose: () => void;
  onSaved: (paper: PaperSummary) => void;
}) => {
  const { user: me } = useAuth();
  const [title, setTitle] = useState(
    mode === "duplicate" ? `${paper?.title} (copy)` : paper?.title ?? "",
  );
  const [members, setMembers] = useState(() => new Set(paper?.memberIds ?? []));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // public link changes apply immediately (not on "Save")
  const [sharePaper, setSharePaper] = useState(paper);
  const others = users.filter((user) => user.id !== me.id);

  return (
    <Modal
      title={
        mode === "create"
          ? "New paper"
          : mode === "duplicate"
          ? "Duplicate paper"
          : "Paper settings"
      }
      onClose={onClose}
      width={520}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const memberIds = [...members];
            let result: PaperSummary;
            if (mode === "create") {
              ({ paper: result } = await api.createPaper({ title, memberIds }));
            } else if (mode === "duplicate") {
              ({ paper: result } = await api.duplicatePaper(paper!.id, title));
              ({ paper: result } = await api.updatePaper(result.id, {
                memberIds,
              }));
            } else {
              ({ paper: result } = await api.updatePaper(paper!.id, {
                title,
                memberIds,
              }));
            }
            onSaved(result);
          } catch (error: any) {
            setError(error.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Title">
          <input
            value={title}
            maxLength={120}
            placeholder="e.g. Weekly planning, Algebra lesson 3…"
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <div className="wb-field">
          <span className="wb-field__label">Shared with</span>
          <MemberPicker
            users={others}
            selected={members}
            onChange={setMembers}
          />
        </div>
        {mode === "edit" && sharePaper && (
          <div className="wb-field">
            <span className="wb-field__label">Anyone with the link</span>
            <ShareSettings paper={sharePaper} onChange={setSharePaper} />
          </div>
        )}
        <ErrorText>{error}</ErrorText>
        <div className="wb-modal__actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {mode === "create"
              ? "Create & open"
              : mode === "duplicate"
              ? "Duplicate"
              : "Save"}
          </Button>
        </div>
      </form>
    </Modal>
  );
};

const PaperCard = ({
  paper,
  usersById,
  canManage,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  paper: PaperSummary;
  usersById: Map<string, PublicUser>;
  canManage: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const thumbnail = api.thumbnailUrl(paper);
  const members = paper.memberIds
    .map((id) => usersById.get(id))
    .filter((user): user is PublicUser => !!user);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menuOpen]);

  return (
    <div className="wb-card">
      <Link to={`/p/${paper.id}`} className="wb-card__link">
        <div className="wb-card__thumb">
          {thumbnail ? (
            <img src={thumbnail} alt="" loading="lazy" />
          ) : (
            <span className="wb-card__thumb-empty">Empty paper</span>
          )}
          {paper.locked && (
            <span
              className="wb-card__lock"
              title="Locked: only the owner can edit"
            >
              🔒
            </span>
          )}
        </div>
        <div className="wb-card__body">
          <div className="wb-card__title" title={paper.title}>
            {paper.title}
          </div>
          <div className="wb-muted wb-small">
            {paper.pageCount} {paper.pageCount === 1 ? "page" : "pages"} ·
            edited {timeAgo(paper.updatedAt)}
          </div>
        </div>
      </Link>
      <div className="wb-card__footer">
        <div className="wb-card__members">
          {members.slice(0, 5).map((user) => (
            <Avatar
              key={user.id}
              id={user.id}
              name={user.displayName}
              size={22}
            />
          ))}
          {members.length > 5 && (
            <span className="wb-muted wb-small">+{members.length - 5}</span>
          )}
          {canManage && members.length === 0 && (
            <span className="wb-muted wb-small">Only you</span>
          )}
        </div>
        {canManage && (
          <div className="wb-card__menu" ref={menuRef}>
            <button
              type="button"
              className="wb-icon-btn"
              aria-label="Paper actions"
              onClick={() => setMenuOpen((open) => !open)}
            >
              ⋯
            </button>
            {menuOpen && (
              <div className="wb-menu wb-menu--up" role="menu">
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onEdit();
                  }}
                >
                  Rename, share & embed…
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onDuplicate();
                  }}
                >
                  Duplicate…
                </button>
                <button
                  type="button"
                  className="wb-menu__danger"
                  onClick={() => {
                    setMenuOpen(false);
                    onDelete();
                  }}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export const Dashboard = () => {
  const { user } = useAuth();
  const isAdmin = user.role === "admin";
  const [papers, setPapers] = useState<PaperSummary[] | null>(null);
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<
    | null
    | { mode: "create" }
    | { mode: "edit" | "duplicate"; paper: PaperSummary }
  >(null);
  const [deleting, setDeleting] = useState<PaperSummary | null>(null);

  const load = useCallback(async () => {
    try {
      const [{ papers }, usersResult] = await Promise.all([
        api.listPapers(),
        isAdmin ? api.listUsers() : Promise.resolve({ users: [] }),
      ]);
      setPapers(papers);
      setUsers(usersResult.users);
      setError(null);
    } catch (error: any) {
      setError(error.message);
    }
  }, [isAdmin]);

  useEffect(() => {
    load();
    // keep "edited x ago" & thumbnails fresh while the tab is visible
    const onVisible = () => {
      if (!document.hidden) {
        load();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    const interval = window.setInterval(onVisible, 30_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(interval);
    };
  }, [load]);

  const usersById = useMemo(
    () => new Map(users.map((user) => [user.id, user])),
    [users],
  );

  const filtered = (papers ?? []).filter((paper) =>
    paper.title.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <div className="wb-page">
      <AppHeader />
      <main className="wb-container">
        <div className="wb-toolbar">
          <h1>Papers</h1>
          <div className="wb-toolbar__spacer" />
          {(papers?.length ?? 0) > 4 && (
            <input
              className="wb-search"
              placeholder="Search papers…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          )}
          {isAdmin && (
            <Button
              variant="primary"
              onClick={() => setDialog({ mode: "create" })}
            >
              + New paper
            </Button>
          )}
        </div>
        <ErrorText>{error}</ErrorText>
        {papers === null ? (
          <Spinner />
        ) : papers.length === 0 ? (
          <div className="wb-empty">
            {isAdmin ? (
              <>
                <h2>No papers yet</h2>
                <p className="wb-muted">
                  A paper is a whiteboard with as many pages as you need. Create
                  one, share it with people, and work on it together live.
                </p>
                <Button
                  variant="primary"
                  onClick={() => setDialog({ mode: "create" })}
                >
                  Create your first paper
                </Button>
              </>
            ) : (
              <>
                <h2>Nothing shared with you yet</h2>
                <p className="wb-muted">
                  Papers appear here once an admin shares them with you.
                </p>
              </>
            )}
          </div>
        ) : (
          <div className="wb-grid">
            {filtered.map((paper) => (
              <PaperCard
                key={paper.id}
                paper={paper}
                usersById={usersById}
                canManage={isAdmin || paper.ownerId === user.id}
                onEdit={() => setDialog({ mode: "edit", paper })}
                onDuplicate={() => setDialog({ mode: "duplicate", paper })}
                onDelete={() => setDeleting(paper)}
              />
            ))}
          </div>
        )}
      </main>

      {dialog && (
        <PaperDialog
          mode={dialog.mode}
          paper={dialog.mode === "create" ? undefined : dialog.paper}
          users={users}
          onClose={() => {
            setDialog(null);
            load();
          }}
          onSaved={(paper) => {
            const mode = dialog.mode;
            setDialog(null);
            if (mode === "create") {
              navigate(`/p/${paper.id}`);
            } else {
              load();
            }
          }}
        />
      )}

      {deleting && (
        <Modal title="Delete paper?" onClose={() => setDeleting(null)}>
          <p>
            <strong>{deleting.title}</strong> and all of its{" "}
            {deleting.pageCount} {deleting.pageCount === 1 ? "page" : "pages"}{" "}
            will be deleted for everyone. This can't be undone.
          </p>
          <div className="wb-modal__actions">
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={async () => {
                const paper = deleting;
                setDeleting(null);
                try {
                  await api.deletePaper(paper.id);
                } catch (error: any) {
                  setError(error.message);
                }
                load();
              }}
            >
              Delete
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
};
