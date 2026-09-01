//! What the server does with more than one repository: which ones it opens,
//! and which one a request lands on. The API is driven directly rather than
//! over a socket, so a test is a request in and a response out.

use super::*;
use axum::body::Body;
use axum::http::Request;
use git2::{Repository, Signature, Time};
use http_body_util::BodyExt;
use tempfile::TempDir;
use tower::ServiceExt;

/// A repository with one commit on `master`, kept alive by its TempDir.
struct Fixture {
    dir: TempDir,
}

impl Fixture {
    fn new(file: &str) -> Self {
        let dir = TempDir::new().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        let sig = Signature::new("Test", "test@example.com", &Time::new(1_700_000_000, 0)).unwrap();
        let blob = repo.blob(b"contents").unwrap();
        let mut tb = repo.treebuilder(None).unwrap();
        tb.insert(file, blob, 0o100644).unwrap();
        let tree = repo.find_tree(tb.write().unwrap()).unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "only commit", &tree, &[])
            .unwrap();
        Fixture { dir }
    }

    /// The path the UI shows, which is also how a request names the repository.
    fn display_path(&self) -> String {
        gitcore::open_repo(self.path().as_str())
            .unwrap()
            .display_path
    }

    fn path(&self) -> String {
        self.dir.path().to_string_lossy().into_owned()
    }
}

/// Send one GET through the API and return its status and body.
async fn get(state: &Arc<AppState>, uri: &str) -> (StatusCode, serde_json::Value) {
    let response = api_router()
        .with_state(state.clone())
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, json)
}

fn state_of(fixtures: &[&Fixture]) -> Arc<AppState> {
    let paths: Vec<String> = fixtures.iter().map(|f| f.path()).collect();
    Arc::new(AppState {
        repos: open_all(&paths, &[]).unwrap(),
    })
}

#[test]
fn opens_each_repository_in_the_order_given() {
    let a = Fixture::new("a.txt");
    let b = Fixture::new("b.txt");
    let repos = open_all(&[a.path(), b.path()], &[]).unwrap();
    assert_eq!(repos.len(), 2);
    assert_eq!(repos[0].display_path, a.display_path());
    assert_eq!(repos[1].display_path, b.display_path());
}

#[test]
fn two_names_for_one_repository_collapse() {
    let a = Fixture::new("a.txt");
    // The working directory and the .git inside it are the same repository.
    let inside = format!("{}/.git", a.path());
    let repos = open_all(&[a.path(), inside], &[]).unwrap();
    assert_eq!(repos.len(), 1, "one repository named twice is still one");
}

#[test]
fn no_repository_named_means_the_working_directory() {
    // Asserted as an equivalence rather than a count, so the test does not
    // depend on the tests themselves being run from inside a checkout.
    match (open_all(&[], &[]), open_all(&[".".to_string()], &[])) {
        (Ok(none), Ok(dot)) => assert_eq!(
            none.iter().map(|r| &r.git_dir).collect::<Vec<_>>(),
            dot.iter().map(|r| &r.git_dir).collect::<Vec<_>>(),
        ),
        (Err(_), Err(_)) => {}
        _ => panic!("naming nothing and naming `.` must come to the same thing"),
    }
}

#[test]
fn a_path_that_is_not_a_repository_is_an_error() {
    let dir = TempDir::new().unwrap();
    let err = open_all(&[dir.path().to_string_lossy().into_owned()], &[]).unwrap_err();
    assert!(err.contains("cannot open repository at"), "{err}");
}

#[test]
fn a_request_names_its_repository() {
    let a = Fixture::new("a.txt");
    let b = Fixture::new("b.txt");
    let state = state_of(&[&a, &b]);
    let Ok(dir) = state.git_dir(Some(&b.display_path())) else {
        panic!("the second repository should be reachable by its own path");
    };
    assert_eq!(dir, state.repos[1].git_dir);
}

#[test]
fn naming_no_repository_falls_back_to_the_first() {
    let a = Fixture::new("a.txt");
    let b = Fixture::new("b.txt");
    let state = state_of(&[&a, &b]);
    let Ok(dir) = state.git_dir(None) else {
        panic!("naming nothing should still resolve");
    };
    assert_eq!(dir, state.repos[0].git_dir);
}

