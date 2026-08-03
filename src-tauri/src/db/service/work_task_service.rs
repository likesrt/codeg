//! Work-task CRUD + state machine. Mode-agnostic: every fn takes a plain
//! `&DatabaseConnection` so Tauri commands, Axum handlers, and the task engine
//! share one code path.
//!
//! Invariants enforced here:
//! - Every status transition is a conditional UPDATE (CAS) on the expected
//!   status — and, for engine-driven transitions, the current `run_seq` — so a
//!   canceled/stale generation's late events are zero-side-effect no-ops.
//! - Every transition writes its `work_task_event` row in the SAME transaction
//!   (and the CAS UPDATE is the transaction's first statement, so SQLite takes
//!   the write lock up front — see the busy-snapshot pitfall).
//! - `done` is written only by `merge_landed` and never rolls back; a failed
//!   worktree cleanup surfaces as `cleanup_state='failed'` on the done row.

use chrono::Utc;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, ConnectionTrait, DatabaseConnection,
    EntityTrait, IntoActiveModel, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, Set,
    TransactionTrait,
};

use crate::db::entities::work_task::WorkTaskStatus;
use crate::db::entities::{folder, work_task, work_task_event, work_task_settings, work_task_template};
use crate::db::error::DbError;
use crate::models::{
    WorkTaskConfig, WorkTaskDraft, WorkTaskEventInfo, WorkTaskFolderSettings, WorkTaskInfo,
    WorkTaskMergeState,
};

// `WorkTaskPendingMerge` / `WorkTaskPreflight` are referenced via `crate::models::`
// in their fns to keep this import list stable.

pub fn status_str(s: WorkTaskStatus) -> &'static str {
    match s {
        WorkTaskStatus::Todo => "todo",
        WorkTaskStatus::Queued => "queued",
        WorkTaskStatus::Running => "running",
        WorkTaskStatus::AwaitingInput => "awaiting_input",
        WorkTaskStatus::Review => "review",
        WorkTaskStatus::Merging => "merging",
        WorkTaskStatus::Done => "done",
        WorkTaskStatus::Failed => "failed",
        WorkTaskStatus::Canceled => "canceled",
    }
}

fn to_info(m: work_task::Model) -> WorkTaskInfo {
    WorkTaskInfo {
        id: m.id,
        folder_id: m.folder_id,
        title: m.title,
        config: serde_json::from_str(&m.config).unwrap_or(serde_json::Value::Null),
        status: m.status,
        failure_reason: m.failure_reason,
        last_error: m.last_error,
        run_seq: m.run_seq,
        sort_order: m.sort_order,
        worktree_folder_id: m.worktree_folder_id,
        conversation_id: m.conversation_id,
        connection_id: m.connection_id,
        base_branch: m.base_branch,
        base_sha: m.base_sha,
        work_branch: m.work_branch,
        cleanup_state: m.cleanup_state,
        verdict: m.verdict,
        result_summary: m.result_summary,
        files_changed: m.files_changed,
        additions: m.additions,
        deletions: m.deletions,
        merge_commit: m.merge_commit,
        preflight: m
            .preflight
            .as_deref()
            .and_then(|p| serde_json::from_str(p).ok()),
        archived_at: m.archived_at,
        latest_progress: None,
        created_at: m.created_at,
        updated_at: m.updated_at,
        started_at: m.started_at,
        settled_at: m.settled_at,
        finished_at: m.finished_at,
    }
}

fn event_to_info(m: work_task_event::Model) -> WorkTaskEventInfo {
    WorkTaskEventInfo {
        id: m.id,
        task_id: m.task_id,
        kind: m.kind,
        actor: m.actor,
        payload: m
            .payload
            .as_deref()
            .and_then(|p| serde_json::from_str(p).ok()),
        created_at: m.created_at,
    }
}

/// Append a timeline event. Callers inside a transition pass the open `txn` so
/// the event commits atomically with the state change.
pub async fn record_event<C: ConnectionTrait>(
    conn: &C,
    task_id: i32,
    kind: &str,
    actor: &str,
    payload: Option<serde_json::Value>,
) -> Result<(), DbError> {
    let active = work_task_event::ActiveModel {
        id: NotSet,
        task_id: Set(task_id),
        kind: Set(kind.to_string()),
        actor: Set(actor.to_string()),
        payload: Set(payload.map(|p| p.to_string())),
        created_at: Set(Utc::now()),
    };
    active.insert(conn).await?;
    Ok(())
}

async fn status_changed_event<C: ConnectionTrait>(
    conn: &C,
    task_id: i32,
    actor: &str,
    from: Option<WorkTaskStatus>,
    to: WorkTaskStatus,
    extra: Option<serde_json::Value>,
) -> Result<(), DbError> {
    let mut payload = serde_json::json!({ "to": status_str(to) });
    if let Some(from) = from {
        payload["from"] = serde_json::Value::String(status_str(from).to_string());
    }
    if let Some(serde_json::Value::Object(extra)) = extra {
        for (k, v) in extra {
            payload[k] = v;
        }
    }
    record_event(conn, task_id, "status_changed", actor, Some(payload)).await
}

// ── queries ─────────────────────────────────────────────────────────────────

/// Active tasks (optionally per folder), joined on the live folder so tasks of
/// a removed folder are invisible and unschedulable. Board order: sort_order.
pub async fn list(
    conn: &DatabaseConnection,
    folder_id: Option<i32>,
) -> Result<Vec<WorkTaskInfo>, DbError> {
    let mut q = work_task::Entity::find()
        .filter(work_task::Column::DeletedAt.is_null())
        .inner_join(folder::Entity)
        .filter(folder::Column::DeletedAt.is_null());
    if let Some(fid) = folder_id {
        q = q.filter(work_task::Column::FolderId.eq(fid));
    }
    let rows = q
        .order_by_asc(work_task::Column::SortOrder)
        .order_by_asc(work_task::Column::Id)
        .all(conn)
        .await?;
    let mut infos: Vec<WorkTaskInfo> = rows.into_iter().map(to_info).collect();

    // Realtime progress line for live cards: the latest `agent_progress`
    // milestone of each running/awaiting/merging task, fetched in one sweep.
    let live_ids: Vec<i32> = infos
        .iter()
        .filter(|t| {
            matches!(
                t.status,
                WorkTaskStatus::Running
                    | WorkTaskStatus::AwaitingInput
                    | WorkTaskStatus::Merging
            )
        })
        .map(|t| t.id)
        .collect();
    if !live_ids.is_empty() {
        let events = work_task_event::Entity::find()
            .filter(work_task_event::Column::TaskId.is_in(live_ids))
            .filter(work_task_event::Column::Kind.eq("agent_progress"))
            .order_by_asc(work_task_event::Column::Id)
            .all(conn)
            .await?;
        let mut latest: std::collections::HashMap<i32, String> = std::collections::HashMap::new();
        for e in events {
            let message = e
                .payload
                .as_deref()
                .and_then(|p| serde_json::from_str::<serde_json::Value>(p).ok())
                .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from));
            if let Some(message) = message {
                latest.insert(e.task_id, message); // ascending id — last wins
            }
        }
        for t in &mut infos {
            if let Some(m) = latest.get(&t.id) {
                t.latest_progress = Some(m.clone());
            }
        }
    }
    Ok(infos)
}

pub async fn get(conn: &DatabaseConnection, id: i32) -> Result<WorkTaskInfo, DbError> {
    Ok(to_info(get_model(conn, id).await?))
}

/// Raw row (includes internal fields like `connection_id` / `merge_state`) for
/// the engine. Errors on missing or soft-deleted rows.
pub async fn get_model(conn: &DatabaseConnection, id: i32) -> Result<work_task::Model, DbError> {
    let row = work_task::Entity::find_by_id(id)
        .one(conn)
        .await?
        .ok_or_else(|| DbError::NotFound(format!("work task {id}")))?;
    if row.deleted_at.is_some() {
        return Err(DbError::NotFound(format!("work task {id}")));
    }
    Ok(row)
}

pub async fn list_events(
    conn: &DatabaseConnection,
    task_id: i32,
    limit: u64,
) -> Result<Vec<WorkTaskEventInfo>, DbError> {
    let rows = work_task_event::Entity::find()
        .filter(work_task_event::Column::TaskId.eq(task_id))
        .order_by_asc(work_task_event::Column::CreatedAt)
        .order_by_asc(work_task_event::Column::Id)
        .limit(limit)
        .all(conn)
        .await?;
    Ok(rows.into_iter().map(event_to_info).collect())
}

/// Raw rows in the given statuses. Deliberately does NOT join the folder: the
/// reconcile sweep must also converge tasks whose folder was removed mid-run.
pub async fn list_by_status(
    conn: &DatabaseConnection,
    statuses: &[WorkTaskStatus],
) -> Result<Vec<work_task::Model>, DbError> {
    let rows = work_task::Entity::find()
        .filter(work_task::Column::DeletedAt.is_null())
        .filter(work_task::Column::Status.is_in(statuses.iter().copied()))
        .all(conn)
        .await?;
    Ok(rows)
}

/// Ids of all todo tasks of a folder, in board order (for "start all").
pub async fn list_todo_ids(
    conn: &DatabaseConnection,
    folder_id: i32,
) -> Result<Vec<i32>, DbError> {
    let rows = work_task::Entity::find()
        .filter(work_task::Column::DeletedAt.is_null())
        .filter(work_task::Column::FolderId.eq(folder_id))
        .filter(work_task::Column::Status.eq(WorkTaskStatus::Todo))
        .order_by_asc(work_task::Column::SortOrder)
        .order_by_asc(work_task::Column::Id)
        .all(conn)
        .await?;
    Ok(rows.into_iter().map(|m| m.id).collect())
}

