import clsx from "clsx";
import { useEffect, useRef } from "react";

import type { ButtonHTMLAttributes, ReactNode } from "react";

export const Button = ({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
}) => (
  <button
    type="button"
    {...props}
    className={clsx(
      "wb-btn",
      `wb-btn--${variant}`,
      `wb-btn--${size}`,
      className,
    )}
  />
);

export const Modal = ({
  title,
  onClose,
  children,
  footer,
  width = 440,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    // focus the first input for quick keyboard use
    ref.current
      ?.querySelector<HTMLElement>("input, select, textarea, button")
      ?.focus();
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return (
    <div
      className="wb-modal-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="wb-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ maxWidth: width }}
        ref={ref}
      >
        <div className="wb-modal__header">
          <h2>{title}</h2>
          <button
            type="button"
            className="wb-icon-btn"
            aria-label="Close"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="wb-modal__body">{children}</div>
        {footer && <div className="wb-modal__footer">{footer}</div>}
      </div>
    </div>
  );
};

const AVATAR_COLORS = [
  "#e8590c",
  "#2f9e44",
  "#1971c2",
  "#9c36b5",
  "#c2255c",
  "#0c8599",
  "#5f3dc4",
  "#e67700",
];

export const colorForId = (id: string) => {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
};

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("") || "?";

export const Avatar = ({
  id,
  name,
  size = 28,
  title,
}: {
  id: string;
  name: string;
  size?: number;
  title?: string;
}) => (
  <span
    className="wb-avatar"
    title={title ?? name}
    style={{
      width: size,
      height: size,
      fontSize: Math.round(size * 0.4),
      background: colorForId(id),
    }}
  >
    {initials(name)}
  </span>
);

export const Field = ({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) => (
  <label className="wb-field">
    <span className="wb-field__label">{label}</span>
    {children}
    {hint && <span className="wb-field__hint">{hint}</span>}
  </label>
);

export const ErrorText = ({ children }: { children: ReactNode }) =>
  children ? <div className="wb-error">{children}</div> : null;

export const Spinner = ({ label }: { label?: string }) => (
  <div className="wb-spinner-wrap">
    <div className="wb-spinner" />
    {label && <div className="wb-spinner-label">{label}</div>}
  </div>
);

const rtf =
  typeof Intl !== "undefined" && "RelativeTimeFormat" in Intl
    ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })
    : null;

export const timeAgo = (timestamp: number) => {
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (!rtf) {
    return new Date(timestamp).toLocaleString();
  }
  if (abs < 60) {
    return rtf.format(seconds, "second");
  }
  if (abs < 3600) {
    return rtf.format(Math.round(seconds / 60), "minute");
  }
  if (abs < 86400) {
    return rtf.format(Math.round(seconds / 3600), "hour");
  }
  if (abs < 86400 * 30) {
    return rtf.format(Math.round(seconds / 86400), "day");
  }
  return new Date(timestamp).toLocaleDateString();
};