#[test]
fn an_unknown_repository_is_refused() {
    let a = Fixture::new("a.txt");
    let state = state_of(&[&a]);
    let Err(ApiError(status, _)) = state.git_dir(Some("/not/served/here")) else {
        panic!("a repository the server was not given must not resolve");
    };
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn repos_lists_every_repository_served() {
    let a = Fixture::new("a.txt");
    let b = Fixture::new("b.txt");
    let (status, body) = get(&state_of(&[&a, &b]), "/api/repos").await;
    assert_eq!(status, StatusCode::OK);
    let listed: Vec<String> = body
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["display_path"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(listed, vec![a.display_path(), b.display_path()]);
}

#[tokio::test]
async fn a_read_lands_on_the_repository_it_names() {
    let a = Fixture::new("only-in-a.txt");
    let b = Fixture::new("only-in-b.txt");
    let state = state_of(&[&a, &b]);

    // The second repository, named explicitly: its own file is the one listed.
    let uri = format!("/api/tree?repo={}&rev=master", b.display_path());
    let (status, body) = get(&state, &uri).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["entries"][0]["name"], "only-in-b.txt");
}

#[tokio::test]
async fn a_read_naming_no_repository_falls_back_to_the_first() {
    let a = Fixture::new("only-in-a.txt");
    let b = Fixture::new("only-in-b.txt");
    let (status, body) = get(&state_of(&[&a, &b]), "/api/tree?rev=master").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["entries"][0]["name"], "only-in-a.txt");
}

#[tokio::test]
async fn a_read_of_an_unserved_repository_is_refused() {
    let a = Fixture::new("a.txt");
    let (status, body) = get(
        &state_of(&[&a]),
        "/api/tree?repo=/not/served/here&rev=master",
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(
        body["error"].as_str().unwrap().contains("/not/served/here"),
        "the error should name what was asked for: {body}"
    );
}

/// The graph reads its parameters by hand rather than through serde, so its
/// repository is worth checking separately from the rest.
#[tokio::test]
async fn the_graph_reads_the_repository_it_names() {
    let a = Fixture::new("a.txt");
    let b = Fixture::new("b.txt");
    let state = state_of(&[&a, &b]);
    let uri = format!(
        "/api/graph?repo={}&branch=refs/heads/master&limit=10",
        b.display_path()
    );
    let (status, body) = get(&state, &uri).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["rows"].as_array().unwrap().len(), 1);
    // Same message in both, so compare the commit the other repository has.
    let (_, from_a) = get(&state, "/api/graph?branch=refs/heads/master&limit=10").await;
    assert_ne!(body["rows"][0]["id"], from_a["rows"][0]["id"]);
}

/// A directory of repositories, as --repo-dir expects to find one.
struct Workspace {
    dir: TempDir,
}

impl Workspace {
    fn new() -> Self {
        Workspace {
            dir: TempDir::new().unwrap(),
        }
    }

    fn path(&self) -> String {
        self.dir.path().to_string_lossy().into_owned()
    }

    fn at(&self, name: &str) -> String {
        self.dir.path().join(name).to_string_lossy().into_owned()
    }

    /// A repository with one commit, so it has a HEAD to add worktrees from.
    fn repo(&self, name: &str) -> String {
        let path = self.dir.path().join(name);
        let repo = Repository::init(&path).unwrap();
        let sig = Signature::new("Test", "test@example.com", &Time::new(1_700_000_000, 0)).unwrap();
        let tree = repo
            .find_tree(repo.treebuilder(None).unwrap().write().unwrap())
            .unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "only commit", &tree, &[])
            .unwrap();
        path.to_string_lossy().into_owned()
    }

    /// A linked worktree of `name`, checked out beside it under `as_name`.
    fn worktree(&self, name: &str, as_name: &str) {
        let repo = Repository::open(self.dir.path().join(name)).unwrap();
        repo.worktree(as_name, &self.dir.path().join(as_name), None)
            .unwrap();
    }

    /// A directory that is not a repository at all.
    fn plain(&self, name: &str) {
        std::fs::create_dir_all(self.dir.path().join(name)).unwrap();
    }
}

fn names(repos: &[gitcore::RepoInfo]) -> Vec<String> {
    repos.iter().map(|r| r.name.clone()).collect()
}

