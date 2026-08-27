export interface RepoInfo {
  git_dir: string;
  display_path: string;
  name: string;
}

export interface BranchInfo {
  name: string;
  full_name: string;
  target: string;
  tip_time: number;
  remote: string | null;
}

export interface RefsResult {
  locals: BranchInfo[];
  remotes: BranchInfo[];
  head_branch: string | null;
}

export interface RefLabel {
  name: string;
  kind: "local" | "remote" | "tag";
}

export interface Edge {
  from: number;
  to: number;
  color: number;
}

export interface GraphRow {
  id: string;
  short_id: string;
  summary: string;
  author: string;
  email: string;
  time: number;
  parents: string[];
  column: number;
  color: number;
  edges: Edge[];
  refs: RefLabel[];
}

export interface GraphResult {
  rows: GraphRow[];
  width: number;
  has_more: boolean;
  head_id: string | null;
}

export interface FileDiff {
  path: string;
  old_path: string | null;
  status: "added" | "modified" | "deleted" | "renamed" | "typechange";
  additions: number;
  deletions: number;
  binary: boolean;
  /// Size after the change, or before it for a deletion.
  size: number;
  /// True when the file is an image the host can hand over for display.
  image: boolean;
  patch: string;
  truncated: boolean;
}

export interface CommitDetails {
  id: string;
  short_id: string;
  summary: string;
  message: string;
  author_name: string;
  author_email: string;
  author_time: number;
  committer_name: string;
  committer_email: string;
  commit_time: number;
  parents: string[];
  refs: RefLabel[];
  files: FileDiff[];
}

export interface ReviewCommit {
  id: string;
  short_id: string;
  summary: string;
  author: string;
  time: number;
}

export interface ReviewResult {
  base_id: string;
  head_id: string;
  merge_base: string | null;
  commits: ReviewCommit[];
  commits_truncated: boolean;
  behind: number;
  files: FileDiff[];
}

export interface TreeEntry {
  name: string;
  path: string;
  kind: "dir" | "file" | "symlink" | "submodule";
  size: number;
}

export interface TreeResult {
  commit: string;
  short_commit: string;
  path: string;
  entries: TreeEntry[];
}

export interface FileContent {
  path: string;
  commit: string;
  short_commit: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  /// True when the file is an image the host can hand over for display.
  image: boolean;
  text: string;
}

/// An image's bytes, base64 encoded: the desktop build has no URL to point an
/// <img> at, so both hosts hand the page the data itself.
export interface ImageContent {
  path: string;
  commit: string;
  short_commit: string;
  mime: string;
  size: number;
  base64: string;
}

/// The repository access the UI needs from its host. The desktop build talks to
/// Tauri over IPC and keeps its own list of repositories; the web build talks to
/// the HTTP server, whose list is fixed by the command line it was started with.
///
/// Every read names the repository it is about, by the path the host shows for
/// it, so the two hosts address a repository the same way.
export interface Backend {
  /// Every repository this host can reach, in the order it offers them.
  listRepos(): Promise<RepoInfo[]>;
  listRefs(repo: string): Promise<RefsResult>;
  getGraph(repo: string, branches: string[], limit: number): Promise<GraphResult>;
  getCommitDetails(repo: string, id: string): Promise<CommitDetails>;
  /// Diff `head` against the commit it would merge into, pull-request style.
  getReview(repo: string, base: string, head: string): Promise<ReviewResult>;
  /// One directory of the tree at `rev`; empty `path` is the root.
  listTree(repo: string, rev: string, path: string): Promise<TreeResult>;
  readFile(repo: string, rev: string, path: string): Promise<FileContent>;
  readImage(repo: string, rev: string, path: string): Promise<ImageContent>;
  /// Link that downloads the file, or null on hosts without one.
  rawUrl(repo: string, rev: string, path: string): string | null;
  /// True when the host has a real URL, so the app's position can live in the
  /// address bar and be walked with back and forward.
  readonly routable: boolean;
  /// True when the reader owns the list of repositories, so the UI offers to add
  /// and remove them. The server fixes its list from the command line instead.
  readonly editableRepos: boolean;
  /// Ask for a repository and add it to the list; null if nothing was chosen.
  /// Only present when `editableRepos`.
  addRepo?(): Promise<RepoInfo | null>;
  /// Drop a repository from the list. Nothing on disk is touched. Only present
  /// when `editableRepos`.
  removeRepo?(repo: string): Promise<void>;
}
