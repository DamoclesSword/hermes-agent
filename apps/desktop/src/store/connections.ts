import { atom, computed } from 'nanostores'

import type { DesktopAgentRoster, DesktopConnectionsRegistry } from '@/global'
import { persistStringRecord, storedStringRecord } from '@/lib/storage'
import { wipeSessionListsForGatewaySwitch } from '@/store/gateway-switch'
import {
  $activeGatewayProfile,
  $newChatProfile,
  $showAllProfiles,
  ensureGatewayAgent,
  normalizeProfileKey,
  refreshActiveProfile,
  requestFreshSession
} from '@/store/profile'
import { $connection } from '@/store/session'

const LAST_PROFILE_STORAGE_KEY = 'hermes.desktop.lastProfileByConnection'

export const $connectionsRegistry = atom<DesktopConnectionsRegistry | null>(null)

// Use only the resolved descriptor identity Electron publishes. `primary`
// means the registry default, not necessarily the source this window is using;
// guessing it here would paint the wrong source as active for an unmatched v1
// route or while a legacy main is still resolving the descriptor.
export const $activeConnectionId = computed($connection, connection => connection?.connectionId ?? null)

export const $hasMultipleConnections = computed(
  $connectionsRegistry,
  registry => (registry?.connections.length ?? 0) > 1
)

const $lastProfileByConnection = atom<Record<string, string>>(storedStringRecord(LAST_PROFILE_STORAGE_KEY))
let pendingTarget: null | string = null
let restoreAttempted = false
let switchRevision = 0

export const $pendingConnectionId = atom<null | string>(null)

$lastProfileByConnection.subscribe(value => persistStringRecord(LAST_PROFILE_STORAGE_KEY, value))

const $activeConnectionProfile = computed(
  [$activeConnectionId, $activeGatewayProfile, $connection],
  (connectionId, profile, connection) => ({
    connectionId,
    descriptorProfile: normalizeProfileKey(connection?.profile),
    profile: normalizeProfileKey(profile),
    registryScoped: connection?.registryScoped === true
  })
)

type RememberedProfileAvailability = 'missing' | 'present' | 'unknown'

/**
 * A persisted profile is only a preference. Treat it as missing when the
 * source has just returned a complete, reachable roster without that key;
 * unreachable/error/connect-on-demand sources remain unknown so auth,
 * transport, and offline failures never turn into a misleading default
 * switch.
 */
async function rememberedProfileAvailability(
  connectionId: string,
  profile: string
): Promise<RememberedProfileAvailability> {
  if (profile === 'default') {
    return 'present'
  }

  const getAgentRoster = window.hermesDesktop?.getAgentRoster

  if (!getAgentRoster) {
    return 'unknown'
  }

  try {
    const roster: DesktopAgentRoster = await getAgentRoster()
    const source = roster.sources?.find(candidate => candidate.connectionId === connectionId)

    if (!source || !source.reachable || source.error) {
      return 'unknown'
    }

    return roster.agents?.some(
      agent => agent.connectionId === connectionId && normalizeProfileKey(agent.profile) === profile
    )
      ? 'present'
      : 'missing'
  } catch {
    return 'unknown'
  }
}

function isExplicitMissingProfileError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')

  return message.includes('no longer exists') || message.includes('is being deleted')
}

// Remember one profile per source, so switching machines is a re-home rather
// than a reset to `default`. The map is local UI preference only; Electron
// remains the authority for the connection registry and all secrets.
$activeConnectionProfile.subscribe(({ connectionId, descriptorProfile, profile, registryScoped }) => {
  // A migrated v1 per-profile remote may expose a client-side alias such as
  // "work" while the registered source's actual profile is "default". Only
  // remember a source/profile pair after Electron confirms that exact v2
  // descriptor. This also rejects the brief startup window where the profile
  // atom still carries the previous app run's alias.
  if (
    !connectionId ||
    !registryScoped ||
    descriptorProfile !== profile ||
    $lastProfileByConnection.get()[connectionId] === profile
  ) {
    return
  }

  $lastProfileByConnection.set({ ...$lastProfileByConnection.get(), [connectionId]: profile })
})

/** @internal Reset module-owned preferences and switch coordination for tests. */
export function _resetConnectionsForTests(): void {
  $lastProfileByConnection.set({})
  pendingTarget = null
  restoreAttempted = false
  switchRevision = 0
  $pendingConnectionId.set(null)
}

export function setConnectionsRegistry(registry: DesktopConnectionsRegistry): void {
  $connectionsRegistry.set(registry)
}

/** Refresh the renderer cache from Electron's local registry. No backend is contacted. */
export async function refreshConnectionsRegistry(): Promise<DesktopConnectionsRegistry | null> {
  const bridge = window.hermesDesktop?.connections

  if (!bridge) {
    return null
  }

  const registry = await bridge.list()
  setConnectionsRegistry(registry)

  return registry
}

async function rememberConnection(connectionId: string): Promise<void> {
  const setLastUsed = window.hermesDesktop?.connections?.setLastUsed

  if (!setLastUsed) {
    return
  }

  try {
    const result = await setLastUsed(connectionId)
    setConnectionsRegistry(result.registry)
  } catch {
    // The source is already usable. A read-only/full userData directory must
    // not turn a successful backend switch into a false connection failure.
  }
}

/**
 * Load the registry once for Sessions and restore the last successfully used
 * source. Later registry refreshes stay side-effect free, so editing Settings
 * in another window never changes the active workspace.
 */
