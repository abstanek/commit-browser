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
        TestRepo {
            _dir: dir,
            repo,
            path,
            clock: 1_700_000_000,
        }
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
    t.repo
        .remote("origin", "https://example.invalid/r.git")
        .unwrap();
    t.repo
        .remote("upstream", "https://example.invalid/u.git")
        .unwrap();
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
    let [_a, _b, _c, topic, _m, _f] = oids[..] else {
        panic!()
    };

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
        &[
            "refs/heads/main".into(),
            "refs/heads/topic".into(),
            "refs/heads/feature".into(),
        ],
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
    assert!(
        tip.refs
            .iter()
            .any(|l| l.name == "main" && l.kind == "local")
    );
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
    assert!(!d.meta.parents.is_empty());
}

#[test]
fn details_root_commit() {
    let (t, oids) = sample();
    let d = commit_details(&t.path, &oids[0].to_string()).unwrap();
    assert!(d.meta.parents.is_empty());
    assert_eq!(d.files.len(), 1);
    assert_eq!(d.files[0].status, "added");
}

#[test]
fn review_unmerged_branch() {
    let (t, oids) = sample();
    let [_a, b, _c, topic, _m, f] = oids[..] else {
        panic!()
    };
    let r = review(&t.path, "refs/heads/main", "refs/heads/topic").unwrap();

    assert_eq!(r.merge_base, Some(b.to_string()));
    assert_eq!(r.head_id, topic.to_string());
    assert_eq!(r.base_id, f.to_string());
    // Only the commit made on topic; main is ahead by C, M and F, since the
    // merge puts feature's commit on main too.
    let summaries: Vec<_> = r.commits.iter().map(|c| c.id.clone()).collect();
    assert_eq!(summaries, vec![topic.to_string()]);
    assert_eq!(r.behind, 3);
    assert!(!r.commits_truncated);

    // Diffed from the merge base, so main's later edits to f.txt are absent.
    let paths: Vec<_> = r.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, vec!["topic.txt"]);
    assert_eq!(r.files[0].status, "added");
}

#[test]
fn review_of_merged_branch_is_empty() {
    let (t, oids) = sample();
    let [_a, _b, c, ..] = oids[..] else { panic!() };
    let r = review(&t.path, "refs/heads/main", "refs/heads/feature").unwrap();
    // feature is contained in main: nothing to merge, but it is behind.
    assert!(r.commits.is_empty());
    assert!(r.files.is_empty());
    assert_eq!(r.merge_base, Some(c.to_string()));
    assert_eq!(r.behind, 3);
}

#[test]
fn review_the_other_way_round() {
    let (t, oids) = sample();
    let [_a, b, c, _topic, m, f] = oids[..] else {
        panic!()
    };
    let r = review(&t.path, "refs/heads/feature", "refs/heads/main").unwrap();
    let got: Vec<_> = r.commits.iter().map(|c| c.id.clone()).collect();
    assert_eq!(got, vec![f.to_string(), m.to_string(), b.to_string()]);
    assert_eq!(r.merge_base, Some(c.to_string()));
    assert_eq!(r.behind, 0);
    assert_eq!(r.files.len(), 1);
    assert_eq!(r.files[0].path, "f.txt");
}

#[test]
fn review_against_itself_is_empty() {
    let (t, _) = sample();
    let r = review(&t.path, "refs/heads/main", "refs/heads/main").unwrap();
    assert!(r.commits.is_empty());
    assert!(r.files.is_empty());
    assert_eq!(r.behind, 0);
}

#[test]
fn review_unrelated_histories_shows_whole_branch() {
    let (mut t, _) = sample();
    let orphan = t.commit("orphan", &[], &[("only.txt", "x\n")]);
    let r = review(&t.path, "refs/heads/main", "refs/heads/orphan").unwrap();

    assert_eq!(r.merge_base, None);
    assert_eq!(r.commits.len(), 1);
    assert_eq!(r.commits[0].id, orphan.to_string());
    // No merge base: the branch reads as wholly added.
    assert_eq!(r.files.len(), 1);
    assert_eq!(r.files[0].path, "only.txt");
    assert_eq!(r.files[0].status, "added");
}

#[test]
fn review_accepts_raw_commit_ids() {
    let (t, oids) = sample();
    let [_a, b, _c, topic, ..] = oids[..] else {
        panic!()
    };
    let r = review(&t.path, &b.to_string(), &topic.to_string()).unwrap();
    assert_eq!(r.commits.len(), 1);
    assert_eq!(r.merge_base, Some(b.to_string()));
}

