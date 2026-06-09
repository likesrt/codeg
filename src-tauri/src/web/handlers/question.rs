//! HTTP handlers for ask-user-question settings — the web-mode mirror of the
//! Tauri commands in `commands::question`.
//!
//! Both endpoints share the same core helpers (`load_question_settings`,
//! `set_question_settings_core`) so the persist + runtime-config re-apply
//! behavior stays identical across transports. (Answering a pending question is
//! an ACP operation and lives in `web::handlers::acp::acp_answer_question`.)

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::question::{
    load_question_settings, set_question_settings_core, QuestionSettings,
};

pub async fn get_question_settings(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<QuestionSettings>, AppCommandError> {
    Ok(Json(load_question_settings(&state.db.conn).await))
}

#[derive(Deserialize)]
pub struct SetQuestionSettingsParams {
    pub settings: QuestionSettings,
}

pub async fn set_question_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SetQuestionSettingsParams>,
) -> Result<Json<QuestionSettings>, AppCommandError> {
    let saved = set_question_settings_core(
        &state.db.conn,
        &state.question_config,
        &state.emitter,
        params.settings,
    )
    .await?;
    Ok(Json(saved))
}
