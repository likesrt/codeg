//! HTTP handlers for get-session-info settings — the web-mode mirror of the
//! Tauri commands in `commands::session_info`.
//!
//! Both endpoints share the same core helpers (`load_session_info_settings`,
//! `set_session_info_settings_core`) so the persist + runtime-config re-apply
//! behavior stays identical across transports.

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::session_info::{
    load_session_info_settings, set_session_info_settings_core, SessionInfoSettings,
};

pub async fn get_session_info_settings(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<SessionInfoSettings>, AppCommandError> {
    Ok(Json(load_session_info_settings(&state.db.conn).await))
}

#[derive(Deserialize)]
pub struct SetSessionInfoSettingsParams {
    pub settings: SessionInfoSettings,
}

pub async fn set_session_info_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SetSessionInfoSettingsParams>,
) -> Result<Json<SessionInfoSettings>, AppCommandError> {
    let saved = set_session_info_settings_core(
        &state.db.conn,
        &state.session_info_config,
        &state.emitter,
        params.settings,
    )
    .await?;
    Ok(Json(saved))
}
