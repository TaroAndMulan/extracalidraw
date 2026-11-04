import { useEffect, useState } from "react";

import { api } from "../api";
import { Button, Field, Spinner } from "../components/ui";
import { useTheme } from "../prefs";

import { PaperEditor } from "./PaperEditor";

import type { GuestIdentity } from "../../../whiteboard-server/src/protocol";

const GUEST_KEY = "whiteboard-guest";

const randomGuestId = () => {
  const bytes = new Uint8Array(12);
  window.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const loadGuest = (): Partial<GuestIdentity> => {
  try {
    return JSON.parse(localStorage.getItem(GUEST_KEY) || "{}");
  } catch {
    return {};
  }
};

const saveGuest = (guest: GuestIdentity) => {
  try {
    localStorage.setItem(GUEST_KEY, JSON.stringify(guest));
  } catch {
    // storage may be blocked in third-party iframes
  }
};

type Info = Awaited<ReturnType<typeof api.paperPublicInfo>>;

/**
 * `/embed/<paperId>#token=<shareToken>` — a paper on its own, meant to be put
 * in an <iframe> on other websites. Visitors join as guests (no account).
 *
 * Query parameters: `name` (the visitor's name), `theme` (`light`/`dark`).
 */
export const EmbedPage = ({ paperId }: { paperId: string }) => {
  // the token lives in the #hash so it's never sent to servers or in Referer
  const [shareToken] = useState(() =>
    new URLSearchParams(window.location.hash.slice(1)).get("token"),
  );
  const [params] = useState(() => new URLSearchParams(window.location.search));
  const { setPreference } = useTheme();
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guest, setGuest] = useState<GuestIdentity | null>(() => {
    const stored = loadGuest();
    const name = params.get("name")?.trim().slice(0, 40) || stored.name;
    return name ? { id: stored.id || randomGuestId(), name } : null;
  });
  const [nameInput, setNameInput] = useState("");

  useEffect(() => {
    const theme = params.get("theme");
    if (theme === "light" || theme === "dark") {
      setPreference(theme);
    }
  }, [params, setPreference]);

  // remember the guest (e.g. a name given by the embedding site)
  useEffect(() => {
    if (guest) {
      saveGuest(guest);
    }
  }, [guest]);

  useEffect(() => {
    api
      .paperPublicInfo(paperId, shareToken)
      .then((info) => {
        setInfo(info);
        document.title = info.title;
      })
      .catch((error) =>
        setError(
          error.status === 401 || error.status === 404
            ? "This whiteboard isn't available. The link may be wrong, or sharing was turned off."
            : error.message,
        ),
      );
  }, [paperId, shareToken]);

  if (error) {
    return (
      <div className="wb-center-message">
        <h2>Whiteboard unavailable</h2>
        <p className="wb-muted">{error}</p>
        {!shareToken && (
          <a href={`/p/${paperId}`} target="_blank" rel="noreferrer">
            Sign in to open it ↗
          </a>
        )}
      </div>
    );
  }

  if (!info) {
    return <Spinner />;
  }

  // signed-in users (same site) join with their account
  if (!info.signedIn && !guest) {
    return (
      <div className="wb-login">
        <form
          className="wb-login__card"
          onSubmit={(event) => {
            event.preventDefault();
            const name = nameInput.trim().slice(0, 40);
            if (name) {
              const identity = { id: loadGuest().id || randomGuestId(), name };
              saveGuest(identity);
              setGuest(identity);
            }
          }}
        >
          <h1>{info.title}</h1>
          <p className="wb-muted">
            {info.canEdit
              ? "Join to draw together in real time."
              : "Join to watch live."}
          </p>
          <Field label="Your name" hint="Shown next to your cursor">
            <input
              autoFocus
              value={nameInput}
              maxLength={40}
              placeholder="e.g. Alex"
              onChange={(event) => setNameInput(event.target.value)}
            />
          </Field>
          <Button
            type="submit"
            variant="primary"
            className="wb-login__submit"
            disabled={!nameInput.trim()}
          >
            Join
          </Button>
        </form>
      </div>
    );
  }

  return (
    <PaperEditor
      paperId={paperId}
      appName={info.appName}
      embed={{ shareToken, guest: info.signedIn ? null : guest }}
    />
  );
};

export default EmbedPage;
