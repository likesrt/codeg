//! Work-task execution engine: drives the manual pipeline
//! `todo → queued → running ⇄ awaiting_input → review → merging → done`.
//!
//! Structure mirrors `automation::engine` (single per-process engine elected by
//! an exclusive data-dir file lock; a `tokio::select!` loop over the internal
//! event bus + a reconcile tick), with three task-specific additions:
//! - **run_seq generations**: every launch claims a new `run_seq`; events are
//!   matched on `(connection_id, run_seq)` and settle through CAS updates, so a
//!   cancel racing a late `TurnComplete` is a zero-side-effect no-op.
//! - **backend-driven awaiting_input**: the engine subscribes to
//!   Question/Permission/PlanApproval request+resolve events (the frontend has
//!   no global pending-question channel for unopened conversations) and flips
//!   `running ⇄ awaiting_input` from an outstanding-request-id set.
//! - **two-stage merge with persisted intent**: stage A merges base INTO the
//!   worktree (conflicts always land there); stage B lands on the base branch
//!   in the project folder under a per-folder git mutex, with the merge intent
//!   persisted before execution so crash recovery can replay git truth.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use sea_orm::{ActiveModelTrait, EntityTrait, IntoActiveModel, Set};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::Mutex;
use tokio::time::MissedTickBehavior;

use crate::acp::manager::ConnectionManager;
use crate::acp::types::{AcpEvent, EventEnvelope, PromptInputBlock};
use crate::acp::work_task_tools::{TaskReportAck, WorkTaskToolAccess};
use crate::acp::InternalEventBus;
use crate::commands::acp::{build_session_runtime_env, verify_agent_installed};
use crate::commands::conversations::{create_conversation_core, emit_conversation_upsert};
use crate::commands::folders::{
    emit_folder_upsert, get_folder_core, git_worktree_add, open_worktree_folder_core,
    resolve_git_head,
};
use crate::db::entities::conversation::{self, ConversationStatus};
use crate::db::entities::work_task::WorkTaskStatus;
use crate::db::entities::{folder, folder_command};
use crate::db::service::{conversation_service, tab_service, work_task_service};
use crate::db::AppDatabase;
use crate::logging::throttle::{LagLogThrottle, LAG_LOG_WINDOW};
use crate::models::{
    AgentType, WorkTaskConfig, WorkTaskFolderSettings, WorkTaskMergeState,
    WorkTaskPreflight,
};
use crate::web::event_bridge::{
    emit_event, EventEmitter, WorkTaskChange, WORK_TASK_CHANGED_EVENT,
};
use crate::work_task::git as task_git;

/// Reconcile sweep cadence.
const RECONCILE_INTERVAL_SECS: u64 = 30;

/// Cap on the preflight output tail persisted with a red light.
const PREFLIGHT_TAIL_CHARS: usize = 4000;

static ENGINE: OnceLock<Arc<TaskEngine>> = OnceLock::new();

/// The process-global engine, set once at boot by [`build_task_engine`]. Read
/// by the start/cancel/merge/cleanup commands.
pub fn engine() -> Option<Arc<TaskEngine>> {
    ENGINE.get().cloned()
}

pub struct TaskEngine {
    db: AppDatabase,
    manager: ConnectionManager,
    emitter: EventEmitter,
    bus: Arc<InternalEventBus>,
    data_dir: PathBuf,
    /// Live runs: `connection_id -> (task_id, run_seq)` — the only way events
    /// keyed by connection_id map back to a task generation. Lost on restart
    /// (boot reconcile covers that).
    index: Arc<Mutex<HashMap<String, (i32, i32)>>>,
    /// Outstanding blocking requests per task (`"q:<id>"`, `"p:<id>"`,
    /// `"a:<id>"` — namespaced so the three id spaces can't collide). Non-empty
    /// set ⇔ awaiting_input.
    awaiting: Arc<Mutex<HashMap<i32, HashSet<String>>>>,
    /// Tasks currently being launched (queued in DB but owned by an in-flight
    /// launch), mapped to their folder so the pump's concurrency accounting
    /// stays per-folder. Keeps the pump from double-launching and reconcile
    /// from re-claiming them.
    launching: Arc<Mutex<HashMap<i32, i32>>>,
    /// Tasks whose merge/cleanup is executing in THIS process — the reconcile
    /// tick must not run crash recovery against them.
    merging: Arc<Mutex<HashSet<i32>>>,
    /// Per-task lock serializing launch vs cancel teardown (same role as the
    /// automation engine's fire lock).
    task_locks: Arc<Mutex<HashMap<i32, Arc<Mutex<()>>>>>,
    /// Per-project-folder git mutex: merge and worktree cleanup serialize here.
    folder_locks: Arc<Mutex<HashMap<i32, Arc<Mutex<()>>>>>,
    /// Per-folder pump lock so concurrent pumps can't over-launch past
    /// max_concurrent.
    pump_locks: Arc<Mutex<HashMap<i32, Arc<Mutex<()>>>>>,
    /// Held for the engine's lifetime: exclusive advisory lock on
    /// `<db>.tasks.lock`. Its existence proves this process is the sole task
    /// engine on the DB — the precondition for the destructive boot reconcile.
    _engine_lock: std::fs::File,
}

/// Build the engine and publish it to the process global. Fails closed like the
/// automation engine: `None` unless this process holds the exclusive task lock.
pub fn build_task_engine(
    db: AppDatabase,
    manager: ConnectionManager,
    emitter: EventEmitter,
    bus: Arc<InternalEventBus>,
    data_dir: PathBuf,
) -> Option<Arc<TaskEngine>> {
    let engine_lock = match acquire_engine_ownership(&data_dir) {
        Ownership::Exclusive(file) => file,
        Ownership::Taken => {
            tracing::info!(
                "[work_task] another codeg process owns the task engine for {}; \
                 this process will not drive tasks",
                data_dir.display()
            );
            return None;
        }
        Ownership::Unavailable => {
            tracing::warn!(
                "[work_task] could not establish the task engine lock for {}; \
                 tasks are disabled in this process",
                data_dir.display()
            );
            return None;
        }
    };
    let engine = Arc::new(TaskEngine {
        db,
        manager,
        emitter,
        bus,
        data_dir,
        index: Arc::new(Mutex::new(HashMap::new())),
        awaiting: Arc::new(Mutex::new(HashMap::new())),
        launching: Arc::new(Mutex::new(HashMap::new())),
        merging: Arc::new(Mutex::new(HashSet::new())),
        task_locks: Arc::new(Mutex::new(HashMap::new())),
        folder_locks: Arc::new(Mutex::new(HashMap::new())),
        pump_locks: Arc::new(Mutex::new(HashMap::new())),
        _engine_lock: engine_lock,
    });
    let _ = ENGINE.set(engine.clone());
    Some(engine)
}

enum Ownership {
    Exclusive(std::fs::File),
    Taken,
    Unavailable,
}

/// `<db-file>.tasks.lock` — sibling of the automation engine's `<db>.lock`, so
/// the two engines elect independently but both contend exactly when the DB is
/// shared.
fn engine_lock_path(data_dir: &Path) -> PathBuf {
    data_dir.join(format!("{}.tasks.lock", crate::db::database_file_name()))
}

fn acquire_engine_ownership(data_dir: &Path) -> Ownership {
    let path = engine_lock_path(data_dir);
    let file = match std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
    {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!("[work_task] engine lock open failed: {e}");
            return Ownership::Unavailable;
        }
    };
    match file.try_lock() {
        Ok(()) => Ownership::Exclusive(file),
        Err(std::fs::TryLockError::WouldBlock) => Ownership::Taken,
        Err(std::fs::TryLockError::Error(e)) => {
            tracing::warn!("[work_task] engine lock failed: {e}");
            Ownership::Unavailable
        }
    }
}

/// Long-running driver: boot recovery, then a select loop over the event bus +
/// the reconcile tick. Spawn once per process in each boot path.
pub async fn run_task_engine(engine: Arc<TaskEngine>) {
    // Boot recovery: no connections survive a restart, so queued / running /
    // awaiting_input are interruptions → failed(interrupted); retry is
    // idempotent (the worktree is reused). merging is exempt — it recovers
    // from git truth below, never from connection liveness.
    match work_task_service::boot_reconcile_interrupted(&engine.db.conn).await {
        Ok(n) if n > 0 => {
            tracing::info!("[work_task] boot reconcile failed {n} interrupted task(s)");
            engine.emit_changed_all();
        }
        Ok(_) => {}
        Err(e) => tracing::warn!("[work_task] boot reconcile error: {e}"),
    }
    match work_task_service::list_by_status(&engine.db.conn, &[WorkTaskStatus::Merging]).await {
        Ok(rows) => {
            for row in rows {
                engine.recover_merging(row.id).await;
            }
        }
        Err(e) => tracing::warn!("[work_task] boot merging scan error: {e}"),
    }

    let mut rx = engine.bus.subscribe();
    let mut reconcile = {
        let mut i = tokio::time::interval(Duration::from_secs(RECONCILE_INTERVAL_SECS));
        i.set_missed_tick_behavior(MissedTickBehavior::Delay);
        i
    };
    let mut lag_throttle = LagLogThrottle::new(LAG_LOG_WINDOW);

    loop {
        tokio::select! {
            ev = rx.recv() => match ev {
                Ok(env) => engine.on_event(&env).await,
                Err(RecvError::Lagged(n)) => {
                    if let Some(s) = lag_throttle.record(n) {
                        tracing::warn!(
                            "[work_task] event bus lagged: dropped {} events across \
                             {} occurrence(s) in the last {}s; reconcile will recover",
                            s.dropped,
                            s.occurrences,
                            LAG_LOG_WINDOW.as_secs()
                        );
                    }
                }
                Err(RecvError::Closed) => break,
            },
            _ = reconcile.tick() => engine.reconcile_once().await,
        }
    }
}

