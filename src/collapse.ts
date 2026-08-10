/// Ranges of patch lines the reader has folded away, remembered per file.
///
/// A range is a pair of inclusive indices into the file's patch lines, which is
/// also how a folded hunk is stored: hunks are just the range between one @@
/// header and the next. Ranges are kept sorted and non-overlapping, so every
/// fold on screen corresponds to exactly one stored range.

export type Range = [number, number];

/// Line counts are stored alongside the ranges: if the patch has changed
/// length since, the old line numbers mean nothing and are dropped.
interface FileFolds {
  n: number;
  r: Range[];
}

type ScopeFolds = Record<string, FileFolds>;

function key(scope: string): string {
  return `folds:${scope}`;
}

function read(scope: string): ScopeFolds {
  const raw = localStorage.getItem(key(scope));
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ScopeFolds;
  } catch {
    return {};
  }
}

export function loadFolds(scope: string, file: string, lines: number): Range[] {
  const stored = read(scope)[file];
  return stored && stored.n === lines ? stored.r : [];
}

export function saveFolds(scope: string, file: string, lines: number, ranges: Range[]): void {
  const all = read(scope);
  if (ranges.length === 0) delete all[file];
  else all[file] = { n: lines, r: ranges };

  if (Object.keys(all).length === 0) localStorage.removeItem(key(scope));
  else localStorage.setItem(key(scope), JSON.stringify(all));
}

/// Add a range, merging it with any it touches so folds never overlap.
export function addRange(ranges: Range[], from: number, to: number): Range[] {
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  const merged: Range[] = [];
  let lo = start;
  let hi = end;
  for (const [s, e] of ranges) {
    // +1 so ranges that merely abut are joined rather than left adjacent.
    if (e + 1 < lo || s > hi + 1) merged.push([s, e]);
    else {
      lo = Math.min(lo, s);
      hi = Math.max(hi, e);
    }
  }
  merged.push([lo, hi]);
  merged.sort((a, b) => a[0] - b[0]);
  return merged;
}

/// Drop every range overlapping [from, to].
export function removeRange(ranges: Range[], from: number, to: number): Range[] {
  return ranges.filter(([s, e]) => e < from || s > to);
}

export function coversRange(ranges: Range[], from: number, to: number): boolean {
  return ranges.some(([s, e]) => s <= from && e >= to);
}

/// The fold hiding `line`, if any.
export function rangeAt(ranges: Range[], line: number): Range | null {
  return ranges.find(([s, e]) => s <= line && e >= line) ?? null;
}
