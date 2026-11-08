"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

type Theme = "light" | "dark";
interface AppearanceContextValue {
  theme: Theme;
  toggleTheme: () => void;
}

const STORAGE_KEY = "outlist-appearance-v1";
const AppearanceContext = createContext<AppearanceContextValue | null>(null);

function readTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function DirectoryProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    // Appearance is the only public UI preference persisted in this browser.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(readTheme());
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Appearance still works for this session when storage is unavailable.
    }
  }, [theme]);

  const value = useMemo<AppearanceContextValue>(() => ({
    theme,
    toggleTheme: () => setTheme((current) => current === "light" ? "dark" : "light"),
  }), [theme]);

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useDirectory(): AppearanceContextValue {
  const context = useContext(AppearanceContext);
  if (!context) throw new Error("useDirectory must be used within DirectoryProvider");
  return context;
}
