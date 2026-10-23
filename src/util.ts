export function escapeHtml(s: string): string {
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

export function formatDate(seconds: number): string {
  return dateFmt.format(new Date(seconds * 1000));
}

export function toast(msg: string): void {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

/// "refs/remotes/origin/main" reads as "origin/main".
export function shortRef(full: string): string {
  return full.replace(/^refs\/(heads|remotes|tags)\//, "");
}

/// Byte counts as a reader wants them: whole units, no more precision than the
/// number deserves.
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} M`;
}

/// Put `text` on the clipboard and say so. Falls back to the selection-based
/// copy for a webview that has no clipboard API, and reports either failing.
export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const holder = document.createElement("textarea");
      holder.value = text;
      holder.setAttribute("readonly", "");
      holder.style.position = "fixed";
      holder.style.opacity = "0";
      document.body.appendChild(holder);
      holder.select();
      const ok = document.execCommand("copy");
      holder.remove();
      if (!ok) throw new Error("the copy command was refused");
    }
    toast(`Copied ${text}`);
  } catch (e) {
    toast(`Could not copy: ${e}`);
  }
}
