import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import { ApiError, api, setUnauthorizedHandler } from "./api";
import { AuthContext } from "./auth";
import { Spinner } from "./components/ui";
import { AdminUsers } from "./pages/AdminUsers";
import { Dashboard } from "./pages/Dashboard";
import { LoginPage } from "./pages/LoginPage";
import { navigate, usePathname } from "./router";

import type { AuthContextValue } from "./auth";
import type { PublicUser } from "../../whiteboard-server/src/protocol";

// the editor (Excalidraw) is big — load it only when a paper is opened
const loadEditor = () => import("./editor/PaperEditor");
const PaperEditor = lazy(() =>
  loadEditor().then((module) => ({ default: module.PaperEditor })),
);
const EmbedPage = lazy(() => import("./editor/EmbedPage"));

type AuthState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "authenticated"; user: PublicUser };

export const App = () => {
  const pathname = usePathname();
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const [appName, setAppName] = useState("Extracalidraw");

  useEffect(() => {
    api
      .config()
      .then(({ appName }) => setAppName(appName))
      .catch(() => {});
    api
      .me()
      .then(({ user }) =>
        setAuth(
          user ? { status: "authenticated", user } : { status: "anonymous" },
        ),
      )
      .catch((error) => {
        if (!(error instanceof ApiError) || error.status !== 401) {
          console.error(error);
        }
        setAuth({ status: "anonymous" });
      });
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setAuth({ status: "anonymous" }));
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    document.title = appName;
  }, [appName]);

  // warm up the editor bundle once the user is logged in
  useEffect(() => {
    if (auth.status === "authenticated") {
      const id = window.setTimeout(() => {
        loadEditor().catch(() => {});
      }, 1500);
      return () => window.clearTimeout(id);
    }
  }, [auth.status]);

  const logout = useCallback(async () => {
    await api.logout().catch(() => {});
    setAuth({ status: "anonymous" });
    navigate("/", { replace: true });
  }, []);

  const contextValue = useMemo<AuthContextValue | null>(
    () =>
      auth.status === "authenticated"
        ? {
            user: auth.user,
            appName,
            logout,
            setUser: (user) => setAuth({ status: "authenticated", user }),
          }
        : null,
    [auth, appName, logout],
  );

  // embeds (/embed/<paperId>#token=…) work without an account
  const embedMatch = pathname.match(/^\/embed\/([A-Za-z0-9_-]+)\/?$/);
  if (embedMatch) {
    return (
      <Suspense fallback={<Spinner />}>
        <EmbedPage paperId={embedMatch[1]} />
      </Suspense>
    );
  }

  if (auth.status === "loading") {
    return <Spinner />;
  }

  if (auth.status === "anonymous" || !contextValue) {
    return (
      <LoginPage
        appName={appName}
        onLogin={(user) => setAuth({ status: "authenticated", user })}
      />
    );
  }

  const paperMatch = pathname.match(/^\/p\/([A-Za-z0-9_-]+)\/?$/);

  let page;
  if (paperMatch) {
    page = (
      <Suspense fallback={<Spinner label="Opening paper…" />}>
        <PaperEditor
          key={paperMatch[1]}
          paperId={paperMatch[1]}
          appName={appName}
        />
      </Suspense>
    );
  } else if (pathname.startsWith("/admin/users")) {
    page = contextValue.user.role === "admin" ? <AdminUsers /> : <Dashboard />;
  } else {
    page = <Dashboard />;
  }

  return (
    <AuthContext.Provider value={contextValue}>{page}</AuthContext.Provider>
  );
};
