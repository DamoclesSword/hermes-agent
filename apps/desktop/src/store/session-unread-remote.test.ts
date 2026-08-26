import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionInfo } from '@/types/hermes'
import type { SessionProfileRoute } from './session-request-router'

const patch = vi.fn<(id: string, unread: boolean, route?: SessionProfileRoute) => Promise<{ ok: boolean }>>(() =>
  Promise.resolve({ ok: true })
)

vi.mock('@/hermes', () => ({
  // The store only needs the REST mutation; keep the mock minimal.
  setApiRequestProfile: () => {},
  setSessionUnreadRemote: (id: string, unread: boolean, route?: SessionProfileRoute) => patch(id, unread, route)
}))

import { $sessions, sessionIdentityKey, sessionProfileRoute } from '@/store/session'

import { $unreadWriteGuard, clearUnreadOnOpen, markSessionUnread, watchUnreadWriteGuard } from './session-unread-remote'

const row = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, message_count: 1, source: 'cli', started_at: 0, title: id, ...extra }) as SessionInfo
const routeFor = (session: SessionInfo): SessionProfileRoute => sessionProfileRoute(session)

beforeEach(() => {
  $sessions.set([])
  $unreadWriteGuard.set(new Map())
  patch.mockClear()
})

afterEach(() => {
  $sessions.set([])
  $unreadWriteGuard.set(new Map())
})

describe('markSessionUnread', () => {
  it('optimistically paints the row, then PATCHes with the owning profile', async () => {
    const session = row('a', { profile: 'work', unread: false })
    $sessions.set([session])

    await markSessionUnread('a', true)

    expect(patch).toHaveBeenCalledWith('a', true, routeFor(session))
    expect($sessions.get().find(s => s.id === 'a')?.unread).toBe(true)
  })

  it('no-ops for a runtime-only session with no persisted row', async () => {
    await markSessionUnread('ghost', true)

    expect(patch).not.toHaveBeenCalled()
  })

  it('rolls back the row and rethrows when the PATCH fails', async () => {
    const session = row('a', { unread: false })
    $sessions.set([session])
    patch.mockImplementationOnce(() => Promise.reject(new Error('offline')))

    await expect(markSessionUnread('a', true)).rejects.toThrow('offline')

    // The backend kept the old value, so the optimistic flip is undone and
    // the guard is released (nothing to fence a page about).
    expect($sessions.get().find(s => s.id === 'a')?.unread).toBe(false)
    expect($unreadWriteGuard.get().has(sessionIdentityKey(session, 'a'))).toBe(false)
  })
})

describe('clearUnreadOnOpen', () => {
  it('no-ops for a session that is already read', async () => {
    $sessions.set([row('a', { unread: false })])

    await clearUnreadOnOpen('a')

    expect(patch).not.toHaveBeenCalled()
  })

  it('PATCHes read for an unread session, using its owning profile', async () => {
    const session = row('a', { profile: 'p2', unread: true })
    $sessions.set([session])

    await clearUnreadOnOpen('a')

    expect(patch).toHaveBeenCalledWith('a', false, routeFor(session))
    expect($sessions.get().find(s => s.id === 'a')?.unread).toBe(false)
  })

  it('swallows a failed PATCH (the next honest refresh heals the dot)', async () => {
    $sessions.set([row('a', { unread: true })])
    patch.mockImplementationOnce(() => Promise.reject(new Error('offline')))

    await expect(clearUnreadOnOpen('a')).resolves.toBeUndefined()
  })
})

describe('watchUnreadWriteGuard', () => {
  it('drops a guard entry once a list page confirms the value we wrote', () => {
    watchUnreadWriteGuard()
    const guard = new Map<string, { at: number; value: boolean }>()
    const session = row('a', { unread: true })
    guard.set(sessionIdentityKey(session, 'a'), { at: Date.now(), value: true })
    $unreadWriteGuard.set(guard)

    // The server caught up and echoes our value back.
    $sessions.set([session])

    expect($unreadWriteGuard.get().has(sessionIdentityKey(session, 'a'))).toBe(false)
  })

  it('keeps the guard while a page contradicts a write still in flight', () => {
    watchUnreadWriteGuard()
    const guard = new Map<string, { at: number; value: boolean }>()
    const session = row('a')
    guard.set(sessionIdentityKey(session, 'a'), { at: Date.now(), value: true })
    $unreadWriteGuard.set(guard)

    // A list request issued before the PATCH still says read. Honouring it
    // would silently undo the mark the user just made.
    $sessions.set([session])

    expect($unreadWriteGuard.get().has(sessionIdentityKey(session, 'a'))).toBe(true)
  })

  it('fails closed for an unscoped duplicate and updates only the owned row', async () => {
    const first = row('shared', { connection_id: 'gateway-a', profile: 'astra', unread: false })
    const second = row('shared', { connection_id: 'gateway-b', profile: 'astra', unread: false })
    $sessions.set([first, second])

    await markSessionUnread('shared', true)

    expect(patch).not.toHaveBeenCalled()
    expect($sessions.get().every(session => session.unread === false)).toBe(true)

    await markSessionUnread('shared', true, routeFor(first))

    expect(patch).toHaveBeenCalledWith('shared', true, routeFor(first))
    expect($sessions.get().find(session => session.connection_id === 'gateway-a')?.unread).toBe(true)
    expect($sessions.get().find(session => session.connection_id === 'gateway-b')?.unread).toBe(false)
    expect($unreadWriteGuard.get().has(sessionIdentityKey(first, 'shared'))).toBe(true)
  })
})
