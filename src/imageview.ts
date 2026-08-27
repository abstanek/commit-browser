/// Images shown in place, in the diff and in the files view.
///
/// Both hosts hand over the bytes rather than a URL, because the desktop build
/// has no address to point an <img> at, so an image costs a round trip and its
/// own weight again in base64. Small ones are worth that without being asked;
/// past the threshold the reader says when, which matters most over the SSH
/// tunnel the web variant is built for.

import { backend } from "@backend";
import { escapeHtml, formatSize } from "./util";

/// Images at or below this appear on their own; larger ones wait to be asked
/// for.
const INLINE_LIMIT = 100 * 1024;

/// A placeholder for one image, filled in by `hydrate`. Everything it needs to
/// fetch the bytes rides on the element, so a redraw of the surrounding markup
/// carries it along.
export function imageHtml(repo: string, rev: string, path: string, size: number): string {
  const attrs =
    `data-image-repo="${escapeHtml(repo)}" data-image-rev="${escapeHtml(rev)}" ` +
    `data-image-path="${escapeHtml(path)}" data-image-size="${size}"`;
  const body =
    size <= INLINE_LIMIT
      ? ""
      : `<button class="btn image-show">Show image (${escapeHtml(formatSize(size))})</button>`;
  return `<div class="image-view" ${attrs}>${body}</div>`;
}

async function load(box: HTMLElement): Promise<void> {
  const { imageRepo, imageRev, imagePath } = box.dataset;
  if (!imageRepo || !imageRev || !imagePath) return;
  box.dataset.imageLoaded = "1";
  box.innerHTML = `<div class="image-note">Loading…</div>`;
  try {
    const img = await backend.readImage(imageRepo, imageRev, imagePath);
    box.innerHTML =
      `<img class="image-inline" alt="${escapeHtml(imagePath)}" ` +
      `src="data:${escapeHtml(img.mime)};base64,${img.base64}" />` +
      `<div class="image-note">${escapeHtml(formatSize(img.size))}</div>`;
  } catch (e) {
    // Leave it askable again: the failure may be the revision, not the file.
    delete box.dataset.imageLoaded;
    box.innerHTML = `<div class="image-note">Could not read the image: ${escapeHtml(String(e))}</div>`;
  }
}

/// Fill in any placeholder under `root` that has not been dealt with: the small
/// ones straight away, the rest once their button is pressed. Safe to call
/// again after a redraw, which is why loading is marked on the element.
export function hydrate(root: HTMLElement): void {
  for (const box of root.querySelectorAll<HTMLElement>(".image-view")) {
    if (box.dataset.imageLoaded) continue;
    if (Number(box.dataset.imageSize) <= INLINE_LIMIT) {
      void load(box);
      continue;
    }
    box.querySelector(".image-show")?.addEventListener("click", () => void load(box), {
      once: true,
    });
  }
}