/// How a launch composes its prompt.
enum LaunchMode {
    /// First run: the task's own prompt blocks.
    Fresh,
    /// Retry after failure: resume the session if possible and ask to continue.
    Retry,
    /// Returned from review with feedback.
    Return(String),
    /// Merge generation: the agent lands the task onto the base branch itself
    /// (sync base into the worktree, resolve conflicts, merge into base). The
    /// task sits in `merging` for the whole turn; the engine settles from git
    /// truth, never from the agent's word.
    Merge {
        root_path: String,
        base_branch: String,
        work_branch: String,
        /// "squash" | "merge"
        strategy: String,
        /// `None` → the agent writes the commit message itself.
        message: Option<String>,
    },
}

impl LaunchMode {
    /// The task status a launch of this mode expects to find (and keep).
    fn expected_status(&self) -> WorkTaskStatus {
        match self {
            LaunchMode::Merge { .. } => WorkTaskStatus::Merging,
            _ => WorkTaskStatus::Queued,
        }
    }

    /// Timeline `round` label for the prompt this mode composes.
    fn round_kind(&self) -> &'static str {
        match self {
            LaunchMode::Fresh => "work",
            LaunchMode::Retry => "retry",
            LaunchMode::Return(_) => "return",
            LaunchMode::Merge { .. } => "merge",
        }
    }
}

impl TaskEngine {
    // ── user entry points ───────────────────────────────────────────────────

    /// Manual start: claim todo → queued, then pump the folder.
    pub async fn start(self: &Arc<Self>, task_id: i32) -> Result<(), String> {
        let task = work_task_service::get_model(&self.db.conn, task_id)
            .await
            .map_err(|e| e.to_string())?;
        self.preflight_folder(task.folder_id).await?;
        match work_task_service::claim_for_run(&self.db.conn, task_id, WorkTaskStatus::Todo, "user")
            .await
            .map_err(|e| e.to_string())?
        {
            Some(_) => {
                self.emit_upsert(task_id);
                self.pump_folder(task.folder_id).await;
                Ok(())
            }
            None => Err("task is not in todo".to_string()),
        }
    }

    /// "Start all": claim every todo of the folder, then pump. With no folder
    /// selected this is the global sweep — every folder that holds todos, each
    /// on its own preflight (an invalid folder is skipped, not fatal).
    pub async fn start_all(self: &Arc<Self>, folder_id: Option<i32>) -> Result<u32, String> {
        let folder_ids = match folder_id {
            Some(id) => vec![id],
            None => work_task_service::folders_with_todos(&self.db.conn)
                .await
                .map_err(|e| e.to_string())?,
        };
        let explicit = folder_id.is_some();
        let mut claimed = 0u32;
        for fid in folder_ids {
            if let Err(e) = self.preflight_folder(fid).await {
                if explicit {
                    return Err(e);
                }
                tracing::info!("[work_task] start all skips folder {fid}: {e}");
                continue;
            }
            let ids = work_task_service::list_todo_ids(&self.db.conn, fid)
                .await
                .map_err(|e| e.to_string())?;
            let mut folder_claimed = 0u32;
            for id in ids {
                if work_task_service::claim_for_run(&self.db.conn, id, WorkTaskStatus::Todo, "user")
                    .await
                    .map_err(|e| e.to_string())?
                    .is_some()
                {
                    folder_claimed += 1;
                    self.emit_upsert(id);
                }
            }
            if folder_claimed > 0 {
                self.pump_folder(fid).await;
            }
            claimed += folder_claimed;
        }
        Ok(claimed)
    }

    /// Retry a failed task: claim failed → queued (same worktree / session
    /// reused by the launch), then pump.
    pub async fn retry(self: &Arc<Self>, task_id: i32) -> Result<(), String> {
        let task = work_task_service::get_model(&self.db.conn, task_id)
            .await
            .map_err(|e| e.to_string())?;
        self.preflight_folder(task.folder_id).await?;
        match work_task_service::claim_for_run(
            &self.db.conn,
            task_id,
            WorkTaskStatus::Failed,
            "user",
        )
        .await
        .map_err(|e| e.to_string())?
        {
            Some(_) => {
                self.emit_upsert(task_id);
                self.pump_folder(task.folder_id).await;
                Ok(())
            }
            None => Err("task is not in failed".to_string()),
        }
    }

    /// Return a reviewed task to the agent with feedback. Launches directly
    /// (explicit user action — does not wait behind the queue).
    pub async fn return_task(self: &Arc<Self>, task_id: i32, feedback: String) -> Result<(), String> {
        let task = work_task_service::get_model(&self.db.conn, task_id)
            .await
            .map_err(|e| e.to_string())?;
        self.preflight_folder(task.folder_id).await?;
        let Some(_) = work_task_service::claim_for_run(
            &self.db.conn,
            task_id,
            WorkTaskStatus::Review,
            "user",
        )
        .await
        .map_err(|e| e.to_string())?
        else {
            return Err("task is not in review".to_string());
        };
        let _ = work_task_service::record_event(
            &self.db.conn,
            task_id,
            "user_action",
            "user",
            Some(serde_json::json!({ "action": "return", "feedback": feedback })),
        )
        .await;
        self.emit_upsert(task_id);
        self.spawn_launch(task_id, task.folder_id, LaunchMode::Return(feedback));
        Ok(())
    }

    /// Cancel a task from any non-terminal state except merging. Worktree is
    /// kept (the card offers cleanup separately).
    pub async fn cancel(self: &Arc<Self>, task_id: i32) -> Result<(), String> {
        let won = work_task_service::cancel(&self.db.conn, task_id)
            .await
            .map_err(|e| e.to_string())?;
        if !won {
            return Err("task cannot be canceled in its current state".to_string());
        }
        self.emit_upsert(task_id);

        // Serialize the teardown with a possibly in-flight launch: the launch
        // holds the task lock across spawn → prompt, and its status gates
        // re-read after each step — so we tear down either before the prompt
        // (gate aborts) or after the turn is truly in flight (manager.cancel
        // aborts a real turn), never interleaved with the prompt enqueue.
        let lock = self.task_lock(task_id).await;
        let _guard = lock.lock().await;

        let conn_id = {
            self.index
                .lock()
                .await
                .iter()
                .find(|(_, (tid, _))| *tid == task_id)
                .map(|(c, _)| c.clone())
        };
        if let Some(conn_id) = conn_id {
            let _ = self.manager.cancel(&self.db.conn, &conn_id).await;
            self.index.lock().await.remove(&conn_id);
            let _ = self.manager.disconnect(&conn_id).await;
        }
        self.awaiting.lock().await.remove(&task_id);

        // Converge a stranded InProgress conversation.
        let task = work_task_service::get_model(&self.db.conn, task_id).await.ok();
        if let Some(conv_id) = task.as_ref().and_then(|t| t.conversation_id) {
            if self.conversation_status(conv_id).await == Some(ConversationStatus::InProgress) {
                self.cancel_conversation(conv_id).await;
            }
        }
        // The slot freed — refill from the queue (and an auto folder's todo).
        if let Some(folder_id) = task.map(|t| t.folder_id) {
            self.pump_folder(folder_id).await;
        }
        Ok(())
    }

    // ── pump ────────────────────────────────────────────────────────────────

