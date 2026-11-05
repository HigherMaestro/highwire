"use client";

import { useEffect, useState } from "react";
import { THEME_KEY } from "../lib/theme.ts";

type Theme = "system" | "light" | "dark";

const ORDER: Theme[] = ["system", "light", "dark"];
const LABEL: Record<Theme, string> = { system: "Auto", light: "Light", dark: "Dark" };

function apply(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
}

function read(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => setTheme(read()), []);

  function next() {
    const t = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]!;
    setTheme(t);
    apply(t);
    try {
      if (t === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, t);
    } catch {
      // Private mode or blocked storage: the choice just won't persist.
    }
  }

  const upcoming = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]!;
  return (
    <button type="button" className="theme-toggle" onClick={next} aria-label={`Theme: ${LABEL[theme]}. Switch to ${LABEL[upcoming]}`}>
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
        <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
        {theme === "light" ? null : <path d="M10 2.5 A7.5 7.5 0 0 1 10 17.5 Z" fill="currentColor" />}
        {theme === "dark" ? <circle cx="10" cy="10" r="7.5" fill="currentColor" /> : null}
      </svg>
      <span>{LABEL[theme]}</span>
    </button>
  );
}
