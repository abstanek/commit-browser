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

/// Requests go to the origin serving the page, so the app works unchanged
/// through an SSH tunnel or any reverse proxy.
async function get<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/${path}`);
  } catch {
    throw new Error("cannot reach the commit-browser server");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const backend: Backend = {
  listRepos: () => get<RepoInfo[]>("repos"),
  listRefs: (repo) => get<RefsResult>(`refs?${new URLSearchParams({ repo })}`),
  getGraph: (repo, branches, limit) => {
    const q = new URLSearchParams({ repo });
    for (const b of branches) q.append("branch", b);
    q.set("limit", String(limit));
    return get<GraphResult>(`graph?${q}`);
  },
  getCommitDetails: (repo, id) =>
    get<CommitDetails>(
      `commits/${encodeURIComponent(id)}?${new URLSearchParams({ repo })}`,
    ),
  getCommitMeta: (repo, id) =>
    get<CommitMeta>(
      `commits/${encodeURIComponent(id)}/meta?${new URLSearchParams({ repo })}`,
    ),
  getReview: (repo, base, head) =>
    get<ReviewResult>(`review?${new URLSearchParams({ repo, base, head })}`),
  listTree: (repo, rev, path) =>
    get<TreeResult>(`tree?${new URLSearchParams({ repo, rev, path })}`),
  readFile: (repo, rev, path) =>
    get<FileContent>(`file?${new URLSearchParams({ repo, rev, path })}`),
  readImage: (repo, rev, path) =>
    get<ImageContent>(`image?${new URLSearchParams({ repo, rev, path })}`),
  rawUrl: (repo, rev, path) => `/api/raw?${new URLSearchParams({ repo, rev, path })}`,
  routable: true,
  // The server is pointed at its repositories on the command line; the reader
  // browsing it has no say in the list.
  editableRepos: false,
};
