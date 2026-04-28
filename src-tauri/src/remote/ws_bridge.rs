// WebSocket event bridge: subscribes to a remote daemon's `/ws/events`
// stream and re-emits every frame on the desktop's local `EventEmitter`.
// One bridge runs per Live SSH connection; it is spawned alongside the
// reconnect supervisor and torn down via the same kill-switch.
//
// Wire format (matches `web::event_bridge::WebEvent`):
//   { "channel": "<event-name>", "payload": <arbitrary JSON> }
//
// The bridge is intentionally dumb: it forwards every event regardless of
// channel name. Routing back to specific frontend connections happens via
// the standard envelope `connection_id` field already embedded in payloads.
//
// A1 limitation: if the WS connection itself drops (e.g. mid-air mux
// reset) but the daemon is still healthy, the bridge exits and events are
// silently lost until the next reconnect supervisor cycle re-spawns it.
// A future iteration adds in-bridge retry.

use serde::Deserialize;
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::Message;

use crate::web::event_bridge::{emit_event, EventEmitter};

#[derive(Debug, Deserialize)]
struct DaemonEventFrame {
    channel: String,
    payload: serde_json::Value,
}

/// Run a bridge against `ws://127.0.0.1:<local_port>/ws/events?token=...`.
///
/// The bridge auths via the `?token=` query string (matches
/// `web::auth::require_token`). It returns when:
///   - the killer fires (graceful shutdown),
///   - the daemon closes the socket,
///   - the WS handshake or any subsequent read fails.
pub async fn bridge_loop(
    local_port: u16,
    token: String,
    emitter: EventEmitter,
    mut killer: oneshot::Receiver<()>,
) {
    let url = format!(
        "ws://127.0.0.1:{}/ws/events?token={}",
        local_port,
        urlencoding::encode(&token)
    );
    let (ws_stream, _) = match tokio_tungstenite::connect_async(&url).await {
        Ok(pair) => pair,
        Err(e) => {
            eprintln!("[Remote ws-bridge] connect failed: {e}");
            return;
        }
    };

    use futures_util::StreamExt;
    let (_write, mut read) = ws_stream.split();

    loop {
        tokio::select! {
            biased;
            _ = &mut killer => return,
            msg = read.next() => {
                let Some(msg) = msg else { return; };
                let msg = match msg {
                    Ok(m) => m,
                    Err(e) => {
                        eprintln!("[Remote ws-bridge] read error: {e}");
                        return;
                    }
                };
                match msg {
                    Message::Text(text) => relay_frame(&emitter, &text),
                    Message::Binary(_)
                    | Message::Ping(_)
                    | Message::Pong(_)
                    | Message::Frame(_) => {}
                    Message::Close(_) => return,
                }
            }
        }
    }
}

fn relay_frame(emitter: &EventEmitter, text: &str) {
    let frame: DaemonEventFrame = match serde_json::from_str(text) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[Remote ws-bridge] frame parse error: {e}");
            return;
        }
    };
    emit_event(emitter, &frame.channel, frame.payload);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_round_trip() {
        let raw = r#"{"channel":"acp://event","payload":{"connection_id":"abc","type":"agent_message_start"}}"#;
        let frame: DaemonEventFrame = serde_json::from_str(raw).unwrap();
        assert_eq!(frame.channel, "acp://event");
        assert_eq!(
            frame.payload.get("connection_id").and_then(|v| v.as_str()),
            Some("abc")
        );
    }
}