/// A commit with nested directories, for the file browser tests.
fn nested() -> (TestRepo, Oid) {
    let t = TestRepo::new();
    // Scoped so the builders, which borrow the repo, are gone before t moves.
    let oid = {
        let sig = Signature::new("Test", "test@example.com", &Time::new(t.clock, 0)).unwrap();
        let blob = t.repo.blob(b"fn main() {}\n").unwrap();
        let readme = t.repo.blob(b"# Title\n").unwrap();
        let mut inner = t.repo.treebuilder(None).unwrap();
        inner.insert("main.rs", blob, 0o100644).unwrap();
        let inner_id = inner.write().unwrap();
        let mut root = t.repo.treebuilder(None).unwrap();
        root.insert("src", inner_id, 0o040000).unwrap();
        root.insert("README.md", readme, 0o100644).unwrap();
        let tree = t.repo.find_tree(root.write().unwrap()).unwrap();
        t.repo
            .commit(None, &sig, &sig, "nested", &tree, &[])
            .unwrap()
    };
    t.repo
        .reference("refs/heads/main", oid, true, "test")
        .unwrap();
    (t, oid)
}

#[test]
fn tree_listing_puts_directories_first() {
    let (t, oid) = nested();
    let root = list_tree(&t.path, "refs/heads/main", "").unwrap();
    assert_eq!(root.commit, oid.to_string());
    let names: Vec<_> = root.entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, vec!["src", "README.md"]);
    assert_eq!(root.entries[0].kind, "dir");
    assert_eq!(root.entries[1].kind, "file");
    assert_eq!(root.entries[1].size, 8);

    let sub = list_tree(&t.path, "refs/heads/main", "src").unwrap();
    assert_eq!(sub.path, "src");
    assert_eq!(sub.entries.len(), 1);
    assert_eq!(sub.entries[0].path, "src/main.rs");
}

#[test]
fn tree_listing_rejects_a_file_path() {
    let (t, _) = nested();
    assert!(list_tree(&t.path, "refs/heads/main", "README.md").is_err());
}

#[test]
fn read_file_and_blob() {
    let (t, oid) = nested();
    let f = read_file(&t.path, "refs/heads/main", "src/main.rs").unwrap();
    assert_eq!(f.text, "fn main() {}\n");
    assert_eq!(f.size, 13);
    assert!(!f.binary && !f.truncated);
    assert_eq!(f.commit, oid.to_string());

    // Raw bytes come back untouched, and any rev spelling resolves.
    assert_eq!(
        read_blob(&t.path, &oid.to_string(), "README.md").unwrap(),
        b"# Title\n"
    );
    assert!(read_file(&t.path, "refs/heads/main", "nope.txt").is_err());
    assert!(read_file(&t.path, "refs/heads/main", "src").is_err());
}

#[test]
fn read_file_flags_binary_content() {
    let t = TestRepo::new();
    let sig = Signature::new("Test", "test@example.com", &Time::new(t.clock, 0)).unwrap();
    let blob = t.repo.blob(&[0u8, 1, 2, 0, 3, 4]).unwrap();
    let mut root = t.repo.treebuilder(None).unwrap();
    root.insert("data.bin", blob, 0o100644).unwrap();
    let tree = t.repo.find_tree(root.write().unwrap()).unwrap();
    let oid = t
        .repo
        .commit(None, &sig, &sig, "binary", &tree, &[])
        .unwrap();
    t.repo
        .reference("refs/heads/main", oid, true, "test")
        .unwrap();

    let f = read_file(&t.path, "refs/heads/main", "data.bin").unwrap();
    assert!(f.binary);
    assert!(f.text.is_empty());
    assert_eq!(f.size, 6);
    // The bytes are still downloadable even though they are not displayable.
    assert_eq!(
        read_blob(&t.path, "refs/heads/main", "data.bin")
            .unwrap()
            .len(),
        6
    );
}

#[test]
fn merge_commit_layout() {
    let (t, oids) = sample();
    let [a, b, c, _tt, m, _f] = oids[..] else {
        panic!()
    };
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
    assert!(
        mrow.edges.len() >= 2,
        "merge should fan out to both parents"
    );
    // B and C sit in different columns; A reconverges below both.
    assert_ne!(g.rows[ri_b].column, g.rows[ri_c].column);
    assert!(ri_a > ri_b && ri_a > ri_c);
    check_edge_continuity(&g.rows);
}

/// How long a diff says `f.txt` is after a commit that rewrites it.
fn lines_after(before: &str, after: &str) -> usize {
    let mut t = TestRepo::new();
    let first = t.commit("main", &[], &[("f.txt", before)]);
    let second = t.commit("main", &[first], &[("f.txt", after)]);
    let d = commit_details(&t.path, &second.to_string()).unwrap();
    d.files[0].lines
}

#[test]
fn a_diff_says_how_long_the_file_is_afterwards() {
    assert_eq!(lines_after("a\n", "a\nb\nc\n"), 3);
}

#[test]
fn a_last_line_without_a_newline_still_counts() {
    assert_eq!(lines_after("a\n", "a\nb"), 2);
}

