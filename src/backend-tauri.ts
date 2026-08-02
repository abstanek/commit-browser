import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type {
  Backend,
  CommitDetails,
  GraphResult,
  RefsResult,
  RepoInfo,
  ReviewResult,
} from "./api";

export const backend: Backend = {
  openRepo: (path) => invoke<RepoInfo>("open_repo", { path }),
  listRefs: () => invoke<RefsResult>("list_refs"),
  getGraph: (branches, limit) => invoke<GraphResult>("get_graph", { branches, limit }),
  getCommitDetails: (id) => invoke<CommitDetails>("get_commit_details", { id }),
  getReview: (base, head) => invoke<ReviewResult>("get_review", { base, head }),
  fixedRepo: false,
  async pickRepo() {
    const dir = await openDialog({ directory: true, title: "Open git repository" });
    return typeof dir === "string" ? dir : null;
  },
};
