import {
  LoginRateLimiter,
  getDummyPasswordHash,
  getSessionToken,
  hashPassword,
  serializeSessionCookie,
  validatePassword,
  validateUsername,
  verifyPassword,
} from "./auth";
import { HttpError, Router, readBody, readJSON, sendJSON } from "./http";
import {
  canAccessPaper,
  canEditPaper,
  canGuestEdit,
  canManagePaper,
  isValidShareToken,
} from "./realtime";
import { isValidId, randomId, toPublicUser } from "./store";

import type { Config } from "./config";
import type { Role } from "./protocol";
import type { PaperHub } from "./realtime";
import type { Database, PaperRecord, PaperStorage, UserRecord } from "./store";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface ApiContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  ip: string;
  secure: boolean;
  token: string | null;
  user: UserRecord | null;
}

const MAX_TITLE_LENGTH = 120;
const MAX_THUMBNAIL_BYTES = 1024 * 1024;
const IMAGE_MIME_RE = /^image\/(png|jpeg|gif|webp|svg\+xml|bmp|x-icon|avif)$/;

const requireUser = (ctx: ApiContext) => {
  if (!ctx.user) {
    throw new HttpError(401, "Please log in");
  }
  return ctx.user;
};

const requireAdmin = (ctx: ApiContext) => {
  const user = requireUser(ctx);
  if (user.role !== "admin") {
    throw new HttpError(403, "Admins only");
  }
  return user;
};

const parseRole = (role: unknown): Role => {
  if (role === "admin" || role === "member") {
    return role;
  }
  throw new HttpError(400, "Role must be admin or member");
};