    /// Launch queued tasks of a folder up to its `max_concurrent` (0 =
    /// unlimited). Serialized per folder so concurrent pumps can't over-launch.
    pub async fn pump_folder(self: &Arc<Self>, folder_id: i32) {
        let lock = {
            let mut locks = self.pump_locks.lock().await;
            locks
                .entry(folder_id)
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _guard = lock.lock().await;

        let settings = work_task_service::settings_get_effective(&self.db.conn, folder_id)
            .await
            .unwrap_or_default();
        let max = settings.max_concurrent.max(0) as u64;

        // Scheduler arm: an auto_process folder claims todo heads into the
        // queue until the budget (which counts queued) is spent; the drain
        // loop below then launches them like any manually queued task.
        if settings.auto_process {
            loop {
                match work_task_service::auto_claim_next(
                    &self.db.conn,
                    folder_id,
                    settings.max_concurrent,
                )
                .await
                {
                    Ok(Some(id)) => self.emit_upsert(id),
                    Ok(None) => break,
                    Err(e) => {
                        tracing::warn!("[work_task] auto claim error: {e}");
                        break;
                    }
                }
            }
        }

        loop {
            // Only THIS folder's in-flight launches count against its limit.
            let launching: Vec<i32> = self
                .launching
                .lock()
                .await
                .iter()
                .filter(|(_, fid)| **fid == folder_id)
                .map(|(tid, _)| *tid)
                .collect();
            let active = match work_task_service::active_launched_count(&self.db.conn, folder_id)
                .await
            {
                Ok(n) => n + launching.len() as u64,
                Err(e) => {
                    tracing::warn!("[work_task] pump count error: {e}");
                    return;
                }
            };
            if max != 0 && active >= max {
                return;
            }
            let next = match work_task_service::next_queued(&self.db.conn, folder_id, &launching)
                .await
            {
                Ok(Some(t)) => t,
                Ok(None) => return,
                Err(e) => {
                    tracing::warn!("[work_task] pump next error: {e}");
                    return;
                }
            };
            self.launching.lock().await.insert(next.id, folder_id);
            self.spawn_launch(next.id, folder_id, launch_mode_for(&next));
        }
    }

    fn spawn_launch(self: &Arc<Self>, task_id: i32, folder_id: i32, mode: LaunchMode) {
        let engine = self.clone();
        tokio::spawn(async move {
            engine.launching.lock().await.insert(task_id, folder_id);
            let result = engine.launch(task_id, mode).await;
            engine.launching.lock().await.remove(&task_id);
            if let Err(e) = result {
                tracing::info!("[work_task] launch {task_id}: {e}");
                let task = work_task_service::get_model(&engine.db.conn, task_id).await.ok();
                let seq = task.as_ref().map(|t| t.run_seq);
                let failed = work_task_service::fail(
                    &engine.db.conn,
                    task_id,
                    &[WorkTaskStatus::Queued, WorkTaskStatus::Running],
                    seq,
                    "setup_error",
                    Some(e),
                )
                .await
                .unwrap_or(false);
                if failed {
                    engine.emit_upsert(task_id);
                }
                // A slot may have opened up (or this task left the queue) —
                // keep draining.
                if let Some(t) = task {
                    engine.pump_folder(t.folder_id).await;
                }
            }
        });
    }

    // ── launch ──────────────────────────────────────────────────────────────

    async fn launch(self: &Arc<Self>, task_id: i32, mode: LaunchMode) -> Result<(), String> {
        let lock = self.task_lock(task_id).await;
        let _guard = lock.lock().await;

        let task = work_task_service::get_model(&self.db.conn, task_id)
            .await
            .map_err(|e| e.to_string())?;
        if task.status != mode.expected_status() {
            return Ok(()); // canceled (or otherwise moved on) before we got here
        }
        let run_seq = task.run_seq;
        let root = get_folder_core(&self.db, task.folder_id)
            .await
            .map_err(|e| e.to_string())?;

        // Effective agent + config: task override > folder task settings >
        // folder default agent. Audited via a config_effective event (values
        // are inherited live, never frozen).
        let cfg: WorkTaskConfig =
            serde_json::from_str(&task.config).unwrap_or_default();
        let settings = work_task_service::settings_get_effective(&self.db.conn, task.folder_id)
            .await
            .unwrap_or_default();
        let (agent_str, mode_id, config_values) = effective_agent_config(&cfg, &settings, &root);
        let agent_str = agent_str.ok_or_else(|| {
            "no agent configured: set a task agent or a folder default".to_string()
        })?;
        let agent_type = parse_agent_type(&agent_str)?;

        // Cheap validation before any side effects; the full prompt is composed
        // after the spawn, once we know whether the session actually resumed.
        if matches!(mode, LaunchMode::Fresh) && cfg.prompt_blocks.is_empty() {
            return Err("prompt is empty".to_string());
        }

        // Worktree: reuse the recorded one when it still exists (retry/return),
        // else mint a fresh one pinned to the base recorded FIRST (no drift
        // window between reading the branch and creating the worktree). A merge
        // generation never creates one — merging a fresh empty worktree would
        // "land" as a no-op tree match.
        let wt = if matches!(mode, LaunchMode::Merge { .. }) {
            self.existing_worktree(&task).await?
        } else {
            let wt = self.ensure_worktree(&task, &root).await?;
            // Freshly created tree → run the folder's init command (deps
            // install etc.) before the agent ever sees it. A failure is a
            // setup error: the task must not start half-initialized.
            if wt.created {
                let init = settings
                    .init_command
                    .as_deref()
                    .map(str::trim)
                    .filter(|c| !c.is_empty());
                if let Some(command) = init {
                    self.run_init_command(task_id, command, &wt.path).await?;
                }
            }
            wt
        };

        let _ = work_task_service::record_event(
            &self.db.conn,
            task_id,
            "config_effective",
            "engine",
            Some(serde_json::json!({
                "agent": agent_str,
                "mode": mode_id,
                "model": config_values.get("model"),
            })),
        )
        .await;

        // Announce the worktree folder before any conversation upsert so every
        // client can group the conversation (idempotent re-broadcast).
        if let Ok(detail) = get_folder_core(&self.db, wt.folder_id).await {
            emit_folder_upsert(&self.emitter, detail);
        }

        // Resume the previous session for retry/return/merge when we have one.
        let resume_session_id = match mode {
            LaunchMode::Fresh => None,
            LaunchMode::Retry | LaunchMode::Return(_) | LaunchMode::Merge { .. } => {
                match task.conversation_id {
                    Some(conv_id) => conversation::Entity::find_by_id(conv_id)
                        .one(&self.db.conn)
                        .await
                        .ok()
                        .flatten()
                        .and_then(|c| c.external_id),
                    None => None,
                }
            }
        };

        let runtime_env =
            build_session_runtime_env(&self.db, agent_type, resume_session_id.as_deref(), &self.data_dir)
                .await
                .map_err(|e| e.to_string())?;
        verify_agent_installed(agent_type)
            .await
            .map_err(|e| e.to_string())?;

        // Cancel gate before spawning the CLI.
        if !still_expected(&self.db.conn, task_id, run_seq, mode.expected_status()).await {
            return Ok(());
        }

        let mut resumed = resume_session_id.is_some();
        let conn_id = match self
            .manager
            .spawn_agent(
                agent_type,
                Some(wt.path.clone()),
                resume_session_id.clone(),
                runtime_env.clone(),
                "work_task".to_string(),
                self.emitter.clone(),
                mode_id.clone(),
                config_values.clone(),
            )
            .await
        {
            Ok(id) => id,
            Err(e) if resumed => {
                // Resume failed (e.g. the agent lost the session) → fall back
                // to a fresh session in the same worktree, recorded on the
                // timeline.
                tracing::info!("[work_task] resume failed for task {task_id}: {e}; falling back");
                let _ = work_task_service::record_event(
                    &self.db.conn,
                    task_id,
                    "resume_fallback",
                    "engine",
                    Some(serde_json::json!({ "error": e.to_string() })),
                )
                .await;
                resumed = false;
                self.manager
                    .spawn_agent(
                        agent_type,
                        Some(wt.path.clone()),
                        None,
                        runtime_env,
                        "work_task".to_string(),
                        self.emitter.clone(),
                        mode_id.clone(),
                        config_values.clone(),
                    )
                    .await
                    .map_err(|e| e.to_string())?
            }
            Err(e) => return Err(e.to_string()),
        };

        // Conversation row: reuse when resuming the same session; otherwise a
        // fresh row (fresh runs and resume fallbacks).
        let conversation_id = if resumed {
            task.conversation_id.expect("resumed implies conversation")
        } else {
            let title = first_chars(task.title.trim(), 80);
            match create_conversation_core(&self.db.conn, wt.folder_id, agent_type, Some(title))
                .await
            {
                Ok(id) => id,
                Err(e) => {
                    let _ = self.manager.disconnect(&conn_id).await;
                    return Err(e.to_string());
                }
            }
        };
        emit_conversation_upsert(&self.emitter, &self.db.conn, conversation_id).await;

        let blocks = compose_prompt(&cfg, &task, &mode, resumed, &self.db.conn).await?;

        // Register for completion correlation BEFORE prompting so a fast
        // TurnComplete can't race ahead of the index entry.
        self.index
            .lock()
            .await
            .insert(conn_id.clone(), (task_id, run_seq));

        // queued → running (CAS on run_seq) — or, for a merge generation, just
        // record the live coordinates while the status stays merging. Losing
        // means a concurrent cancel/settle — tear down without side effects.
        let marked = if matches!(mode, LaunchMode::Merge { .. }) {
            work_task_service::mark_merging_live(
                &self.db.conn,
                task_id,
                run_seq,
                conversation_id,
                &conn_id,
            )
            .await
            .map_err(|e| e.to_string())?
        } else {
            work_task_service::mark_running(
                &self.db.conn,
                task_id,
                run_seq,
                conversation_id,
                &conn_id,
            )
            .await
            .map_err(|e| e.to_string())?
        };
        if !marked {
            self.index.lock().await.remove(&conn_id);
            let _ = self.manager.disconnect(&conn_id).await;
            if !resumed {
                self.cancel_conversation(conversation_id).await;
            }
            return Ok(());
        }
        self.emit_upsert(task_id);

        let prompt_head = prompt_head(&blocks);
        match self
            .manager
            .send_prompt_linked_with_message_id(
                &self.db,
                &conn_id,
                blocks,
                Some(wt.folder_id),
                Some(conversation_id),
                None,
                None,
            )
            .await
        {
            Ok(_) => {
                // Timeline round marker: lets the transcript viewer label this
                // prompt's turn with its phase (work / retry / return / merge).
                let _ = work_task_service::record_event(
                    &self.db.conn,
                    task_id,
                    "round",
                    "engine",
                    Some(serde_json::json!({
                        "kind": mode.round_kind(),
                        "run_seq": run_seq,
                        "prompt_head": prompt_head,
                    })),
                )
                .await;
                Ok(())
            }
            Err(e) => {
                self.index.lock().await.remove(&conn_id);
                let _ = self.manager.disconnect(&conn_id).await;
                if !resumed {
                    self.cancel_conversation(conversation_id).await;
                }
                Err(e.to_string())
            }
        }
    }

    /// Resolve (and if needed create) the task's worktree. On creation the base
    /// branch + sha are recorded BEFORE `git worktree add` runs against that
    /// exact sha.
    async fn ensure_worktree(
        &self,
        task: &crate::db::entities::work_task::Model,
        root: &crate::models::FolderDetail,
    ) -> Result<WorktreeRef, String> {
        if let Some(wt_id) = task.worktree_folder_id {
            if let Ok(detail) = get_folder_core(&self.db, wt_id).await {
                if Path::new(&detail.path).exists() {
                    return Ok(WorktreeRef {
                        folder_id: detail.id,
                        path: detail.path,
                        created: false,
                    });
                }
            }
        }

        let head = resolve_git_head(&root.path).await.map_err(|e| e.to_string())?;
        let base_branch = head
            .branch
            .ok_or_else(|| "project folder is not on a branch (detached HEAD?)".to_string())?;
        let base_sha = task_git::rev_parse(&root.path, "HEAD")
            .await
            .map_err(|e| e.to_string())?;

        let branch = format!("task/{}", task.id);
        let dir = format!("{}-task-{}", basename(&root.path), task.id);
        let mut wt_path = sibling_path(&root.path, &dir);
        let mut branch_used = branch.clone();

        if let Err(e) = git_worktree_add(
            root.path.clone(),
            branch.clone(),
            wt_path.clone(),
            Some(base_sha.clone()),
        )
        .await
        {
            // A leftover from a prior attempt may collide — retry once with a
            // generation-scoped suffix.
            let suffix = format!("r{}b", task.run_seq);
            branch_used = format!("{branch}-{suffix}");
            wt_path = sibling_path(&root.path, &format!("{dir}-{suffix}"));
            git_worktree_add(
                root.path.clone(),
                branch_used.clone(),
                wt_path.clone(),
                Some(base_sha.clone()),
            )
            .await
            .map_err(|_| format!("worktree add failed: {e}"))?;
        }

        let wt = open_worktree_folder_core(&self.db, wt_path, task.folder_id)
            .await
            .map_err(|e| e.to_string())?;
        work_task_service::attach_worktree(
            &self.db.conn,
            task.id,
            wt.id,
            &base_branch,
            &base_sha,
            &branch_used,
        )
        .await
        .map_err(|e| e.to_string())?;
        Ok(WorktreeRef {
            folder_id: wt.id,
            path: wt.path,
            created: true,
        })
    }

    /// The task's recorded worktree, required to exist on disk — the merge
    /// generation must never mint a fresh (empty) one.
    async fn existing_worktree(&self, task: &crate::db::entities::work_task::Model) -> Result<WorktreeRef, String> {
        let wt_id = task
            .worktree_folder_id
            .ok_or_else(|| "task has no worktree".to_string())?;
        let detail = get_folder_core(&self.db, wt_id)
            .await
            .map_err(|e| e.to_string())?;
        if !Path::new(&detail.path).exists() {
            return Err("the task worktree no longer exists on disk".to_string());
        }
        Ok(WorktreeRef {
            folder_id: detail.id,
            path: detail.path,
            created: false,
        })
    }

    /// Run the folder's worktree init command in a freshly created worktree.
    /// The outcome is always recorded on the timeline; a failure aborts the
    /// launch (setup error) so the agent never starts half-initialized.
    async fn run_init_command(&self, task_id: i32, command: &str, cwd: &str) -> Result<(), String> {
        let run = run_shell_capture(command, cwd).await;
        let (exit_code, tail) = match &run {
            Ok((code, tail)) => (*code, tail.clone()),
            Err(e) => (None, e.clone()),
        };
        let ok = matches!(run, Ok((Some(0), _)));
        let _ = work_task_service::record_event(
            &self.db.conn,
            task_id,
            "init_command",
            "engine",
            Some(serde_json::json!({
                "command": command,
                "exit_code": exit_code,
                "output_tail": (!ok && !tail.is_empty()).then_some(tail.clone()),
            })),
        )
        .await;
        if ok {
            Ok(())
        } else {
            let code = exit_code.map(|c| c.to_string()).unwrap_or_else(|| "?".into());
            Err(format!("worktree init command failed (exit {code}): {tail}"))
        }
    }

    /// Start preflight: the target folder must exist, be live, and be a
    /// project root (not a worktree).
    async fn preflight_folder(&self, folder_id: i32) -> Result<(), String> {
        let row = folder::Entity::find_by_id(folder_id)
            .one(&self.db.conn)
            .await
            .map_err(|e| e.to_string())?
            .filter(|f| f.deleted_at.is_none())
            .ok_or_else(|| "folder not found".to_string())?;
        if row.parent_id.is_some() {
            return Err("tasks must run from a project folder, not a worktree".to_string());
        }
        Ok(())
    }

    // ── event settlement ────────────────────────────────────────────────────

    async fn on_event(self: &Arc<Self>, env: &EventEnvelope) {
        match &env.payload {
            AcpEvent::TurnComplete { stop_reason, .. } => {
                self.on_turn_complete(&env.connection_id, stop_reason).await;
            }
            AcpEvent::QuestionRequest { question_id, .. } => {
                self.track_request(&env.connection_id, format!("q:{question_id}"), true)
                    .await;
            }
            AcpEvent::QuestionResolved { question_id } => {
                self.track_request(&env.connection_id, format!("q:{question_id}"), false)
                    .await;
            }
            AcpEvent::PermissionRequest { request_id, .. } => {
                self.track_request(&env.connection_id, format!("p:{request_id}"), true)
                    .await;
            }
            AcpEvent::PermissionResolved { request_id } => {
                self.track_request(&env.connection_id, format!("p:{request_id}"), false)
                    .await;
            }
            AcpEvent::PlanApprovalRequest { approval_id, .. } => {
                self.track_request(&env.connection_id, format!("a:{approval_id}"), true)
                    .await;
            }
            AcpEvent::PlanApprovalResolved { approval_id } => {
                self.track_request(&env.connection_id, format!("a:{approval_id}"), false)
                    .await;
            }
            _ => {}
        }
    }

    async fn on_turn_complete(self: &Arc<Self>, conn_id: &str, stop_reason: &str) {
        let entry = { self.index.lock().await.get(conn_id).copied() };
        let Some((task_id, run_seq)) = entry else {
            return; // not a task run
        };

        let summary = self.capture_summary(conn_id).await;
        self.index.lock().await.remove(conn_id);
        self.awaiting.lock().await.remove(&task_id);
        let _ = self.manager.disconnect(conn_id).await;

        let task = work_task_service::get_model(&self.db.conn, task_id).await.ok();

        // A merge generation settles from git truth whatever the stop reason —
        // the agent may have landed the merge and then errored or been stopped.
        if let Some(t) = task
            .as_ref()
            .filter(|t| t.status == WorkTaskStatus::Merging && t.run_seq == run_seq)
        {
            self.settle_merge_generation(t, stop_reason, summary.as_deref())
                .await;
            self.pump_folder(t.folder_id).await;
            return;
        }

        let changed = match stop_reason {
            "end_turn" => {
                // A `task_complete` report from this generation decides the
                // settle: blocked → failed(verdict_blocked); success /
                // needs_review → review. The verdict column is cleared on every
                // claim, so a present verdict is always this generation's — and
                // its summary (written with it) outranks the captured
                // last-assistant text.
                let verdict = task
                    .as_ref()
                    .filter(|t| t.run_seq == run_seq)
                    .and_then(|t| t.verdict.clone());
                if verdict.as_deref() == Some("blocked") {
                    let error = task
                        .as_ref()
                        .and_then(|t| t.result_summary.clone())
                        .unwrap_or_else(|| "agent reported the task as blocked".to_string());
                    work_task_service::fail(
                        &self.db.conn,
                        task_id,
                        &[WorkTaskStatus::Running, WorkTaskStatus::AwaitingInput],
                        Some(run_seq),
                        "verdict_blocked",
                        Some(error),
                    )
                    .await
                    .unwrap_or(false)
                } else {
                    let own_summary = if verdict.is_some() {
                        task.as_ref().and_then(|t| t.result_summary.clone())
                    } else {
                        None
                    };
                    let stats = self.snapshot_diff_stats(task_id).await;
                    let settled = work_task_service::settle_review(
                        &self.db.conn,
                        task_id,
                        run_seq,
                        own_summary.or(summary),
                        stats,
                    )
                    .await
                    .unwrap_or(false);
                    if settled {
                        self.spawn_preflight(task_id, run_seq);
                    }
                    settled
                }
            }
            "cancelled" => {
                // The user stopped the agent from the conversation UI — that is
                // a task cancel, not an agent failure.
                work_task_service::cancel(&self.db.conn, task_id)
                    .await
                    .unwrap_or(false)
            }
            other => work_task_service::fail(
                &self.db.conn,
                task_id,
                &[WorkTaskStatus::Running, WorkTaskStatus::AwaitingInput],
                Some(run_seq),
                "agent_error",
                Some(format!("agent stopped: {other}")),
            )
            .await
            .unwrap_or(false),
        };
        if changed {
            self.emit_upsert(task_id);
        }
        // A slot freed up — keep the queue draining.
        if let Ok(task) = work_task_service::get_model(&self.db.conn, task_id).await {
            self.pump_folder(task.folder_id).await;
        }
    }

    /// Track an outstanding blocking request and flip running ⇄ awaiting_input
    /// on the empty↔non-empty edges of the per-task set.
    async fn track_request(&self, conn_id: &str, key: String, outstanding: bool) {
        let entry = { self.index.lock().await.get(conn_id).copied() };
        let Some((task_id, run_seq)) = entry else {
            return;
        };
        let flip = {
            let mut awaiting = self.awaiting.lock().await;
            let set = awaiting.entry(task_id).or_default();
            if outstanding {
                set.insert(key);
                set.len() == 1
            } else {
                set.remove(&key);
                if set.is_empty() {
                    awaiting.remove(&task_id);
                    true
                } else {
                    false
                }
            }
        };
        if flip {
            let flipped =
                work_task_service::flip_awaiting(&self.db.conn, task_id, run_seq, outstanding)
                    .await
                    .unwrap_or(false);
            if flipped {
                self.emit_upsert(task_id);
            }
        }
    }

    // ── codeg-mcp task reporting tools ──────────────────────────────────────

    /// `task_progress`: attribute the report through the connection index and
    /// append an `agent_progress` event (the card/timeline milestone).
    pub async fn record_progress(&self, conn_id: &str, message: &str) -> TaskReportAck {
        let entry = { self.index.lock().await.get(conn_id).copied() };
        let Some((task_id, run_seq)) = entry else {
            return TaskReportAck::rejected("this session is not executing a work task");
        };
        // Generation guard: a stale connection's report is a no-op.
        match work_task_service::get_model(&self.db.conn, task_id).await {
            Ok(task) if task.run_seq == run_seq => {}
            _ => return TaskReportAck::rejected("the task moved on to a new run"),
        }
        if let Err(e) = work_task_service::record_event(
            &self.db.conn,
            task_id,
            "agent_progress",
            "agent",
            Some(serde_json::json!({ "message": message })),
        )
        .await
        {
            return TaskReportAck::rejected(&format!("could not record progress: {e}"));
        }
        self.emit_upsert(task_id);
        TaskReportAck::recorded()
    }

    /// `task_complete`: stash the verdict + summary on the current generation;
    /// the TurnComplete settle reads them to decide review vs failed.
    pub async fn record_complete(
        &self,
        conn_id: &str,
        verdict: &str,
        summary: Option<&str>,
    ) -> TaskReportAck {
        let entry = { self.index.lock().await.get(conn_id).copied() };
        let Some((task_id, run_seq)) = entry else {
            return TaskReportAck::rejected("this session is not executing a work task");
        };
        match work_task_service::set_verdict(&self.db.conn, task_id, run_seq, verdict, summary)
            .await
        {
            Ok(true) => {
                self.emit_upsert(task_id);
                TaskReportAck::recorded()
            }
            Ok(false) => TaskReportAck::rejected("the task is not running anymore"),
            Err(e) => TaskReportAck::rejected(&format!("could not record verdict: {e}")),
        }
    }

    // ── preflight (acceptance red/green light) ──────────────────────────────

    /// Run the folder's configured preflight command against the task worktree
    /// after a settle into review. Fire-and-forget: the result is written CAS
    /// (review + run_seq), so a task that moved on ignores a slow finish.
    fn spawn_preflight(self: &Arc<Self>, task_id: i32, run_seq: i32) {
        let engine = self.clone();
        tokio::spawn(async move {
            engine.run_preflight(task_id, run_seq).await;
        });
    }

    async fn run_preflight(&self, task_id: i32, run_seq: i32) {
        let Ok(task) = work_task_service::get_model(&self.db.conn, task_id).await else {
            return;
        };
        let settings = work_task_service::settings_get_effective(&self.db.conn, task.folder_id)
            .await
            .unwrap_or_default();
        // A free-form command wins over a folder-command reference; the
        // reference must still exist and belong to this project folder.
        let custom = settings
            .preflight_command
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty());
        let (display_name, command_line) = match custom {
            Some(cmd) => (cmd.to_string(), cmd.to_string()),
            None => {
                let Some(command_id) = settings.preflight_command_id else {
                    return;
                };
                let Ok(Some(command)) = folder_command::Entity::find_by_id(command_id)
                    .one(&self.db.conn)
                    .await
                else {
                    return;
                };
                if command.folder_id != task.folder_id {
                    return;
                }
                (command.name, command.command)
            }
        };
        let Some(wt_id) = task.worktree_folder_id else {
            return;
        };
        let Ok(wt) = get_folder_core(&self.db, wt_id).await else {
            return;
        };
        if !Path::new(&wt.path).exists() {
            return;
        }

        let mut light = WorkTaskPreflight {
            status: "running".to_string(),
            command: display_name,
            exit_code: None,
            output_tail: None,
        };
        match work_task_service::set_preflight(&self.db.conn, task_id, run_seq, &light).await {
            Ok(true) => self.emit_upsert(task_id),
            _ => return, // task already moved on
        }

        match run_shell_capture(&command_line, &wt.path).await {
            Ok((code, tail)) => {
                let passed = code == Some(0);
                light.status = if passed { "passed" } else { "failed" }.to_string();
                light.exit_code = code;
                // The tail only matters when the light is red.
                light.output_tail = (!passed && !tail.is_empty()).then_some(tail);
            }
            Err(e) => {
                light.status = "failed".to_string();
                light.output_tail = Some(format!("could not run the command: {e}"));
            }
        }
        if work_task_service::set_preflight(&self.db.conn, task_id, run_seq, &light)
            .await
            .unwrap_or(false)
        {
            self.emit_upsert(task_id);
        }
    }

