/// What a drop-down built out of buttons has to do for itself, getting none of
/// it from the browser the way a <select> does: opening and closing, the arrow
/// keys and Escape, and being put away when a click or the focus lands
/// somewhere else.

export interface Dropdown {
  open(): void;
  /// Hands focus back to the trigger unless told not to, which is for when
  /// whatever closed the menu is taking focus somewhere of its own.
  close(focusButton?: boolean): void;
  isOpen(): boolean;
}

export interface DropdownParts {
  /// Holds both the trigger and the menu; anything outside it is elsewhere.
  root: HTMLElement;
  button: HTMLButtonElement;
  menu: HTMLElement;
  /// The rows, in the order they are drawn, for the keyboard to walk.
  rows: () => HTMLElement[];
  /// The row focus lands on when the menu opens.
  current: () => HTMLElement | undefined;
}

export function createDropdown(parts: DropdownParts): Dropdown {
  const { root, button, menu, rows, current } = parts;

  function isOpen(): boolean {
    return !menu.hidden;
  }

  function open(): void {
    if (isOpen()) return;
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    (current() ?? rows()[0])?.focus();
  }

  function close(focusButton = true): void {
    if (!isOpen()) return;
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (focusButton) button.focus();
  }

  /// Move the keyboard through the rows, wrapping at both ends so holding a
  /// direction never dead-ends.
  function step(from: HTMLElement, delta: number): void {
    const all = rows();
    if (!all.length) return;
    const i = all.indexOf(from);
    const next = all[(((i < 0 ? 0 : i) + delta) % all.length + all.length) % all.length];
    next.focus();
  }

  button.addEventListener("click", () => (isOpen() ? close() : open()));

  // Keys are handled on the menu so they never reach the commit list, which
  // reads the arrows for its own navigation.
  menu.addEventListener("keydown", (e) => {
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
    if (isOpen() && !root.contains(e.target as Node)) close(false);
  });
  root.addEventListener("focusout", (e) => {
    // Where focus is going, which is known now and saves waiting for it to
    // land. Nowhere at all is not the reader leaving: macOS does not focus a
    // button when it is clicked, so every press inside the menu looks like
    // that, and closing on it took the menu away before the click arrived.
    const to = e.relatedTarget as Node | null;
    if (to && !root.contains(to)) close(false);
  });

  return { open, close, isOpen };
}
