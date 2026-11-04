import { useCallback, useEffect, useState } from "react";

const THEME_KEY = "whiteboard-theme";
const LANG_KEY = "whiteboard-lang";

export type ThemePreference = "light" | "dark" | "system";

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode etc.
  }
};

const systemDark = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-color-scheme: dark)").matches;

export const resolveTheme = (preference: ThemePreference) =>
  preference === "system" ? (systemDark() ? "dark" : "light") : preference;

/** app-wide theme, shared between the dashboard and the editor */
export const useTheme = () => {
  const [preference, setPreference] = useState<ThemePreference>(() => {
    const stored = read(THEME_KEY);
    return stored === "light" || stored === "dark" || stored === "system"
      ? stored
      : "system";
  });
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    resolveTheme(preference),
  );

  useEffect(() => {
    const update = () => setTheme(resolveTheme(preference));
    update();
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    query?.addEventListener("change", update);
    return () => query?.removeEventListener("change", update);
  }, [preference]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  const set = useCallback((next: ThemePreference) => {
    write(THEME_KEY, next);
    setPreference(next);
  }, []);

  return { theme, preference, setPreference: set };
};

export const useLangCode = () => {
  const [langCode, setLangCode] = useState(() => read(LANG_KEY) || "en");
  const set = useCallback((code: string) => {
    write(LANG_KEY, code);
    setLangCode(code);
  }, []);
  return [langCode, set] as const;
};
