//! Task-specific git building blocks: base-pinned revs, commit-all, the
//! two-stage merge steps, and worktree removal. Thin wrappers over the git CLI
//! (mirroring `commands::folders`), composed by the task engine which owns the
//! per-folder git mutex.

use crate::app_error::AppCommandError;
use crate::commands::folders::{detect_conflicts, git_command_error};
use crate::models::WorkTaskChangedFile;

async fn run_git(path: &str, args: &[&str]) -> Result<std::process::Output, AppCommandError> {
    crate::process::tokio_command("git")
        .args(args)
        .current_dir(path)
        .output()
        .await
        .map_err(AppCommandError::io)
}

/// A worktree's own git directory (`<repo>/.git/worktrees/<name>` for a linked
/// worktree, `<repo>/.git` for the main one). Engine-private markers live here:
/// nothing under it can show up in `git status` or be committed by the agent.
pub async fn git_dir(path: &str) -> Result<std::path::PathBuf, AppCommandError> {
    let out = run_git(path, &["rev-parse", "--absolute-git-dir"]).await?;
    if !out.status.success() {
        return Err(git_command_error("rev-parse --absolute-git-dir", &out.stderr));
    }
    let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if dir.is_empty() {
        return Err(AppCommandError::external_command(
            "git rev-parse --absolute-git-dir returned nothing",
            path.to_string(),
        ));
    }
    Ok(std::path::PathBuf::from(dir))
}

/// Resolve a revision to a full sha.
pub async fn rev_parse(path: &str, rev: &str) -> Result<String, AppCommandError> {
    let out = run_git(path, &["rev-parse", "--verify", &format!("{rev}^{{commit}}")]).await?;
    if !out.status.success() {
        return Err(git_command_error("rev-parse", &out.stderr));
    }
    let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if sha.is_empty() {
        return Err(AppCommandError::external_command(
            "git rev-parse returned nothing",
            rev.to_string(),
        ));
    }
    Ok(sha)
}

/// Whether the index has staged changes (stage-B preflight requires a clean
/// index in the project folder).
pub async fn staged_clean(path: &str) -> Result<bool, AppCommandError> {
    let out = run_git(path, &["diff", "--cached", "--quiet"]).await?;
    Ok(out.status.success())
}

/// Whether the working tree has anything to commit (tracked or untracked).
pub async fn has_changes(path: &str) -> Result<bool, AppCommandError> {
    let out = run_git(path, &["status", "--porcelain=v1", "-unormal"]).await?;
    if !out.status.success() {
        return Err(git_command_error("status", &out.stderr));
    }
    Ok(!out.stdout.iter().all(|b| b.is_ascii_whitespace()))
}

/// Stage everything and commit with the user's resolved author. Returns
/// `false` when there was nothing to commit.
pub async fn commit_all(
    conn: &sea_orm::DatabaseConnection,
    path: &str,
    message: &str,
) -> Result<bool, AppCommandError> {
    if !has_changes(path).await? {
        return Ok(false);
    }
    let add = run_git(path, &["add", "-A"]).await?;
    if !add.status.success() {
        return Err(git_command_error("add -A", &add.stderr));
    }
    commit_staged(conn, path, message).await?;
    Ok(true)
}

/// Commit whatever is staged (used by commit-all and the squash landing).
/// Resolves the commit author from the matching configured account, like
/// `git_commit_core`.
pub async fn commit_staged(
    conn: &sea_orm::DatabaseConnection,
    path: &str,
    message: &str,
) -> Result<(), AppCommandError> {
    let author_override = crate::git_credential::resolve_commit_author(path, conn).await;
    let mut cmd = crate::process::tokio_command("git");
    if let Some((ref name, ref email)) = author_override {
        cmd.args([
            "-c",
            &format!("user.name={name}"),
            "-c",
            &format!("user.email={email}"),
        ]);
    }
    cmd.args(["commit", "-m", message]).current_dir(path);
    let out = cmd.output().await.map_err(AppCommandError::io)?;
    if !out.status.success() {
        return Err(git_command_error("commit", &out.stderr));
    }
    Ok(())
}

