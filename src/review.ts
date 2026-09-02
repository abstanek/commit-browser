import { backend } from "@backend";
import type { FileDiff, ReviewResult } from "./api";
import { statsHtml, STATUS_LETTER } from "./diff";
import { createDiffPane } from "./diffpane";
import { $, escapeHtml, formatDate, shortRef, toast } from "./util";

/// Pull-request style view: the whole of one branch measured against the
/// branch it would merge into, with the option to step through the individual
/// commits that make it up.

const ALL = "all";

interface ReviewState {
  /// Repository this comparison belongs to, for keying stored state.
  repo: string;
  base: string | null;
  head: string | null;
  result: ReviewResult | null;
  /// Commit id whose own diff is shown, or ALL for the whole branch.
  showing: string;
  /// Full message of that commit, once fetched with its diff.
  message: string | null;
  expanded: boolean;
  files: FileDiff[];
  selected: number;
  collapsed: Set<string>;
  /// Shown when there is nothing to diff.
  empty: string;
  /// Indices into files, in the order their rows appear in the tree, skipping
  /// anything inside a collapsed directory. Arrow keys walk this.
  visible: number[];
}

const rs: ReviewState = {
  repo: "",
  base: null,
  head: null,
  result: null,
  showing: ALL,
  message: null,
  expanded: localStorage.getItem("reviewMessageExpanded") === "1",
  files: [],
  selected: 0,
  collapsed: new Set(),
  empty: "Pick a branch to review.",
  visible: [],
};

const el = {
  root: $("review"),
  summary: $("review-summary"),
  nav: $("review-nav"),
  commitSelect: $<HTMLSelectElement>("commit-select"),
  prev: $<HTMLButtonElement>("commit-prev"),
  next: $<HTMLButtonElement>("commit-next"),
  tree: $("review-tree"),
  diff: $("review-diff"),
  message: $("review-message"),
  messageSplitter: $("review-message-splitter"),
};

const pane = createDiffPane(el.diff);
pane.onSelect((index) => {
  rs.selected = index;
  markTree();
});

// ----------------------------------------------------------------- file tree

interface DirNode {
  name: string;
  path: string;
  dirs: Map<string, DirNode>;
  files: { file: FileDiff; index: number }[];
}

function newDir(name: string, path: string): DirNode {
  return { name, path, dirs: new Map(), files: [] };
}

function buildTree(files: FileDiff[]): DirNode {
  const root = newDir("", "");
  files.forEach((file, index) => {
    const parts = file.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const path = node.path ? `${node.path}/${part}` : part;
      let child = node.dirs.get(part);
      if (!child) node.dirs.set(part, (child = newDir(part, path)));
      node = child;
    }
    node.files.push({ file, index });
  });
  collapseChains(root);
  return root;
}

/// Fold a directory that holds nothing but one subdirectory into its child, so
/// deep paths read as "src/backend/api" on a single row.
function collapseChains(node: DirNode): void {
  for (const [key, child] of node.dirs) {
    collapseChains(child);
    if (child.files.length === 0 && child.dirs.size === 1) {
      const [only] = [...child.dirs.values()];
      node.dirs.set(key, { ...only, name: `${child.name}/${only.name}` });
    }
  }
}

type TreeRow =
  | { kind: "dir"; dir: DirNode; depth: number }
  | { kind: "file"; file: FileDiff; index: number; depth: number };

/// One traversal drives both the markup and the arrow-key order, so the two
/// cannot drift apart.
function flatten(node: DirNode, depth: number, out: TreeRow[]): void {
  for (const dir of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    out.push({ kind: "dir", dir, depth });
    if (!rs.collapsed.has(dir.path)) flatten(dir, depth + 1, out);
  }
  for (const { file, index } of node.files) {
    out.push({ kind: "file", file, index, depth });
  }
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/// Orders paths the way flatten() draws them: within a directory, subdirectories
/// come before files, each alphabetically. The diff pane stacks files in this
/// order too, so scrolling through the patches walks the tree top to bottom.
function comparePaths(a: string, b: string): number {
  const x = a.split("/");
  const y = b.split("/");
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    const aDir = i < x.length - 1;
    const bDir = i < y.length - 1;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return x[i].localeCompare(y[i]);
  }
  return x.length - y.length;
}

function inTreeOrder(files: FileDiff[]): FileDiff[] {
  return [...files].sort((a, b) => comparePaths(a.path, b.path));
}

/// Rows carry the file name alone; the directory is already the row above it.
/// A rename only spells out the old name when the name itself changed.
function treeLabel(f: FileDiff): string {
  const name = escapeHtml(baseName(f.path));
  if (!f.old_path) return name;
  const old = baseName(f.old_path);
  return old === baseName(f.path) ? name : `${escapeHtml(old)} → ${name}`;
}

