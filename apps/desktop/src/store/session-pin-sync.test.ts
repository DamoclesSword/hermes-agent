import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionInfo } from '@/types/hermes'
import type { SessionProfileRoute } from './session-request-router'

const patch = vi.fn<(id: string, pinned: boolean, route?: SessionProfileRoute) => Promise<{ ok: boolean }>>(() =>
  Promise.resolve({ ok: true })
)

vi.mock('@/hermes', () => ({
  // The layout store reaches the profile store, which sets the request profile
  // at import time; this suite only cares about the pin call.
  setApiRequestProfile: () => {},
  setSessionPinnedRemote: (id: string, pinned: boolean, route?: SessionProfileRoute) => patch(id, pinned, route)
}))

import { $pinnedSessionIds } from '@/store/layout'
import { $sessions, sessionIdentityKey, sessionProfileRoute } from '@/store/session'

import { $unconfirmedPinWrites, resetSessionPinMirror, watchSessionPins } from './session-pin-sync'

const row = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, message_count: 1, source: 'cli', started_at: 0, title: id, ...extra }) as SessionInfo
const routeFor = (session: SessionInfo): SessionProfileRoute => sessionProfileRoute(session)

const flush = () => Promise.resolve()

beforeAll(() => {
  ;(globalThis as { window?: unknown }).window ??= {}
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = {}
  // Attach the listeners once — module state is process-global.
  watchSessionPins()
})

beforeEach(() => {
  $sessions.set([])
  $pinnedSessionIds.set([])
  // The mirror/pending/unconfirmed maps are module-global, so one test's
  // bookkeeping would otherwise suppress the next test's PATCH (or fence out
  // its page). Same reset the gateway switch uses.
  resetSessionPinMirror()
  patch.mockClear()
})

afterEach(() => {
  $sessions.set([])
  $pinnedSessionIds.set([])
})

describe('watchSessionPins', () => {
  it('mirrors a new pin as pinned=true with the row profile', async () => {
    const session = row('a', { profile: 'work' })
    $sessions.set([session])
    $pinnedSessionIds.set([sessionIdentityKey(session)])
    await flush()

    expect(patch).toHaveBeenCalledWith('a', true, routeFor(session))
  })

  it('mirrors an unpin as pinned=false', async () => {
    const session = row('b')
    $sessions.set([session])
    $pinnedSessionIds.set([sessionIdentityKey(session)])
    await flush()
    patch.mockClear()

    $pinnedSessionIds.set([])
    await flush()

    expect(patch).toHaveBeenCalledWith('b', false, routeFor(session))
  })

  it('defers a pin whose row is not loaded, then flushes once it appears', async () => {
    $pinnedSessionIds.set(['c'])
    await flush()
    // No row yet -> nothing sent.
    expect(patch).not.toHaveBeenCalled()

    $sessions.set([row('c', { profile: 'p2' })])
    await flush()

    const session = row('c', { profile: 'p2' })
    expect($pinnedSessionIds.get()).toContain(sessionIdentityKey(session))
    expect(patch).toHaveBeenCalledWith('c', true, routeFor(session))
  })

  it('matches a pin id against the lineage root', async () => {
    // pin id is the lineage root; the live row carries it as _lineage_root_id.
    const session = row('tip', { _lineage_root_id: 'root' })
    $sessions.set([session])
    $pinnedSessionIds.set([sessionIdentityKey(session)])
    await flush()

    expect(patch).toHaveBeenCalledWith('root', true, routeFor(session))
  })

  it('does not re-PATCH an already-mirrored pin on unrelated session updates', async () => {
    const session = row('d')
    $sessions.set([session])
    $pinnedSessionIds.set([sessionIdentityKey(session)])
    await flush()
    patch.mockClear()

    // A session-list refresh that doesn't change the pinned set.
    $sessions.set([row('d'), row('e')])
    await flush()

    expect(patch).not.toHaveBeenCalled()
  })
})

