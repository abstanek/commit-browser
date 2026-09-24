import type { FileDiff } from "./api";
import { coversRange, rangeAt, type Range } from "./collapse";
import { imageHtml } from "./imageview";
import { escapeHtml } from "./util";

export const STATUS_LETTER: Record<string, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  typechange: "T",
  conflict: "C",
};

/// Added/removed counts, or a marker for files with no readable patch.
export function statsHtml(f: FileDiff): string {
  if (f.status === "conflict") return `<span class="filestat conflict">conflict</span>`;
  return f.binary
    ? `<span class="filestat">bin</span>`
    : `<span class="filestat add">+${f.additions}</span>` +
        `<span class="filestat del">−${f.deletions}</span>`;
}

export function fileLabel(f: FileDiff): string {
  return f.old_path
    ? `${escapeHtml(f.old_path)} → ${escapeHtml(f.path)}`
    : escapeHtml(f.path);
}

function lineClass(line: string): string {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("diff --git") || line.startsWith("index ")) return "meta";
  if (line.startsWith("new file") || line.startsWith("deleted file")) return "meta";
  if (line.startsWith("similarity") || line.startsWith("rename")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

/// Where each hunk's body starts and ends: from just after its @@ header to
/// the line before the next one.
export function hunkBodies(lines: string[]): Map<number, Range> {
  const heads = lines.flatMap((l, i) => (l.startsWith("@@") ? [i] : []));
  const bodies = new Map<number, Range>();
  heads.forEach((head, k) => {
    const end = (heads[k + 1] ?? lines.length) - 1;
    if (end > head) bodies.set(head, [head + 1, end]);
  });
  return bodies;
}

/// How many lines one press of a "load more" row lets in.
const MORE_STEP = 20;

/// Lines of the file let in beyond its hunks. They are read from the file as it
/// stands after the change - context is the same on both sides, so one side
/// will do - and drawn as rows outside the patch's own numbering: folds and
/// picked lines count patch lines, and must not shift when context arrives.
export interface Context {
  /// How many lines are showing above and below each hunk, keyed by the patch
  /// index of its @@ header.
  shown: Map<number, Room>;
  /// The file after the change, line by line, once it has been fetched.
  text: string[] | null;
}

export interface Room {
  above: number;
  below: number;
}

/// Where a hunk sits in the file after the change: lines [start, end), from 1.
interface Hunk {
  head: number;
  start: number;
  end: number;
}

function hunks(lines: string[]): Hunk[] {
  return lines.flatMap((line, head) => {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) return [];
    const count = m[2] === undefined ? 1 : Number(m[2]);
    // A hunk that leaves nothing behind names the line before it, not its first.
    const start = count === 0 ? Number(m[1]) + 1 : Number(m[1]);
    return [{ head, start, end: start + count }];
  });
}

/// Whether there is a file to read more of: a patch cut short has hunks that
/// cannot be trusted, and a deletion leaves nothing behind to read.
function expandable(f: FileDiff): boolean {
  return !f.binary && !f.truncated && f.status !== "deleted" && f.lines > 0;
}

/// How many lines are still out of sight above and below each hunk, keyed like
/// `Context.shown`. Two hunks share the gap between them, so what either has
/// let in comes off what is left for both.
export function room(f: FileDiff, ctx?: Context): Map<number, Room> {
  const left = new Map<number, Room>();
  if (!expandable(f)) return left;
  const all = hunks(f.patch.split("\n"));
  // The text can fall short of the count when the file was too big to send whole.
  const total = ctx?.text ? Math.min(f.lines, ctx.text.length) : f.lines;
  const shown = (h?: Hunk): Room => (h && ctx?.shown.get(h.head)) || { above: 0, below: 0 };
  all.forEach((h, k) => {
    const before = all[k - 1];
    const after = all[k + 1];
    const above = h.start - (before ? before.end : 1) - shown(h).above - shown(before).below;
    const below = (after ? after.start : total + 1) - h.end - shown(h).below - shown(after).above;
    left.set(h.head, { above: Math.max(0, above), below: Math.max(0, below) });
  });
  return left;
}

/// What one press on a "load more" row should let in.
export function moreStep(left: number): number {
  return Math.min(MORE_STEP, left);
}

function moreRow(head: number, side: keyof Room, left: number): string {
  const n = moreStep(left);
  return (
    `<div class="dl more" data-more="${side}" data-hunk="${head}">` +
    `Load ${n} more line${n === 1 ? "" : "s"}</div>`
  );
}