/// Next queued task of a folder in board order (the engine's launch pump picks
/// from here while under the folder's pump lock). Joined on the live folder.
pub async fn next_queued(
    conn: &DatabaseConnection,
    folder_id: i32,
    exclude: &[i32],
) -> Result<Option<work_task::Model>, DbError> {
    let mut q = work_task::Entity::find()
        .filter(work_task::Column::DeletedAt.is_null())
        .filter(work_task::Column::FolderId.eq(folder_id))
        .filter(work_task::Column::Status.eq(WorkTaskStatus::Queued))
        .inner_join(folder::Entity)
        .filter(folder::Column::DeletedAt.is_null());
    if !exclude.is_empty() {
        q = q.filter(work_task::Column::Id.is_not_in(exclude.iter().copied()));
    }
    Ok(q.order_by_asc(work_task::Column::SortOrder)
        .order_by_asc(work_task::Column::Id)
        .one(conn)
        .await?)
}

/// Distinct folder ids that currently have pending (todo or queued) tasks over
/// live folders — drives the reconcile tick's pump sweep. Todo is included so
/// auto_process folders get their scheduler pass even when nothing is queued;
/// the pump itself checks the folder's auto flag.
pub async fn folders_with_pending(conn: &DatabaseConnection) -> Result<Vec<i32>, DbError> {
    let rows = work_task::Entity::find()
        .filter(work_task::Column::DeletedAt.is_null())
        .filter(
            work_task::Column::Status.is_in([WorkTaskStatus::Todo, WorkTaskStatus::Queued]),
        )
        .inner_join(folder::Entity)
        .filter(folder::Column::DeletedAt.is_null())
        .all(conn)
        .await?;
    let mut ids: Vec<i32> = rows.into_iter().map(|m| m.folder_id).collect();
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}

/// Folders that currently hold todo tasks — the "start all" fan-out set when
/// no folder is selected.
pub async fn folders_with_todos(conn: &DatabaseConnection) -> Result<Vec<i32>, DbError> {
    let rows = work_task::Entity::find()
        .filter(work_task::Column::DeletedAt.is_null())
        .filter(work_task::Column::Status.eq(WorkTaskStatus::Todo))
        .inner_join(folder::Entity)
        .filter(folder::Column::DeletedAt.is_null())
        .all(conn)
        .await?;
    let mut ids: Vec<i32> = rows.into_iter().map(|m| m.folder_id).collect();
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}

/// Launched-and-active count per folder (running + awaiting_input + merging).
/// `queued` is deliberately excluded — it is the waiting room the pump drains.
pub async fn active_launched_count(
    conn: &DatabaseConnection,
    folder_id: i32,
) -> Result<u64, DbError> {
    let count = work_task::Entity::find()
        .filter(work_task::Column::DeletedAt.is_null())
        .filter(work_task::Column::FolderId.eq(folder_id))
        .filter(work_task::Column::Status.is_in([
            WorkTaskStatus::Running,
            WorkTaskStatus::AwaitingInput,
            WorkTaskStatus::Merging,
        ]))
        .count(conn)
        .await?;
    Ok(count)
}

/// Tasks needing the user ("等你处理"): awaiting_input + review + failed, over
/// live folders. Drives the sidebar badge.
pub async fn attention_count(conn: &DatabaseConnection) -> Result<u64, DbError> {
    let count = work_task::Entity::find()
        .filter(work_task::Column::DeletedAt.is_null())
        .filter(work_task::Column::Status.is_in([
            WorkTaskStatus::AwaitingInput,
            WorkTaskStatus::Review,
            WorkTaskStatus::Failed,
        ]))
        .filter(work_task::Column::ArchivedAt.is_null())
        .inner_join(folder::Entity)
        .filter(folder::Column::DeletedAt.is_null())
        .count(conn)
        .await?;
    Ok(count)
}

// ── CRUD ────────────────────────────────────────────────────────────────────

fn parse_config(config: &serde_json::Value) -> WorkTaskConfig {
    serde_json::from_value(config.clone()).unwrap_or_default()
}

fn validate_draft(draft: &WorkTaskDraft) -> Result<(), DbError> {
    if draft.title.trim().is_empty() {
        return Err(DbError::Validation("title is required".into()));
    }
    let cfg = parse_config(&draft.config);
    if cfg.display_text.trim().is_empty() && cfg.prompt_blocks.is_empty() {
        return Err(DbError::Validation("prompt is required".into()));
    }
    Ok(())
}

pub async fn create(
    conn: &DatabaseConnection,
    draft: WorkTaskDraft,
) -> Result<WorkTaskInfo, DbError> {
    validate_draft(&draft)?;
    // The target folder must exist, be live, and be a project root (a task
    // bound to a worktree folder would nest worktrees at launch).
    let folder = folder::Entity::find_by_id(draft.folder_id)
        .one(conn)
        .await?
        .filter(|f| f.deleted_at.is_none())
        .ok_or_else(|| DbError::NotFound(format!("folder {}", draft.folder_id)))?;
    if folder.parent_id.is_some() {
        return Err(DbError::Validation(
            "tasks must target a project folder, not a worktree".into(),
        ));
    }
    let config_str = serde_json::to_string(&draft.config)
        .map_err(|e| DbError::Validation(format!("config not serializable: {e}")))?;
    let now = Utc::now();
    let max_order = work_task::Entity::find()
        .filter(work_task::Column::FolderId.eq(draft.folder_id))
        .order_by_desc(work_task::Column::SortOrder)
        .one(conn)
        .await?
        .map(|m| m.sort_order)
        .unwrap_or(0);

    let txn = conn.begin().await?;
    let active = work_task::ActiveModel {
        id: NotSet,
        folder_id: Set(draft.folder_id),
        title: Set(draft.title.trim().to_string()),
        config: Set(config_str),
        status: Set(WorkTaskStatus::Todo),
        failure_reason: Set(None),
        last_error: Set(None),
        run_seq: Set(0),
        sort_order: Set(max_order + 1),
        worktree_folder_id: Set(None),
        conversation_id: Set(None),
        connection_id: Set(None),
        base_branch: Set(None),
        base_sha: Set(None),
        work_branch: Set(None),
        merge_state: Set(None),
        pending_merge: Set(None),
        cleanup_state: Set(None),
        verdict: Set(None),
        result_summary: Set(None),
        files_changed: Set(None),
        additions: Set(None),
        deletions: Set(None),
        merge_commit: Set(None),
        preflight: Set(None),
        archived_at: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
        started_at: Set(None),
        settled_at: Set(None),
        finished_at: Set(None),
        deleted_at: Set(None),
    };
    let row = active.insert(&txn).await?;
    record_event(&txn, row.id, "created", "user", None).await?;
    txn.commit().await?;
    Ok(to_info(row))
}

/// Edit title/config. Only meaningful outside an active run: allowed in
/// todo / failed / canceled. Moving to another folder is allowed only for a
/// pristine todo (no worktree minted yet).
pub async fn update(
    conn: &DatabaseConnection,
    id: i32,
    draft: WorkTaskDraft,
) -> Result<WorkTaskInfo, DbError> {
    validate_draft(&draft)?;
    let row = get_model(conn, id).await?;
    if !matches!(
        row.status,
        WorkTaskStatus::Todo | WorkTaskStatus::Failed | WorkTaskStatus::Canceled
    ) {
        return Err(DbError::Validation(
            "only todo, failed, or canceled tasks can be edited".into(),
        ));
    }
    if draft.folder_id != row.folder_id
        && (row.status != WorkTaskStatus::Todo || row.worktree_folder_id.is_some())
    {
        return Err(DbError::Validation(
            "a task that already ran cannot move to another folder".into(),
        ));
    }
    let config_str = serde_json::to_string(&draft.config)
        .map_err(|e| DbError::Validation(format!("config not serializable: {e}")))?;
    let mut active = row.into_active_model();
    active.folder_id = Set(draft.folder_id);
    active.title = Set(draft.title.trim().to_string());
    active.config = Set(config_str);
    active.updated_at = Set(Utc::now());
    Ok(to_info(active.update(conn).await?))
}

/// Soft-delete. The command layer is responsible for cancelling an active run
/// first (and refuses while merging).
pub async fn soft_delete(conn: &DatabaseConnection, id: i32) -> Result<(), DbError> {
    let now = Utc::now();
    let txn = conn.begin().await?;
    let res = work_task::Entity::update_many()
        .col_expr(work_task::Column::DeletedAt, Expr::value(Some(now)))
        .col_expr(work_task::Column::UpdatedAt, Expr::value(now))
        .filter(work_task::Column::Id.eq(id))
        .filter(work_task::Column::DeletedAt.is_null())
        .filter(work_task::Column::Status.ne(WorkTaskStatus::Merging))
        .exec(&txn)
        .await?;
    if res.rows_affected != 1 {
        txn.rollback().await?;
        return Err(DbError::Validation(
            "task not found or currently merging".into(),
        ));
    }
    record_event(
        &txn,
        id,
        "user_action",
        "user",
        Some(serde_json::json!({ "action": "delete" })),
    )
    .await?;
    txn.commit().await?;
    Ok(())
}

// ── state machine (all CAS; event in the same transaction) ─────────────────

