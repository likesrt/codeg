//! In-place self-update endpoints for the standalone server / Docker
//! runtime: download+verify+swap (`perform_app_update`), relaunch
//! (`restart_app`), and revert (`rollback_app`).
//!
//! All three are gated behind the process-wide `system_op_lock` so a second
//! click can't race a download already in flight. On desktop (Tauri) builds
//! they hard-error — desktop updates through `tauri-plugin-updater`.

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Serialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::update::runtime::UpdateCapability;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateActionResult {
    /// Version installed (perform) — absent for restart/rollback.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Whether the caller should follow up with `restart_app`.
    pub need_restart: bool,
    /// Relaunch delay (ms) the frontend countdown should use.
    pub restart_delay_ms: u64,
    /// Supervisor probation window (seconds) during which a freshly-upgraded
    /// worker that crashes is auto-rolled-back. 0 when there is no supervisor
    /// (re-exec mode): no auto-rollback, so the frontend need not wait it out.
    pub trial_seconds: u64,
    pub capability: UpdateCapability,
}

pub async fn perform_app_update(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<UpdateActionResult>, AppCommandError> {
    perform_impl(state).await.map(Json)
}

pub async fn restart_app(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<UpdateActionResult>, AppCommandError> {
    restart_impl(state).map(Json)
}

pub async fn rollback_app(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<UpdateActionResult>, AppCommandError> {
    rollback_impl(state).await.map(Json)
}

// ─── desktop build: not supported ────────────────────────────────────────

#[cfg(feature = "tauri-runtime")]
async fn perform_impl(_state: Arc<AppState>) -> Result<UpdateActionResult, AppCommandError> {
    Err(not_supported())
}

#[cfg(feature = "tauri-runtime")]
fn restart_impl(_state: Arc<AppState>) -> Result<UpdateActionResult, AppCommandError> {
    Err(not_supported())
}

#[cfg(feature = "tauri-runtime")]
async fn rollback_impl(_state: Arc<AppState>) -> Result<UpdateActionResult, AppCommandError> {
    Err(not_supported())
}

#[cfg(feature = "tauri-runtime")]
fn not_supported() -> AppCommandError {
    AppCommandError::invalid_input("In-place update is only available in server mode")
}

// ─── server build: the real thing ────────────────────────────────────────

#[cfg(not(feature = "tauri-runtime"))]
fn busy() -> AppCommandError {
    AppCommandError::already_exists("An update operation is already in progress")
}

/// Refuse on platforms where in-place self-update is not validated. Windows
/// server self-update is disabled (running-.exe swap + re-exec rebind are
/// untested there); the desktop Windows app updates via tauri-plugin-updater.
/// The probation window the frontend should wait out before declaring success,
/// in seconds — only meaningful under the supervisor (which performs the
/// auto-rollback). Re-exec mode has no supervisor, hence no trial.
#[cfg(not(feature = "tauri-runtime"))]
fn trial_seconds_value() -> u64 {
    match crate::update::runtime::capability() {
        UpdateCapability::Supervised => crate::update::runtime::upgrade_trial_secs(),
        _ => 0,
    }
}

#[cfg(not(feature = "tauri-runtime"))]
fn ensure_supported() -> Result<(), AppCommandError> {
    if cfg!(target_os = "windows") {
        return Err(AppCommandError::invalid_input(
            "In-place server self-update is not supported on Windows yet",
        ));
    }
    Ok(())
}

#[cfg(not(feature = "tauri-runtime"))]
async fn perform_impl(state: Arc<AppState>) -> Result<UpdateActionResult, AppCommandError> {
    use crate::update::install::UpdatePhase;

    ensure_supported()?;

    // Hold the lock for the whole download/verify/swap so a concurrent
    // perform/restart/rollback is rejected rather than racing the swap.
    let _guard = state.system_op_lock.try_lock().map_err(|_| busy())?;

    let emitter = state.emitter.clone();
    let progress = move |phase: UpdatePhase, downloaded: u64, total: Option<u64>| {
        crate::web::event_bridge::emit_event(
            &emitter,
            "app_update_progress",
            serde_json::json!({
                "phase": phase,
                "downloaded": downloaded,
                "total": total,
            }),
        );
    };

    let outcome = crate::update::install::perform_update(&state.data_dir, &progress).await?;

    Ok(UpdateActionResult {
        version: Some(outcome.version),
        need_restart: true,
        restart_delay_ms: crate::update::runtime::restart_delay_ms(),
        trial_seconds: trial_seconds_value(),
        capability: crate::update::runtime::capability(),
    })
}

#[cfg(not(feature = "tauri-runtime"))]
fn restart_impl(state: Arc<AppState>) -> Result<UpdateActionResult, AppCommandError> {
    ensure_supported()?;
    // Take the lock and hold it until the process exits, so a perform/rollback
    // can't start in the flush window and then be killed by the restart.
    let guard = state
        .system_op_lock
        .clone()
        .try_lock_owned()
        .map_err(|_| busy())?;
    let restart_delay_ms = crate::update::runtime::restart_delay_ms();
    // Responds first, then exits/re-execs after a short flush delay.
    crate::update::schedule_restart(guard);
    Ok(UpdateActionResult {
        version: None,
        need_restart: false,
        restart_delay_ms,
        trial_seconds: trial_seconds_value(),
        capability: crate::update::runtime::capability(),
    })
}

#[cfg(not(feature = "tauri-runtime"))]
async fn rollback_impl(state: Arc<AppState>) -> Result<UpdateActionResult, AppCommandError> {
    ensure_supported()?;
    // Revert and relaunch under a *single* held lock, the same way the upgrade
    // path's restart does. Rollback clears the staged marker, so without this an
    // owned lock spanning revert→exit, a concurrent `perform_app_update` could
    // slip into the gap between a separate rollback and restart and stage a new
    // version that the restart would then boot instead of the reverted one.
    let guard = state
        .system_op_lock
        .clone()
        .try_lock_owned()
        .map_err(|_| busy())?;
    crate::update::install::rollback()?;
    let restart_delay_ms = crate::update::runtime::restart_delay_ms();
    // Responds first, then exits/re-execs after a short flush delay — the lock
    // is held until the process dies, so nothing can race the relaunch.
    crate::update::schedule_restart(guard);
    Ok(UpdateActionResult {
        version: None,
        // Restart is already scheduled server-side; the client must not issue a
        // separate `restart_app` (which would just contend for the held lock).
        need_restart: false,
        restart_delay_ms,
        trial_seconds: 0,
        capability: crate::update::runtime::capability(),
    })
}
