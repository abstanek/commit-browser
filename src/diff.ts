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
};

/// Added/removed counts, or a marker for files with no readable patch.
export function statsHtml(f: FileDiff): string {
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

/// A unified patch as coloured lines. Lines inside a folded range collapse to a
/// single placeholder, and hunk headers carry the extent of their body so they
/// can be folded whole.
///
/// A binary file has no patch to draw. An image is shown instead, as it stands
/// at the revision being read: `at` says where to read it from.
export function patchHtml(
  f: FileDiff,
  folds: Range[] = [],
  at?: { repo: string; rev: string },
): string {
  if (f.binary) {
    // A deleted file is not at this revision to be read.
    if (f.image && at && f.status !== "deleted") {
      return imageHtml(at.repo, at.rev, f.path, f.size);
    }
    return `<div class="detail-empty">Binary file.</div>`;
  }
  const lines = f.patch.split("\n");
  const bodies = hunkBodies(lines);
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
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
    out.push(
      `<div class="dl ${cls}" data-line="${i}">${toggle}${escapeHtml(line) || " "}</div>`,
    );
  }

  if (f.truncated) {
    out.push(`<div class="dl meta">… patch truncated (too large) …</div>`);
  }
  return `<pre class="diff">${out.join("")}</pre>`;
}
