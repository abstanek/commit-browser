//! Repository reading for the commit browser: ref listing, commit-graph
//! construction with lane layout, and per-commit diff details.

mod layout;

use std::collections::HashMap;
use std::path::Path;

use git2::{Diff, DiffOptions, Oid, Repository, Sort};
use serde::Serialize;

pub use layout::Edge;

pub type Result<T> = std::result::Result<T, String>;

fn err(e: git2::Error) -> String {
    e.message().to_string()
}

const MAX_PATCH_BYTES: usize = 1_000_000;
const MAX_REVIEW_COMMITS: usize = 2000;
const MAX_FILE_BYTES: usize = 2_000_000;

#[derive(Serialize, Debug)]
pub struct RepoInfo {
    /// Path to the .git directory (stable handle for reopening).
    pub git_dir: String,
    /// Path shown to the user (workdir if present).
    pub display_path: String,
    pub name: String,
}

#[derive(Serialize, Debug)]
pub struct BranchInfo {
    pub name: String,
    pub full_name: String,
    pub target: String,
    /// Committer time of the tip commit, unix seconds.
    pub tip_time: i64,
    /// For remote-tracking branches, the remote this branch belongs to.
    pub remote: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct RefsResult {
    pub locals: Vec<BranchInfo>,
    pub remotes: Vec<BranchInfo>,
    pub head_branch: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct RefLabel {
    pub name: String,
    /// "local" | "remote" | "tag"
    pub kind: String,
}

#[derive(Serialize, Debug)]
pub struct GraphRow {
    pub id: String,
    pub short_id: String,
    pub summary: String,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub parents: Vec<String>,
    pub column: usize,
    pub color: usize,
    pub edges: Vec<Edge>,
    pub refs: Vec<RefLabel>,
}

#[derive(Serialize, Debug)]
pub struct GraphResult {
    pub rows: Vec<GraphRow>,
    pub width: usize,
    pub has_more: bool,
    pub head_id: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    /// "added" | "modified" | "deleted" | "renamed" | "typechange"
    pub status: String,
    pub additions: usize,
    pub deletions: usize,
    pub binary: bool,
    pub patch: String,
    pub truncated: bool,
}

#[derive(Serialize, Debug)]
pub struct CommitDetails {
    pub id: String,
    pub short_id: String,
    pub summary: String,
    pub message: String,
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,
    pub committer_name: String,
    pub committer_email: String,
    pub commit_time: i64,
    pub parents: Vec<String>,
    pub refs: Vec<RefLabel>,
    pub files: Vec<FileDiff>,
}

#[derive(Serialize, Debug)]
pub struct ReviewCommit {
    pub id: String,
    pub short_id: String,
    pub summary: String,
    pub author: String,
    pub time: i64,
}

#[derive(Serialize, Debug)]
pub struct ReviewResult {
    pub base_id: String,
    pub head_id: String,
    /// Where the branches diverged, or None if their histories are unrelated.
    pub merge_base: Option<String>,
    /// Commits on head but not base, newest first.
    pub commits: Vec<ReviewCommit>,
    pub commits_truncated: bool,
    /// Commits on base but not head: how far the branch has fallen behind.
    pub behind: usize,
    /// Combined diff from the merge base to head.
    pub files: Vec<FileDiff>,
}

#[derive(Serialize, Debug)]
pub struct TreeEntry {
    pub name: String,
    /// Path from the root of the repository.
    pub path: String,
    /// "dir" | "file" | "symlink" | "submodule"
    pub kind: String,
    pub size: u64,
}

#[derive(Serialize, Debug)]
pub struct TreeResult {
    /// The commit `rev` resolved to.
    pub commit: String,
    pub short_commit: String,
    pub path: String,
    pub entries: Vec<TreeEntry>,
}

#[derive(Serialize, Debug)]
pub struct FileContent {
    pub path: String,
    pub commit: String,
    pub short_commit: String,
    pub size: u64,
    pub binary: bool,
    /// True when `text` holds only the first MAX_FILE_BYTES of the file.
    pub truncated: bool,
    pub text: String,
}

pub fn open_repo(path: &str) -> Result<RepoInfo> {
    let repo = Repository::discover(path).map_err(err)?;
    let git_dir = repo.path().to_string_lossy().into_owned();
    let display = repo
        .workdir()
        .unwrap_or_else(|| repo.path())
        .to_string_lossy()
        .trim_end_matches('/')
        .to_string();
    let name = Path::new(&display)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| display.clone());
    Ok(RepoInfo { git_dir, display_path: display, name })
}

pub fn list_refs(repo_path: &str) -> Result<RefsResult> {
    let repo = Repository::open(repo_path).map_err(err)?;
    let mut locals = Vec::new();
    let mut remotes = Vec::new();
    let remote_names: Vec<String> = repo
        .remotes()
        .map(|arr| arr.iter().flatten().map(str::to_string).collect())
        .unwrap_or_default();

    for r in repo.references().map_err(err)? {
        let r = match r {
            Ok(r) => r,
            Err(_) => continue,
        };
        let Some(full) = r.name().map(str::to_string) else { continue };
        if full.ends_with("/HEAD") {
            continue; // e.g. refs/remotes/origin/HEAD
        }
        let Ok(commit) = r.peel_to_commit() else { continue };
        let target = commit.id().to_string();
        let tip_time = commit.time().seconds();
        if let Some(short) = full.strip_prefix("refs/heads/") {
            locals.push(BranchInfo {
                name: short.to_string(),
                full_name: full.clone(),
                target,
                tip_time,
                remote: None,
            });
        } else if let Some(short) = full.strip_prefix("refs/remotes/") {
            // Match against configured remotes rather than splitting on "/",
            // since branch names may themselves contain slashes.
            let remote = remote_names
                .iter()
                .find(|rn| short.strip_prefix(rn.as_str()).is_some_and(|s| s.starts_with('/')))
                .cloned();
            remotes.push(BranchInfo {
                name: short.to_string(),
                full_name: full.clone(),
                target,
                tip_time,
                remote,
            });
        }
    }
    locals.sort_by(|a, b| a.name.cmp(&b.name));
    remotes.sort_by(|a, b| a.name.cmp(&b.name));

    let head_branch = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().map(str::to_string));