/// Claim a task for a fresh execution generation: `from` → queued with
/// `run_seq + 1`, clearing stale failure fields. Returns the NEW run_seq, or
/// `None` if the CAS lost (wrong status / deleted).
pub async fn claim_for_run(
    conn: &DatabaseConnection,
    id: i32,
    from: WorkTaskStatus,
    actor: &str,
) -> Result<Option<i32>, DbError> {
    let now = Utc::now();
    let txn = conn.begin().await?;
    let res = work_task::Entity::update_many()
        .col_expr(
            work_task::Column::Status,
            Expr::value(status_str(WorkTaskStatus::Queued)),
        )
        .col_expr(
            work_task::Column::RunSeq,
            Expr::col(work_task::Column::RunSeq).add(1),
        )
        .col_expr(work_task::Column::FailureReason, Expr::value(None::<String>))
        .col_expr(work_task::Column::LastError, Expr::value(None::<String>))
        // A fresh generation invalidates the previous run's self-reported
        // verdict (result_summary stays visible until the next settle).
        .col_expr(work_task::Column::Verdict, Expr::value(None::<String>))
        // A user-driven claim supersedes any auto-remerge intent and stale
        // preflight light, and resurrects an archived terminal task.
        .col_expr(work_task::Column::PendingMerge, Expr::value(None::<String>))
        .col_expr(work_task::Column::Preflight, Expr::value(None::<String>))
        .col_expr(
            work_task::Column::ArchivedAt,
            Expr::value(None::<chrono::DateTime<Utc>>),
        )
        .col_expr(work_task::Column::FinishedAt, Expr::value(None::<chrono::DateTime<Utc>>))
        .col_expr(work_task::Column::UpdatedAt, Expr::value(now))
        .filter(work_task::Column::Id.eq(id))
        .filter(work_task::Column::Status.eq(from))
        .filter(work_task::Column::DeletedAt.is_null())
        .exec(&txn)
        .await?;
    if res.rows_affected != 1 {
        txn.rollback().await?;
        return Ok(None);
    }
    let run_seq = work_task::Entity::find_by_id(id)
        .one(&txn)
        .await?
        .map(|m| m.run_seq)
        .ok_or_else(|| DbError::NotFound(format!("work task {id}")))?;
    status_changed_event(&txn, id, actor, Some(from), WorkTaskStatus::Queued, None).await?;
    txn.commit().await?;
    Ok(Some(run_seq))
}

/// Persist the board's new pending-column order: each id gets its index as its
/// `sort_order`. Scoped to the folder (an id from another folder simply
/// doesn't match the WHERE) — sort_order is a pure ordering field, so a task
/// that advanced mid-drag is harmless to renumber.
pub async fn reorder(
    conn: &DatabaseConnection,
    folder_id: i32,
    ordered_ids: &[i32],
) -> Result<(), DbError> {
    let now = Utc::now();
    let txn = conn.begin().await?;
    for (index, id) in ordered_ids.iter().enumerate() {
        work_task::Entity::update_many()
            .col_expr(work_task::Column::SortOrder, Expr::value(index as i32))
            .col_expr(work_task::Column::UpdatedAt, Expr::value(now))
            .filter(work_task::Column::Id.eq(*id))
            .filter(work_task::Column::FolderId.eq(folder_id))
            .filter(work_task::Column::DeletedAt.is_null())
            .exec(&txn)
            .await?;
    }
    txn.commit().await?;
    Ok(())
}

/// Scheduler arm of an auto_process folder: claim the head todo task (board
/// order) into the queue — todo → queued, `run_seq + 1` — but only while the
/// folder's concurrency budget has room. Unlike the launch pump's count, the
/// budget here INCLUDES queued tasks (manual or auto), so the auto arm never
/// piles up a queue beyond `max_concurrent`; the rest stay visible in todo.
///
/// The CAS UPDATE is the transaction's first statement (write lock up front);
/// the budget is then re-checked INSIDE the same transaction and the claim is
/// rolled back when over — that in-transaction recheck is what makes the
/// reservation safe against concurrent manual starts. `max_concurrent <= 0`
/// means unlimited. Returns the claimed task id, or `None` when the folder has
/// no todo task or the budget is spent.
pub async fn auto_claim_next(
    conn: &DatabaseConnection,
    folder_id: i32,
    max_concurrent: i32,
) -> Result<Option<i32>, DbError> {
    loop {
        // Head lookup runs outside the transaction so the write stays first;
        // the CAS below re-checks the status and simply retries on a miss.
        let head = work_task::Entity::find()
            .filter(work_task::Column::DeletedAt.is_null())
            .filter(work_task::Column::FolderId.eq(folder_id))
            .filter(work_task::Column::Status.eq(WorkTaskStatus::Todo))
            .inner_join(folder::Entity)
            .filter(folder::Column::DeletedAt.is_null())
            .order_by_asc(work_task::Column::SortOrder)
            .order_by_asc(work_task::Column::Id)
            .one(conn)
            .await?;
        let Some(head) = head else {
            return Ok(None);
        };

        let now = Utc::now();
        let txn = conn.begin().await?;
        let res = work_task::Entity::update_many()
            .col_expr(
                work_task::Column::Status,
                Expr::value(status_str(WorkTaskStatus::Queued)),
            )
            .col_expr(
                work_task::Column::RunSeq,
                Expr::col(work_task::Column::RunSeq).add(1),
            )
            .col_expr(work_task::Column::FailureReason, Expr::value(None::<String>))
            .col_expr(work_task::Column::LastError, Expr::value(None::<String>))
            .col_expr(work_task::Column::FinishedAt, Expr::value(None::<chrono::DateTime<Utc>>))
            .col_expr(work_task::Column::UpdatedAt, Expr::value(now))
            .filter(work_task::Column::Id.eq(head.id))
            .filter(work_task::Column::Status.eq(WorkTaskStatus::Todo))
            .filter(work_task::Column::DeletedAt.is_null())
            .exec(&txn)
            .await?;
        if res.rows_affected != 1 {
            // Someone moved the head (manual start, edit, delete) — retry with
            // the fresh head.
            txn.rollback().await?;
            continue;
        }
        if max_concurrent > 0 {
            let active = work_task::Entity::find()
                .filter(work_task::Column::DeletedAt.is_null())
                .filter(work_task::Column::FolderId.eq(folder_id))
                .filter(work_task::Column::Status.is_in([
                    WorkTaskStatus::Queued,
                    WorkTaskStatus::Running,
                    WorkTaskStatus::AwaitingInput,
                    WorkTaskStatus::Merging,
                ]))
                .count(&txn)
                .await?;
            if active > max_concurrent as u64 {
                txn.rollback().await?;
                return Ok(None);
            }
        }
        status_changed_event(
            &txn,
            head.id,
            "engine",
            Some(WorkTaskStatus::Todo),
            WorkTaskStatus::Queued,
            Some(serde_json::json!({ "auto": true })),
        )
        .await?;
        txn.commit().await?;
        return Ok(Some(head.id));
    }
}

/// canceled → todo ("requeue"): back to the board, worktree (if any) reused at
/// the next start.
pub async fn requeue_canceled(conn: &DatabaseConnection, id: i32) -> Result<bool, DbError> {
    let now = Utc::now();
    let txn = conn.begin().await?;
    let res = work_task::Entity::update_many()
        .col_expr(
            work_task::Column::Status,
            Expr::value(status_str(WorkTaskStatus::Todo)),
        )
        .col_expr(work_task::Column::FailureReason, Expr::value(None::<String>))
        .col_expr(work_task::Column::LastError, Expr::value(None::<String>))
        .col_expr(work_task::Column::PendingMerge, Expr::value(None::<String>))
        .col_expr(
            work_task::Column::ArchivedAt,
            Expr::value(None::<chrono::DateTime<Utc>>),
        )
        .col_expr(work_task::Column::FinishedAt, Expr::value(None::<chrono::DateTime<Utc>>))
        .col_expr(work_task::Column::UpdatedAt, Expr::value(now))
        .filter(work_task::Column::Id.eq(id))
        .filter(work_task::Column::Status.eq(WorkTaskStatus::Canceled))
        .filter(work_task::Column::DeletedAt.is_null())
        .exec(&txn)
        .await?;
    if res.rows_affected != 1 {
        txn.rollback().await?;
        return Ok(false);
    }
    status_changed_event(
        &txn,
        id,
        "user",
        Some(WorkTaskStatus::Canceled),
        WorkTaskStatus::Todo,
        None,
    )
    .await?;
    txn.commit().await?;
    Ok(true)
}

