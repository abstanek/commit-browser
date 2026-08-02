import type { GraphRow } from "./api";

export const COL_W = 14;
const PAD_L = 8;
const NODE_R = 4;

/// Height of one commit row, matching `.row { height: 2rem }`. Read from the
/// document so the graph follows the UI font size.
export function rowHeight(): number {
  return 2 * parseFloat(getComputedStyle(document.documentElement).fontSize);
}

/// Lane colours live in CSS (--lane-0 … --lane-9) so they follow the theme.
export const LANE_COLORS = 10;

export function graphWidthPx(columns: number): number {
  return PAD_L + Math.max(columns, 1) * COL_W + 8;
}

function cx(col: number): number {
  return PAD_L + col * COL_W + COL_W / 2;
}

function cy(row: number, rowH: number): number {
  return row * rowH + rowH / 2;
}

function color(idx: number): string {
  return `var(--lane-${idx % LANE_COLORS})`;
}

/** Render the whole graph column as SVG inner markup. */
export function renderGraph(rows: GraphRow[], headId: string | null): string {
  const parts: string[] = [];
  const rowH = rowHeight();

  // Edges below each row first, nodes on top.
  rows.forEach((row, i) => {
    const y1 = cy(i, rowH);
    const y2 = cy(i + 1, rowH);
    for (const e of row.edges) {
      const x1 = cx(e.from);
      const x2 = cx(e.to);
      const stroke = color(e.color);
      if (x1 === x2) {
        parts.push(
          `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="2"/>`,
        );
      } else {
        const bend = rowH * 0.6;
        parts.push(
          `<path d="M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}" ` +
            `stroke="${stroke}" stroke-width="2" fill="none"/>`,
        );
      }
    }
  });

  rows.forEach((row, i) => {
    const x = cx(row.column);
    const y = cy(i, rowH);
    const fill = color(row.color);
    if (row.id === headId) {
      parts.push(
        `<circle cx="${x}" cy="${y}" r="${NODE_R + 2.5}" fill="none" stroke="${fill}" stroke-width="1.5"/>`,
      );
    }
    const merge = row.parents.length > 1;
    parts.push(
      merge
        ? `<circle cx="${x}" cy="${y}" r="${NODE_R - 0.5}" fill="var(--bg-list)" stroke="${fill}" stroke-width="2"/>`
        : `<circle cx="${x}" cy="${y}" r="${NODE_R}" fill="${fill}" stroke="var(--bg-list)" stroke-width="1.5"/>`,
    );
  });

  return parts.join("");
}
