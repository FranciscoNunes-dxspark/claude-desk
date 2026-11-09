import type { ITheme } from "@xterm/xterm";

export type ThemeName = "dark" | "light";

export const TERMINAL_THEMES: Record<ThemeName, ITheme> = {
  dark: {
    background: "#141413",
    foreground: "#e8e6dc",
    cursor: "#d97757",
    cursorAccent: "#141413",
    selectionBackground: "#d9775750",
    black: "#262624",
    red: "#e5736a",
    green: "#8fbf7f",
    yellow: "#e0b86b",
    blue: "#7aa6da",
    magenta: "#c397d8",
    cyan: "#70c0b1",
    white: "#d8d6cc",
    brightBlack: "#6b6a65",
    brightRed: "#f08a80",
    brightGreen: "#a6d394",
    brightYellow: "#f0cb82",
    brightBlue: "#94bbe8",
    brightMagenta: "#d4ade6",
    brightCyan: "#8ad4c6",
    brightWhite: "#faf9f5",
  },
  light: {
    background: "#faf9f5",
    foreground: "#1f1e1d",
    cursor: "#c6613f",
    cursorAccent: "#faf9f5",
    selectionBackground: "#c6613f40",
    black: "#1f1e1d",
    red: "#c4463d",
    green: "#3f7d38",
    yellow: "#94690f",
    blue: "#2f62a8",
    magenta: "#8a4aa8",
    cyan: "#1d7a72",
    white: "#c9c6bc",
    brightBlack: "#6f6d66",
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
    matchBackground: "#4a3128",
    matchBorder: "#6b4232",
    matchOverviewRuler: "#a65c40",
    activeMatchBackground: "#b8603f",
    activeMatchBorder: "#e58b6d",
    activeMatchColorOverviewRuler: "#e58b6d",
  },
  light: {
    matchBackground: "#f5dccf",
    matchBorder: "#ebc1ad",
    matchOverviewRuler: "#d99a7f",
    activeMatchBackground: "#eba47f",
    activeMatchBorder: "#c6613f",
    activeMatchColorOverviewRuler: "#c6613f",
  },
};