/// Outcome of a merge attempt that treats conflicts as data, not errors.
pub enum MergeAttempt {
    Ok,
    /// Conflicted; the merge has ALREADY been aborted (worktree left clean).
    Conflict(Vec<String>),
}

/// Stage A: merge the base branch INTO the task worktree, so conflicts always
/// land in the worktree. On conflict the merge is aborted and the conflicted
/// paths are returned.
pub async fn merge_base_into_worktree(
    worktree_path: &str,
    base_branch: &str,
) -> Result<MergeAttempt, AppCommandError> {
    let out = run_git(worktree_path, &["merge", "--no-edit", base_branch]).await?;
    if out.status.success() {
        return Ok(MergeAttempt::Ok);
    }
    let conflicts = detect_conflicts(worktree_path).await?;
    if conflicts.is_empty() {
        return Err(git_command_error("merge", &out.stderr));
    }
    let abort = run_git(worktree_path, &["merge", "--abort"]).await?;
    if !abort.status.success() {
        tracing::warn!(
            "[work_task] merge --abort failed in {worktree_path}: {}",
            String::from_utf8_lossy(&abort.stderr)
        );
    }
    Ok(MergeAttempt::Conflict(conflicts))
}

/// Stage B (squash): stage the work branch's tree onto the base branch. The
/// caller commits via [`commit_staged`]. On failure the caller cleans up with
/// [`reset_merge`].
pub async fn merge_squash(path: &str, work_branch: &str) -> Result<(), AppCommandError> {
    let out = run_git(path, &["merge", "--squash", work_branch]).await?;
    if !out.status.success() {
        return Err(git_command_error("merge --squash", &out.stderr));
    }
    Ok(())
}

/// Stage B (merge commit): `git merge --no-ff -m <message> <branch>`.
pub async fn merge_no_ff(
    path: &str,
    work_branch: &str,
    message: &str,
) -> Result<(), AppCommandError> {
    let out = run_git(path, &["merge", "--no-ff", "-m", message, work_branch]).await?;
    if !out.status.success() {
        return Err(git_command_error("merge --no-ff", &out.stderr));
    }
    Ok(())
}

/// Clean a failed/interrupted stage B out of the project folder. Safe because
/// the preflight guaranteed the index was clean before we touched it.
pub async fn reset_merge(path: &str) -> Result<(), AppCommandError> {
    let out = run_git(path, &["reset", "--merge"]).await?;
    if !out.status.success() {
        return Err(git_command_error("reset --merge", &out.stderr));
    }
    Ok(())
}

/// Whether a merge is in progress (MERGE_HEAD exists) — crash-recovery probe.
pub async fn has_merge_head(path: &str) -> Result<bool, AppCommandError> {
    let out = run_git(path, &["rev-parse", "--verify", "MERGE_HEAD"]).await?;
    Ok(out.status.success())
}

/// Whether `ancestor` is reachable from `descendant`. Exit 0 = yes, 1 = no,
/// anything else is a real error.
pub async fn is_ancestor(
    path: &str,
    ancestor: &str,
    descendant: &str,
) -> Result<bool, AppCommandError> {
    let out = run_git(path, &["merge-base", "--is-ancestor", ancestor, descendant]).await?;
    match out.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(git_command_error("merge-base --is-ancestor", &out.stderr)),
    }
}

/// Whether two revisions point at identical trees (`git diff --quiet a b`) —
/// how a squash landing is recognized without knowing the commit message.
pub async fn trees_equal(path: &str, a: &str, b: &str) -> Result<bool, AppCommandError> {
    let out = run_git(path, &["diff", "--quiet", a, b]).await?;
    match out.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(git_command_error("diff --quiet", &out.stderr)),
    }
}