function rowHtml(row: TreeRow): string {
  const pad = `style="padding-left:${6 + row.depth * 13}px"`;
  if (row.kind === "dir") {
    const isCollapsed = rs.collapsed.has(row.dir.path);
    return (
      `<div class="tree-dir" data-path="${escapeHtml(row.dir.path)}" ${pad}>` +
      `<span class="disclosure">${isCollapsed ? "▸" : "▾"}</span>` +
      `<span class="tree-name">${escapeHtml(row.dir.name)}</span></div>`
    );
  }
  const f = row.file;
  const sel = row.index === rs.selected ? " selected" : "";
  return (
    `<div class="tree-file${sel}" data-i="${row.index}" ${pad} ` +
    `title="${escapeHtml(f.old_path ? `${f.old_path} → ${f.path}` : f.path)}">` +
    `<span class="status ${f.status}">${STATUS_LETTER[f.status] ?? "?"}</span>` +
    `<span class="file-name">${treeLabel(f)}</span>${statsHtml(f)}</div>`
  );
}

// -------------------------------------------------------------------- render

function renderSummary(): void {
  const r = rs.result;
  if (!r) {
    el.summary.innerHTML = "";
    return;
  }
  const adds = r.files.reduce((n, f) => n + f.additions, 0);
  const dels = r.files.reduce((n, f) => n + f.deletions, 0);
  const commits = `${r.commits.length}${r.commits_truncated ? "+" : ""} commit${
    r.commits.length === 1 ? "" : "s"
  }`;
  el.summary.innerHTML =
    `<span class="review-refs">` +
    `<span class="chip local">${escapeHtml(shortRef(rs.head!))}</span>` +
    `<span class="arrow">→</span>` +
    `<span class="chip local">${escapeHtml(shortRef(rs.base!))}</span>` +
    `</span>` +
    `<span class="review-stat">${commits}</span>` +
    `<span class="review-stat">${r.files.length} file${r.files.length === 1 ? "" : "s"}</span>` +
    `<span class="review-stat"><span class="filestat add">+${adds}</span>` +
    `<span class="filestat del">−${dels}</span></span>` +
    (r.behind
      ? `<span class="review-stat dim">${r.behind} behind</span>`
      : "") +
    (r.merge_base === null
      ? `<span class="review-stat warn">unrelated histories</span>`
      : "");
}

function renderCommitSelect(): void {
  const r = rs.result;
  if (!r) {
    el.commitSelect.innerHTML = "";
    el.nav.hidden = true;
    return;
  }
  // With one commit there is nothing to step between, and the whole branch and
  // that commit are the same diff, so the picker would offer a choice that
  // makes no difference.
  el.nav.hidden = r.commits.length <= 1;
  // Oldest first, unlike the graph: a branch is reviewed in the order it was
  // written, so stepping forward moves to the newer commit.
  const opts = [
    `<option value="${ALL}">All changes (${r.commits.length} commits)</option>`,
    ...[...r.commits].reverse().map(
      (c) =>
        `<option value="${c.id}">${c.short_id}  ${escapeHtml(c.summary)}</option>`,
    ),
  ];
  el.commitSelect.innerHTML = opts.join("");
  el.commitSelect.value = rs.showing;
  const i = el.commitSelect.selectedIndex;
  el.prev.disabled = i <= 0;
  el.next.disabled = i < 0 || i >= el.commitSelect.options.length - 1;
}

function renderTree(): void {
  if (rs.files.length === 0) {
    el.tree.innerHTML = "";
    rs.visible = [];
    return;
  }
  const rows: TreeRow[] = [];
  flatten(buildTree(rs.files), 0, rows);
  rs.visible = rows.flatMap((r) => (r.kind === "file" ? [r.index] : []));
  // Collapsing a directory can hide the selected file; fall back to the top.
  if (!rs.visible.includes(rs.selected)) rs.selected = rs.visible[0] ?? 0;
  el.tree.innerHTML = rows.map(rowHtml).join("");
}

/// Why the diff pane has nothing to show.
function emptyReason(): string {
  if (!rs.result) return rs.empty;
  return rs.result.commits.length === 0
    ? "Nothing to merge: this branch is already contained in the target."
    : "This commit changes no files.";
}

/// The commit message of whichever single commit is being shown: its summary,
/// which is all most commits need, expanding to the whole message on request.
/// Expanded or not is remembered, since it is a habit rather than a per-commit
/// decision.
function renderMessage(): void {
  const c = rs.result?.commits.find((x) => x.id === rs.showing);
  el.message.hidden = !c;
  el.messageSplitter.hidden = !c || !rs.expanded;
  el.message.classList.toggle("expanded", rs.expanded);
  if (!c) return;
  const full = (rs.message ?? "").trimEnd();
  // Expanded stays expanded even for a one-line message, so that stepping
  // through commits does not move the diff up and down.
  const open = rs.expanded;
  const hasMore = full.trim() !== c.summary.trim();
  el.message.innerHTML =
    `<div class="message-line">` +
    `<span class="sha">${c.short_id}</span>` +
    (hasMore || open
      ? `<button class="msg-toggle" title="${open ? "Show just the summary" : "Show the whole message"}">` +
        `${open ? "▾" : "▸"}</button>`
      : "") +
    // Expanded, the body below already opens with the summary.
    (open ? "" : `<span class="msg">${escapeHtml(c.summary)}</span>`) +
    `<span class="dim">${escapeHtml(c.author)}, ${formatDate(c.time)}</span>` +
    `</div>` +
    (open ? `<pre class="message-body">${escapeHtml(full)}</pre>` : "");
}