#[test]
fn a_directory_offers_the_repositories_inside_it() {
    let w = Workspace::new();
    w.repo("beta");
    w.repo("alpha");
    w.plain("not-a-repo");
    let repos = open_all(&[], &[w.path()]).unwrap();
    assert_eq!(
        names(&repos),
        ["alpha", "beta"],
        "in name order, and nothing else"
    );
}

#[test]
fn the_scan_does_not_go_deeper_than_one_level() {
    let w = Workspace::new();
    w.plain("nested");
    Repository::init(w.dir.path().join("nested/inner")).unwrap();
    let err = open_all(&[], &[w.path()]).unwrap_err();
    assert!(err.contains("no repositories directly inside"), "{err}");
}

/// Discovery walks up, so a plain subdirectory of a repository would resolve to
/// that repository and every one of them would look like a repository of its
/// own. The scan opens instead, which does not.
#[test]
fn a_subdirectory_is_not_mistaken_for_the_repository_above_it() {
    let w = Workspace::new();
    let outer = Repository::init(w.dir.path()).unwrap();
    let sig = Signature::new("Test", "test@example.com", &Time::new(1_700_000_000, 0)).unwrap();
    let tree = outer
        .find_tree(outer.treebuilder(None).unwrap().write().unwrap())
        .unwrap();
    outer
        .commit(Some("HEAD"), &sig, &sig, "only commit", &tree, &[])
        .unwrap();
    w.plain("src");
    w.plain("docs");
    let err = open_all(&[], &[w.path()]).unwrap_err();
    assert!(err.contains("no repositories directly inside"), "{err}");
}

#[test]
fn worktrees_of_one_repository_are_one_entry() {
    let w = Workspace::new();
    w.repo("alpha");
    w.repo("beta");
    w.worktree("alpha", "alpha-feature");
    w.worktree("alpha", "alpha-hotfix");
    let repos = open_all(&[], &[w.path()]).unwrap();
    assert_eq!(names(&repos), ["alpha", "beta"]);
}

/// Which checkout is met first would otherwise depend on what the worktrees
/// happen to be called, so the one the repository was made in is preferred.
#[test]
fn a_scan_keeps_the_checkout_the_repository_was_made_in() {
    let w = Workspace::new();
    w.repo("zulu");
    w.worktree("zulu", "aaa-sorts-first");
    let repos = open_all(&[], &[w.path()]).unwrap();
    assert_eq!(names(&repos), ["zulu"]);
    assert!(!repos[0].is_worktree());
}

#[test]
fn a_worktree_named_outright_is_the_one_served() {
    let w = Workspace::new();
    w.repo("zulu");
    w.worktree("zulu", "aaa-sorts-first");
    // Asked for by name, so it stays, and the scan adds nothing further.
    let repos = open_all(&[w.at("aaa-sorts-first")], &[w.path()]).unwrap();
    assert_eq!(names(&repos), ["aaa-sorts-first"]);
    assert!(repos[0].is_worktree());
}

#[test]
fn a_repository_reached_both_ways_is_one_entry() {
    let w = Workspace::new();
    let alpha = w.repo("alpha");
    w.repo("beta");
    let repos = open_all(&[alpha], &[w.path()]).unwrap();
    assert_eq!(names(&repos), ["alpha", "beta"]);
}

#[test]
fn directories_are_scanned_in_the_order_they_are_given() {
    let one = Workspace::new();
    one.repo("alpha");
    let two = Workspace::new();
    two.repo("beta");
    let repos = open_all(&[], &[two.path(), one.path()]).unwrap();
    assert_eq!(names(&repos), ["beta", "alpha"]);
}

#[test]
fn a_directory_that_cannot_be_read_is_an_error() {
    let err = open_all(&[], &["/no/such/directory".to_string()]).unwrap_err();
    assert!(err.contains("cannot read"), "{err}");
}

#[tokio::test]
async fn a_scanned_repository_can_be_read_through_the_api() {
    let w = Workspace::new();
    w.repo("alpha");
    let state = Arc::new(AppState {
        repos: open_all(&[], &[w.path()]).unwrap(),
    });
    let uri = format!("/api/refs?repo={}", state.repos[0].display_path);
    let (status, body) = get(&state, &uri).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        body["head_branch"].is_string(),
        "a scanned repository reads like any other: {body}"
    );
}
