use super::*;
use git2::{Repository, Signature, Time};
use tempfile::TempDir;

struct TestRepo {
    _dir: TempDir,
    repo: Repository,
    path: String,
    clock: i64,
}

impl TestRepo {
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        let path = repo.path().to_string_lossy().into_owned();
        TestRepo { _dir: dir, repo, path, clock: 1_700_000_000 }
    }

    /// Create a commit with the given parents and file contents, and point
    /// `refs/heads/<branch>` at it.
    fn commit(&mut self, branch: &str, parents: &[Oid], files: &[(&str, &str)]) -> Oid {
        self.clock += 60;
        let sig = Signature::new("Test", "test@example.com", &Time::new(self.clock, 0)).unwrap();
        let base = parents
            .first()
            .map(|&p| self.repo.find_commit(p).unwrap().tree().unwrap());
        let mut tb = self.repo.treebuilder(base.as_ref()).unwrap();
        for (name, content) in files {
            let blob = self.repo.blob(content.as_bytes()).unwrap();
            tb.insert(name, blob, 0o100644).unwrap();
        }
        let tree = self.repo.find_tree(tb.write().unwrap()).unwrap();
        let parent_commits: Vec<_> = parents
            .iter()
            .map(|&p| self.repo.find_commit(p).unwrap())
            .collect();
        let parent_refs: Vec<_> = parent_commits.iter().collect();
        let msg = format!("commit on {branch} at {}", self.clock);
        let oid = self
            .repo
            .commit(None, &sig, &sig, &msg, &tree, &parent_refs)
            .unwrap();
        self.repo
            .reference(&format!("refs/heads/{branch}"), oid, true, "test")
            .unwrap();
        oid
    }
}

/// A -- B -- M -- F   (main)
///  \       /
///   C ----          (feature)
/// B -- T            (topic, not merged)
fn sample() -> (TestRepo, Vec<Oid>) {
    let mut t = TestRepo::new();
    let a = t.commit("main", &[], &[("f.txt", "a\n")]);
    let c = t.commit("feature", &[a], &[("feat.txt", "c\n")]);
    let b = t.commit("main", &[a], &[("f.txt", "a\nb\n")]);
    let tt = t.commit("topic", &[b], &[("topic.txt", "t\n")]);
    let m = t.commit("main", &[b, c], &[("f.txt", "a\nb\n"), ("feat.txt", "c\n")]);
    let f = t.commit("main", &[m], &[("f.txt", "a\nb\nf\n")]);
    t.repo.set_head("refs/heads/main").unwrap();
    (t, vec![a, b, c, tt, m, f])
}

fn ids(rows: &[GraphRow]) -> Vec<String> {
    rows.iter().map(|r| r.id.clone()).collect()
}

#[test]
fn open_and_list_refs() {
    let (t, oids) = sample();
    let info = open_repo(&t.path).unwrap();
    assert!(!info.name.is_empty());
    let refs = list_refs(&t.path).unwrap();
    let names: Vec<_> = refs.locals.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(names, vec!["feature", "main", "topic"]);
    assert!(refs.remotes.is_empty());
    // Tip times reflect commit order: feature (oids[2]) is older than main's tip.
    let by_name = |n: &str| refs.locals.iter().find(|b| b.name == n).unwrap();
    assert!(by_name("feature").tip_time < by_name("main").tip_time);
    assert_eq!(by_name("main").target, oids[5].to_string());
}

#[test]
fn remote_branches_grouped_by_remote() {
    let (t, oids) = sample();
    t.repo.remote("origin", "https://example.invalid/r.git").unwrap();
    t.repo.remote("upstream", "https://example.invalid/u.git").unwrap();
    t.repo
        .reference("refs/remotes/origin/main", oids[5], true, "test")
        .unwrap();
    // Branch name containing a slash must still resolve to the right remote.
    t.repo
        .reference("refs/remotes/origin/feat/x", oids[2], true, "test")
        .unwrap();
    t.repo
        .reference("refs/remotes/upstream/main", oids[4], true, "test")
        .unwrap();

    let refs = list_refs(&t.path).unwrap();
    assert_eq!(refs.remotes.len(), 3);
    let by_name = |n: &str| refs.remotes.iter().find(|b| b.name == n).unwrap();
    assert_eq!(by_name("origin/main").remote.as_deref(), Some("origin"));
    assert_eq!(by_name("origin/feat/x").remote.as_deref(), Some("origin"));
    assert_eq!(by_name("upstream/main").remote.as_deref(), Some("upstream"));
}

#[test]
fn branch_filtering_hides_unreachable_commits() {
    let (t, oids) = sample();
    let [_a, _b, _c, topic, _m, _f] = oids[..] else { panic!() };

    // Only main enabled: topic's commit must not appear, feature's C must
    // (it was merged into main).
    let g = graph(&t.path, &["refs/heads/main".into()], 100).unwrap();
    assert_eq!(g.rows.len(), 5);
    assert!(!ids(&g.rows).contains(&topic.to_string()));

    // Enable topic too: its commit appears.
    let g = graph(
        &t.path,
        &["refs/heads/main".into(), "refs/heads/topic".into()],
        100,
    )
    .unwrap();
    assert_eq!(g.rows.len(), 6);
    assert!(ids(&g.rows).contains(&topic.to_string()));

    // No branches enabled: empty graph.
    let g = graph(&t.path, &[], 100).unwrap();
    assert!(g.rows.is_empty());
}

