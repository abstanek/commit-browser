//! Lane layout for a commit graph.
//!
//! Commits arrive in topological order (children before parents). Each commit
//! is assigned a column ("lane") and a colour, and each row carries the list of
//! edge segments that run through the gap between it and the row below.

use git2::Oid;
use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Edge {
    pub from: usize,
    pub to: usize,
    pub color: usize,
}

#[derive(Debug, Clone)]
pub struct LayoutInput {
    pub id: Oid,
    pub parents: Vec<Oid>,
}

#[derive(Debug)]
pub struct LayoutRow {
    pub column: usize,
    pub color: usize,
    /// Edge segments between this row and the next one.
    pub edges: Vec<Edge>,
}

struct Lane {
    expected: Oid,
    color: usize,
}

/// Returns one row per commit plus the total number of columns used.
pub fn layout(commits: &[LayoutInput], continue_below: bool) -> (Vec<LayoutRow>, usize) {
    let mut lanes: Vec<Option<Lane>> = Vec::new();
    let mut next_color = 0usize;
    let mut width = 0usize;
    let mut rows: Vec<LayoutRow> = Vec::with_capacity(commits.len());

    // Lanes created while processing the previous row: their segment in the gap
    // above starts at the previous row's node column instead of their own lane.
    let mut births: Vec<(usize, usize)> = Vec::new(); // (lane index, origin column)
    // Merge edges from the previous row into lanes that already existed:
    // (origin column, target lane index, colour).
    let mut pending_merges: Vec<(usize, usize, usize)> = Vec::new();

    for (i, c) in commits.iter().enumerate() {
        let oid = c.id;

        // Which lanes were waiting for this commit?
        let waiting: Vec<usize> = lanes
            .iter()
            .enumerate()
            .filter(|(_, l)| l.as_ref().is_some_and(|l| l.expected == oid))
            .map(|(idx, _)| idx)
            .collect();

        let mut born_here: Option<usize> = None;
        let (col, color) = if let Some(&first) = waiting.first() {
            (first, lanes[first].as_ref().unwrap().color)
        } else {
            // A branch tip with no line from above: take the first free slot.
            let idx = match lanes.iter().position(|l| l.is_none()) {
                Some(idx) => idx,
                None => {
                    lanes.push(None);
                    lanes.len() - 1
                }
            };
            let color = next_color;
            next_color += 1;
            lanes[idx] = Some(Lane {
                expected: oid,
                color,
            });
            born_here = Some(idx);
            (idx, color)
        };

        // Finalize the edges of the gap between the previous row and this one.
        if i > 0 {
            let mut edges: Vec<Edge> = Vec::new();
            for (idx, slot) in lanes.iter().enumerate() {
                let Some(l) = slot else { continue };
                if born_here == Some(idx) {
                    continue; // new tip, nothing above it
                }
                let from = births
                    .iter()
                    .find(|(lane, _)| *lane == idx)
                    .map(|(_, origin)| *origin)
                    .unwrap_or(idx);
                let to = if l.expected == oid { col } else { idx };
                edges.push(Edge {
                    from,
                    to,
                    color: l.color,
                });
            }
            for (origin, lane_idx, ecolor) in pending_merges.drain(..) {
                let converges = lanes[lane_idx].as_ref().is_some_and(|l| l.expected == oid);
                let to = if converges { col } else { lane_idx };
                edges.push(Edge {
                    from: origin,
                    to,
                    color: ecolor,
                });
            }
            births.clear();
            rows[i - 1].edges = edges;
        } else {
            births.clear();
        }

        rows.push(LayoutRow {
            column: col,
            color,
            edges: Vec::new(),
        });
        width = width.max(lanes.len());

        // Update lane state for the rows below.
        for &idx in waiting.iter().filter(|&&idx| idx != col) {
            lanes[idx] = None; // merged into this node
        }
        match c.parents.first() {
            Some(&p0) => lanes[col].as_mut().unwrap().expected = p0,
            None => lanes[col] = None, // root commit
        }
        for &p in c.parents.iter().skip(1) {
            if p == c.parents[0] {
                continue;
            }
            if let Some(idx) = lanes
                .iter()
                .position(|l| l.as_ref().is_some_and(|l| l.expected == p))
            {
                if idx == col {
                    continue;
                }
                let ecolor = lanes[idx].as_ref().unwrap().color;
                pending_merges.push((col, idx, ecolor));
            } else {
                let idx = match lanes.iter().position(|l| l.is_none()) {
                    Some(idx) => idx,
                    None => {
                        lanes.push(None);
                        lanes.len() - 1
                    }
                };
                let color = next_color;
                next_color += 1;
                lanes[idx] = Some(Lane { expected: p, color });
                births.push((idx, col));
                width = width.max(lanes.len());
            }
        }
    }

    // If the walk was cut short, draw the still-active lanes running off the
    // bottom of the last row so the graph reads as "continues below".
    if continue_below {
        if let Some(last) = rows.last_mut() {
            for (idx, slot) in lanes.iter().enumerate() {
                let Some(l) = slot else { continue };
                let from = births
                    .iter()
                    .find(|(lane, _)| *lane == idx)
                    .map(|(_, origin)| *origin)
                    .unwrap_or(idx);
                last.edges.push(Edge {
                    from,
                    to: idx,
                    color: l.color,
                });
            }
            for (origin, lane_idx, ecolor) in pending_merges.drain(..) {
                last.edges.push(Edge {
                    from: origin,
                    to: lane_idx,
                    color: ecolor,
                });
            }
        }
    }

    (rows, width)
}
