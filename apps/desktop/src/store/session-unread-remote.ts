/**
 * Persisted unread flag sync (backend read-state watermark via
 * PATCH /api/sessions/{id} → SessionDB.set_session_read).
 *
 * The sidebar's dot is fed by TWO sources (see session-dot-state.ts): the
 * runtime "turn finished in background" marker ($unreadFinishedSessionIds,
 * transient) and the backend's derived `unread` key (last_read_at watermark
 * vs last_active — survives restarts and is visible to every surface). This
 * module owns the WRITE side of the persisted flag: the row-level
 * "Mark as unread"/"Mark as read" toggle and the automatic clear when a
 * session is opened. The read side lives in session-dot-state.ts.
 *
 * Optimistic, then honest (AGENTS.md): paint the row immediately, PATCH the
 * backend, roll back visibly on failure. A list page already in flight when
 * we PATCH can land after the ack carrying the OLD value — the write guard
 * lets our value outrank that stale page briefly (#74570 pattern, same as
 * session-pin-sync.ts).
 *
 * NOTE: import cycle with ./session is inert — both modules only touch each
 * other's exports inside function bodies, never at module evaluation time.
 */
import { atom } from 'nanostores'

import { setSessionUnreadRemote } from '@/hermes'

import {
  $sessions,
  resolveUniqueSessionRow,
  sessionIdentityKey,
  sessionMatchesStoredId,
  sessionProfileRoute,
  setSessions
} from './session'
import type { SessionProfileRoute } from './session-request-router'

export const UNREAD_WRITE_GUARD_MS = 10_000

/** id -> the value we wrote and when. Guarded rows outrank list pages. */
export const $unreadWriteGuard = atom<Map<string, { at: number; value: boolean }>>(new Map())

// A mark/read operation updates the renderer row optimistically before the
// remote PATCH resolves. The list watcher must not mistake that local paint
// for an authoritative server echo and retire the guard immediately.
const optimisticUnreadWrites = new Set<string>()

function rowFor(storedId: string, ownerRoute?: SessionProfileRoute) {
  return resolveUniqueSessionRow(
    $sessions.get(),
    storedId,
    ownerRoute
      ? { connectionId: ownerRoute.connectionId, profile: ownerRoute.targetProfile || ownerRoute.profile }
      : undefined
  )
}

/** Toggle the persisted unread flag: optimistic row update, then PATCH, then
 *  roll back visibly if the write fails. No-op for runtime-only sessions (a
 *  brand-new chat with no persisted row yet — there is nothing to flag). */
export async function markSessionUnread(
  storedId: string,
  unread: boolean,
  ownerRoute?: SessionProfileRoute
): Promise<void> {
  const row = rowFor(storedId, ownerRoute)

  if (!row) {
    return
  }

  const route = ownerRoute || sessionProfileRoute(row)
  const scope = { connectionId: row.connection_id, profile: row.profile }
  const identity = sessionIdentityKey(row, storedId)
  const guard = new Map($unreadWriteGuard.get())
  guard.set(identity, { at: Date.now(), value: unread })
  $unreadWriteGuard.set(guard)

  optimisticUnreadWrites.add(identity)

  try {
    setSessions(rows =>
      rows.map(r => (sessionMatchesStoredId(r, storedId, scope) ? { ...r, unread } : r))
    )
  } finally {
    optimisticUnreadWrites.delete(identity)
  }

  try {
    await setSessionUnreadRemote(storedId, unread, route)
  } catch (err) {
    // Roll back visibly: the backend kept the old value.
    const guard2 = new Map($unreadWriteGuard.get())
    guard2.delete(identity)
    $unreadWriteGuard.set(guard2)
    setSessions(rows =>
      rows.map(r => (sessionMatchesStoredId(r, storedId, scope) ? { ...r, unread: !unread } : r))
    )
    throw err
  }
}

/** Opening a session clears its persisted unread flag (auto-mark-read).
 *  Best-effort: a failed PATCH is healed by the next honest refresh. */
export async function clearUnreadOnOpen(storedId: string, ownerRoute?: SessionProfileRoute): Promise<void> {
  const row = rowFor(storedId, ownerRoute)

  if (!row || row.unread !== true) {
    return
  }

  try {
    await markSessionUnread(storedId, false, ownerRoute)
  } catch {
    // Ignore: the dot simply returns until a refresh reconciles.
  }
}

/** Release guard entries once a list page confirms the value we wrote. Call
 *  once at boot, next to watchSessionPins(). */
export function watchUnreadWriteGuard(): void {
  $sessions.listen(rows => {
    const guard = $unreadWriteGuard.get()
    let changed = false

    for (const [identity, entry] of guard) {
      if (optimisticUnreadWrites.has(identity)) {
        continue
      }

      const row = rows.find(
        r => sessionIdentityKey(r, r.id) === identity || sessionIdentityKey(r) === identity
      )

      if (row && row.unread === entry.value) {
        guard.delete(identity)
        changed = true
      }
    }

    if (changed) {
      $unreadWriteGuard.set(new Map(guard))
    }
  })
}
