/// Draggable dividers between panes. A divider sizes the pane it sits against
/// through a CSS variable on the root, so the rules that size those panes stay
/// in the stylesheet: `.vsplit` sets a width, `.hsplit` a height.
///
/// Sizes are stored in rem, like the list columns, so a pane keeps its
/// proportions when the text size changes.

const DEFAULT_MIN_PX = 120;
/// Panes stop well short of swallowing the window.
const MAX_FRACTION = 0.7;

type Widths = Record<string, number>;

function read(): Widths {
  const raw = localStorage.getItem("panes");
  try {
    return raw ? (JSON.parse(raw) as Widths) : {};
  } catch {
    return {};
  }
}

function write(widths: Widths): void {
  localStorage.setItem("panes", JSON.stringify(widths));
}

function rootFontSize(): number {
  return parseFloat(getComputedStyle(document.documentElement).fontSize);
}

function setSize(name: string, rem: number): void {
  document.documentElement.style.setProperty(name, `${rem}rem`);
}

const HANDLES = ".vsplit, .hsplit";

export function applyPanes(): void {
  const sizes = read();
  for (const handle of document.querySelectorAll<HTMLElement>(HANDLES)) {
    const stored = sizes[handle.dataset.key!];
    if (stored) setSize(handle.dataset.var!, stored);
  }
}

export function wirePanes(): void {
  for (const handle of document.querySelectorAll<HTMLElement>(HANDLES)) {
    const name = handle.dataset.var!;
    const key = handle.dataset.key!;
    const vertical = handle.classList.contains("hsplit");
    const min = Number(handle.dataset.min) || DEFAULT_MIN_PX;
    // The pane a divider resizes is the one it sits against.
    const pane = handle.previousElementSibling as HTMLElement;

    handle.addEventListener("mousedown", (down) => {
      down.preventDefault();
      const start = vertical ? down.clientY : down.clientX;
      const rect = pane.getBoundingClientRect();
      const startSize = vertical ? rect.height : rect.width;
      let rem = startSize / rootFontSize();
      handle.classList.add("dragging");

      const move = (ev: MouseEvent) => {
        const moved = (vertical ? ev.clientY : ev.clientX) - start;
        const limit = (vertical ? window.innerHeight : window.innerWidth) * MAX_FRACTION;
        const px = Math.min(Math.max(min, startSize + moved), limit);
        rem = px / rootFontSize();
        setSize(name, rem);
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        handle.classList.remove("dragging");
        write({ ...read(), [key]: rem });
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });

    handle.addEventListener("dblclick", () => {
      const widths = read();
      delete widths[key];
      write(widths);
      // Dropping the variable falls back to the stylesheet's default.
      document.documentElement.style.removeProperty(name);
    });
  }
}
