import { useEffect, useState } from 'react'
import { activeAdapter, subscribeSyncSource } from '@/sync/sync-sources'

/**
 * Reactively tracks the active sync source connection. Adapters read
 * localStorage at call time, so without this hook the UI would miss
 * connect/disconnect events that happen elsewhere (e.g. the footer
 * connecting in a popup, or a WebDAV form submitting in a dialog).
 */
export function useSyncConnected(): boolean {
  const [connected, setConnected] = useState(() => activeAdapter().isConnected())
  useEffect(() => subscribeSyncSource(() => setConnected(activeAdapter().isConnected())), [])
  return connected
}