"use client";

import { useEffect, useState } from "react";
import { THEME_KEY } from "../lib/theme.ts";

// Ink is the site's default; paper is the visitor's choice, kept in localStorage.
type Theme = "dark" | "light";

const ORDER: Theme[] = ["dark", "light"];
const LABEL: Record<Theme, string> = { dark: "Dark", light: "Light" };

function apply(theme: Theme) {
  const root = document.documentElement;
  if (theme === "dark") delete root.dataset.theme;
  else root.dataset.theme = theme;
}

function read(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => setTheme(read()), []);

  function next() {
    const t = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]!;
    setTheme(t);
    apply(t);
    try {
      if (t === "dark") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, t);
    } catch {
      // Private mode or blocked storage: the choice just won't persist.
    }
  }

  const upcoming = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]!;
  return (
    <button type="button" className="theme-toggle" onClick={next} aria-label={`Theme: ${LABEL[theme]}. Switch to ${LABEL[upcoming]}`} title={`Switch to ${LABEL[upcoming].toLowerCase()}`}>
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
        <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
        {theme === "dark" ? <circle cx="10" cy="10" r="7.5" fill="currentColor" /> : null}
      </svg>
      <span className="sr-only">{LABEL[theme]}</span>
    </button>
  );
}
