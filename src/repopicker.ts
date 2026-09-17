/// The repository selector in the toolbar: a button showing the open
/// repository over its path, and a drop-down listing the rest the same way.
///
/// A plain <select> can only show one line per option, and a repository needs
/// two - the name alone is not enough to tell two checkouts apart, and the path
/// alone is too long to read at a glance. So this is a listbox built out of
/// buttons, with the keyboard behaviour that implies written out.

import type { RepoInfo } from "./api";
import { createDropdown, type Dropdown } from "./dropdown";
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

let menu: Dropdown;

/// The rows, in the order they are drawn, for the keyboard to walk.
function rows(): HTMLButtonElement[] {
  return [...el.list.querySelectorAll<HTMLButtonElement>(".repo-option")];
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

export function wire(canEdit: boolean): void {
  editable = canEdit;
  menu = createDropdown({
    root: el.picker,
    button: el.button,
    menu: el.menu,
    rows,
    current: () => rows().find((r) => r.dataset.repo === current),
  });

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
    menu.close();
    if (option.dataset.repo !== current) selectCb(option.dataset.repo!);
  });

  el.add.addEventListener("click", () => {
    // Put the menu away without pulling focus back to the trigger: this action
    // opens a window of its own, and focus belongs wherever that leads.
    menu.close(false);
    addCb();
  });
}
