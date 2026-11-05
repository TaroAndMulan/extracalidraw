import { useCallback, useEffect, useState } from "react";

import { api } from "../api";
import { useAuth } from "../auth";
import {
  Avatar,
  Button,
  ErrorText,
  Field,
  Modal,
  Spinner,
  timeAgo,
} from "../components/ui";

import { AppHeader } from "./AppHeader";

import type { PublicUser, Role } from "../../../whiteboard-server/src/protocol";

/** readable random passwords that are easy to hand out */
const generatePassword = () => {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(10);
  window.crypto.getRandomValues(bytes);
  const chars = [...bytes].map((byte) => alphabet[byte % alphabet.length]);
  return `${chars.slice(0, 5).join("")}-${chars.slice(5).join("")}`;
};

const CredentialsNote = ({
  username,
  password,
}: {
  username: string;
  password: string;
}) => {
  const [copied, setCopied] = useState(false);
  const text = `${window.location.origin}\nUsername: ${username}\nPassword: ${password}`;
  return (
    <div className="wb-credentials">
      <pre>{text}</pre>
      <Button
        size="sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? "Copied ✓" : "Copy"}
      </Button>
    </div>
  );
};

/** a username from a name, e.g. "Maya Chen" → "maya.chen" */
const toUsername = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 28);

const randomDigits = () =>
  String(1000 + (window.crypto.getRandomValues(new Uint16Array(1))[0] % 9000));

type BulkResult = {
  name: string;
  username: string;
  password: string;
  error: string | null;
};

const toCSV = (rows: BulkResult[]) =>
  [
    "name,username,password",
    ...rows
      .filter((row) => !row.error)
      .map((row) =>
        [row.name, row.username, row.password]
          .map((value) => `"${value.replace(/"/g, '""')}"`)
          .join(","),
      ),
  ].join("\n");

