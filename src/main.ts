import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  api,
  type BranchInfo,
  type CommitDetails,
  type GraphResult,
  type RefsResult,
} from "./api";
import { graphWidthPx, renderGraph, ROW_H } from "./graph";

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
};

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const el = {
  openRepo: $("open-repo"),
  openRepoEmpty: $("open-repo-empty"),
  repoName: $("repo-name"),
  repoPath: $("repo-path"),
  toggleDetails: $("toggle-details"),
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
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const dateFmt = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatDate(seconds: number): string {
  return dateFmt.format(new Date(seconds * 1000));
}

function toast(msg: string): void {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

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
};

// ------------------------------------------------------------------- sidebar

function renderBranchList(
  container: HTMLElement,
  branches: BranchInfo[],
  headBranch: string | null,
): void {
  container.innerHTML = branches
    .map((b) => {
      const checked = state.enabled.has(b.full_name) ? "checked" : "";
      const isHead = headBranch !== null && b.name === headBranch;
      return (
        `<label class="ref-item${isHead ? " head" : ""}" title="${escapeHtml(b.full_name)}">` +
        `<input type="checkbox" data-ref="${escapeHtml(b.full_name)}" ${checked}/>` +
        `<span class="ref-name">${escapeHtml(b.name)}</span>` +
        (isHead ? `<span class="head-dot" title="Current branch">●</span>` : "") +
        `</label>`
      );
    })
    .join("");
}

function renderSidebar(): void {
  if (!state.refs) return;
  renderBranchList(el.localBranches, state.refs.locals, state.refs.head_branch);
  renderBranchList(el.remoteBranches, state.refs.remotes, null);
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
    state.graph = await api.getGraph([...state.enabled], state.limit);
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

async function selectCommit(id: string, scrollTo = false): Promise<void> {
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
    state.details = await api.getCommitDetails(id);
    state.selectedFile = 0;
  } catch (e) {
    toast(`Failed to load commit: ${e}`);
    state.details = null;
  }
  renderDetails();
}

// -------------------------------------------------------------- details pane

const STATUS_LETTER: Record<string, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  typechange: "T",
};

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
      const stats = f.binary
        ? `<span class="filestat">bin</span>`
        : `<span class="filestat add">+${f.additions}</span><span class="filestat del">−${f.deletions}</span>`;
      const name = f.old_path
        ? `${escapeHtml(f.old_path)} → ${escapeHtml(f.path)}`
        : escapeHtml(f.path);
      return (
        `<div class="file-item${sel}" data-i="${i}" title="${escapeHtml(f.path)}">` +
        `<span class="status ${f.status}">${STATUS_LETTER[f.status] ?? "?"}</span>` +
        `<span class="file-name">${name}</span>${stats}</div>`
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
  if (!f) {
    el.diffView.innerHTML = "";
    return;
  }
  if (f.binary) {
    el.diffView.innerHTML = `<div class="detail-empty">Binary file.</div>`;
    return;
  }
  const out: string[] = [];
  for (const line of f.patch.split("\n")) {
    let cls = "ctx";
    if (line.startsWith("@@")) cls = "hunk";
    else if (line.startsWith("+++") || line.startsWith("---")) cls = "meta";
    else if (line.startsWith("diff --git") || line.startsWith("index ")) cls = "meta";
    else if (line.startsWith("new file") || line.startsWith("deleted file")) cls = "meta";
    else if (line.startsWith("similarity") || line.startsWith("rename")) cls = "meta";
    else if (line.startsWith("+")) cls = "add";
    else if (line.startsWith("-")) cls = "del";
    out.push(`<div class="dl ${cls}">${escapeHtml(line) || " "}</div>`);
  }
  if (f.truncated) {
    out.push(`<div class="dl meta">… patch truncated (too large) …</div>`);
  }
  el.diffView.innerHTML = `<pre class="diff">${out.join("")}</pre>`;
}

function setDetailsVisible(visible: boolean): void {
  el.details.hidden = !visible;
  el.splitter.hidden = !visible;
  el.toggleDetails.classList.toggle("active", visible);
  store.setDetailsVisible(visible);
}

// ------------------------------------------------------------------ open repo

async function openRepo(path: string): Promise<void> {
  let info;
  try {
    info = await api.openRepo(path);
  } catch (e) {
    toast(`Could not open repository: ${e}`);
    return;
  }
  state.repoPath = info.display_path;
  state.limit = PAGE;
  state.selectedId = null;
  state.details = null;
  store.setLastRepo(path);
  el.repoName.textContent = info.name;
  el.repoPath.textContent = info.display_path;
  el.emptyState.hidden = true;

  try {
    state.refs = await api.listRefs();
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

async function chooseRepo(): Promise<void> {
  const dir = await openDialog({
    directory: true,
    title: "Open git repository",
  });
  if (typeof dir === "string") await openRepo(dir);
}

// -------------------------------------------------------------------- wiring

function wire(): void {
  el.openRepo.addEventListener("click", () => void chooseRepo());
  el.openRepoEmpty.addEventListener("click", () => void chooseRepo());
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
      void refreshGraph();
    });
  }
  $("locals-all").addEventListener("click", () => setAll(state.refs?.locals ?? [], true));
  $("locals-none").addEventListener("click", () => setAll(state.refs?.locals ?? [], false));
  $("remotes-all").addEventListener("click", () => setAll(state.refs?.remotes ?? [], true));
  $("remotes-none").addEventListener("click", () => setAll(state.refs?.remotes ?? [], false));

  // Row selection (delegated).
  el.rows.addEventListener("click", (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>(".row");
    if (row?.dataset.id) void selectCommit(row.dataset.id);
  });

  // Keyboard navigation.
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowUp" && ev.key !== "ArrowDown") return;
    if ((ev.target as HTMLElement).tagName === "INPUT") return;
    const g = state.graph;
    if (!g || g.rows.length === 0) return;
    const cur = g.rows.findIndex((r) => r.id === state.selectedId);
    const next =
      cur === -1
        ? 0
        : Math.min(g.rows.length - 1, Math.max(0, cur + (ev.key === "ArrowDown" ? 1 : -1)));
    if (next !== cur) void selectCommit(g.rows[next].id, true);
    ev.preventDefault();
  });

  // File list selection + parent links (delegated).
  el.fileList.addEventListener("click", (ev) => {
    const item = (ev.target as HTMLElement).closest<HTMLElement>(".file-item");
    if (!item) return;
    state.selectedFile = Number(item.dataset.i);
    for (const c of el.fileList.children) {
      c.classList.toggle("selected", c === item);
    }
    renderDiff();
  });
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
  el.details.style.height = `${store.detailsHeight()}px`;
  setDetailsVisible(store.detailsVisible());
  renderDetails();
  const last = store.lastRepo();
  if (last) await openRepo(last);
}

void init();
