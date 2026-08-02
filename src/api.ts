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

/// The repository access the UI needs from its host. The desktop build talks to
/// Tauri over IPC and can open any repository; the web build talks to the HTTP
/// server, which is started pointed at a single repository.
export interface Backend {
  /// Opens `path`. Ignored by hosts with a fixed repository.
  openRepo(path: string): Promise<RepoInfo>;
  listRefs(): Promise<RefsResult>;
  getGraph(branches: string[], limit: number): Promise<GraphResult>;
  getCommitDetails(id: string): Promise<CommitDetails>;
  /// True when the host chooses the repository, so the UI hides its
  /// open-repository controls and opens on startup without being asked.
  readonly fixedRepo: boolean;
  /// Directory picker; only present when `fixedRepo` is false.
  pickRepo?(): Promise<string | null>;
}