const BulkCreateDialog = ({
  existingUsernames,
  onClose,
  onCreated,
}: {
  existingUsernames: string[];
  onClose: () => void;
  onCreated: () => void;
}) => {
  const [text, setText] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [progress, setProgress] = useState<string | null>(null);
  const [results, setResults] = useState<BulkResult[] | null>(null);
  const [copied, setCopied] = useState(false);

  const entries = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, username] = line.split(",").map((part) => part.trim());
      return { name, username: username || "" };
    });

  const create = async () => {
    const taken = new Set(existingUsernames.map((name) => name.toLowerCase()));
    const created: BulkResult[] = [];
    for (const [index, entry] of entries.entries()) {
      setProgress(`Creating ${index + 1} of ${entries.length}…`);
      let username = entry.username || toUsername(entry.name);
      if (username.length < 2) {
        // e.g. names written in non-latin scripts
        username = `user-${randomDigits()}`;
      }
      if (!entry.username) {
        const base = username;
        for (let n = 2; taken.has(username.toLowerCase()); n++) {
          username = `${base}${n}`;
        }
      }
      const password = generatePassword();
      try {
        await api.createUser({
          username,
          displayName: entry.name,
          password,
          role,
        });
        taken.add(username.toLowerCase());
        created.push({ name: entry.name, username, password, error: null });
      } catch (error: any) {
        created.push({
          name: entry.name,
          username,
          password: "",
          error: error.message,
        });
      }
    }
    setProgress(null);
    setResults(created);
    onCreated();
  };

  if (results) {
    const ok = results.filter((row) => !row.error);
    const summary = ok
      .map((row) => `${row.name}: ${row.username} / ${row.password}`)
      .join("\n");
    return (
      <Modal
        title={`Created ${ok.length} accounts`}
        onClose={onClose}
        width={560}
      >
        <p>
          Send each person their username and password (sign in at{" "}
          <strong>{window.location.origin}</strong>). Passwords aren't shown
          again, but you can reset them any time.
        </p>
        <div className="wb-table-wrap wb-bulk-results">
          <table className="wb-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Username</th>
                <th>Password</th>
              </tr>
            </thead>
            <tbody>
              {results.map((row, index) => (
                <tr key={index}>
                  <td>{row.name}</td>
                  <td className="wb-mono">{row.username}</td>
                  <td className="wb-mono">
                    {row.error ? (
                      <span className="wb-text-danger">{row.error}</span>
                    ) : (
                      row.password
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="wb-modal__actions">
          <Button
            onClick={() => {
              const blob = new Blob([toCSV(results)], { type: "text/csv" });
              const link = document.createElement("a");
              link.href = URL.createObjectURL(blob);
              link.download = "accounts.csv";
              link.click();
              URL.revokeObjectURL(link.href);
            }}
          >
            Download CSV
          </Button>
          <Button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(summary);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? "Copied ✓" : "Copy all"}
          </Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Add many people" onClose={onClose} width={520}>
      <Field
        label="Names, one per line"
        hint={
          <>
            Optionally add a username after a comma, e.g.{" "}
            <code>Maya Chen, maya</code>. Usernames and passwords are generated
            for you.
          </>
        }
      >
        <textarea
          className="wb-textarea"
          rows={8}
          value={text}
          placeholder={"Maya Chen\nOmar Haddad\nSam Lee, sam"}
          onChange={(event) => setText(event.target.value)}
          disabled={!!progress}
        />
      </Field>
      <Field label="Role">
        <select
          value={role}
          onChange={(event) => setRole(event.target.value as Role)}
          disabled={!!progress}
        >
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
      </Field>
      <div className="wb-modal__actions">
        <Button onClick={onClose} disabled={!!progress}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!entries.length || !!progress}
          onClick={create}
        >
          {progress ??
            `Create ${entries.length || ""} ${
              entries.length === 1 ? "account" : "accounts"
            }`}
        </Button>
      </div>
    </Modal>
  );
};

const CreateUserDialog = ({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) => {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState(generatePassword);
  const [role, setRole] = useState<Role>("member");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<PublicUser | null>(null);

  if (created) {
    return (
      <Modal title="Account created" onClose={onClose}>
        <p>
          Send these sign-in details to <strong>{created.displayName}</strong>.
          The password won't be shown again (you can reset it any time).
        </p>
        <CredentialsNote username={created.username} password={password} />
        <div className="wb-modal__actions">
          <Button
            onClick={() => {
              setCreated(null);
              setUsername("");
              setDisplayName("");
              setPassword(generatePassword());
            }}
          >
            Add another
          </Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Add person" onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const { user } = await api.createUser({
              username: username.trim(),
              displayName: displayName.trim() || username.trim(),
              password,
              role,
            });
            setCreated(user);
            onCreated();
          } catch (error: any) {
            setError(error.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Name" hint="Shown next to their cursor">
          <input
            value={displayName}
            maxLength={60}
            placeholder="e.g. Maya Chen"
            onChange={(event) => {
              const value = event.target.value;
              // suggest a username from the name
              if (
                !username ||
                username ===
                  displayName
                    .toLowerCase()
                    .trim()
                    .replace(/[^a-z0-9]+/g, ".")
              ) {
                setUsername(
                  value
                    .toLowerCase()
                    .trim()
                    .replace(/[^a-z0-9]+/g, ".")
                    .replace(/^\.+|\.+$/g, ""),
                );
              }
              setDisplayName(value);
            }}
          />
        </Field>
        <Field label="Username" hint="Letters, numbers, dot, dash, underscore">
          <input
            value={username}
            required
            autoCapitalize="none"
            spellCheck={false}
            pattern="[a-zA-Z0-9._\-]{2,32}"
            onChange={(event) => setUsername(event.target.value)}
          />
        </Field>
        <Field label="Password">
          <div className="wb-input-row">
            <input
              value={password}
              required
              minLength={6}
              onChange={(event) => setPassword(event.target.value)}
            />
            <Button size="sm" onClick={() => setPassword(generatePassword())}>
              Generate
            </Button>
          </div>
        </Field>
        <Field
          label="Role"
          hint={
            role === "admin"
              ? "Admins can manage people and see/edit every paper."
              : "Members open the papers you share with them."
          }
        >
          <select
            value={role}
            onChange={(event) => setRole(event.target.value as Role)}
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="wb-modal__actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            Create account
          </Button>
        </div>
      </form>
    </Modal>
  );
};

const EditUserDialog = ({
  user,
  isSelf,
  onClose,
  onSaved,
}: {
  user: PublicUser;
  isSelf: boolean;
  onClose: () => void;
  onSaved: () => void;
}) => {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [role, setRole] = useState<Role>(user.role);
  const [resetPassword, setResetPassword] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedPassword, setSavedPassword] = useState<string | null>(null);

  if (savedPassword) {
    return (
      <Modal title="Password reset" onClose={onClose}>
        <p>
          New sign-in details for <strong>{user.displayName}</strong> (they were
          signed out everywhere):
        </p>
        <CredentialsNote username={user.username} password={savedPassword} />
        <div className="wb-modal__actions">
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Edit ${user.displayName}`} onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api.updateUser(user.id, {
              displayName,
              ...(role !== user.role ? { role } : {}),
              ...(resetPassword ? { password: resetPassword } : {}),
            });
            onSaved();
            if (resetPassword) {
              setSavedPassword(resetPassword);
            } else {
              onClose();
            }
          } catch (error: any) {
            setError(error.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Username">
          <input value={user.username} disabled />
        </Field>
        <Field label="Name">
          <input
            value={displayName}
            maxLength={60}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </Field>
        <Field label="Role">
          <select
            value={role}
            disabled={isSelf}
            onChange={(event) => setRole(event.target.value as Role)}
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </Field>
        <Field label="Password">
          {resetPassword === null ? (
            <Button
              size="sm"
              onClick={() => setResetPassword(generatePassword())}
            >
              Reset password…
            </Button>
          ) : (
            <div className="wb-input-row">
              <input
                value={resetPassword}
                minLength={6}
                onChange={(event) => setResetPassword(event.target.value)}
              />
              <Button size="sm" onClick={() => setResetPassword(null)}>
                Keep current
              </Button>
            </div>
          )}
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="wb-modal__actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
};

export const AdminUsers = () => {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<PublicUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [bulkCreating, setBulkCreating] = useState(false);
  const [editing, setEditing] = useState<PublicUser | null>(null);
  const [deleting, setDeleting] = useState<PublicUser | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    try {
      setUsers((await api.listUsers()).users);
    } catch (error: any) {
      setError(error.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = (users ?? []).filter((user) =>
    `${user.displayName} ${user.username}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );

  return (
    <div className="wb-page">
      <AppHeader />
      <main className="wb-container">
        <div className="wb-toolbar">
          <h1>People</h1>
          <div className="wb-toolbar__spacer" />
          {(users?.length ?? 0) > 6 && (
            <input
              className="wb-search"
              placeholder="Search people…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          )}
          <Button onClick={() => setBulkCreating(true)}>Add many…</Button>
          <Button variant="primary" onClick={() => setCreating(true)}>
            + Add person
          </Button>
        </div>
        <p className="wb-muted">
          Everyone signs in with the username and password you give them. Share
          papers with them from the Papers page.
        </p>
        <ErrorText>{error}</ErrorText>
        {users === null ? (
          <Spinner />
        ) : (
          <div className="wb-table-wrap">
            <table className="wb-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Username</th>
                  <th>Role</th>
                  <th>Added</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((user) => (
                  <tr
                    key={user.id}
                    className={user.disabled ? "is-disabled" : ""}
                  >
                    <td>
                      <div className="wb-table__name">
                        <Avatar
                          id={user.id}
                          name={user.displayName}
                          size={26}
                        />
                        {user.displayName}
                        {user.id === me.id && (
                          <span className="wb-muted wb-small">(you)</span>
                        )}
                      </div>
                    </td>
                    <td className="wb-mono">{user.username}</td>
                    <td>
                      <span
                        className={`wb-badge ${
                          user.role === "admin" ? "" : "wb-badge--muted"
                        }`}
                      >
                        {user.role}
                      </span>
                      {user.disabled && (
                        <span className="wb-badge wb-badge--danger">
                          disabled
                        </span>
                      )}
                    </td>
                    <td className="wb-muted wb-small">
                      {timeAgo(user.createdAt)}
                    </td>
                    <td className="wb-table__actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing(user)}
                      >
                        Edit
                      </Button>
                      {user.id !== me.id && (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={async () => {
                              try {
                                await api.updateUser(user.id, {
                                  disabled: !user.disabled,
                                });
                                load();
                              } catch (error: any) {
                                setError(error.message);
                              }
                            }}
                          >
                            {user.disabled ? "Enable" : "Disable"}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="wb-text-danger"
                            onClick={() => setDeleting(user)}
                          >
                            Delete
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {bulkCreating && (
        <BulkCreateDialog
          existingUsernames={(users ?? []).map((user) => user.username)}
          onClose={() => setBulkCreating(false)}
          onCreated={load}
        />
      )}
      {creating && (
        <CreateUserDialog onClose={() => setCreating(false)} onCreated={load} />
      )}
      {editing && (
        <EditUserDialog
          user={editing}
          isSelf={editing.id === me.id}
          onClose={() => setEditing(null)}
          onSaved={load}
        />
      )}
      {deleting && (
        <Modal title="Delete account?" onClose={() => setDeleting(null)}>
          <p>
            <strong>{deleting.displayName}</strong> (@{deleting.username}) will
            lose access to every paper. Their drawings stay on the papers.
            {deleting.role === "admin" &&
              " Papers they own are handed over to you."}
          </p>
          <div className="wb-modal__actions">
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={async () => {
                const user = deleting;
                setDeleting(null);
                try {
                  await api.deleteUser(user.id);
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