    Ok(RefsResult { locals, remotes, head_branch })
}

fn ref_labels(repo: &Repository) -> HashMap<Oid, Vec<RefLabel>> {
    let mut map: HashMap<Oid, Vec<RefLabel>> = HashMap::new();
    let Ok(refs) = repo.references() else { return map };
    for r in refs.flatten() {
        let Some(full) = r.name().map(str::to_string) else { continue };
        if full.ends_with("/HEAD") {
            continue;
        }
        let (kind, name) = if let Some(n) = full.strip_prefix("refs/heads/") {
            ("local", n)
        } else if let Some(n) = full.strip_prefix("refs/remotes/") {
            ("remote", n)
        } else if let Some(n) = full.strip_prefix("refs/tags/") {
            ("tag", n)
        } else {
            continue;
        };
        let Ok(commit) = r.peel_to_commit() else { continue };
        map.entry(commit.id()).or_default().push(RefLabel {
            name: name.to_string(),
            kind: kind.to_string(),
        });
    }
    map
}

/// Walk the commits reachable from `branches` (full ref names), newest first,
/// and lay them out into graph rows. At most `limit` rows are returned.
pub fn graph(repo_path: &str, branches: &[String], limit: usize) -> Result<GraphResult> {
    let repo = Repository::open(repo_path).map_err(err)?;
    let head_id = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .map(|c| c.id().to_string());

    if branches.is_empty() {
        return Ok(GraphResult { rows: Vec::new(), width: 0, has_more: false, head_id });
    }

    let mut walk = repo.revwalk().map_err(err)?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME).map_err(err)?;
    for b in branches {
        // Tolerate refs that vanished since the sidebar was populated.
        let _ = walk.push_ref(b);
    }

    let mut inputs = Vec::new();
    let mut commits = Vec::new();
    let mut has_more = false;
    for oid in walk {
        let oid = oid.map_err(err)?;
        if inputs.len() == limit {
            has_more = true;
            break;
        }
        let commit = repo.find_commit(oid).map_err(err)?;
        inputs.push(layout::LayoutInput { id: oid, parents: commit.parent_ids().collect() });
        commits.push(commit);
    }

    let (lrows, width) = layout::layout(&inputs, has_more);
    let labels = ref_labels(&repo);

    let rows = commits
        .iter()
        .zip(lrows)
        .map(|(c, l)| {
            let author = c.author();
            GraphRow {
                id: c.id().to_string(),
                short_id: c.id().to_string()[..7].to_string(),
                summary: c.summary().unwrap_or("").to_string(),
                author: author.name().unwrap_or("").to_string(),
                email: author.email().unwrap_or("").to_string(),
                time: c.time().seconds(),
                parents: c.parent_ids().map(|p| p.to_string()).collect(),
                column: l.column,
                color: l.color,
                edges: l.edges,
                refs: labels.get(&c.id()).cloned().unwrap_or_default(),
            }
        })
        .collect();

    Ok(GraphResult { rows, width, has_more, head_id })
}

