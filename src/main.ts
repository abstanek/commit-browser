import { backend } from "@backend";
import type { BranchInfo, CommitDetails, GraphResult, RefsResult, RepoInfo } from "./api";
import { fileLabel, statsHtml, STATUS_LETTER } from "./diff";
import { createDiffPane } from "./diffpane";
import * as files from "./files";
import { applyPanes, wirePanes } from "./panes";
import * as repopicker from "./repopicker";
import { fromUrl, type Route, sameUrl, toUrl } from "./router";
import { graphWidthPx, renderGraph, rowHeight } from "./graph";
import * as review from "./review";
import { $, escapeHtml, formatDate, shortRef, toast } from "./util";

const PAGE = 1000;

type Mode = "graph" | "review" | "files";

interface AppUiState {
  /// Every repository the host offers, and which of them is open. The open one
  /// is named by its display path, which is also the persistence key.
  repos: RepoInfo[];
  repoPath: string | null;
  mode: Mode;
  refs: RefsResult | null;
  enabled: Set<string>; // full ref names, graph mode
  /// Review mode: the branch under review and the one it would merge into.
  head: string | null;
  base: string | null;
  /// Files mode: the ref being browsed.
  rev: string | null;
  graph: GraphResult | null;
  limit: number;
  selectedId: string | null;
  details: CommitDetails | null;
  selectedFile: number;
  /// Which pane arrow keys act on.
  focus: "commits" | "files";
}

const state: AppUiState = {
  repos: [],
  repoPath: null,
  mode: "graph",
  refs: null,
  enabled: new Set(),
  head: null,
  base: null,
  rev: null,
  graph: null,
  limit: PAGE,
  selectedId: null,
  details: null,
  selectedFile: 0,
  focus: "commits",
};

const el = {
  main: $("main"),
  modeGraph: $("mode-graph"),
  modeReview: $("mode-review"),
  modeFiles: $("mode-files"),
  baseControls: $("base-controls"),
  baseRef: $<HTMLSelectElement>("base-ref"),
  openRepoEmpty: $("open-repo-empty"),
  refresh: $("refresh"),
  toggleDetails: $("toggle-details"),
  themeToggle: $("theme-toggle"),
  fontSmaller: $<HTMLButtonElement>("font-smaller"),
  fontBigger: $<HTMLButtonElement>("font-bigger"),
  branchSort: $<HTMLSelectElement>("branch-sort"),
  localBranches: $("local-branches"),
  remoteBranches: $("remote-branches"),
  commitList: $("commit-list"),
  listScroll: $("list-scroll"),
  rowsWrap: $("rows-wrap"),
  rows: $("rows"),
  graphSvg: document.getElementById("graph-svg") as unknown as SVGSVGElement,
  loadMore: $("load-more"),
  listEmpty: $("list-empty"),
  splitter: $("splitter"),
  details: $("details"),
  detailMeta: $("detail-meta"),
  fileList: $("file-list"),
  diffView: $("diff-view"),
  emptyState: $("empty-state"),
  emptyHint: $("empty-hint"),
};

// ---------------------------------------------------------------- persistence

const store = {
  lastRepo: (): string | null => localStorage.getItem("lastRepo"),
  setLastRepo: (p: string) => localStorage.setItem("lastRepo", p),
  enabledFor(repo: string): string[] | null {
    const raw = localStorage.getItem(`enabled:${repo}`);
    return raw ? (JSON.parse(raw) as string[]) : null;
  },
  setEnabledFor(repo: string, refs: string[]) {
    localStorage.setItem(`enabled:${repo}`, JSON.stringify(refs));
  },
  detailsVisible: (): boolean => localStorage.getItem("detailsVisible") !== "0",
  setDetailsVisible: (v: boolean) => localStorage.setItem("detailsVisible", v ? "1" : "0"),
  detailsHeight: (): number => Number(localStorage.getItem("detailsHeight") ?? 320),
  setDetailsHeight: (h: number) => localStorage.setItem("detailsHeight", String(h)),
  branchSort: (): BranchSort =>
    localStorage.getItem("branchSort") === "name" ? "name" : "recent",
  setBranchSort: (s: BranchSort) => localStorage.setItem("branchSort", s),
  theme: (): ThemePref => {
    const t = localStorage.getItem("theme");
    return t === "light" || t === "dark" ? t : "system";
  },
  setTheme: (t: ThemePref) => localStorage.setItem("theme", t),
  collapsedFor(repo: string): string[] {
    const raw = localStorage.getItem(`collapsed:${repo}`);
    return raw ? (JSON.parse(raw) as string[]) : [];
  },
  setCollapsedFor(repo: string, remotes: string[]) {
    localStorage.setItem(`collapsed:${repo}`, JSON.stringify(remotes));
  },
  fontSize: (): number => Number(localStorage.getItem("fontSize")) || FONT_DEFAULT,
  setFontSize: (px: number) => localStorage.setItem("fontSize", String(px)),
  mode: (): Mode => {
    const m = localStorage.getItem("mode");
    return m === "review" || m === "files" ? m : "graph";
  },
  setMode: (m: Mode) => localStorage.setItem("mode", m),
  revFor: (repo: string): string | null => localStorage.getItem(`rev:${repo}`),
  setRevFor: (repo: string, rev: string) => localStorage.setItem(`rev:${repo}`, rev),
  reviewFor(repo: string): { base: string; head: string } | null {
    const raw = localStorage.getItem(`review:${repo}`);
    return raw ? (JSON.parse(raw) as { base: string; head: string }) : null;
  },
  setReviewFor(repo: string, base: string, head: string) {
    localStorage.setItem(`review:${repo}`, JSON.stringify({ base, head }));
  },
  columns(): ColumnWidths {
    const raw = localStorage.getItem("columns");
    return { ...COLUMN_DEFAULTS, ...(raw ? (JSON.parse(raw) as ColumnWidths) : {}) };
  },
  setColumns(widths: ColumnWidths) {
    localStorage.setItem("columns", JSON.stringify(widths));
  },
  collapsedSections(): Set<string> {
    const raw = localStorage.getItem("collapsedSections");
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  },
  setCollapsedSections(sections: Set<string>) {
    localStorage.setItem("collapsedSections", JSON.stringify([...sections]));
  },
};

