use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// Lifecycle of a single automation run. `running` is set at claim/launch;
/// `skipped` records a fire suppressed because a prior run was still active;
/// boot recovery folds interrupted runs into `failed` with an `error` reason.
#[derive(Debug, Clone, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum AutomationRunStatus {
    #[sea_orm(string_value = "running")]
    Running,
    #[sea_orm(string_value = "succeeded")]
    Succeeded,
    #[sea_orm(string_value = "failed")]
    Failed,
    #[sea_orm(string_value = "cancelled")]
    Cancelled,
    #[sea_orm(string_value = "skipped")]
    Skipped,
}

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "automation_run")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub automation_id: i32,
    pub status: AutomationRunStatus,
    /// 'schedule' | 'manual' — provenance of this run.
    pub trigger: String,
    /// The UTC instant this run was scheduled for (audit of which slot a crash
    /// missed). `None` for manual runs.
    pub scheduled_for: Option<DateTimeUtc>,
    pub started_at: Option<DateTimeUtc>,
    pub ended_at: Option<DateTimeUtc>,
    /// The lazily-created produced conversation. SET NULL if it is deleted, so the
    /// run history survives.
    pub conversation_id: Option<i32>,
    /// In-process ACP connection UUID, for live completion correlation. Not durable
    /// across restart (a fresh process has no live connections).
    pub connection_id: Option<String>,
    /// Worktree folder minted for this run (worktree_per_run), for GC / opening.
    pub worktree_folder_id: Option<i32>,
    /// Raw end_turn / refusal / max_tokens / cancelled — the settle authority.
    pub stop_reason: Option<String>,
    pub error: Option<String>,
    pub summary: Option<String>,
    pub created_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::automation::Entity",
        from = "Column::AutomationId",
        to = "super::automation::Column::Id"
    )]
    Automation,
}

impl Related<super::automation::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Automation.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