pub fn commit_details(repo_path: &str, id: &str) -> Result<CommitDetails> {
    let repo = Repository::open(repo_path).map_err(err)?;
    let oid = Oid::from_str(id).map_err(err)?;
    let commit = repo.find_commit(oid).map_err(err)?;

    let new_tree = commit.tree().map_err(err)?;
    let old_tree = match commit.parent(0) {
        Ok(p) => Some(p.tree().map_err(err)?),
        Err(_) => None,
    };
    let files = diff_files(&repo, old_tree.as_ref(), Some(&new_tree))?;

    let author = commit.author();
    let committer = commit.committer();
    let labels = ref_labels(&repo);
    Ok(CommitDetails {
        id: commit.id().to_string(),
        short_id: commit.id().to_string()[..7].to_string(),
        summary: commit.summary().unwrap_or("").to_string(),
        message: commit.message().unwrap_or("").to_string(),
        author_name: author.name().unwrap_or("").to_string(),
        author_email: author.email().unwrap_or("").to_string(),
        author_time: author.when().seconds(),
        committer_name: committer.name().unwrap_or("").to_string(),
        committer_email: committer.email().unwrap_or("").to_string(),
        commit_time: commit.time().seconds(),
        parents: commit.parent_ids().map(|p| p.to_string()).collect(),
        refs: labels.get(&commit.id()).cloned().unwrap_or_default(),
        files,
    })
}

/// Per-file patches between two trees. A missing tree means the empty tree, so
/// passing None as `old` yields an all-added diff.
fn diff_files(
    repo: &Repository,
    old_tree: Option<&git2::Tree>,
    new_tree: Option<&git2::Tree>,
) -> Result<Vec<FileDiff>> {
    let mut opts = DiffOptions::new();
    opts.context_lines(3);
    let mut diff: Diff = repo
        .diff_tree_to_tree(old_tree, new_tree, Some(&mut opts))
        .map_err(err)?;
    let mut find_opts = git2::DiffFindOptions::new();
    find_opts.renames(true);
    let _ = diff.find_similar(Some(&mut find_opts));

    let mut files = Vec::new();
    let n = diff.deltas().len();
    for idx in 0..n {
        let Ok(Some(mut patch)) = git2::Patch::from_diff(&diff, idx) else {
            // Binary or unreadable delta: still list the file.
            let delta = diff.get_delta(idx).unwrap();
            files.push(FileDiff {
                path: delta
                    .new_file()
                    .path()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                old_path: None,
                status: status_name(delta.status()),
                additions: 0,
                deletions: 0,
                binary: true,
                patch: String::new(),
                truncated: false,
            });
            continue;
        };
        let delta = patch.delta();
        let status = status_name(delta.status());
        let binary = delta.new_file().is_binary() || delta.old_file().is_binary();
        let new_path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let old_path = delta.old_file().path().map(|p| p.to_string_lossy().into_owned());
        let old_path = match &old_path {
            Some(op) if *op != new_path => Some(op.clone()),
            _ => None,
        };
        let (_, additions, deletions) = patch.line_stats().unwrap_or((0, 0, 0));
        let (text, truncated) = if binary {
            (String::new(), false)
        } else {
            match patch.to_buf() {
                Ok(buf) => {
                    let s = String::from_utf8_lossy(&buf);
                    if s.len() > MAX_PATCH_BYTES {
                        let mut end = MAX_PATCH_BYTES;
                        while !s.is_char_boundary(end) {
                            end -= 1;
                        }
                        (s[..end].to_string(), true)
                    } else {
                        (s.into_owned(), false)
                    }
                }
                Err(_) => (String::new(), false),
            }
        };
        files.push(FileDiff {
            path: new_path,
            old_path,
            status,
            additions,
            deletions,
            binary,
            patch: text,
            truncated,
        });
    }
    Ok(files)
}

