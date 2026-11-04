import type {
  PaperSummary,
  PublicUser,
  Role,
} from "../../whiteboard-server/src/protocol";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;

const shareHeaders = (shareToken?: string | null): Record<string, string> =>
  shareToken ? { "X-Share-Token": shareToken } : {};

/** called whenever the server says the session is gone */
export const setUnauthorizedHandler = (handler: (() => void) | null) => {
  onUnauthorized = handler;
};

const request = async <T>(
  method: string,
  url: string,
  body?: unknown,
): Promise<T> => {
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    headers:
      body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !url.startsWith("/api/auth/")) {
      onUnauthorized?.();
    }
    throw new ApiError(
      response.status,
      data?.error || `Request failed (${response.status})`,
    );
  }
  return data as T;
};

export const api = {
  config: () => request<{ appName: string }>("GET", "/api/config"),

  // auth
  me: () => request<{ user: PublicUser | null }>("GET", "/api/auth/me"),
  login: (username: string, password: string) =>
    request<{ user: PublicUser }>("POST", "/api/auth/login", {
      username,
      password,
    }),
  logout: () => request("POST", "/api/auth/logout", {}),
  changePassword: (currentPassword: string, newPassword: string) =>
    request("POST", "/api/auth/password", { currentPassword, newPassword }),

  // users
  listUsers: () => request<{ users: PublicUser[] }>("GET", "/api/users"),
  createUser: (input: {
    username: string;
    displayName: string;
    password: string;
    role: Role;
  }) => request<{ user: PublicUser }>("POST", "/api/users", input),
  updateUser: (
    id: string,
    updates: Partial<{
      displayName: string;
      password: string;
      role: Role;
      disabled: boolean;
    }>,
  ) => request<{ user: PublicUser }>("PATCH", `/api/users/${id}`, updates),
  deleteUser: (id: string) => request("DELETE", `/api/users/${id}`),

  // papers
  listPapers: () => request<{ papers: PaperSummary[] }>("GET", "/api/papers"),
  createPaper: (input: { title: string; memberIds: string[] }) =>
    request<{ paper: PaperSummary }>("POST", "/api/papers", input),
  updatePaper: (
    id: string,
    updates: Partial<{ title: string; memberIds: string[]; locked: boolean }>,
  ) => request<{ paper: PaperSummary }>("PATCH", `/api/papers/${id}`, updates),
  deletePaper: (id: string) => request("DELETE", `/api/papers/${id}`),
  duplicatePaper: (id: string, title?: string) =>
    request<{ paper: PaperSummary }>("POST", `/api/papers/${id}/duplicate`, {
      title,
    }),

  /** turns the public link / embed of a paper on or off */
  sharePaper: (
    id: string,
    options: {
      enabled: boolean;
      access?: "view" | "edit";
      regenerate?: boolean;
    },
  ) =>
    request<{ paper: PaperSummary }>(
      "POST",
      `/api/papers/${id}/share`,
      options,
    ),

  getPaper: (id: string) =>
    request<{ paper: PaperSummary }>("GET", `/api/papers/${id}`),

  /** checks a public link before joining */
  paperPublicInfo: async (paperId: string, shareToken: string | null) => {
    const response = await fetch(`/api/papers/${paperId}/public`, {
      credentials: "same-origin",
      headers: shareHeaders(shareToken),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new ApiError(response.status, data?.error || "Not available");
    }
    return data as {
      title: string;
      appName: string;
      signedIn: boolean;
      canEdit: boolean;
    };
  },

  thumbnailUrl: (paper: PaperSummary) =>
    paper.thumbnailVersion
      ? `/api/papers/${paper.id}/thumbnail?v=${paper.thumbnailVersion}`
      : null,

  uploadThumbnail: async (paperId: string, blob: Blob) => {
    await fetch(`/api/papers/${paperId}/thumbnail`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "image/png" },
      body: blob,
    });
  },

  uploadFile: async (
    paperId: string,
    fileId: string,
    blob: Blob,
    shareToken?: string | null,
  ) => {
    const response = await fetch(
      `/api/papers/${paperId}/files/${encodeURIComponent(fileId)}`,
      {
        method: "PUT",
        credentials: "same-origin",
        headers: {
          "Content-Type": blob.type || "application/octet-stream",
          ...shareHeaders(shareToken),
        },
        body: blob,
      },
    );
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new ApiError(response.status, data?.error || "Upload failed");
    }
  },

  /** resolves `null` when the file doesn't exist (yet) */
  fetchFile: async (
    paperId: string,
    fileId: string,
    shareToken?: string | null,
  ) => {
    const response = await fetch(
      `/api/papers/${paperId}/files/${encodeURIComponent(fileId)}`,
      { credentials: "same-origin", headers: shareHeaders(shareToken) },
    );
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new ApiError(response.status, "Failed to load image");
    }
    return response.blob();
  },
};
