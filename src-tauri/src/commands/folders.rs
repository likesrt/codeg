use std::collections::{hash_map::DefaultHasher, HashMap, HashSet};
use std::fs::OpenOptions;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::UNIX_EPOCH;

use base64::Engine as _;
use serde::{Deserialize, Serialize};

use tokio::sync::Semaphore;
use walkdir::WalkDir;

#[cfg(feature = "tauri-runtime")]
use tauri::Manager;

use crate::app_error::AppCommandError;
use crate::db::error::DbError;
use crate::db::service::folder_service;
use crate::db::AppDatabase;
use crate::models::GitCredentials;
use crate::models::{FolderDetail, FolderHistoryEntry};
use crate::web::event_bridge::EventEmitter;

/// Configure a git command for remote operations:
/// - Always disable interactive prompts (prevent hanging in a GUI app)
/// - If explicit credentials are provided, use them directly
/// - Otherwise, try to inject stored account credentials
async fn prepare_remote_git_cmd(
    cmd: &mut tokio::process::Command,
    repo_path: &str,
    credentials: Option<&GitCredentials>,
    db: &AppDatabase,
    data_dir: &std::path::Path,
) {
    prepare_remote_git_cmd_with_remote(cmd, repo_path, None, credentials, db, data_dir).await;
}

/// Same as `prepare_remote_git_cmd` but allows specifying a remote name
/// to match credentials against the correct remote URL.
async fn prepare_remote_git_cmd_with_remote(
    cmd: &mut tokio::process::Command,
    repo_path: &str,
    remote_name: Option<&str>,
    credentials: Option<&GitCredentials>,
    db: &AppDatabase,
    data_dir: &std::path::Path,
) {
    cmd.env("GIT_TERMINAL_PROMPT", "0").stdin(Stdio::null());

    if let Some(creds) = credentials {
        // Explicit credentials provided (e.g. from credential dialog)
        if let Ok(askpass) = crate::git_credential::ensure_askpass_script(data_dir) {
            crate::git_credential::inject_credentials(
                cmd,
                &creds.username,
                &creds.password,
                &askpass,
            );
        }
    } else {
        // Fall back to stored accounts, matching against the specified remote
        crate::git_credential::try_inject_for_repo_remote(
            cmd,
            repo_path,
            remote_name,
            &db.conn,
            data_dir,
        )
        .await;
    }
}

/// Same as `prepare_remote_git_cmd` but for clone (URL only, no repo yet).
async fn prepare_remote_git_cmd_for_url(
    cmd: &mut tokio::process::Command,
    clone_url: &str,
    credentials: Option<&GitCredentials>,
    db: &AppDatabase,
    data_dir: &std::path::Path,
) {
    cmd.env("GIT_TERMINAL_PROMPT", "0").stdin(Stdio::null());

    if let Some(creds) = credentials {
        if let Ok(askpass) = crate::git_credential::ensure_askpass_script(data_dir) {
            crate::git_credential::inject_credentials(
                cmd,
                &creds.username,
                &creds.password,
                &askpass,
            );
        }
    } else {
        crate::git_credential::try_inject_for_url(cmd, clone_url, &db.conn, data_dir).await;
    }
}

/// Classify a git remote command error, detecting authentication failures.
fn classify_remote_git_error(operation: &str, stderr: &[u8]) -> AppCommandError {
    let msg = String::from_utf8_lossy(stderr).trim().to_string();
    eprintln!("[GIT_CMD] {} failed, stderr: {}", operation, msg);
    let lower = msg.to_lowercase();

    if lower.contains("authentication failed")
        || lower.contains("invalid credentials")
        || lower.contains("could not read username")
        || lower.contains("could not read password")
        || lower.contains("logon failed")
        || lower.contains("terminal prompts disabled")
        || lower.contains("the requested url returned error: 401")
        || lower.contains("the requested url returned error: 403")
        || lower.contains("http basic: access denied")
    {
        return AppCommandError::authentication_failed(format!(
            "git {operation}: authentication failed. Configure a GitHub account in Settings → Version Control."
        ))
        .with_detail(msg);
    }

    if lower.contains("could not resolve host")
        || lower.contains("unable to access")
        || lower.contains("connection refused")
        || lower.contains("network is unreachable")
    {
        return AppCommandError::network(format!("git {operation}: network error"))
            .with_detail(msg);
    }

    AppCommandError::external_command(format!("git {operation} failed"), msg)
}

#[derive(Debug, Serialize)]
pub struct GitStatusEntry {
    pub status: String,
    pub file: String,
}

