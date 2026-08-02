import type { FileDiff } from "./api";
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
  /// Replace the contents. `empty` is shown when there are no files.
  show(files: FileDiff[], empty: string): void;
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

  function blockHtml(f: FileDiff, index: number): string {
    return (
      `<section class="diff-block" data-i="${index}">` +
      `<div class="diff-head">` +
      `<span class="status ${f.status}">${STATUS_LETTER[f.status] ?? "?"}</span>` +
      `<span class="diff-path">${fileLabel(f)}</span>${statsHtml(f)}</div>` +
      patchHtml(f) +
      `</section>`
    );
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
    show(next, empty) {
      files = next;
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
