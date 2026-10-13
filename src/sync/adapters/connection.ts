/**
 * Connection-state notifications shared by all adapters. Adapters emit on
 * credential changes; the registry turns that into source-aware snapshots.
 * Standalone module: adapters can emit without importing the registry.
 */
type ConnectionListener = () => void
let listeners: ConnectionListener[] = []

export function emitConnectionChanged(): void {
  for (const listener of listeners) listener()
}

export function subscribeConnection(listener: ConnectionListener): () => void {
  listeners.push(listener)
  return () => {
    listeners = listeners.filter((l) => l !== listener)
  }
}