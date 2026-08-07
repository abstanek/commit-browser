//! Web variant of the commit browser: serves the same frontend as the Tauri
//! app over HTTP, backed by one repository named on the command line. Intended
//! to run on a dev machine and be reached through an SSH tunnel, so it binds
//! loopback by default and exposes no way to open a different repository.

use std::net::IpAddr;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use clap::Parser;
use serde::Serialize;
use serde_json::json;
use tower_http::services::{ServeDir, ServeFile};

const DEFAULT_LIMIT: usize = 1000;

#[derive(Parser)]
#[command(about = "Browse a git repository's commit graph in a web browser")]
struct Args {
    /// Repository to browse (the working directory, or any path inside it).
    #[arg(long, short, default_value = ".")]
    repo: String,

    /// Address to bind. Defaults to loopback; use 0.0.0.0 to expose the server
    /// on the network, which grants anyone who can reach it read access to the
    /// repository.
    #[arg(long, default_value = "127.0.0.1")]
    host: IpAddr,

    #[arg(long, short, default_value_t = 4600)]
    port: u16,

    /// Directory holding the built frontend. Defaults to the dist-web/ produced
    /// by `npm run build:web` in the source tree this binary was built from.
    #[arg(long)]
    static_dir: Option<PathBuf>,
}

struct AppState {
    /// Path to the .git directory. The repo is reopened per request; git2
    /// handles are cheap to open and not Sync.
    git_dir: String,
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

async fn repo(State(s): State<Arc<AppState>>) -> Result<Json<gitcore::RepoInfo>, ApiError> {
    let dir = s.git_dir.clone();
    blocking(move || gitcore::open_repo(&dir)).await
}

async fn refs(State(s): State<Arc<AppState>>) -> Result<Json<gitcore::RefsResult>, ApiError> {
    let dir = s.git_dir.clone();
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
    for (key, value) in params {
        match key.as_str() {
            "branch" => branches.push(value),
            "limit" => {
                limit = value
                    .parse()
                    .map_err(|_| ApiError(StatusCode::BAD_REQUEST, format!("bad limit {value}")))?
            }
            _ => {}
        }
    }
    let dir = s.git_dir.clone();
    blocking(move || gitcore::graph(&dir, &branches, limit)).await
}

#[derive(serde::Deserialize)]
struct ReviewParams {
    base: String,
    head: String,
}

async fn review(
    State(s): State<Arc<AppState>>,
    Query(p): Query<ReviewParams>,
) -> Result<Json<gitcore::ReviewResult>, ApiError> {
    let dir = s.git_dir.clone();
    blocking(move || gitcore::review(&dir, &p.base, &p.head)).await
}

#[derive(serde::Deserialize)]
struct PathParams {
    rev: String,
    /// Empty for the root of the tree.
    #[serde(default)]
    path: String,
}

async fn tree(
    State(s): State<Arc<AppState>>,
    Query(p): Query<PathParams>,
) -> Result<Json<gitcore::TreeResult>, ApiError> {
    let dir = s.git_dir.clone();
    blocking(move || gitcore::list_tree(&dir, &p.rev, &p.path)).await
}

async fn file(
    State(s): State<Arc<AppState>>,
    Query(p): Query<PathParams>,
) -> Result<Json<gitcore::FileContent>, ApiError> {
    let dir = s.git_dir.clone();
    blocking(move || gitcore::read_file(&dir, &p.rev, &p.path)).await
}

/// RFC 6266 attachment header: an ASCII fallback plus the exact name. Both are
/// escaped, so a file name from the repository cannot inject header syntax.
fn disposition(name: &str) -> String {
    let ascii: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '_' })
        .collect();
    let ascii = if ascii.is_empty() { "download".to_string() } else { ascii };
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
    let dir = s.git_dir.clone();
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
) -> Result<Json<gitcore::CommitDetails>, ApiError> {
    let dir = s.git_dir.clone();
    blocking(move || gitcore::commit_details(&dir, &id)).await
}

#[tokio::main]
async fn main() -> ExitCode {
    let args = Args::parse();

    let info = match gitcore::open_repo(&args.repo) {
        Ok(info) => info,
        Err(e) => {
            eprintln!("cannot open repository at {}: {e}", args.repo);
            return ExitCode::FAILURE;
        }
    };

    let static_dir = args
        .static_dir
        .unwrap_or_else(|| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../dist-web")));
    // Not fatal: `npm run dev:web` proxies to this server for the API alone.
    if !static_dir.join("index.html").exists() {
        eprintln!(
            "warning: no frontend at {} - run `npm run build:web`, or pass --static-dir",
            static_dir.display()
        );
    }

    // Unknown paths fall back to index.html so the page survives a reload.
    let files = ServeDir::new(&static_dir).fallback(ServeFile::new(static_dir.join("index.html")));

    let app = Router::new()
        .route("/api/repo", get(repo))
        .route("/api/refs", get(refs))
        .route("/api/graph", get(graph))
        .route("/api/review", get(review))
        .route("/api/tree", get(tree))
        .route("/api/file", get(file))
        .route("/api/raw", get(raw))
        .route("/api/commits/{id}", get(commit))
        .fallback_service(files)
        .with_state(Arc::new(AppState { git_dir: info.git_dir }));

    let listener = match tokio::net::TcpListener::bind((args.host, args.port)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("cannot bind {}:{}: {e}", args.host, args.port);
            return ExitCode::FAILURE;
        }
    };
    println!("commit-browser: {} at http://{}:{}", info.display_path, args.host, args.port);

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
