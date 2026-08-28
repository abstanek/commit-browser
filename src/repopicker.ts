/// The repository selector in the toolbar: a button showing the open
/// repository over its path, and a drop-down listing the rest the same way.
///
/// A plain <select> can only show one line per option, and a repository needs
/// two - the name alone is not enough to tell two checkouts apart, and the path
/// alone is too long to read at a glance. So this is a listbox built out of
/// buttons, with the keyboard behaviour that implies written out.

import type { RepoInfo } from "./api";
import { $, escapeHtml } from "./util";

const el = {
  picker: $("repo-picker"),
  button: $("repo-button") as HTMLButtonElement,
  name: $("repo-name"),
  path: $("repo-path"),
  menu: $("repo-menu"),
  list: $("repo-list"),
  add: $("repo-add") as HTMLButtonElement,
};

let repos: RepoInfo[] = [];
let current: string | null = null;
let selectCb: (repo: string) => void = () => {};
let addCb: () => void = () => {};
let removeCb: (repo: string) => void = () => {};
/// Whether the reader owns the list, which decides if rows can be removed and
/// if the drop-down has an add button under them.
let editable = false;

function isOpen(): boolean {
  return !el.menu.hidden;
}

/// The rows, in the order they are drawn, for the keyboard to walk.
function rows(): HTMLButtonElement[] {
  return [...el.list.querySelectorAll<HTMLButtonElement>(".repo-option")];
}

function open(): void {
  if (isOpen()) return;
  el.menu.hidden = false;
  el.button.setAttribute("aria-expanded", "true");
  const active = rows().find((r) => r.dataset.repo === current) ?? rows()[0];
  active?.focus();
}

function close(focusButton = true): void {
  if (!isOpen()) return;
  el.menu.hidden = true;
  el.button.setAttribute("aria-expanded", "false");
  if (focusButton) el.button.focus();
}

export function isMenuOpen(): boolean {
  return isOpen();
}

/// Draw the button and the list. Called whenever the set of repositories or the
/// open one changes.
export function render(list: RepoInfo[], open_: string | null): void {
  repos = list;
  current = open_;
  const info = repos.find((r) => r.display_path === current);
  el.name.textContent = info?.name ?? (repos.length ? "Select repository" : "No repository");
  el.path.textContent = info?.display_path ?? "";
  // Nothing to pick between and nothing to add: leave the button inert rather
  // than opening an empty menu.
  el.button.disabled = repos.length === 0 && !editable;

  el.list.innerHTML = repos
    .map((r) => {
      const on = r.display_path === current;
      return `<div class="repo-row${on ? " current" : ""}">
        <button class="repo-option" role="option" aria-selected="${on}" data-repo="${escapeHtml(r.display_path)}">
          <span class="repo-option-name">${escapeHtml(r.name)}</span>
          <span class="repo-option-path">${escapeHtml(r.display_path)}</span>
        </button>${
          editable
            ? `<button class="repo-remove" data-remove="${escapeHtml(r.display_path)}" title="Remove ${escapeHtml(r.name)} from the list. Nothing on disk is touched.">✕</button>`
            : ""
        }
      </div>`;
    })
    .join("");
  el.add.hidden = !editable;
  if (!repos.length) {
    el.list.innerHTML = `<p class="repo-empty">${
      editable ? "No repositories yet." : "The server was given no repositories."
    }</p>`;
  }
}

export function onSelect(cb: (repo: string) => void): void {
  selectCb = cb;
}

export function onAdd(cb: () => void): void {
  addCb = cb;
}

export function onRemove(cb: (repo: string) => void): void {
  removeCb = cb;
}

/// Move the keyboard through the rows, wrapping at both ends so holding a
/// direction never dead-ends.
function step(from: HTMLElement, delta: number): void {
  const all = rows();
  if (!all.length) return;
  const i = all.indexOf(from as HTMLButtonElement);
  const next = all[(((i < 0 ? 0 : i) + delta) % all.length + all.length) % all.length];
  next.focus();
}

export function wire(canEdit: boolean): void {
  editable = canEdit;

  el.button.addEventListener("click", () => (isOpen() ? close() : open()));

  el.list.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const remove = target.closest<HTMLElement>("[data-remove]");
    if (remove) {
      // Stop the click reaching the row behind it, which would select the
      // repository being taken out of the list.
      e.stopPropagation();
      removeCb(remove.dataset.remove!);
      return;
    }
    const option = target.closest<HTMLElement>(".repo-option");
    if (!option) return;
    close();
    if (option.dataset.repo !== current) selectCb(option.dataset.repo!);
  });

  el.add.addEventListener("click", () => {
    // Put the menu away without pulling focus back to the trigger: this action
    // opens a window of its own, and focus belongs wherever that leads.
    close(false);
    addCb();
  });

  // Keys are handled on the menu so they never reach the commit list, which
  // reads the arrows for its own navigation.
  el.menu.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement;
    switch (e.key) {
      case "ArrowDown":
        step(target, 1);
        break;
      case "ArrowUp":
        step(target, -1);
        break;
      case "Escape":
        close();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  });

  // A click anywhere else, or focus leaving the picker entirely, puts it away.
  document.addEventListener("pointerdown", (e) => {
    if (isOpen() && !el.picker.contains(e.target as Node)) close(false);
  });
  el.picker.addEventListener("focusout", (e) => {
    // Where focus is going, which is known now and saves waiting for it to
    // land. Nowhere at all is not the reader leaving: macOS does not focus a
    // button when it is clicked, so every press inside the menu looks like
    // that, and closing on it took the menu away before the click arrived.
    const to = e.relatedTarget as Node | null;
    if (to && !el.picker.contains(to)) close(false);
  });
}
