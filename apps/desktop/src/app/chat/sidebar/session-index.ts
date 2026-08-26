import type { SessionInfo } from '@/types/hermes'
import { sessionIdentityKey, sessionServingScopeKey } from '@/store/session'

/**
 * Index sessions by every id a pin might be stored under.
 *
 * The sidebar fetches three independent slices — recents, cron, and messaging
 * — and renders the latter two in self-managed sections. Any of them can be
 * pinned, so all three must be indexed here or the Pinned section can't
 * resolve the pin to a row. A pinned session is also filtered out of its own
 * section, so failing to index it doesn't merely misplace the row: it removes
 * the session from the sidebar entirely.
 *
 * Each session is keyed under both its live id and its lineage root, so a pin
 * stored before an auto-compression still resolves to the live continuation
 * tip. Recents are indexed last and win a direct id collision.
 */
export function buildSessionByAnyId(
  visibleSessions: SessionInfo[],
  cronSessions: SessionInfo[],
  messagingSessions: SessionInfo[]
): Map<string, SessionInfo> {
  const map = new Map<string, SessionInfo>()
  const directById = new Map<string, { row: SessionInfo; scope: string }>()
  const directScopes = new Map<string, Set<string>>()
  const lineageById = new Map<string, { row: SessionInfo; scope: string }>()
  const ambiguousIds = new Set<string>()

  for (const session of [...cronSessions, ...messagingSessions, ...visibleSessions]) {
    const scope = sessionServingScopeKey(session)
    map.set(sessionIdentityKey(session, session.id), session)
    map.set(sessionIdentityKey(session), session)

    const scopes = directScopes.get(session.id) ?? new Set<string>()
    scopes.add(scope)
    directScopes.set(session.id, scopes)

    if (scopes.size === 1) {
      // Later slices have the same precedence as the old bare-id map: recents
      // are visited last and win duplicate rows inside one serving scope.
      directById.set(session.id, { row: session, scope })
    } else {
      directById.delete(session.id)
      ambiguousIds.add(session.id)
    }

    if (session._lineage_root_id && !directScopes.has(session._lineage_root_id)) {
      const existing = lineageById.get(session._lineage_root_id)

      if (!existing) {
        lineageById.set(session._lineage_root_id, { row: session, scope })
      } else if (existing.scope !== scope) {
        lineageById.delete(session._lineage_root_id)
        ambiguousIds.add(session._lineage_root_id)
      }
    }
  }

  for (const [id, entry] of directById) {
    if (!ambiguousIds.has(id)) {
      map.set(id, entry.row)
    }
  }

  for (const [id, entry] of lineageById) {
    if (!directScopes.has(id) && !ambiguousIds.has(id)) {
      map.set(id, entry.row)
    }
  }

  return map
}

/**
 * Resolve the Pinned section's rows: the locally stored pin ids first (in the
 * user's hand-picked order), then any row the SERVER flags `pinned` that the
 * local set doesn't know about yet.
 *
 * The local set (`$pinnedSessionIds` in localStorage) is a UI-ordering hint,
 * not the source of truth — `sessions.pinned` in the backend's state.db is.
 * When the two disagree (cold localStorage after a reload, a pin made from
 * another client, a persist that never landed), every other sidebar list
 * filters the session out as "pinned" while the Pinned section — resolving
 * only local ids — renders empty, so the conversation vanishes from the
 * sidebar entirely (#85969). Falling back to the row flag keeps the invariant:
 * a session the backend says is pinned is always reachable from the Pinned
 * section, whatever the local cache holds. session-pin-sync then adopts the
 * pin into the local set on its next reconcile, restoring ordering control.
 *
 * `unconfirmedPinWrites` is that same module's fence, and the fallback has to
 * respect it. Unpinning drops the id from the local set immediately, but the
 * loaded row keeps saying `pinned: true` until a page issued after the PATCH
 * lands — so an unfenced fallback reads the user's own unpin as a foreign pin
 * and parks the session at the bottom of Pinned for a refresh cycle before it
 * finally moves to Sessions.
 */
export function resolvePinnedSessions(
  pinnedSessionIds: readonly string[],
  sessionByAnyId: Map<string, SessionInfo>,
  allSessions: readonly SessionInfo[],
  unconfirmedPinWrites: ReadonlySet<string>
): SessionInfo[] {
  const seen = new Set<string>()
  const out: SessionInfo[] = []

  for (const pinId of pinnedSessionIds) {
    const session = sessionByAnyId.get(pinId)

    const identity = session && sessionIdentityKey(session)

    if (session && identity && !seen.has(identity)) {
      seen.add(identity)
      out.push(session)
    }
  }

  for (const session of allSessions) {
    const identity = sessionIdentityKey(session)

    if (session.pinned !== true || seen.has(identity)) {
      continue
    }

    // A pin write of ours the row predates — under either identity, since the
    // fence is keyed on the durable id and the row may surface as its tip.
    if (unconfirmedPinWrites.has(identity)) {
      continue
    }

    seen.add(identity)
    out.push(session)
  }

  return out
}
