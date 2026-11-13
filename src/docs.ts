// Helpers for the documents panel: what a session's conversation produced (plans,
// markdown files, published artifacts; see src-tauri/src/docs.rs).
import { marked } from "marked";
import DOMPurify from "dompurify";

export interface Doc {
  kind: "plan" | "markdown" | "artifact";
  path: string | null;
  url: string | null;
  title: string | null;
  description: string | null;
  /** A plan presented without a file. */
  text: string | null;
  at: string | null;
  writes: number;
}

/** One item of Claude's to-do list (see src-tauri/src/docs.rs). */
export interface Todo {
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed" | string;
  activeForm: string | null;
}

/** "3/7", and what Claude is doing now, for a to-do list; null when there's none. */
export function todoSummary(todos: Todo[]): { done: number; total: number; now: string | null } | null {
  if (!todos.length) return null;
  const done = todos.filter((t) => t.status === "completed").length;
  const cur = todos.find((t) => t.status === "in_progress");
  return { done, total: todos.length, now: cur ? cur.activeForm || cur.subject : null };
}

/** Identifies a document across refreshes and conversations. */
export const docKey = (d: Doc) => d.url ?? `${d.kind}:${d.path ?? ""}`;

const basename = (p: string) => p.split(/[\\/]/).pop() || p;

/** Titles read from artifacts' pages and plans' headings, keyed by path, to label them in the list. */
export const pageTitles = new Map<string, string>();

export function docName(d: Doc): string {
  if (d.kind === "artifact") return d.title || (d.path && pageTitles.get(d.path)) || (d.path ? basename(d.path).replace(/\.html?$/i, "") : "Artifact");
  if (d.kind === "plan") return (d.path && pageTitles.get(d.path)) || firstHeading(d.text ?? "") || "Plan";
  return d.path ? basename(d.path) : "Document";
}

/** The line under a document's name: where it is, or what it is. */
export function docDetail(d: Doc, cwd: string): string {
  if (d.kind === "artifact") return d.description || "Artifact on claude.ai";
  if (!d.path) return "Presented in plan mode";
  if (d.kind === "plan") return basename(d.path).replace(/\.md$/i, "");
  const sep = cwd.includes("\\") ? "\\" : "/";
  const root = cwd.replace(/[\\/]+$/, "") + sep;
  const rel = d.path.startsWith(root) ? d.path.slice(root.length) : d.path;
  const dir = rel.slice(0, Math.max(0, rel.length - basename(rel).length - 1));
  return dir || "Project folder";
}

/** A markdown document's first heading, which names a plan better than its file. */
export function firstHeading(md: string): string | null {
  const m = /^#{1,2}\s+(.{1,120}?)\s*#*\s*$/m.exec(md);
  return m ? m[1].replace(/[*_`]/g, "") : null;
}

/** Markdown as sanitized HTML: Claude wrote it, but it may quote anything. */
export function renderMarkdown(src: string): string {
  const html = marked.parse(src, { gfm: true, breaks: false, async: false }) as string;
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ["style", "form", "button", "textarea", "select", "iframe", "object", "embed"],
    FORBID_ATTR: ["style"],
  });
}

/** The page's own `<title>`, if it has one. */
export function pageTitle(html: string): string | null {
  const m = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html);
  if (!m) return null;
  const t = new DOMParser().parseFromString(m[1], "text/html").documentElement.textContent?.trim();
  return t || null;
}

/** Whether a page uses claude.ai's runtime (saving data, the viewer, connectors), which
 *  a local preview doesn't have. */
export const needsClaudeRuntime = (html: string) => /claude\s*\.\s*use\s*\(|window\.claude\b/.test(html);

/** The address of an artifact's preview, served by the app's `swpreview` scheme. */
export function previewUrl(path: string, windows: boolean): string {
  const hex = [...new TextEncoder().encode(path)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${windows ? "http://swpreview.localhost/" : "swpreview://localhost/"}${hex}`;
}

/** Only claude.ai's own artifact links are opened from the panel. */
export const isArtifactUrl = (u: string) => /^https:\/\/claude\.ai\/(code\/)?artifact\/[\w-]+$/.test(u);