/// `git diff --numstat <base>` — the task's change set vs its recorded base.
/// Binary files report `-` counts; they are counted as a changed file with 0/0.
pub async fn diff_numstat(
    path: &str,
    base: &str,
) -> Result<Vec<WorkTaskChangedFile>, AppCommandError> {
    let out = run_git(path, &["diff", "--numstat", base]).await?;
    if !out.status.success() {
        return Err(git_command_error("diff --numstat", &out.stderr));
    }
    let mut files = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut parts = line.splitn(3, '\t');
        let (Some(adds), Some(dels), Some(file)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        files.push(WorkTaskChangedFile {
            file: file.to_string(),
            additions: adds.parse().unwrap_or(0),
            deletions: dels.parse().unwrap_or(0),
        });
    }
    Ok(files)
}

/// Remove a task worktree directory + its branch. Runs from the project repo.
/// Tolerant of a directory already gone (prunes the stale registration) and of
/// a branch already deleted; `-D` is required because a squash-landed branch is
/// unmerged in git's eyes.
pub async fn remove_worktree_and_branch(
    repo_path: &str,
    worktree_path: &str,
    work_branch: Option<&str>,
) -> Result<(), AppCommandError> {
    let removed = run_git(repo_path, &["worktree", "remove", "--force", worktree_path]).await?;
    if !removed.status.success() {
        if std::path::Path::new(worktree_path).exists() {
            return Err(git_command_error("worktree remove", &removed.stderr));
        }
        // Directory already gone — drop the stale registration so the branch
        // delete below isn't blocked by a phantom checkout.
        let prune = run_git(repo_path, &["worktree", "prune"]).await?;
        if !prune.status.success() {
            return Err(git_command_error("worktree prune", &prune.stderr));
        }
    }
    if let Some(branch) = work_branch {
        let del = run_git(repo_path, &["branch", "-D", branch]).await?;
        if !del.status.success() {
            let msg = String::from_utf8_lossy(&del.stderr).to_lowercase();
            if !msg.contains("not found") {
                return Err(git_command_error("branch -D", &del.stderr));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Run a git command in `dir`, supplying identity via env so the test does
    /// not depend on (or mutate) the developer's global git config.
    fn git_run(dir: &std::path::Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .output()
            .expect("spawn git");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// Why removing a task worktree has to consult BOTH probes: each is blind
    /// to exactly what the other sees. `remove_worktree_and_branch` runs
    /// `worktree remove --force` + `branch -D`, so anything either probe would
    /// have found is destroyed silently if only one of them is asked.
    #[tokio::test]
    async fn status_and_base_diff_have_opposite_blind_spots() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().to_str().expect("utf-8 path");
        git_run(dir.path(), &["init", "-q"]);
        std::fs::write(dir.path().join("a.txt"), "one\n").expect("write");
        git_run(dir.path(), &["add", "-A"]);
        git_run(dir.path(), &["commit", "-q", "-m", "base"]);
        let base = rev_parse(path, "HEAD").await.expect("base sha");

        // Settled state: nothing on top of the base, by either measure.
        assert!(!has_changes(path).await.expect("status"));
        assert!(diff_numstat(path, &base).await.expect("diff").is_empty());

        // Work committed on the branch afterwards leaves a spotless worktree…
        std::fs::write(dir.path().join("a.txt"), "one\ntwo\n").expect("write");
        git_run(dir.path(), &["commit", "-qam", "later work"]);
        assert!(
            !has_changes(path).await.expect("status"),
            "a commit leaves no trace in `git status` — status alone would clear a branch for deletion"
        );
        // …but it is exactly what a merge would have taken.
        let files = diff_numstat(path, &base).await.expect("diff");
        assert_eq!(files.len(), 1, "the base diff still holds the commit");
        assert_eq!(files[0].file, "a.txt");

        // The mirror image: an untracked file never reaches a diff against the
        // base, so the base diff alone would clear a worktree for deletion.
        git_run(dir.path(), &["reset", "-q", "--hard", &base]);
        std::fs::write(dir.path().join("scratch.txt"), "junk\n").expect("write");
        assert!(
            diff_numstat(path, &base).await.expect("diff").is_empty(),
            "untracked files are invisible to the base diff"
        );
        assert!(has_changes(path).await.expect("status"));
    }
}