type BranchSort = "recent" | "name";
type ThemePref = "system" | "light" | "dark";

// ------------------------------------------------------------- list columns

/// Widths in rem, so a column keeps its proportions when the text size
/// changes. The description column is not listed: it takes what is left.
type ColumnWidths = Record<"author" | "date" | "sha", number>;

const COLUMN_DEFAULTS: ColumnWidths = { author: 13, date: 12.3, sha: 6.2 };
const COLUMN_MIN_PX = 40;
const COLUMN_MAX_PX = 800;

function setColumnVar(key: keyof ColumnWidths, rem: number): void {
  el.commitList.style.setProperty(`--col-${key}`, `${rem}rem`);
}

function applyColumns(): void {
  const widths = store.columns();
  for (const key of Object.keys(COLUMN_DEFAULTS) as (keyof ColumnWidths)[]) {
    setColumnVar(key, widths[key]);
  }
}

function rootFontSize(): number {
  return parseFloat(getComputedStyle(document.documentElement).fontSize);
}

/// Drag a header grip to resize its column; double-click to put it back.
function wireColumns(): void {
  for (const grip of document.querySelectorAll<HTMLElement>(".col-grip")) {
    const key = grip.dataset.col as keyof ColumnWidths;
    grip.addEventListener("mousedown", (down) => {
      down.preventDefault();
      const startX = down.clientX;
      const startW = grip.parentElement!.getBoundingClientRect().width;
      let rem = store.columns()[key];
      grip.classList.add("dragging");
      const move = (ev: MouseEvent) => {
        const px = Math.min(
          Math.max(COLUMN_MIN_PX, startW + ev.clientX - startX),
          COLUMN_MAX_PX,
        );
        rem = px / rootFontSize();
        setColumnVar(key, rem);
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        grip.classList.remove("dragging");
        // Written once at the end rather than on every pixel of the drag.
        store.setColumns({ ...store.columns(), [key]: rem });
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });

    grip.addEventListener("dblclick", () => {
      store.setColumns({ ...store.columns(), [key]: COLUMN_DEFAULTS[key] });
      applyColumns();
    });
  }
}

// ------------------------------------------------------------- theme and size

/// The root font size everything else is sized against; index.html applies the
/// stored value before first paint so the UI does not reflow on load.
const FONT_DEFAULT = 13;
const FONT_MIN = 9;
const FONT_MAX = 24;

function applyFontSize(px: number): void {
  document.documentElement.style.setProperty("--ui-font-size", `${px}px`);
  el.fontSmaller.disabled = px <= FONT_MIN;
  el.fontBigger.disabled = px >= FONT_MAX;
}

function stepFontSize(delta: number): void {
  const px = Math.min(FONT_MAX, Math.max(FONT_MIN, store.fontSize() + delta));
  store.setFontSize(px);
  applyFontSize(px);
  // Rows just changed height, and the graph SVG is drawn in pixels.
  if (state.graph) renderCommitList();
}

const darkMedia = window.matchMedia("(prefers-color-scheme: dark)");

function applyTheme(): void {
  const pref = store.theme();
  const effective = pref === "system" ? (darkMedia.matches ? "dark" : "light") : pref;
  document.documentElement.dataset.theme = effective;
  el.themeToggle.textContent =
    pref === "system" ? "Theme: Auto" : pref === "light" ? "Theme: Light" : "Theme: Dark";
}

// ------------------------------------------------------------------- sidebar

function sortBranches(branches: BranchInfo[]): BranchInfo[] {
  const copy = [...branches];
  if (store.branchSort() === "recent") {
    copy.sort((a, b) => b.tip_time - a.tip_time || a.name.localeCompare(b.name));
  } else {
    copy.sort((a, b) => a.name.localeCompare(b.name));
  }
  return copy;
}

/// Graph mode enables any number of branches; the other two pick exactly one,
/// so the same rows switch between checkboxes and radio buttons.
function refItemHtml(b: BranchInfo, label: string, isHead: boolean): string {
  const graphing = state.mode === "graph";
  const checked = graphing
    ? state.enabled.has(b.full_name)
    : (state.mode === "review" ? state.head : state.rev) === b.full_name;
  const input = graphing
    ? `<input type="checkbox" data-ref="${escapeHtml(b.full_name)}" ${
        checked ? "checked" : ""
      }/>`
    : `<input type="radio" name="ref-pick" data-ref="${escapeHtml(b.full_name)}" ${
        checked ? "checked" : ""
      }/>`;
  return (
    `<label class="ref-item${isHead ? " head" : ""}" title="${escapeHtml(b.full_name)}">` +
    input +
    `<span class="ref-name">${escapeHtml(label)}</span>` +
    (isHead ? `<span class="head-dot" title="Current branch">●</span>` : "") +
    (checked && graphing
      ? `<button class="jump-btn" data-target="${b.target}" ` +
        `title="Jump to head of ${escapeHtml(b.name)}">⌖</button>`
      : "") +
    `</label>`
  );
}

function applySectionCollapse(): void {
  const collapsed = store.collapsedSections();
  for (const sec of document.querySelectorAll<HTMLElement>(".section[data-section]")) {
    const isCollapsed = collapsed.has(sec.dataset.section!);
    sec.querySelector(".section-body")?.toggleAttribute("hidden", isCollapsed);
    const d = sec.querySelector(".section-toggle .disclosure");
    if (d) d.textContent = isCollapsed ? "▸" : "▾";
  }
}

function collapsedRemotes(): Set<string> {
  return new Set(state.repoPath ? store.collapsedFor(state.repoPath) : []);
}

function renderSidebar(): void {
  if (!state.refs) return;
  const head = state.refs.head_branch;
  el.localBranches.innerHTML = sortBranches(state.refs.locals)
    .map((b) => refItemHtml(b, b.name, head !== null && b.name === head))
    .join("");

  // Remote branches grouped by remote; sort applies within each group.
  const groups = new Map<string, BranchInfo[]>();
  for (const b of state.refs.remotes) {
    const remote = b.remote ?? "(unknown)";
    let g = groups.get(remote);
    if (!g) groups.set(remote, (g = []));
    g.push(b);
  }
  const collapsed = collapsedRemotes();
  el.remoteBranches.innerHTML = [...groups.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((remote) => {
      const isCollapsed = collapsed.has(remote);
      const items = sortBranches(groups.get(remote)!)
        .map((b) => {
          const label = b.remote ? b.name.slice(b.remote.length + 1) : b.name;
          return refItemHtml(b, label, false);
        })
        .join("");
      return (
        `<div class="remote-group${isCollapsed ? " collapsed" : ""}">` +
        `<div class="remote-header" data-remote="${escapeHtml(remote)}">` +
        `<span class="disclosure">${isCollapsed ? "▸" : "▾"}</span>` +
        `<span class="remote-name">${escapeHtml(remote)}</span>` +
        `<span class="remote-count">${groups.get(remote)!.length}</span>` +
        `</div>` +
        `<div class="remote-items"${isCollapsed ? " hidden" : ""}>${items}</div>` +
        `</div>`
      );
    })
    .join("");
}

function persistEnabled(): void {
  if (state.repoPath) store.setEnabledFor(state.repoPath, [...state.enabled]);
}

function setAll(branches: BranchInfo[], on: boolean): void {
  for (const b of branches) {
    if (on) state.enabled.add(b.full_name);
    else state.enabled.delete(b.full_name);
  }
  persistEnabled();
  renderSidebar();
  void refreshGraph();
}

// --------------------------------------------------------------- review mode

function allBranches(): BranchInfo[] {
  return [...(state.refs?.locals ?? []), ...(state.refs?.remotes ?? [])];
}

const TRUNKS = ["main", "master", "trunk", "develop"];

/// The branch a review would most likely target: the repo's trunk if it has
/// one, otherwise the checked-out branch, preferring local refs and never the
/// branch under review. Null when the repo has nothing else to offer.
function defaultBase(head: string | null): string | null {
  const rank = (b: BranchInfo): number => {
    const leaf = b.remote ? b.name.slice(b.remote.length + 1) : b.name;
    const remote = b.remote ? 20 : 0;
    const trunk = TRUNKS.indexOf(leaf);
    if (trunk !== -1) return trunk + remote;
    if (!b.remote && b.name === state.refs?.head_branch) return 10;
    return 50 + remote;
  };
  return (
    allBranches()
      .filter((b) => b.full_name !== head)
      .sort((a, b) => rank(a) - rank(b))[0]?.full_name ?? null
  );
}

function renderBaseSelect(): void {
  const groups: [string, BranchInfo[]][] = [
    ["Branches", state.refs?.locals ?? []],
    ["Remotes", state.refs?.remotes ?? []],
  ];
  el.baseRef.innerHTML = groups
    .filter(([, list]) => list.length > 0)
    .map(
      ([label, list]) =>
        `<optgroup label="${label}">` +
        list
          .map(
            (b) =>
              // A branch cannot be merged into itself.
              `<option value="${escapeHtml(b.full_name)}"${
                b.full_name === state.head ? " disabled" : ""
              }>${escapeHtml(b.name)}</option>`,
          )
          .join("") +
        `</optgroup>`,
    )
    .join("");
  if (state.base) el.baseRef.value = state.base;
}

/// Keep the single-ref selections pointing at refs that still exist, filling in
/// defaults for a repo opened for the first time.
function syncRefSelections(): void {
  const existing = new Set(allBranches().map((b) => b.full_name));
  const saved = state.repoPath ? store.reviewFor(state.repoPath) : null;
  const savedRev = state.repoPath ? store.revFor(state.repoPath) : null;
  if (!state.head && saved && existing.has(saved.head)) state.head = saved.head;
  if (!state.base && saved && existing.has(saved.base)) state.base = saved.base;
  if (!state.rev && savedRev && (isCommitRev(savedRev) || existing.has(savedRev))) {
    state.rev = savedRev;
  }
  if (state.head && !existing.has(state.head)) state.head = null;
  // A commit rev stands on its own; only branch selections need to still exist.
  if (state.rev && !isCommitRev(state.rev) && !existing.has(state.rev)) state.rev = null;
  if (state.base && (!existing.has(state.base) || state.base === state.head)) {
    state.base = null;
  }

  const checkedOut =
    state.refs?.locals.find((b) => b.name === state.refs?.head_branch)?.full_name ??
    state.refs?.locals[0]?.full_name ??
    null;
  if (!state.head) state.head = checkedOut;
  if (!state.rev) state.rev = checkedOut;
  if (!state.base) state.base = defaultBase(state.head);
  renderBaseSelect();
}

function persistReview(): void {
  if (state.repoPath && state.base && state.head) {
    store.setReviewFor(state.repoPath, state.base, state.head);
  }
}

async function loadReview(): Promise<void> {
  const showing = pendingShowing;
  pendingShowing = null;
  if (!state.head) review.clear("Pick a branch to review.");
  else if (!state.base) review.clear("There is no other branch to merge into.");
  else {
    await review.load(state.repoPath ?? "", state.base, state.head, showing ?? undefined);
  }
  // Which commit ended up on screen is only known now, so complete the entry.
  syncUrl(true);
}

function persistRev(): void {
  if (state.repoPath && state.rev) store.setRevFor(state.repoPath, state.rev);
}

/// Anything that is not a full ref name is a commit browsed on its own, with
/// no branch selected in the sidebar.
function isCommitRev(rev: string): boolean {
  return !rev.startsWith("refs/");
}

/// Set by the diff views, consumed by the next files load.
let pendingFile: string | null = null;

async function loadFiles(): Promise<void> {
  const open = pendingFile;
  pendingFile = null;
  if (!state.rev) {
    files.clear("Pick a branch to browse.");
    return;
  }
  const commit = isCommitRev(state.rev);
  const label = commit ? state.rev.slice(0, 7) : shortRef(state.rev);
  await files.load(state.repoPath ?? "", state.rev, label, commit, open ?? undefined);
  // Which file ended up open is only known now, so complete the entry.
  syncUrl(true);
}

/// Follow a diff's file into the files view, at the revision it was read from.
function openInFiles(rev: string, path: string): void {
  pendingFile = path;
  state.rev = rev;
  persistRev();
  setMode("files");
}

// -------------------------------------------------------------------- routing

/// Set while a URL is being applied, so restoring a position does not record
/// it again as a new one.
let applyingRoute = false;
/// A position from the address bar, waiting for the repository to open.
let startRoute: Route | null = null;
/// Commit the review should show once its comparison has loaded.
let pendingShowing: string | null = null;

function refParam(full: string): string {
  return isCommitRev(full) ? full : shortRef(full);
}

/// The branch a short name from the URL refers to, preferring local ones, or
/// the name itself when it looks like a commit.
function resolveRef(name: string | undefined): string | null {
  if (!name) return null;
  const match =
    state.refs?.locals.find((b) => b.name === name) ??
    state.refs?.remotes.find((b) => b.name === name);
  if (match) return match.full_name;
  return /^[0-9a-f]{7,40}$/.test(name) ? name : null;
}

function currentRoute(): Route {
  const repo = state.repoPath ?? undefined;
  if (state.mode === "review") {
    const showing = review.showing();
    return {
      view: "review",
      repo,
      head: state.head ? refParam(state.head) : undefined,
      base: state.base ? refParam(state.base) : undefined,
      commit: showing === "all" ? undefined : showing,
    };
  }
  if (state.mode === "files") {
    return {
      view: "files",
      repo,
      rev: state.rev ? refParam(state.rev) : undefined,
      path: files.openPath() ?? undefined,
    };
  }
  return { view: "graph", repo, commit: state.selectedId ?? undefined };
}

/// Record where the app now is. Deliberate moves add to the history; ones the
/// reader is holding a key down for replace the entry instead.
function syncUrl(replace = false): void {
  if (!backend.routable || applyingRoute) return;
  const url = toUrl(currentRoute());
  if (sameUrl(url)) return;
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
}

async function applyRoute(route: Route): Promise<void> {
  // Switching repository reloads refs and the graph and then applies the route
  // itself, so hand the whole thing over rather than carrying on here.
  const other = knownRepo(route.repo);
  if (other && other !== state.repoPath) {
    startRoute = route;
    await openRepo(other);
    return;
  }
  applyingRoute = true;
  try {
    if (route.view === "review") {
      state.head = resolveRef(route.head) ?? state.head;
      state.base = resolveRef(route.base) ?? state.base;
      if (state.base === state.head) state.base = defaultBase(state.head);
      renderBaseSelect();
      persistReview();
      pendingShowing = route.commit ?? null;
      setMode("review", false);
      await loadReview();
    } else if (route.view === "files") {
      state.rev = resolveRef(route.rev) ?? state.rev;
      persistRev();
      pendingFile = route.path ?? null;
      setMode("files", false);
      await loadFiles();
    } else {
      setMode("graph");
      if (route.commit) await jumpToCommit(route.commit);
    }
  } finally {
    applyingRoute = false;
  }
}

/// `load` is false when the caller will run the view's load itself, as
/// applying a route does so it can await it.
function setMode(mode: Mode, load = true): void {
  state.mode = mode;
  store.setMode(mode);
  const graphing = mode === "graph";
  el.modeGraph.classList.toggle("active", graphing);
  el.modeReview.classList.toggle("active", mode === "review");
  el.modeFiles.classList.toggle("active", mode === "files");
  el.main.hidden = !graphing;
  el.baseControls.hidden = mode !== "review";
  el.toggleDetails.hidden = !graphing;
  review.setVisible(mode === "review");
  files.setVisible(mode === "files");
  // "all"/"none" only make sense for the graph's checkboxes.
  for (const a of document.querySelectorAll<HTMLElement>(".section-actions")) {
    a.hidden = !graphing;
  }
  renderSidebar();
  syncUrl();
  if (!state.repoPath || !load) return;
  if (mode === "review") void loadReview();
  if (mode === "files") void loadFiles();
}

// --------------------------------------------------------------- commit list

function renderCommitList(): void {
  const g = state.graph;
  if (!g) return;

  const graphW = graphWidthPx(g.width);
  el.commitList.style.setProperty("--graph-w", `${graphW}px`);

  el.rows.innerHTML = g.rows
    .map((r, i) => {
      const chips = r.refs
        .map(
          (l) =>
            `<span class="chip ${l.kind}${
              l.kind === "local" && state.refs?.head_branch === l.name ? " chip-head" : ""
            }">${escapeHtml(l.name)}</span>`,
        )
        .join("");
      const sel = r.id === state.selectedId ? " selected" : "";
      return (
        `<div class="row${sel}" data-i="${i}" data-id="${r.id}">` +
        `<div class="cell graph-pad"></div>` +
        `<div class="cell subject">${chips}<span class="subject-text">${escapeHtml(r.summary)}</span></div>` +
        `<div class="cell author" title="${escapeHtml(r.email)}">${escapeHtml(r.author)}</div>` +
        `<div class="cell date">${formatDate(r.time)}</div>` +
        `<div class="cell sha">${r.short_id}</div>` +
        `</div>`
      );
    })
    .join("");

  const rowH = rowHeight();
  const svgH = g.rows.length * rowH + (g.has_more ? rowH / 2 : 0);
  el.graphSvg.setAttribute("width", String(graphW));
  el.graphSvg.setAttribute("height", String(svgH));
  el.graphSvg.innerHTML = renderGraph(g.rows, g.head_id);

  el.loadMore.hidden = !g.has_more;
  el.listEmpty.hidden = g.rows.length > 0;
}

async function refreshGraph(): Promise<void> {
  if (!state.repoPath) return;
  try {
    state.graph = await backend.getGraph(state.repoPath!, [...state.enabled], state.limit);
  } catch (e) {
    toast(`Failed to load graph: ${e}`);
    return;
  }
  // Drop the selection if the commit is no longer visible.
  if (state.selectedId && !state.graph.rows.some((r) => r.id === state.selectedId)) {
    state.selectedId = null;
    state.details = null;
    renderDetails();
  }
  renderCommitList();
}

function setFocus(f: "commits" | "files"): void {
  state.focus = f;
  el.listScroll.classList.toggle("pane-focus", f === "commits");
  el.details.classList.toggle("pane-focus", f === "files");
}

function markFileList(): void {
  for (const c of el.fileList.children) {
    c.classList.toggle(
      "selected",
      (c as HTMLElement).dataset.i === String(state.selectedFile),
    );
  }
  el.fileList.children[state.selectedFile]?.scrollIntoView({ block: "nearest" });
}

function selectFile(i: number): void {
  const files = state.details?.files ?? [];
  if (files.length === 0) return;
  state.selectedFile = Math.min(Math.max(0, i), files.length - 1);
  markFileList();
  detailPane.select(state.selectedFile, true);
}

/// `replaceUrl` is for arrow-key walking, which would otherwise fill the
/// history with a step per commit.
async function selectCommit(
  id: string,
  scrollTo = false,
  replaceUrl = false,
): Promise<void> {
  setFocus("commits");
  state.selectedId = id;
  syncUrl(replaceUrl);
  for (const row of el.rows.children) {
    row.classList.toggle("selected", (row as HTMLElement).dataset.id === id);
  }
  if (scrollTo) {
    el.rows
      .querySelector(`[data-id="${id}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }
  try {
    state.details = await backend.getCommitDetails(state.repoPath!, id);
    state.selectedFile = 0;
  } catch (e) {
    toast(`Failed to load commit: ${e}`);
    state.details = null;
  }
  renderDetails();
}

/// Select a commit that may lie beyond the currently loaded page: keep
/// extending the walk until its row exists, then select and scroll to it.
async function jumpToCommit(id: string): Promise<void> {
  let guard = 0;
  while (
    state.graph &&
    state.graph.has_more &&
    !state.graph.rows.some((r) => r.id === id) &&
    guard++ < 50
  ) {
    state.limit += PAGE;
    await refreshGraph();
  }
  await selectCommit(id, true);
}

// -------------------------------------------------------------- details pane

const detailPane = createDiffPane(el.diffView);
detailPane.onSelect((index) => {
  state.selectedFile = index;
  markFileList();
});

function renderDetails(): void {
  const d = state.details;
  if (!d) {
    el.detailMeta.innerHTML = `<div class="detail-empty">Select a commit to see its details.</div>`;
    el.fileList.innerHTML = "";
    detailPane.show([], "");
    return;
  }
  const chips = d.refs
    .map((l) => `<span class="chip ${l.kind}">${escapeHtml(l.name)}</span>`)
    .join("");
  const parents = d.parents
    .map((p) => `<a href="#" class="parent-link" data-id="${p}">${p.slice(0, 7)}</a>`)
    .join(", ");
  el.detailMeta.innerHTML =
    `<div class="detail-row1"><span class="sha">${d.id}</span>${chips}</div>` +
    `<div class="detail-row2">` +
    `<span><b>${escapeHtml(d.author_name)}</b> &lt;${escapeHtml(d.author_email)}&gt;</span>` +
    `<span>${formatDate(d.author_time)}</span>` +
    (d.parents.length ? `<span>Parents: ${parents}</span>` : `<span>Root commit</span>`) +
    `</div>` +
    `<pre class="detail-message">${escapeHtml(d.message.trimEnd())}</pre>`;

  el.fileList.innerHTML = d.files
    .map((f, i) => {
      const sel = i === state.selectedFile ? " selected" : "";
      return (
        `<div class="file-item${sel}" data-i="${i}" title="${escapeHtml(f.path)}">` +
        `<span class="status ${f.status}">${STATUS_LETTER[f.status] ?? "?"}</span>` +
        `<span class="file-name">${fileLabel(f)}</span>${statsHtml(f)}</div>`
      );
    })
    .join("");
  detailPane.show(d.files, "No changes vs first parent.", {
    scope: `${state.repoPath}|${d.id}`,
    repo: state.repoPath ?? "",
    rev: d.id,
  });
}

function setDetailsVisible(visible: boolean): void {
  el.details.hidden = !visible;
  el.splitter.hidden = !visible;
  el.toggleDetails.classList.toggle("active", visible);
  store.setDetailsVisible(visible);
  if (!visible) setFocus("commits");
}

// ----------------------------------------------------------------- repositories

/// Re-read the host's list of repositories and redraw the picker. The desktop
/// build's list is the reader's own; the server's is fixed by its command line.
async function loadRepos(): Promise<void> {
  try {
    state.repos = await backend.listRepos();
  } catch (e) {
    state.repos = [];
    el.emptyHint.textContent = `Could not list repositories: ${e}`;
  }
  repopicker.render(state.repos, state.repoPath);
}

function knownRepo(path: string | null | undefined): string | null {
  return path && state.repos.some((r) => r.display_path === path) ? path : null;
}

/// Nothing to browse: say so in the terms of whichever host this is.
function showNoRepo(): void {
  state.repoPath = null;
  state.refs = null;
  state.graph = null;
  repopicker.render(state.repos, null);
  el.emptyState.hidden = false;
  el.emptyHint.textContent = backend.editableRepos
    ? "Add a git repository to browse its commit graph."
    : "The server was given no repositories.";
  el.openRepoEmpty.hidden = !backend.editableRepos;
}

/// Open a repository from the host's list. `push` marks a switch the reader
/// asked for, which is a move like any other and earns its own history entry;
/// the entry is refined once the refs have settled what is on screen.
async function openRepo(path: string, push = false): Promise<void> {
  state.repoPath = path;
  state.limit = PAGE;
  state.selectedId = null;
  state.details = null;
  store.setLastRepo(path);
  repopicker.render(state.repos, path);
  el.emptyState.hidden = true;
  if (push) syncUrl();

  try {
    state.refs = await backend.listRefs(state.repoPath);
  } catch (e) {
    toast(`Could not list branches: ${e}`);
    return;
  }
  const saved = store.enabledFor(state.repoPath);
  const existing = new Set(
    [...state.refs.locals, ...state.refs.remotes].map((b) => b.full_name),
  );
  if (saved) {
    state.enabled = new Set(saved.filter((r) => existing.has(r)));
  } else {
    state.enabled = new Set(state.refs.locals.map((b) => b.full_name));
  }
  state.head = null;
  state.base = null;
  state.rev = null;
  syncRefSelections();
  renderSidebar();
  renderDetails();
  await refreshGraph();
  // A position from the address bar needs the refs, so it waits until here.
  if (startRoute) {
    const route = startRoute;
    startRoute = null;
    await applyRoute(route);
  } else if (state.mode === "review") {
    await loadReview();
  } else if (state.mode === "files") {
    await loadFiles();
  }
  syncUrl(true);
}

/// Re-read refs and commits from disk, keeping the current branch selection
/// (minus refs that no longer exist; new branches start unchecked).
async function refreshAll(): Promise<void> {
  if (!state.repoPath) return;
  try {
    state.refs = await backend.listRefs(state.repoPath);
  } catch (e) {
    toast(`Refresh failed: ${e}`);
    return;
  }
  const existing = new Set(
    [...state.refs.locals, ...state.refs.remotes].map((b) => b.full_name),
  );
  state.enabled = new Set([...state.enabled].filter((r) => existing.has(r)));
  persistEnabled();
  syncRefSelections();
  renderSidebar();
  if (state.mode === "review") {
    await loadReview();
    return;
  }
  if (state.mode === "files") {
    await loadFiles();
    return;
  }
  await refreshGraph();
  // The selected commit's refs/details may have changed (e.g. new tag).
  if (state.selectedId && state.graph?.rows.some((r) => r.id === state.selectedId)) {
    await selectCommit(state.selectedId);
  }
}

async function addRepo(): Promise<void> {
  let info;
  try {
    info = await backend.addRepo?.();
  } catch (e) {
    toast(`Could not add repository: ${e}`);
    return;
  }
  if (!info) return;
  await loadRepos();
  await openRepo(info.display_path, true);
}

/// Take a repository out of the list. Only the list is touched; the repository
/// itself is left where it is.
async function removeRepo(path: string): Promise<void> {
  await backend.removeRepo?.(path);
  await loadRepos();
  if (state.repoPath !== path) return;
  // The open one just went: fall back to whatever is left.
  const next = state.repos[0]?.display_path;
  if (next) await openRepo(next);
  else showNoRepo();
}

// -------------------------------------------------------------------- wiring

function wire(): void {
  // Only the desktop build lets the reader change the list; the server's is
  // settled by the command line it was started with.
  el.openRepoEmpty.hidden = !backend.editableRepos;
  if (backend.editableRepos) {
    el.openRepoEmpty.addEventListener("click", () => void addRepo());
  } else {
    el.emptyHint.textContent = "Connecting to the commit-browser server…";
  }
  repopicker.wire(backend.editableRepos);
  repopicker.onSelect((repo) => void openRepo(repo, true));
  repopicker.onAdd(() => void addRepo());
  repopicker.onRemove((repo) => void removeRepo(repo));
  el.refresh.addEventListener("click", () => void refreshAll());
  el.loadMore.addEventListener("click", () => {
    state.limit += PAGE;
    void refreshGraph();
  });

  el.modeGraph.addEventListener("click", () => setMode("graph"));
  el.modeReview.addEventListener("click", () => setMode("review"));
  el.modeFiles.addEventListener("click", () => setMode("files"));
  review.wire();
  review.onOpenFile(openInFiles);
  detailPane.onOpenFile((path) => {
    if (state.selectedId) openInFiles(state.selectedId, path);
  });
  files.wire();

  el.baseRef.addEventListener("change", () => {
    state.base = el.baseRef.value;
    persistReview();
    syncUrl();
    void loadReview();
  });

  review.onNavigate(() => syncUrl());
  files.onNavigate(() => syncUrl());

  window.addEventListener("popstate", () => {
    const route = fromUrl(new URL(location.href));
    if (route) void applyRoute(route);
  });

  // Branch selection (delegated): checkboxes in graph mode, radios in review.
  for (const list of [el.localBranches, el.remoteBranches]) {
    list.addEventListener("change", (ev) => {
      const cb = ev.target as HTMLInputElement;
      const ref = cb.dataset.ref;
      if (!ref) return;
      if (state.mode === "review") {
        state.head = ref;
        if (state.base === ref) state.base = defaultBase(ref);
        renderBaseSelect();
        persistReview();
        syncUrl();
        void loadReview();
        return;
      }
      if (state.mode === "files") {
        state.rev = ref;
        persistRev();
        syncUrl();
        void loadFiles();
        return;
      }
      if (cb.checked) state.enabled.add(ref);
      else state.enabled.delete(ref);
      persistEnabled();
      renderSidebar(); // add/remove the jump-to-head icon
      void refreshGraph();
    });
  }

  // Jump-to-branch-head icons (delegated across both lists). preventDefault
  // stops the surrounding <label> from also toggling the checkbox.
  $("sidebar").addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>(".jump-btn");
    if (!btn?.dataset.target) return;
    ev.preventDefault();
    ev.stopPropagation();
    void jumpToCommit(btn.dataset.target);
  });

  // Collapsible Branches/Remotes sections.
  for (const toggle of document.querySelectorAll<HTMLElement>(".section-toggle")) {
    toggle.addEventListener("click", () => {
      const sec = toggle.closest<HTMLElement>(".section[data-section]");
      if (!sec) return;
      const collapsed = store.collapsedSections();
      const id = sec.dataset.section!;
      if (collapsed.has(id)) collapsed.delete(id);
      else collapsed.add(id);
      store.setCollapsedSections(collapsed);
      applySectionCollapse();
    });
  }
  $("locals-all").addEventListener("click", () => setAll(state.refs?.locals ?? [], true));
  $("locals-none").addEventListener("click", () => setAll(state.refs?.locals ?? [], false));
  $("remotes-all").addEventListener("click", () => setAll(state.refs?.remotes ?? [], true));
  $("remotes-none").addEventListener("click", () => setAll(state.refs?.remotes ?? [], false));

  el.branchSort.addEventListener("change", () => {
    store.setBranchSort(el.branchSort.value as BranchSort);
    renderSidebar();
  });

  el.fontSmaller.addEventListener("click", () => stepFontSize(-1));
  el.fontBigger.addEventListener("click", () => stepFontSize(1));

  el.themeToggle.addEventListener("click", () => {
    const order: ThemePref[] = ["system", "light", "dark"];
    const next = order[(order.indexOf(store.theme()) + 1) % order.length];
    store.setTheme(next);
    applyTheme();
  });
  darkMedia.addEventListener("change", applyTheme);

  // Collapse/expand remote groups (delegated; ignore clicks on checkboxes).
  el.remoteBranches.addEventListener("click", (ev) => {
    const header = (ev.target as HTMLElement).closest<HTMLElement>(".remote-header");
    if (!header?.dataset.remote || !state.repoPath) return;
    const collapsed = collapsedRemotes();
    if (collapsed.has(header.dataset.remote)) collapsed.delete(header.dataset.remote);
    else collapsed.add(header.dataset.remote);
    store.setCollapsedFor(state.repoPath, [...collapsed]);
    renderSidebar();
  });

  // Clicking anywhere in the commit list focuses it for arrow navigation.
  el.listScroll.addEventListener("click", () => setFocus("commits"));

  // Row selection (delegated).
  el.rows.addEventListener("click", (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>(".row");
    if (row?.dataset.id) void selectCommit(row.dataset.id);
  });

  // Keyboard navigation.
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "F5") {
      ev.preventDefault();
      void refreshAll();
      return;
    }
    if (ev.key !== "ArrowUp" && ev.key !== "ArrowDown") return;
    const tag = (ev.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "SELECT") return;
    const delta = ev.key === "ArrowDown" ? 1 : -1;

    // Review mode has one list to walk: the changed files.
    if (state.mode === "review") {
      if (review.moveSelection(delta)) ev.preventDefault();
      return;
    }
    if (state.mode !== "graph") return;

    // When the details pane has focus, arrows move through the diff's files.
    if (state.focus === "files" && !el.details.hidden && state.details?.files.length) {
      selectFile(state.selectedFile + delta);
      ev.preventDefault();
      return;
    }

    const g = state.graph;
    if (!g || g.rows.length === 0) return;
    const cur = g.rows.findIndex((r) => r.id === state.selectedId);
    const next =
      cur === -1 ? 0 : Math.min(g.rows.length - 1, Math.max(0, cur + delta));
    if (next !== cur) void selectCommit(g.rows[next].id, true, true);
    ev.preventDefault();
  });

  // File list selection + parent links (delegated).
  el.fileList.addEventListener("click", (ev) => {
    setFocus("files");
    const item = (ev.target as HTMLElement).closest<HTMLElement>(".file-item");
    if (item) selectFile(Number(item.dataset.i));
  });
  el.diffView.addEventListener("click", () => setFocus("files"));
  el.detailMeta.addEventListener("click", (ev) => {
    const link = (ev.target as HTMLElement).closest<HTMLElement>(".parent-link");
    if (link?.dataset.id) {
      ev.preventDefault();
      void selectCommit(link.dataset.id, true);
    }
  });

  // Details pane toggle + splitter.
  // hidden reads as boolean | string, since it can also be "until-found".
  el.toggleDetails.addEventListener("click", () =>
    setDetailsVisible(Boolean(el.details.hidden)),
  );
  el.splitter.addEventListener("mousedown", (down) => {
    down.preventDefault();
    const startY = down.clientY;
    const startH = el.details.getBoundingClientRect().height;
    const move = (ev: MouseEvent) => {
      const h = Math.min(
        Math.max(120, startH + (startY - ev.clientY)),
        window.innerHeight - 200,
      );
      el.details.style.height = `${h}px`;
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      store.setDetailsHeight(el.details.getBoundingClientRect().height);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
}

async function init(): Promise<void> {
  wire();
  wireColumns();
  wirePanes();
  applyTheme();
  applyFontSize(store.fontSize());
  applyColumns();
  applyPanes();
  applySectionCollapse();
  setFocus("commits");
  el.branchSort.value = store.branchSort();
  el.details.style.height = `${store.detailsHeight()}px`;
  setDetailsVisible(store.detailsVisible());
  // A URL wins over the stored mode: it is where the reader asked to be.
  startRoute = backend.routable ? fromUrl(new URL(location.href)) : null;
  setMode(startRoute?.view ?? store.mode(), false);
  renderDetails();
  await loadRepos();
  // A repository named in the address bar wins - it is where the reader asked
  // to be - then the one open last, then whatever the host offers first.
  const wanted =
    knownRepo(startRoute?.repo) ?? knownRepo(store.lastRepo()) ??
    state.repos[0]?.display_path ?? null;
  if (wanted) await openRepo(wanted);
  else showNoRepo();
}

void init();
