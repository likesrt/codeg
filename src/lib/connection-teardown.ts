/**
 * Shared gate for the ACP connection teardowns that fire on their own — no
 * user asked for them — so they can't drift apart:
 *
 *   * the tab-unmount cleanup (`shouldDisconnectOnUnmount`)
 *   * the preview-tab release (`disconnectIfIdle`), fired when the next
 *     single-click in the sidebar takes the preview slot
 *
 * (The idle sweep enforces the same rule inline, alongside guards this
 * predicate can't express: `connecting`, viewers, delegation children.)
 */

/**
 * Work that an `acpDisconnect` would DESTROY rather than merely detach from.
 * The backend tears a connection down unconditionally, so the agent CLI dies
 * with its in-flight turn — which agents record in their own transcript as an
 * interrupted request — and any launched-but-unresolved background task
 * (async sub-agent / background shell) dies with it.
 *
 * Only OWNERS need this gate: a viewer's teardown detaches and never kills
 * anything, and the sweeps skip viewers, so one left attached leaks its
 * subscription. An explicit `disconnect` ignores it by design — that path
 * carries user intent (agent switch, restart-to-apply, an explicit close).
 */
export function isConnectionBusy(conn: {
  status: string | null
  backgroundOutstanding: number
}): boolean {
  return conn.status === "prompting" || conn.backgroundOutstanding > 0
}
