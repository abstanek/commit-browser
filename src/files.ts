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
  rev: string | null;
  /// Directory listings already fetched, keyed by path ("" is the root).
  listings: Map<string, TreeEntry[]>;
  expanded: Set<string>;
  selected: string | null;
  content: FileContent | null;
}

const fs: FilesState = {
  rev: null,
  listings: new Map(),
  expanded: new Set(),
  selected: null,
  content: null,
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

async function loadDir(path: string): Promise<void> {
  if (!fs.rev || fs.listings.has(path)) return;
  try {
    const result = await backend.listTree(fs.rev, path);
    fs.listings.set(path, result.entries);
  } catch (e) {
    toast(`Could not read ${path || "the repository root"}: ${e}`);
  }
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

  const url = c && fs.rev ? backend.rawUrl(fs.rev, c.path) : null;
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
    el.view.innerHTML = `<div class="detail-empty">Select a file.</div>`;
    return;
  }
  if (c.binary) {
    el.view.innerHTML =
      `<div class="detail-empty">Binary file, ${formatSize(c.size)}.` +
      (backend.rawUrl(fs.rev!, c.path) ? " Use Download to fetch it." : "") +
      `</div>`;
    return;
  }
  el.view.innerHTML = sourceHtml(c.text, c.path);
}

async function openFile(path: string): Promise<void> {
  if (!fs.rev) return;
  fs.selected = path;
  for (const node of el.tree.querySelectorAll<HTMLElement>(".tree-file")) {
    node.classList.toggle("selected", node.dataset.file === path);
  }
  try {
    fs.content = await backend.readFile(fs.rev, path);
  } catch (e) {
    toast(`Could not read ${path}: ${e}`);
    fs.content = null;
  }
  renderHeader();
  renderContent();
}

// --------------------------------------------------------------------- state

/// Browse `rev`, keeping the open file if it still exists there.
export async function load(rev: string, label: string): Promise<void> {
  const sameRev = fs.rev === rev;
  fs.rev = rev;
  el.rev.textContent = label;
  fs.listings.clear();
  await loadDir("");
  // Re-fetch the directories that were open, so the tree keeps its shape.
  for (const path of [...fs.expanded].sort()) await loadDir(path);
  renderTree();

  if (sameRev && fs.selected) {
    await openFile(fs.selected);
  } else {
    fs.selected = null;
    fs.content = null;
    renderHeader();
    renderContent();
  }
}

export function clear(why: string): void {
  fs.rev = null;
  fs.listings.clear();
  fs.selected = null;
  fs.content = null;
  el.rev.textContent = "";
  el.tree.innerHTML = `<div class="detail-empty">${escapeHtml(why)}</div>`;
  renderHeader();
  renderContent();
}

export function setVisible(visible: boolean): void {
  el.root.hidden = !visible;
}

export function wire(): void {
  el.tree.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    const file = target.closest<HTMLElement>(".tree-file");
    if (file?.dataset.file) {
      void openFile(file.dataset.file);
      return;
    }
    const dir = target.closest<HTMLElement>(".tree-dir");
    if (dir?.dataset.dir) void toggleDir(dir.dataset.dir);
  });
}
