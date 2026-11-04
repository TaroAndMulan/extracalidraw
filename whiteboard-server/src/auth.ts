import crypto from "node:crypto";
import { promisify } from "node:util";

import type { IncomingMessage } from "node:http";

const scrypt = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;

export const SESSION_COOKIE = "wb_session";

export const USERNAME_RE = /^[a-zA-Z0-9._-]{2,32}$/;
export const MIN_PASSWORD_LENGTH = 6;
export const MAX_PASSWORD_LENGTH = 200;

export const hashPassword = async (password: string) => {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH, SCRYPT_PARAMS);
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString(
    "base64",
  )}`;
};

export const verifyPassword = async (password: string, stored: string) => {
  const [scheme, N, r, p, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) {
    return false;
  }
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(
    password,
    Buffer.from(saltB64, "base64"),
    expected.length,
    { N: Number(N), r: Number(r), p: Number(p) },
  );
  return (
    actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected)
  );
};

/** a hash to compare against when the user doesn't exist (timing safety) */
let dummyHash: Promise<string> | null = null;
export const getDummyPasswordHash = () =>
  (dummyHash ??= hashPassword(crypto.randomBytes(16).toString("hex")));

export const validatePassword = (password: unknown): string | null => {
  if (typeof password !== "string") {
    return "Password is required";
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must have at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return "Password is too long";
  }
  return null;
};

export const validateUsername = (username: unknown): string | null => {
  if (typeof username !== "string" || !USERNAME_RE.test(username.trim())) {
    return "Username must be 2–32 characters: letters, numbers, dot, dash or underscore";
  }
  return null;
};

// -----------------------------------------------------------------------------
// cookies
// -----------------------------------------------------------------------------

export const parseCookies = (header: string | undefined) => {
  const cookies: Record<string, string> = {};
  if (!header) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) {
      continue;
    }
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name && !(name in cookies)) {
      try {
        cookies[name] = decodeURIComponent(value);
      } catch {
        cookies[name] = value;
      }
    }
  }
  return cookies;
};

export const getSessionToken = (req: IncomingMessage) =>
  parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? null;

export const serializeSessionCookie = (
  token: string,
  opts: { maxAgeSeconds: number; secure: boolean },
) =>
  [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(opts.maxAgeSeconds))}`,
    opts.secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");

// -----------------------------------------------------------------------------
// login rate limiting
// -----------------------------------------------------------------------------

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;

/** limits failed login attempts per (ip, username) pair */
export class LoginRateLimiter {
  private failures = new Map<string, { count: number; resetAt: number }>();

  isBlocked(key: string) {
    const entry = this.failures.get(key);
    if (!entry) {
      return false;
    }
    if (entry.resetAt < Date.now()) {
      this.failures.delete(key);
      return false;
    }
    return entry.count >= MAX_FAILURES;
  }

  fail(key: string) {
    const now = Date.now();
    const entry = this.failures.get(key);
    if (!entry || entry.resetAt < now) {
      this.failures.set(key, { count: 1, resetAt: now + WINDOW_MS });
    } else {
      entry.count++;
    }
    // keep the map from growing unbounded
    if (this.failures.size > 10_000) {
      for (const [key, entry] of this.failures) {
        if (entry.resetAt < now) {
          this.failures.delete(key);
        }
      }
    }
  }

  reset(key: string) {
    this.failures.delete(key);
  }
}
