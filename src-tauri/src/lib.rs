/// Every command names the repository it reads, by the path the UI shows. The
/// repository is reopened per command; git2 handles are cheap to open and not
/// Sync, and the list of repositories lives in the frontend, which is what the
/// reader adds to and removes from.
fn git_dir(repo: &str) -> Result<String, String> {
    Ok(gitcore::open_repo(repo)?.git_dir)
}

/// Reads a repository so the UI can name it, and confirms the path holds one
/// before it is added to the list.
#[tauri::command]
fn open_repo(path: String) -> Result<gitcore::RepoInfo, String> {
    gitcore::open_repo(&path)
}

#[tauri::command]
fn list_refs(repo: String) -> Result<gitcore::RefsResult, String> {
    gitcore::list_refs(&git_dir(&repo)?)
}

#[tauri::command]
fn get_graph(
    repo: String,
    branches: Vec<String>,
    limit: usize,
) -> Result<gitcore::GraphResult, String> {
    gitcore::graph(&git_dir(&repo)?, &branches, limit)
}

#[tauri::command]
fn get_commit_details(repo: String, id: String) -> Result<gitcore::CommitDetails, String> {
    gitcore::commit_details(&git_dir(&repo)?, &id)
}

#[tauri::command]
fn get_commit_meta(repo: String, id: String) -> Result<gitcore::CommitMeta, String> {
    gitcore::commit_meta(&git_dir(&repo)?, &id)
}

#[tauri::command]
fn get_review(repo: String, base: String, head: String) -> Result<gitcore::ReviewResult, String> {
    gitcore::review(&git_dir(&repo)?, &base, &head)
}

#[tauri::command]
fn list_tree(repo: String, rev: String, path: String) -> Result<gitcore::TreeResult, String> {
    gitcore::list_tree(&git_dir(&repo)?, &rev, &path)
}

#[tauri::command]
fn read_file(repo: String, rev: String, path: String) -> Result<gitcore::FileContent, String> {
    gitcore::read_file(&git_dir(&repo)?, &rev, &path)
}

#[tauri::command]
fn read_image(repo: String, rev: String, path: String) -> Result<gitcore::ImageContent, String> {
    gitcore::read_image(&git_dir(&repo)?, &rev, &path)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_repo,
            list_refs,
            get_graph,
            get_commit_details,
            get_commit_meta,
            get_review,
            list_tree,
            read_file,
            read_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