#[test]
fn a_deleted_file_has_no_lines_afterwards() {
    let mut t = TestRepo::new();
    let first = t.commit("main", &[], &[("keep.txt", "k\n"), ("gone.txt", "a\nb\n")]);
    // The helper only ever adds to its parent's tree, so take the file out by hand.
    let sig = Signature::new("Test", "test@example.com", &Time::new(t.clock + 60, 0)).unwrap();
    let parent = t.repo.find_commit(first).unwrap();
    let mut tb = t.repo.treebuilder(Some(&parent.tree().unwrap())).unwrap();
    tb.remove("gone.txt").unwrap();
    let tree = t.repo.find_tree(tb.write().unwrap()).unwrap();
    let second = t
        .repo
        .commit(None, &sig, &sig, "remove it", &tree, &[&parent])
        .unwrap();

    let d = commit_details(&t.path, &second.to_string()).unwrap();
    assert_eq!(d.files[0].status, "deleted");
    assert_eq!(d.files[0].lines, 0);
}

#[test]
fn review_names_the_branches_on_its_commits() {
    let mut t = TestRepo::new();
    let base = t.commit("main", &[], &[("f.txt", "a\n")]);
    let first = t.commit("work", &[base], &[("f.txt", "a\nb\n")]);
    let second = t.commit("work", &[first], &[("f.txt", "a\nb\nc\n")]);
    // Another branch starts part way down the one under review.
    t.repo
        .reference("refs/heads/spinoff", first, true, "test")
        .unwrap();

    let r = review(&t.path, "refs/heads/main", "refs/heads/work").unwrap();
    let names = |id: Oid| -> Vec<String> {
        let c = r.commits.iter().find(|c| c.id == id.to_string()).unwrap();
        c.refs.iter().map(|l| l.name.clone()).collect()
    };
    assert_eq!(names(first), ["spinoff"]);
    assert_eq!(names(second), ["work"]);
}

/// Two lines of history from one root: `main` and a branch off it, each given
/// its own edits, for merging one into the other in memory.
fn diverged(main_edit: &str, branch_edit: &str) -> (TestRepo, Oid, Oid) {
    let mut t = TestRepo::new();
    let root = t.commit("main", &[], &[("f.txt", "one\ntwo\nthree\n")]);
    let branch = t.commit("work", &[root], &[("f.txt", branch_edit)]);
    let main = t.commit("main", &[root], &[("f.txt", main_edit)]);
    (t, main, branch)
}

#[test]
fn merging_work_that_already_arrived_changes_nothing() {
    // main took the branch's exact edit some other way - a rebase, a squash.
    let (t, _, _) = diverged("one\ntwo\nthree\nfour\n", "one\ntwo\nthree\nfour\n");
    let p = merge_preview(&t.path, "refs/heads/main", "refs/heads/work").unwrap();
    assert!(p.files.is_empty(), "{:?}", p.files);
    assert_eq!(p.conflicts, 0);
}

#[test]
fn merging_a_drifted_copy_conflicts() {
    // Both sides rewrote the same line, differently.
    let (t, _, _) = diverged("one\ntwo\nTHREE\n", "one\ntwo\n3\n");
    let p = merge_preview(&t.path, "refs/heads/main", "refs/heads/work").unwrap();
    assert_eq!(p.conflicts, 1);
    assert_eq!(p.files.len(), 1);
    assert_eq!(p.files[0].path, "f.txt");
    assert_eq!(p.files[0].status, "conflict");
    assert!(
        p.files[0].patch.is_empty(),
        "a conflict has no one patch to show"
    );
}

#[test]
fn a_clean_merge_shows_only_what_the_branch_brings() {
    // main changed the top of the file, the branch the bottom.
    let (t, main, _) = diverged("ONE\ntwo\nthree\n", "one\ntwo\nthree\nfour\n");
    let p = merge_preview(&t.path, "refs/heads/main", "refs/heads/work").unwrap();
    assert_eq!(p.base_id, main.to_string());
    assert_eq!(p.conflicts, 0);
    assert_eq!(p.files.len(), 1);
    assert_eq!(p.files[0].status, "modified");
    // The branch's line arrives; main's own edit is context, not a change.
    let changed: Vec<&str> = p.files[0]
        .patch
        .lines()
        .filter(|l| {
            (l.starts_with('+') || l.starts_with('-'))
                && !l.starts_with("+++")
                && !l.starts_with("---")
        })
        .collect();
    assert_eq!(changed, ["+four"]);
}

#[test]
fn merging_unrelated_histories_is_refused() {
    let mut t = TestRepo::new();
    t.commit("main", &[], &[("a.txt", "a\n")]);
    t.commit("other", &[], &[("b.txt", "b\n")]);
    let err = merge_preview(&t.path, "refs/heads/main", "refs/heads/other").unwrap_err();
    assert!(err.contains("no history"), "{err}");
}
