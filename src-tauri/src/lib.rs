use std::sync::Mutex;

use tauri::State;

/// Path to the currently opened repository's .git directory. The repo is
/// reopened per command; git2 handles are cheap to open and not Sync.
#[derive(Default)]
struct AppState {
    git_dir: Mutex<Option<String>>,
}

fn current_repo(state: &State<AppState>) -> Result<String, String> {
    state
        .git_dir
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no repository opened".to_string())
}

#[tauri::command]
fn open_repo(path: String, state: State<AppState>) -> Result<gitcore::RepoInfo, String> {
    let info = gitcore::open_repo(&path)?;
    *state.git_dir.lock().unwrap() = Some(info.git_dir.clone());
    Ok(info)
}

#[tauri::command]
fn list_refs(state: State<AppState>) -> Result<gitcore::RefsResult, String> {
    gitcore::list_refs(&current_repo(&state)?)
}

#[tauri::command]
fn get_graph(
    branches: Vec<String>,
    limit: usize,
    state: State<AppState>,
) -> Result<gitcore::GraphResult, String> {
    gitcore::graph(&current_repo(&state)?, &branches, limit)
}

#[tauri::command]
fn get_commit_details(id: String, state: State<AppState>) -> Result<gitcore::CommitDetails, String> {
    gitcore::commit_details(&current_repo(&state)?, &id)
}

#[tauri::command]
fn get_review(
    base: String,
    head: String,
    state: State<AppState>,
) -> Result<gitcore::ReviewResult, String> {
    gitcore::review(&current_repo(&state)?, &base, &head)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            open_repo,
            list_refs,
            get_graph,
            get_commit_details,
            get_review
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
