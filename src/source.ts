import hljs from "highlight.js/lib/common";
import { escapeHtml } from "./util";

/// Rendering of file contents: highlighted where the language is known, with a
/// line-number gutter that stays put when the code scrolls sideways.

/// Beyond this the highlighter costs more than the colour is worth.
const MAX_HIGHLIGHT_BYTES = 400_000;

/// Extensions whose highlight.js language name is not simply the extension.
const LANGUAGE_BY_EXT: Record<string, string> = {
  cc: "cpp",
  cxx: "cpp",
  h: "cpp",
  hpp: "cpp",
  htm: "xml",
  html: "xml",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  mts: "typescript",
  tsx: "typescript",
  markdown: "markdown",
  md: "markdown",
  rs: "rust",
  py: "python",
  rb: "ruby",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  toml: "ini",
  cfg: "ini",
  svg: "xml",
};

/// Files without a useful extension that are still worth colouring.
const LANGUAGE_BY_NAME: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  ".gitignore": "bash",
  ".gitattributes": "bash",
};

function languageFor(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const byName = LANGUAGE_BY_NAME[name.toLowerCase()];
  if (byName) return byName;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  const lang = LANGUAGE_BY_EXT[ext] ?? ext;
  return hljs.getLanguage(lang) ? lang : null;
}

function highlight(text: string, path: string): string {
  if (text.length > MAX_HIGHLIGHT_BYTES) return escapeHtml(text);
  const language = languageFor(path);
  if (!language) return escapeHtml(text);
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    // A grammar that chokes on the file is not worth failing the view over.
    return escapeHtml(text);
  }
}

export function sourceHtml(text: string, path: string): string {
  // A trailing newline would otherwise show as an extra empty line.
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines = body.split("\n");
  const gutter = lines.map((_, i) => i + 1).join("\n");
  return (
    `<div class="source">` +
    `<pre class="gutter" aria-hidden="true">${gutter}</pre>` +
    `<pre class="code"><code class="hljs">${highlight(body, path)}</code></pre>` +
    `</div>`
  );
}
