import { useState } from "react";

import { api } from "../api";

import { Button, ErrorText } from "./ui";

import type { PaperSummary } from "../../../whiteboard-server/src/protocol";

export const getEmbedUrl = (paperId: string, shareToken: string) =>
  `${window.location.origin}/embed/${paperId}#token=${shareToken}`;

export const getIframeSnippet = (url: string) =>
  `<iframe src="${url}" width="100%" height="600" style="border:0;border-radius:8px" allow="clipboard-read; clipboard-write; fullscreen" allowfullscreen></iframe>`;

const CopyField = ({
  value,
  multiline,
  label,
}: {
  value: string;
  multiline?: boolean;
  label: string;
}) => {
  const [copied, setCopied] = useState(false);
  return (
    <div className="wb-copy-field">
      {multiline ? (
        <textarea
          readOnly
          value={value}
          rows={3}
          aria-label={label}
          onFocus={(event) => event.target.select()}
        />
      ) : (
        <input
          readOnly
          value={value}
          aria-label={label}
          onFocus={(event) => event.target.select()}
        />
      )}
      <Button
        size="sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
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

/**
 * Public link & embed settings of a paper (for its owner/admins). Anyone with
 * the link joins without an account, which is what makes embedding the paper
 * on another website work.
 */
export const ShareSettings = ({
  paper,
  onChange,
}: {
  paper: PaperSummary;
  onChange: (paper: PaperSummary) => void;
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabled = !!paper.shareToken;

  const update = async (options: Parameters<typeof api.sharePaper>[1]) => {
    setBusy(true);
    setError(null);
    try {
      onChange((await api.sharePaper(paper.id, options)).paper);
    } catch (error: any) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  };

  const url = paper.shareToken ? getEmbedUrl(paper.id, paper.shareToken) : "";

  return (
    <div className="wb-share">
      <label className="wb-share__toggle">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(event) =>
            update({ enabled: event.target.checked, access: paper.shareAccess })
          }
        />
        <span>
          <strong>Public link &amp; embed</strong>
          <span className="wb-muted wb-small">
            Anyone with the link can join live without an account — use it to
            put this paper on another website.
          </span>
        </span>
      </label>
      {enabled && (
        <>
          <div className="wb-segmented" role="radiogroup" aria-label="Access">
            {(
              [
                ["edit", "Can draw"],
                ["view", "View only"],
              ] as const
            ).map(([access, label]) => (
              <button
                key={access}
                type="button"
                role="radio"
                aria-checked={paper.shareAccess === access}
                className={paper.shareAccess === access ? "is-active" : ""}
                disabled={busy}
                onClick={() => update({ enabled: true, access })}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="wb-field">
            <span className="wb-field__label">Link</span>
            <CopyField value={url} label="Public link" />
          </div>
          <div className="wb-field">
            <span className="wb-field__label">Embed code</span>
            <CopyField
              value={getIframeSnippet(url)}
              label="Embed code"
              multiline
            />
            <span className="wb-field__hint">
              Paste it into any web page. To set the visitor's name from your
              site, add <code>?name=Alice</code> before the <code>#</code>. Use{" "}
              <code>?theme=dark</code> for dark mode.
            </span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  "Create a new link? The current link and embeds stop working.",
                )
              ) {
                update({ enabled: true, regenerate: true });
              }
            }}
          >
            ↻ Reset link
          </Button>
        </>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  );
};
