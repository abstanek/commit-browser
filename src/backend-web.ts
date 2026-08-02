import type {
  Backend,
  CommitDetails,
  GraphResult,
  RefsResult,
  RepoInfo,
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
  openRepo: () => get<RepoInfo>("repo"),
  listRefs: () => get<RefsResult>("refs"),
  getGraph: (branches, limit) => {
    const q = new URLSearchParams();
    for (const b of branches) q.append("branch", b);
    q.set("limit", String(limit));
    return get<GraphResult>(`graph?${q}`);
  },
  getCommitDetails: (id) => get<CommitDetails>(`commits/${encodeURIComponent(id)}`),
  fixedRepo: true,
};
