import type { FileDiff } from "./api";
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

/// A unified patch as coloured lines.
export function patchHtml(f: FileDiff): string {
  if (f.binary) return `<div class="detail-empty">Binary file.</div>`;
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
  return `<pre class="diff">${out.join("")}</pre>`;
}
