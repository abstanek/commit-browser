import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type {
  Backend,
  CommitDetails,
  CommitMeta,
  FileContent,
  GraphResult,
  ImageContent,
  RefsResult,
  RepoInfo,
  ReviewResult,
  TreeResult,
} from "./api";

/// The reader's repositories, by the path shown for each, in the order they
/// were added. This is the desktop build's whole notion of which repositories
/// exist: there is no server holding a list for it.
const REPOS_KEY = "repos";

function storedPaths(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(REPOS_KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function setStoredPaths(paths: string[]): void {
  localStorage.setItem(REPOS_KEY, JSON.stringify(paths));
}

export const backend: Backend = {
  async listRepos() {
    const repos: RepoInfo[] = [];
    for (const path of storedPaths()) {
      // A repository that will not open right now - moved, or on a drive that
      // is not mounted - is left out of the list but kept in storage, so it
      // comes back on its own rather than needing to be added again.
      try {
        const info = await invoke<RepoInfo>("open_repo", { path });
        if (!repos.some((r) => r.display_path === info.display_path)) repos.push(info);
      } catch {
        continue;
      }
    }
    return repos;
  },
  listRefs: (repo) => invoke<RefsResult>("list_refs", { repo }),
  getGraph: (repo, branches, limit) =>
    invoke<GraphResult>("get_graph", { repo, branches, limit }),
  getCommitDetails: (repo, id) => invoke<CommitDetails>("get_commit_details", { repo, id }),
  getCommitMeta: (repo, id) => invoke<CommitMeta>("get_commit_meta", { repo, id }),
  getReview: (repo, base, head) => invoke<ReviewResult>("get_review", { repo, base, head }),
  listTree: (repo, rev, path) => invoke<TreeResult>("list_tree", { repo, rev, path }),
  readFile: (repo, rev, path) => invoke<FileContent>("read_file", { repo, rev, path }),
  readImage: (repo, rev, path) => invoke<ImageContent>("read_image", { repo, rev, path }),
  // Downloading is an HTTP idea; the desktop build hides the link.
  rawUrl: () => null,
  // The window has no address bar, and the webview's URL is not a place.
  routable: false,
  editableRepos: true,
  async addRepo() {
    const chosen = await openDialog({ directory: true, title: "Add git repository" });
    // Cancelling is the ordinary way out of the dialog and means nothing was
    // added. Anything else that is not a path is the host surprising us, and
    // saying so is better than the button appearing to do nothing.
    if (chosen === null || chosen === undefined) return null;
    if (typeof chosen !== "string") {
      throw new Error(`the file dialog gave back ${JSON.stringify(chosen)} rather than a path`);
    }
    // Opening it first both checks that it holds a repository and settles the
    // path to store, which is the repository's root rather than what was picked.
    const info = await invoke<RepoInfo>("open_repo", { path: chosen });
    const paths = storedPaths();
    if (!paths.includes(info.display_path)) setStoredPaths([...paths, info.display_path]);
    return info;
  },
  async removeRepo(repo) {
    setStoredPaths(storedPaths().filter((p) => p !== repo));
  },
};
