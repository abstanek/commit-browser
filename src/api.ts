import { invoke } from "@tauri-apps/api/core";

export interface RepoInfo {
  git_dir: string;
  display_path: string;
  name: string;
}

export interface BranchInfo {
  name: string;
  full_name: string;
  target: string;
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

export const api = {
  openRepo: (path: string) => invoke<RepoInfo>("open_repo", { path }),
  listRefs: () => invoke<RefsResult>("list_refs"),
  getGraph: (branches: string[], limit: number) =>
    invoke<GraphResult>("get_graph", { branches, limit }),
  getCommitDetails: (id: string) => invoke<CommitDetails>("get_commit_details", { id }),
};