#[derive(Debug, Serialize)]
pub struct GitBranchList {
    pub local: Vec<String>,
    pub remote: Vec<String>,
    pub worktree_branches: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct GitConflictInfo {
    pub has_conflicts: bool,
    pub conflicted_files: Vec<String>,
    pub operation: String,
    pub upstream_commit: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GitPullResult {
    pub updated_files: usize,
    pub conflict: Option<GitConflictInfo>,
}

#[derive(Debug, Serialize)]
pub struct GitPushResult {
    pub pushed_commits: usize,
    pub upstream_set: bool,
}

#[derive(Debug, Serialize)]
pub struct GitPushInfo {
    pub branch: String,
    pub remotes: Vec<GitRemote>,
    pub tracking_remote: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GitMergeResult {
    pub merged_commits: usize,
    pub conflict: Option<GitConflictInfo>,
}

#[derive(Debug, Serialize)]
pub struct GitRebaseResult {
    pub message: String,
    pub conflict: Option<GitConflictInfo>,
}

#[derive(Debug, Serialize)]
pub struct GitConflictFileVersions {
    pub base: String,
    pub ours: String,
    pub theirs: String,
    pub merged: String,
}

#[derive(Debug, Serialize)]
pub struct GitCommitResult {
    pub committed_files: usize,
}

#[derive(Debug, Serialize)]
pub struct GitStashEntry {
    pub index: usize,
    pub message: String,
    pub branch: String,
    pub date: String,
    pub ref_name: String,
}

#[derive(Debug, Serialize)]
pub struct GitRemote {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
struct GitCommitSucceededEvent {
    folder_id: i32,
    committed_files: usize,
}

#[derive(Debug, Clone, Serialize)]
struct GitPushSucceededEvent {
    folder_id: i32,
    pushed_commits: usize,
    upstream_set: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FileTreeNode {
    File {
        name: String,
        path: String,
    },
    Dir {
        name: String,
        path: String,
        children: Vec<FileTreeNode>,
    },
}

#[derive(Debug, Serialize)]
pub struct FilePreviewContent {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
pub struct FileEditContent {
    pub path: String,
    pub content: String,
    pub etag: String,
    pub mtime_ms: Option<i64>,
    pub readonly: bool,
    pub line_ending: String,
}

#[derive(Debug, Serialize)]
pub struct FileSaveResult {
    pub path: String,
    pub etag: String,
    pub mtime_ms: Option<i64>,
    pub readonly: bool,
    pub line_ending: String,
}

#[derive(Debug, Serialize)]
pub struct GitLogEntry {
    pub hash: String,
    pub full_hash: String,
    pub author: String,
    pub date: String,
    pub message: String,
    pub files: Vec<GitLogFileChange>,
    pub pushed: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct GitLogFileChange {
    pub path: String,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Serialize)]
pub struct GitLogResult {
    pub entries: Vec<GitLogEntry>,
    pub has_upstream: bool,
}

fn count_non_empty_lines(content: &str) -> usize {
    content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .count()
}

fn parse_count_from_output(stdout: &[u8]) -> Option<usize> {
    String::from_utf8_lossy(stdout).trim().parse::<usize>().ok()
}

fn git_command_error(operation: &str, stderr: &[u8]) -> AppCommandError {
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    AppCommandError::external_command(format!("git {operation} failed"), stderr)
}

use crate::git_repo::ensure_git_repo;

async fn detect_conflicts(path: &str) -> Result<Vec<String>, AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args(["-c", "core.quotePath=false"])
        .args(["diff", "--name-only", "--diff-filter=U"])
        .current_dir(path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Ok(vec![]);
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(unquote_git_path)
        .filter(|l| !l.is_empty())
        .collect())
}

async fn get_head_hash(path: &str) -> Result<Option<String>, AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Ok(None);
    }

    let head = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if head.is_empty() {
        return Ok(None);
    }
    Ok(Some(head))
}

async fn count_files_in_commit(path: &str, commit: &str) -> Result<usize, AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args(["show", "--name-only", "--pretty=format:", commit])
        .current_dir(path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("show", &output.stderr));
    }

    Ok(count_non_empty_lines(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

async fn count_changed_files_between(
    path: &str,
    base: &str,
    head: &str,
) -> Result<usize, AppCommandError> {
    let range = format!("{}..{}", base, head);
    let output = crate::process::tokio_command("git")
        .args(["diff", "--name-only", &range])
        .current_dir(path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("diff", &output.stderr));
    }

    Ok(count_non_empty_lines(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

async fn estimate_push_commit_count(path: &str) -> usize {
    let upstream_ahead = crate::process::tokio_command("git")
        .args(["rev-list", "--count", "@{push}..HEAD"])
        .current_dir(path)
        .output()
        .await;
    if let Ok(output) = upstream_ahead {
        if output.status.success() {
            if let Some(count) = parse_count_from_output(&output.stdout) {
                return count;
            }
        }
    }

    let branch_output = crate::process::tokio_command("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(path)
        .output()
        .await;
    let Ok(branch_output) = branch_output else {
        return 0;
    };
    if !branch_output.status.success() {
        return 0;
    }

    let branch = String::from_utf8_lossy(&branch_output.stdout)
        .trim()
        .to_string();
    if branch.is_empty() || branch == "HEAD" {
        return 0;
    }

    let remote_key = format!("branch.{}.remote", branch);
    let remote_output = crate::process::tokio_command("git")
        .args(["config", "--get", &remote_key])
        .current_dir(path)
        .output()
        .await;
    let remote = remote_output
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "origin".to_string());

    let remote_arg = format!("--remotes={}", remote);
    let output = crate::process::tokio_command("git")
        .args(["rev-list", "--count", "HEAD", "--not", &remote_arg])
        .current_dir(path)
        .output()
        .await;
    let Ok(output) = output else {
        return 0;
    };
    if !output.status.success() {
        return 0;
    }

    parse_count_from_output(&output.stdout).unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Shared core functions (used by both Tauri commands and web handlers)
// ---------------------------------------------------------------------------

pub async fn get_folder_core(db: &AppDatabase, folder_id: i32) -> Result<FolderDetail, DbError> {
    folder_service::get_folder_by_id(&db.conn, folder_id)
        .await?
        .ok_or_else(|| DbError::Migration(format!("Folder {} not found", folder_id)))
}

pub async fn load_folder_history_core(
    db: &AppDatabase,
) -> Result<Vec<FolderHistoryEntry>, AppCommandError> {
    folder_service::list_folders(&db.conn)
        .await
        .map_err(AppCommandError::from)
}

pub async fn add_folder_to_history_core(
    db: &AppDatabase,
    path: String,
) -> Result<FolderHistoryEntry, DbError> {
    folder_service::add_folder(&db.conn, &path).await
}

pub async fn remove_folder_from_history_core(
    db: &AppDatabase,
    path: String,
) -> Result<(), AppCommandError> {
    folder_service::remove_folder(&db.conn, &path)
        .await
        .map_err(AppCommandError::from)
}

pub async fn list_open_folders_core(
    db: &AppDatabase,
) -> Result<Vec<FolderHistoryEntry>, AppCommandError> {
    folder_service::list_open_folders(&db.conn)
        .await
        .map_err(AppCommandError::from)
}

pub async fn list_open_folder_details_core(
    db: &AppDatabase,
) -> Result<Vec<FolderDetail>, AppCommandError> {
    folder_service::list_open_folder_details(&db.conn)
        .await
        .map_err(AppCommandError::from)
}

pub async fn list_all_folder_details_core(
    db: &AppDatabase,
) -> Result<Vec<FolderDetail>, AppCommandError> {
    folder_service::list_all_folder_details(&db.conn)
        .await
        .map_err(AppCommandError::from)
}

pub async fn open_folder_core(
    db: &AppDatabase,
    path: String,
) -> Result<FolderDetail, AppCommandError> {
    let entry = folder_service::add_folder(&db.conn, &path)
        .await
        .map_err(AppCommandError::from)?;
    folder_service::get_folder_by_id(&db.conn, entry.id)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| AppCommandError::not_found("Folder not found after add"))
}

/// Open a folder into the workspace and announce it so the workspace window
/// can surface it. Used by the project launcher, which lives in its own
/// window/tab and can't reach the workspace's React state directly. Emitting
/// through the shared `EventEmitter` routes the signal correctly in every
/// runtime — Tauri events (desktop), the WebSocket broadcaster (server), and
/// the remote server's broadcaster (remote desktop) — so only windows talking
/// to this same backend react.
pub async fn open_folder_in_workspace_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    path: String,
) -> Result<FolderDetail, AppCommandError> {
    let detail = open_folder_core(db, path).await?;
    crate::web::event_bridge::emit_event(emitter, "folder://open-in-workspace", &detail);
    Ok(detail)
}

pub async fn open_folder_by_id_core(
    db: &AppDatabase,
    folder_id: i32,
) -> Result<FolderDetail, AppCommandError> {
    folder_service::set_folder_open(&db.conn, folder_id, true)
        .await
        .map_err(AppCommandError::from)?;
    folder_service::get_folder_by_id(&db.conn, folder_id)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| AppCommandError::not_found(format!("Folder {folder_id} not found")))
}

pub async fn remove_folder_from_workspace_core(
    db: &AppDatabase,
    folder_id: i32,
) -> Result<(), AppCommandError> {
    use crate::db::service::tab_service;
    tab_service::delete_tabs_for_folder(&db.conn, folder_id)
        .await
        .map_err(AppCommandError::from)?;
    folder_service::set_folder_open(&db.conn, folder_id, false)
        .await
        .map_err(AppCommandError::from)
}

pub async fn reorder_folders_core(db: &AppDatabase, ids: Vec<i32>) -> Result<(), AppCommandError> {
    folder_service::reorder_folders(&db.conn, ids)
        .await
        .map_err(AppCommandError::from)
}

pub async fn update_folder_color_core(
    db: &AppDatabase,
    folder_id: i32,
    color: String,
) -> Result<FolderDetail, AppCommandError> {
    folder_service::update_folder_color(&db.conn, folder_id, &color)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| AppCommandError::not_found("Folder not found"))
}

pub async fn update_folder_default_agent_core(
    db: &AppDatabase,
    folder_id: i32,
    default_agent_type: Option<crate::models::agent::AgentType>,
) -> Result<FolderDetail, AppCommandError> {
    folder_service::update_folder_default_agent(&db.conn, folder_id, default_agent_type)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| AppCommandError::not_found("Folder not found"))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilesRequest {
    pub root_path: String,
    pub query: String,
    pub search_dirs: Option<Vec<String>>,
    pub include_extensions: Option<Vec<String>>,
    pub exclude_extensions: Option<Vec<String>>,
    pub exclude_dirs: Option<Vec<String>>,
    pub max_results: Option<usize>,
    pub max_file_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFileMatch {
    pub path: String,
    pub name: String,
    pub line_number: usize,
    pub line_text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilesResponse {
    pub results: Vec<SearchFileMatch>,
    pub truncated: bool,
    pub scanned_files: usize,
    pub skipped_files: usize,
}

#[derive(Debug, Clone)]
struct SearchConfig {
    root: PathBuf,
    query_lower: String,
    include_extensions: HashSet<String>,
    exclude_extensions: HashSet<String>,
    exclude_dirs: HashSet<String>,
    max_results: usize,
    max_file_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SearchStep {
    Continue,
    Stop,
}

/// Return the default directory names skipped by file content search.
///
/// These filters are applied to directory basenames and common relative paths so
/// generated dependencies, VCS metadata, and build outputs do not dominate
/// results. It takes no parameters, returns normalized lowercase filters, and
/// has no filesystem side effects.
pub fn default_search_exclude_dirs() -> Vec<String> {
    [
        ".git",
        "node_modules",
        "target",
        "dist",
        "build",
        ".next",
        ".turbo",
        "coverage",
        "out",
        "public/vs",
        "__pycache__",
        ".venv",
        "venv",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

/// Return the default file extensions skipped by file content search.
///
/// These extensions cover archives, media, images, and compiled artifacts that
/// are usually binary or too noisy for text search. It takes no parameters,
/// returns lowercase extension names without dots, and has no side effects.
pub fn default_search_exclude_extensions() -> Vec<String> {
    [
        "png", "jpg", "jpeg", "gif", "webp", "ico", "pdf", "zip", "tar", "gz", "7z", "rar", "exe",
        "dll", "so", "dylib", "bin", "lock",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

/// Normalize extension filters for case-insensitive suffix comparisons.
///
/// Each entry is trimmed, lowercased, and stripped of a leading dot. Empty
/// entries are dropped, duplicates collapse in the returned set, and the input
/// collection is otherwise not modified.
pub fn normalize_extensions(values: Option<Vec<String>>) -> HashSet<String> {
    values
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| {
            let trimmed = value.trim().trim_start_matches('.').to_lowercase();
            (!trimmed.is_empty()).then_some(trimmed)
        })
        .collect()
}

/// Normalize directory filters for basename or relative-path matching.
///
/// Filters are trimmed, converted to forward-slash lowercase form, and stripped
/// of leading `./` or `/` so callers may pass UI-friendly paths. Empty filters
/// are ignored; the returned set is used read-only while walking directories.
pub fn normalize_dir_filters(values: Option<Vec<String>>) -> HashSet<String> {
    values
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| normalize_dir_filter(&value))
        .collect()
}

/// Detect whether a byte buffer is likely binary content.
///
/// The check treats NUL bytes as binary and otherwise allows normal text bytes;
/// callers should still validate UTF-8 separately. It reads only the provided
/// bytes, returns false for empty buffers, and performs no I/O.
pub fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|byte| *byte == 0)
}

/// Search text files below a root directory using case-insensitive containment.
///
/// `request` supplies the root, query, optional search subdirectories, filters,
/// and safety limits. Search dirs must stay inside `root`; binary, non-UTF-8, and
/// oversized files are skipped. Results stop at the clamped limit and set
/// `truncated` when more matches were available.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn search_files(
    request: SearchFilesRequest,
) -> Result<SearchFilesResponse, AppCommandError> {
    if request.query.trim().is_empty() {
        return Ok(empty_search_response());
    }
    run_file_io(move || search_files_blocking(request)).await
}

/// Return an empty file-search response without touching the filesystem.
///
/// Empty queries are treated as a valid no-op so callers can clear UI search
/// boxes without surfacing validation errors. The response contains no results,
/// is not truncated, and reports zero scanned or skipped files.
fn empty_search_response() -> SearchFilesResponse {
    SearchFilesResponse {
        results: Vec::new(),
        truncated: false,
        scanned_files: 0,
        skipped_files: 0,
    }
}

/// Execute file content search on a blocking worker thread.
///
/// `request` is consumed so all filesystem path validation, directory walking,
/// metadata reads, and file reads happen away from the async runtime. It returns
/// the complete response or the first validation/I/O error encountered.
fn search_files_blocking(
    request: SearchFilesRequest,
) -> Result<SearchFilesResponse, AppCommandError> {
    let config = build_search_config(&request)?;
    let search_dirs = resolve_search_dirs(&config.root, request.search_dirs)?;
    let mut response = empty_search_response();

    for dir in search_dirs {
        if search_dir(&dir, &config, &mut response)? == SearchStep::Stop {
            break;
        }
    }
    Ok(response)
}

/// Build normalized search settings from a user request.
///
/// This validates the root and non-empty query, clamps size/result limits, and
/// merges default plus user-provided exclusion filters. It returns a reusable
/// immutable config and only canonicalizes paths; it does not walk files.
fn build_search_config(request: &SearchFilesRequest) -> Result<SearchConfig, AppCommandError> {
    let root = canonicalize_existing_dir(&request.root_path)?;
    let query = request.query.trim();
    if query.is_empty() {
        return Err(AppCommandError::invalid_input(
            "Search query cannot be empty",
        ));
    }
    let mut exclude_extensions = normalize_extensions(Some(default_search_exclude_extensions()));
    exclude_extensions.extend(normalize_extensions(request.exclude_extensions.clone()));
    let mut exclude_dirs = normalize_dir_filters(Some(default_search_exclude_dirs()));
    exclude_dirs.extend(normalize_dir_filters(request.exclude_dirs.clone()));
    Ok(SearchConfig {
        root,
        query_lower: query.to_lowercase(),
        include_extensions: normalize_extensions(request.include_extensions.clone()),
        exclude_extensions,
        exclude_dirs,
        max_results: request.max_results.unwrap_or(100).clamp(1, 1000),
        max_file_bytes: request
            .max_file_bytes
            .unwrap_or(2 * 1024 * 1024)
            .clamp(64 * 1024, 10 * 1024 * 1024),
    })
}

/// Canonicalize an existing search root directory.
///
/// The path is trimmed and must resolve to a directory. The returned absolute
/// path is used for containment checks, and errors are mapped to user-facing app
/// errors without creating or modifying filesystem entries.
fn canonicalize_existing_dir(path: &str) -> Result<PathBuf, AppCommandError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppCommandError::invalid_input(
            "Search root cannot be empty",
        ));
    }
    let root = std::fs::canonicalize(trimmed).map_err(AppCommandError::io)?;
    if !root.is_dir() {
        return Err(AppCommandError::invalid_input(
            "Search root must be a directory",
        ));
    }
    Ok(root)
}

/// Resolve requested search directories under the canonical root.
///
/// Relative entries are joined to `root`, absolute entries are used directly,
/// and every resolved directory must remain inside `root`. Missing paths and
/// escape attempts return errors; an empty list defaults to the root itself.
/// Canonical duplicates and child directories already covered by an earlier
/// parent are collapsed so each file tree is walked at most once.
fn resolve_search_dirs(
    root: &Path,
    search_dirs: Option<Vec<String>>,
) -> Result<Vec<PathBuf>, AppCommandError> {
    let dirs = search_dirs
        .filter(|dirs| !dirs.is_empty())
        .unwrap_or_else(|| vec![".".to_string()]);
    let mut resolved = Vec::new();
    for dir in dirs {
        let candidate = resolve_search_dir_candidate(root, &dir)?;
        if !resolved.iter().any(|path| path == &candidate) {
            resolved.push(candidate);
        }
    }
    resolved.sort_by_key(|path| path.components().count());
    resolved.dedup_by(|a, b| a == b);
    let mut covered = Vec::new();
    for candidate in resolved {
        if !covered.iter().any(|parent: &PathBuf| candidate.starts_with(parent)) {
            covered.push(candidate);
        }
    }
    Ok(covered)
}

/// Resolve one search directory candidate and enforce root containment.
///
/// The candidate may be relative to `root` or absolute; canonicalization follows
/// existing filesystem state so symlinks cannot escape containment unnoticed.
/// The returned directory is canonical and safe to walk.
fn resolve_search_dir_candidate(root: &Path, dir: &str) -> Result<PathBuf, AppCommandError> {
    let trimmed = dir.trim();
    if trimmed.is_empty() {
        return Err(AppCommandError::invalid_input(
            "Search directory cannot be empty",
        ));
    }
    let candidate = if Path::new(trimmed).is_absolute() {
        PathBuf::from(trimmed)
    } else {
        root.join(trimmed)
    };
    let canonical = std::fs::canonicalize(candidate).map_err(AppCommandError::io)?;
    if !canonical.is_dir() || !canonical.starts_with(root) {
        return Err(AppCommandError::invalid_input(
            "Search directory must stay inside the root",
        ));
    }
    Ok(canonical)
}

/// Walk one directory tree and append matching lines to the response.
///
/// The walk applies directory, extension, binary, encoding, and size filters.
/// Unreadable entries are counted as skipped and do not abort sibling files.
/// It returns `Stop` as soon as the result limit is exceeded so callers can
/// avoid unnecessary I/O after the response is known to be truncated.
fn search_dir(
    dir: &Path,
    config: &SearchConfig,
    response: &mut SearchFilesResponse,
) -> Result<SearchStep, AppCommandError> {
    for entry in WalkDir::new(dir)
        .into_iter()
        .filter_entry(|e| should_descend(e, config))
    {
        let Ok(entry) = entry else {
            response.skipped_files += 1;
            continue;
        };
        if !entry.file_type().is_file() {
            continue;
        }
        if !should_search_file(entry.path(), config, response)? {
            continue;
        }
        if search_file(entry.path(), config, response)? == SearchStep::Stop {
            return Ok(SearchStep::Stop);
        }
    }
    Ok(SearchStep::Continue)
}

/// Decide whether a directory walker should descend into an entry.
///
/// Non-directories are always kept for later file checks. Directory basenames
/// and root-relative paths are matched against normalized exclusions, preventing
/// noisy subtrees from being read while preserving sibling traversal.
fn should_descend(entry: &walkdir::DirEntry, config: &SearchConfig) -> bool {
    if !entry.file_type().is_dir() || entry.path() == config.root {
        return true;
    }
    !is_excluded_dir(entry.path(), config)
}

/// Decide whether a file should be opened for text search.
///
/// The check enforces max byte size and include/exclude extension filters before
/// reading content. Filtered or unreadable files increment `skipped_files`; no
/// file content is read here, and sibling files keep being searched.
fn should_search_file(
    path: &Path,
    config: &SearchConfig,
    response: &mut SearchFilesResponse,
) -> Result<bool, AppCommandError> {
    let Ok(metadata) = std::fs::metadata(path) else {
        response.skipped_files += 1;
        return Ok(false);
    };
    if metadata.len() > config.max_file_bytes {
        response.skipped_files += 1;
        return Ok(false);
    }
    let ext = file_extension(path);
    if !config.include_extensions.is_empty()
        && !ext
            .as_ref()
            .is_some_and(|e| config.include_extensions.contains(e))
    {
        response.skipped_files += 1;
        return Ok(false);
    }
    if ext
        .as_ref()
        .is_some_and(|e| config.exclude_extensions.contains(e))
    {
        response.skipped_files += 1;
        return Ok(false);
    }
    Ok(true)
}

/// Search a single UTF-8 text file and append matching lines.
///
/// The file is read as bytes to skip binary and non-UTF-8 content safely. Binary
/// detection is limited to the first 8192 bytes for predictable overhead. Scanned
/// and skipped counters are updated according to whether text search runs; read
/// errors count as skipped so one volatile file cannot abort the whole search.
fn search_file(
    path: &Path,
    config: &SearchConfig,
    response: &mut SearchFilesResponse,
) -> Result<SearchStep, AppCommandError> {
    let Ok(bytes) = std::fs::read(path) else {
        response.skipped_files += 1;
        return Ok(SearchStep::Continue);
    };
    if looks_binary(&bytes[..bytes.len().min(8192)]) {
        response.skipped_files += 1;
        return Ok(SearchStep::Continue);
    }
    let Ok(content) = std::str::from_utf8(&bytes) else {
        response.skipped_files += 1;
        return Ok(SearchStep::Continue);
    };
    response.scanned_files += 1;
    append_line_matches(path, content, config, response)
}

/// Append matching lines from one file's text content.
///
/// Matching is ordinary case-insensitive substring search; no regex syntax is
/// interpreted. The response is mutated in place and signals `Stop` when adding
/// another match would exceed `max_results`.
fn append_line_matches(
    path: &Path,
    content: &str,
    config: &SearchConfig,
    response: &mut SearchFilesResponse,
) -> Result<SearchStep, AppCommandError> {
    for (index, line) in content.lines().enumerate() {
        if !line.to_lowercase().contains(&config.query_lower) {
            continue;
        }
        if response.results.len() >= config.max_results {
            response.truncated = true;
            return Ok(SearchStep::Stop);
        }
        push_search_match(path, line, index + 1, config, response)?;
    }
    Ok(SearchStep::Continue)
}

/// Add one bounded search match to the response.
///
/// The line text is shortened around the query before serialization so minified
/// generated files cannot send multi-megabyte rows back to the webview. The
/// filesystem is not touched; path validation is delegated to relative path
/// conversion.
fn push_search_match(
    path: &Path,
    line: &str,
    line_number: usize,
    config: &SearchConfig,
    response: &mut SearchFilesResponse,
) -> Result<(), AppCommandError> {
    response.results.push(SearchFileMatch {
        path: relative_path_string(&config.root, path)?,
        name: file_name_string(path),
        line_number,
        line_text: snippet_around_query(line, &config.query_lower),
    });
    Ok(())
}

/// Build a compact line preview centered on the matched query.
///
/// Matching is case-insensitive and uses character indices so UTF-8 boundaries
/// remain valid. Lines shorter than the preview limit are returned unchanged;
/// longer lines receive ellipses on the trimmed sides.
fn snippet_around_query(line: &str, query_lower: &str) -> String {
    const MAX: usize = 240;
    if line.chars().count() <= MAX {
        return line.to_string();
    }
    let lower = line.to_lowercase();
    let match_byte = lower.find(query_lower).unwrap_or(0);
    let match_char = line[..match_byte].chars().count();
    let half = MAX / 2;
    let start = match_char.saturating_sub(half);
    let end = start + MAX;
    compact_char_range(line, start, end)
}

/// Return one character range with ellipses when content is omitted.
///
/// `start` and `end` are character offsets, not bytes. The function walks the
/// string once and allocates only the returned preview, keeping long minified
/// lines cheap to display.
fn compact_char_range(line: &str, start: usize, end: usize) -> String {
    let total = line.chars().count();
    let body: String = line
        .chars()
        .skip(start)
        .take(end.saturating_sub(start))
        .collect();
    match (start > 0, end < total) {
        (true, true) => format!("…{body}…"),
        (true, false) => format!("…{body}"),
        (false, true) => format!("{body}…"),
        (false, false) => body,
    }
}

/// Return a displayable file basename for a search result.
///
/// The basename comes from the path's final component and falls back to the full
/// path string for unusual paths without a Unicode filename. It performs no I/O
/// and is used only for response serialization.
fn file_name_string(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

/// Normalize one directory filter value.
///
/// This helper is shared by public normalization and matching code. It accepts
/// platform separators, trims leading relative markers, returns lowercase text,
/// and drops empty values without touching the filesystem.
fn normalize_dir_filter(value: &str) -> Option<String> {
    let mut normalized = value.trim().replace('\\', "/").to_lowercase();
    while let Some(stripped) = normalized.strip_prefix("./") {
        normalized = stripped.to_string();
    }
    let normalized = normalized
        .trim_start_matches('/')
        .trim_end_matches('/')
        .to_string();
    (!normalized.is_empty()).then_some(normalized)
}

/// Return a lowercase extension without the leading dot.
///
/// Paths without a valid Unicode extension return `None`. The result is used for
/// case-insensitive include/exclude checks and does not inspect file contents or
/// metadata.
fn file_extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_lowercase)
        .filter(|ext| !ext.is_empty())
}

/// Check whether a directory is excluded by basename or relative path.
///
/// Basenames handle broad filters like `node_modules`; relative paths allow UI
/// callers to exclude a specific subtree. The function reads only path strings
/// and has no filesystem side effects.
fn is_excluded_dir(path: &Path, config: &SearchConfig) -> bool {
    let basename = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if config.exclude_dirs.contains(&basename.to_lowercase()) {
        return true;
    }
    relative_path_string(&config.root, path)
        .ok()
        .and_then(|relative| normalize_dir_filter(&relative))
        .is_some_and(|relative| config.exclude_dirs.contains(&relative))
}

/// Convert a path under root into a forward-slash relative string.
///
/// The path must be contained by `root`; otherwise an invalid-input error is
/// returned. The output is stable for frontend display across platforms and does
/// not alter the filesystem.
fn relative_path_string(root: &Path, path: &Path) -> Result<String, AppCommandError> {
    let relative = path.strip_prefix(root).map_err(|_| {
        AppCommandError::invalid_input("Search result path must stay inside the root")
    })?;
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

// ---------------------------------------------------------------------------
// Tauri command wrappers (thin shims over _core)
// ---------------------------------------------------------------------------

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_folder(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
) -> Result<FolderDetail, DbError> {
    get_folder_core(&db, folder_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn load_folder_history(
    db: tauri::State<'_, AppDatabase>,
) -> Result<Vec<FolderHistoryEntry>, AppCommandError> {
    load_folder_history_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn add_folder_to_history(
    db: tauri::State<'_, AppDatabase>,
    path: String,
) -> Result<FolderHistoryEntry, DbError> {
    add_folder_to_history_core(&db, path).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn remove_folder_from_history(
    db: tauri::State<'_, AppDatabase>,
    path: String,
) -> Result<(), AppCommandError> {
    remove_folder_from_history_core(&db, path).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn list_open_folder_details(
    db: tauri::State<'_, AppDatabase>,
) -> Result<Vec<FolderDetail>, AppCommandError> {
    list_open_folder_details_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn list_all_folder_details(
    db: tauri::State<'_, AppDatabase>,
) -> Result<Vec<FolderDetail>, AppCommandError> {
    list_all_folder_details_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn open_folder(
    db: tauri::State<'_, AppDatabase>,
    path: String,
) -> Result<FolderDetail, AppCommandError> {
    open_folder_core(&db, path).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn open_folder_in_workspace(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    path: String,
) -> Result<FolderDetail, AppCommandError> {
    let emitter = EventEmitter::Tauri(app);
    open_folder_in_workspace_core(&emitter, &db, path).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn open_folder_by_id(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
) -> Result<FolderDetail, AppCommandError> {
    open_folder_by_id_core(&db, folder_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn remove_folder_from_workspace(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
) -> Result<(), AppCommandError> {
    remove_folder_from_workspace_core(&db, folder_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn reorder_folders(
    db: tauri::State<'_, AppDatabase>,
    ids: Vec<i32>,
) -> Result<(), AppCommandError> {
    reorder_folders_core(&db, ids).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_folder_color(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
    color: String,
) -> Result<FolderDetail, AppCommandError> {
    update_folder_color_core(&db, folder_id, color).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_folder_default_agent(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
    default_agent_type: Option<crate::models::agent::AgentType>,
) -> Result<FolderDetail, AppCommandError> {
    update_folder_default_agent_core(&db, folder_id, default_agent_type).await
}

/// Create one new directory for the in-app directory browser.
///
/// `path` is trimmed before use, must point at a missing target, and must have
/// an existing parent directory. This intentionally calls `create_dir` instead
/// of `create_dir_all` so duplicate names and missing parents surface as user
/// visible errors instead of being silently accepted.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn create_folder_directory(path: String) -> Result<(), AppCommandError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppCommandError::invalid_input("Path cannot be empty"));
    }

    let target = PathBuf::from(trimmed);
    if target.exists() {
        return Err(AppCommandError::already_exists("Directory already exists"));
    }

    let parent = target
        .parent()
        .ok_or_else(|| AppCommandError::invalid_input("Directory must have a parent"))?;
    if !parent.is_dir() {
        return Err(AppCommandError::not_found(
            "Parent directory does not exist",
        ));
    }

    std::fs::create_dir(&target).map_err(AppCommandError::io)
}

pub(crate) async fn clone_repository_core(
    url: &str,
    target_dir: &str,
    credentials: Option<&GitCredentials>,
    db: &AppDatabase,
    data_dir: &std::path::Path,
) -> Result<(), AppCommandError> {
    if url.trim().is_empty() || target_dir.trim().is_empty() {
        return Err(AppCommandError::invalid_input(
            "Repository URL and target directory are required",
        ));
    }

    let mut cmd = crate::process::tokio_command("git");
    cmd.args(["clone", url, target_dir]);
    prepare_remote_git_cmd_for_url(&mut cmd, url, credentials, db, data_dir).await;

    let output = cmd.output().await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppCommandError::dependency_missing("Git is not installed. Please install Git first.")
                .with_detail("https://git-scm.com")
        } else {
            AppCommandError::external_command("Failed to run git clone", e.to_string())
        }
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(classify_git_clone_error(stderr.trim()));
    }
    Ok(())
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn clone_repository(
    url: String,
    target_dir: String,
    credentials: Option<GitCredentials>,
    db: tauri::State<'_, AppDatabase>,
    app_handle: tauri::AppHandle,
) -> Result<(), AppCommandError> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| {
        AppCommandError::external_command("Failed to resolve app data dir", e.to_string())
    })?;
    // Resolve through the effective data dir so a custom
    // `CODEG_DATA_DIR` reaches the git credential helper invoked by
    // this subprocess.
    let data_dir = crate::paths::resolve_effective_data_dir(&data_dir);
    clone_repository_core(&url, &target_dir, credentials.as_ref(), &db, &data_dir).await
}

fn classify_git_clone_error(stderr: &str) -> AppCommandError {
    let normalized = stderr.to_lowercase();

    if normalized.contains("already exists and is not an empty directory") {
        return AppCommandError::already_exists("Target directory already exists and is not empty")
            .with_detail(stderr.to_string());
    }

    if normalized.contains("repository not found") {
        return AppCommandError::not_found(
            "Repository not found. Check URL and access permissions.",
        )
        .with_detail(stderr.to_string());
    }

    if normalized.contains("could not resolve host")
        || normalized.contains("network is unreachable")
        || normalized.contains("connection timed out")
        || normalized.contains("failed to connect")
    {
        return AppCommandError::network("Network is unavailable while cloning repository")
            .with_detail(stderr.to_string());
    }

    if normalized.contains("authentication failed")
        || normalized.contains("could not read username")
        || normalized.contains("could not read password")
        || normalized.contains("logon failed")
        || normalized.contains("terminal prompts disabled")
        || normalized.contains("the requested url returned error: 401")
        || normalized.contains("the requested url returned error: 403")
        || normalized.contains("http basic: access denied")
        || normalized.contains("permission denied (publickey)")
    {
        return AppCommandError::authentication_failed(
            "Authentication failed while cloning repository",
        )
        .with_detail(stderr.to_string());
    }

    if normalized.contains("permission denied") {
        return AppCommandError::permission_denied("Permission denied while cloning repository")
            .with_detail(stderr.to_string());
    }

    AppCommandError::external_command("Git clone failed", stderr.to_string())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_git_branch(path: String) -> Result<Option<String>, AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if output.status.success() {
        let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !branch.is_empty() && branch != "HEAD" {
            return Ok(Some(branch));
        }
    }

    // Fallback: symbolic-ref works on unborn branches (after git init, before first commit)
    let sym_output = crate::process::tokio_command("git")
        .args(["symbolic-ref", "--short", "HEAD"])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if sym_output.status.success() {
        let branch = String::from_utf8_lossy(&sym_output.stdout)
            .trim()
            .to_string();
        if !branch.is_empty() {
            return Ok(Some(branch));
        }
    }

    Ok(None)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_init(path: String) -> Result<(), AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args(["init"])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("init", &output.stderr));
    }
    Ok(())
}

pub(crate) async fn git_pull_core(
    path: &str,
    credentials: Option<&GitCredentials>,
    db: &AppDatabase,
    data_dir: &std::path::Path,
) -> Result<GitPullResult, AppCommandError> {
    let head_before = get_head_hash(path).await?;

    // Step 1: fetch from remote
    let mut fetch_cmd = crate::process::tokio_command("git");
    fetch_cmd.args(["fetch"]).current_dir(path);
    prepare_remote_git_cmd(&mut fetch_cmd, path, credentials, db, data_dir).await;

    let fetch_output = fetch_cmd.output().await.map_err(AppCommandError::io)?;

    if !fetch_output.status.success() {
        return Err(classify_remote_git_error("fetch", &fetch_output.stderr));
    }

    // Step 2: check if upstream exists
    let upstream_check = crate::process::tokio_command("git")
        .args(["rev-parse", "@{u}"])
        .current_dir(path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !upstream_check.status.success() {
        return Ok(GitPullResult {
            updated_files: 0,
            conflict: None,
        });
    }
    let upstream_commit = String::from_utf8_lossy(&upstream_check.stdout)
        .trim()
        .to_string();

    // Step 3: check if we can fast-forward
    let merge_base = crate::process::tokio_command("git")
        .args(["merge-base", "HEAD", "@{u}"])
        .current_dir(path)
        .output()
        .await
        .map_err(AppCommandError::io)?;
    let head_hash = crate::process::tokio_command("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    let base_hash = String::from_utf8_lossy(&merge_base.stdout)
        .trim()
        .to_string();
    let current_head = String::from_utf8_lossy(&head_hash.stdout)
        .trim()
        .to_string();

    if base_hash == current_head {
        let ff_output = crate::process::tokio_command("git")
            .args(["merge", "--ff-only", "@{u}"])
            .current_dir(path)
            .output()
            .await
            .map_err(AppCommandError::io)?;

        if !ff_output.status.success() {
            return Err(git_command_error("merge --ff-only", &ff_output.stderr));
        }
    } else {
        let merge_output = crate::process::tokio_command("git")
            .args(["merge", "--no-commit", "@{u}"])
            .current_dir(path)
            .output()
            .await
            .map_err(AppCommandError::io)?;

        if !merge_output.status.success() {
            let conflicted_files = detect_conflicts(path).await?;
            if !conflicted_files.is_empty() {
                let _ = crate::process::tokio_command("git")
                    .args(["merge", "--abort"])
                    .current_dir(path)
                    .output()
                    .await;

                return Ok(GitPullResult {
                    updated_files: 0,
                    conflict: Some(GitConflictInfo {
                        has_conflicts: true,
                        conflicted_files,
                        operation: "pull".to_string(),
                        upstream_commit: Some(upstream_commit),
                    }),
                });
            }
            return Err(git_command_error("merge", &merge_output.stderr));
        }

        let commit_output = crate::process::tokio_command("git")
            .args(["commit", "--no-edit"])
            .current_dir(path)
            .output()
            .await
            .map_err(AppCommandError::io)?;

        if !commit_output.status.success() {
            let stderr = String::from_utf8_lossy(&commit_output.stderr);
            let stdout = String::from_utf8_lossy(&commit_output.stdout);
            if !stderr.contains("nothing to commit") && !stdout.contains("nothing to commit") {
                return Err(git_command_error("commit", &commit_output.stderr));
            }
        }
    }

    let head_after = get_head_hash(path).await?;
    let updated_files = match (head_before.as_deref(), head_after.as_deref()) {
        (Some(before), Some(after)) if before != after => {
            count_changed_files_between(path, before, after).await?
        }
        (None, Some(after)) => count_files_in_commit(path, after).await?,
        _ => 0,
    };

    Ok(GitPullResult {
        updated_files,
        conflict: None,
    })
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_pull(
    path: String,
    credentials: Option<GitCredentials>,
    db: tauri::State<'_, AppDatabase>,
    app_handle: tauri::AppHandle,
) -> Result<GitPullResult, AppCommandError> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| {
        AppCommandError::external_command("Failed to resolve app data dir", e.to_string())
    })?;
    // Resolve through the effective data dir so a custom
    // `CODEG_DATA_DIR` reaches the git credential helper invoked by
    // this subprocess.
    let data_dir = crate::paths::resolve_effective_data_dir(&data_dir);
    git_pull_core(&path, credentials.as_ref(), &db, &data_dir).await
}

/// Start a merge with the upstream branch (used by merge workspace after pull conflict detection).
/// This recreates the conflict state so that :1:, :2:, :3: stage entries are available.
/// If `upstream_commit` is provided, merge against that specific commit instead of `@{u}`.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_start_pull_merge(
    path: String,
    upstream_commit: Option<String>,
) -> Result<(), AppCommandError> {
    let target = upstream_commit.as_deref().unwrap_or("@{u}");
    let output = crate::process::tokio_command("git")
        .args(["merge", "--no-commit", target])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    // It's expected to fail with conflicts — that's the point.
    // We just need the merge state to be active so stage entries exist.
    if !output.status.success() {
        let conflicted_files = detect_conflicts(&path).await?;
        if !conflicted_files.is_empty() {
            return Ok(()); // Conflict state is now active — merge workspace can proceed
        }
        return Err(git_command_error("merge", &output.stderr));
    }

    Ok(())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_has_merge_head(path: String) -> Result<bool, AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args(["rev-parse", "--verify", "MERGE_HEAD"])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;
    Ok(output.status.success())
}

pub(crate) async fn git_fetch_core(
    path: &str,
    credentials: Option<&GitCredentials>,
    db: &AppDatabase,
    data_dir: &std::path::Path,
) -> Result<String, AppCommandError> {
    let mut cmd = crate::process::tokio_command("git");
    cmd.args(["fetch", "--all"]).current_dir(path);
    prepare_remote_git_cmd(&mut cmd, path, credentials, db, data_dir).await;

    let output = cmd.output().await.map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(classify_remote_git_error("fetch --all", &output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stderr).trim().to_string())
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_fetch(
    path: String,
    credentials: Option<GitCredentials>,
    db: tauri::State<'_, AppDatabase>,
    app_handle: tauri::AppHandle,
) -> Result<String, AppCommandError> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| {
        AppCommandError::external_command("Failed to resolve app data dir", e.to_string())
    })?;
    // Resolve through the effective data dir so a custom
    // `CODEG_DATA_DIR` reaches the git credential helper invoked by
    // this subprocess.
    let data_dir = crate::paths::resolve_effective_data_dir(&data_dir);
    git_fetch_core(&path, credentials.as_ref(), &db, &data_dir).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_push_info(path: String) -> Result<GitPushInfo, AppCommandError> {
    ensure_git_repo(&path)?;

    // Get current branch name
    let branch_output = crate::process::tokio_command("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;
    let branch = String::from_utf8_lossy(&branch_output.stdout)
        .trim()
        .to_string();

    // Get tracking remote for current branch
    let remote_key = format!("branch.{}.remote", branch);
    let remote_output = crate::process::tokio_command("git")
        .args(["config", "--get", &remote_key])
        .current_dir(&path)
        .output()
        .await;
    let tracking_remote = remote_output
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|v| !v.is_empty());

    // Get all remotes
    let remotes = git_list_remotes(path).await?;

    Ok(GitPushInfo {
        branch,
        remotes,
        tracking_remote,
    })
}

pub(crate) async fn git_push_core(
    data_dir: &std::path::Path,
    emitter: &EventEmitter,
    folder_id: Option<i32>,
    path: &str,
    remote: Option<&str>,
    credentials: Option<&GitCredentials>,
    db: &AppDatabase,
) -> Result<GitPushResult, AppCommandError> {
    let pushed_commits = estimate_push_commit_count(path).await;

    let target_remote = remote.filter(|s| !s.is_empty()).unwrap_or("origin");

    let branch_output = crate::process::tokio_command("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(path)
        .output()
        .await
        .map_err(AppCommandError::io)?;
    let branch = String::from_utf8_lossy(&branch_output.stdout)
        .trim()
        .to_string();

    let upstream_check = crate::process::tokio_command("git")
        .args(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
        .current_dir(path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    let current_upstream = if upstream_check.status.success() {
        Some(
            String::from_utf8_lossy(&upstream_check.stdout)
                .trim()
                .to_string(),
        )
    } else {
        None
    };

    let needs_set_upstream = match &current_upstream {
        None => true,
        Some(upstream) => !upstream.starts_with(&format!("{}/", target_remote)),
    };

    let output = if needs_set_upstream {
        let mut cmd = crate::process::tokio_command("git");
        cmd.args(["push", "--set-upstream", target_remote, &branch])
            .current_dir(path);
        prepare_remote_git_cmd_with_remote(
            &mut cmd,
            path,
            Some(target_remote),
            credentials,
            db,
            data_dir,
        )
        .await;
        cmd.output().await.map_err(AppCommandError::io)?
    } else {
        let mut cmd = crate::process::tokio_command("git");
        cmd.args(["push", target_remote, &branch]).current_dir(path);
        prepare_remote_git_cmd_with_remote(
            &mut cmd,
            path,
            Some(target_remote),
            credentials,
            db,
            data_dir,
        )
        .await;
        cmd.output().await.map_err(AppCommandError::io)?
    };

    if !output.status.success() {
        return Err(classify_remote_git_error("push", &output.stderr));
    }

    let upstream_set = needs_set_upstream;

    if let Some(folder_id) = folder_id {
        crate::web::event_bridge::emit_event(
            emitter,
            "folder://git-push-succeeded",
            GitPushSucceededEvent {
                folder_id,
                pushed_commits,
                upstream_set,
            },
        );
    }

    Ok(GitPushResult {
        pushed_commits,
        upstream_set,
    })
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_push(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    path: String,
    remote: Option<String>,
    credentials: Option<GitCredentials>,
    folder_id: Option<i32>,
    db: tauri::State<'_, AppDatabase>,
) -> Result<GitPushResult, AppCommandError> {
    let folder_id = folder_id.or_else(|| {
        window
            .label()
            .strip_prefix("push-")
            .and_then(|value| value.parse::<i32>().ok())
    });
    let data_dir = app.path().app_data_dir().map_err(|e| {
        AppCommandError::external_command("Failed to resolve app data dir", e.to_string())
    })?;
    // Resolve through the effective data dir so a custom
    // `CODEG_DATA_DIR` reaches the git credential helper invoked by
    // this subprocess.
    let data_dir = crate::paths::resolve_effective_data_dir(&data_dir);
    let emitter = EventEmitter::Tauri(app.clone());
    git_push_core(
        &data_dir,
        &emitter,
        folder_id,
        &path,
        remote.as_deref(),
        credentials.as_ref(),
        &db,
    )
    .await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_new_branch(
    path: String,
    branch_name: String,
    start_point: Option<String>,
) -> Result<(), AppCommandError> {
    let mut args = vec!["checkout".to_string(), "-b".to_string(), branch_name];
    if let Some(start_point) = start_point {
        let trimmed = start_point.trim();
        if !trimmed.is_empty() {
            args.push(trimmed.to_string());
        }
    }

    let output = crate::process::tokio_command("git")
        .args(&args)
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("checkout -b", &output.stderr));
    }
    Ok(())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_worktree_add(
    path: String,
    branch_name: String,
    worktree_path: String,
) -> Result<(), AppCommandError> {
    // 校验分支是否已存在
    let check = crate::process::tokio_command("git")
        .args([
            "rev-parse",
            "--verify",
            &format!("refs/heads/{}", branch_name),
        ])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;
    if check.status.success() {
        return Err(
            AppCommandError::already_exists("Branch already exists").with_detail(branch_name)
        );
    }

    // 校验目录是否已存在
    if std::path::Path::new(&worktree_path).exists() {
        return Err(
            AppCommandError::already_exists("Worktree directory already exists")
                .with_detail(worktree_path),
        );
    }

    // 执行 git worktree add -b <branch> <path>
    let output = crate::process::tokio_command("git")
        .args(["worktree", "add", "-b", &branch_name, &worktree_path])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("worktree add", &output.stderr));
    }
    Ok(())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_checkout(path: String, branch_name: String) -> Result<(), AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args(["checkout", &branch_name])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("checkout", &output.stderr));
    }
    Ok(())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_reset(path: String, commit: String, mode: String) -> Result<(), AppCommandError> {
    let mode = mode.trim().to_lowercase();
    let mode_flag = match mode.as_str() {
        "soft" | "mixed" | "hard" | "keep" => format!("--{mode}"),
        _ => {
            return Err(AppCommandError::invalid_input(
                "Reset mode must be one of: soft, mixed, hard, keep",
            ))
        }
    };

    let output = crate::process::tokio_command("git")
        .args(["reset", mode_flag.as_str(), commit.as_str()])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("reset", &output.stderr));
    }

    Ok(())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_list_branches(path: String) -> Result<Vec<String>, AppCommandError> {
    ensure_git_repo(&path)?;

    let output = crate::process::tokio_command("git")
        .args(["branch", "--format=%(refname:short)"])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("branch", &output.stderr));
    }

    let branches = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    Ok(branches)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_stash_push(
    path: String,
    message: Option<String>,
    keep_index: bool,
) -> Result<String, AppCommandError> {
    let mut args = vec!["stash".to_string(), "push".to_string()];
    if let Some(msg) = message {
        if !msg.is_empty() {
            args.push("-m".to_string());
            args.push(msg);
        }
    }
    if keep_index {
        args.push("--keep-index".to_string());
    }
    let output = crate::process::tokio_command("git")
        .args(&args)
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("stash push", &output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_stash_pop(
    path: String,
    stash_ref: Option<String>,
) -> Result<String, AppCommandError> {
    let mut args = vec!["stash", "pop"];
    let stash_ref_val;
    if let Some(ref r) = stash_ref {
        stash_ref_val = r.clone();
        args.push(&stash_ref_val);
    }
    let output = crate::process::tokio_command("git")
        .args(&args)
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("stash pop", &output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_stash_list(path: String) -> Result<Vec<GitStashEntry>, AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args(["stash", "list", "--format=%gd||%gs||%ci"])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("stash list", &output.stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let entries = stdout
        .lines()
        .filter(|l| !l.is_empty())
        .enumerate()
        .filter_map(|(i, line)| {
            let parts: Vec<&str> = line.splitn(3, "||").collect();
            if parts.len() < 3 {
                return None;
            }
            let ref_name = parts[0].to_string();
            let subject = parts[1];
            let date = parts[2].to_string();

            // Parse branch and message from subject like "On branch: message" or "WIP on branch: hash"
            let (branch, message) = if let Some(rest) = subject.strip_prefix("On ") {
                if let Some(colon_pos) = rest.find(": ") {
                    let branch = rest[..colon_pos].to_string();
                    let msg = rest[colon_pos + 2..].to_string();
                    (branch, msg)
                } else {
                    (String::new(), subject.to_string())
                }
            } else if let Some(rest) = subject.strip_prefix("WIP on ") {
                if let Some(colon_pos) = rest.find(": ") {
                    let branch = rest[..colon_pos].to_string();
                    let msg = rest[colon_pos + 2..].to_string();
                    (branch, msg)
                } else {
                    (String::new(), subject.to_string())
                }
            } else {
                (String::new(), subject.to_string())
            };

            Some(GitStashEntry {
                index: i,
                message,
                branch,
                date,
                ref_name,
            })
        })
        .collect();

    Ok(entries)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_stash_apply(path: String, stash_ref: String) -> Result<String, AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args(["stash", "apply", &stash_ref])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("stash apply", &output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_stash_drop(path: String, stash_ref: String) -> Result<String, AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args(["stash", "drop", &stash_ref])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("stash drop", &output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_stash_clear(path: String) -> Result<String, AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args(["stash", "clear"])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("stash clear", &output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_stash_show(
    path: String,
    stash_ref: String,
) -> Result<Vec<GitStatusEntry>, AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args(["-c", "core.quotePath=false"])
        .args(["stash", "show", "--name-status", &stash_ref])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("stash show", &output.stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let entries = stdout
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|line| {
            let mut parts = line.splitn(2, '\t');
            let status = parts.next()?.trim().to_string();
            let file = unquote_git_path(parts.next()?);
            Some(GitStatusEntry { status, file })
        })
        .collect();

    Ok(entries)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_status(
    path: String,
    show_all_untracked: Option<bool>,
) -> Result<Vec<GitStatusEntry>, AppCommandError> {
    ensure_git_repo(&path)?;

    let untracked_mode = if show_all_untracked.unwrap_or(false) {
        "-uall"
    } else {
        "-unormal"
    };
    // `--no-optional-locks` keeps this read-only query from contending with
    // concurrent agent writes on `.git/index.lock`. See PR #215 follow-up.
    let output = crate::process::tokio_command("git")
        .arg("--no-optional-locks")
        .args(["-c", "core.quotePath=false"])
        .args(["status", "--porcelain=v1", untracked_mode])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("status", &output.stderr));
    }

    let entries = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|l| !l.is_empty())
        .map(|line| {
            let status = line[..2].trim().to_string();
            let file = unquote_git_path(&line[3..]);
            GitStatusEntry { status, file }
        })
        .collect();
    Ok(entries)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_is_tracked(path: String, file: String) -> Result<bool, AppCommandError> {
    let literal_file = to_git_literal_pathspec(&file);
    let output = crate::process::tokio_command("git")
        .args(["ls-files", "--error-unmatch", "--"])
        .arg(&literal_file)
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    Ok(output.status.success())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_diff(path: String, file: Option<String>) -> Result<String, AppCommandError> {
    ensure_git_repo(&path)?;

    let literal_file = file.as_deref().map(to_git_literal_pathspec);
    let mut args = vec!["diff".to_string(), "HEAD".to_string()];
    if let Some(ref f) = literal_file {
        args.push("--".to_string());
        args.push(f.clone());
    }

    let output = crate::process::tokio_command("git")
        .args(&args)
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        // For new repos with no HEAD, fall back to diff --cached
        let mut fallback_args = vec!["diff".to_string(), "--cached".to_string()];
        if let Some(ref f) = literal_file {
            fallback_args.push("--".to_string());
            fallback_args.push(f.clone());
        }
        let fallback = crate::process::tokio_command("git")
            .args(&fallback_args)
            .current_dir(&path)
            .output()
            .await
            .map_err(AppCommandError::io)?;
        return Ok(String::from_utf8_lossy(&fallback.stdout).to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_diff_with_branch(
    path: String,
    branch: String,
    file: Option<String>,
) -> Result<String, AppCommandError> {
    ensure_git_repo(&path)?;

    let target_branch = branch.trim();
    if target_branch.is_empty() {
        return Err(AppCommandError::invalid_input(
            "Branch name cannot be empty",
        ));
    }

    let literal_file = file.as_deref().map(to_git_literal_pathspec);
    let mut args = vec![
        "diff".to_string(),
        "--no-color".to_string(),
        target_branch.to_string(),
    ];
    if let Some(ref f) = literal_file {
        args.push("--".to_string());
        args.push(f.clone());
    }

    let output = crate::process::tokio_command("git")
        .args(&args)
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppCommandError::external_command(
            "git diff failed",
            format!("branch={target_branch}; {stderr}"),
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_show_diff(
    path: String,
    commit: String,
    file: Option<String>,
) -> Result<String, AppCommandError> {
    ensure_git_repo(&path)?;

    let literal_file = file.as_deref().map(to_git_literal_pathspec);
    let mut args = vec![
        "show".to_string(),
        "--no-color".to_string(),
        "--format=".to_string(),
        commit,
    ];
    if let Some(ref f) = literal_file {
        args.push("--".to_string());
        args.push(f.clone());
    }

    let output = crate::process::tokio_command("git")
        .args(&args)
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("show", &output.stderr));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_show_file(
    path: String,
    file: String,
    ref_name: Option<String>,
) -> Result<String, AppCommandError> {
    ensure_git_repo(&path)?;

    let git_ref = ref_name.unwrap_or_else(|| "HEAD".to_string());
    let file_spec = format!("{}:{}", git_ref, file);

    let output = crate::process::tokio_command("git")
        .args(["show", &file_spec])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        // File doesn't exist at this ref (e.g. new/untracked file) — return empty
        return Ok(String::new());
    }

    let bytes = &output.stdout;
    if bytes.iter().take(2048).any(|b| *b == 0) {
        return Err(
            AppCommandError::invalid_input("Binary files are not supported").with_detail(file_spec),
        );
    }

    Ok(String::from_utf8_lossy(bytes).to_string())
}

pub(crate) async fn git_commit_core(
    emitter: &EventEmitter,
    folder_id: Option<i32>,
    conn: &sea_orm::DatabaseConnection,
    path: &str,
    message: &str,
    files: &[String],
) -> Result<GitCommitResult, AppCommandError> {
    // Find files already staged for deletion — git add would fail on these
    // because they no longer exist in either the working tree or the index.
    let staged_deletions: std::collections::HashSet<String> = crate::process::tokio_command("git")
        .args(["diff", "--cached", "--name-only", "--diff-filter=D", "-z"])
        .current_dir(path)
        .output()
        .await
        .ok()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .split('\0')
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();

    // Stage only files that aren't already staged deletions
    let files_to_add: Vec<_> = files
        .iter()
        .filter(|f| !staged_deletions.contains(f.as_str()))
        .collect();

    if !files_to_add.is_empty() {
        let mut add_args = vec!["add".to_string(), "--".to_string()];
        add_args.extend(
            files_to_add
                .iter()
                .map(|file| to_git_literal_pathspec(file)),
        );

        let add_output = crate::process::tokio_command("git")
            .args(&add_args)
            .current_dir(path)
            .output()
            .await
            .map_err(AppCommandError::io)?;

        if !add_output.status.success() {
            return Err(git_command_error("add", &add_output.stderr));
        }
    }

    // Resolve commit author from matching account (e.g. GitHub username)
    let author_override = crate::git_credential::resolve_commit_author(path, conn).await;

    // Commit
    let mut commit_cmd = crate::process::tokio_command("git");
    if let Some((ref name, ref email)) = author_override {
        commit_cmd.args([
            "-c",
            &format!("user.name={name}"),
            "-c",
            &format!("user.email={email}"),
        ]);
    }
    commit_cmd.args(["commit", "-m", message]).current_dir(path);

    let commit_output = commit_cmd.output().await.map_err(AppCommandError::io)?;

    if !commit_output.status.success() {
        return Err(git_command_error("commit", &commit_output.stderr));
    }

    let committed_files = count_files_in_commit(path, "HEAD")
        .await
        .unwrap_or(files.len());

    if let Some(folder_id) = folder_id {
        crate::web::event_bridge::emit_event(
            emitter,
            "folder://git-commit-succeeded",
            GitCommitSucceededEvent {
                folder_id,
                committed_files,
            },
        );
    }

    Ok(GitCommitResult { committed_files })
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_commit(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    db: tauri::State<'_, AppDatabase>,
    path: String,
    message: String,
    files: Vec<String>,
    folder_id: Option<i32>,
) -> Result<GitCommitResult, AppCommandError> {
    let folder_id = folder_id.or_else(|| {
        window
            .label()
            .strip_prefix("commit-")
            .and_then(|value| value.parse::<i32>().ok())
    });
    let emitter = EventEmitter::Tauri(app.clone());
    git_commit_core(&emitter, folder_id, &db.conn, &path, &message, &files).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_rollback_file(path: String, file: String) -> Result<(), AppCommandError> {
    let target = file.trim();
    if target.is_empty() {
        return Err(AppCommandError::invalid_input("File path cannot be empty"));
    }

    let literal_file = to_git_literal_pathspec(target);
    let restore_output = crate::process::tokio_command("git")
        .args([
            "restore",
            "--source=HEAD",
            "--staged",
            "--worktree",
            "--",
            &literal_file,
        ])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if restore_output.status.success() {
        return Ok(());
    }

    let restore_stderr = String::from_utf8_lossy(&restore_output.stderr)
        .trim()
        .to_string();
    let restore_stderr_lower = restore_stderr.to_lowercase();
    let supports_restore = !restore_stderr_lower.contains("unknown option")
        && !restore_stderr_lower.contains("unknown switch")
        && !restore_stderr_lower.contains("not a git command")
        && !restore_stderr_lower.contains("did you mean");

    if supports_restore {
        return Err(AppCommandError::external_command(
            "git restore failed",
            restore_stderr,
        ));
    }

    let _ = crate::process::tokio_command("git")
        .args(["reset", "HEAD", "--", &literal_file])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    let checkout_output = crate::process::tokio_command("git")
        .args(["checkout", "--", &literal_file])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !checkout_output.status.success() {
        return Err(git_command_error("checkout --", &checkout_output.stderr));
    }

    Ok(())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_add_files(path: String, files: Vec<String>) -> Result<(), AppCommandError> {
    if files.is_empty() {
        return Ok(());
    }

    let mut args = vec!["add".to_string(), "--".to_string()];
    args.extend(files.iter().map(|file| to_git_literal_pathspec(file)));

    let output = crate::process::tokio_command("git")
        .args(&args)
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("add", &output.stderr));
    }

    Ok(())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_list_all_branches(path: String) -> Result<GitBranchList, AppCommandError> {
    ensure_git_repo(&path)?;

    let local_fut = crate::process::tokio_command("git")
        .args(["branch", "--format=%(refname:short)"])
        .current_dir(&path)
        .output();

    let remote_fut = crate::process::tokio_command("git")
        .args(["branch", "-r", "--format=%(refname:short)"])
        .current_dir(&path)
        .output();

    let wt_fut = crate::process::tokio_command("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(&path)
        .output();

    let (local_output, remote_output, wt_output) = tokio::join!(local_fut, remote_fut, wt_fut);

    let local_output = local_output.map_err(AppCommandError::io)?;
    if !local_output.status.success() {
        return Err(git_command_error("branch", &local_output.stderr));
    }

    let local: Vec<String> = String::from_utf8_lossy(&local_output.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    let remote: Vec<String> = match remote_output {
        Ok(output) if output.status.success() => String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty() && !l.contains("HEAD") && l.contains('/'))
            .collect(),
        _ => vec![],
    };

    // Parse worktree entries, excluding the current worktree (path itself)
    let worktree_branches: Vec<String> = match wt_output {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let canonical_path =
                std::fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(&path));
            let mut branches = Vec::new();
            let mut current_wt_path: Option<String> = None;
            for line in stdout.lines() {
                if let Some(wt) = line.strip_prefix("worktree ") {
                    current_wt_path = Some(wt.trim().to_string());
                } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
                    if let Some(ref wt) = current_wt_path {
                        let wt_canonical =
                            std::fs::canonicalize(wt).unwrap_or_else(|_| PathBuf::from(wt));
                        if wt_canonical != canonical_path {
                            branches.push(b.trim().to_string());
                        }
                    }
                } else if line.is_empty() {
                    current_wt_path = None;
                }
            }
            branches
        }
        _ => vec![],
    };

    Ok(GitBranchList {
        local,
        remote,
        worktree_branches,
    })
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_list_remotes(path: String) -> Result<Vec<GitRemote>, AppCommandError> {
    ensure_git_repo(&path)?;

    let output = crate::process::tokio_command("git")
        .args(["remote", "-v"])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("remote -v", &output.stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut seen = HashSet::new();
    let mut remotes = Vec::new();
    for line in stdout.lines() {
        // Format: "name\turl (fetch|push)"
        if !line.ends_with("(fetch)") {
            continue;
        }
        let Some((name, rest)) = line.split_once('\t') else {
            continue;
        };
        let url = rest.trim_end_matches("(fetch)").trim();
        if seen.insert(name.to_string()) {
            remotes.push(GitRemote {
                name: name.to_string(),
                url: url.to_string(),
            });
        }
    }
    Ok(remotes)
}

pub(crate) async fn git_fetch_remote_core(
    path: &str,
    name: &str,
    credentials: Option<&GitCredentials>,
    db: &AppDatabase,
    data_dir: &std::path::Path,
) -> Result<String, AppCommandError> {
    let mut cmd = crate::process::tokio_command("git");
    cmd.args(["fetch", name]).current_dir(path);
    prepare_remote_git_cmd_with_remote(&mut cmd, path, Some(name), credentials, db, data_dir).await;

    let output = cmd.output().await.map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(classify_remote_git_error("fetch", &output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stderr).trim().to_string())
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_fetch_remote(
    path: String,
    name: String,
    credentials: Option<GitCredentials>,
    db: tauri::State<'_, AppDatabase>,
    app_handle: tauri::AppHandle,
) -> Result<String, AppCommandError> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| {
        AppCommandError::external_command("Failed to resolve app data dir", e.to_string())
    })?;
    // Resolve through the effective data dir so a custom
    // `CODEG_DATA_DIR` reaches the git credential helper invoked by
    // this subprocess.
    let data_dir = crate::paths::resolve_effective_data_dir(&data_dir);
    git_fetch_remote_core(&path, &name, credentials.as_ref(), &db, &data_dir).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_add_remote(
    path: String,
    name: String,
    url: String,
) -> Result<(), AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args(["remote", "add", &name, &url])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("remote add", &output.stderr));
    }
    Ok(())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_remove_remote(path: String, name: String) -> Result<(), AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args(["remote", "remove", &name])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("remote remove", &output.stderr));
    }
    Ok(())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_set_remote_url(
    path: String,
    name: String,
    url: String,
) -> Result<(), AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args(["remote", "set-url", &name, &url])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("remote set-url", &output.stderr));
    }
    Ok(())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_merge(
    path: String,
    branch_name: String,
) -> Result<GitMergeResult, AppCommandError> {
    // Count commits to be merged before performing merge
    let count_output = crate::process::tokio_command("git")
        .args(["rev-list", "--count", &format!("HEAD..{}", branch_name)])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    let merged_commits = if count_output.status.success() {
        String::from_utf8_lossy(&count_output.stdout)
            .trim()
            .parse::<usize>()
            .unwrap_or(0)
    } else {
        0
    };

    let output = crate::process::tokio_command("git")
        .args(["merge", &branch_name])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        let conflicted_files = detect_conflicts(&path).await?;
        if !conflicted_files.is_empty() {
            return Ok(GitMergeResult {
                merged_commits,
                conflict: Some(GitConflictInfo {
                    has_conflicts: true,
                    conflicted_files,
                    operation: "merge".to_string(),
                    upstream_commit: None,
                }),
            });
        }
        return Err(git_command_error("merge", &output.stderr));
    }
    Ok(GitMergeResult {
        merged_commits,
        conflict: None,
    })
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_rebase(
    path: String,
    branch_name: String,
) -> Result<GitRebaseResult, AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args(["rebase", &branch_name])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        let conflicted_files = detect_conflicts(&path).await?;
        if !conflicted_files.is_empty() {
            return Ok(GitRebaseResult {
                message: String::from_utf8_lossy(&output.stdout).trim().to_string(),
                conflict: Some(GitConflictInfo {
                    has_conflicts: true,
                    conflicted_files,
                    operation: "rebase".to_string(),
                    upstream_commit: None,
                }),
            });
        }
        return Err(git_command_error("rebase", &output.stderr));
    }
    Ok(GitRebaseResult {
        message: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        conflict: None,
    })
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_delete_branch(
    path: String,
    branch_name: String,
    force: bool,
) -> Result<String, AppCommandError> {
    let flag = if force { "-D" } else { "-d" };
    let output = crate::process::tokio_command("git")
        .args(["branch", flag, &branch_name])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error(&format!("branch {flag}"), &output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub(crate) async fn git_delete_remote_branch_core(
    path: &str,
    remote: &str,
    branch: &str,
    credentials: Option<&GitCredentials>,
    db: &AppDatabase,
    data_dir: &std::path::Path,
) -> Result<String, AppCommandError> {
    let mut cmd = crate::process::tokio_command("git");
    cmd.args(["push", remote, "--delete", branch])
        .current_dir(path);
    prepare_remote_git_cmd_with_remote(&mut cmd, path, Some(remote), credentials, db, data_dir)
        .await;

    let output = cmd.output().await.map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(classify_remote_git_error("push --delete", &output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stderr).trim().to_string())
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_delete_remote_branch(
    path: String,
    remote: String,
    branch: String,
    credentials: Option<GitCredentials>,
    db: tauri::State<'_, AppDatabase>,
    app_handle: tauri::AppHandle,
) -> Result<String, AppCommandError> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| {
        AppCommandError::external_command("Failed to resolve app data dir", e.to_string())
    })?;
    // Resolve through the effective data dir so a custom
    // `CODEG_DATA_DIR` reaches the git credential helper invoked by
    // this subprocess.
    let data_dir = crate::paths::resolve_effective_data_dir(&data_dir);
    git_delete_remote_branch_core(
        &path,
        &remote,
        &branch,
        credentials.as_ref(),
        &db,
        &data_dir,
    )
    .await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_list_conflicts(path: String) -> Result<Vec<String>, AppCommandError> {
    detect_conflicts(&path).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_conflict_file_versions(
    path: String,
    file: String,
) -> Result<GitConflictFileVersions, AppCommandError> {
    // :1: = base (common ancestor), :2: = ours (HEAD), :3: = theirs (incoming)
    let mut versions = Vec::with_capacity(3);
    for stage in ["1", "2", "3"] {
        let file_spec = format!(":{}:{}", stage, file);
        let output = crate::process::tokio_command("git")
            .args(["show", &file_spec])
            .current_dir(&path)
            .output()
            .await
            .map_err(AppCommandError::io)?;

        if !output.status.success() {
            // File may not exist at this stage (e.g. newly added on one side)
            versions.push(String::new());
        } else {
            let bytes = &output.stdout;
            if bytes.iter().take(2048).any(|b| *b == 0) {
                return Err(
                    AppCommandError::invalid_input("Binary files are not supported")
                        .with_detail(file_spec),
                );
            }
            versions.push(String::from_utf8_lossy(bytes).to_string());
        }
    }

    // Read the working tree file (contains conflict markers)
    let file_path = Path::new(&path).join(&file);
    let merged = std::fs::read_to_string(&file_path).unwrap_or_default();

    Ok(GitConflictFileVersions {
        base: versions.remove(0),
        ours: versions.remove(0),
        theirs: versions.remove(0),
        merged,
    })
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_resolve_conflict(
    path: String,
    file: String,
    content: String,
) -> Result<(), AppCommandError> {
    let file_path = Path::new(&path).join(&file);

    // Write resolved content
    std::fs::write(&file_path, content)
        .map_err(|e| AppCommandError::io_error(format!("Failed to write resolved file: {}", e)))?;

    // Stage the resolved file
    let output = crate::process::tokio_command("git")
        .args(["add", &file])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("add", &output.stderr));
    }

    Ok(())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_abort_operation(path: String, operation: String) -> Result<(), AppCommandError> {
    let args = match operation.as_str() {
        "merge" | "pull" => vec!["merge", "--abort"],
        "rebase" => vec!["rebase", "--abort"],
        _ => {
            return Err(AppCommandError::invalid_input(format!(
                "Unknown operation: {operation}"
            )));
        }
    };

    let output = crate::process::tokio_command("git")
        .args(&args)
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error(
            &format!("{} --abort", operation),
            &output.stderr,
        ));
    }
    Ok(())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_continue_operation(
    path: String,
    operation: String,
) -> Result<(), AppCommandError> {
    let (program, args): (&str, Vec<&str>) = match operation.as_str() {
        "merge" | "pull" => ("git", vec!["commit", "--no-edit"]),
        "rebase" => ("git", vec!["rebase", "--continue"]),
        _ => {
            return Err(AppCommandError::invalid_input(format!(
                "Unknown operation: {operation}"
            )));
        }
    };

    let output = crate::process::tokio_command(program)
        .args(&args)
        .current_dir(&path)
        .env("GIT_EDITOR", "true")
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error(
            &format!("{} --continue", operation),
            &output.stderr,
        ));
    }
    Ok(())
}

const FILE_TREE_IGNORED_DIRS: &[&str] = &[".git", "__pycache__"];

/// Hard limit: refuse to open files larger than 50 MB in the text editor.
const FILE_OPEN_HARD_LIMIT: usize = 50_000_000;
/// Save limit: refuse to save content larger than 50 MB.
const FILE_SAVE_HARD_LIMIT: usize = 50_000_000;
const FILE_BASE64_DEFAULT_MAX_BYTES: usize = 20_000_000;
const FILE_BASE64_MAX_BYTES: usize = 100_000_000;
const FILE_IO_MAX_CONCURRENT_OPS: usize = 8;

static FILE_IO_SEMAPHORE: LazyLock<Semaphore> =
    LazyLock::new(|| Semaphore::new(FILE_IO_MAX_CONCURRENT_OPS));

fn to_git_literal_pathspec(path: &str) -> String {
    format!(":(literal){path}")
}

/// Remove surrounding quotes from a git output path.
/// Git quotes paths containing non-ASCII or special characters, e.g.
/// `"path/\344\270\255\346\226\207.txt"`.  With `core.quotePath=false`
/// the octal escapes are gone, but the quotes may still appear for paths
/// with spaces, tabs, etc.
fn unquote_git_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
        trimmed[1..trimmed.len() - 1].to_string()
    } else {
        trimmed.to_string()
    }
}

fn resolve_tree_path(root: &Path, rel_path: &str) -> Result<PathBuf, AppCommandError> {
    let rel = Path::new(rel_path);
    if rel.is_absolute() {
        return Err(AppCommandError::invalid_input("Path must be relative"));
    }

    for component in rel.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir => {
                return Err(AppCommandError::invalid_input("Path cannot contain '..'"));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(AppCommandError::invalid_input("Invalid path component"));
            }
        }
    }

    Ok(root.join(rel))
}

fn validate_new_name(new_name: &str) -> Result<&str, AppCommandError> {
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err(AppCommandError::invalid_input("New name cannot be empty"));
    }
    if trimmed == "." || trimmed == ".." {
        return Err(AppCommandError::invalid_input("Invalid file name"));
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err(AppCommandError::invalid_input(
            "New name cannot contain path separators",
        ));
    }
    Ok(trimmed)
}

fn file_mtime_ms(metadata: &std::fs::Metadata) -> Option<i64> {
    let modified = metadata.modified().ok()?;
    let elapsed = modified.duration_since(UNIX_EPOCH).ok()?;
    let millis = elapsed.as_millis();
    if millis > i64::MAX as u128 {
        return Some(i64::MAX);
    }
    Some(millis as i64)
}

fn detect_line_ending(content: &[u8]) -> String {
    let mut has_lf = false;
    let mut has_crlf = false;

    for index in 0..content.len() {
        if content[index] != b'\n' {
            continue;
        }

        if index > 0 && content[index - 1] == b'\r' {
            has_crlf = true;
        } else {
            has_lf = true;
        }

        if has_lf && has_crlf {
            return "mixed".to_string();
        }
    }

    if has_crlf {
        "crlf".to_string()
    } else if has_lf {
        "lf".to_string()
    } else {
        "none".to_string()
    }
}

fn compute_etag(content: &[u8], metadata: &std::fs::Metadata) -> String {
    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    if let Some(mtime_ms) = file_mtime_ms(metadata) {
        mtime_ms.hash(&mut hasher);
    }
    format!("{:016x}", hasher.finish())
}

fn ensure_path_in_workspace(root: &Path, target: &Path) -> Result<(), AppCommandError> {
    let canonical_root = std::fs::canonicalize(root).map_err(AppCommandError::io)?;
    let canonical_target = std::fs::canonicalize(target).map_err(AppCommandError::io)?;
    if !canonical_target.starts_with(&canonical_root) {
        return Err(AppCommandError::invalid_input(
            "Path is outside workspace root",
        ));
    }
    Ok(())
}

fn read_text_full(target: &Path, hard_limit: usize) -> Result<String, AppCommandError> {
    let metadata = std::fs::metadata(target).map_err(AppCommandError::io)?;
    if metadata.len() > hard_limit as u64 {
        return Err(
            AppCommandError::invalid_input("File is too large to open in editor")
                .with_detail(format!("size={}, limit={}", metadata.len(), hard_limit)),
        );
    }

    let bytes = std::fs::read(target).map_err(AppCommandError::io)?;

    if bytes.iter().take(2_048).any(|b| *b == 0) {
        return Err(AppCommandError::invalid_input(
            "Binary files are not supported in preview",
        ));
    }

    Ok(String::from_utf8_lossy(&bytes).to_string())
}

fn atomic_write_text(path: &Path, bytes: &[u8]) -> Result<(), AppCommandError> {
    let parent = path.parent().ok_or_else(|| {
        AppCommandError::invalid_input("Cannot determine parent directory for target file")
            .with_detail(path.display().to_string())
    })?;
    if !parent.exists() {
        return Err(
            AppCommandError::not_found("Parent directory does not exist")
                .with_detail(parent.display().to_string()),
        );
    }

    let temp_path = parent.join(format!(
        ".codeg-edit-{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    let existing_permissions = std::fs::metadata(path).ok().map(|m| m.permissions());

    let write_result = (|| -> Result<(), AppCommandError> {
        let mut temp = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)
            .map_err(AppCommandError::io)?;

        temp.write_all(bytes).map_err(AppCommandError::io)?;
        temp.sync_all().map_err(AppCommandError::io)?;

        if let Some(permissions) = existing_permissions {
            std::fs::set_permissions(&temp_path, permissions).map_err(AppCommandError::io)?;
        }

        replace_file(&temp_path, path)?;
        sync_directory(parent)?;
        Ok(())
    })();

    if write_result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }

    write_result
}

#[cfg(unix)]
fn replace_file(temp_path: &Path, target_path: &Path) -> Result<(), AppCommandError> {
    std::fs::rename(temp_path, target_path).map_err(AppCommandError::io)
}

#[cfg(target_os = "windows")]
fn replace_file(temp_path: &Path, target_path: &Path) -> Result<(), AppCommandError> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    fn to_wide(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    let src = to_wide(temp_path);
    let dst = to_wide(target_path);

    // SAFETY: pointers are valid and UTF-16 null-terminated for the duration of the call.
    let ok = unsafe {
        MoveFileExW(
            src.as_ptr(),
            dst.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };

    if ok == 0 {
        return Err(
            AppCommandError::io_error("Failed to atomically replace file")
                .with_detail(std::io::Error::last_os_error().to_string()),
        );
    }

    Ok(())
}

#[cfg(not(any(unix, target_os = "windows")))]
fn replace_file(temp_path: &Path, target_path: &Path) -> Result<(), AppCommandError> {
    std::fs::rename(temp_path, target_path).map_err(AppCommandError::io)
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), AppCommandError> {
    let dir = std::fs::File::open(path).map_err(AppCommandError::io)?;
    dir.sync_all().map_err(AppCommandError::io)
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), AppCommandError> {
    Ok(())
}

async fn run_file_io<T, F>(f: F) -> Result<T, AppCommandError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AppCommandError> + Send + 'static,
{
    let _permit = FILE_IO_SEMAPHORE
        .acquire()
        .await
        .map_err(|_| AppCommandError::task_execution_failed("File I/O runtime is unavailable"))?;

    tokio::task::spawn_blocking(f).await.map_err(|e| {
        AppCommandError::task_execution_failed("File I/O task failed").with_detail(e.to_string())
    })?
}

// ─── Directory browser helpers (for web/server mode) ───

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_home_directory() -> Result<String, AppCommandError> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| AppCommandError::io_error("Could not determine home directory"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
    pub has_children: bool,
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn list_directory_entries(path: String) -> Result<Vec<DirectoryEntry>, AppCommandError> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(AppCommandError::io_error("Path is not a directory").with_detail(path));
    }

    let mut entries: Vec<DirectoryEntry> = Vec::new();
    let read_dir = std::fs::read_dir(&root).map_err(|e| {
        AppCommandError::io_error("Failed to read directory").with_detail(e.to_string())
    })?;

    for entry in read_dir {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        // Follow symlinks: check if the resolved path is a directory
        let is_dir = if file_type.is_symlink() {
            entry.path().is_dir()
        } else {
            file_type.is_dir()
        };
        if !is_dir {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip hidden directories (starting with '.')
        if name.starts_with('.') {
            continue;
        }
        let abs_path = entry.path().to_string_lossy().to_string();

        // Peek into subdirectory to check if it has child directories
        let has_children = match std::fs::read_dir(entry.path()) {
            Ok(sub) => sub.filter_map(|e| e.ok()).any(|e| {
                let ft = e.file_type().ok();
                let is_sub_dir = ft.is_some_and(|ft| {
                    if ft.is_symlink() {
                        e.path().is_dir()
                    } else {
                        ft.is_dir()
                    }
                });
                if !is_sub_dir {
                    return false;
                }
                let sub_name = e.file_name().to_string_lossy().to_string();
                !sub_name.starts_with('.')
            }),
            Err(_) => false,
        };

        entries.push(DirectoryEntry {
            name,
            path: abs_path,
            has_children,
        });
    }

    // Sort by name, case-insensitive
    entries.sort_by_key(|a| a.name.to_lowercase());

    Ok(entries)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryItem {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// Only meaningful when `is_dir` is true.
    pub has_children: bool,
    /// File size in bytes; `None` for directories.
    pub size: Option<u64>,
}

/// List immediate children of `path`, returning both directories and files.
/// Mirrors `list_directory_entries` but does not filter out files, used by the
/// "attach server file" picker.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn list_directory_with_files(
    path: String,
) -> Result<Vec<DirectoryItem>, AppCommandError> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(AppCommandError::io_error("Path is not a directory").with_detail(path));
    }

    let mut items: Vec<DirectoryItem> = Vec::new();
    let read_dir = std::fs::read_dir(&root).map_err(|e| {
        AppCommandError::io_error("Failed to read directory").with_detail(e.to_string())
    })?;

    for entry in read_dir {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        // Follow symlinks for the dir/file classification.
        let is_dir = if file_type.is_symlink() {
            entry.path().is_dir()
        } else {
            file_type.is_dir()
        };
        let abs_path = entry.path().to_string_lossy().to_string();

        let (has_children, size) = if is_dir {
            let has = match std::fs::read_dir(entry.path()) {
                Ok(sub) => sub.filter_map(|e| e.ok()).any(|e| {
                    let sub_name = e.file_name().to_string_lossy().to_string();
                    !sub_name.starts_with('.')
                }),
                Err(_) => false,
            };
            (has, None)
        } else {
            let size = entry.metadata().ok().map(|m| m.len());
            (false, size)
        };

        items.push(DirectoryItem {
            name,
            path: abs_path,
            is_dir,
            has_children,
            size,
        });
    }

    // Sort: directories first, then files; each group by name case-insensitive.
    items.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(items)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_file_tree(
    path: String,
    max_depth: Option<usize>,
) -> Result<Vec<FileTreeNode>, AppCommandError> {
    let root = PathBuf::from(&path);
    let depth = max_depth.unwrap_or(usize::MAX);

    // Collect all entries, skipping ignored directories
    let mut dir_children: HashMap<PathBuf, Vec<FileTreeNode>> = HashMap::new();
    let mut dir_order: Vec<PathBuf> = Vec::new();
    let mut dir_paths_by_rel: HashMap<String, PathBuf> = HashMap::new();

    for entry in WalkDir::new(&root)
        .max_depth(depth)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            if e.file_type().is_dir() {
                !FILE_TREE_IGNORED_DIRS.contains(&name.as_ref())
            } else {
                name != ".DS_Store"
            }
        })
    {
        let entry = entry.map_err(|e| {
            AppCommandError::io_error("Failed to walk file tree").with_detail(e.to_string())
        })?;
        let entry_path = entry.path().to_path_buf();

        // Skip the root itself
        if entry_path == root {
            dir_children.entry(root.clone()).or_default();
            dir_order.push(root.clone());
            continue;
        }

        let parent = entry_path.parent().unwrap_or(&root).to_path_buf();
        let name = entry.file_name().to_string_lossy().to_string();
        let rel_path = entry_path
            .strip_prefix(&root)
            .unwrap_or(&entry_path)
            .to_string_lossy()
            .replace('\\', "/");

        if entry.file_type().is_dir() {
            dir_paths_by_rel.insert(rel_path.clone(), entry_path.clone());
            dir_children.entry(entry_path.clone()).or_default();
            dir_order.push(entry_path);
            // Add a placeholder Dir node to parent (children filled later)
            dir_children
                .entry(parent)
                .or_default()
                .push(FileTreeNode::Dir {
                    name,
                    path: rel_path,
                    children: vec![],
                });
        } else {
            dir_children
                .entry(parent)
                .or_default()
                .push(FileTreeNode::File {
                    name,
                    path: rel_path,
                });
        }
    }

    // Build tree bottom-up: process dirs in reverse order so children are ready
    for dir_path in dir_order.iter().rev() {
        let children = dir_children.remove(dir_path).unwrap_or_default();

        // Sort: dirs first, then files, alphabetically within each group
        let mut dirs: Vec<FileTreeNode> = Vec::new();
        let mut files: Vec<FileTreeNode> = Vec::new();
        for child in children {
            match &child {
                FileTreeNode::Dir { .. } => dirs.push(child),
                FileTreeNode::File { .. } => files.push(child),
            }
        }
        dirs.sort_by(|a, b| {
            let a_name = match a {
                FileTreeNode::Dir { name, .. } => name,
                _ => unreachable!(),
            };
            let b_name = match b {
                FileTreeNode::Dir { name, .. } => name,
                _ => unreachable!(),
            };
            a_name.to_lowercase().cmp(&b_name.to_lowercase())
        });
        files.sort_by(|a, b| {
            let a_name = match a {
                FileTreeNode::File { name, .. } => name,
                _ => unreachable!(),
            };
            let b_name = match b {
                FileTreeNode::File { name, .. } => name,
                _ => unreachable!(),
            };
            a_name.to_lowercase().cmp(&b_name.to_lowercase())
        });

        let mut sorted: Vec<FileTreeNode> = Vec::with_capacity(dirs.len() + files.len());

        // Fill dir children from the map
        for d in dirs {
            if let FileTreeNode::Dir {
                name,
                path: rel_path,
                ..
            } = d
            {
                let full_path = dir_paths_by_rel
                    .get(&rel_path)
                    .cloned()
                    .unwrap_or_else(|| root.join(Path::new(&rel_path)));
                let sub_children = dir_children.remove(&full_path).unwrap_or_default();
                sorted.push(FileTreeNode::Dir {
                    name,
                    path: rel_path,
                    children: sub_children,
                });
            }
        }
        sorted.extend(files);

        dir_children.insert(dir_path.clone(), sorted);
    }

    Ok(dir_children.remove(&root).unwrap_or_default())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn read_file_base64(
    path: String,
    max_bytes: Option<usize>,
) -> Result<String, AppCommandError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppCommandError::invalid_input("Path cannot be empty"));
    }
    let target = PathBuf::from(trimmed);
    if !target.exists() {
        return Err(AppCommandError::not_found("File does not exist"));
    }
    if !target.is_file() {
        return Err(AppCommandError::invalid_input("Path is not a file"));
    }

    let limit = max_bytes
        .unwrap_or(FILE_BASE64_DEFAULT_MAX_BYTES)
        .clamp(4_096, FILE_BASE64_MAX_BYTES);

    run_file_io(move || {
        let metadata = std::fs::metadata(&target).map_err(AppCommandError::io)?;
        if metadata.len() > limit as u64 {
            return Err(
                AppCommandError::invalid_input("File is too large to attach")
                    .with_detail(format!("max_bytes={limit}")),
            );
        }
        let bytes = std::fs::read(&target).map_err(AppCommandError::io)?;
        if bytes.len() > limit {
            return Err(
                AppCommandError::invalid_input("File is too large to attach")
                    .with_detail(format!("max_bytes={limit}")),
            );
        }
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    })
    .await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn read_file_preview(
    root_path: String,
    path: String,
) -> Result<FilePreviewContent, AppCommandError> {
    let root = PathBuf::from(&root_path);
    if !root.exists() || !root.is_dir() {
        return Err(AppCommandError::not_found("Folder does not exist"));
    }

    let target = resolve_tree_path(&root, &path)?;
    if !target.exists() {
        return Err(AppCommandError::not_found("File does not exist"));
    }
    if !target.is_file() {
        return Err(AppCommandError::invalid_input("Path is not a file"));
    }
    let path_for_response = path.clone();

    run_file_io(move || {
        ensure_path_in_workspace(&root, &target)?;
        let content = read_text_full(&target, FILE_OPEN_HARD_LIMIT)?;
        Ok(FilePreviewContent {
            path: path_for_response,
            content,
        })
    })
    .await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn read_file_for_edit(
    root_path: String,
    path: String,
) -> Result<FileEditContent, AppCommandError> {
    let root = PathBuf::from(&root_path);
    if !root.exists() || !root.is_dir() {
        return Err(AppCommandError::not_found("Folder does not exist"));
    }

    let target = resolve_tree_path(&root, &path)?;
    if !target.exists() {
        return Err(AppCommandError::not_found("File does not exist"));
    }
    if !target.is_file() {
        return Err(AppCommandError::invalid_input("Path is not a file"));
    }

    let path_for_response = path.clone();

    run_file_io(move || {
        ensure_path_in_workspace(&root, &target)?;
        let metadata = std::fs::metadata(&target).map_err(AppCommandError::io)?;
        let content = read_text_full(&target, FILE_OPEN_HARD_LIMIT)?;
        let readonly = metadata.permissions().readonly();
        let mtime_ms = file_mtime_ms(&metadata);
        let etag = compute_etag(content.as_bytes(), &metadata);
        let line_ending = detect_line_ending(content.as_bytes());

        Ok(FileEditContent {
            path: path_for_response,
            content,
            etag,
            mtime_ms,
            readonly,
            line_ending,
        })
    })
    .await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn save_file_content(
    root_path: String,
    path: String,
    content: String,
    expected_etag: Option<String>,
) -> Result<FileSaveResult, AppCommandError> {
    let root = PathBuf::from(&root_path);
    if !root.exists() || !root.is_dir() {
        return Err(AppCommandError::not_found("Folder does not exist"));
    }
    if content.len() > FILE_SAVE_HARD_LIMIT {
        return Err(
            AppCommandError::invalid_input("File is too large to save in editor")
                .with_detail(format!("max_bytes={FILE_SAVE_HARD_LIMIT}")),
        );
    }

    let target = resolve_tree_path(&root, &path)?;
    if !target.exists() {
        return Err(AppCommandError::not_found("File does not exist"));
    }
    if !target.is_file() {
        return Err(AppCommandError::invalid_input("Path is not a file"));
    }
    let path_for_response = path.clone();

    run_file_io(move || {
        ensure_path_in_workspace(&root, &target)?;

        let link_meta = std::fs::symlink_metadata(&target).map_err(AppCommandError::io)?;
        if link_meta.file_type().is_symlink() {
            return Err(AppCommandError::invalid_input(
                "Saving symlink targets is not supported",
            ));
        }

        let before_meta = std::fs::metadata(&target).map_err(AppCommandError::io)?;
        if before_meta.permissions().readonly() {
            return Err(AppCommandError::permission_denied("File is read-only"));
        }

        let current_bytes = std::fs::read(&target).map_err(AppCommandError::io)?;
        if current_bytes.iter().take(2_048).any(|b| *b == 0) {
            return Err(AppCommandError::invalid_input(
                "Binary files are not supported in editor",
            ));
        }
        let current_etag = compute_etag(&current_bytes, &before_meta);
        if let Some(expected) = expected_etag {
            if expected != current_etag {
                return Err(AppCommandError::invalid_input(
                    "File has changed on disk. Reload the file before saving.",
                ));
            }
        }

        atomic_write_text(&target, content.as_bytes())?;

        let after_meta = std::fs::metadata(&target).map_err(AppCommandError::io)?;
        let etag = compute_etag(content.as_bytes(), &after_meta);
        let mtime_ms = file_mtime_ms(&after_meta);
        let readonly = after_meta.permissions().readonly();
        let line_ending = detect_line_ending(content.as_bytes());

        Ok(FileSaveResult {
            path: path_for_response,
            etag,
            mtime_ms,
            readonly,
            line_ending,
        })
    })
    .await
}

fn build_local_copy_file_name(original_name: &str, attempt: usize) -> String {
    let original = Path::new(original_name);
    let stem = original
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or(original_name);
    let extension = original
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty());

    let suffix = if attempt <= 1 {
        ".local".to_string()
    } else {
        format!(".local.{}", attempt)
    };

    match extension {
        Some(ext) => format!("{stem}{suffix}.{ext}"),
        None => format!("{stem}{suffix}"),
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn save_file_copy(
    root_path: String,
    path: String,
    content: String,
) -> Result<FileSaveResult, AppCommandError> {
    let root = PathBuf::from(&root_path);
    if !root.exists() || !root.is_dir() {
        return Err(AppCommandError::not_found("Folder does not exist"));
    }
    if content.len() > FILE_SAVE_HARD_LIMIT {
        return Err(
            AppCommandError::invalid_input("File is too large to save in editor")
                .with_detail(format!("max_bytes={FILE_SAVE_HARD_LIMIT}")),
        );
    }

    let source = resolve_tree_path(&root, &path)?;
    if !source.exists() {
        return Err(AppCommandError::not_found("File does not exist"));
    }
    if !source.is_file() {
        return Err(AppCommandError::invalid_input("Path is not a file"));
    }

    run_file_io(move || {
        ensure_path_in_workspace(&root, &source)?;

        let source_meta = std::fs::symlink_metadata(&source).map_err(AppCommandError::io)?;
        if source_meta.file_type().is_symlink() {
            return Err(AppCommandError::invalid_input(
                "Saving symlink targets is not supported",
            ));
        }

        let parent = source
            .parent()
            .ok_or_else(|| {
                AppCommandError::invalid_input("Cannot determine parent directory for source file")
            })?
            .to_path_buf();
        ensure_path_in_workspace(&root, &parent)?;

        let source_name = source
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .ok_or_else(|| AppCommandError::invalid_input("Cannot determine source file name"))?;

        let mut created_path: Option<PathBuf> = None;
        for attempt in 1..=9_999 {
            let candidate_name = build_local_copy_file_name(&source_name, attempt);
            let candidate_path = parent.join(candidate_name);
            if candidate_path.exists() {
                continue;
            }
            created_path = Some(candidate_path);
            break;
        }

        let created_path = created_path.ok_or_else(|| {
            AppCommandError::already_exists(
                "Unable to create copy file: too many existing local copies",
            )
        })?;
        atomic_write_text(&created_path, content.as_bytes())?;

        let metadata = std::fs::metadata(&created_path).map_err(AppCommandError::io)?;
        let etag = compute_etag(content.as_bytes(), &metadata);
        let mtime_ms = file_mtime_ms(&metadata);
        let readonly = metadata.permissions().readonly();
        let line_ending = detect_line_ending(content.as_bytes());
        let rel_path = created_path
            .strip_prefix(&root)
            .map_err(|e| {
                AppCommandError::invalid_input("Failed to compute relative path for copy")
                    .with_detail(e.to_string())
            })?
            .to_string_lossy()
            .replace('\\', "/");

        Ok(FileSaveResult {
            path: rel_path,
            etag,
            mtime_ms,
            readonly,
            line_ending,
        })
    })
    .await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn rename_file_tree_entry(
    root_path: String,
    path: String,
    new_name: String,
) -> Result<String, AppCommandError> {
    let root = PathBuf::from(&root_path);
    if !root.exists() || !root.is_dir() {
        return Err(AppCommandError::not_found("Folder does not exist"));
    }

    let target = resolve_tree_path(&root, &path)?;
    if !target.exists() {
        return Err(AppCommandError::not_found("Target file does not exist"));
    }
    if target == root {
        return Err(AppCommandError::invalid_input(
            "Cannot rename workspace root",
        ));
    }

    let parent = target
        .parent()
        .ok_or_else(|| AppCommandError::invalid_input("Cannot rename path without parent"))?;
    let validated_name = validate_new_name(&new_name)?;
    let next_path = parent.join(validated_name);

    if next_path == target {
        return Ok(path);
    }
    if next_path.exists() {
        return Err(AppCommandError::already_exists(
            "A file with this name already exists",
        ));
    }

    std::fs::rename(&target, &next_path).map_err(AppCommandError::io)?;

    let rel = next_path
        .strip_prefix(&root)
        .map_err(|e| {
            AppCommandError::invalid_input("Failed to compute relative path")
                .with_detail(e.to_string())
        })?
        .to_string_lossy()
        .to_string();
    Ok(rel)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn delete_file_tree_entry(
    root_path: String,
    path: String,
) -> Result<(), AppCommandError> {
    let root = PathBuf::from(&root_path);
    if !root.exists() || !root.is_dir() {
        return Err(AppCommandError::not_found("Folder does not exist"));
    }

    let target = resolve_tree_path(&root, &path)?;
    // `Path::exists` follows symlinks and silently returns false on a
    // dangling link or any I/O error along the resolve chain, which gave
    // us "Target file does not exist" toasts even for files that were
    // physically present (case-only mismatches against a case-preserving
    // FS, NFD/NFC mismatches on macOS, files under a non-traversable
    // ancestor). `symlink_metadata` only stats the leaf and surfaces the
    // real OS error code in `detail`, which is what we want to diagnose
    // those reports.
    let meta = match std::fs::symlink_metadata(&target) {
        Ok(m) => m,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(AppCommandError::not_found("Target file does not exist")
                .with_detail(format!("resolved={} relative={}", target.display(), path)));
        }
        Err(err) => {
            return Err(
                AppCommandError::io_error("Failed to stat target").with_detail(format!(
                    "resolved={} relative={} error={}",
                    target.display(),
                    path,
                    err
                )),
            );
        }
    };
    if target == root {
        return Err(AppCommandError::invalid_input(
            "Cannot delete workspace root",
        ));
    }
    if meta.is_dir() {
        std::fs::remove_dir_all(&target).map_err(AppCommandError::io)?;
    } else {
        std::fs::remove_file(&target).map_err(AppCommandError::io)?;
    }

    Ok(())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn create_file_tree_entry(
    root_path: String,
    path: String,
    name: String,
    kind: String,
) -> Result<String, AppCommandError> {
    let root = PathBuf::from(&root_path);
    if !root.exists() || !root.is_dir() {
        return Err(AppCommandError::not_found("Folder does not exist"));
    }

    let validated_name = validate_new_name(&name)?;

    let parent_dir = if path.is_empty() {
        root.clone()
    } else {
        let resolved = resolve_tree_path(&root, &path)?;
        if !resolved.exists() {
            return Err(AppCommandError::not_found("Parent path does not exist"));
        }
        if resolved.is_file() {
            resolved.parent().map(|p| p.to_path_buf()).ok_or_else(|| {
                AppCommandError::invalid_input("Cannot determine parent directory")
            })?
        } else {
            resolved
        }
    };

    let target = parent_dir.join(validated_name);
    if target.exists() {
        return Err(AppCommandError::already_exists(
            "A file or directory with this name already exists",
        ));
    }

    match kind.as_str() {
        "file" => {
            std::fs::File::create(&target).map_err(AppCommandError::io)?;
        }
        "dir" => {
            std::fs::create_dir(&target).map_err(AppCommandError::io)?;
        }
        _ => {
            return Err(AppCommandError::invalid_input(
                "Kind must be 'file' or 'dir'",
            ));
        }
    }

    let rel = target
        .strip_prefix(&root)
        .map_err(|e| {
            AppCommandError::invalid_input("Failed to compute relative path")
                .with_detail(e.to_string())
        })?
        .to_string_lossy()
        .to_string();
    Ok(rel)
}

/// 文件树粘贴操作模式：复制或剪切。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PasteFileTreeEntryMode {
    Copy,
    Cut,
}

/// 同名冲突处理策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PasteConflictStrategy {
    /// 遇到同名直接报错，让前端弹出冲突对话框。
    Abort,
    /// 直接覆盖目标。
    Overwrite,
    /// 自动生成不冲突的副本名（如 "文件-副本.ext"）。
    Duplicate,
}

/// 判断 candidate_child 是否为 candidate_parent 的子孙路径。
///
/// 用于检测目录粘贴到自身子树的危险操作，复制和剪切都要复用这层防护。
fn is_descendant(candidate_parent: &Path, candidate_child: &Path) -> bool {
    candidate_child.starts_with(candidate_parent)
}

/// 为同名冲突生成副本名称。
///
/// 首次追加 "-副本"，之后追加 "-副本(2)"、"-副本(3)" 等。
fn build_duplicate_name(name: &str, attempt: usize) -> String {
    if attempt == 1 {
        format!("{}-副本", name)
    } else {
        format!("{}-副本({})", name, attempt)
    }
}

/// 同步递归复制文件或目录。
///
/// 在 `run_file_io` 闭包内调用，不直接涉及 async；会拒绝任何层级的符号链接，
/// 避免把工作区外内容卷入复制结果。
fn copy_tree_entry_sync(source: &Path, destination: &Path) -> Result<(), AppCommandError> {
    let meta = std::fs::symlink_metadata(source).map_err(AppCommandError::io)?;
    if meta.file_type().is_symlink() {
        return Err(AppCommandError::invalid_input(
            "Symbolic links are not supported for paste operations",
        ));
    }

    if meta.is_file() {
        std::fs::copy(source, destination).map_err(AppCommandError::io)?;
        return Ok(());
    }

    // 源为目录，创建目标目录后递归复制子条目。
    std::fs::create_dir_all(destination).map_err(AppCommandError::io)?;
    for entry in std::fs::read_dir(source).map_err(AppCommandError::io)? {
        let entry = entry.map_err(AppCommandError::io)?;
        let child_source = entry.path();
        let child_destination = destination.join(entry.file_name());
        copy_tree_entry_sync(&child_source, &child_destination)?;
    }
    Ok(())
}

/// 递归确认目录树内没有符号链接。
///
/// 剪切同一文件系统内会优先使用 `rename`，不会逐项复制；因此移动目录前必须先扫描
/// 子树，避免把含有符号链接的目录绕过复制阶段的安全检查。
fn ensure_tree_has_no_symlinks(source: &Path) -> Result<(), AppCommandError> {
    let meta = std::fs::symlink_metadata(source).map_err(AppCommandError::io)?;
    if meta.file_type().is_symlink() {
        return Err(AppCommandError::invalid_input(
            "Symbolic links are not supported for paste operations",
        ));
    }
    if !meta.is_dir() {
        return Ok(());
    }

    for entry in std::fs::read_dir(source).map_err(AppCommandError::io)? {
        let entry = entry.map_err(AppCommandError::io)?;
        ensure_tree_has_no_symlinks(&entry.path())?;
    }
    Ok(())
}

/// 同步删除文件或目录。
///
/// 供覆盖和清理临时粘贴产物复用；路径不存在时视为已清理完成。
fn remove_tree_entry_sync(path: &Path) -> Result<(), AppCommandError> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {
            std::fs::remove_dir_all(path).map_err(AppCommandError::io)
        }
        Ok(_) => std::fs::remove_file(path).map_err(AppCommandError::io),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(AppCommandError::io(err)),
    }
}

/// 同步移动文件或目录（跨文件系统时回退到复制+删除）。
fn move_tree_entry_sync(source: &Path, destination: &Path) -> Result<(), AppCommandError> {
    let meta = std::fs::symlink_metadata(source).map_err(AppCommandError::io)?;
    if meta.is_dir() {
        ensure_tree_has_no_symlinks(source)?;
    }

    // 先尝试 rename，同文件系统内 O(1) 操作。
    match std::fs::rename(source, destination) {
        Ok(()) => return Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::CrossesDevices => {
            // 跨文件系统：复制后删除源。
        }
        Err(e) => return Err(AppCommandError::io(e)),
    }

    copy_tree_entry_sync(source, destination)?;
    if meta.is_dir() {
        std::fs::remove_dir_all(source).map_err(AppCommandError::io)?;
    } else {
        std::fs::remove_file(source).map_err(AppCommandError::io)?;
    }
    Ok(())
}

/// 根据冲突策略，若目标存在则返回实际应使用的目标路径。
///
/// `Abort` 策略下目标存在时返回 `AlreadyExists` 错误；
/// `Overwrite` 策略由调用方分阶段处理，因此这里防御性拒绝；
/// `Duplicate` 策略下递增序号生成不冲突的副本名。
fn resolve_conflict(
    target: &Path,
    conflict: PasteConflictStrategy,
    source_meta: &std::fs::Metadata,
) -> Result<PathBuf, AppCommandError> {
    if std::fs::symlink_metadata(target).is_err() {
        return Ok(target.to_path_buf());
    }

    match conflict {
        PasteConflictStrategy::Abort => Err(AppCommandError::already_exists(
            "A file or directory with this name already exists in the target location",
        )),
        PasteConflictStrategy::Overwrite => Err(AppCommandError::already_exists(
            "Overwrite must be handled by the paste operation after staging succeeds",
        )),
        PasteConflictStrategy::Duplicate => {
            let parent = target.parent().ok_or_else(|| {
                AppCommandError::invalid_input("Cannot determine parent directory")
            })?;
            let target_name = target.file_name().and_then(|s| s.to_str()).unwrap_or("file");

            // 目录直接在名字后追加副本后缀；文件则保留扩展名，避免副本失去类型信息。
            let (stem, ext) = if source_meta.is_file() {
                let stem = target
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or(target_name);
                (stem, target.extension().and_then(|e| e.to_str()))
            } else {
                (target_name, None)
            };

            for attempt in 1..=999 {
                let candidate_name = if let Some(ext) = ext {
                    format!("{}.{}", build_duplicate_name(stem, attempt), ext)
                } else {
                    build_duplicate_name(stem, attempt)
                };
                let candidate = parent.join(&candidate_name);
                if std::fs::symlink_metadata(&candidate).is_err() {
                    return Ok(candidate);
                }
            }
            Err(AppCommandError::invalid_input(
                "Could not generate a unique duplicate name after 999 attempts",
            ))
        }
    }
}

/// 执行已解析路径的复制或剪切，并返回实际目标路径。
///
/// 当冲突策略为覆盖且目标已存在时，先把源条目写入同级临时路径，再把旧目标
/// 改名为备份，最后将临时条目改回目标路径；这样即使最终替换失败，旧目标也
/// 还在备份里，不会提前丢失。
fn copy_paste_entry_sync(
    source: &Path,
    initial_target: &Path,
    mode: PasteFileTreeEntryMode,
    conflict: PasteConflictStrategy,
    source_meta: &std::fs::Metadata,
) -> Result<PathBuf, AppCommandError> {
    if conflict == PasteConflictStrategy::Overwrite && initial_target.exists() {
        let parent = initial_target.parent().ok_or_else(|| {
            AppCommandError::invalid_input("Cannot determine parent directory")
        })?;
        let stage_path = parent.join(format!(
            ".codeg-paste-{}.{}.tmp",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let backup_path = parent.join(format!(
            ".codeg-paste-backup-{}.{}.tmp",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));

    let staged = match mode {
            PasteFileTreeEntryMode::Copy => copy_tree_entry_sync(source, &stage_path),
            PasteFileTreeEntryMode::Cut => move_tree_entry_sync(source, &stage_path),
        };
        if let Err(err) = staged {
            let _ = remove_tree_entry_sync(&stage_path);
            return Err(err);
        }

        if let Err(err) = std::fs::rename(initial_target, &backup_path).map_err(AppCommandError::io) {
            if mode == PasteFileTreeEntryMode::Cut {
                let restore_err = std::fs::rename(&stage_path, source).map_err(AppCommandError::io);
                if let Err(restore_err) = restore_err {
                    let backup_detail = err.detail.clone().unwrap_or_else(|| err.message.clone());
                    let restore_detail = restore_err
                        .detail
                        .unwrap_or_else(|| restore_err.message.clone());
                    return Err(err.with_detail(format!(
                        "backup rename failed: {}; restore of staged source also failed: {}",
                        backup_detail, restore_detail
                    )));
                }
            } else {
                let _ = remove_tree_entry_sync(&stage_path);
            }
            return Err(err);
        }

        if let Err(err) = std::fs::rename(&stage_path, initial_target).map_err(AppCommandError::io) {
            if let Err(_restore_err) = std::fs::rename(&backup_path, initial_target) {
                if mode == PasteFileTreeEntryMode::Cut {
                    let _ = std::fs::rename(&stage_path, source);
                } else {
                    let _ = remove_tree_entry_sync(&stage_path);
                }
                return Err(err);
            }
            if mode == PasteFileTreeEntryMode::Cut {
                let _ = std::fs::rename(&stage_path, source);
            } else {
                let _ = remove_tree_entry_sync(&stage_path);
            }
            let _ = remove_tree_entry_sync(&backup_path);
            return Err(err);
        }

        let _ = remove_tree_entry_sync(&backup_path);
        return Ok(initial_target.to_path_buf());
    }

    let actual_target = resolve_conflict(initial_target, conflict, source_meta)?;
    match mode {
        PasteFileTreeEntryMode::Copy => copy_tree_entry_sync(source, &actual_target)?,
        PasteFileTreeEntryMode::Cut => move_tree_entry_sync(source, &actual_target)?,
    }
    Ok(actual_target)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn paste_file_tree_entry(
    root_path: String,
    source_path: String,
    target_dir_path: String,
    mode: PasteFileTreeEntryMode,
    conflict: PasteConflictStrategy,
) -> Result<String, AppCommandError> {
    let root = PathBuf::from(&root_path);
    if !root.exists() || !root.is_dir() {
        return Err(AppCommandError::not_found("Workspace root does not exist"));
    }

    let source = resolve_tree_path(&root, &source_path)?;
    if !source.exists() {
        return Err(AppCommandError::not_found("Source file does not exist"));
    }
    if source == root {
        return Err(AppCommandError::invalid_input("Cannot copy workspace root"));
    }

    let source_meta = std::fs::symlink_metadata(&source).map_err(AppCommandError::io)?;
    if source_meta.file_type().is_symlink() {
        return Err(AppCommandError::invalid_input(
            "Symbolic links are not supported for paste operations",
        ));
    }

    let target_dir = resolve_tree_path(&root, &target_dir_path)?;
    if !target_dir.exists() {
        return Err(AppCommandError::not_found("Target directory does not exist"));
    }
    if !target_dir.is_dir() {
        return Err(AppCommandError::invalid_input("Target must be a directory"));
    }

    if source_meta.is_dir() {
        let canonical_source = std::fs::canonicalize(&source).map_err(AppCommandError::io)?;
        let canonical_target = std::fs::canonicalize(&target_dir).map_err(AppCommandError::io)?;
        if is_descendant(&canonical_source, &canonical_target) {
            return Err(AppCommandError::invalid_input(
                "Cannot paste a directory into itself or one of its descendants",
            ));
        }
    }

    let source_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AppCommandError::invalid_input("Source path has no file name"))?;
    let initial_target = target_dir.join(source_name);

    if initial_target == source {
        match conflict {
            PasteConflictStrategy::Abort => {
                return Err(AppCommandError::already_exists(
                    "A file or directory with this name already exists in the target location",
                ));
            }
            PasteConflictStrategy::Overwrite => {
                let rel = source
                    .strip_prefix(&root)
                    .map_err(|e| {
                        AppCommandError::invalid_input("Failed to compute relative path")
                            .with_detail(e.to_string())
                    })?
                    .to_string_lossy()
                    .replace('\\', "/");
                return Ok(rel);
            }
            PasteConflictStrategy::Duplicate => {
                // 相同路径且策略为 Duplicate：不提前返回，继续走下面的 I/O 路径创建副本。
            }
        }
    }

    run_file_io(move || {
        ensure_path_in_workspace(&root, &source)?;
        ensure_path_in_workspace(&root, &target_dir)?;

        let actual_target =
            copy_paste_entry_sync(&source, &initial_target, mode, conflict, &source_meta)?;

        let rel = actual_target
            .strip_prefix(&root)
            .map_err(|e| {
                AppCommandError::invalid_input("Failed to compute relative path")
                    .with_detail(e.to_string())
            })?
            .to_string_lossy()
            .replace('\\', "/");
        Ok(rel)
    })
    .await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_log(
    path: String,
    limit: Option<u32>,
    branch: Option<String>,
    remote: Option<String>,
) -> Result<GitLogResult, AppCommandError> {
    ensure_git_repo(&path)?;

    const COMMIT_META_PREFIX: &str = "__COMMIT__\0";
    const MESSAGE_END_MARKER: &str = "__COMMIT_MESSAGE_END__";

    let limit_str = format!("-{}", limit.unwrap_or(100));
    let mut args = vec![
        "log".to_string(),
        limit_str,
        format!("--format=__COMMIT__%x00%h%x00%H%x00%an%x00%aI%n%B%n{MESSAGE_END_MARKER}"),
        "--raw".to_string(),
        "--numstat".to_string(),
        "--no-renames".to_string(),
    ];
    if let Some(ref b) = branch {
        args.push(b.clone());
    }
    let output = crate::process::tokio_command("git")
        .args(["-c", "core.quotePath=false"])
        .args(&args)
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        // Empty repo (no commits yet) — return empty list instead of error
        let stderr_str = String::from_utf8_lossy(&output.stderr);
        if stderr_str.contains("does not have any commits yet")
            || stderr_str.contains("unknown revision or path not in the working tree")
        {
            return Ok(GitLogResult {
                entries: Vec::new(),
                has_upstream: false,
            });
        }
        return Err(git_command_error("log", &output.stderr));
    }

    let mut entries = Vec::<GitLogEntry>::new();
    let mut current: Option<GitLogEntryBuilder> = None;
    let mut reading_message = false;

    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if let Some(meta) = line.strip_prefix(COMMIT_META_PREFIX) {
            if let Some(entry) = current.take() {
                entries.push(entry.finish());
            }

            let parts: Vec<&str> = meta.splitn(4, '\0').collect();
            if parts.len() == 4 {
                current = Some(GitLogEntryBuilder::new(parts));
                reading_message = true;
            } else {
                reading_message = false;
            }
            continue;
        }

        let Some(entry) = current.as_mut() else {
            continue;
        };

        if reading_message {
            if line == MESSAGE_END_MARKER {
                reading_message = false;
                entry.finalize_message();
            } else {
                entry.push_message_line(line);
            }
            continue;
        }

        if line.is_empty() {
            continue;
        }

        if line.starts_with(':') {
            if let Some((status, file_path)) = parse_raw_file_line(line) {
                let file = entry.get_or_insert_file(file_path);
                file.status = status;
            }
            continue;
        }

        if let Some((additions, deletions, file_path)) = parse_numstat_file_line(line) {
            let file = entry.get_or_insert_file(file_path);
            file.additions = additions;
            file.deletions = deletions;
        }
    }

    if let Some(entry) = current {
        entries.push(entry.finish());
    }

    let log_limit = limit.unwrap_or(100);
    let (unpushed_hashes, has_upstream) =
        get_unpushed_hashes(&path, log_limit, remote.as_deref(), branch.as_deref())
            .await
            .unwrap_or((None, false));
    for entry in entries.iter_mut() {
        entry.pushed = unpushed_hashes
            .as_ref()
            .map(|hashes| !hashes.contains(&entry.full_hash));
    }

    Ok(GitLogResult {
        entries,
        has_upstream,
    })
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_commit_branches(
    path: String,
    commit: String,
) -> Result<Vec<String>, AppCommandError> {
    ensure_git_repo(&path)?;

    let contains_arg = format!("--contains={commit}");
    let output = crate::process::tokio_command("git")
        .args([
            "for-each-ref",
            &contains_arg,
            "--format=%(refname:short)",
            "refs/heads",
            "refs/remotes",
        ])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("for-each-ref", &output.stderr));
    }

    let mut seen = HashSet::new();
    let mut branches = Vec::new();

    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let branch = line.trim();
        if branch.is_empty() || branch.ends_with("/HEAD") {
            continue;
        }

        if seen.insert(branch.to_string()) {
            branches.push(branch.to_string());
        }
    }

    branches.sort();
    Ok(branches)
}

struct GitLogEntryBuilder {
    hash: String,
    full_hash: String,
    author: String,
    date: String,
    message: String,
    files: Vec<GitLogFileChange>,
    index_by_path: HashMap<String, usize>,
}

impl GitLogEntryBuilder {
    fn new(parts: Vec<&str>) -> Self {
        Self {
            hash: parts[0].to_string(),
            full_hash: parts[1].to_string(),
            author: parts[2].to_string(),
            date: parts[3].to_string(),
            message: String::new(),
            files: Vec::new(),
            index_by_path: HashMap::new(),
        }
    }

    fn push_message_line(&mut self, line: &str) {
        if !self.message.is_empty() {
            self.message.push('\n');
        }
        self.message.push_str(line);
    }

    fn finalize_message(&mut self) {
        self.message = self.message.trim_end_matches('\n').to_string();
    }

    fn get_or_insert_file(&mut self, path: String) -> &mut GitLogFileChange {
        let index = if let Some(index) = self.index_by_path.get(&path) {
            *index
        } else {
            self.files.push(GitLogFileChange {
                path: path.clone(),
                status: "M".to_string(),
                additions: 0,
                deletions: 0,
            });
            let index = self.files.len() - 1;
            self.index_by_path.insert(path, index);
            index
        };

        &mut self.files[index]
    }

    fn finish(self) -> GitLogEntry {
        GitLogEntry {
            hash: self.hash,
            full_hash: self.full_hash,
            author: self.author,
            date: self.date,
            message: self.message,
            files: self.files,
            pushed: None,
        }
    }
}

fn parse_raw_file_line(line: &str) -> Option<(String, String)> {
    let mut parts = line.split('\t');
    let meta = parts.next()?;
    let file_path = unquote_git_path(parts.next()?);
    let status = meta
        .split_whitespace()
        .last()
        .and_then(|v| v.chars().next())
        .unwrap_or('M')
        .to_string();
    Some((status, file_path))
}

fn parse_numstat_file_line(line: &str) -> Option<(u32, u32, String)> {
    let mut parts = line.splitn(3, '\t');
    let additions = parse_numstat_count(parts.next()?);
    let deletions = parse_numstat_count(parts.next()?);
    let file_path = unquote_git_path(parts.next()?);
    Some((additions, deletions, file_path))
}

fn parse_numstat_count(value: &str) -> u32 {
    if value == "-" {
        return 0;
    }

    value.parse::<u32>().unwrap_or(0)
}

/// Returns (unpushed_hashes, has_upstream).
async fn get_unpushed_hashes(
    path: &str,
    limit: u32,
    remote_override: Option<&str>,
    branch: Option<&str>,
) -> Result<(Option<HashSet<String>>, bool), AppCommandError> {
    let limit_arg = format!("-{}", limit);

    // If viewing a remote branch (e.g. "origin/main"), all commits are pushed
    if let Some(b) = branch {
        let is_remote = crate::process::tokio_command("git")
            .args([
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/remotes/{}", b),
            ])
            .current_dir(path)
            .output()
            .await
            .is_ok_and(|o| o.status.success());
        if is_remote {
            return Ok((Some(HashSet::new()), true));
        }
    }

    // The local ref to compare: specified branch or HEAD
    let local_ref = branch.unwrap_or("HEAD");

    // Check upstream for the target branch
    let upstream_arg = if branch.is_some() {
        format!("{}@{{upstream}}", local_ref)
    } else {
        "@{upstream}".to_string()
    };

    let upstream_output = crate::process::tokio_command("git")
        .args([
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            &upstream_arg,
        ])
        .current_dir(path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    let has_upstream = upstream_output.status.success()
        && !String::from_utf8_lossy(&upstream_output.stdout)
            .trim()
            .is_empty();

    // Determine the comparison target for unpushed commits.
    // We compare against <remote>/<branch> specifically rather than all remote
    // branches, so that commits shared with other remote branches still appear.
    let rev_list_output = if has_upstream && remote_override.is_none() {
        // Fast path: branch has an upstream tracking ref, use it directly
        let upstream = String::from_utf8_lossy(&upstream_output.stdout)
            .trim()
            .to_string();
        let range = format!("{upstream}..{local_ref}");
        crate::process::tokio_command("git")
            .args(["rev-list", &limit_arg, &range])
            .current_dir(path)
            .output()
            .await
            .map_err(AppCommandError::io)?
    } else {
        // Either remote_override is specified or no upstream exists.
        // Resolve the branch name and the target remote.
        let branch_name = if let Some(b) = branch {
            b.to_string()
        } else {
            let branch_output = crate::process::tokio_command("git")
                .args(["rev-parse", "--abbrev-ref", "HEAD"])
                .current_dir(path)
                .output()
                .await
                .map_err(AppCommandError::io)?;
            if !branch_output.status.success() {
                return Ok((None, has_upstream));
            }
            let name = String::from_utf8_lossy(&branch_output.stdout)
                .trim()
                .to_string();
            if name.is_empty() || name == "HEAD" {
                return Ok((None, has_upstream));
            }
            name
        };

        let remote = if let Some(r) = remote_override {
            r.to_string()
        } else {
            let remote_key = format!("branch.{}.remote", branch_name);
            let remote_output = crate::process::tokio_command("git")
                .args(["config", "--get", &remote_key])
                .current_dir(path)
                .output()
                .await;
            remote_output
                .ok()
                .filter(|output| output.status.success())
                .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "origin".to_string())
        };

        // Try comparing against <remote>/<branch> directly
        let remote_branch_ref = format!("refs/remotes/{}/{}", remote, branch_name);
        let verify_output = crate::process::tokio_command("git")
            .args(["rev-parse", "--verify", "--quiet", &remote_branch_ref])
            .current_dir(path)
            .output()
            .await;
        let remote_branch_exists = verify_output.is_ok_and(|o| o.status.success());

        if remote_branch_exists {
            let range = format!("{}/{}..{}", remote, branch_name, local_ref);
            crate::process::tokio_command("git")
                .args(["rev-list", &limit_arg, &range])
                .current_dir(path)
                .output()
                .await
                .map_err(AppCommandError::io)?
        } else {
            // Branch doesn't exist on remote yet (new branch).
            // Try merge-base with the remote's default branch to show
            // the meaningful divergence point.
            let remote_head = format!("{}/HEAD", remote);
            let mb_output = crate::process::tokio_command("git")
                .args(["merge-base", local_ref, &remote_head])
                .current_dir(path)
                .output()
                .await;
            let merge_base = mb_output
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|s| !s.is_empty());

            if let Some(base) = merge_base {
                let range = format!("{}..{}", base, local_ref);
                crate::process::tokio_command("git")
                    .args(["rev-list", &limit_arg, &range])
                    .current_dir(path)
                    .output()
                    .await
                    .map_err(AppCommandError::io)?
            } else {
                // Last resort: compare against all branches on the remote
                let remote_arg = format!("--remotes={}", remote);
                crate::process::tokio_command("git")
                    .args(["rev-list", &limit_arg, local_ref, "--not", &remote_arg])
                    .current_dir(path)
                    .output()
                    .await
                    .map_err(AppCommandError::io)?
            }
        }
    };

    if !rev_list_output.status.success() {
        return Ok((None, has_upstream));
    }

    let hashes = String::from_utf8_lossy(&rev_list_output.stdout)
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| line.to_string())
        .collect::<HashSet<_>>();

    Ok((Some(hashes), has_upstream))
}

#[cfg(test)]
mod search_files_tests {
    use super::*;
    use crate::app_error::AppErrorCode;

    /// Write one UTF-8 file for search command tests.
    ///
    /// The path must include an existing parent directory. It panics on I/O
    /// failure because tests cannot proceed without deterministic fixtures, and
    /// it returns no value or filesystem cleanup handle.
    fn write_file(path: &Path, content: &str) {
        std::fs::write(path, content).expect("write test file");
    }

    /// Build a minimal search request for a temporary root.
    ///
    /// The helper fills optional filters and limits with `None`, so individual
    /// tests can override only the field under examination. It performs no I/O
    /// and returns a request using the root's display path.
    fn request(root: &Path, query: &str) -> SearchFilesRequest {
        SearchFilesRequest {
            root_path: root.to_string_lossy().to_string(),
            query: query.to_string(),
            search_dirs: None,
            include_extensions: None,
            exclude_extensions: None,
            exclude_dirs: None,
            max_results: None,
            max_file_bytes: None,
        }
    }

    #[tokio::test]
    async fn search_files_returns_empty_response_for_empty_query() {
        let temp = tempfile::tempdir().expect("tempdir");
        write_file(&temp.path().join("alpha.txt"), "needle\n");

        let result = search_files(request(temp.path(), "   "))
            .await
            .expect("empty query returns empty response");

        assert!(!result.truncated);
        assert!(result.results.is_empty());
        assert_eq!(result.scanned_files, 0);
        assert_eq!(result.skipped_files, 0);
    }

    /// Verify an explicit empty search-dir list falls back to searching the root.
    #[tokio::test]
    async fn search_files_treats_empty_search_dirs_as_root() {
        let temp = tempfile::tempdir().expect("tempdir");
        write_file(&temp.path().join("alpha.txt"), "needle\n");
        let mut req = request(temp.path(), "needle");
        req.search_dirs = Some(Vec::new());

        let result = search_files(req).await.expect("search files");

        assert_eq!(result.results.len(), 1);
        assert!(result.results[0].path.ends_with("alpha.txt"));
        assert_eq!(result.scanned_files, 1);
    }

    /// Verify overlapping search dirs do not scan child files twice.
    #[tokio::test]
    async fn search_files_deduplicates_child_search_dirs_covered_by_parent() {
        let temp = tempfile::tempdir().expect("tempdir");
        let src = temp.path().join("src");
        std::fs::create_dir_all(&src).expect("create src");
        write_file(&src.join("app.ts"), "needle\n");
        let mut req = request(temp.path(), "needle");
        req.search_dirs = Some(vec![".".to_string(), "src".to_string()]);

        let result = search_files(req).await.expect("search files");

        assert_eq!(result.results.len(), 1);
        assert!(result.results[0].path.ends_with("src/app.ts"));
        assert_eq!(result.scanned_files, 1);
    }

    #[tokio::test]
    async fn search_files_returns_line_matches() {
        let temp = tempfile::tempdir().expect("tempdir");
        write_file(
            &temp.path().join("alpha.txt"),
            "first line\nNeedle appears here\nlast needle\n",
        );
        write_file(&temp.path().join("beta.txt"), "no match\n");

        let result = search_files(request(temp.path(), "needle"))
            .await
            .expect("search files");

        assert!(!result.truncated);
        assert_eq!(result.results.len(), 2);
        assert_eq!(result.results[0].name, "alpha.txt");
        assert_eq!(result.results[0].line_number, 2);
        assert_eq!(result.results[0].line_text, "Needle appears here");
        assert!(result.results[0].path.ends_with("alpha.txt"));
        assert_eq!(result.results[1].line_number, 3);
        assert_eq!(result.scanned_files, 2);
        assert_eq!(result.skipped_files, 0);
    }

    /// Verify a stable read error is skipped without hiding readable matches.
    #[tokio::test]
    async fn search_files_skips_read_error_and_continues() {
        let temp = tempfile::tempdir().expect("tempdir");
        let config = build_search_config(&request(temp.path(), "needle")).expect("config");
        let mut response = empty_search_response();
        let read_error_path = temp.path();
        let readable = temp.path().join("readable.txt");
        write_file(&readable, "needle\n");

        let read_step = search_file(read_error_path, &config, &mut response)
            .expect("read error should be skipped");
        let readable_step = search_file(&readable, &config, &mut response)
            .expect("readable file should still be searched");

        assert_eq!(read_step, SearchStep::Continue);
        assert_eq!(readable_step, SearchStep::Continue);
        assert_eq!(response.results.len(), 1);
        assert!(response.results[0].path.ends_with("readable.txt"));
        assert_eq!(response.scanned_files, 1);
        assert_eq!(response.skipped_files, 1);
    }

    #[tokio::test]
    async fn search_files_respects_excluded_directories() {
        let temp = tempfile::tempdir().expect("tempdir");
        let nested = temp.path().join("src");
        let vendor = temp.path().join("vendor");
        std::fs::create_dir_all(&nested).expect("create src");
        std::fs::create_dir_all(&vendor).expect("create vendor");
        write_file(&nested.join("main.rs"), "needle\n");
        write_file(&vendor.join("dep.rs"), "needle\n");
        let mut req = request(temp.path(), "needle");
        req.exclude_dirs = Some(vec!["vendor".to_string()]);

        let result = search_files(req).await.expect("search files");

        assert_eq!(result.results.len(), 1);
        assert!(result.results[0].path.ends_with("src/main.rs"));
    }

    #[tokio::test]
    async fn search_files_respects_include_and_exclude_extensions() {
        let temp = tempfile::tempdir().expect("tempdir");
        write_file(&temp.path().join("keep.rs"), "needle\n");
        write_file(&temp.path().join("skip.txt"), "needle\n");
        write_file(&temp.path().join("drop.md"), "needle\n");
        let mut req = request(temp.path(), "needle");
        req.include_extensions = Some(vec!["rs".to_string(), ".txt".to_string()]);
        req.exclude_extensions = Some(vec!["txt".to_string()]);

        let result = search_files(req).await.expect("search files");

        assert_eq!(result.results.len(), 1);
        assert!(result.results[0].path.ends_with("keep.rs"));
    }

    #[tokio::test]
    async fn search_files_respects_default_exclusions() {
        let temp = tempfile::tempdir().expect("tempdir");
        for dir in ["__pycache__", ".venv", "venv"] {
            let nested = temp.path().join(dir);
            std::fs::create_dir_all(&nested).expect("create excluded dir");
            write_file(&nested.join("ignored.txt"), "needle\n");
        }
        write_file(&temp.path().join("Cargo.lock"), "needle\n");
        write_file(&temp.path().join("visible.txt"), "needle\n");

        let result = search_files(request(temp.path(), "needle"))
            .await
            .expect("search files");

        assert_eq!(result.results.len(), 1);
        assert!(result.results[0].path.ends_with("visible.txt"));
        assert_eq!(result.scanned_files, 1);
        assert_eq!(result.skipped_files, 1);
    }

    #[tokio::test]
    async fn search_files_truncates_long_matching_lines() {
        let temp = tempfile::tempdir().expect("tempdir");
        let long_line = format!("{}chrome{}", "a".repeat(50_000), "b".repeat(50_000));
        write_file(&temp.path().join("bundle.js"), &long_line);

        let result = search_files(request(temp.path(), "chrome"))
            .await
            .expect("search files");

        assert_eq!(result.results.len(), 1);
        assert!(result.results[0].line_text.contains("chrome"));
        assert!(result.results[0].line_text.len() <= 260);
    }

    #[tokio::test]
    async fn search_files_skips_generated_frontend_assets_by_default() {
        let temp = tempfile::tempdir().expect("tempdir");
        let public_vs = temp.path().join("public").join("vs");
        let out_chunks = temp.path().join("out").join("_next").join("static");
        std::fs::create_dir_all(&public_vs).expect("create public vs");
        std::fs::create_dir_all(&out_chunks).expect("create out chunks");
        write_file(&public_vs.join("worker.js"), "chrome\n");
        write_file(&out_chunks.join("bundle.js"), "chrome\n");
        write_file(&temp.path().join("visible.txt"), "chrome\n");

        let result = search_files(request(temp.path(), "chrome"))
            .await
            .expect("search files");

        assert_eq!(result.results.len(), 1);
        assert!(result.results[0].path.ends_with("visible.txt"));
    }

    #[tokio::test]
    async fn search_files_truncates_at_max_results() {
        let temp = tempfile::tempdir().expect("tempdir");
        write_file(&temp.path().join("many.txt"), "needle\nneedle\nneedle\n");
        let mut req = request(temp.path(), "needle");
        req.max_results = Some(2);

        let result = search_files(req).await.expect("search files");

        assert!(result.truncated);
        assert_eq!(result.results.len(), 2);
    }

    #[tokio::test]
    async fn search_files_rejects_search_dir_escape() {
        let temp = tempfile::tempdir().expect("tempdir");
        let outside = tempfile::tempdir().expect("outside tempdir");
        let mut req = request(temp.path(), "needle");
        req.search_dirs = Some(vec![outside.path().to_string_lossy().to_string()]);

        let err = search_files(req)
            .await
            .expect_err("escaped search dir should fail");

        assert!(matches!(err.code, AppErrorCode::InvalidInput));
    }
}

#[cfg(test)]
mod directory_browser_tests {
    use super::*;
    use crate::app_error::AppErrorCode;

    /// Verify empty browser create paths are rejected before filesystem access.
    #[tokio::test]
    async fn create_folder_directory_rejects_empty_path() {
        let err = create_folder_directory("   ".to_string())
            .await
            .expect_err("empty path should fail");

        assert!(matches!(err.code, AppErrorCode::InvalidInput));
    }

    #[tokio::test]
    async fn create_folder_directory_creates_missing_directory() {
        let temp = tempfile::tempdir().expect("tempdir");
        let target = temp.path().join("new-child");

        create_folder_directory(target.to_string_lossy().to_string())
            .await
            .expect("create directory");

        assert!(target.is_dir());
    }

    #[tokio::test]
    async fn create_folder_directory_rejects_existing_directory() {
        let temp = tempfile::tempdir().expect("tempdir");
        let target = temp.path().join("existing");
        std::fs::create_dir(&target).expect("seed existing dir");

        let err = create_folder_directory(target.to_string_lossy().to_string())
            .await
            .expect_err("existing directory should fail");

        assert!(matches!(err.code, AppErrorCode::AlreadyExists));
    }

    #[tokio::test]
    async fn create_folder_directory_rejects_missing_parent() {
        let temp = tempfile::tempdir().expect("tempdir");
        let target = temp.path().join("missing-parent").join("child");

        let err = create_folder_directory(target.to_string_lossy().to_string())
            .await
            .expect_err("missing parent should fail");

        assert!(matches!(err.code, AppErrorCode::NotFound));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;
    use crate::models::agent::AgentType;

    #[tokio::test]
    async fn add_folder_to_history_core_derives_name_from_path() {
        let db = fresh_in_memory_db().await;
        let entry = add_folder_to_history_core(&db, "/tmp/codeg-test-project".into())
            .await
            .expect("add folder");
        assert_eq!(entry.name, "codeg-test-project");
        assert_eq!(entry.path, "/tmp/codeg-test-project");
    }

    #[tokio::test]
    async fn add_folder_to_history_core_upserts_on_duplicate_path() {
        let db = fresh_in_memory_db().await;
        let path = "/tmp/codeg-dup-test".to_string();
        let first = add_folder_to_history_core(&db, path.clone())
            .await
            .expect("add 1st");
        let second = add_folder_to_history_core(&db, path.clone())
            .await
            .expect("add 2nd");
        assert_eq!(first.id, second.id, "duplicate path must reuse id");

        let history = load_folder_history_core(&db).await.expect("history");
        assert_eq!(
            history.iter().filter(|f| f.path == path).count(),
            1,
            "no duplicate rows for same path"
        );
    }

    #[tokio::test]
    async fn remove_folder_from_history_core_soft_deletes() {
        let db = fresh_in_memory_db().await;
        let path = "/tmp/codeg-remove-test".to_string();
        add_folder_to_history_core(&db, path.clone())
            .await
            .expect("add");
        remove_folder_from_history_core(&db, path.clone())
            .await
            .expect("remove");
        let history = load_folder_history_core(&db).await.expect("history");
        assert!(
            history.iter().all(|f| f.path != path),
            "soft-deleted folder must not appear in list"
        );
    }

    #[tokio::test]
    async fn open_folder_by_id_core_errors_when_missing() {
        let db = fresh_in_memory_db().await;
        let err = open_folder_by_id_core(&db, 99_999)
            .await
            .expect_err("missing id should error");
        // Either the not_found wrapper (when set_folder_open returns Ok(()) on no-op)
        // or the underlying DbError propagates — both are acceptable for "missing".
        let msg = format!("{err:?}");
        assert!(
            msg.to_lowercase().contains("not found") || msg.to_lowercase().contains("99999"),
            "expected not-found-ish error, got: {msg}"
        );
    }

    #[tokio::test]
    async fn update_folder_color_core_roundtrips() {
        let db = fresh_in_memory_db().await;
        let entry = add_folder_to_history_core(&db, "/tmp/codeg-color-test".into())
            .await
            .expect("add");
        let updated = update_folder_color_core(&db, entry.id, "#ff8800".into())
            .await
            .expect("update color");
        assert_eq!(updated.color, "#ff8800");
        let read_back = get_folder_core(&db, entry.id).await.expect("get");
        assert_eq!(read_back.color, "#ff8800");
    }

    #[tokio::test]
    async fn update_folder_default_agent_core_set_then_clear() {
        let db = fresh_in_memory_db().await;
        let entry = add_folder_to_history_core(&db, "/tmp/codeg-agent-test".into())
            .await
            .expect("add");
        let set = update_folder_default_agent_core(&db, entry.id, Some(AgentType::ClaudeCode))
            .await
            .expect("set agent");
        assert_eq!(set.default_agent_type, Some(AgentType::ClaudeCode));
        let cleared = update_folder_default_agent_core(&db, entry.id, None)
            .await
            .expect("clear agent");
        assert_eq!(cleared.default_agent_type, None);
    }
}


#[cfg(test)]
mod paste_file_tree_entry_tests {
    use super::*;
    use crate::app_error::AppErrorCode;

    /// 创建临时目录并在其中创建测试文件/目录结构。
    ///
    /// 返回 (tempdir, root_path) 元组。root_path 为完整路径字符串。
    fn setup_temp() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().to_path_buf();
        (temp, root)
    }

    /// 在 root 下创建相对路径对应的文件，并写入内容。
    fn create_file(root: &Path, rel: &str, content: &str) {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent dir");
        }
        std::fs::write(&path, content).expect("write file");
    }

    /// 在 root 下创建相对路径对应的目录。
    fn create_dir(root: &Path, rel: &str) {
        let path = root.join(rel);
        std::fs::create_dir_all(&path).expect("create dir");
    }

    // ── 复制文件 ──

    /// 复制文件到另一个目录。
    #[tokio::test]
    async fn paste_copy_file_to_other_dir() {
        let (_t, root) = setup_temp();
        create_file(&root, "src/file.txt", "hello");
        create_dir(&root, "dst");

        let result = paste_file_tree_entry(
            root.to_string_lossy().to_string(),
            "src/file.txt".to_string(),
            "dst".to_string(),
            PasteFileTreeEntryMode::Copy,
            PasteConflictStrategy::Abort,
        )
        .await
        .expect("copy file should succeed");

        assert_eq!(result, "dst/file.txt");
        assert!(root.join("src/file.txt").exists());
        assert!(root.join("dst/file.txt").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("dst/file.txt")).unwrap(),
            "hello"
        );
    }

    /// 复制目录递归到另一个目录。
    #[tokio::test]
    async fn paste_copy_directory_recursively() {
        let (_t, root) = setup_temp();
        create_file(&root, "src/a/1.txt", "one");
        create_file(&root, "src/a/b/2.txt", "two");
        create_dir(&root, "dst");

        let result = paste_file_tree_entry(
            root.to_string_lossy().to_string(),
            "src/a".to_string(),
            "dst".to_string(),
            PasteFileTreeEntryMode::Copy,
            PasteConflictStrategy::Abort,
        )
        .await
        .expect("copy dir should succeed");

        assert_eq!(result, "dst/a");
        assert!(root.join("dst/a/b/2.txt").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("dst/a/1.txt")).unwrap(),
            "one"
        );
    }

    // ── 剪切（移动）文件 ──

    /// 剪切（移动）文件到另一个目录。
    #[tokio::test]
    async fn paste_cut_file_to_other_dir() {
        let (_t, root) = setup_temp();
        create_file(&root, "src/file.txt", "hello");
        create_dir(&root, "dst");

        let result = paste_file_tree_entry(
            root.to_string_lossy().to_string(),
            "src/file.txt".to_string(),
            "dst".to_string(),
            PasteFileTreeEntryMode::Cut,
            PasteConflictStrategy::Abort,
        )
        .await
        .expect("cut file should succeed");

        assert_eq!(result, "dst/file.txt");
        assert!(!root.join("src/file.txt").exists());
        assert!(root.join("dst/file.txt").exists());
    }

    /// 剪切（移动）目录到另一个目录。
    #[tokio::test]
    async fn paste_cut_directory_to_other_dir() {
        let (_t, root) = setup_temp();
        create_file(&root, "src/a/1.txt", "one");
        create_dir(&root, "dst");

        let result = paste_file_tree_entry(
            root.to_string_lossy().to_string(),
            "src/a".to_string(),
            "dst".to_string(),
            PasteFileTreeEntryMode::Cut,
            PasteConflictStrategy::Abort,
        )
        .await
        .expect("cut dir should succeed");

        assert_eq!(result, "dst/a");
        assert!(!root.join("src/a").exists());
        assert!(root.join("dst/a/1.txt").exists());
    }

    // ── 冲突策略 ──

    /// Abort 策略下同名时报错。
    #[tokio::test]
    async fn paste_abort_on_name_conflict() {
        let (_t, root) = setup_temp();
        create_file(&root, "src/file.txt", "original");
        create_file(&root, "dst/file.txt", "existing");

        let err = paste_file_tree_entry(
            root.to_string_lossy().to_string(),
            "src/file.txt".to_string(),
            "dst".to_string(),
            PasteFileTreeEntryMode::Copy,
            PasteConflictStrategy::Abort,
        )
        .await
        .expect_err("should fail on conflict");

        assert!(matches!(err.code, AppErrorCode::AlreadyExists));
        // 目标文件不应被覆盖
        assert_eq!(
            std::fs::read_to_string(root.join("dst/file.txt")).unwrap(),
            "existing"
        );
    }

    /// Overwrite 策略下同名时覆盖。
    #[tokio::test]
    async fn paste_overwrite_on_name_conflict() {
        let (_t, root) = setup_temp();
        create_file(&root, "src/file.txt", "new content");
        create_file(&root, "dst/file.txt", "old content");

        let result = paste_file_tree_entry(
            root.to_string_lossy().to_string(),
            "src/file.txt".to_string(),
            "dst".to_string(),
            PasteFileTreeEntryMode::Copy,
            PasteConflictStrategy::Overwrite,
        )
        .await
        .expect("overwrite should succeed");

        assert_eq!(result, "dst/file.txt");
        assert_eq!(
            std::fs::read_to_string(root.join("dst/file.txt")).unwrap(),
            "new content"
        );
    }

    /// Duplicate 策略下同名时自动生成副本名。
    #[tokio::test]
    async fn paste_duplicate_on_name_conflict() {
        let (_t, root) = setup_temp();
        create_file(&root, "src/file.txt", "original");
        create_file(&root, "dst/file.txt", "existing first");
        create_file(&root, "dst/file-副本.txt", "existing second");

        let result = paste_file_tree_entry(
            root.to_string_lossy().to_string(),
            "src/file.txt".to_string(),
            "dst".to_string(),
            PasteFileTreeEntryMode::Copy,
            PasteConflictStrategy::Duplicate,
        )
        .await
        .expect("duplicate should succeed");

        assert_eq!(result, "dst/file-副本(2).txt");
        assert!(root.join("dst/file.txt").exists());
        assert!(root.join("dst/file-副本.txt").exists());
        assert!(root.join("dst/file-副本(2).txt").exists());
    }

    // ── 相同路径特殊处理 ──

    /// 相同路径 + Overwrite 策略返回原路径（无操作）。
    #[tokio::test]
    async fn paste_same_path_overwrite_returns_original_path() {
        let (_t, root) = setup_temp();
        create_file(&root, "file.txt", "content");

        let result = paste_file_tree_entry(
            root.to_string_lossy().to_string(),
            "file.txt".to_string(),
            "".to_string(),
            PasteFileTreeEntryMode::Copy,
            PasteConflictStrategy::Overwrite,
        )
        .await
        .expect("same-path overwrite should succeed");

        assert_eq!(result, "file.txt");
    }

    /// 相同路径 + Duplicate 策略创建副本。
    #[tokio::test]
    async fn paste_same_path_duplicate_creates_copy() {
        let (_t, root) = setup_temp();
        create_file(&root, "file.txt", "content");

        let result = paste_file_tree_entry(
            root.to_string_lossy().to_string(),
            "file.txt".to_string(),
            "".to_string(),
            PasteFileTreeEntryMode::Copy,
            PasteConflictStrategy::Duplicate,
        )
        .await
        .expect("same-path duplicate should succeed");

        assert_eq!(result, "file-副本.txt");
        assert!(root.join("file.txt").exists());
        assert!(root.join("file-副本.txt").exists());
    }

    /// 相同路径 + Abort 策略报 AlreadyExists。
    #[tokio::test]
    async fn paste_same_path_abort_fails() {
        let (_t, root) = setup_temp();
        create_file(&root, "file.txt", "content");

        let err = paste_file_tree_entry(
            root.to_string_lossy().to_string(),
            "file.txt".to_string(),
            "".to_string(),
            PasteFileTreeEntryMode::Copy,
            PasteConflictStrategy::Abort,
        )
        .await
        .expect_err("same-path abort should fail");

        assert!(matches!(err.code, AppErrorCode::AlreadyExists));
    }

    // ── 安全性 ──

    /// 剪切目录到自身子目录时报错。
    #[tokio::test]
    async fn paste_cut_dir_into_self_is_rejected() {
        let (_t, root) = setup_temp();
        create_file(&root, "parent/child/file.txt", "content");

        let err = paste_file_tree_entry(
            root.to_string_lossy().to_string(),
            "parent".to_string(),
            "parent/child".to_string(),
            PasteFileTreeEntryMode::Cut,
            PasteConflictStrategy::Abort,
        )
        .await
        .expect_err("cut dir into itself should fail");

        assert!(matches!(err.code, AppErrorCode::InvalidInput));
    }

    /// 复制目录到自身子目录时报错，避免递归复制刚创建出的目标目录。
    #[tokio::test]
    async fn paste_copy_dir_into_self_is_rejected() {
        let (_t, root) = setup_temp();
        create_file(&root, "parent/child/file.txt", "content");

        let err = paste_file_tree_entry(
            root.to_string_lossy().to_string(),
            "parent".to_string(),
            "parent/child".to_string(),
            PasteFileTreeEntryMode::Copy,
            PasteConflictStrategy::Abort,
        )
        .await
        .expect_err("copy dir into itself should fail");

        assert!(matches!(err.code, AppErrorCode::InvalidInput));
    }

    /// 符号链接会跟随到真实目标，后端先拒绝以避免复制越界内容。
    #[tokio::test]
    #[cfg(unix)]
    async fn paste_symlink_source_is_rejected() {
        use std::os::unix::fs::symlink;

        let (_t, root) = setup_temp();
        create_file(&root, "real.txt", "content");
        create_dir(&root, "dst");
        symlink(root.join("real.txt"), root.join("link.txt")).expect("create symlink");

        let err = paste_file_tree_entry(
            root.to_string_lossy().to_string(),
            "link.txt".to_string(),
            "dst".to_string(),
            PasteFileTreeEntryMode::Copy,
            PasteConflictStrategy::Abort,
        )
        .await
        .expect_err("symlink source should fail");

        assert!(matches!(err.code, AppErrorCode::InvalidInput));
    }

    /// 剪切文件到自身所在目录（即相同路径）不应报目录子孙检测错误。
    #[tokio::test]
    async fn paste_cut_file_same_path_handled_gracefully() {
        let (_t, root) = setup_temp();
        create_file(&root, "file.txt", "content");

        let err = paste_file_tree_entry(
            root.to_string_lossy().to_string(),
            "file.txt".to_string(),
            "".to_string(),
            PasteFileTreeEntryMode::Cut,
            PasteConflictStrategy::Abort,
        )
        .await
        .expect_err("cut file to same path should fail");

        assert!(matches!(err.code, AppErrorCode::AlreadyExists));
    }

    // ── 错误路径 ──

    /// 源文件不存在时报 NotFound。
    #[tokio::test]
    async fn paste_source_not_found() {
        let (_t, root) = setup_temp();

        let err = paste_file_tree_entry(
            root.to_string_lossy().to_string(),
            "nonexistent.txt".to_string(),
            "".to_string(),
            PasteFileTreeEntryMode::Copy,
            PasteConflictStrategy::Abort,
        )
        .await
        .expect_err("non-existent source should fail");

        assert!(matches!(err.code, AppErrorCode::NotFound));
    }

    /// 目标目录不存在时报 NotFound。
    #[tokio::test]
    async fn paste_target_dir_not_found() {
        let (_t, root) = setup_temp();
        create_file(&root, "file.txt", "content");

        let err = paste_file_tree_entry(
            root.to_string_lossy().to_string(),
            "file.txt".to_string(),
            "nonexistent_dir".to_string(),
            PasteFileTreeEntryMode::Copy,
            PasteConflictStrategy::Abort,
        )
        .await
        .expect_err("non-existent target dir should fail");

        assert!(matches!(err.code, AppErrorCode::NotFound));
    }

    /// 根路径不存在时报 NotFound。
    #[tokio::test]
    async fn paste_root_not_found() {
        let err = paste_file_tree_entry(
            "/tmp/codeg_paste_test_nonexistent_root_12345".to_string(),
            "file.txt".to_string(),
            "".to_string(),
            PasteFileTreeEntryMode::Copy,
            PasteConflictStrategy::Abort,
        )
        .await
        .expect_err("non-existent root should fail");

        assert!(matches!(err.code, AppErrorCode::NotFound));
    }

    /// 源为工作区根路径时报 InvalidInput。
    #[tokio::test]
    async fn paste_source_is_root_rejected() {
        let (_t, root) = setup_temp();

        let err = paste_file_tree_entry(
            root.to_string_lossy().to_string(),
            "".to_string(),
            "".to_string(),
            PasteFileTreeEntryMode::Copy,
            PasteConflictStrategy::Abort,
        )
        .await
        .expect_err("root as source should fail");

        assert!(matches!(err.code, AppErrorCode::InvalidInput));
    }
}
