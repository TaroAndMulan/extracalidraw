import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

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

  private constructor(file: string, data: DbData) {
    this.file = file;
    this.data = data;
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
    }
    const db = new Database(file, data);
    db.pruneSessions();
    return db;
  }

  /** schedules a write */
  save() {
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
    return this.data.users.find((user) => user.id === id) ?? null;
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
    const tokenHash = hashToken(token);
    const session = this.data.sessions.find(
      (session) => session.tokenHash === tokenHash,
    );
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
    return this.data.papers.find((paper) => paper.id === id) ?? null;
  }

  createPaper(input: {
    title: string;
    ownerId: string;
    memberIds: string[];
    id?: string;
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

export class PaperStorage {
  constructor(private readonly dataDir: string) {}

  private paperDir(paperId: string) {
    if (!isValidId(paperId)) {
      throw new Error(`invalid paper id: ${paperId}`);
    }
    return path.join(this.dataDir, "papers", paperId);
  }

  private pageFile(paperId: string, pageId: string) {
    if (!isValidId(pageId)) {
      throw new Error(`invalid page id: ${pageId}`);
    }
    return path.join(this.paperDir(paperId), "pages", `${pageId}.json`);
  }

  private fileDir(paperId: string) {
    return path.join(this.paperDir(paperId), "files");
  }

  async loadPaper(paperId: string) {
    const pages =
      (await readJSON<PageMeta[]>(
        path.join(this.paperDir(paperId), "pages.json"),
      )) ?? [];
    const elements = new Map<string, SyncedElement[]>();
    await Promise.all(
      pages.map(async (page) => {
        if (!isValidId(page.id)) {
          return;
        }
        elements.set(
          page.id,
          (await readJSON<SyncedElement[]>(this.pageFile(paperId, page.id))) ??
            [],
        );
      }),
    );
    return { pages, elements };
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
      JSON.stringify(elements),
    );
  }

  async deletePageElements(paperId: string, pageId: string) {
    await fs.rm(this.pageFile(paperId, pageId), { force: true });
  }

  async deletePaper(paperId: string) {
    await fs.rm(this.paperDir(paperId), { recursive: true, force: true });
  }

  async duplicatePaper(sourceId: string, targetId: string) {
    const source = this.paperDir(sourceId);
    if (existsSync(source)) {
      await fs.cp(source, this.paperDir(targetId), { recursive: true });
    }
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
