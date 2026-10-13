import type { SyncSourceId } from './adapters/types'
import { gdriveAdapter } from './adapters/gdrive'
import { webdavAdapter } from './adapters/webdav'
import type { SyncAdapter } from './adapters/types'
import { subscribeConnection, emitConnectionChanged } from './adapters/connection'

const ADAPTERS: Record<SyncSourceId, SyncAdapter> = {
  gdrive: gdriveAdapter,
  webdav: webdavAdapter,
}

const SOURCE_KEY = 'kanban-sync-source'

/** Last selected sync source (persisted); webdav until the user picks otherwise. */
export function readActiveSource(): SyncSourceId {
  const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(SOURCE_KEY)
  return raw === 'gdrive' || raw === 'webdav' ? raw : 'webdav'
}

export function setActiveSource(source: SyncSourceId): void {
  localStorage.setItem(SOURCE_KEY, source)
  // The effective connection snapshot is (source, credentials): switching the
  // source changes it even though no adapter touched its credentials. Emit so
  // useSyncConnected() consumers re-read the new adapter's isConnected().
  emitConnectionChanged()
}

export function getAdapter(source: SyncSourceId): SyncAdapter {
  return ADAPTERS[source]
}

/** The adapter sync calls into; the persisted source picks which one. */
export function activeAdapter(): SyncAdapter {
  return ADAPTERS[readActiveSource()]
}

/**
 * Best-effort check for cloud data a provider switch would strand: returns
 * the id of a source DIFFERENT from `next` whose index still holds live
 * (non-tombstoned) entries, or null. Only reachable, connected backends are
 * probed; errors mean "no known data", never "block the switch". Reconnecting
 * the same source (new WebDAV server) is an edit, not a switch, and is not
 * detected by design.
 */
export async function findStrandedSource(next: SyncSourceId): Promise<SyncSourceId | null> {
  const others = (Object.keys(ADAPTERS) as SyncSourceId[]).filter((id) => id !== next)
  for (const id of others) {
    const adapter = ADAPTERS[id]
    if (!adapter.isConnected()) continue
    try {
      const { index } = await adapter.readIndex()
      if (Object.values(index.entries).some((entry) => !entry.deletedAt)) return id
    } catch {
      // Unreachable backend: don't block or warn on the switch.
    }
  }
  return null
}

/**
 * Reactively tracks the active source: any adapter credential change (connect,
 * disconnect, token refresh) notifies, and the persisted source is re-read.
 * Replaces the Drive-only connection hook.
 */
export function subscribeSyncSource(listener: () => void): () => void {
  return subscribeConnection(listener)
}

export type { SyncAdapter, SyncSourceId } from './adapters/types'