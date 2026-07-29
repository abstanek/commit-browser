import type { GraphRow } from "./api";

export const ROW_H = 26;
export const COL_W = 14;
const PAD_L = 8;
const NODE_R = 4;

export const PALETTE = [
  "#2f6fe4",
  "#d9822b",
  "#38a05c",
  "#c74a4a",
  "#8657c9",
  "#2a9d9f",
  "#c94f9e",
  "#7a8c1e",
  "#5b6ee1",
  "#b3763a",
];

export function graphWidthPx(columns: number): number {
  return PAD_L + Math.max(columns, 1) * COL_W + 8;
}

function cx(col: number): number {
  return PAD_L + col * COL_W + COL_W / 2;
}

function cy(row: number): number {
  return row * ROW_H + ROW_H / 2;
}

function color(idx: number): string {
  return PALETTE[idx % PALETTE.length];
}

/** Render the whole graph column as SVG inner markup. */
export function renderGraph(rows: GraphRow[], headId: string | null): string {
  const parts: string[] = [];

  // Edges below each row first, nodes on top.
  rows.forEach((row, i) => {
    const y1 = cy(i);
    const y2 = cy(i + 1);
    for (const e of row.edges) {
      const x1 = cx(e.from);
      const x2 = cx(e.to);
      const stroke = color(e.color);
      if (x1 === x2) {
        parts.push(
          `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="2"/>`,
        );
      } else {
        const bend = ROW_H * 0.6;
        parts.push(
          `<path d="M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}" ` +
            `stroke="${stroke}" stroke-width="2" fill="none"/>`,
        );
      }
    }
  });

  rows.forEach((row, i) => {
    const x = cx(row.column);
    const y = cy(i);
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