describe('watchSessionPins remote pull', () => {
  it('adopts a pin another app made', async () => {
    const session = row('remote', { pinned: true })
    $sessions.set([session])
    await flush()

    expect($pinnedSessionIds.get()).toContain(sessionIdentityKey(session))
  })

  it('adopts a remote pin on the durable lineage root, not the live tip', async () => {
    const session = row('tip', { _lineage_root_id: 'root', pinned: true })
    $sessions.set([session])
    await flush()

    expect($pinnedSessionIds.get()).toEqual([sessionIdentityKey(session)])
  })

  it('does not echo an adopted pin back as a redundant write', async () => {
    $sessions.set([row('adopted', { pinned: true })])
    await flush()

    expect(patch).not.toHaveBeenCalled()
  })

  it('drops a local pin the server reports as unpinned', async () => {
    const session = row('gone', { pinned: true })
    $pinnedSessionIds.set([sessionIdentityKey(session)])
    $sessions.set([session])
    await flush()
    patch.mockClear()

    // Another app unpinned it; our next refresh carries the new truth.
    $sessions.set([row('gone', { pinned: false })])
    await flush()

    expect($pinnedSessionIds.get()).not.toContain(sessionIdentityKey(session))
  })

  it('leaves the local set alone when the backend omits the flag', async () => {
    const session = row('legacy')
    $pinnedSessionIds.set([sessionIdentityKey(session)])
    // No `pinned` key at all — a runtime predating the column.
    $sessions.set([session])
    await flush()

    expect($pinnedSessionIds.get()).toContain(sessionIdentityKey(session))
  })

  it('does not revert a fresh local pin while the loaded row is still stale (#74570)', async () => {
    // The row is already loaded and says pinned=false when the user pins.
    // The pin listener fires reconcile synchronously — before any PATCH — and
    // the stale row must not win over the local intent.
    const session = row('fresh', { pinned: false })
    $sessions.set([session])
    await flush()
    patch.mockClear()

    $pinnedSessionIds.set([sessionIdentityKey(session)])
    await flush()

    expect($pinnedSessionIds.get()).toContain(sessionIdentityKey(session))
    expect(patch).toHaveBeenCalledWith('fresh', true, routeFor(session))
  })

  it('does not revert a fresh local unpin while the loaded row still says pinned (#74570)', async () => {
    // Adopt a server-side pin first, so it's held locally and mirrored.
    const session = row('sticky', { pinned: true })
    $sessions.set([session])
    await flush()
    expect($pinnedSessionIds.get()).toContain(sessionIdentityKey(session))
    patch.mockClear()

    // User unpins while the loaded row still says pinned=true.
    $pinnedSessionIds.set([])
    await flush()

    expect($pinnedSessionIds.get()).not.toContain(sessionIdentityKey(session))
    expect(patch).toHaveBeenCalledWith('sticky', false, routeFor(session))
  })

  it('keeps a deferred pin (row not yet loaded) when a stale page finally arrives', async () => {
    $pinnedSessionIds.set(['deferred'])
    await flush()
    expect(patch).not.toHaveBeenCalled()

    // The page that loads the row still predates our intent.
    const session = row('deferred', { pinned: false })
    $sessions.set([session])
    await flush()

    expect($pinnedSessionIds.get()).toContain(sessionIdentityKey(session))
    expect(patch).toHaveBeenCalledWith('deferred', true, routeFor(session))
  })

  it('ignores a stale page that contradicts a write still in flight', async () => {
    let settle: (v: { ok: boolean }) => void = () => {}

    patch.mockImplementationOnce(() => new Promise(resolve => (settle = resolve)))

    const session = row('race')
    $sessions.set([session])
    $pinnedSessionIds.set([sessionIdentityKey(session)])
    await flush()
    expect(patch).toHaveBeenCalledWith('race', true, routeFor(session))

    // A list request issued before the PATCH lands still says pinned=false.
    // Honouring it would silently undo the pin the user just made.
    $sessions.set([row('race', { pinned: false })])
    await flush()

    expect($pinnedSessionIds.get()).toContain(sessionIdentityKey(session))

    settle({ ok: true })
    await flush()
    await flush()

    expect($pinnedSessionIds.get()).toContain(sessionIdentityKey(session))
  })

  it('still ignores a pre-write page that lands AFTER the ack (#76919)', async () => {
    // The ack is not proof: a list request issued before the PATCH is slower
    // than the PATCH itself, so it can arrive afterwards still carrying the
    // old value. Reverting on it un-pins the session AND pushes the wrong
    // value back to the server, making the mistake durable.
    const session = row('acked')
    $sessions.set([session])
    $pinnedSessionIds.set([sessionIdentityKey(session)])
    await flush()
    await flush()
    expect(patch).toHaveBeenCalledWith('acked', true, routeFor(session))
    patch.mockClear()

    // Post-ack, but this page predates the write.
    $sessions.set([row('acked', { pinned: false })])
    await flush()

    expect($pinnedSessionIds.get()).toContain(sessionIdentityKey(session))
    expect(patch).not.toHaveBeenCalled()
  })

  it('releases the guard once a page confirms the written value', async () => {
    const session = row('confirmed')
    $sessions.set([session])
    $pinnedSessionIds.set([sessionIdentityKey(session)])
    await flush()
    await flush()

    // The server catches up and echoes our value back.
    $sessions.set([row('confirmed', { pinned: true })])
    await flush()
    patch.mockClear()

    // With the write confirmed, a genuine remote unpin is authoritative again.
    $sessions.set([row('confirmed', { pinned: false })])
    await flush()

    expect($pinnedSessionIds.get()).not.toContain(sessionIdentityKey(session))
  })

  it('stops fencing once the guard cooldown expires', async () => {
    vi.useFakeTimers()

    try {
      const session = row('stale')
      $sessions.set([session])
      $pinnedSessionIds.set([sessionIdentityKey(session)])
      await flush()
      await flush()

      // No page ever confirms the write. The guard must not fence forever —
      // after the cooldown the server's answer wins again.
      vi.advanceTimersByTime(11_000)

      $sessions.set([row('stale', { pinned: false })])
      await flush()

      expect($pinnedSessionIds.get()).not.toContain(sessionIdentityKey(session))
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the pin and retries when the write itself fails', async () => {
    patch.mockImplementationOnce(() => Promise.reject(new Error('offline')))

    const session = row('failed')
    $sessions.set([session])
    $pinnedSessionIds.set([sessionIdentityKey(session)])
    await flush()
    await flush()
    patch.mockClear()

    // The PATCH never landed, so the server legitimately still says unpinned —
    // but that's OUR undelivered intent, not a remote decision. The pin stays
    // and the next reconcile retries it rather than silently dropping it.
    $sessions.set([row('failed', { pinned: false })])
    await flush()

    expect($pinnedSessionIds.get()).toContain(sessionIdentityKey(session))
    expect(patch).toHaveBeenCalledWith('failed', true, routeFor(session))
  })

  it('does not oscillate when two profiles share a session id with conflicting pins', async () => {
    // The cross-profile list can hold the same durable id twice with opposite
    // `pinned` flags (copied/imported profile DBs). A profile-blind pull would
    // pin then unpin the id in one pass and re-fire reconcile forever,
    // overflowing nanostores' listenerQueue (RangeError: Invalid array length).
    const defaultSession = row('shared', { profile: 'default', pinned: true })
    const hcoderSession = row('shared', { profile: 'hcoder', pinned: false })
    $sessions.set([defaultSession, hcoderSession])
    await flush()

    // The pinned row is adopted under its own serving scope, and the other
    // same-id row cannot collapse or oscillate it into a bare key.
    expect($pinnedSessionIds.get()).toEqual([sessionIdentityKey(defaultSession)])
  })

  it('publishes the fence so the sidebar can ignore the rows it covers', async () => {
    // The Pinned section falls back to the server flag for pins the local set
    // doesn't hold. Without the fence it reads a just-unpinned row's stale
    // pinned=true as a foreign pin and re-lists the session.
    const session = row('exposed', { pinned: true })
    $sessions.set([session])
    await flush()
    expect($pinnedSessionIds.get()).toContain(sessionIdentityKey(session))

    $pinnedSessionIds.set([])
    await flush()

    expect($unconfirmedPinWrites.get().has(sessionIdentityKey(session))).toBe(true)

    // Server catches up; nothing left to fence.
    $sessions.set([row('exposed', { pinned: false })])
    await flush()

    expect($unconfirmedPinWrites.get().has(sessionIdentityKey(session))).toBe(false)
  })

  it('keeps the published fence reference stable across an unrelated refresh', async () => {
    // The sidebar memoizes the Pinned section on this set; a fresh Set every
    // session refresh would rebuild the list for nothing.
    $sessions.set([row('quiet')])
    await flush()

    const before = $unconfirmedPinWrites.get()
    $sessions.set([row('quiet'), row('another')])
    await flush()

    expect($unconfirmedPinWrites.get()).toBe(before)
  })

  it('updates only the explicitly scoped row when ids are shared across connections', async () => {
    const first = row('shared', { connection_id: 'gateway-a', profile: 'astra', pinned: false })
    const second = row('shared', { connection_id: 'gateway-b', profile: 'astra', pinned: false })
    $sessions.set([first, second])
    const firstKey = sessionIdentityKey(first)
    const secondKey = sessionIdentityKey(second)

    $pinnedSessionIds.set([firstKey])
    await flush()

    expect(patch).toHaveBeenCalledWith('shared', true, routeFor(first))
    expect(patch).not.toHaveBeenCalledWith('shared', true, routeFor(second))
    expect($pinnedSessionIds.get()).toEqual([firstKey])
    expect($pinnedSessionIds.get()).not.toContain(secondKey)
  })
})