/// Every visible parent must be reachable from its child along drawn edges:
/// the gap above a parent's row must contain an edge ending at its column,
/// and each commit with a visible parent must have an edge leaving its column.
fn check_edge_continuity(rows: &[GraphRow]) {
    for (i, row) in rows.iter().enumerate() {
        let child_of_earlier = rows[..i].iter().any(|r| r.parents.contains(&row.id));
        if child_of_earlier {
            assert!(
                rows[i - 1].edges.iter().any(|e| e.to == row.column),
                "row {i} ({}) has no incoming edge to column {}",
                row.short_id,
                row.column
            );
        }
        let visible_parent = row
            .parents
            .iter()
            .any(|p| rows[i + 1..].iter().any(|r| &r.id == p));
        if visible_parent {
            assert!(
                row.edges.iter().any(|e| e.from == row.column),
                "row {i} ({}) has no outgoing edge from column {}",
                row.short_id,
                row.column
            );
        }
    }
}

#[test]
fn layout_is_continuous_and_within_width() {
    let (t, _) = sample();
    let g = graph(
        &t.path,
        &["refs/heads/main".into(), "refs/heads/topic".into(), "refs/heads/feature".into()],
        100,
    )
    .unwrap();
    assert!(g.width >= 2, "merge history must use at least two columns");
    for row in &g.rows {
        assert!(row.column < g.width);
        for e in &row.edges {
            assert!(e.from < g.width && e.to < g.width);
        }
    }
    check_edge_continuity(&g.rows);
    // Topologically sorted: every parent appears after its child.
    let order: Vec<String> = ids(&g.rows);
    for (i, row) in g.rows.iter().enumerate() {
        for p in &row.parents {
            if let Some(pi) = order.iter().position(|x| x == p) {
                assert!(pi > i, "parent {p} appears before child");
            }
        }
    }
}

#[test]
fn limit_and_has_more() {
    let (t, _) = sample();
    let g = graph(&t.path, &["refs/heads/main".into()], 3).unwrap();
    assert_eq!(g.rows.len(), 3);
    assert!(g.has_more);
    // Truncated graph still shows lanes running off the bottom.
    assert!(!g.rows.last().unwrap().edges.is_empty());
    let g = graph(&t.path, &["refs/heads/main".into()], 100).unwrap();
    assert!(!g.has_more);
}

#[test]
fn ref_labels_present() {
    let (t, oids) = sample();
    let f = oids[5];
    let g = graph(&t.path, &["refs/heads/main".into()], 100).unwrap();
    let tip = g.rows.iter().find(|r| r.id == f.to_string()).unwrap();
    assert!(tip.refs.iter().any(|l| l.name == "main" && l.kind == "local"));
    assert_eq!(g.head_id, Some(f.to_string()));
}

#[test]
fn details_diff() {
    let (t, oids) = sample();
    let [_a, b, ..] = oids[..] else { panic!() };
    let d = commit_details(&t.path, &b.to_string()).unwrap();
    assert_eq!(d.files.len(), 1);
    let file = &d.files[0];
    assert_eq!(file.path, "f.txt");
    assert_eq!(file.status, "modified");
    assert_eq!(file.additions, 1);
    assert!(file.patch.contains("+b"));
    assert!(!d.parents.is_empty());
}

#[test]
fn details_root_commit() {
    let (t, oids) = sample();
    let d = commit_details(&t.path, &oids[0].to_string()).unwrap();
    assert!(d.parents.is_empty());
    assert_eq!(d.files.len(), 1);
    assert_eq!(d.files[0].status, "added");
}

#[test]
fn merge_commit_layout() {
    let (t, oids) = sample();
    let [a, b, c, _tt, m, _f] = oids[..] else { panic!() };
    let g = graph(
        &t.path,
        &["refs/heads/main".into(), "refs/heads/feature".into()],
        100,
    )
    .unwrap();
    let row_of = |oid: Oid| g.rows.iter().position(|r| r.id == oid.to_string()).unwrap();
    let (ri_m, ri_b, ri_c, ri_a) = (row_of(m), row_of(b), row_of(c), row_of(a));

    // Merge row must have two outgoing edges (one per parent).
    let mrow = &g.rows[ri_m];
    assert!(mrow.edges.len() >= 2, "merge should fan out to both parents");
    // B and C sit in different columns; A reconverges below both.
    assert_ne!(g.rows[ri_b].column, g.rows[ri_c].column);
    assert!(ri_a > ri_b && ri_a > ri_c);
    check_edge_continuity(&g.rows);
}
