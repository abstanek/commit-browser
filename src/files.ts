import { backend } from "@backend";
import type { FileContent, TreeEntry } from "./api";
import { sourceHtml } from "./source";
import { $, escapeHtml, toast } from "./util";

/// File browser: the repository as it stands at one revision, with a lazily
/// expanded directory tree on the left and the selected file on the right.

/// Kinds worth calling out; plain files need no label.
const KIND_LABEL: Record<string, string> = {
  symlink: "symlink",
  submodule: "submodule",
};

interface FilesState {
  /// Repository being browsed, by the path shown for it.
  repo: string | null;
  rev: string | null;
  /// Directory listings already fetched, keyed by path ("" is the root).
  listings: Map<string, TreeEntry[]>;
  expanded: Set<string>;
  /// The open file, kept across revisions so switching branch shows the same
  /// file where it exists.
  selected: string | null;
  content: FileContent | null;
  /// Why the open file has no content at this revision, if it has none.
  missing: string | null;
}

const fs: FilesState = {
  repo: null,
  rev: null,
  listings: new Map(),
  expanded: new Set(),
  selected: null,
  content: null,
  missing: null,
};

const el = {
  root: $("files"),
  rev: $("files-rev"),
  path: $("files-path"),
  download: $<HTMLAnchorElement>("files-download"),
  tree: $("files-tree"),
  view: $("files-view"),
};

// ---------------------------------------------------------------------- tree

function rowHtml(entry: TreeEntry, depth: number): string {
  const pad = `style="padding-left:${6 + depth * 13}px"`;
  if (entry.kind === "dir") {
    const open = fs.expanded.has(entry.path);
    return (
      `<div class="tree-dir" data-dir="${escapeHtml(entry.path)}" ${pad}>` +
      `<span class="disclosure">${open ? "▾" : "▸"}</span>` +
      `<span class="tree-name">${escapeHtml(entry.name)}</span></div>`
    );
  }
  const selected = entry.path === fs.selected ? " selected" : "";
  const label = KIND_LABEL[entry.kind];
  return (
    `<div class="tree-file${selected}" data-file="${escapeHtml(entry.path)}" ${pad} ` +
    `title="${escapeHtml(entry.path)}">` +
    `<span class="file-name">${escapeHtml(entry.name)}</span>` +
    (label ? `<span class="kind-tag">${label}</span>` : "") +
    `<span class="filestat">${formatSize(entry.size)}</span></div>`
  );
}

function levelHtml(path: string, depth: number): string {
  const entries = fs.listings.get(path);
  if (!entries) return "";
  return entries
    .map((entry) => {
      const row = rowHtml(entry, depth);
      const children =
        entry.kind === "dir" && fs.expanded.has(entry.path)
          ? levelHtml(entry.path, depth + 1)
          : "";
      return row + children;
    })
    .join("");
}