    /// Best-effort diff-stat snapshot of the task worktree vs its base.
    async fn snapshot_diff_stats(&self, task_id: i32) -> Option<(i32, i32, i32)> {
        let task = work_task_service::get_model(&self.db.conn, task_id).await.ok()?;
        let wt_id = task.worktree_folder_id?;
        let base = task.base_sha.clone()?;
        let wt = get_folder_core(&self.db, wt_id).await.ok()?;
        let files = task_git::diff_numstat(&wt.path, &base).await.ok()?;
        let adds: i32 = files.iter().map(|f| f.additions).sum();
        let dels: i32 = files.iter().map(|f| f.deletions).sum();
        Some((files.len() as i32, adds, dels))
    }

    /// Best-effort: the turn's final assistant text (cleared at next turn
    /// start) becomes the task's result summary.
    async fn capture_summary(&self, conn_id: &str) -> Option<String> {
        let (state, _) = self.manager.get_state_and_emitter(conn_id).await?;
        let text = state.read().await.last_assistant_text.clone();
        text.filter(|t| !t.trim().is_empty())
    }

    // ── merge (two-stage, persisted intent, per-folder git mutex) ───────────

    /// Land a reviewed task on its base branch. Runs the full stage 0/A/B
    /// pipeline; on any failure the task returns to review with a readable
    /// error. Optionally removes the worktree after landing.
    /// Accept a reviewed task: dispatch a MERGE GENERATION — the agent lands
    /// the task onto the base branch itself in its session, resolving any
    /// conflicts in the same turn. Validation runs before the review→merging
    /// CAS, so a refused merge leaves the task untouched; after dispatch the
    /// settle comes from git truth (`settle_merge_generation` / recovery),
    /// never from the agent's word.
    pub async fn merge_task(
        self: &Arc<Self>,
        task_id: i32,
        message: Option<String>,
        delete_worktree: bool,
    ) -> Result<(), String> {
        let task = work_task_service::get_model(&self.db.conn, task_id)
            .await
            .map_err(|e| e.to_string())?;
        if task.status != WorkTaskStatus::Review {
            return Err("task is not in review".to_string());
        }
        let message = message
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty());
        let settings = work_task_service::settings_get_effective(&self.db.conn, task.folder_id)
            .await
            .unwrap_or_default();
        let strategy = if settings.merge_strategy == "merge" {
            "merge"
        } else {
            "squash"
        }
        .to_string();
        let (root, _wt, base_branch, work_branch) = self.merge_coordinates(&task).await?;

