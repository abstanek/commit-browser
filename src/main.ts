import { backend } from "@backend";
import type { BranchInfo, CommitDetails, GraphResult, RefsResult } from "./api";
import { fileLabel, patchHtml, statsHtml, STATUS_LETTER } from "./diff";
import { graphWidthPx, renderGraph, ROW_H } from "./graph";
import { $, escapeHtml, formatDate, toast } from "./util";

const PAGE = 1000;

interface AppUiState {
  repoPath: string | null; // display path, used as persistence key
  refs: RefsResult | null;
  enabled: Set<string>; // full ref names
  graph: GraphResult | null;
  limit: number;
  selectedId: string | null;
  details: CommitDetails | null;
  selectedFile: number;
  /// Which pane arrow keys act on.
  focus: "commits" | "files";
}

const state: AppUiState = {
  repoPath: null,
  refs: null,
  enabled: new Set(),
  graph: null,
  limit: PAGE,
  selectedId: null,
  details: null,
  selectedFile: 0,
  focus: "commits",
};

const el = {
  openRepo: $("open-repo"),
  openRepoEmpty: $("open-repo-empty"),
  refresh: $("refresh"),
  repoName: $("repo-name"),
  repoPath: $("repo-path"),
  toggleDetails: $("toggle-details"),
  themeToggle: $("theme-toggle"),
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

// --------------------------------------------------------------------- theme

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

function refItemHtml(b: BranchInfo, label: string, isHead: boolean): string {
  const checked = state.enabled.has(b.full_name);
  return (
    `<label class="ref-item${isHead ? " head" : ""}" title="${escapeHtml(b.full_name)}">` +
    `<input type="checkbox" data-ref="${escapeHtml(b.full_name)}" ${checked ? "checked" : ""}/>` +
    `<span class="ref-name">${escapeHtml(label)}</span>` +
    (isHead ? `<span class="head-dot" title="Current branch">●</span>` : "") +
    (checked
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

  const svgH = g.rows.length * ROW_H + (g.has_more ? ROW_H / 2 : 0);
  el.graphSvg.setAttribute("width", String(graphW));
  el.graphSvg.setAttribute("height", String(svgH));
  el.graphSvg.innerHTML = renderGraph(g.rows, g.head_id);

  el.loadMore.hidden = !g.has_more;
  el.listEmpty.hidden = g.rows.length > 0;
}

async function refreshGraph(): Promise<void> {
  if (!state.repoPath) return;
  try {
    state.graph = await backend.getGraph([...state.enabled], state.limit);
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

function selectFile(i: number): void {
  const files = state.details?.files ?? [];
  if (files.length === 0) return;
  state.selectedFile = Math.min(Math.max(0, i), files.length - 1);
  for (const c of el.fileList.children) {
    c.classList.toggle(
      "selected",
      (c as HTMLElement).dataset.i === String(state.selectedFile),
    );
  }
  el.fileList.children[state.selectedFile]?.scrollIntoView({ block: "nearest" });
  renderDiff();
}

async function selectCommit(id: string, scrollTo = false): Promise<void> {
  setFocus("commits");
  state.selectedId = id;
  for (const row of el.rows.children) {
    row.classList.toggle("selected", (row as HTMLElement).dataset.id === id);
  }
  if (scrollTo) {
    el.rows
      .querySelector(`[data-id="${id}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }
  try {
    state.details = await backend.getCommitDetails(id);
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

function renderDetails(): void {
  const d = state.details;
  if (!d) {
    el.detailMeta.innerHTML = `<div class="detail-empty">Select a commit to see its details.</div>`;
    el.fileList.innerHTML = "";
    el.diffView.innerHTML = "";
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
  if (d.files.length === 0) {
    el.fileList.innerHTML = `<div class="detail-empty">No changes vs first parent.</div>`;
  }
  renderDiff();
}

function renderDiff(): void {
  const f = state.details?.files[state.selectedFile];
  el.diffView.innerHTML = f ? patchHtml(f) : "";
}

function setDetailsVisible(visible: boolean): void {
  el.details.hidden = !visible;
  el.splitter.hidden = !visible;
  el.toggleDetails.classList.toggle("active", visible);
  store.setDetailsVisible(visible);
  if (!visible) setFocus("commits");
}

// ------------------------------------------------------------------ open repo

async function openRepo(path: string): Promise<void> {
  let info;
  try {
    info = await backend.openRepo(path);
  } catch (e) {
    toast(`Could not open repository: ${e}`);
    if (backend.fixedRepo) el.emptyHint.textContent = `Server error: ${e}`;
    return;
  }
  state.repoPath = info.display_path;
  state.limit = PAGE;
  state.selectedId = null;
  state.details = null;
  if (!backend.fixedRepo) store.setLastRepo(path);
  el.repoName.textContent = info.name;
  el.repoPath.textContent = info.display_path;
  el.emptyState.hidden = true;

  try {
    state.refs = await backend.listRefs();
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
  renderSidebar();
  renderDetails();
  await refreshGraph();
}

/// Re-read refs and commits from disk, keeping the current branch selection
/// (minus refs that no longer exist; new branches start unchecked).
async function refreshAll(): Promise<void> {
  if (!state.repoPath) return;
  try {
    state.refs = await backend.listRefs();
  } catch (e) {
    toast(`Refresh failed: ${e}`);
    return;
  }
  const existing = new Set(
    [...state.refs.locals, ...state.refs.remotes].map((b) => b.full_name),
  );
  state.enabled = new Set([...state.enabled].filter((r) => existing.has(r)));
  persistEnabled();
  renderSidebar();
  await refreshGraph();
  // The selected commit's refs/details may have changed (e.g. new tag).
  if (state.selectedId && state.graph?.rows.some((r) => r.id === state.selectedId)) {
    await selectCommit(state.selectedId);
  }
}

async function chooseRepo(): Promise<void> {
  const dir = await backend.pickRepo?.();
  if (dir) await openRepo(dir);
}

// -------------------------------------------------------------------- wiring

function wire(): void {
  // The web build browses whichever repository the server was pointed at, so
  // there is nothing to choose.
  el.openRepo.hidden = backend.fixedRepo;
  el.openRepoEmpty.hidden = backend.fixedRepo;
  if (backend.fixedRepo) {
    el.emptyHint.textContent = "Connecting to the commit-browser server…";
  } else {
    el.openRepo.addEventListener("click", () => void chooseRepo());
    el.openRepoEmpty.addEventListener("click", () => void chooseRepo());
  }
  el.refresh.addEventListener("click", () => void refreshAll());
  el.loadMore.addEventListener("click", () => {
    state.limit += PAGE;
    void refreshGraph();
  });

  // Branch checkboxes (delegated).
  for (const list of [el.localBranches, el.remoteBranches]) {
    list.addEventListener("change", (ev) => {
      const cb = ev.target as HTMLInputElement;
      const ref = cb.dataset.ref;
      if (!ref) return;
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
    if ((ev.target as HTMLElement).tagName === "INPUT") return;
    const delta = ev.key === "ArrowDown" ? 1 : -1;

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
    if (next !== cur) void selectCommit(g.rows[next].id, true);
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
  el.toggleDetails.addEventListener("click", () => setDetailsVisible(el.details.hidden));
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
  applyTheme();
  applySectionCollapse();
  setFocus("commits");
  el.branchSort.value = store.branchSort();
  el.details.style.height = `${store.detailsHeight()}px`;
  setDetailsVisible(store.detailsVisible());
  renderDetails();
  // The server picks the repository for the web build, which ignores the path;
  // the desktop build reopens whatever was open last.
  const last = backend.fixedRepo ? "" : store.lastRepo();
  if (last !== null) await openRepo(last);
}

void init();
