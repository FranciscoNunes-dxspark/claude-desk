import type { ITheme } from "@xterm/xterm";

export type ThemeName = "dark" | "light";

export const TERMINAL_THEMES: Record<ThemeName, ITheme> = {
  dark: {
    background: "#12151a",
    foreground: "#e8e4da",
    cursor: "#f2b13c",
    cursorAccent: "#12151a",
    selectionBackground: "#6fa8dc45",
    black: "#1f242c",
    red: "#e5736a",
    green: "#8fbf7f",
    yellow: "#e0b86b",
    blue: "#7aa6da",
    magenta: "#c397d8",
    cyan: "#70c0b1",
    white: "#d8d6cc",
    brightBlack: "#6b707a",
    brightRed: "#f08a80",
    brightGreen: "#a6d394",
    brightYellow: "#f0cb82",
    brightBlue: "#94bbe8",
    brightMagenta: "#d4ade6",
    brightCyan: "#8ad4c6",
    brightWhite: "#f7f4ec",
  },
  light: {
    background: "#faf8f3",
    foreground: "#1b2028",
    cursor: "#b86f06",
    cursorAccent: "#faf8f3",
    selectionBackground: "#2f6db033",
    black: "#1b2028",
    red: "#c4463d",
    green: "#3f7d38",
    yellow: "#94690f",
    blue: "#2f62a8",
    magenta: "#8a4aa8",
    cyan: "#1d7a72",
    white: "#c9c6bc",
    brightBlack: "#6c717b",
    brightRed: "#d65a4f",
    brightGreen: "#4c9444",
    brightYellow: "#a87a17",
    brightBlue: "#3b74c2",
    brightMagenta: "#9c5ab9",
    brightCyan: "#258c83",
    brightWhite: "#ffffff",
  },
};

/** Highlight colours for scrollback search (xterm needs opaque #RRGGBB here). */
export const SEARCH_DECORATIONS: Record<ThemeName, {
  matchBackground: string;
  matchBorder: string;
  matchOverviewRuler: string;
  activeMatchBackground: string;
  activeMatchBorder: string;
  activeMatchColorOverviewRuler: string;
}> = {
  dark: {
    matchBackground: "#4a3a1c",
    matchBorder: "#6b5226",
    matchOverviewRuler: "#b88a35",
    activeMatchBackground: "#8f6a1e",
    activeMatchBorder: "#f2b13c",
    activeMatchColorOverviewRuler: "#f2b13c",
  },
  light: {
    matchBackground: "#f6e7c8",
    matchBorder: "#ebd3a0",
    matchOverviewRuler: "#d9a54a",
    activeMatchBackground: "#efc77a",
    activeMatchBorder: "#b86f06",
    activeMatchColorOverviewRuler: "#b86f06",
  },
};
