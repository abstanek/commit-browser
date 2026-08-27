/// The app's position as a URL, so the browser's history holds it and back
/// and forward move through it.
///
/// Only what identifies a position is carried: which view, and what it is
/// pointed at. Preferences such as text size or which branches the graph
/// shows stay in local storage, where they belong to the reader rather than
/// to the place.

export type View = "graph" | "review" | "files";

export interface Route {
  view: View;
  /// The repository being browsed, by the path shown for it. Absent in a URL
  /// written when the host served only one.
  repo?: string;
  /// Graph: the selected commit. Review: the commit whose own diff is shown.
  commit?: string;
  /// Review: the branches being compared, by short name.
  base?: string;
  head?: string;
  /// Files: the revision browsed, and the file open in it.
  rev?: string;
  path?: string;
}

function isView(s: string): s is View {
  return s === "graph" || s === "review" || s === "files";
}

export function toUrl(route: Route): string {
  const q = new URLSearchParams();
  // First, so the repository reads as the thing the rest of the URL is within.
  if (route.repo) q.set("repo", route.repo);
  if (route.view === "review") {
    if (route.head) q.set("head", route.head);
    if (route.base) q.set("base", route.base);
    if (route.commit) q.set("commit", route.commit);
  } else if (route.view === "files") {
    if (route.rev) q.set("rev", route.rev);
    if (route.path) q.set("path", route.path);
  } else if (route.commit) {
    q.set("commit", route.commit);
  }
  // Slashes are legal in a query and branch names and paths are full of them,
  // so leave them be rather than reading as %2F.
  const query = q.toString().replace(/%2F/g, "/");
  return `/${route.view}${query ? `?${query}` : ""}`;
}

/// The route a URL names, or null if it names nothing this app serves.
export function fromUrl(url: URL): Route | null {
  const view = url.pathname.replace(/^\/+|\/+$/g, "");
  if (!isView(view)) return null;
  const q = url.searchParams;
  const value = (name: string) => q.get(name) || undefined;
  return {
    view,
    repo: value("repo"),
    commit: value("commit"),
    base: value("base"),
    head: value("head"),
    rev: value("rev"),
    path: value("path"),
  };
}

export function sameUrl(url: string): boolean {
  return url === `${location.pathname}${location.search}`;
}
