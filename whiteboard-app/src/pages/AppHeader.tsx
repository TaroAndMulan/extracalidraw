import { useEffect, useRef, useState } from "react";

import { api } from "../api";
import { useAuth } from "../auth";
import { Avatar, Button, ErrorText, Field, Modal } from "../components/ui";
import { useTheme } from "../prefs";
import { Link } from "../router";

const ChangePasswordDialog = ({ onClose }: { onClose: () => void }) => {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <Modal title="Change password" onClose={onClose}>
      {done ? (
        <>
          <p>Your password was changed. Other devices were signed out.</p>
          <div className="wb-modal__actions">
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </>
      ) : (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (next !== confirm) {
              setError("The new passwords don't match");
              return;
            }
            setBusy(true);
            setError(null);
            try {
              await api.changePassword(current, next);
              setDone(true);
            } catch (error: any) {
              setError(error.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Current password">
            <input
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
              required
            />
          </Field>
          <Field label="New password" hint="At least 6 characters">
            <input
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(event) => setNext(event.target.value)}
              required
              minLength={6}
            />
          </Field>
          <Field label="Repeat new password">
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              required
            />
          </Field>
          <ErrorText>{error}</ErrorText>
          <div className="wb-modal__actions">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={busy}>
              Change password
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
};

export const AppHeader = () => {
  const { user, appName, logout } = useAuth();
  const { preference, setPreference, theme } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen]);

  return (
    <header className="wb-header">
      <Link to="/" className="wb-header__brand">
        {appName}
      </Link>
      <nav className="wb-header__nav">
        <Link to="/">Papers</Link>
        {user.role === "admin" && <Link to="/admin/users">People</Link>}
      </nav>
      <div className="wb-header__spacer" />
      <button
        type="button"
        className="wb-icon-btn"
        title={`Theme: ${preference}`}
        aria-label="Toggle theme"
        onClick={() => setPreference(theme === "dark" ? "light" : "dark")}
      >
        {theme === "dark" ? "☀" : "☾"}
      </button>
      <div className="wb-header__user" ref={menuRef}>
        <button
          type="button"
          className="wb-header__user-btn"
          onClick={() => setMenuOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <Avatar id={user.id} name={user.displayName} size={30} />
          <span className="wb-header__user-name">{user.displayName}</span>
          {user.role === "admin" && <span className="wb-badge">admin</span>}
        </button>
        {menuOpen && (
          <div className="wb-menu" role="menu">
            <div className="wb-menu__info">
              Signed in as <strong>{user.username}</strong>
            </div>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                setChangingPassword(true);
              }}
            >
              Change password
            </button>
            <button type="button" role="menuitem" onClick={logout}>
              Sign out
            </button>
          </div>
        )}
      </div>
      {changingPassword && (
        <ChangePasswordDialog onClose={() => setChangingPassword(false)} />
      )}
    </header>
  );
};