function renderTree(): void {
  el.tree.innerHTML = fs.listings.has("")
    ? levelHtml("", 0)
    : `<div class="detail-empty">Pick a branch to browse.</div>`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} M`;
}

async function loadDir(path: string, quiet = false): Promise<void> {
  if (!fs.repo || !fs.rev || fs.listings.has(path)) return;
  try {
    const result = await backend.listTree(fs.repo, fs.rev, path);
    fs.listings.set(path, result.entries);
  } catch (e) {
    // A directory that another revision had is not an error worth reporting.
    if (!quiet) toast(`Could not read ${path || "the repository root"}: ${e}`);
  }
}

/// Whether the loaded listings show `path` as a file at this revision.
function isKnownFile(path: string): boolean {
  const cut = path.lastIndexOf("/");
  const parent = cut === -1 ? "" : path.slice(0, cut);
  return (fs.listings.get(parent) ?? []).some((e) => e.path === path && e.kind !== "dir");
}

async function toggleDir(path: string): Promise<void> {
  if (fs.expanded.has(path)) {
    fs.expanded.delete(path);
  } else {
    fs.expanded.add(path);
    await loadDir(path);
  }
  renderTree();
}

// ------------------------------------------------------------------ contents

function renderHeader(): void {
  const c = fs.content;
  el.path.innerHTML = c
    ? `<span class="files-crumbs">${crumbsHtml(c.path)}</span>` +
      `<span class="review-stat dim">${formatSize(c.size)}</span>` +
      (c.truncated ? `<span class="review-stat warn">shown truncated</span>` : "")
    : "";

  const url = c && fs.repo && fs.rev ? backend.rawUrl(fs.repo, fs.rev, c.path) : null;
  el.download.hidden = !url;
  if (url) {
    el.download.href = url;
    el.download.setAttribute("download", c!.path.slice(c!.path.lastIndexOf("/") + 1));
  }
}

function crumbsHtml(path: string): string {
  return path
    .split("/")
    .map((part) => escapeHtml(part))
    .join('<span class="crumb-sep">/</span>');
}

function renderContent(): void {
  const c = fs.content;
  if (!c) {
    const why = fs.missing ?? "Select a file.";
    el.view.innerHTML = `<div class="detail-empty">${escapeHtml(why)}</div>`;
    return;
  }
  if (c.binary) {
    el.view.innerHTML =
      `<div class="detail-empty">Binary file, ${formatSize(c.size)}.` +
      (backend.rawUrl(fs.repo!, fs.rev!, c.path) ? " Use Download to fetch it." : "") +
      `</div>`;
    return;
  }
  el.view.innerHTML = sourceHtml(c.text, c.path);
}

async function openFile(path: string): Promise<void> {
  if (!fs.repo || !fs.rev) return;
  fs.selected = path;
  for (const node of el.tree.querySelectorAll<HTMLElement>(".tree-file")) {
    node.classList.toggle("selected", node.dataset.file === path);
  }
  el.tree.querySelector(".tree-file.selected")?.scrollIntoView({ block: "nearest" });
  try {
    fs.content = await backend.readFile(fs.repo, fs.rev, path);
    fs.missing = null;
  } catch (e) {
    toast(`Could not read ${path}: ${e}`);
    fs.content = null;
  }
  renderHeader();
  renderContent();
}

// --------------------------------------------------------------------- state

/// Every directory above `path`, outermost first.
function ancestors(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/// Browse `rev`, which may be a branch or any commit. The open file is carried
/// over: switching branch shows the same file there, and `openPath` opens one
/// chosen elsewhere, expanding the tree down to it.
export async function load(
  repo: string,
  rev: string,
  label: string,
  atCommit: boolean,
  openPath?: string,
): Promise<void> {
  fs.repo = repo;
  fs.rev = rev;
  el.rev.className = atCommit ? "chip detached" : "chip local";
  el.rev.textContent = atCommit ? `commit ${label}` : label;

  const target = openPath ?? fs.selected;
  if (target) for (const dir of ancestors(target)) fs.expanded.add(dir);

  fs.listings.clear();
  await loadDir("");
  // Re-fetch the directories that were open, so the tree keeps its shape.
  // Quietly: this revision need not have all of them.
  for (const path of [...fs.expanded].sort()) await loadDir(path, true);
  renderTree();

  if (target && isKnownFile(target)) {
    await openFile(target);
  } else if (target) {
    // Keep it selected, so returning to a revision that has it opens it again.
    fs.selected = target;
    fs.content = null;
    fs.missing = `${target} is not in this revision.`;
    renderHeader();
    renderContent();
  } else {
    fs.content = null;
    fs.missing = null;
    renderHeader();
    renderContent();
  }
}

export function clear(why: string): void {
  fs.repo = null;
  fs.rev = null;
  fs.listings.clear();
  fs.selected = null;
  fs.content = null;
  fs.missing = null;
  el.rev.className = "chip local";
  el.rev.textContent = "";
  el.tree.innerHTML = `<div class="detail-empty">${escapeHtml(why)}</div>`;
  renderHeader();
  renderContent();
}

export function setVisible(visible: boolean): void {
  el.root.hidden = !visible;
}

/// The file on screen, for recording the position.
export function openPath(): string | null {
  return fs.selected;
}

/// Fires when the reader opens a different file, which loading does not count
/// as: that position was already recorded by whoever asked for the load.
export function onNavigate(cb: () => void): void {
  navigated = cb;
}

let navigated: () => void = () => {};

export function wire(): void {
  el.tree.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    const file = target.closest<HTMLElement>(".tree-file");
    if (file?.dataset.file) {
      void openFile(file.dataset.file).then(navigated);
      return;
    }
    const dir = target.closest<HTMLElement>(".tree-dir");
    if (dir?.dataset.dir) void toggleDir(dir.dataset.dir);
  });
}