fn resolve_commit<'r>(repo: &'r Repository, name: &str) -> Result<git2::Commit<'r>> {
    repo.revparse_single(name)
        .map_err(err)?
        .peel_to_commit()
        .map_err(err)
}

/// Compare a branch with the one it would merge into, the way a pull request
/// does: the file list is the diff from the merge base to `head`, so commits
/// added to `base` since the branch diverged don't show up as reversed edits.
pub fn review(repo_path: &str, base: &str, head: &str) -> Result<ReviewResult> {
    let repo = Repository::open(repo_path).map_err(err)?;
    let base_commit = resolve_commit(&repo, base)?;
    let head_commit = resolve_commit(&repo, head)?;
    let merge_base = repo.merge_base(base_commit.id(), head_commit.id()).ok();

    let mut walk = repo.revwalk().map_err(err)?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME).map_err(err)?;
    walk.push(head_commit.id()).map_err(err)?;
    let _ = walk.hide(base_commit.id());
    let mut commits = Vec::new();
    let mut commits_truncated = false;
    for oid in walk {
        let oid = oid.map_err(err)?;
        if commits.len() == MAX_REVIEW_COMMITS {
            commits_truncated = true;
            break;
        }
        let c = repo.find_commit(oid).map_err(err)?;
        commits.push(ReviewCommit {
            id: oid.to_string(),
            short_id: oid.to_string()[..7].to_string(),
            summary: c.summary().unwrap_or("").to_string(),
            author: c.author().name().unwrap_or("").to_string(),
            time: c.time().seconds(),
        });
    }

    let mut behind_walk = repo.revwalk().map_err(err)?;
    behind_walk.push(base_commit.id()).map_err(err)?;
    let _ = behind_walk.hide(head_commit.id());
    let behind = behind_walk.count();

    // Unrelated histories have no merge base; diff against the empty tree so
    // the branch still shows as wholly added rather than erroring.
    let old_tree = match merge_base {
        Some(oid) => Some(repo.find_commit(oid).map_err(err)?.tree().map_err(err)?),
        None => None,
    };
    let new_tree = head_commit.tree().map_err(err)?;
    let files = diff_files(&repo, old_tree.as_ref(), Some(&new_tree))?;

    Ok(ReviewResult {
        base_id: base_commit.id().to_string(),
        head_id: head_commit.id().to_string(),
        merge_base: merge_base.map(|o| o.to_string()),
        commits,
        commits_truncated,
        behind,
        files,
    })
}

/// The tree at `path` within the commit `rev` names, or the root tree when
/// `path` is empty.
fn tree_at<'r>(repo: &'r Repository, commit: &git2::Commit<'r>, path: &str) -> Result<git2::Tree<'r>> {
    let root = commit.tree().map_err(err)?;
    if path.is_empty() {
        return Ok(root);
    }
    root.get_path(Path::new(path))
        .map_err(err)?
        .to_object(repo)
        .map_err(err)?
        .into_tree()
        .map_err(|_| format!("{path} is not a directory"))
}

