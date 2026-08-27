//! Web variant of the commit browser: serves the same frontend as the Tauri
//! app over HTTP, backed by the repositories named on the command line.
//! Intended to run on a dev machine and be reached through an SSH tunnel, so it
//! binds loopback by default and exposes no repository it was not given.
//!
//! The frontend is compiled into the binary, so a release build is one file
//! that needs nothing beside it. `--static-dir` serves from disk instead, which
//! is what the frontend's own dev loop wants.

use std::net::IpAddr;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use clap::Parser;
use include_dir::{Dir, include_dir};
use serde::Serialize;
use serde_json::json;
use tower_http::services::{ServeDir, ServeFile};

static ASSETS: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../dist-web");

const DEFAULT_LIMIT: usize = 1000;

#[derive(Parser)]
#[command(about = "Browse a git repository's commit graph in a web browser")]
struct Args {
    /// Repository to browse (the working directory, or any path inside it).
    /// Repeat to serve more than one; the reader picks between them.
    #[arg(long, short)]
    repo: Vec<String>,

    /// Address to bind. Defaults to loopback; use 0.0.0.0 to expose the server
    /// on the network, which grants anyone who can reach it read access to
    /// every repository served.
    #[arg(long, default_value = "127.0.0.1")]
    host: IpAddr,

    #[arg(long, short, default_value_t = 4600)]
    port: u16,

    /// Serve the frontend from this directory instead of the copy compiled
    /// into the binary.
    #[arg(long)]
    static_dir: Option<PathBuf>,
}

struct AppState {
    /// The repositories named on the command line, in that order. Each is
    /// reopened per request; git2 handles are cheap to open and not Sync.
    repos: Vec<gitcore::RepoInfo>,
}

impl AppState {
    /// The .git directory of the repository `repo` names, which is the path the
    /// UI shows. Naming none means the first, so a URL written when the server
    /// served a single repository still lands somewhere sensible.
    fn git_dir(&self, repo: Option<&str>) -> Result<String, ApiError> {
        let found = match repo {
            Some(path) => self.repos.iter().find(|r| r.display_path == path),
            None => self.repos.first(),
        };
        match found {
            Some(info) => Ok(info.git_dir.clone()),
            None => Err(ApiError(
                StatusCode::NOT_FOUND,
                format!(
                    "not a repository this server was given: {}",
                    repo.unwrap_or("")
                ),
            )),
        }
    }
}

/// Names a repository by the path the UI shows, on every request that reads one.
#[derive(serde::Deserialize)]
struct RepoParams {
    repo: Option<String>,
}

struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

/// Runs a gitcore call off the async runtime and renders it as JSON.
async fn blocking<T, F>(f: F) -> Result<Json<T>, ApiError>
where
    T: Serialize + Send + 'static,
    F: FnOnce() -> gitcore::Result<T> + Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(Ok(value)) => Ok(Json(value)),
        Ok(Err(e)) => Err(ApiError(StatusCode::BAD_REQUEST, e)),
        Err(e) => Err(ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

/// Everything this server was pointed at, in the order it was given them. The
/// UI has no way to add to the list, so this is the whole of what it can reach.
async fn repos(State(s): State<Arc<AppState>>) -> Json<Vec<gitcore::RepoInfo>> {
    Json(s.repos.clone())
}

async fn refs(
    State(s): State<Arc<AppState>>,
    Query(p): Query<RepoParams>,
) -> Result<Json<gitcore::RefsResult>, ApiError> {
    let dir = s.git_dir(p.repo.as_deref())?;
    blocking(move || gitcore::list_refs(&dir)).await
}

/// Branches arrive as repeated `branch=` parameters; ref names may contain any
/// character except a few, so they cannot be packed into one delimited value.
async fn graph(
    State(s): State<Arc<AppState>>,
    Query(params): Query<Vec<(String, String)>>,
) -> Result<Json<gitcore::GraphResult>, ApiError> {
    let mut branches = Vec::new();
    let mut limit = DEFAULT_LIMIT;
    let mut repo = None;
    for (key, value) in params {
        match key.as_str() {
            "branch" => branches.push(value),
            "repo" => repo = Some(value),
            "limit" => {
                limit = value
                    .parse()
                    .map_err(|_| ApiError(StatusCode::BAD_REQUEST, format!("bad limit {value}")))?
            }
            _ => {}
        }
    }
    let dir = s.git_dir(repo.as_deref())?;
    blocking(move || gitcore::graph(&dir, &branches, limit)).await
}

#[derive(serde::Deserialize)]
struct ReviewParams {
    base: String,
    head: String,
    repo: Option<String>,
}

async fn review(
    State(s): State<Arc<AppState>>,
    Query(p): Query<ReviewParams>,
) -> Result<Json<gitcore::ReviewResult>, ApiError> {
    let dir = s.git_dir(p.repo.as_deref())?;
    blocking(move || gitcore::review(&dir, &p.base, &p.head)).await
}

#[derive(serde::Deserialize)]
struct PathParams {
    rev: String,
    /// Empty for the root of the tree.
    #[serde(default)]
    path: String,
    repo: Option<String>,
}

async fn tree(
    State(s): State<Arc<AppState>>,
    Query(p): Query<PathParams>,
) -> Result<Json<gitcore::TreeResult>, ApiError> {
    let dir = s.git_dir(p.repo.as_deref())?;
    blocking(move || gitcore::list_tree(&dir, &p.rev, &p.path)).await
}

async fn file(
    State(s): State<Arc<AppState>>,
    Query(p): Query<PathParams>,
) -> Result<Json<gitcore::FileContent>, ApiError> {
    let dir = s.git_dir(p.repo.as_deref())?;
    blocking(move || gitcore::read_file(&dir, &p.rev, &p.path)).await
}

async fn image(
    State(s): State<Arc<AppState>>,
    Query(p): Query<PathParams>,
) -> Result<Json<gitcore::ImageContent>, ApiError> {
    let dir = s.git_dir(p.repo.as_deref())?;
    blocking(move || gitcore::read_image(&dir, &p.rev, &p.path)).await
}

/// RFC 6266 attachment header: an ASCII fallback plus the exact name. Both are
/// escaped, so a file name from the repository cannot inject header syntax.
fn disposition(name: &str) -> String {
    let ascii: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "._-".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    let ascii = if ascii.is_empty() {
        "download".to_string()
    } else {
        ascii
    };
    let mut encoded = String::new();
    for b in name.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-' => {
                encoded.push(*b as char)
            }
            _ => encoded.push_str(&format!("%{b:02X}")),
        }
    }
    format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{encoded}")
}