function render(): void {
  renderSummary();
  renderCommitSelect();
  renderMessage();
  renderTree();
  // Folds belong to one comparison and one commit within it.
  pane.show(rs.files, emptyReason(), {
    scope: `${rs.repo}|${rs.base}..${rs.head}|${rs.showing}`,
    repo: rs.repo,
    // The same revision the file links open at: one commit's own version,
    // or the branch tip when the whole branch is in view.
    rev: (rs.showing === ALL ? rs.head : rs.showing) ?? "",
  });
}

// --------------------------------------------------------------------- state

/// Show either the whole branch diff or one commit's own changes.
async function showCommit(id: string): Promise<void> {
  rs.showing = id;
  rs.selected = 0;
  rs.message = null;
  if (id === ALL) {
    rs.files = inTreeOrder(rs.result?.files ?? []);
  } else {
    try {
      const details = await backend.getCommitDetails(rs.repo, id);
      rs.files = inTreeOrder(details.files);
      rs.message = details.message;
    } catch (e) {
      toast(`Failed to load commit: ${e}`);
      rs.files = [];
    }
  }
  render();
}

/// Which commit's diff is on screen, or ALL for the whole branch.
export function showing(): string {
  return rs.showing;
}

/// Fires when the reader moves to another commit, so the position can be
/// recorded. Loading a comparison does not count as moving.
export function onNavigate(cb: () => void): void {
  navigated = cb;
}

let navigated: () => void = () => {};

export async function load(
  repo: string,
  base: string,
  head: string,
  showing?: string,
): Promise<void> {
  rs.repo = repo;
  rs.base = base;
  rs.head = head;
  try {
    rs.result = await backend.getReview(repo, base, head);
  } catch (e) {
    toast(`Failed to compare branches: ${e}`);
    rs.result = null;
    rs.files = [];
    render();
    return;
  }
  // A branch of one commit shows that commit rather than "all changes": the
  // two are the same diff, and the commit brings its message with it.
  const only = rs.result.commits.length === 1 ? rs.result.commits[0].id : null;
  // Otherwise, a commit asked for by the URL if this comparison still has it.
  const wanted =
    only ?? (showing && rs.result.commits.some((c) => c.id === showing) ? showing : ALL);
  await showCommit(wanted);
}

export function clear(why: string): void {
  rs.base = null;
  rs.head = null;
  rs.result = null;
  rs.files = [];
  rs.empty = why;
  render();
}

export function setVisible(visible: boolean): void {
  el.root.hidden = !visible;
}

/// Arrow-key navigation through the file tree; returns false if unhandled.
export function moveSelection(delta: number): boolean {
  if (rs.visible.length === 0) return false;
  const at = rs.visible.indexOf(rs.selected);
  const next = Math.min(Math.max(0, at + delta), rs.visible.length - 1);
  select(rs.visible[next]);
  return true;
}

function markTree(): void {
  for (const node of el.tree.querySelectorAll<HTMLElement>(".tree-file")) {
    node.classList.toggle("selected", node.dataset.i === String(rs.selected));
  }
  el.tree.querySelector(".tree-file.selected")?.scrollIntoView({ block: "nearest" });
}

function select(i: number): void {
  rs.selected = i;
  markTree();
  pane.select(i, true);
}

function step(delta: number): void {
  const i = el.commitSelect.selectedIndex + delta;
  if (i < 0 || i >= el.commitSelect.options.length) return;
  void showCommit(el.commitSelect.options[i].value).then(navigated);
}

/// The files view opens what the diff is showing: one commit's own version of
/// the file, or the branch tip when the whole branch is in view.
export function onOpenFile(cb: (rev: string, path: string) => void): void {
  pane.onOpenFile((path) => {
    const rev = rs.showing === ALL ? rs.head : rs.showing;
    if (rev) cb(rev, path);
  });
}

export function wire(): void {
  el.message.addEventListener("click", (ev) => {
    if (!(ev.target as HTMLElement).closest(".msg-toggle")) return;
    rs.expanded = !rs.expanded;
    localStorage.setItem("reviewMessageExpanded", rs.expanded ? "1" : "0");
    renderMessage();
  });

  el.commitSelect.addEventListener("change", () =>
    void showCommit(el.commitSelect.value).then(navigated),
  );
  el.prev.addEventListener("click", () => step(-1));
  el.next.addEventListener("click", () => step(1));

  el.tree.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    const file = target.closest<HTMLElement>(".tree-file");
    if (file?.dataset.i) {
      select(Number(file.dataset.i));
      return;
    }
    const dir = target.closest<HTMLElement>(".tree-dir");
    if (dir?.dataset.path !== undefined) {
      const path = dir.dataset.path;
      if (rs.collapsed.has(path)) rs.collapsed.delete(path);
      else rs.collapsed.add(path);
      renderTree();
    }
  });
}
