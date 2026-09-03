/// A card describing the commit behind a reference, shown on hover.
///
/// Not a title attribute, which cannot be read at length, cannot be selected,
/// and vanishes the moment the pointer moves. This stays while the pointer is
/// over either the reference or the card, so the reader can move into it, take
/// their time and copy out of it.
///
/// It carries what the details pane carries about a commit and nothing about
/// its diff: the same fields, read the same way, in a smaller space.

import type { CommitMeta } from "./api";
import { escapeHtml, formatDate } from "./util";

/// Long enough that running the pointer across a line of references does not
/// flash a card for each one.
const OPEN_DELAY = 300;
/// The gap between the reference and the card, which the pointer crosses on the
/// way in. Long enough to be crossed without hurrying.
const CLOSE_DELAY = 200;

let card: HTMLElement | null = null;
let openFor: string | null = null;
let openTimer: number | undefined;
let closeTimer: number | undefined;
/// Metadata already fetched, since a card is opened over and over.
const known = new Map<string, CommitMeta>();

function element(): HTMLElement {
  if (card) return card;
  card = document.createElement("div");
  card.id = "commit-card";
  card.hidden = true;
  // On the body rather than beside the reference, so no pane's overflow can
  // clip it.
  document.body.appendChild(card);
  card.addEventListener("pointerenter", () => clearTimeout(closeTimer));
  card.addEventListener("pointerleave", () => scheduleClose());
  return card;
}

function bodyHtml(m: CommitMeta): string {
  const chips = m.refs
    .map((l) => `<span class="chip ${l.kind}">${escapeHtml(l.name)}</span>`)
    .join("");
  return (
    `<div class="detail-row1"><span class="sha">${escapeHtml(m.id)}</span>${chips}</div>` +
    `<div class="detail-row2">` +
    `<span><b>${escapeHtml(m.author_name)}</b> &lt;${escapeHtml(m.author_email)}&gt;</span>` +
    `<span>${formatDate(m.author_time)}</span>` +
    (m.parents.length
      ? `<span>Parents: ${m.parents.map((p) => p.slice(0, 7)).join(", ")}</span>`
      : `<span>Root commit</span>`) +
    `</div>` +
    `<pre class="detail-message">${escapeHtml(m.message.trimEnd())}</pre>`
  );
}

/// Put the card beside `anchor`, below it where there is room and above it
/// where there is not, and never off the side of the window.
function place(anchor: HTMLElement): void {
  const el = element();
  const at = anchor.getBoundingClientRect();
  el.style.left = "0";
  el.style.top = "0";
  const box = el.getBoundingClientRect();
  const margin = 8;
  const left = Math.max(
    margin,
    Math.min(at.left, document.documentElement.clientWidth - box.width - margin),
  );
  const below = at.bottom + 6;
  const top =
    below + box.height + margin > document.documentElement.clientHeight && at.top - box.height - 6 > margin
      ? at.top - box.height - 6
      : below;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function scheduleClose(): void {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(hide, CLOSE_DELAY);
}

export function hide(): void {
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
  openFor = null;
  if (card) card.hidden = true;
}

async function show(anchor: HTMLElement, repo: string, id: string, load: Loader): Promise<void> {
  const el = element();
  openFor = id;
  let meta = known.get(id);
  if (!meta) {
    try {
      meta = await load(repo, id);
    } catch {
      // A commit that cannot be read is not worth a card, and not worth a
      // complaint either: nothing was asked for but a look.
      if (openFor === id) hide();
      return;
    }
    known.set(id, meta);
  }
  // The pointer may have moved on while that was in flight.
  if (openFor !== id) return;
  el.innerHTML = bodyHtml(meta);
  el.hidden = false;
  place(anchor);
}

type Loader = (repo: string, id: string) => Promise<CommitMeta>;

/// Watch `root` for hovers over anything carrying `data-commit`, and describe
/// that commit. `repo` is asked for at hover time, since it changes.
export function wire(root: HTMLElement, repo: () => string | null, load: Loader): void {
  root.addEventListener("pointerover", (e) => {
    const ref = (e.target as HTMLElement).closest<HTMLElement>("[data-commit]");
    if (!ref) return;
    const id = ref.dataset.commit!;
    clearTimeout(closeTimer);
    if (openFor === id && card && !card.hidden) return;
    clearTimeout(openTimer);
    openTimer = setTimeout(() => {
      const r = repo();
      if (r) void show(ref, r, id, load);
    }, OPEN_DELAY);
  });

  root.addEventListener("pointerout", (e) => {
    const ref = (e.target as HTMLElement).closest<HTMLElement>("[data-commit]");
    if (!ref) return;
    clearTimeout(openTimer);
    scheduleClose();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hide();
  });
}
