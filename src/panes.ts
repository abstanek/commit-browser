/// Draggable dividers between the side panes. Each divider sets the width of
/// the pane to its left through a CSS variable on the root, so the rules that
/// size those panes stay in the stylesheet.
///
/// Widths are stored in rem, like the list columns, so a pane keeps its
/// proportions when the text size changes.

const MIN_PX = 120;
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

function setWidth(name: string, rem: number): void {
  document.documentElement.style.setProperty(name, `${rem}rem`);
}

export function applyPanes(): void {
  const widths = read();
  for (const handle of document.querySelectorAll<HTMLElement>(".vsplit")) {
    const stored = widths[handle.dataset.key!];
    if (stored) setWidth(handle.dataset.var!, stored);
  }
}

export function wirePanes(): void {
  for (const handle of document.querySelectorAll<HTMLElement>(".vsplit")) {
    const name = handle.dataset.var!;
    const key = handle.dataset.key!;
    // The pane a divider resizes is the one it sits against.
    const pane = handle.previousElementSibling as HTMLElement;

    handle.addEventListener("mousedown", (down) => {
      down.preventDefault();
      const startX = down.clientX;
      const startW = pane.getBoundingClientRect().width;
      let rem = startW / rootFontSize();
      handle.classList.add("dragging");

      const move = (ev: MouseEvent) => {
        const px = Math.min(
          Math.max(MIN_PX, startW + ev.clientX - startX),
          window.innerWidth * MAX_FRACTION,
        );
        rem = px / rootFontSize();
        setWidth(name, rem);
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
