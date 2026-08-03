use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// Lifecycle of a work task. The pipeline is
/// `todo → queued → running ⇄ awaiting_input → review → merging → done`, with
/// `failed` / `canceled` as side paths. Two hard invariants:
/// - `done` ⟺ merged: only the merge landing (or its crash recovery) writes
///   `done`, and `done` never rolls back.
/// - Every transition is a conditional UPDATE (CAS) guarded by the expected
///   status (and, for engine-driven transitions, the current `run_seq`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum WorkTaskStatus {
    #[sea_orm(string_value = "todo")]
    Todo,
    /// Claimed for execution; waiting for (or undergoing) launch.
    #[sea_orm(string_value = "queued")]
    Queued,
    #[sea_orm(string_value = "running")]
    Running,
    /// The agent is blocked on a question / permission / plan approval.
    #[sea_orm(string_value = "awaiting_input")]
    AwaitingInput,
    /// Agent finished; waiting for the user to accept (merge), return, or drop.
    #[sea_orm(string_value = "review")]
    Review,
    /// Merge in flight — the only state the user cannot cancel.
    #[sea_orm(string_value = "merging")]
    Merging,
    #[sea_orm(string_value = "done")]
    Done,
    #[sea_orm(string_value = "failed")]
    Failed,
    /// Not a dead end: requeue moves it back to `todo` (worktree reused).
    #[sea_orm(string_value = "canceled")]
    Canceled,
}

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "work_task")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    /// The project folder (never a worktree folder). Soft reference; every
    /// query joins the live folder.
    pub folder_id: i32,
    pub title: String,
    /// JSON `WorkTaskConfig` — per-task overrides; empty fields inherit the
    /// folder's `work_task_settings`.
    #[sea_orm(column_type = "Text")]
    pub config: String,
    pub status: WorkTaskStatus,
    /// agent_error | setup_error | verdict_blocked | interrupted
    pub failure_reason: Option<String>,
    pub last_error: Option<String>,
    /// Execution generation: bumped whenever a new run is claimed
    /// (start / retry / return). Events match on (connection_id, run_seq);
    /// anything stale is dropped.
    pub run_seq: i32,
    pub sort_order: i32,
    pub worktree_folder_id: Option<i32>,
    pub conversation_id: Option<i32>,
    /// Live ACP connection of the current generation. Not durable across
    /// restart (a fresh process has no live connections).
    pub connection_id: Option<String>,
    pub base_branch: Option<String>,
    /// The exact commit the worktree branched from — recorded BEFORE the
    /// worktree is created so a concurrent branch switch can't drift it.
    pub base_sha: Option<String>,
    pub work_branch: Option<String>,
    /// JSON `WorkTaskMergeState` — the merge intent persisted in the same
    /// transaction as the review→merging CAS; crash recovery reads git truth
    /// against it.
    #[sea_orm(column_type = "Text")]
    pub merge_state: Option<String>,
    /// JSON `WorkTaskPendingMerge` — the auto-remerge intent carried across a
    /// conflict-repair cycle (P2). Set when a stage-A conflict dispatches the
    /// agent, consumed when the repaired run settles into review; cleared by
    /// every user-driven claim / cancel / failure.
    #[sea_orm(column_type = "Text")]
    pub pending_merge: Option<String>,
    /// NULL = nothing pending; 'failed' = worktree cleanup failed (retryable).
    pub cleanup_state: Option<String>,
    /// success | needs_review | blocked (P1, agent self-report via MCP).
    pub verdict: Option<String>,
    pub result_summary: Option<String>,
    pub files_changed: Option<i32>,
    pub additions: Option<i32>,
    pub deletions: Option<i32>,
    pub merge_commit: Option<String>,
    /// JSON `WorkTaskPreflight` — result of the folder's preflight command run
    /// when this generation settled into review (P2 acceptance light).
    #[sea_orm(column_type = "Text")]
    pub preflight: Option<String>,
    /// Archived (hidden from the default board view); terminal statuses only.
    /// Cleared by any resurrection (retry / requeue / return).
    pub archived_at: Option<DateTimeUtc>,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
    pub started_at: Option<DateTimeUtc>,
    /// Entered review / failed.
    pub settled_at: Option<DateTimeUtc>,
    /// Entered done / canceled.
    pub finished_at: Option<DateTimeUtc>,
    pub deleted_at: Option<DateTimeUtc>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "super::work_task_event::Entity")]
    Events,
    #[sea_orm(
        belongs_to = "super::folder::Entity",
        from = "Column::FolderId",
        to = "super::folder::Column::Id"
    )]
    Folder,
}

impl Related<super::work_task_event::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Events.def()
    }
}

impl Related<super::folder::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Folder.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