export const createApi = ({
  db,
  storage,
  hub,
  config,
}: {
  db: Database;
  storage: PaperStorage;
  hub: PaperHub;
  config: Config;
}) => {
  const router = new Router<ApiContext>();
  const rateLimiter = new LoginRateLimiter();
  const sessionTtlMs = config.sessionTtlDays * 24 * 60 * 60 * 1000;

  const isSecure = (ctx: ApiContext) =>
    config.cookieSecure === "true" ||
    (config.cookieSecure === "auto" && ctx.secure);

  /** guests (public link / embed) send the link secret in this header */
  const getShareToken = (ctx: ApiContext) => {
    const header = ctx.req.headers["x-share-token"];
    return typeof header === "string" ? header : null;
  };

  /**
   * like `getPaperForUser`, but also lets in guests holding the paper's
   * public link token
   */
  const getPaperForUserOrGuest = (
    ctx: ApiContext,
    paperId: string,
    permission: "access" | "edit",
  ) => {
    const paper = isValidId(paperId) ? db.getPaper(paperId) : null;
    if (paper && ctx.user && canAccessPaper(ctx.user, paper)) {
      return getPaperForUser(ctx, paperId, permission);
    }
    if (paper && isValidShareToken(paper, getShareToken(ctx))) {
      if (permission === "edit" && !canGuestEdit(paper)) {
        throw new HttpError(403, "This paper is view only");
      }
      return { user: null, paper };
    }
    if (!ctx.user) {
      throw new HttpError(401, "Please log in");
    }
    throw new HttpError(404, "Paper not found");
  };

  /** the link secret is only shown to people who manage the paper */
  const toPaperView = (paper: PaperRecord, user: UserRecord | null) =>
    user && canManagePaper(user, paper)
      ? paper
      : { ...paper, shareToken: null };

  const getPaperForUser = (
    ctx: ApiContext,
    paperId: string,
    permission: "access" | "edit" | "manage" = "access",
  ) => {
    const user = requireUser(ctx);
    const paper = isValidId(paperId) ? db.getPaper(paperId) : null;
    if (!paper || !canAccessPaper(user, paper)) {
      throw new HttpError(404, "Paper not found");
    }
    if (permission === "edit" && !canEditPaper(user, paper)) {
      throw new HttpError(403, "This paper is locked");
    }
    if (permission === "manage" && !canManagePaper(user, paper)) {
      throw new HttpError(
        403,
        "Only the owner of this paper or an admin can do that",
      );
    }
    return { user, paper };
  };

  const validMemberIds = (memberIds: unknown) => {
    if (memberIds == null) {
      return [];
    }
    if (!Array.isArray(memberIds)) {
      throw new HttpError(400, "memberIds must be an array");
    }
    return [
      ...new Set(
        memberIds.filter(
          (id): id is string => typeof id === "string" && !!db.getUserById(id),
        ),
      ),
    ];
  };

  const parseTitle = (title: unknown) => {
    if (typeof title !== "string") {
      throw new HttpError(400, "Title is required");
    }
    return title.trim().slice(0, MAX_TITLE_LENGTH) || "Untitled paper";
  };

  const activeAdminCount = () =>
    db.listUsers().filter((user) => user.role === "admin" && !user.disabled)
      .length;

  // ---------------------------------------------------------------------------
  // misc
  // ---------------------------------------------------------------------------

  router.get("/api/health", ({ res }) => sendJSON(res, 200, { ok: true }));

  router.get("/api/config", ({ res }) =>
    sendJSON(res, 200, { appName: config.appName }),
  );

  // ---------------------------------------------------------------------------
  // auth
  // ---------------------------------------------------------------------------

  router.post("/api/auth/login", async (ctx) => {
    const body = await readJSON<{ username?: unknown; password?: unknown }>(
      ctx.req,
    );
    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";
    const limiterKey = `${ctx.ip}|${username.trim().toLowerCase()}`;

    if (rateLimiter.isBlocked(limiterKey)) {
      throw new HttpError(
        429,
        "Too many failed attempts. Try again in 15 minutes.",
      );
    }

    const user = db.getUserByUsername(username);
    const valid = await verifyPassword(
      password,
      user?.passwordHash ?? (await getDummyPasswordHash()),
    );
    if (!user || !valid) {
      rateLimiter.fail(limiterKey);
      throw new HttpError(401, "Wrong username or password");
    }
    if (user.disabled) {
      throw new HttpError(403, "This account is disabled");
    }
    rateLimiter.reset(limiterKey);

    const token = db.createSession(user.id, sessionTtlMs);
    sendJSON(
      ctx.res,
      200,
      { user: toPublicUser(user) },
      {
        "Set-Cookie": serializeSessionCookie(token, {
          maxAgeSeconds: sessionTtlMs / 1000,
          secure: isSecure(ctx),
        }),
      },
    );
  });

  router.post("/api/auth/logout", (ctx) => {
    if (ctx.token) {
      db.deleteSession(ctx.token);
    }
    sendJSON(
      ctx.res,
      200,
      { ok: true },
      {
        "Set-Cookie": serializeSessionCookie("", {
          maxAgeSeconds: 0,
          secure: isSecure(ctx),
        }),
      },
    );
  });

  // answers 200 either way so the app can check the session quietly
  router.get("/api/auth/me", (ctx) => {
    sendJSON(ctx.res, 200, { user: ctx.user ? toPublicUser(ctx.user) : null });
  });

  router.post("/api/auth/password", async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJSON<{
      currentPassword?: unknown;
      newPassword?: unknown;
    }>(ctx.req);
    if (
      typeof body.currentPassword !== "string" ||
      !(await verifyPassword(body.currentPassword, user.passwordHash))
    ) {
      throw new HttpError(400, "Current password is wrong");
    }
    const error = validatePassword(body.newPassword);
    if (error) {
      throw new HttpError(400, error);
    }
    db.updateUser(user.id, {
      passwordHash: await hashPassword(body.newPassword as string),
    });
    // log out other devices
    db.deleteUserSessions(user.id, ctx.token ?? undefined);
    sendJSON(ctx.res, 200, { ok: true });
  });

  // ---------------------------------------------------------------------------
  // users (admin)
  // ---------------------------------------------------------------------------

  router.get("/api/users", (ctx) => {
    requireAdmin(ctx);
    sendJSON(ctx.res, 200, { users: db.listUsers().map(toPublicUser) });
  });

  router.post("/api/users", async (ctx) => {
    requireAdmin(ctx);
    const body = await readJSON<{
      username?: unknown;
      displayName?: unknown;
      password?: unknown;
      role?: unknown;
    }>(ctx.req);
    const usernameError = validateUsername(body.username);
    if (usernameError) {
      throw new HttpError(400, usernameError);
    }
    const passwordError = validatePassword(body.password);
    if (passwordError) {
      throw new HttpError(400, passwordError);
    }
    const username = (body.username as string).trim();
    if (db.getUserByUsername(username)) {
      throw new HttpError(409, "This username is taken");
    }
    const user = db.createUser({
      username,
      displayName:
        typeof body.displayName === "string"
          ? body.displayName.slice(0, 60)
          : username,
      role: parseRole(body.role ?? "member"),
      passwordHash: await hashPassword(body.password as string),
    });
    sendJSON(ctx.res, 201, { user: toPublicUser(user) });
  });

  router.patch("/api/users/:id", async (ctx) => {
    const admin = requireAdmin(ctx);
    const user = db.getUserById(ctx.params.id);
    if (!user) {
      throw new HttpError(404, "User not found");
    }
    const body = await readJSON<{
      displayName?: unknown;
      password?: unknown;
      role?: unknown;
      disabled?: unknown;
    }>(ctx.req);
    const updates: Parameters<Database["updateUser"]>[1] = {};

    if (typeof body.displayName === "string") {
      updates.displayName =
        body.displayName.trim().slice(0, 60) || user.username;
    }
    if (body.password != null) {
      const error = validatePassword(body.password);
      if (error) {
        throw new HttpError(400, error);
      }
      updates.passwordHash = await hashPassword(body.password as string);
    }
    if (body.role != null) {
      updates.role = parseRole(body.role);
    }
    if (body.disabled != null) {
      updates.disabled = body.disabled === true;
    }

    const losesAdmin =
      user.role === "admin" &&
      !user.disabled &&
      ((updates.role && updates.role !== "admin") || updates.disabled);
    if (losesAdmin && user.id === admin.id) {
      throw new HttpError(400, "You can't remove your own admin access");
    }
    if (losesAdmin && activeAdminCount() <= 1) {
      throw new HttpError(400, "There must be at least one active admin");
    }

    const updated = db.updateUser(user.id, updates)!;
    if (updates.passwordHash || updates.disabled) {
      // force re-login everywhere
      db.deleteUserSessions(user.id);
    }
    await hub.onUserChanged(user.id);
    sendJSON(ctx.res, 200, { user: toPublicUser(updated) });
  });

  router.delete("/api/users/:id", async (ctx) => {
    const admin = requireAdmin(ctx);
    const user = db.getUserById(ctx.params.id);
    if (!user) {
      throw new HttpError(404, "User not found");
    }
    if (user.id === admin.id) {
      throw new HttpError(400, "You can't delete your own account");
    }
    if (user.role === "admin" && !user.disabled && activeAdminCount() <= 1) {
      throw new HttpError(400, "There must be at least one active admin");
    }
    // hand papers owned by the deleted user over to the admin deleting them
    for (const paper of db.listPapers()) {
      if (paper.ownerId === user.id) {
        db.updatePaper(paper.id, { ownerId: admin.id });
      }
    }
    db.deleteUser(user.id);
    await hub.onUserChanged(user.id);
    sendJSON(ctx.res, 200, { ok: true });
  });

  // ---------------------------------------------------------------------------
  // papers
  // ---------------------------------------------------------------------------

  router.get("/api/papers", (ctx) => {
    const user = requireUser(ctx);
    const papers = db
      .listPapers()
      .filter((paper) => canAccessPaper(user, paper))
      .map((paper) => toPaperView(paper, user));
    sendJSON(ctx.res, 200, { papers });
  });

  router.post("/api/papers", async (ctx) => {
    const admin = requireAdmin(ctx);
    const body = await readJSON<{ title?: unknown; memberIds?: unknown }>(
      ctx.req,
    );
    const paper = db.createPaper({
      title: parseTitle(body.title ?? ""),
      ownerId: admin.id,
      memberIds: validMemberIds(body.memberIds),
    });
    sendJSON(ctx.res, 201, { paper });
  });

  router.get("/api/papers/:id", (ctx) => {
    const { paper, user } = getPaperForUser(ctx, ctx.params.id);
    sendJSON(ctx.res, 200, { paper: toPaperView(paper, user) });
  });

  /** what the embed page needs to know before joining */
  router.get("/api/papers/:id/public", (ctx) => {
    const { paper, user } = getPaperForUserOrGuest(
      ctx,
      ctx.params.id,
      "access",
    );
    sendJSON(ctx.res, 200, {
      title: paper.title,
      appName: config.appName,
      signedIn: !!user,
      canEdit: user ? canEditPaper(user, paper) : canGuestEdit(paper),
    });
  });

  /** turns the public link (used for embedding) on/off */
  router.post("/api/papers/:id/share", async (ctx) => {
    const { paper } = getPaperForUser(ctx, ctx.params.id, "manage");
    const body = await readJSON<{
      enabled?: unknown;
      access?: unknown;
      regenerate?: unknown;
    }>(ctx.req);
    const enabled = body.enabled !== false;
    const shareAccess =
      body.access === "view" || body.access === "edit"
        ? body.access
        : paper.shareAccess;
    const shareToken = !enabled
      ? null
      : !paper.shareToken || body.regenerate === true
      ? randomId(18)
      : paper.shareToken;
    const updated = db.updatePaper(paper.id, { shareToken, shareAccess })!;
    // kicks guests holding an old link, updates permissions of the others
    hub.onPaperUpdated(updated);
    sendJSON(ctx.res, 200, { paper: updated });
  });

  router.patch("/api/papers/:id", async (ctx) => {
    const { paper } = getPaperForUser(ctx, ctx.params.id, "manage");
    const body = await readJSON<{
      title?: unknown;
      memberIds?: unknown;
      locked?: unknown;
    }>(ctx.req);
    const updates: Partial<PaperRecord> = {};
    if (body.title != null) {
      updates.title = parseTitle(body.title);
    }
    if (body.memberIds != null) {
      updates.memberIds = validMemberIds(body.memberIds);
    }
    if (body.locked != null) {
      updates.locked = body.locked === true;
    }
    const updated = db.updatePaper(paper.id, updates)!;
    hub.onPaperUpdated(updated);
    sendJSON(ctx.res, 200, { paper: updated });
  });

  router.delete("/api/papers/:id", async (ctx) => {
    const { paper } = getPaperForUser(ctx, ctx.params.id, "manage");
    db.deletePaper(paper.id);
    await hub.onPaperDeleted(paper.id);
    await storage.deletePaper(paper.id);
    sendJSON(ctx.res, 200, { ok: true });
  });

  router.post("/api/papers/:id/duplicate", async (ctx) => {
    const admin = requireAdmin(ctx);
    const { paper } = getPaperForUser(ctx, ctx.params.id);
    const body = await readJSON<{ title?: unknown; memberIds?: unknown }>(
      ctx.req,
    );
    await hub.persist(paper.id);
    const id = randomId(9);
    await storage.duplicatePaper(paper.id, id);
    const copy = db.createPaper({
      id,
      title: parseTitle(body.title ?? `${paper.title} (copy)`),
      ownerId: admin.id,
      memberIds:
        body.memberIds != null
          ? validMemberIds(body.memberIds)
          : paper.memberIds,
    });
    db.updatePaper(copy.id, {
      pageCount: paper.pageCount,
      thumbnailVersion: paper.thumbnailVersion,
    });
    sendJSON(ctx.res, 201, { paper: copy });
  });

  // ---------------------------------------------------------------------------
  // images & thumbnails
  // ---------------------------------------------------------------------------

  router.put("/api/papers/:id/files/:fileId", async (ctx) => {
    const { paper } = getPaperForUserOrGuest(ctx, ctx.params.id, "edit");
    const { fileId } = ctx.params;
    const mimeType = String(ctx.req.headers["content-type"] || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!isValidId(fileId)) {
      throw new HttpError(400, "Invalid file id");
    }
    if (!IMAGE_MIME_RE.test(mimeType)) {
      throw new HttpError(415, "Only images can be uploaded");
    }
    // file ids are content hashes, so an existing file never changes
    if (await storage.hasFile(paper.id, fileId)) {
      ctx.req.resume();
      sendJSON(ctx.res, 200, { ok: true });
      return;
    }
    const data = await readBody(ctx.req, config.maxFileBytes);
    await storage.saveFile(paper.id, fileId, mimeType, data);
    sendJSON(ctx.res, 201, { ok: true });
  });

  router.get("/api/papers/:id/files/:fileId", async (ctx) => {
    const { paper } = getPaperForUserOrGuest(ctx, ctx.params.id, "access");
    const file = await storage.readFile(paper.id, ctx.params.fileId);
    if (!file) {
      throw new HttpError(404, "File not found");
    }
    ctx.res.writeHead(200, {
      "Content-Type": file.mimeType,
      "Content-Length": String(file.data.length),
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      // svg images must never run scripts in our origin
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'",
    });
    ctx.res.end(ctx.req.method === "HEAD" ? undefined : file.data);
  });

  router.put("/api/papers/:id/thumbnail", async (ctx) => {
    const { paper } = getPaperForUser(ctx, ctx.params.id, "edit");
    const mimeType = String(ctx.req.headers["content-type"] || "");
    if (!mimeType.startsWith("image/png")) {
      throw new HttpError(415, "Thumbnail must be a PNG");
    }
    const data = await readBody(ctx.req, MAX_THUMBNAIL_BYTES);
    await storage.saveThumbnail(paper.id, data);
    const updated = db.updatePaper(paper.id, { thumbnailVersion: Date.now() });
    sendJSON(ctx.res, 200, { thumbnailVersion: updated?.thumbnailVersion });
  });

  router.get("/api/papers/:id/thumbnail", async (ctx) => {
    const { paper } = getPaperForUser(ctx, ctx.params.id);
    const data = await storage.readThumbnail(paper.id);
    if (!data) {
      throw new HttpError(404, "No thumbnail");
    }
    ctx.res.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": String(data.length),
      // the url carries a version, so it can be cached
      "Cache-Control": "private, max-age=31536000, immutable",
    });
    ctx.res.end(ctx.req.method === "HEAD" ? undefined : data);
  });

  // ---------------------------------------------------------------------------

  const isSameOrigin = (req: IncomingMessage) => {
    const origin = req.headers.origin;
    if (!origin) {
      return true;
    }
    if (config.allowedOrigins.includes(origin)) {
      return true;
    }
    const host =
      (config.trustProxy && (req.headers["x-forwarded-host"] as string)) ||
      req.headers.host;
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  };

  return {
    isSameOrigin,
    async handle(
      req: IncomingMessage,
      res: ServerResponse,
      url: URL,
      meta: { ip: string; secure: boolean },
    ) {
      try {
        if (
          req.method !== "GET" &&
          req.method !== "HEAD" &&
          !isSameOrigin(req)
        ) {
          throw new HttpError(403, "Cross-origin requests are not allowed");
        }
        const match = router.match(req.method || "GET", url.pathname);
        if (!match) {
          throw new HttpError(404, "Not found");
        }
        if (match === "method-not-allowed") {
          throw new HttpError(405, "Method not allowed");
        }
        const token = getSessionToken(req);
        await match.handler({
          req,
          res,
          url,
          ip: meta.ip,
          secure: meta.secure,
          token,
          user: db.getSessionUser(token),
          params: match.params,
        });
      } catch (error: any) {
        if (res.headersSent) {
          res.end();
          return;
        }
        if (error instanceof HttpError) {
          sendJSON(res, error.status, { error: error.message });
        } else {
          console.error(`[api] ${req.method} ${url.pathname}`, error);
          sendJSON(res, 500, { error: "Something went wrong" });
        }
      }
    },
  };
};