/// The file's bytes as a download.
async fn raw(
    State(s): State<Arc<AppState>>,
    Query(p): Query<PathParams>,
) -> Result<Response, ApiError> {
    let dir = s.git_dir(p.repo.as_deref())?;
    let name = p.path.rsplit('/').next().unwrap_or("download").to_string();
    let bytes = match tokio::task::spawn_blocking(move || gitcore::read_blob(&dir, &p.rev, &p.path))
        .await
    {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(e)) => return Err(ApiError(StatusCode::BAD_REQUEST, e)),
        Err(e) => return Err(ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    };
    Response::builder()
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_DISPOSITION, disposition(&name))
        .body(Body::from(bytes))
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

async fn commit(
    State(s): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(p): Query<RepoParams>,
) -> Result<Json<gitcore::CommitDetails>, ApiError> {
    let dir = s.git_dir(p.repo.as_deref())?;
    blocking(move || gitcore::commit_details(&dir, &id)).await
}

/// Looks a path up in the compiled-in frontend, tolerating the leading slash a
/// request path carries.
fn asset(path: &str) -> Option<&'static include_dir::File<'static>> {
    ASSETS.get_file(path.trim_start_matches('/'))
}

/// The frontend, served out of the binary. Anything the bundle does not have is
/// answered with index.html, so a reload of an in-app URL lands on the app
/// rather than a 404, matching what ServeDir does under --static-dir.
async fn embedded(uri: Uri) -> Response {
    let (file, mime) = match asset(uri.path()) {
        Some(file) => (
            file,
            mime_guess::from_path(uri.path()).first_or_octet_stream(),
        ),
        None => match asset("index.html") {
            Some(index) => (index, mime_guess::mime::TEXT_HTML_UTF_8),
            None => {
                let msg = "no frontend was built into this binary";
                return (StatusCode::NOT_FOUND, msg).into_response();
            }
        },
    };
    ([(header::CONTENT_TYPE, mime.as_ref())], file.contents()).into_response()
}

/// Open every repository named on the command line, in the order given. No
/// name at all means the working directory, as it always has.
fn open_all(paths: &[String]) -> Result<Vec<gitcore::RepoInfo>, String> {
    let wanted: Vec<String> = if paths.is_empty() {
        vec![".".to_string()]
    } else {
        paths.to_vec()
    };
    let mut opened: Vec<gitcore::RepoInfo> = Vec::new();
    for path in &wanted {
        let info = gitcore::open_repo(path)
            .map_err(|e| format!("cannot open repository at {path}: {e}"))?;
        // Two arguments can name one repository from different directories
        // inside it; keep the first and say nothing.
        if !opened.iter().any(|r| r.git_dir == info.git_dir) {
            opened.push(info);
        }
    }
    Ok(opened)
}

/// The API alone, waiting for its state. The frontend is attached separately,
/// which leaves this the whole of what the tests need.
fn api_router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/repos", get(repos))
        .route("/api/refs", get(refs))
        .route("/api/graph", get(graph))
        .route("/api/review", get(review))
        .route("/api/tree", get(tree))
        .route("/api/file", get(file))
        .route("/api/image", get(image))
        .route("/api/raw", get(raw))
        .route("/api/commits/{id}", get(commit))
}

#[tokio::main]
async fn main() -> ExitCode {
    let args = Args::parse();

    let opened = match open_all(&args.repo) {
        Ok(opened) => opened,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };

    let app = api_router();

    let app = match &args.static_dir {
        Some(dir) => {
            if !dir.join("index.html").exists() {
                eprintln!("warning: no index.html under {}", dir.display());
            }
            // Unknown paths fall back to index.html so the page survives a reload.
            app.fallback_service(
                ServeDir::new(dir).fallback(ServeFile::new(dir.join("index.html"))),
            )
        }
        None => {
            // Not fatal: `npm run dev:web` proxies to this server for the API alone,
            // and serves the frontend itself.
            if asset("index.html").is_none() {
                eprintln!(
                    "warning: no frontend was compiled into this binary - run \
                     `npm run build:web` and rebuild, or pass --static-dir"
                );
            }
            app.fallback(embedded)
        }
    };

    let app = app.with_state(Arc::new(AppState {
        repos: opened.clone(),
    }));

    let listener = match tokio::net::TcpListener::bind((args.host, args.port)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("cannot bind {}:{}: {e}", args.host, args.port);
            return ExitCode::FAILURE;
        }
    };
    println!("commit-browser: http://{}:{}", args.host, args.port);
    for info in &opened {
        println!("  {}", info.display_path);
    }

    if let Err(e) = axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
    {
        eprintln!("server error: {e}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}