/// Record the minted worktree + branch/base coordinates (no status change).
pub async fn attach_worktree(
    conn: &DatabaseConnection,
    id: i32,
    worktree_folder_id: i32,
    base_branch: &str,
    base_sha: &str,
    work_branch: &str,
) -> Result<(), DbError> {
    work_task::Entity::update_many()
        .col_expr(
            work_task::Column::WorktreeFolderId,
            Expr::value(Some(worktree_folder_id)),
        )
        .col_expr(
            work_task::Column::BaseBranch,
            Expr::value(Some(base_branch.to_string())),
        )
        .col_expr(
            work_task::Column::BaseSha,
            Expr::value(Some(base_sha.to_string())),
        )
        .col_expr(
            work_task::Column::WorkBranch,
            Expr::value(Some(work_branch.to_string())),
        )
        .col_expr(work_task::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(work_task::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(())
}

/// queued → running for the given generation; binds conversation + connection.
pub async fn mark_running(
    conn: &DatabaseConnection,
    id: i32,
    run_seq: i32,
    conversation_id: i32,
    connection_id: &str,
) -> Result<bool, DbError> {
    let now = Utc::now();
    let txn = conn.begin().await?;
    let res = work_task::Entity::update_many()
        .col_expr(
            work_task::Column::Status,
            Expr::value(status_str(WorkTaskStatus::Running)),
        )
        .col_expr(
            work_task::Column::ConversationId,
            Expr::value(Some(conversation_id)),
        )
        .col_expr(
            work_task::Column::ConnectionId,
            Expr::value(Some(connection_id.to_string())),
        )
        .col_expr(work_task::Column::StartedAt, Expr::value(Some(now)))
        .col_expr(work_task::Column::UpdatedAt, Expr::value(now))
        .filter(work_task::Column::Id.eq(id))
        .filter(work_task::Column::Status.eq(WorkTaskStatus::Queued))
        .filter(work_task::Column::RunSeq.eq(run_seq))
        .filter(work_task::Column::DeletedAt.is_null())
        .exec(&txn)
        .await?;
    if res.rows_affected != 1 {
        txn.rollback().await?;
        return Ok(false);
    }
    status_changed_event(
        &txn,
        id,
        "engine",
        Some(WorkTaskStatus::Queued),
        WorkTaskStatus::Running,
        None,
    )
    .await?;
    txn.commit().await?;
    Ok(true)
}

/// Record the live connection/conversation of a MERGE generation. The status
/// stays `merging` for the whole agent turn; the CAS (merging + run_seq) makes
/// a concurrent settle or recovery win cleanly.
pub async fn mark_merging_live(
    conn: &DatabaseConnection,
    id: i32,
    run_seq: i32,
    conversation_id: i32,
    connection_id: &str,
) -> Result<bool, DbError> {
    let res = work_task::Entity::update_many()
        .col_expr(
            work_task::Column::ConversationId,
            Expr::value(Some(conversation_id)),
        )
        .col_expr(
            work_task::Column::ConnectionId,
            Expr::value(Some(connection_id.to_string())),
        )
        .col_expr(work_task::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(work_task::Column::Id.eq(id))
        .filter(work_task::Column::Status.eq(WorkTaskStatus::Merging))
        .filter(work_task::Column::RunSeq.eq(run_seq))
        .filter(work_task::Column::DeletedAt.is_null())
        .exec(conn)
        .await?;
    Ok(res.rows_affected == 1)
}

/// `from` (any of) → failed with a reason. `run_seq: Some(n)` guards
/// engine-driven failures against stale generations; `None` is used by the
/// boot/reconcile sweeps that own the whole DB.
pub async fn fail(
    conn: &DatabaseConnection,
    id: i32,
    from: &[WorkTaskStatus],
    run_seq: Option<i32>,
    reason: &str,
    error: Option<String>,
) -> Result<bool, DbError> {
    let now = Utc::now();
    let txn = conn.begin().await?;
    let mut update = work_task::Entity::update_many()
        .col_expr(
            work_task::Column::Status,
            Expr::value(status_str(WorkTaskStatus::Failed)),
        )
        .col_expr(
            work_task::Column::FailureReason,
            Expr::value(Some(reason.to_string())),
        )
        .col_expr(work_task::Column::LastError, Expr::value(error.clone()))
        .col_expr(work_task::Column::ConnectionId, Expr::value(None::<String>))
        // Any failure abandons a pending auto-remerge — the user restarts the
        // cycle explicitly.
        .col_expr(work_task::Column::PendingMerge, Expr::value(None::<String>))
        .col_expr(work_task::Column::SettledAt, Expr::value(Some(now)))
        .col_expr(work_task::Column::UpdatedAt, Expr::value(now))
        .filter(work_task::Column::Id.eq(id))
        .filter(work_task::Column::Status.is_in(from.iter().copied()))
        .filter(work_task::Column::DeletedAt.is_null());
    if let Some(seq) = run_seq {
        update = update.filter(work_task::Column::RunSeq.eq(seq));
    }
    let res = update.exec(&txn).await?;
    if res.rows_affected != 1 {
        txn.rollback().await?;
        return Ok(false);
    }
    status_changed_event(
        &txn,
        id,
        "engine",
        None,
        WorkTaskStatus::Failed,
        Some(serde_json::json!({ "reason": reason, "error": error })),
    )
    .await?;
    txn.commit().await?;
    Ok(true)
}

/// running/awaiting_input → review for the given generation. Captures the
/// agent's summary and the diff-stat snapshot; also writes a `diff_stat` event
/// when stats are present.
/// Record the agent's self-reported verdict (`task_complete` MCP tool) on the
/// current generation while it is still executing. `result_summary` is written
/// unconditionally (NULL when the report carried none), so a present verdict
/// always means the summary column reflects THIS generation's report — the
/// settle path relies on that to prefer it over the captured assistant text.
/// Same-transaction `agent_verdict` event.
pub async fn set_verdict(
    conn: &DatabaseConnection,
    id: i32,
    run_seq: i32,
    verdict: &str,
    summary: Option<&str>,
) -> Result<bool, DbError> {
    let now = Utc::now();
    let txn = conn.begin().await?;
    let res = work_task::Entity::update_many()
        .col_expr(
            work_task::Column::Verdict,
            Expr::value(Some(verdict.to_string())),
        )
        .col_expr(
            work_task::Column::ResultSummary,
            Expr::value(summary.map(str::to_string)),
        )
        .col_expr(work_task::Column::UpdatedAt, Expr::value(now))
        .filter(work_task::Column::Id.eq(id))
        .filter(work_task::Column::RunSeq.eq(run_seq))
        .filter(
            work_task::Column::Status
                .is_in([WorkTaskStatus::Running, WorkTaskStatus::AwaitingInput]),
        )
        .filter(work_task::Column::DeletedAt.is_null())
        .exec(&txn)
        .await?;
    if res.rows_affected != 1 {
        txn.rollback().await?;
        return Ok(false);
    }
    record_event(
        &txn,
        id,
        "agent_verdict",
        "agent",
        Some(serde_json::json!({ "verdict": verdict, "summary": summary })),
    )
    .await?;
    txn.commit().await?;
    Ok(true)
}

pub async fn settle_review(
    conn: &DatabaseConnection,
    id: i32,
    run_seq: i32,
    result_summary: Option<String>,
    stats: Option<(i32, i32, i32)>,
) -> Result<bool, DbError> {
    let now = Utc::now();
    let txn = conn.begin().await?;
    let res = work_task::Entity::update_many()
        .col_expr(
            work_task::Column::Status,
            Expr::value(status_str(WorkTaskStatus::Review)),
        )
        .col_expr(
            work_task::Column::ResultSummary,
            Expr::value(result_summary.clone()),
        )
        .col_expr(
            work_task::Column::FilesChanged,
            Expr::value(stats.map(|s| s.0)),
        )
        .col_expr(work_task::Column::Additions, Expr::value(stats.map(|s| s.1)))
        .col_expr(work_task::Column::Deletions, Expr::value(stats.map(|s| s.2)))
        .col_expr(work_task::Column::ConnectionId, Expr::value(None::<String>))
        // A fresh review starts with a fresh light; the preflight runner
        // rewrites it right after when one is configured.
        .col_expr(work_task::Column::Preflight, Expr::value(None::<String>))
        .col_expr(work_task::Column::SettledAt, Expr::value(Some(now)))
        .col_expr(work_task::Column::UpdatedAt, Expr::value(now))
        .filter(work_task::Column::Id.eq(id))
        .filter(
            work_task::Column::Status
                .is_in([WorkTaskStatus::Running, WorkTaskStatus::AwaitingInput]),
        )
        .filter(work_task::Column::RunSeq.eq(run_seq))
        .filter(work_task::Column::DeletedAt.is_null())
        .exec(&txn)
        .await?;
    if res.rows_affected != 1 {
        txn.rollback().await?;
        return Ok(false);
    }
    status_changed_event(&txn, id, "engine", None, WorkTaskStatus::Review, None).await?;
    if let Some((files, adds, dels)) = stats {
        record_event(
            &txn,
            id,
            "diff_stat",
            "engine",
            Some(serde_json::json!({
                "files_changed": files,
                "additions": adds,
                "deletions": dels,
            })),
        )
        .await?;
    }
    txn.commit().await?;
    Ok(true)
}

/// running ⇄ awaiting_input for the given generation.
pub async fn flip_awaiting(
    conn: &DatabaseConnection,
    id: i32,
    run_seq: i32,
    awaiting: bool,
) -> Result<bool, DbError> {
    let (from, to) = if awaiting {
        (WorkTaskStatus::Running, WorkTaskStatus::AwaitingInput)
    } else {
        (WorkTaskStatus::AwaitingInput, WorkTaskStatus::Running)
    };
    let now = Utc::now();
    let txn = conn.begin().await?;
    let res = work_task::Entity::update_many()
        .col_expr(work_task::Column::Status, Expr::value(status_str(to)))
        .col_expr(work_task::Column::UpdatedAt, Expr::value(now))
        .filter(work_task::Column::Id.eq(id))
        .filter(work_task::Column::Status.eq(from))
        .filter(work_task::Column::RunSeq.eq(run_seq))
        .filter(work_task::Column::DeletedAt.is_null())
        .exec(&txn)
        .await?;
    if res.rows_affected != 1 {
        txn.rollback().await?;
        return Ok(false);
    }
    status_changed_event(&txn, id, "engine", Some(from), to, None).await?;
    txn.commit().await?;
    Ok(true)
}

/// review → merging, persisting the merge intent in the same transaction (the
/// crash-recovery anchor). Also records a `merge_attempt` event.
pub async fn begin_merge(
    conn: &DatabaseConnection,
    id: i32,
    state: &WorkTaskMergeState,
) -> Result<Option<i32>, DbError> {
    let state_json = serde_json::to_string(state)
        .map_err(|e| DbError::Validation(format!("merge state not serializable: {e}")))?;
    let now = Utc::now();
    let txn = conn.begin().await?;
    let res = work_task::Entity::update_many()
        .col_expr(
            work_task::Column::Status,
            Expr::value(status_str(WorkTaskStatus::Merging)),
        )
        // The merge is a fresh agent generation: bump run_seq so stale events
        // of the settled run can't touch it, and clear the run-scoped fields.
        .col_expr(
            work_task::Column::RunSeq,
            Expr::col(work_task::Column::RunSeq).add(1),
        )
        .col_expr(work_task::Column::ConnectionId, Expr::value(None::<String>))
        .col_expr(work_task::Column::Verdict, Expr::value(None::<String>))
        .col_expr(work_task::Column::MergeState, Expr::value(Some(state_json)))
        .col_expr(work_task::Column::LastError, Expr::value(None::<String>))
        .col_expr(work_task::Column::UpdatedAt, Expr::value(now))
        .filter(work_task::Column::Id.eq(id))
        .filter(work_task::Column::Status.eq(WorkTaskStatus::Review))
        .filter(work_task::Column::DeletedAt.is_null())
        .exec(&txn)
        .await?;
    if res.rows_affected != 1 {
        txn.rollback().await?;
        return Ok(None);
    }
    let run_seq = work_task::Entity::find_by_id(id)
        .one(&txn)
        .await?
        .map(|m| m.run_seq)
        .ok_or_else(|| DbError::NotFound(format!("work task {id}")))?;
    record_event(
        &txn,
        id,
        "merge_attempt",
        "user",
        Some(serde_json::json!({
            "strategy": state.strategy,
            "pre_merge_head": state.pre_merge_head,
        })),
    )
    .await?;
    status_changed_event(
        &txn,
        id,
        "user",
        Some(WorkTaskStatus::Review),
        WorkTaskStatus::Merging,
        None,
    )
    .await?;
    txn.commit().await?;
    Ok(Some(run_seq))
}

/// merging → done. The ONLY writer of `done`; never rolls back. Used both by
/// the live merge path and by crash recovery back-filling a landed merge.
pub async fn merge_landed(
    conn: &DatabaseConnection,
    id: i32,
    merge_commit: &str,
) -> Result<bool, DbError> {
    let now = Utc::now();
    let txn = conn.begin().await?;
    let res = work_task::Entity::update_many()
        .col_expr(
            work_task::Column::Status,
            Expr::value(status_str(WorkTaskStatus::Done)),
        )
        .col_expr(
            work_task::Column::MergeCommit,
            Expr::value(Some(merge_commit.to_string())),
        )
        .col_expr(work_task::Column::FinishedAt, Expr::value(Some(now)))
        .col_expr(work_task::Column::UpdatedAt, Expr::value(now))
        .filter(work_task::Column::Id.eq(id))
        .filter(work_task::Column::Status.eq(WorkTaskStatus::Merging))
        .filter(work_task::Column::DeletedAt.is_null())
        .exec(&txn)
        .await?;
    if res.rows_affected != 1 {
        txn.rollback().await?;
        return Ok(false);
    }
    status_changed_event(
        &txn,
        id,
        "engine",
        Some(WorkTaskStatus::Merging),
        WorkTaskStatus::Done,
        Some(serde_json::json!({ "merge_commit": merge_commit })),
    )
    .await?;
    txn.commit().await?;
    Ok(true)
}

/// merging → review after a conflict / preflight failure / crash cleanup.
/// Clears the merge intent; records `merge_conflict` when files are known.
pub async fn merge_back_to_review(
    conn: &DatabaseConnection,
    id: i32,
    error: Option<String>,
    conflict_files: Option<Vec<String>>,
) -> Result<bool, DbError> {
    let now = Utc::now();
    let txn = conn.begin().await?;
    let res = work_task::Entity::update_many()
        .col_expr(
            work_task::Column::Status,
            Expr::value(status_str(WorkTaskStatus::Review)),
        )
        .col_expr(work_task::Column::MergeState, Expr::value(None::<String>))
        .col_expr(work_task::Column::LastError, Expr::value(error.clone()))
        .col_expr(work_task::Column::UpdatedAt, Expr::value(now))
        .filter(work_task::Column::Id.eq(id))
        .filter(work_task::Column::Status.eq(WorkTaskStatus::Merging))
        .filter(work_task::Column::DeletedAt.is_null())
        .exec(&txn)
        .await?;
    if res.rows_affected != 1 {
        txn.rollback().await?;
        return Ok(false);
    }
    if let Some(files) = conflict_files {
        record_event(
            &txn,
            id,
            "merge_conflict",
            "engine",
            Some(serde_json::json!({ "files": files })),
        )
        .await?;
    }
    status_changed_event(
        &txn,
        id,
        "engine",
        Some(WorkTaskStatus::Merging),
        WorkTaskStatus::Review,
        Some(serde_json::json!({ "error": error })),
    )
    .await?;
    txn.commit().await?;
    Ok(true)
}

/// Write the preflight light for the CURRENT review generation. Guarded on
/// review + run_seq so a slow command finishing after the task moved on is a
/// no-op. Records a `preflight_result` event for terminal statuses.
pub async fn set_preflight(
    conn: &DatabaseConnection,
    id: i32,
    run_seq: i32,
    preflight: &crate::models::WorkTaskPreflight,
) -> Result<bool, DbError> {
    let json = serde_json::to_string(preflight)
        .map_err(|e| DbError::Validation(format!("preflight not serializable: {e}")))?;
    let now = Utc::now();
    let txn = conn.begin().await?;
    let res = work_task::Entity::update_many()
        .col_expr(work_task::Column::Preflight, Expr::value(Some(json)))
        .col_expr(work_task::Column::UpdatedAt, Expr::value(now))
        .filter(work_task::Column::Id.eq(id))
        .filter(work_task::Column::Status.eq(WorkTaskStatus::Review))
        .filter(work_task::Column::RunSeq.eq(run_seq))
        .filter(work_task::Column::DeletedAt.is_null())
        .exec(&txn)
        .await?;
    if res.rows_affected != 1 {
        txn.rollback().await?;
        return Ok(false);
    }
    if preflight.status != "running" {
        record_event(
            &txn,
            id,
            "preflight_result",
            "engine",
            Some(serde_json::json!({
                "status": preflight.status,
                "command": preflight.command,
                "exit_code": preflight.exit_code,
            })),
        )
        .await?;
    }
    txn.commit().await?;
    Ok(true)
}

/// Archive / unarchive. Only terminal tasks (done / failed / canceled) can be
/// archived — active ones stay on the board by construction; unarchiving is
/// status-agnostic. Records the user action.
pub async fn set_archived(
    conn: &DatabaseConnection,
    id: i32,
    archived: bool,
) -> Result<bool, DbError> {
    let now = Utc::now();
    let txn = conn.begin().await?;
    let mut update = work_task::Entity::update_many()
        .col_expr(
            work_task::Column::ArchivedAt,
            Expr::value(archived.then_some(now)),
        )
        .col_expr(work_task::Column::UpdatedAt, Expr::value(now))
        .filter(work_task::Column::Id.eq(id))
        .filter(work_task::Column::DeletedAt.is_null());
    if archived {
        update = update
            .filter(work_task::Column::Status.is_in([
                WorkTaskStatus::Done,
                WorkTaskStatus::Failed,
                WorkTaskStatus::Canceled,
            ]))
            .filter(work_task::Column::ArchivedAt.is_null());
    } else {
        update = update.filter(work_task::Column::ArchivedAt.is_not_null());
    }
    let res = update.exec(&txn).await?;
    if res.rows_affected != 1 {
        txn.rollback().await?;
        return Ok(false);
    }
    record_event(
        &txn,
        id,
        "user_action",
        "user",
        Some(serde_json::json!({ "action": if archived { "archive" } else { "unarchive" } })),
    )
    .await?;
    txn.commit().await?;
    Ok(true)
}

/// Any non-terminal state EXCEPT merging → canceled. Returns whether the CAS
/// won (the engine tears the connection down only when it did).
pub async fn cancel(conn: &DatabaseConnection, id: i32) -> Result<bool, DbError> {
    let now = Utc::now();
    let txn = conn.begin().await?;
    let res = work_task::Entity::update_many()
        .col_expr(
            work_task::Column::Status,
            Expr::value(status_str(WorkTaskStatus::Canceled)),
        )
        .col_expr(work_task::Column::ConnectionId, Expr::value(None::<String>))
        // A cancel mid-repair abandons the auto-remerge; a later requeue must
        // not re-fire a stale merge.
        .col_expr(work_task::Column::PendingMerge, Expr::value(None::<String>))
        .col_expr(work_task::Column::FinishedAt, Expr::value(Some(now)))
        .col_expr(work_task::Column::UpdatedAt, Expr::value(now))
        .filter(work_task::Column::Id.eq(id))
        .filter(work_task::Column::Status.is_in([
            WorkTaskStatus::Todo,
            WorkTaskStatus::Queued,
            WorkTaskStatus::Running,
            WorkTaskStatus::AwaitingInput,
            WorkTaskStatus::Review,
            WorkTaskStatus::Failed,
        ]))
        .filter(work_task::Column::DeletedAt.is_null())
        .exec(&txn)
        .await?;
    if res.rows_affected != 1 {
        txn.rollback().await?;
        return Ok(false);
    }
    status_changed_event(&txn, id, "user", None, WorkTaskStatus::Canceled, None).await?;
    txn.commit().await?;
    Ok(true)
}

/// Flag / clear the worktree-cleanup outcome. Never touches `status` — a done
/// task with a failed cleanup stays done. Writes a `cleanup_failed` event when
/// flagging.
pub async fn set_cleanup_state(
    conn: &DatabaseConnection,
    id: i32,
    failed: bool,
    error: Option<String>,
) -> Result<(), DbError> {
    let now = Utc::now();
    let txn = conn.begin().await?;
    work_task::Entity::update_many()
        .col_expr(
            work_task::Column::CleanupState,
            Expr::value(if failed { Some("failed".to_string()) } else { None }),
        )
        .col_expr(work_task::Column::UpdatedAt, Expr::value(now))
        .filter(work_task::Column::Id.eq(id))
        .exec(&txn)
        .await?;
    if failed {
        record_event(
            &txn,
            id,
            "cleanup_failed",
            "engine",
            Some(serde_json::json!({ "error": error })),
        )
        .await?;
    }
    txn.commit().await?;
    Ok(())
}

/// Detach the (now removed) worktree from the task and clear any cleanup flag.
pub async fn clear_worktree(conn: &DatabaseConnection, id: i32) -> Result<(), DbError> {
    work_task::Entity::update_many()
        .col_expr(work_task::Column::WorktreeFolderId, Expr::value(None::<i32>))
        .col_expr(work_task::Column::CleanupState, Expr::value(None::<String>))
        .col_expr(work_task::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(work_task::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(())
}

/// Boot recovery: a fresh process has no live connections, so every
/// queued/running/awaiting_input task is an interruption → failed(interrupted)
/// (retry is idempotent and reuses the worktree). Merging tasks are NOT touched
/// here — the engine recovers them from git truth. Only sound while this
/// process provably owns the engine (the data-dir file lock).
pub async fn boot_reconcile_interrupted(conn: &DatabaseConnection) -> Result<u64, DbError> {
    let active = list_by_status(
        conn,
        &[
            WorkTaskStatus::Queued,
            WorkTaskStatus::Running,
            WorkTaskStatus::AwaitingInput,
        ],
    )
    .await?;
    let mut n = 0;
    for t in active {
        if fail(
            conn,
            t.id,
            &[
                WorkTaskStatus::Queued,
                WorkTaskStatus::Running,
                WorkTaskStatus::AwaitingInput,
            ],
            None,
            "interrupted",
            Some("interrupted by restart".to_string()),
        )
        .await?
        {
            n += 1;
        }
    }
    Ok(n)
}

// ── per-folder settings ─────────────────────────────────────────────────────

pub async fn settings_get(
    conn: &DatabaseConnection,
    folder_id: i32,
) -> Result<WorkTaskFolderSettings, DbError> {
    let row = work_task_settings::Entity::find()
        .filter(work_task_settings::Column::FolderId.eq(folder_id))
        .one(conn)
        .await?;
    Ok(row
        .and_then(|r| serde_json::from_str(&r.config).ok())
        .unwrap_or_default())
}

/// The folder's own row only — `None` when the folder never saved its own
/// settings (and thus follows the global row). This is what lets the settings
/// dialog distinguish "own settings" from the global fallback, which
/// `settings_get_effective` deliberately hides.
pub async fn settings_get_own(
    conn: &DatabaseConnection,
    folder_id: i32,
) -> Result<Option<WorkTaskFolderSettings>, DbError> {
    let row = work_task_settings::Entity::find()
        .filter(work_task_settings::Column::FolderId.eq(folder_id))
        .one(conn)
        .await?;
    Ok(row.and_then(|r| serde_json::from_str(&r.config).ok()))
}

/// Drop the folder's own settings row so it follows the global defaults
/// again. Idempotent — a folder without a row is left as-is.
pub async fn settings_delete(
    conn: &DatabaseConnection,
    folder_id: i32,
) -> Result<(), DbError> {
    work_task_settings::Entity::delete_many()
        .filter(work_task_settings::Column::FolderId.eq(folder_id))
        .exec(conn)
        .await?;
    Ok(())
}

/// Sentinel `folder_id` of the global-defaults settings row. Real folders
/// start at 1 (AUTOINCREMENT), so 0 can never collide.
pub const GLOBAL_SETTINGS_FOLDER_ID: i32 = 0;

/// Effective settings for a folder: the folder's own row wins wholesale; a
/// folder that never saved its own settings falls back to the global row
/// (`folder_id = 0`), then to the built-in defaults. Deliberately not a
/// field-by-field merge — one save detaches the folder from the global row
/// entirely, which keeps the behavior predictable.
pub async fn settings_get_effective(
    conn: &DatabaseConnection,
    folder_id: i32,
) -> Result<WorkTaskFolderSettings, DbError> {
    let own = work_task_settings::Entity::find()
        .filter(work_task_settings::Column::FolderId.eq(folder_id))
        .one(conn)
        .await?
        .and_then(|r| serde_json::from_str(&r.config).ok());
    if let Some(settings) = own {
        return Ok(settings);
    }
    settings_get(conn, GLOBAL_SETTINGS_FOLDER_ID).await
}

pub async fn settings_set(
    conn: &DatabaseConnection,
    folder_id: i32,
    settings: &WorkTaskFolderSettings,
) -> Result<(), DbError> {
    let config = serde_json::to_string(settings)
        .map_err(|e| DbError::Validation(format!("settings not serializable: {e}")))?;
    let now = Utc::now();
    let existing = work_task_settings::Entity::find()
        .filter(work_task_settings::Column::FolderId.eq(folder_id))
        .one(conn)
        .await?;
    match existing {
        Some(row) => {
            let mut active = row.into_active_model();
            active.config = Set(config);
            active.updated_at = Set(now);
            active.update(conn).await?;
        }
        None => {
            let active = work_task_settings::ActiveModel {
                id: NotSet,
                folder_id: Set(folder_id),
                config: Set(config),
                created_at: Set(now),
                updated_at: Set(now),
            };
            active.insert(conn).await?;
        }
    }
    Ok(())
}

// ── Templates ───────────────────────────────────────────────────────────────

fn to_template_info(m: work_task_template::Model) -> crate::models::WorkTaskTemplateInfo {
    crate::models::WorkTaskTemplateInfo {
        id: m.id,
        name: m.name,
        title: m.title,
        config: serde_json::from_str(&m.config).unwrap_or(serde_json::Value::Null),
        created_at: m.created_at,
        updated_at: m.updated_at,
    }
}

pub async fn template_list(
    conn: &DatabaseConnection,
) -> Result<Vec<crate::models::WorkTaskTemplateInfo>, DbError> {
    let rows = work_task_template::Entity::find()
        .order_by_asc(work_task_template::Column::Name)
        .order_by_asc(work_task_template::Column::Id)
        .all(conn)
        .await?;
    Ok(rows.into_iter().map(to_template_info).collect())
}

/// Upsert by exact name: saving under an existing template's name replaces its
/// title + config in place instead of accumulating duplicates.
pub async fn template_save(
    conn: &DatabaseConnection,
    draft: &crate::models::WorkTaskTemplateDraft,
) -> Result<crate::models::WorkTaskTemplateInfo, DbError> {
    let name = draft.name.trim();
    if name.is_empty() {
        return Err(DbError::Validation("template name is required".into()));
    }
    if draft.title.trim().is_empty() {
        return Err(DbError::Validation("template title is required".into()));
    }
    if !draft.config.is_object() {
        return Err(DbError::Validation("template config must be an object".into()));
    }
    let config = serde_json::to_string(&draft.config)
        .map_err(|e| DbError::Validation(format!("template config not serializable: {e}")))?;
    let now = Utc::now();
    let existing = work_task_template::Entity::find()
        .filter(work_task_template::Column::Name.eq(name))
        .one(conn)
        .await?;
    let model = match existing {
        Some(row) => {
            let mut active = row.into_active_model();
            active.title = Set(draft.title.trim().to_string());
            active.config = Set(config);
            active.updated_at = Set(now);
            active.update(conn).await?
        }
        None => {
            let active = work_task_template::ActiveModel {
                id: NotSet,
                name: Set(name.to_string()),
                title: Set(draft.title.trim().to_string()),
                config: Set(config),
                created_at: Set(now),
                updated_at: Set(now),
            };
            active.insert(conn).await?
        }
    };
    Ok(to_template_info(model))
}

pub async fn template_delete(conn: &DatabaseConnection, id: i32) -> Result<(), DbError> {
    work_task_template::Entity::delete_by_id(id).exec(conn).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_folder};

    fn draft(folder_id: i32, title: &str) -> WorkTaskDraft {
        WorkTaskDraft {
            folder_id,
            title: title.to_string(),
            config: serde_json::json!({
                "display_text": "do the thing",
                "prompt_blocks": [{ "type": "text", "text": "do the thing" }],
            }),
        }
    }

    #[tokio::test]
    async fn create_list_get_roundtrip_and_validation() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/wt-test").await;

        assert!(create(&db.conn, draft(folder_id, "")).await.is_err());
        let mut no_prompt = draft(folder_id, "x");
        no_prompt.config = serde_json::json!({ "display_text": "", "prompt_blocks": [] });
        assert!(create(&db.conn, no_prompt).await.is_err());

        let t = create(&db.conn, draft(folder_id, "fix login")).await.unwrap();
        assert_eq!(t.status, WorkTaskStatus::Todo);
        assert_eq!(t.run_seq, 0);

        let listed = list(&db.conn, Some(folder_id)).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(get(&db.conn, t.id).await.unwrap().id, t.id);

        // The created event landed in the same transaction.
        let events = list_events(&db.conn, t.id, 100).await.unwrap();
        assert_eq!(events[0].kind, "created");
    }

    #[tokio::test]
    async fn claim_cas_is_exclusive_and_bumps_run_seq() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/wt-claim").await;
        let t = create(&db.conn, draft(folder_id, "t")).await.unwrap();

        let seq = claim_for_run(&db.conn, t.id, WorkTaskStatus::Todo, "user")
            .await
            .unwrap();
        assert_eq!(seq, Some(1));
        // Second claim of the same todo loses (status is now queued).
        assert_eq!(
            claim_for_run(&db.conn, t.id, WorkTaskStatus::Todo, "user")
                .await
                .unwrap(),
            None
        );
        assert_eq!(get(&db.conn, t.id).await.unwrap().status, WorkTaskStatus::Queued);
    }

    #[tokio::test]
    async fn auto_claim_counts_queued_against_the_budget() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/wt-auto-budget").await;

        // Budget 2, spent by one running + one manually queued task.
        let running = create(&db.conn, draft(folder_id, "running")).await.unwrap();
        let seq = claim_for_run(&db.conn, running.id, WorkTaskStatus::Todo, "user")
            .await
            .unwrap()
            .unwrap();
        assert!(mark_running(&db.conn, running.id, seq, 1, "c1").await.unwrap());
        let queued = create(&db.conn, draft(folder_id, "queued")).await.unwrap();
        claim_for_run(&db.conn, queued.id, WorkTaskStatus::Todo, "user")
            .await
            .unwrap()
            .unwrap();
        let todo = create(&db.conn, draft(folder_id, "todo")).await.unwrap();

        assert_eq!(auto_claim_next(&db.conn, folder_id, 2).await.unwrap(), None);
        assert_eq!(
            get(&db.conn, todo.id).await.unwrap().status,
            WorkTaskStatus::Todo
        );

        // The running task settles → a slot frees → the head is claimed with a
        // fresh generation and an engine-actor event.
        assert!(settle_review(&db.conn, running.id, seq, None, None).await.unwrap());
        assert_eq!(
            auto_claim_next(&db.conn, folder_id, 2).await.unwrap(),
            Some(todo.id)
        );
        let claimed = get(&db.conn, todo.id).await.unwrap();
        assert_eq!(claimed.status, WorkTaskStatus::Queued);
        assert_eq!(claimed.run_seq, 1);
        let events = list_events(&db.conn, todo.id, 10).await.unwrap();
        assert!(events
            .iter()
            .any(|e| e.kind == "status_changed" && e.actor == "engine"));

        // Budget full again; nothing left to claim either way.
        assert_eq!(auto_claim_next(&db.conn, folder_id, 2).await.unwrap(), None);
    }

    #[tokio::test]
    async fn auto_claim_drains_in_board_order_and_zero_is_unlimited() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/wt-auto-order").await;
        let a = create(&db.conn, draft(folder_id, "a")).await.unwrap();
        let b = create(&db.conn, draft(folder_id, "b")).await.unwrap();
        let c = create(&db.conn, draft(folder_id, "c")).await.unwrap();

        assert_eq!(auto_claim_next(&db.conn, folder_id, 2).await.unwrap(), Some(a.id));
        assert_eq!(auto_claim_next(&db.conn, folder_id, 2).await.unwrap(), Some(b.id));
        // Two queued spend the budget; c stays visible in todo.
        assert_eq!(auto_claim_next(&db.conn, folder_id, 2).await.unwrap(), None);
        assert_eq!(get(&db.conn, c.id).await.unwrap().status, WorkTaskStatus::Todo);
        // 0 = unlimited.
        assert_eq!(auto_claim_next(&db.conn, folder_id, 0).await.unwrap(), Some(c.id));
        assert_eq!(auto_claim_next(&db.conn, folder_id, 0).await.unwrap(), None);
    }

    #[tokio::test]
    async fn agent_verdict_is_generation_guarded_and_cleared_on_claim() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/wt-verdict").await;
        let t = create(&db.conn, draft(folder_id, "t")).await.unwrap();
        let seq = claim_for_run(&db.conn, t.id, WorkTaskStatus::Todo, "user")
            .await
            .unwrap()
            .unwrap();
        assert!(mark_running(&db.conn, t.id, seq, 1, "c1").await.unwrap());

        // Wrong generation → rejected; current one records verdict + summary
        // (+ the agent_verdict event).
        assert!(!set_verdict(&db.conn, t.id, seq + 1, "success", None).await.unwrap());
        assert!(
            set_verdict(&db.conn, t.id, seq, "needs_review", Some("check the tests"))
                .await
                .unwrap()
        );
        let m = get_model(&db.conn, t.id).await.unwrap();
        assert_eq!(m.verdict.as_deref(), Some("needs_review"));
        assert_eq!(m.result_summary.as_deref(), Some("check the tests"));
        let events = list_events(&db.conn, t.id, 20).await.unwrap();
        assert!(events.iter().any(|e| e.kind == "agent_verdict"));

        // Settled tasks reject further reports; the next claim (a return from
        // review) invalidates the stale verdict.
        assert!(settle_review(&db.conn, t.id, seq, None, None).await.unwrap());
        assert!(!set_verdict(&db.conn, t.id, seq, "success", None).await.unwrap());
        claim_for_run(&db.conn, t.id, WorkTaskStatus::Review, "user")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(get_model(&db.conn, t.id).await.unwrap().verdict, None);
    }

    #[tokio::test]
    async fn stale_generation_events_are_no_ops() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/wt-stale").await;
        let t = create(&db.conn, draft(folder_id, "t")).await.unwrap();
        let seq = claim_for_run(&db.conn, t.id, WorkTaskStatus::Todo, "user")
            .await
            .unwrap()
            .unwrap();
        assert!(mark_running(&db.conn, t.id, seq, 1, "conn-1").await.unwrap());

        // User cancels; a late TurnComplete for the old generation must be a
        // zero-side-effect no-op (the cancel-late-TurnComplete race).
        assert!(cancel(&db.conn, t.id).await.unwrap());
        assert!(!settle_review(&db.conn, t.id, seq, None, None).await.unwrap());
        assert!(!flip_awaiting(&db.conn, t.id, seq, true).await.unwrap());
        assert!(!fail(
            &db.conn,
            t.id,
            &[WorkTaskStatus::Running],
            Some(seq),
            "agent_error",
            None
        )
        .await
        .unwrap());
        assert_eq!(
            get(&db.conn, t.id).await.unwrap().status,
            WorkTaskStatus::Canceled
        );

        // Requeue resurrects it; the next claim bumps the generation.
        assert!(requeue_canceled(&db.conn, t.id).await.unwrap());
        let seq2 = claim_for_run(&db.conn, t.id, WorkTaskStatus::Todo, "user")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(seq2, seq + 1);
    }

    #[tokio::test]
    async fn merge_lifecycle_is_cas_guarded_and_done_never_rolls_back() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/wt-merge").await;
        let t = create(&db.conn, draft(folder_id, "t")).await.unwrap();
        let seq = claim_for_run(&db.conn, t.id, WorkTaskStatus::Todo, "user")
            .await
            .unwrap()
            .unwrap();
        assert!(mark_running(&db.conn, t.id, seq, 1, "conn-1").await.unwrap());
        assert!(settle_review(&db.conn, t.id, seq, Some("done".into()), Some((2, 10, 3)))
            .await
            .unwrap());

        let state = WorkTaskMergeState {
            pre_merge_head: "abc123".into(),
            message: "feat: t".into(),
            strategy: "squash".into(),
            delete_worktree: true,
            auto_message: false,
        };
        // The merge is a fresh agent generation: begin bumps run_seq and
        // clears the run-scoped fields.
        let merge_seq = begin_merge(&db.conn, t.id, &state).await.unwrap().unwrap();
        assert_eq!(merge_seq, seq + 1);
        let row = get_model(&db.conn, t.id).await.unwrap();
        assert!(row.connection_id.is_none());
        assert!(row.verdict.is_none());
        // Double begin loses (already merging) — merge idempotency.
        assert!(begin_merge(&db.conn, t.id, &state).await.unwrap().is_none());
        // Cancel is refused while merging.
        assert!(!cancel(&db.conn, t.id).await.unwrap());

        assert!(merge_landed(&db.conn, t.id, "def456").await.unwrap());
        // A second landing (event vs recovery race) is a no-op.
        assert!(!merge_landed(&db.conn, t.id, "zzz").await.unwrap());
        // And nothing can pull a done task back to review.
        assert!(!merge_back_to_review(&db.conn, t.id, None, None).await.unwrap());

        let got = get(&db.conn, t.id).await.unwrap();
        assert_eq!(got.status, WorkTaskStatus::Done);
        assert_eq!(got.merge_commit.as_deref(), Some("def456"));

        // Cleanup failure keeps done, only flags cleanup_state.
        set_cleanup_state(&db.conn, t.id, true, Some("worktree remove failed".into()))
            .await
            .unwrap();
        let got = get(&db.conn, t.id).await.unwrap();
        assert_eq!(got.status, WorkTaskStatus::Done);
        assert_eq!(got.cleanup_state.as_deref(), Some("failed"));
    }

    #[tokio::test]
    async fn merge_conflict_returns_to_review() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/wt-conflict").await;
        let t = create(&db.conn, draft(folder_id, "t")).await.unwrap();
        let seq = claim_for_run(&db.conn, t.id, WorkTaskStatus::Todo, "user")
            .await
            .unwrap()
            .unwrap();
        assert!(mark_running(&db.conn, t.id, seq, 1, "c").await.unwrap());
        assert!(settle_review(&db.conn, t.id, seq, None, None).await.unwrap());
        let state = WorkTaskMergeState {
            pre_merge_head: "abc".into(),
            message: "m".into(),
            strategy: "squash".into(),
            delete_worktree: false,
            auto_message: false,
        };
        assert!(begin_merge(&db.conn, t.id, &state).await.unwrap().is_some());
        assert!(merge_back_to_review(
            &db.conn,
            t.id,
            Some("conflict".into()),
            Some(vec!["a.rs".into()])
        )
        .await
        .unwrap());
        let got = get(&db.conn, t.id).await.unwrap();
        assert_eq!(got.status, WorkTaskStatus::Review);
        assert_eq!(got.last_error.as_deref(), Some("conflict"));
        let events = list_events(&db.conn, t.id, 100).await.unwrap();
        assert!(events.iter().any(|e| e.kind == "merge_conflict"));
    }

    #[tokio::test]
    async fn boot_reconcile_interrupts_active_but_not_merging() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/wt-boot").await;

        let queued = create(&db.conn, draft(folder_id, "q")).await.unwrap();
        claim_for_run(&db.conn, queued.id, WorkTaskStatus::Todo, "user")
            .await
            .unwrap();

        let running = create(&db.conn, draft(folder_id, "r")).await.unwrap();
        let seq = claim_for_run(&db.conn, running.id, WorkTaskStatus::Todo, "user")
            .await
            .unwrap()
            .unwrap();
        mark_running(&db.conn, running.id, seq, 1, "c").await.unwrap();

        let merging = create(&db.conn, draft(folder_id, "m")).await.unwrap();
        let seq = claim_for_run(&db.conn, merging.id, WorkTaskStatus::Todo, "user")
            .await
            .unwrap()
            .unwrap();
        mark_running(&db.conn, merging.id, seq, 2, "c2").await.unwrap();
        settle_review(&db.conn, merging.id, seq, None, None).await.unwrap();
        begin_merge(
            &db.conn,
            merging.id,
            &WorkTaskMergeState {
                pre_merge_head: "abc".into(),
                message: "m".into(),
                strategy: "squash".into(),
                delete_worktree: false,
                auto_message: false,
            },
        )
        .await
        .unwrap();

        assert_eq!(boot_reconcile_interrupted(&db.conn).await.unwrap(), 2);
        // Idempotent: a second sweep finds nothing.
        assert_eq!(boot_reconcile_interrupted(&db.conn).await.unwrap(), 0);

        let q = get(&db.conn, queued.id).await.unwrap();
        assert_eq!(q.status, WorkTaskStatus::Failed);
        assert_eq!(q.failure_reason.as_deref(), Some("interrupted"));
        // The interrupted queued task retries idempotently: failed → queued.
        assert!(claim_for_run(&db.conn, queued.id, WorkTaskStatus::Failed, "user")
            .await
            .unwrap()
            .is_some());

        // Merging is exempt — its recovery goes through git truth.
        assert_eq!(
            get(&db.conn, merging.id).await.unwrap().status,
            WorkTaskStatus::Merging
        );
    }

    #[tokio::test]
    async fn counts_and_settings_roundtrip() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/wt-counts").await;
        let t = create(&db.conn, draft(folder_id, "t")).await.unwrap();
        assert_eq!(attention_count(&db.conn).await.unwrap(), 0);
        let seq = claim_for_run(&db.conn, t.id, WorkTaskStatus::Todo, "user")
            .await
            .unwrap()
            .unwrap();
        mark_running(&db.conn, t.id, seq, 1, "c").await.unwrap();
        assert_eq!(active_launched_count(&db.conn, folder_id).await.unwrap(), 1);
        settle_review(&db.conn, t.id, seq, None, None).await.unwrap();
        assert_eq!(attention_count(&db.conn).await.unwrap(), 1);
        assert_eq!(active_launched_count(&db.conn, folder_id).await.unwrap(), 0);

        // Settings default → save → read back.
        let s = settings_get(&db.conn, folder_id).await.unwrap();
        assert_eq!(s.max_concurrent, 2);
        assert!(s.delete_worktree_default);
        assert!(!s.auto_process);
        let mut s2 = s;
        s2.max_concurrent = 0;
        s2.merge_strategy = "merge".into();
        settings_set(&db.conn, folder_id, &s2).await.unwrap();
        let s3 = settings_get(&db.conn, folder_id).await.unwrap();
        assert_eq!(s3.max_concurrent, 0);
        assert_eq!(s3.merge_strategy, "merge");
    }

    #[tokio::test]
    async fn effective_settings_fall_back_to_the_global_row_wholesale() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/wt-global").await;

        // No rows anywhere → built-in defaults.
        let s = settings_get_effective(&db.conn, folder_id).await.unwrap();
        assert_eq!(s.max_concurrent, 2);

        // A global row applies to folders without their own settings.
        let global = WorkTaskFolderSettings {
            max_concurrent: 5,
            init_command: Some("pnpm install".into()),
            ..Default::default()
        };
        settings_set(&db.conn, GLOBAL_SETTINGS_FOLDER_ID, &global)
            .await
            .unwrap();
        let s = settings_get_effective(&db.conn, folder_id).await.unwrap();
        assert_eq!(s.max_concurrent, 5);
        assert_eq!(s.init_command.as_deref(), Some("pnpm install"));
        // The raw read is untouched by the fallback.
        assert_eq!(settings_get(&db.conn, folder_id).await.unwrap().max_concurrent, 2);

        // Saving the folder's own settings detaches it entirely — no
        // field-by-field merge.
        let own = WorkTaskFolderSettings {
            max_concurrent: 1,
            ..Default::default()
        };
        settings_set(&db.conn, folder_id, &own).await.unwrap();
        let s = settings_get_effective(&db.conn, folder_id).await.unwrap();
        assert_eq!(s.max_concurrent, 1);
        assert!(s.init_command.is_none());
    }

    #[tokio::test]
    async fn folders_with_todos_lists_distinct_live_folders() {
        let db = fresh_in_memory_db().await;
        let f1 = seed_folder(&db, "/tmp/wt-todos-1").await;
        let f2 = seed_folder(&db, "/tmp/wt-todos-2").await;
        create(&db.conn, draft(f1, "a")).await.unwrap();
        create(&db.conn, draft(f1, "b")).await.unwrap();
        let started = create(&db.conn, draft(f2, "c")).await.unwrap();
        assert_eq!(folders_with_todos(&db.conn).await.unwrap(), vec![f1, f2]);
        // A folder whose only task left todo drops out.
        claim_for_run(&db.conn, started.id, WorkTaskStatus::Todo, "user")
            .await
            .unwrap();
        assert_eq!(folders_with_todos(&db.conn).await.unwrap(), vec![f1]);
    }

    #[tokio::test]
    async fn delete_rules() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/wt-del").await;
        let t = create(&db.conn, draft(folder_id, "t")).await.unwrap();
        soft_delete(&db.conn, t.id).await.unwrap();
        assert!(get(&db.conn, t.id).await.is_err());
        assert!(list(&db.conn, Some(folder_id)).await.unwrap().is_empty());
        // Double delete errors cleanly.
        assert!(soft_delete(&db.conn, t.id).await.is_err());
    }

    /// Drive a task to review and return its current run_seq.
    async fn to_review(db: &crate::db::AppDatabase, id: i32) -> i32 {
        let seq = claim_for_run(&db.conn, id, WorkTaskStatus::Todo, "user")
            .await
            .unwrap()
            .unwrap();
        assert!(mark_running(&db.conn, id, seq, 1, "c").await.unwrap());
        assert!(settle_review(&db.conn, id, seq, None, None).await.unwrap());
        seq
    }

    #[tokio::test]
    async fn preflight_is_generation_guarded_and_reset_by_claim_and_settle() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/wt-preflight").await;
        let t = create(&db.conn, draft(folder_id, "t")).await.unwrap();
        let seq = to_review(&db, t.id).await;

        let mut light = crate::models::WorkTaskPreflight {
            status: "running".into(),
            command: "tests".into(),
            exit_code: None,
            output_tail: None,
        };
        // Stale generation / wrong status writes are no-ops.
        assert!(!set_preflight(&db.conn, t.id, seq + 1, &light).await.unwrap());
        assert!(set_preflight(&db.conn, t.id, seq, &light).await.unwrap());
        light.status = "failed".into();
        light.exit_code = Some(2);
        light.output_tail = Some("boom".into());
        assert!(set_preflight(&db.conn, t.id, seq, &light).await.unwrap());
        let info = get(&db.conn, t.id).await.unwrap();
        assert_eq!(
            info.preflight.as_ref().and_then(|p| p.get("status")).and_then(|s| s.as_str()),
            Some("failed")
        );
        let events = list_events(&db.conn, t.id, 100).await.unwrap();
        assert!(events.iter().any(|e| e.kind == "preflight_result"));

        // A return claim wipes the stale light; the next settle starts clean
        // (and a slow old-generation finish can no longer write).
        let seq2 = claim_for_run(&db.conn, t.id, WorkTaskStatus::Review, "user")
            .await
            .unwrap()
            .unwrap();
        assert!(get_model(&db.conn, t.id).await.unwrap().preflight.is_none());
        assert!(mark_running(&db.conn, t.id, seq2, 1, "c2").await.unwrap());
        assert!(settle_review(&db.conn, t.id, seq2, None, None).await.unwrap());
        assert!(!set_preflight(&db.conn, t.id, seq, &light).await.unwrap());
        assert!(get_model(&db.conn, t.id).await.unwrap().preflight.is_none());
    }

    #[tokio::test]
    async fn archive_is_terminal_only_and_resurrection_unarchives() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/wt-archive").await;
        let t = create(&db.conn, draft(folder_id, "t")).await.unwrap();

        // Active tasks cannot be archived.
        assert!(!set_archived(&db.conn, t.id, true).await.unwrap());

        // failed → archived leaves the attention badge…
        let seq = claim_for_run(&db.conn, t.id, WorkTaskStatus::Todo, "user")
            .await
            .unwrap()
            .unwrap();
        assert!(mark_running(&db.conn, t.id, seq, 1, "c").await.unwrap());
        assert!(fail(
            &db.conn,
            t.id,
            &[WorkTaskStatus::Running],
            Some(seq),
            "agent_error",
            None
        )
        .await
        .unwrap());
        assert_eq!(attention_count(&db.conn).await.unwrap(), 1);
        assert!(set_archived(&db.conn, t.id, true).await.unwrap());
        assert!(!set_archived(&db.conn, t.id, true).await.unwrap()); // already archived
        assert_eq!(attention_count(&db.conn).await.unwrap(), 0);
        assert!(get(&db.conn, t.id).await.unwrap().archived_at.is_some());

        // …a retry claim resurrects it out of the archive…
        assert!(claim_for_run(&db.conn, t.id, WorkTaskStatus::Failed, "user")
            .await
            .unwrap()
            .is_some());
        assert!(get(&db.conn, t.id).await.unwrap().archived_at.is_none());

        // …and so does requeueing an archived canceled task.
        assert!(cancel(&db.conn, t.id).await.unwrap());
        assert!(set_archived(&db.conn, t.id, true).await.unwrap());
        assert!(requeue_canceled(&db.conn, t.id).await.unwrap());
        let row = get(&db.conn, t.id).await.unwrap();
        assert_eq!(row.status, WorkTaskStatus::Todo);
        assert!(row.archived_at.is_none());

        // Explicit unarchive requires an archived row.
        assert!(!set_archived(&db.conn, t.id, false).await.unwrap());
    }

    #[tokio::test]
    async fn template_save_upserts_by_name() {
        let db = fresh_in_memory_db().await;
        let d = |name: &str, title: &str| crate::models::WorkTaskTemplateDraft {
            name: name.to_string(),
            title: title.to_string(),
            config: serde_json::json!({ "display_text": title, "prompt_blocks": [] }),
        };

        let a = template_save(&db.conn, &d("Release", "cut a release")).await.unwrap();
        template_save(&db.conn, &d("Audit", "audit deps")).await.unwrap();
        // Same name replaces in place instead of duplicating.
        let a2 = template_save(&db.conn, &d("Release", "cut a patch release"))
            .await
            .unwrap();
        assert_eq!(a2.id, a.id);

        let listed = template_list(&db.conn).await.unwrap();
        assert_eq!(
            listed.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
            vec!["Audit", "Release"],
            "name-ordered"
        );
        assert_eq!(listed[1].title, "cut a patch release");

        assert!(template_save(&db.conn, &d("  ", "x")).await.is_err());
        template_delete(&db.conn, a.id).await.unwrap();
        assert_eq!(template_list(&db.conn).await.unwrap().len(), 1);
    }
}
