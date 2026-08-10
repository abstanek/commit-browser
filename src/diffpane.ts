import type { FileDiff } from "./api";
import {
  addRange,
  loadFolds,
  type Range,
  rangeAt,
  removeRange,
  saveFolds,
} from "./collapse";
import { fileLabel, patchHtml, statsHtml, STATUS_LETTER } from "./diff";
import { escapeHtml } from "./util";

/// A scrolling stack of file diffs: reading past the end of one file runs
/// straight into the next, and the pane reports the change so the file list
/// beside it can follow. Patches are laid out in batches, so a branch touching
/// hundreds of files does not have to render every one up front.

const BATCH = 10;
/// How close to the bottom the reader gets before the next batch is added.
const PREFETCH = 800;

export interface DiffPane {
  /// Replace the contents. `empty` is shown when there are no files, and
  /// `scope` names what is being diffed, so folded lines are remembered
  /// against that comparison rather than leaking between commits.
  show(files: FileDiff[], empty: string, scope?: string): void;
  /// Make `index` current, optionally scrolling it to the top of the pane.
  select(index: number, scroll: boolean): void;
  /// Called when scrolling brings a different file to the top.
  onSelect(cb: (index: number) => void): void;
}

export function createDiffPane(root: HTMLElement): DiffPane {
  let files: FileDiff[] = [];
  let rendered = 0;
  let current = 0;
  let notify: (index: number) => void = () => {};
  /// Set while the pane scrolls itself, so a programmatic scroll is not
  /// mistaken for the reader moving to another file.
  let selfScroll = false;
  let pending = false;
  let scope = "";
  /// Folded line ranges per file index, and the line range being selected.
  let folds: Range[][] = [];
  let picked: { file: number; from: number; to: number } | null = null;

  function lineCount(index: number): number {
    return files[index].patch.split("\n").length;
  }

  function actionsHtml(index: number): string {
    const count = picked ? Math.abs(picked.to - picked.from) + 1 : 0;
    const selection =
      picked?.file === index
        ? `<button class="linkbtn fold-action" data-fold-selection>` +
          `Hide ${count} line${count === 1 ? "" : "s"}</button>`
        : "";
    const expand = (folds[index] ?? []).length
      ? `<button class="linkbtn fold-action" data-unfold-all>Show all</button>`
      : "";
    return selection + expand;
  }

  /// Refresh a header in place, so picking lines does not disturb the patch
  /// under the pointer mid-drag.
  function updateActions(index: number): void {
    const actions = blockAt(index)?.querySelector(".diff-actions");
    if (actions) actions.innerHTML = actionsHtml(index);
  }

  function blockHtml(f: FileDiff, index: number): string {
    const hidden = folds[index] ?? [];
    return (
      `<section class="diff-block" data-i="${index}">` +
      `<div class="diff-head">` +
      `<span class="status ${f.status}">${STATUS_LETTER[f.status] ?? "?"}</span>` +
      `<span class="diff-path">${fileLabel(f)}</span>${statsHtml(f)}` +
      `<span class="diff-actions">${actionsHtml(index)}</span></div>` +
      patchHtml(f, hidden) +
      `</section>`
    );
  }

  /// Redraw one file in place; the pane's other blocks keep their positions.
  function redraw(index: number): void {
    const block = blockAt(index);
    if (!block) return;
    block.outerHTML = blockHtml(files[index], index);
    markSelection();
  }

  function setFolds(index: number, next: Range[]): void {
    folds[index] = next;
    if (scope) saveFolds(scope, files[index].path, lineCount(index), next);
    redraw(index);
  }

  function markSelection(): void {
    for (const el of root.querySelectorAll<HTMLElement>(".dl[data-line]")) {
      const block = el.closest<HTMLElement>(".diff-block");
      const line = Number(el.dataset.line);
      const inPick =
        picked !== null &&
        Number(block?.dataset.i) === picked.file &&
        line >= Math.min(picked.from, picked.to) &&
        line <= Math.max(picked.from, picked.to);
      el.classList.toggle("picked", inPick);
    }
  }

  function setPick(index: number, from: number, to: number): void {
    const previous = picked?.file ?? null;
    picked = { file: index, from, to };
    markSelection();
    // One header loses the Hide button as the other gains it.
    if (previous !== null && previous !== index) updateActions(previous);
    updateActions(index);
  }

  function clearPick(): void {
    if (!picked) return;
    const index = picked.file;
    picked = null;
    markSelection();
    updateActions(index);
  }

  function renderThrough(index: number): void {
    const want = Math.min(files.length, Math.max(index + 1, rendered + BATCH));
    if (want <= rendered) return;
    root.insertAdjacentHTML(
      "beforeend",
      files
        .slice(rendered, want)
        .map((f, k) => blockHtml(f, rendered + k))
        .join(""),
    );
    rendered = want;
  }

  function blockAt(index: number): HTMLElement | null {
    return root.querySelector<HTMLElement>(`.diff-block[data-i="${index}"]`);
  }

  /// Which file's patch is under the top of the pane.
  function topmost(): number {
    const y = root.scrollTop + 8;
    let found = 0;
    for (const b of root.querySelectorAll<HTMLElement>(".diff-block")) {
      if (b.offsetTop > y) break;
      found = Number(b.dataset.i);
    }
    return found;
  }

  root.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    const block = target.closest<HTMLElement>(".diff-block");
    if (!block) return;
    const index = Number(block.dataset.i);

    if (target.closest("[data-unfold-all]")) {
      setFolds(index, []);
      return;
    }
    if (target.closest("[data-fold-selection]") && picked?.file === index) {
      const { from, to } = picked;
      picked = null;
      setFolds(index, addRange(folds[index] ?? [], from, to));
      return;
    }
    const hunk = target.closest<HTMLElement>(".hunk-toggle");
    if (hunk) {
      const from = Number(hunk.dataset.body);
      const to = Number(hunk.dataset.bodyEnd);
      const current = folds[index] ?? [];
      setFolds(
        index,
        rangeAt(current, from) ? removeRange(current, from, to) : addRange(current, from, to),
      );
      return;
    }
    const fold = target.closest<HTMLElement>(".dl.fold");
    if (fold) {
      const from = Number(fold.dataset.fold);
      setFolds(index, removeRange(folds[index] ?? [], from, Number(fold.dataset.foldEnd)));
      return;
    }
  });

  /// Line picking is a drag: press on a line, pull across the range, release.
  /// The browser's own text selection is left to run alongside and settled up
  /// on release, so selecting a bit of text to copy still works.
  let dragging = false;

  function lineUnder(target: EventTarget | null): { file: number; line: number } | null {
    const el = target as HTMLElement | null;
    const line = el?.closest<HTMLElement>(".dl[data-line]");
    const block = el?.closest<HTMLElement>(".diff-block");
    if (!line || !block) return null;
    return { file: Number(block.dataset.i), line: Number(line.dataset.line) };
  }

  root.addEventListener("mousedown", (ev) => {
    const target = ev.target as HTMLElement;
    if (ev.button !== 0 || target.closest("button, .hunk-toggle, .dl.fold")) return;
    const at = lineUnder(target);
    if (!at) return;
    dragging = true;
    // Shift keeps the existing anchor, for anyone who reaches for it.
    if (ev.shiftKey && picked?.file === at.file) setPick(at.file, picked.from, at.line);
    else setPick(at.file, at.line, at.line);
  });

  root.addEventListener("mousemove", (ev) => {
    if (!dragging || ev.buttons === 0 || !picked) return;
    const at = lineUnder(ev.target);
    if (!at || at.file !== picked.file || at.line === picked.to) return;
    setPick(picked.file, picked.from, at.line);
    // Once the drag spans lines it is a pick, not a copy: take the text
    // selection off the screen and stop it growing.
    if (picked.from !== picked.to) {
      root.classList.add("picking-lines");
      window.getSelection()?.removeAllRanges();
    }
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    root.classList.remove("picking-lines");
    const selection = window.getSelection();
    if (picked && picked.from !== picked.to) {
      // Dragging across lines picked them; drop the text it selected on the way.
      selection?.removeAllRanges();
    } else if (!(selection?.isCollapsed ?? true)) {
      // Text was dragged out within one line: that was a copy, not a pick.
      clearPick();
    }
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") clearPick();
  });

  root.addEventListener("scroll", () => {
    if (root.scrollTop + root.clientHeight >= root.scrollHeight - PREFETCH) {
      renderThrough(rendered);
    }
    if (selfScroll || pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const index = topmost();
      if (index !== current) {
        current = index;
        notify(index);
      }
    });
  });

  return {
    show(next, empty, nextScope = "") {
      files = next;
      scope = nextScope;
      picked = null;
      folds = files.map((f) =>
        scope ? loadFolds(scope, f.path, f.patch.split("\n").length) : [],
      );
      rendered = 0;
      current = 0;
      root.scrollTop = 0;
      root.innerHTML =
        files.length === 0 && empty ? `<div class="detail-empty">${escapeHtml(empty)}</div>` : "";
      renderThrough(0);
    },

    select(index, scroll) {
      if (index < 0 || index >= files.length) return;
      current = index;
      renderThrough(index);
      if (!scroll) return;
      const block = blockAt(index);
      if (!block) return;
      selfScroll = true;
      root.scrollTop = block.offsetTop;
      requestAnimationFrame(() => {
        selfScroll = false;
      });
    },

    onSelect(cb) {
      notify = cb;
    },
  };
}