        // Dispatch under the per-folder git lock: one merge per project at a
        // time, with the base state validated right before the CAS.
        let lock = self.folder_lock(task.folder_id).await;
        let _guard = lock.lock().await;

        let another_merging =
            work_task_service::list_by_status(&self.db.conn, &[WorkTaskStatus::Merging])
                .await
                .map_err(|e| e.to_string())?
                .into_iter()
                .any(|t| t.folder_id == task.folder_id);
        if another_merging {
            return Err("another task of this project is already merging — wait for it".to_string());
        }
        let head = resolve_git_head(&root.path).await.map_err(|e| e.to_string())?;
        if head.branch.as_deref() != Some(base_branch.as_str()) {
            return Err(format!(
                "project folder is on '{}', expected '{base_branch}' — switch back to merge",
                head.branch.as_deref().unwrap_or("detached HEAD")
            ));
        }
        match task_git::staged_clean(&root.path).await {
            Ok(true) => {}
            Ok(false) => {
                return Err(
                    "the project folder has staged changes — commit or unstage them first"
                        .to_string(),
                )
            }
            Err(e) => return Err(e.to_string()),
        }
        let pre_merge_head = task_git::rev_parse(&root.path, "HEAD")
            .await
            .map_err(|e| e.to_string())?;

        let state = WorkTaskMergeState {
            pre_merge_head,
            message: message.clone().unwrap_or_default(),
            strategy: strategy.clone(),
            delete_worktree,
            auto_message: message.is_none(),
        };
        // Keep recovery away from the dispatch window (begin → live conn).
        self.merging.lock().await.insert(task_id);
        let result = match work_task_service::begin_merge(&self.db.conn, task_id, &state).await {
            Err(e) => Err(e.to_string()),
            Ok(None) => Err("task left review before the merge began".to_string()),
            Ok(Some(_run_seq)) => {
                self.emit_upsert(task_id);
                match self
                    .launch(
                        task_id,
                        LaunchMode::Merge {
                            root_path: root.path.clone(),
                            base_branch: base_branch.clone(),
                            work_branch: work_branch.clone(),
                            strategy,
                            message,
                        },
                    )
                    .await
                {
                    Ok(()) => Ok(()),
                    Err(e) => {
                        self.back_to_review(task_id, format!("merge dispatch failed: {e}"), None)
                            .await;
                        Err(e)
                    }
                }
            }
        };
        self.merging.lock().await.remove(&task_id);
        self.emit_upsert(task_id);
        result
    }

    /// Settle a finished merge generation from git truth: landed ⟺ the base
    /// HEAD moved and contains the work (branch ancestry for merge commits,
    /// tree equality for squashes). Anything else goes back to review with the
    /// reason, after cleaning any half-done merge out of the project folder.
    async fn settle_merge_generation(
        self: &Arc<Self>,
        task: &crate::db::entities::work_task::Model,
        stop_reason: &str,
        summary: Option<&str>,
    ) {
        let task_id = task.id;
        let Some(state) = task
            .merge_state
            .as_deref()
            .and_then(|s| serde_json::from_str::<WorkTaskMergeState>(s).ok())
        else {
            self.back_to_review(task_id, "merge state lost — please merge again".to_string(), None)
                .await;
            return;
        };
        let root = match get_folder_core(&self.db, task.folder_id).await {
            Ok(r) => r,
            Err(e) => {
                self.back_to_review(task_id, e.to_string(), None).await;
                return;
            }
        };
        let lock = self.folder_lock(task.folder_id).await;
        let _guard = lock.lock().await;

        match self.merge_landed_commit(task, &state, &root.path).await {
            Ok(Some(commit)) => {
                let landed = work_task_service::merge_landed(&self.db.conn, task_id, &commit)
                    .await
                    .unwrap_or(false);
                if landed {
                    self.emit_upsert(task_id);
                    if state.delete_worktree {
                        self.remove_worktree_locked(task_id).await;
                    }
                }
            }
            Ok(None) => {
                self.clean_merge_residue(&root.path).await;
                let reason = match stop_reason {
                    "end_turn" => match summary.map(str::trim).filter(|s| !s.is_empty()) {
                        Some(s) => format!(
                            "the agent finished without landing the merge: {}",
                            first_chars(s, 300)
                        ),
                        None => "the agent finished without landing the merge — review and \
                                 merge again"
                            .to_string(),
                    },
                    "cancelled" => "the merge run was stopped before landing".to_string(),
                    other => format!("the merge run failed before landing: {other}"),
                };
                self.back_to_review(task_id, reason, None).await;
            }
            Err(e) => {
                self.back_to_review(task_id, format!("could not verify the merge: {e}"), None)
                    .await;
            }
        }
    }

    /// `Some(base HEAD)` when git truth says this task landed on the base.
    /// The commit message is deliberately not consulted — it may have been
    /// written by the agent.
    async fn merge_landed_commit(
        &self,
        task: &crate::db::entities::work_task::Model,
        state: &WorkTaskMergeState,
        root_path: &str,
    ) -> Result<Option<String>, String> {
        let head = task_git::rev_parse(root_path, "HEAD")
            .await
            .map_err(|e| e.to_string())?;
        if head == state.pre_merge_head {
            return Ok(None);
        }
        let Some(work_branch) = task.work_branch.as_deref() else {
            return Ok(None);
        };
        let ancestor = task_git::is_ancestor(root_path, work_branch, &head)
            .await
            .unwrap_or(false);
        let same_tree = task_git::trees_equal(root_path, &head, work_branch)
            .await
            .unwrap_or(false);
        Ok((ancestor || same_tree).then_some(head))
    }

    /// Clean a half-done landing out of the project folder: an in-progress
    /// merge (MERGE_HEAD) or a staged-but-uncommitted squash.
    async fn clean_merge_residue(&self, root_path: &str) {
        let residue = task_git::has_merge_head(root_path).await.unwrap_or(false)
            || !task_git::staged_clean(root_path).await.unwrap_or(true);
        if residue {
            let _ = task_git::reset_merge(root_path).await;
        }
    }

    async fn back_to_review(
        &self,
        task_id: i32,
        error: String,
        conflict_files: Option<Vec<String>>,
    ) {
        let _ = work_task_service::merge_back_to_review(
            &self.db.conn,
            task_id,
            Some(error),
            conflict_files,
        )
        .await;
        self.emit_upsert(task_id);
    }

    /// Resolve (project folder, worktree folder, base branch, work branch) or
    /// explain what's missing.
    async fn merge_coordinates(
        &self,
        task: &crate::db::entities::work_task::Model,
    ) -> Result<
        (
            crate::models::FolderDetail,
            crate::models::FolderDetail,
            String,
            String,
        ),
        String,
    > {
        let root = get_folder_core(&self.db, task.folder_id)
            .await
            .map_err(|e| e.to_string())?;
        let wt_id = task
            .worktree_folder_id
            .ok_or_else(|| "task has no worktree".to_string())?;
        let wt = get_folder_core(&self.db, wt_id)
            .await
            .map_err(|e| e.to_string())?;
        if !Path::new(&wt.path).exists() {
            return Err("the task worktree no longer exists on disk".to_string());
        }
        let base_branch = task
            .base_branch
            .clone()
            .ok_or_else(|| "task has no recorded base branch".to_string())?;
        let work_branch = task
            .work_branch
            .clone()
            .ok_or_else(|| "task has no recorded work branch".to_string())?;
        Ok((root, wt, base_branch, work_branch))
    }

    // ── merging crash recovery (git truth) ──────────────────────────────────

    /// Recover a task stuck in `merging` (crash / lost process) from git
    /// truth in the project folder. A merge generation with a live agent
    /// connection is not stuck — its TurnComplete settles it.
    pub async fn recover_merging(self: &Arc<Self>, task_id: i32) {
        if self.merging.lock().await.contains(&task_id) {
            return; // merge dispatch in flight in this process
        }
        let Ok(task) = work_task_service::get_model(&self.db.conn, task_id).await else {
            return;
        };
        if task.status != WorkTaskStatus::Merging {
            return;
        }
        if let Some(conn_id) = task.connection_id.as_deref() {
            if self.manager.get_state_and_emitter(conn_id).await.is_some() {
                return; // live merge generation — on_turn_complete owns the settle
            }
        }
        let Some(state) = task
            .merge_state
            .as_deref()
            .and_then(|s| serde_json::from_str::<WorkTaskMergeState>(s).ok())
        else {
            self.back_to_review(
                task_id,
                "merge state lost — please merge again".to_string(),
                None,
            )
            .await;
            return;
        };
        let Ok(root) = get_folder_core(&self.db, task.folder_id).await else {
            return;
        };

        let lock = self.folder_lock(task.folder_id).await;
        let _guard = lock.lock().await;
        // Re-read under the lock; an in-flight settle may have finished it.
        let Ok(current) = work_task_service::get_model(&self.db.conn, task_id).await else {
            return;
        };
        if current.status != WorkTaskStatus::Merging || current.run_seq != task.run_seq {
            return;
        }

        match self.merge_landed_commit(&current, &state, &root.path).await {
            Ok(Some(commit)) => {
                let landed = work_task_service::merge_landed(&self.db.conn, task_id, &commit)
                    .await
                    .unwrap_or(false);
                if landed {
                    self.emit_upsert(task_id);
                    if state.delete_worktree {
                        self.remove_worktree_locked(task_id).await;
                    }
                }
            }
            Ok(None) => {
                self.clean_merge_residue(&root.path).await;
                self.back_to_review(
                    task_id,
                    "the merge was interrupted before landing — merge again".to_string(),
                    None,
                )
                .await;
            }
            Err(e) => {
                self.back_to_review(task_id, format!("could not verify the merge: {e}"), None)
                    .await;
            }
        }
    }

    // ── worktree cleanup ────────────────────────────────────────────────────

    /// Remove a task's worktree + branch (user action from the card, or the
    /// post-merge checkbox). Takes the per-folder git lock.
    pub async fn cleanup_task(&self, task_id: i32) -> Result<(), String> {
        let task = work_task_service::get_model(&self.db.conn, task_id)
            .await
            .map_err(|e| e.to_string())?;
        if matches!(
            task.status,
            WorkTaskStatus::Queued | WorkTaskStatus::Running | WorkTaskStatus::AwaitingInput
                | WorkTaskStatus::Merging
        ) {
            return Err("cancel or finish the task before removing its worktree".to_string());
        }
        let lock = self.folder_lock(task.folder_id).await;
        let _guard = lock.lock().await;
        self.remove_worktree_locked(task_id).await;
        self.emit_upsert(task_id);
        Ok(())
    }

    /// Git-first-then-DB worktree removal. Caller holds the folder git lock.
    ///
    /// Order matters: the git removal runs first; only after it succeeds does
    /// the DB transaction re-parent the worktree's conversations onto the
    /// project folder (stamping `origin_cwd`), close its tabs, and soft-delete
    /// the folder row. A git failure flags `cleanup_state='failed'` (retryable
    /// from the card) and leaves the DB untouched; a `done` task never leaves
    /// `done` either way.
    async fn remove_worktree_locked(&self, task_id: i32) {
        let Ok(task) = work_task_service::get_model(&self.db.conn, task_id).await else {
            return;
        };
        let Some(wt_id) = task.worktree_folder_id else {
            return;
        };
        // Precondition: no live connection of ours on this task.
        let has_conn = {
            self.index
                .lock()
                .await
                .values()
                .any(|(tid, _)| *tid == task_id)
        };
        if has_conn {
            let _ = work_task_service::set_cleanup_state(
                &self.db.conn,
                task_id,
                true,
                Some("task still has a live agent connection".to_string()),
            )
            .await;
            return;
        }

        let root = match get_folder_core(&self.db, task.folder_id).await {
            Ok(r) => r,
            Err(e) => {
                let _ = work_task_service::set_cleanup_state(
                    &self.db.conn,
                    task_id,
                    true,
                    Some(e.to_string()),
                )
                .await;
                return;
            }
        };
        let Ok(wt) = get_folder_core(&self.db, wt_id).await else {
            // Folder row already gone — just detach.
            let _ = work_task_service::clear_worktree(&self.db.conn, task_id).await;
            return;
        };

        if let Err(e) = task_git::remove_worktree_and_branch(
            &root.path,
            &wt.path,
            task.work_branch.as_deref(),
        )
        .await
        {
            let _ = work_task_service::set_cleanup_state(
                &self.db.conn,
                task_id,
                true,
                Some(e.to_string()),
            )
            .await;
            return;
        }

        // Git succeeded — converge the DB. Conversations first (so they are
        // never orphaned under a vanishing folder), then tabs, then the folder
        // row itself.
        let moved = conversation_service::reparent_folder_conversations(
            &self.db.conn,
            wt_id,
            task.folder_id,
            &wt.path,
        )
        .await
        .unwrap_or(0);

        match tab_service::delete_folder_tabs_and_bump(&self.db.conn, wt_id).await {
            Ok(inv) => {
                if let Some(tabs) = inv.emit {
                    emit_event(
                        &self.emitter,
                        crate::web::event_bridge::TABS_CHANGED_EVENT,
                        crate::web::event_bridge::TabsChanged {
                            version: inv.version,
                            origin: "server".to_string(),
                            tabs,
                        },
                    );
                }
            }
            Err(e) => tracing::warn!("[work_task] tab cleanup failed for folder {wt_id}: {e}"),
        }

        if let Ok(Some(row)) = folder::Entity::find_by_id(wt_id).one(&self.db.conn).await {
            let mut active = row.into_active_model();
            active.is_open = Set(false);
            active.deleted_at = Set(Some(chrono::Utc::now()));
            active.updated_at = Set(chrono::Utc::now());
            let _ = active.update(&self.db.conn).await;
        }

        let _ = work_task_service::clear_worktree(&self.db.conn, task_id).await;
        let _ = work_task_service::record_event(
            &self.db.conn,
            task_id,
            "user_action",
            "engine",
            Some(serde_json::json!({ "action": "cleanup", "reparented": moved })),
        )
        .await;

        // Nudge every client to refetch conversations/folders — the worktree
        // folder is gone and its conversations moved to the project folder.
        emit_event(
            &self.emitter,
            crate::web::event_bridge::CONVERSATIONS_BULK_CHANGED_EVENT,
            crate::web::event_bridge::ConversationsBulkChanged {
                imported: 0,
                updated: moved as u32,
                folder_ids: vec![task.folder_id],
            },
        );
    }

    // ── reconcile ───────────────────────────────────────────────────────────

    async fn reconcile_once(self: &Arc<Self>) {
        // running / awaiting_input whose worker died without a TurnComplete.
        let active = work_task_service::list_by_status(
            &self.db.conn,
            &[WorkTaskStatus::Running, WorkTaskStatus::AwaitingInput],
        )
        .await
        .unwrap_or_default();
        for task in active {
            let Some(conn_id) = task.connection_id.clone() else {
                continue;
            };
            if self.manager.get_state_and_emitter(&conn_id).await.is_some() {
                continue; // live — on_event settles it authoritatively
            }
            // Connection gone. If the produced conversation reached a terminal
            // status the TurnComplete was merely dropped — settle from it.
            self.index.lock().await.remove(&conn_id);
            self.awaiting.lock().await.remove(&task.id);
            let conv_status = match task.conversation_id {
                Some(cid) => self.conversation_status(cid).await,
                None => None,
            };
            let changed = match conv_status {
                Some(ConversationStatus::PendingReview) | Some(ConversationStatus::Completed) => {
                    let stats = self.snapshot_diff_stats(task.id).await;
                    work_task_service::settle_review(
                        &self.db.conn,
                        task.id,
                        task.run_seq,
                        None,
                        stats,
                    )
                    .await
                    .unwrap_or(false)
                }
                Some(ConversationStatus::Cancelled) => {
                    work_task_service::cancel(&self.db.conn, task.id)
                        .await
                        .unwrap_or(false)
                }
                _ => work_task_service::fail(
                    &self.db.conn,
                    task.id,
                    &[WorkTaskStatus::Running, WorkTaskStatus::AwaitingInput],
                    Some(task.run_seq),
                    "interrupted",
                    Some("task lost its worker".to_string()),
                )
                .await
                .unwrap_or(false),
            };
            if changed {
                self.emit_upsert(task.id);
            }
        }

        // merging not owned by this process's in-flight merges → git truth.
        // Spawned off-thread: recovery waits on the per-folder git lock, and an
        // in-flight merge on that folder must not stall the event loop here.
        let merging = work_task_service::list_by_status(&self.db.conn, &[WorkTaskStatus::Merging])
            .await
            .unwrap_or_default();
        for task in merging {
            let engine = self.clone();
            tokio::spawn(async move {
                engine.recover_merging(task.id).await;
                engine.pump_folder(task.folder_id).await;
            });
        }

        // Pending backlog: queued tasks whose slot freed while no event fired,
        // plus todo tasks of auto_process folders (the pump checks the flag).
        for folder_id in work_task_service::folders_with_pending(&self.db.conn)
            .await
            .unwrap_or_default()
        {
            self.pump_folder(folder_id).await;
        }
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    async fn task_lock(&self, task_id: i32) -> Arc<Mutex<()>> {
        let mut locks = self.task_locks.lock().await;
        locks
            .entry(task_id)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    async fn folder_lock(&self, folder_id: i32) -> Arc<Mutex<()>> {
        let mut locks = self.folder_locks.lock().await;
        locks
            .entry(folder_id)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    fn emit_upsert(&self, task_id: i32) {
        emit_event(
            &self.emitter,
            WORK_TASK_CHANGED_EVENT,
            WorkTaskChange::Upsert { id: task_id },
        );
    }

    fn emit_changed_all(&self) {
        emit_event(
            &self.emitter,
            WORK_TASK_CHANGED_EVENT,
            WorkTaskChange::Refresh,
        );
    }

    async fn conversation_status(&self, conv_id: i32) -> Option<ConversationStatus> {
        conversation::Entity::find_by_id(conv_id)
            .one(&self.db.conn)
            .await
            .ok()
            .flatten()
            .map(|m| m.status)
    }

    async fn cancel_conversation(&self, conversation_id: i32) {
        if let Ok(Some(row)) = conversation::Entity::find_by_id(conversation_id)
            .one(&self.db.conn)
            .await
        {
            let mut active = row.into_active_model();
            active.status = Set(ConversationStatus::Cancelled);
            if active.update(&self.db.conn).await.is_ok() {
                emit_conversation_upsert(&self.emitter, &self.db.conn, conversation_id).await;
            }
        }
    }
}

struct WorktreeRef {
    folder_id: i32,
    path: String,
    /// The worktree was created by this call (→ run the init command).
    created: bool,
}

/// Pick the launch mode for a pump-driven launch from the task's history: a
/// task with a prior conversation continues (retry semantics); a pristine one
/// starts fresh. Explicit returns launch directly with `LaunchMode::Return`.
fn launch_mode_for(task: &crate::db::entities::work_task::Model) -> LaunchMode {
    if task.conversation_id.is_some() {
        LaunchMode::Retry
    } else {
        LaunchMode::Fresh
    }
}

/// Layered agent config: task override wins wholesale; else the folder's task
/// settings; else the folder's default agent with no extra options.
fn effective_agent_config(
    cfg: &WorkTaskConfig,
    settings: &WorkTaskFolderSettings,
    root: &crate::models::FolderDetail,
) -> (
    Option<String>,
    Option<String>,
    std::collections::BTreeMap<String, String>,
) {
    if let Some(agent) = cfg.agent_type.clone() {
        return (Some(agent), cfg.mode_id.clone(), cfg.config_values.clone());
    }
    if let Some(agent) = settings.default_agent_type.clone() {
        return (
            Some(agent),
            settings.mode_id.clone(),
            settings.config_values.clone(),
        );
    }
    let folder_default = root
        .default_agent_type
        .as_ref()
        .and_then(|a| serde_json::to_value(a).ok())
        .and_then(|v| v.as_str().map(String::from));
    (
        folder_default,
        settings.mode_id.clone(),
        settings.config_values.clone(),
    )
}

/// Compose the prompt for a launch mode. Fresh runs replay the task's blocks.
/// Retry/return compose against the session we actually got: a resumed session
/// already carries the task context, while a fresh fallback session needs the
/// full original description again. Every prompt ends with the worktree guard.
async fn compose_prompt(
    cfg: &WorkTaskConfig,
    task: &crate::db::entities::work_task::Model,
    mode: &LaunchMode,
    resumed: bool,
    conn: &sea_orm::DatabaseConnection,
) -> Result<Vec<PromptInputBlock>, String> {
    let mut blocks: Vec<PromptInputBlock> = Vec::new();
    let original: Vec<PromptInputBlock> = cfg
        .prompt_blocks
        .iter()
        .map(|v| serde_json::from_value::<PromptInputBlock>(v.clone()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("bad prompt blocks: {e}"))?;

    match mode {
        LaunchMode::Fresh => {
            if original.is_empty() {
                return Err("prompt is empty".to_string());
            }
            blocks.extend(original);
        }
        LaunchMode::Retry => {
            blocks.push(PromptInputBlock::Text {
                text: "The previous run of this task was interrupted. Continue working in \
                       this worktree and complete the task."
                    .to_string(),
            });
            if !resumed {
                blocks.push(PromptInputBlock::Text {
                    text: "The original task follows for reference:".to_string(),
                });
                blocks.extend(original);
            }
            // Include the latest review feedback (if the interruption happened
            // after a return) so it is never lost across restarts.
            if let Some(feedback) = latest_return_feedback(conn, task.id).await {
                blocks.push(PromptInputBlock::Text {
                    text: format!("Latest review feedback to address:\n{feedback}"),
                });
            }
        }
        LaunchMode::Return(feedback) => {
            if !resumed {
                // Session resume failed — the fresh session has no context, so
                // replay the task before the feedback.
                blocks.push(PromptInputBlock::Text {
                    text: "You are picking up a task whose previous session could not be \
                           resumed. The worktree already contains that session's work. \
                           The original task was:"
                        .to_string(),
                });
                blocks.extend(original);
            }
            blocks.push(PromptInputBlock::Text {
                text: format!(
                    "The user reviewed your work on this task and returned it with the \
                     following feedback. Address it in this same worktree:\n\n{feedback}"
                ),
            });
        }
        LaunchMode::Merge {
            root_path,
            base_branch,
            work_branch,
            strategy,
            message,
        } => {
            if !resumed {
                blocks.push(PromptInputBlock::Text {
                    text: "You are picking up a task whose previous session could not be \
                           resumed. The worktree already contains that session's work. \
                           The original task was:"
                        .to_string(),
                });
                blocks.extend(original);
            }
            let land_command = if strategy == "merge" {
                format!(
                    "git -C \"{root_path}\" merge --no-ff -m \"<message>\" {work_branch}"
                )
            } else {
                format!(
                    "git -C \"{root_path}\" merge --squash {work_branch} && \
                     git -C \"{root_path}\" commit -m \"<message>\""
                )
            };
            let message_rule = match message {
                Some(m) => format!("Use exactly this commit message:\n{m}"),
                None => "Write a concise Conventional Commits message yourself, \
                         summarizing what this task changed."
                    .to_string(),
            };
            blocks.push(PromptInputBlock::Text {
                text: format!(
                    "The user accepted this task — land it onto the base branch \
                     `{base_branch}` now, doing all git operations yourself:\n\
                     1. Commit any uncommitted changes in this worktree to the current \
                     branch (`{work_branch}`).\n\
                     2. Run `git merge {base_branch}` here and resolve every conflict so \
                     both the base's changes and this task's intent survive; complete the \
                     merge commit.\n\
                     3. Land onto the base checkout at `{root_path}`:\n   {land_command}\n\
                     {message_rule}\n\
                     Do NOT push, do NOT delete this worktree or its branch, and do not \
                     change anything else on the base branch. Finish with one short line \
                     saying what landed."
                ),
            });
        }
    }

    // The standing worktree guard — a merge generation replaces it with its
    // own instructions (it exists to forbid exactly what a merge must do).
    if !matches!(mode, LaunchMode::Merge { .. }) {
        blocks.push(PromptInputBlock::Text {
            text: format!(
                "—— Work task context ——\nYou are working inside a dedicated git worktree for \
                 this task{}. Commit to the current branch as you like, but do NOT merge into, \
                 rebase onto, or push the base branch{} — the user lands the result after review. \
                 Finish with a short summary of what you did.\nIf the `task_progress` and \
                 `task_complete` tools are available to you, report milestones with \
                 `task_progress` as you go, and call `task_complete` once right before you \
                 finish (verdict `success`, `needs_review`, or `blocked`, plus a short summary).",
                task.work_branch
                    .as_deref()
                    .map(|b| format!(" (branch `{b}`)"))
                    .unwrap_or_default(),
                task.base_branch
                    .as_deref()
                    .map(|b| format!(" (`{b}`)"))
                    .unwrap_or_default(),
            ),
        });
    }
    Ok(blocks)
}

/// The feedback text of the most recent "return" user action, if any.
async fn latest_return_feedback(
    conn: &sea_orm::DatabaseConnection,
    task_id: i32,
) -> Option<String> {
    let events = work_task_service::list_events(conn, task_id, 500).await.ok()?;
    events
        .into_iter()
        .rev()
        .filter(|e| e.kind == "user_action")
        .find_map(|e| {
            let p = e.payload?;
            if p.get("action")?.as_str()? != "return" {
                return None;
            }
            p.get("feedback")?.as_str().map(String::from)
        })
}

async fn still_expected(
    conn: &sea_orm::DatabaseConnection,
    task_id: i32,
    run_seq: i32,
    expected: WorkTaskStatus,
) -> bool {
    matches!(
        work_task_service::get_model(conn, task_id).await,
        Ok(t) if t.status == expected && t.run_seq == run_seq
    )
}

/// Head of the first text block of a prompt — the transcript viewer matches
/// user turns against it to place round dividers.
fn prompt_head(blocks: &[PromptInputBlock]) -> String {
    blocks
        .iter()
        .find_map(|b| match b {
            PromptInputBlock::Text { text } => Some(first_chars(text.trim(), 160)),
            _ => None,
        })
        .unwrap_or_default()
}

/// Run one shell command line in `cwd`, capturing combined output. stdin is
/// null (a command waiting on input sees EOF); no timeout by design — the
/// result write is generation-guarded, so a runaway command can only waste its
/// own process. Returns (exit code, trailing output capped to
/// `PREFLIGHT_TAIL_CHARS`).
async fn run_shell_capture(line: &str, cwd: &str) -> Result<(Option<i32>, String), String> {
    #[cfg(not(windows))]
    let mut command = {
        let mut c = crate::process::tokio_command("/bin/sh");
        c.arg("-c").arg(line);
        c
    };
    #[cfg(windows)]
    let mut command = {
        let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
        let mut c = crate::process::tokio_command(comspec);
        c.arg("/C").arg(line);
        c
    };
    command.current_dir(cwd);
    let out = command.output().await.map_err(|e| e.to_string())?;
    let mut combined = String::from_utf8_lossy(&out.stdout).into_owned();
    combined.push_str(&String::from_utf8_lossy(&out.stderr));
    Ok((out.status.code(), tail_chars(&combined, PREFLIGHT_TAIL_CHARS)))
}

fn tail_chars(s: &str, n: usize) -> String {
    let trimmed = s.trim_end();
    let count = trimmed.chars().count();
    if count <= n {
        return trimmed.to_string();
    }
    trimmed.chars().skip(count - n).collect()
}

fn parse_agent_type(s: &str) -> Result<AgentType, String> {
    serde_json::from_value(serde_json::Value::String(s.to_string()))
        .map_err(|_| format!("unknown agent type: {s}"))
}

fn first_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn basename(path: &str) -> &str {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path)
}

fn sibling_path(root_path: &str, name: &str) -> String {
    let trimmed = root_path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(idx) => format!("{}/{}", &trimmed[..idx], name),
        None => name.to_string(),
    }
}

/// codeg-mcp `task_progress` / `task_complete` access handed to the delegation
/// listener at boot. Resolves the process-global engine at CALL time — the
/// listener is constructed before the engine, and a process that never wins the
/// engine lock cleanly rejects every report.
pub struct EngineWorkTaskTools;

#[async_trait::async_trait]
impl WorkTaskToolAccess for EngineWorkTaskTools {
    async fn report_progress(&self, parent_connection_id: &str, message: &str) -> TaskReportAck {
        let Some(engine) = engine() else {
            return TaskReportAck::rejected("no task engine running in this process");
        };
        engine.record_progress(parent_connection_id, message).await
    }

    async fn complete(
        &self,
        parent_connection_id: &str,
        verdict: &str,
        summary: Option<&str>,
    ) -> TaskReportAck {
        let Some(engine) = engine() else {
            return TaskReportAck::rejected("no task engine running in this process");
        };
        engine
            .record_complete(parent_connection_id, verdict, summary)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worktree_names_carry_ids() {
        assert_eq!(basename("/home/me/repo"), "repo");
        assert_eq!(
            sibling_path("/home/me/repo", "repo-task-7"),
            "/home/me/repo-task-7"
        );
    }

    #[test]
    fn prompt_head_takes_the_first_text_block() {
        let blocks = vec![PromptInputBlock::Text {
            text: "  Fix the login flow and add tests.  ".to_string(),
        }];
        assert_eq!(prompt_head(&blocks), "Fix the login flow and add tests.");
        assert_eq!(prompt_head(&[]), "");
    }

    #[test]
    fn engine_lock_is_per_data_dir() {
        let dir = tempfile::tempdir().expect("temp dir");
        let guard = match acquire_engine_ownership(dir.path()) {
            Ownership::Exclusive(f) => f,
            _ => panic!("first acquisition should win"),
        };
        assert!(matches!(
            acquire_engine_ownership(dir.path()),
            Ownership::Taken
        ));
        // Independent of the automation engine's lock file in the same dir.
        let automation_lock = dir
            .path()
            .join(format!("{}.lock", crate::db::database_file_name()));
        assert!(!automation_lock.exists());
        drop(guard);
    }
}