export async function initializeConnectionsRegistry(): Promise<DesktopConnectionsRegistry | null> {
  const registry = await refreshConnectionsRegistry()

  if (!registry || restoreAttempted) {
    return registry
  }

  restoreAttempted = true

  // Residual drift: a window can be live on a source the registry cannot name
  // (a v1-configured remote that reconciliation has not repaired yet, e.g. a
  // read-only userData that rejected the healed write). $activeConnectionId is
  // null there, so the preferred-id guard below would miss and "restore" the
  // registry primary over a connection that is already up and painting —
  // re-homing the user onto a different backend seconds after boot. The
  // registry has no claim on a source it does not know; leave the live one be.
  if ($connection.get() && $activeConnectionId.get() === null) {
    return registry
  }

  const lastUsed = registry.connections.some(connection => connection.id === registry.lastUsed)
    ? registry.lastUsed
    : registry.primary

  const preferredId = registry.launchMode === 'last-used' ? lastUsed : registry.primary

  if (!preferredId) {
    return registry
  }

  if ($activeConnectionId.get() === preferredId) {
    await rememberConnection(preferredId)
  } else {
    await selectConnection(preferredId)
  }

  return $connectionsRegistry.get() ?? registry
}

/**
 * Re-home Sessions to one registered source, restoring that source's last
 * profile. Only the selected source is dialed; merely rendering the switcher
 * never probes or opens remote gateways.
 */
export async function selectConnection(connectionId: string): Promise<void> {
  const registry = $connectionsRegistry.get()
  const targetConnection = registry?.connections.find(connection => connection.id === connectionId)

  if (!registry || !targetConnection) {
    return
  }

  // A user-initiated source switch collapses "All profiles" browse mode: the
  // picker is a concrete-source action. The silent boot-time restore (below,
  // from initializeConnectionsRegistry) is not — it must leave the persisted
  // browse-mode preference alone so it survives restart (#93197).
  const restoreOnBoot = pendingTarget === null && $activeConnectionId.get() === null

  const currentConnectionId = $activeConnectionId.get()
  const currentProfile = normalizeProfileKey($activeGatewayProfile.get())
  const rememberedProfile = normalizeProfileKey($lastProfileByConnection.get()[connectionId] ?? 'default')
  // Cold-start safely on the selected source's canonical root. A remembered
  // profile is adopted only after that source is reachable and its roster
  // proves the exact canonical id exists. This prevents a stale Gateway Astra
  // preference from launching a same-named local/missing backend before roster
  // hydration, while preserving every route/session key owned by Astra.
  let targetProfile = 'default'
  let shouldRewriteRememberedProfile = false

  let targetKey = `${connectionId}::${targetProfile}`

  if (pendingTarget === targetKey) {
    return
  }

  const switching =
    pendingTarget !== null ||
    $showAllProfiles.get() ||
    currentConnectionId !== connectionId ||
    currentProfile !== targetProfile

  if (!switching) {
    await rememberConnection(connectionId)

    return
  }

  if (pendingTarget === null && currentConnectionId === connectionId && currentProfile === targetProfile) {
    $showAllProfiles.set(false)
    $newChatProfile.set(targetProfile)
    requestFreshSession()

    await rememberConnection(connectionId)

    return
  }

  const revision = ++switchRevision
  pendingTarget = targetKey
  $pendingConnectionId.set(connectionId)

  try {
    // Always use the explicit registry route. `local` must mean This device,
    // and a registry primary can differ from a legacy per-profile override.
    try {
      await ensureGatewayAgent(connectionId, targetProfile)

      if (rememberedProfile !== 'default') {
        const availability = await rememberedProfileAvailability(connectionId, rememberedProfile)

        if (availability === 'present') {
          targetProfile = rememberedProfile
          targetKey = `${connectionId}::${targetProfile}`

          if (revision === switchRevision) {
            pendingTarget = targetKey
          }

          await ensureGatewayAgent(connectionId, targetProfile)
        } else if (availability === 'missing') {
          shouldRewriteRememberedProfile = true
        }
      }
    } catch (error) {
      // A roster can race a profile delete/rename. Retry once, and only once,
      // with the canonical source default when the backend explicitly proves
      // the remembered profile is gone. Never mask auth/offline/general errors.
      if (targetProfile === 'default' || !isExplicitMissingProfileError(error)) {
        throw error
      }

      targetProfile = 'default'
      shouldRewriteRememberedProfile = true
      targetKey = `${connectionId}::${targetProfile}`

      if (revision === switchRevision) {
        pendingTarget = targetKey
      }

      await ensureGatewayAgent(connectionId, targetProfile)
    }

    if ($connection.get()?.connectionId !== connectionId) {
      throw new Error(`Connection "${targetConnection.label}" did not become active.`)
    }

    // A newer click owns the final refresh. Serialized gateway activation
    // already makes the latest source win; this guard also prevents an older
    // request from repainting its profile list after that newer activation.
    if (revision === switchRevision) {
      if (shouldRewriteRememberedProfile) {
        $lastProfileByConnection.set({ ...$lastProfileByConnection.get(), [connectionId]: targetProfile })
      }

      await rememberConnection(connectionId)
      wipeSessionListsForGatewaySwitch()

      if (!restoreOnBoot) {
        $showAllProfiles.set(false)
      }

      $newChatProfile.set(targetProfile)
      requestFreshSession()
      await refreshActiveProfile()
    }
  } catch (error) {
    if (revision === switchRevision) {
      throw error
    }
  } finally {
    if (revision === switchRevision) {
      pendingTarget = null
      $pendingConnectionId.set(null)
    }
  }
}
