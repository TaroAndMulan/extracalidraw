import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";

import type {
  PageMeta,
  PaperSummary,
  PublicUser,
  Role,
  SyncedElement,
} from "./protocol";

// -----------------------------------------------------------------------------
// utils
// -----------------------------------------------------------------------------

export const randomId = (bytes = 12) =>
  crypto.randomBytes(bytes).toString("base64url");

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** ids end up in file paths, so they must be strictly validated */
export const isValidId = (id: unknown): id is string =>
  typeof id === "string" && ID_RE.test(id);

export const writeFileAtomic = async (
  file: string,
  data: string | Uint8Array,
) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomId(6)}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
};

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const readJSON = async <T>(file: string): Promise<T | null> => {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

const readGzipJSON = async <T>(file: string): Promise<T | null> => {
  try {
    const data = await gunzip(await fs.readFile(file));
    return JSON.parse(data.toString("utf8")) as T;
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

const readDirIfExists = async (dir: string) => {
  try {
    return await fs.readdir(dir);
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
};

// -----------------------------------------------------------------------------
// database (users, sessions, papers index)
// -----------------------------------------------------------------------------

export interface UserRecord extends PublicUser {
  passwordHash: string;
}

export interface SessionRecord {
  tokenHash: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
}

export type PaperRecord = PaperSummary;

interface DbData {
  version: 1;
  users: UserRecord[];
  sessions: SessionRecord[];
  papers: PaperRecord[];
}

export const toPublicUser = (user: UserRecord): PublicUser => ({
  id: user.id,
  username: user.username,
  displayName: user.displayName,
  role: user.role,
  createdAt: user.createdAt,
  disabled: !!user.disabled,
});

export const hashToken = (token: string) =>
  crypto.createHash("sha256").update(token).digest("hex");

/**
 * A tiny JSON-file backed database. The whole index lives in memory and is
 * written atomically (debounced) on every change — plenty for a team or class with
 * hundreds of members and papers. Paper contents are stored separately (see
 * `PaperStorage`).
 */
export class Database {
  private data: DbData;
  private readonly file: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private savePromise: Promise<void> = Promise.resolve();

  // lookups by id (every live message checks permissions)
  private usersById = new Map<string, UserRecord>();
  private papersById = new Map<string, PaperRecord>();
  private sessionsByHash = new Map<string, SessionRecord>();

  private constructor(file: string, data: DbData) {
    this.file = file;
    this.data = data;
    this.reindex();
  }

  private reindex() {
    this.usersById = new Map(this.data.users.map((user) => [user.id, user]));
    this.papersById = new Map(
      this.data.papers.map((paper) => [paper.id, paper]),
    );
    this.sessionsByHash = new Map(
      this.data.sessions.map((session) => [session.tokenHash, session]),
    );
  }

  static async open(dataDir: string) {
    await fs.mkdir(dataDir, { recursive: true });
    const file = path.join(dataDir, "db.json");
    const data = (await readJSON<DbData>(file)) ?? {
      version: 1,
      users: [],
      sessions: [],
      papers: [],
    };
    // fields added after the first release
    for (const paper of data.papers) {
      paper.shareToken ??= null;
      paper.shareAccess ??= "edit";
      paper.viewSync ??= "free";
    }
    const db = new Database(file, data);
    db.pruneSessions();
    return db;
  }

  /** schedules a write */
  save() {
    this.reindex();
    if (this.saveTimer) {
      return;
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.write();
    }, 200);
  }

  private write() {
    const json = JSON.stringify(this.data, null, 1);
    this.savePromise = this.savePromise
      .then(() => writeFileAtomic(this.file, json))
      .catch((error) => console.error("[db] failed to save", error));
    return this.savePromise;
  }

  async flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      await this.write();
    }
    await this.savePromise;
  }

  // ---------------------------------------------------------------------------
  // users
  // ---------------------------------------------------------------------------

  listUsers() {
    return [...this.data.users].sort((a, b) =>
      a.username.localeCompare(b.username),
    );
  }

  hasUsers() {
    return this.data.users.length > 0;
  }

  getUserById(id: string) {
    return this.usersById.get(id) ?? null;
  }

  getUserByUsername(username: string) {
    const normalized = username.trim().toLowerCase();
    return (
      this.data.users.find(
        (user) => user.username.toLowerCase() === normalized,
      ) ?? null
    );
  }

  createUser(input: {
    username: string;
    displayName: string;
    role: Role;
    passwordHash: string;
  }) {
    const user: UserRecord = {
      id: randomId(),
      username: input.username.trim(),
      displayName: input.displayName.trim() || input.username.trim(),
      role: input.role,
      passwordHash: input.passwordHash,
      createdAt: Date.now(),
      disabled: false,
    };
    this.data.users.push(user);
    this.save();
    return user;
  }

  updateUser(
    id: string,
    updates: Partial<
      Pick<UserRecord, "displayName" | "role" | "passwordHash" | "disabled">
    >,
  ) {
    const user = this.getUserById(id);
    if (!user) {
      return null;
    }
    Object.assign(user, updates);
    this.save();
    return user;
  }

  deleteUser(id: string) {
    this.data.users = this.data.users.filter((user) => user.id !== id);
    this.data.sessions = this.data.sessions.filter(
      (session) => session.userId !== id,
    );
    for (const paper of this.data.papers) {
      paper.memberIds = paper.memberIds.filter((memberId) => memberId !== id);
    }
    this.save();
  }

  // ---------------------------------------------------------------------------
  // sessions
  // ---------------------------------------------------------------------------

  createSession(userId: string, ttlMs: number) {
    const token = randomId(32);
    const now = Date.now();
    this.data.sessions.push({
      tokenHash: hashToken(token),
      userId,
      createdAt: now,
      expiresAt: now + ttlMs,
    });
    this.save();
    return token;
  }

  /** returns the session's user, if the session is valid */
  getSessionUser(token: string | undefined | null) {
    if (!token) {
      return null;
    }
    const session = this.sessionsByHash.get(hashToken(token));
    if (!session || session.expiresAt < Date.now()) {
      return null;
    }
    const user = this.getUserById(session.userId);
    if (!user || user.disabled) {
      return null;
    }
    return user;
  }

  deleteSession(token: string) {
    const tokenHash = hashToken(token);
    this.data.sessions = this.data.sessions.filter(
      (session) => session.tokenHash !== tokenHash,
    );
    this.save();
  }

  deleteUserSessions(userId: string, exceptToken?: string) {
    const exceptHash = exceptToken ? hashToken(exceptToken) : null;
    this.data.sessions = this.data.sessions.filter(
      (session) =>
        session.userId !== userId || session.tokenHash === exceptHash,
    );
    this.save();
  }

  private pruneSessions() {
    const now = Date.now();
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter(
      (session) => session.expiresAt > now,
    );
    if (before !== this.data.sessions.length) {
      this.save();
    }
  }

  // ---------------------------------------------------------------------------
  // papers
  // ---------------------------------------------------------------------------

  listPapers() {
    return [...this.data.papers].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getPaper(id: string) {
    return this.papersById.get(id) ?? null;
  }

  createPaper(input: {
    title: string;
    ownerId: string;
    memberIds: string[];
    id?: string;
    viewSync?: PaperRecord["viewSync"];
  }) {
    const now = Date.now();
    const paper: PaperRecord = {
      id: input.id ?? randomId(9),
      title: input.title.trim() || "Untitled paper",
      ownerId: input.ownerId,
      memberIds: [...new Set(input.memberIds)],
      createdAt: now,
      updatedAt: now,
      locked: false,
      pageCount: 1,
      thumbnailVersion: null,
      shareToken: null,
      shareAccess: "edit",
      viewSync: input.viewSync ?? "free",
    };
    this.data.papers.push(paper);
    this.save();
    return paper;
  }

  updatePaper(
    id: string,
    updates: Partial<
      Pick<
        PaperRecord,
        | "title"
        | "ownerId"
        | "memberIds"
        | "locked"
        | "updatedAt"
        | "pageCount"
        | "thumbnailVersion"
        | "shareToken"
        | "shareAccess"
        | "viewSync"
      >
    >,
  ) {
    const paper = this.getPaper(id);
    if (!paper) {
      return null;
    }
    Object.assign(paper, updates);
    this.save();
    return paper;
  }

  deletePaper(id: string) {
    this.data.papers = this.data.papers.filter((paper) => paper.id !== id);
    this.save();
  }
}

// -----------------------------------------------------------------------------
// paper contents (pages, elements, images, thumbnail)
// -----------------------------------------------------------------------------

const MIME_RE = /^[a-z]+\/[a-z0-9.+-]+$/i;

/** image types people may upload */
export const IMAGE_MIME_RE =
  /^image\/(png|jpeg|gif|webp|svg\+xml|bmp|x-icon|avif)$/;

export class PaperStorage {
  constructor(private readonly dataDir: string) {}

  private paperDir(paperId: string) {
    if (!isValidId(paperId)) {
      throw new Error(`invalid paper id: ${paperId}`);
    }
    return path.join(this.dataDir, "papers", paperId);
  }

  /** elements of a page, gzipped (JSON of handwriting shrinks ~5×) */
  private pageFile(paperId: string, pageId: string) {
    return `${this.legacyPageFile(paperId, pageId)}.gz`;
  }

  /** where pages were stored before they were gzipped (still read) */
  private legacyPageFile(paperId: string, pageId: string) {
    if (!isValidId(pageId)) {
      throw new Error(`invalid page id: ${pageId}`);
    }
    return path.join(this.paperDir(paperId), "pages", `${pageId}.json`);
  }

  private fileDir(paperId: string) {
    return path.join(this.paperDir(paperId), "files");
  }

  async loadPages(paperId: string) {
    const pages =
      (await readJSON<PageMeta[]>(
        path.join(this.paperDir(paperId), "pages.json"),
      )) ?? [];
    return pages.filter((page) => isValidId(page?.id));
  }

  /** `legacy`: stored in the old format, worth saving again */
  async loadPageElements(paperId: string, pageId: string) {
    const elements = await readGzipJSON<SyncedElement[]>(
      this.pageFile(paperId, pageId),
    );
    if (elements) {
      return { elements, legacy: false };
    }
    const legacy = await readJSON<SyncedElement[]>(
      this.legacyPageFile(paperId, pageId),
    );
    return { elements: legacy ?? [], legacy: !!legacy };
  }

  async savePages(paperId: string, pages: PageMeta[]) {
    await writeFileAtomic(
      path.join(this.paperDir(paperId), "pages.json"),
      JSON.stringify(pages),
    );
  }

  async savePageElements(
    paperId: string,
    pageId: string,
    elements: SyncedElement[],
  ) {
    await writeFileAtomic(
      this.pageFile(paperId, pageId),
      await gzip(JSON.stringify(elements)),
    );
    await fs.rm(this.legacyPageFile(paperId, pageId), { force: true });
  }

  async deletePageElements(paperId: string, pageId: string) {
    await fs.rm(this.pageFile(paperId, pageId), { force: true });
    await fs.rm(this.legacyPageFile(paperId, pageId), { force: true });
  }

  async deletePaper(paperId: string) {
    await fs.rm(this.paperDir(paperId), { recursive: true, force: true });
  }

  async duplicatePaper(sourceId: string, targetId: string) {
    const source = this.paperDir(sourceId);
    if (!existsSync(source)) {
      return;
    }
    const target = this.paperDir(targetId);
    const sourceFiles = this.fileDir(sourceId);
    await fs.cp(source, target, {
      recursive: true,
      filter: (file) => file !== sourceFiles,
    });
    // images never change (their id is a hash of the content, and they're
    // replaced, never written in place): copies share them through hard links,
    // so a paper used as a template costs no space per copy
    const names = await readDirIfExists(sourceFiles);
    if (!names.length) {
      return;
    }
    const targetFiles = this.fileDir(targetId);
    await fs.mkdir(targetFiles, { recursive: true });
    for (const name of names) {
      if (name.endsWith(".tmp")) {
        continue;
      }
      const from = path.join(sourceFiles, name);
      const to = path.join(targetFiles, name);
      try {
        await fs.link(from, to);
      } catch {
        // e.g. a file system without hard links
        await fs.copyFile(from, to);
      }
    }
  }

  /**
   * Deletes images that no element of the paper uses (erased images stay
   * until their element is pruned, see `TOMBSTONE_TTL_DAYS`). Only files
   * older than `minAgeMs`: an image is uploaded just before (or after) the
   * element that shows it reaches the server. Returns how many were deleted.
   */
  async removeUnusedFiles(
    paperId: string,
    usedFileIds: ReadonlySet<string>,
    minAgeMs: number,
    now = Date.now(),
  ) {
    const dir = this.fileDir(paperId);
    // an image is `<fileId>` and `<fileId>.json` (its type), plus temp files
    // (`<fileId>….tmp`) a crash may leave; ids have no dots
    const byId = new Map<string, string[]>();
    for (const name of await readDirIfExists(dir)) {
      const fileId = name.split(".")[0];
      byId.set(fileId, [...(byId.get(fileId) ?? []), name]);
    }
    let removed = 0;
    for (const [fileId, names] of byId) {
      if (usedFileIds.has(fileId) || !isValidId(fileId)) {
        continue;
      }
      const stats = await Promise.all(
        names.map((name) => fs.stat(path.join(dir, name)).catch(() => null)),
      );
      const newest = Math.max(0, ...stats.map((stat) => stat?.mtimeMs ?? 0));
      if (now - newest < minAgeMs) {
        continue;
      }
      // the data first (shortest name): without it the image counts as
      // missing (`hasFile`), and can be uploaded again
      for (const name of names.sort((a, b) => a.length - b.length)) {
        await fs.rm(path.join(dir, name), { force: true });
      }
      removed++;
    }
    return removed;
  }

  async saveFile(
    paperId: string,
    fileId: string,
    mimeType: string,
    data: Uint8Array,
  ) {
    if (!isValidId(fileId) || !MIME_RE.test(mimeType)) {
      throw new Error("invalid file");
    }
    const dir = this.fileDir(paperId);
    // write the metadata first so a readable file always has a mime type
    await writeFileAtomic(
      path.join(dir, `${fileId}.json`),
      JSON.stringify({ mimeType, created: Date.now() }),
    );
    await writeFileAtomic(path.join(dir, fileId), data);
  }

  async hasFile(paperId: string, fileId: string) {
    return (
      isValidId(fileId) && existsSync(path.join(this.fileDir(paperId), fileId))
    );
  }

  async readFile(paperId: string, fileId: string) {
    if (!isValidId(fileId)) {
      return null;
    }
    const dir = this.fileDir(paperId);
    const meta = await readJSON<{ mimeType: string }>(
      path.join(dir, `${fileId}.json`),
    );
    if (!meta) {
      return null;
    }
    try {
      const data = await fs.readFile(path.join(dir, fileId));
      return { data, mimeType: meta.mimeType };
    } catch (error: any) {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async saveThumbnail(paperId: string, data: Uint8Array) {
    await writeFileAtomic(
      path.join(this.paperDir(paperId), "thumbnail.png"),
      data,
    );
  }

  async readThumbnail(paperId: string) {
    try {
      return await fs.readFile(
        path.join(this.paperDir(paperId), "thumbnail.png"),
      );
    } catch (error: any) {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }
}