function contextRows(text: string[], from: number, count: number): string {
  return text
    .slice(from - 1, from - 1 + count)
    .map((line) => `<div class="dl ctx">${escapeHtml(` ${line}`)}</div>`)
    .join("");
}

/// A unified patch as coloured lines. Lines inside a folded range collapse to a
/// single placeholder, and hunk headers carry the extent of their body so they
/// can be folded whole.
///
/// A binary file has no patch to draw. An image is shown instead, as it stands
/// at the revision being read: `at` says where to read it from.
///
/// Each hunk is offered more of the file around it, and `ctx` is what has been
/// let in so far. A hunk folded away whole gets neither: it has been dismissed.
export function patchHtml(
  f: FileDiff,
  folds: Range[] = [],
  at?: { repo: string; rev: string },
  ctx?: Context,
): string {
  if (f.status === "conflict") {
    return (
      `<div class="detail-empty">Both sides have changed this file, differently. ` +
      `A merge would stop here for it to be resolved by hand.</div>`
    );
  }
  if (f.binary) {
    // A deleted file is not at this revision to be read.
    if (f.image && at && f.status !== "deleted") {
      return imageHtml(at.repo, at.rev, f.path, f.size);
    }
    return `<div class="detail-empty">Binary file.</div>`;
  }
  const lines = f.patch.split("\n");
  // The newline a patch ends on finishes its last line; it does not start another.
  if (lines[lines.length - 1] === "") lines.pop();
  const bodies = hunkBodies(lines);
  const out: string[] = [];

  // Without somewhere to read the file from there is nothing to offer, and a
  // hunk folded out of sight, header or body, is not offered anything either.
  const left = at ? room(f, ctx) : new Map<number, Room>();
  const all = hunks(lines);
  const offered = new Map(
    all
      .filter((h) => {
        const body = bodies.get(h.head);
        const dismissed = body && coversRange(folds, body[0], body[1]);
        return left.has(h.head) && !rangeAt(folds, h.head) && !dismissed;
      })
      .map((h) => [h.head, h]),
  );
  /// The hunk whose body is being drawn, which is still owed its rows below.
  let open: Hunk | null = null;
  const close = (): void => {
    if (!open) return;
    const below = left.get(open.head)?.below ?? 0;
    const shown = ctx?.shown.get(open.head)?.below ?? 0;
    if (ctx?.text && shown) out.push(contextRows(ctx.text, open.end, shown));
    if (below) out.push(moreRow(open.head, "below", below));
    open = null;
  };

  for (let i = 0; i < lines.length; i++) {
    if (open && i > (bodies.get(open.head)?.[1] ?? open.head)) close();
    const fold = rangeAt(folds, i);
    if (fold) {
      const hidden = fold[1] - fold[0] + 1;
      out.push(
        `<div class="dl fold" data-fold="${fold[0]}" data-fold-end="${fold[1]}">` +
          `⋯ ${hidden} line${hidden === 1 ? "" : "s"} hidden</div>`,
      );
      i = fold[1];
      continue;
    }
    const line = lines[i];
    const cls = lineClass(line);
    const body = bodies.get(i);
    const toggle = body
      ? `<span class="hunk-toggle" data-body="${body[0]}" data-body-end="${body[1]}">` +
        `${coversRange(folds, body[0], body[1]) ? "▸" : "▾"}</span>`
      : "";
    const hunk = offered.get(i);
    if (hunk) {
      const above = left.get(i)!.above;
      // A gap small enough to arrive in one press is left to the hunk above it
      // to offer, so the two do not both ask for the same few lines.
      const before = all[all.indexOf(hunk) - 1];
      const theirs = before && offered.has(before.head) && above <= MORE_STEP;
      if (above && !theirs) out.push(moreRow(i, "above", above));
      // Ahead of the header rather than under it, so the header goes on
      // describing exactly the lines that follow it.
      const shown = ctx?.shown.get(i)?.above ?? 0;
      if (ctx?.text && shown) out.push(contextRows(ctx.text, hunk.start - shown, shown));
      open = hunk;
    }
    out.push(
      `<div class="dl ${cls}" data-line="${i}">${toggle}${escapeHtml(line) || " "}</div>`,
    );
  }
  close();

  if (f.truncated) {
    out.push(`<div class="dl meta">… patch truncated (too large) …</div>`);
  }
  return `<pre class="diff">${out.join("")}</pre>`;
}
