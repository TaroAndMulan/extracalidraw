import { useState } from "react";

import { api } from "../api";
import { Button, ErrorText, Field } from "../components/ui";

import type { PublicUser } from "../../../whiteboard-server/src/protocol";

export const LoginPage = ({
  appName,
  onLogin,
}: {
  appName: string;
  onLogin: (user: PublicUser) => void;
}) => {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="wb-login">
      <form
        className="wb-login__card"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const { user } = await api.login(username, password);
            onLogin(user);
          } catch (error: any) {
            setError(error.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="wb-login__logo" aria-hidden="true">
          <svg viewBox="0 0 40 40" width="44" height="44">
            <rect
              x="4"
              y="7"
              width="32"
              height="24"
              rx="3"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            />
            <path
              d="M10 24c3-6 6-9 9-4s6 1 9-6"
              fill="none"
              stroke="#6965db"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
            <path
              d="M14 31l-3 5M26 31l3 5"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
          </svg>
        </div>
        <h1>{appName}</h1>
        <p className="wb-muted">Sign in to open your papers</p>
        <Field label="Username">
          <input
            autoFocus
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
          />
        </Field>
        <Field label="Password">
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </Field>
        <ErrorText>{error}</ErrorText>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !username || !password}
          className="wb-login__submit"
        >
          {busy ? "Signing in…" : "Sign in"}
        </Button>
        <p className="wb-muted wb-small">
          No account? Ask your admin to create one for you.
        </p>
      </form>
    </div>
  );
};