fn entry_kind(entry: &git2::TreeEntry) -> &'static str {
    match entry.kind() {
        Some(git2::ObjectType::Tree) => "dir",
        Some(git2::ObjectType::Commit) => "submodule",
        // 0o120000 is git's file mode for a symlink.
        _ if entry.filemode() == 0o120000 => "symlink",
        _ => "file",
    }
}

/// List one directory of the tree at `rev`. Directories sort before files, as
/// they do in the review tree.
pub fn list_tree(repo_path: &str, rev: &str, path: &str) -> Result<TreeResult> {
    let repo = Repository::open(repo_path).map_err(err)?;
    let commit = resolve_commit(&repo, rev)?;
    let tree = tree_at(&repo, &commit, path)?;

    let mut entries = Vec::new();
    for entry in tree.iter() {
        let name = entry.name().unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        let kind = entry_kind(&entry);
        let size = match entry.to_object(&repo).ok().and_then(|o| o.into_blob().ok()) {
            Some(blob) => blob.size() as u64,
            None => 0,
        };
        entries.push(TreeEntry {
            path: if path.is_empty() { name.clone() } else { format!("{path}/{name}") },
            name,
            kind: kind.to_string(),
            size,
        });
    }
    entries.sort_by(|a, b| {
        let dir = |k: &str| k != "dir";
        dir(&a.kind).cmp(&dir(&b.kind)).then_with(|| a.name.cmp(&b.name))
    });

    let id = commit.id().to_string();
    Ok(TreeResult {
        short_commit: id[..7].to_string(),
        commit: id,
        path: path.to_string(),
        entries,
    })
}

fn blob_at<'r>(repo: &'r Repository, commit: &git2::Commit<'r>, path: &str) -> Result<git2::Blob<'r>> {
    commit
        .tree()
        .map_err(err)?
        .get_path(Path::new(path))
        .map_err(err)?
        .to_object(repo)
        .map_err(err)?
        .into_blob()
        .map_err(|_| format!("{path} is not a file"))
}

/// Read a file as text for display. Binary files and anything past
/// MAX_FILE_BYTES come back empty and flagged; the raw bytes are still
/// available through `read_blob`.
pub fn read_file(repo_path: &str, rev: &str, path: &str) -> Result<FileContent> {
    let repo = Repository::open(repo_path).map_err(err)?;
    let commit = resolve_commit(&repo, rev)?;
    let blob = blob_at(&repo, &commit, path)?;
    let size = blob.size() as u64;
    let binary = blob.is_binary();

    let (text, truncated) = if binary {
        (String::new(), false)
    } else {
        let content = String::from_utf8_lossy(blob.content());
        if content.len() > MAX_FILE_BYTES {
            let mut end = MAX_FILE_BYTES;
            while !content.is_char_boundary(end) {
                end -= 1;
            }
            (content[..end].to_string(), true)
        } else {
            (content.into_owned(), false)
        }
    };

    let id = commit.id().to_string();
    Ok(FileContent {
        path: path.to_string(),
        short_commit: id[..7].to_string(),
        commit: id,
        size,
        binary,
        truncated,
        text,
    })
}

/// The exact bytes of a file at `rev`, for downloading.
pub fn read_blob(repo_path: &str, rev: &str, path: &str) -> Result<Vec<u8>> {
    let repo = Repository::open(repo_path).map_err(err)?;
    let commit = resolve_commit(&repo, rev)?;
    Ok(blob_at(&repo, &commit, path)?.content().to_vec())
}

fn status_name(s: git2::Delta) -> String {
    match s {
        git2::Delta::Added => "added",
        git2::Delta::Deleted => "deleted",
        git2::Delta::Modified => "modified",
        git2::Delta::Renamed => "renamed",
        git2::Delta::Typechange => "typechange",
        _ => "modified",
    }
    .to_string()
}

#[cfg(test)]
mod tests;
