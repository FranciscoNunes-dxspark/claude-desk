// Terminal fonts. Cascadia Mono is bundled in full (src/fonts, see style.css); the
// others come from Fontsource with their Latin characters only, to keep the app
// small. Anything a font lacks (symbols such as ○ ● ❯ ✓) falls back to the full
// Cascadia Mono, which has them at the right width, before any system font.
import "./fonts.css";

export interface FontChoice {
  /** CSS font-family name. */
  name: string;
  /** Weight used for bold text. */
  bold: "600" | "700";
}

export const DEFAULT_FONT = "Cascadia Mono";

export const BUNDLED_FONTS: FontChoice[] = [
  { name: "Cascadia Mono", bold: "600" },
  { name: "JetBrains Mono", bold: "600" },
  { name: "Fira Code", bold: "600" },
  { name: "Geist Mono", bold: "600" },
  { name: "IBM Plex Mono", bold: "600" },
  { name: "Source Code Pro", bold: "600" },
  { name: "Iosevka", bold: "600" },
  { name: "Commit Mono", bold: "600" },
  { name: "Monaspace Neon", bold: "600" },
  { name: "Victor Mono", bold: "600" },
  { name: "Maple Mono", bold: "600" },
  { name: "Roboto Mono", bold: "600" },
  { name: "Ubuntu Mono", bold: "700" },
];

/** Value of `settings.font` meaning "a font installed on this computer". */
export const CUSTOM_FONT = "custom";

const quote = (f: string) => `"${f.replace(/["\\]/g, "")}"`;

/** The CSS font stack for a family: it, then full Cascadia Mono for missing symbols. */
export function fontStack(family: string): string {
  const fallback = family === DEFAULT_FONT ? [] : [quote(DEFAULT_FONT)];
  return [quote(family), ...fallback, "ui-monospace", "Menlo", "Consolas", "monospace"].join(", ");
}

export function boldWeight(family: string): "600" | "700" | "bold" {
  return BUNDLED_FONTS.find((f) => f.name === family)?.bold ?? "bold";
}

/**
 * Whether `family` is available (bundled or installed): text set in it must measure
 * differently from at least one generic fallback. (Not all: the font may itself be
 * what one of the generics maps to, e.g. DejaVu Sans Mono for "monospace" on Linux.) Custom fonts can't be listed by a web page,
 * so this is how the settings tell you a name doesn't match an installed font.
 */
export function fontAvailable(family: string): boolean {
  if (BUNDLED_FONTS.some((f) => f.name === family)) return true;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx || !family.trim()) return false;
  const sample = "mmmmmmmmmmlli10OO@#";
  return ["monospace", "serif", "sans-serif"].some((generic) => {
    ctx.font = `32px ${generic}`;
    const base = ctx.measureText(sample).width;
    ctx.font = `32px ${quote(family)}, ${generic}`;
    return ctx.measureText(sample).width !== base;
  });
}
