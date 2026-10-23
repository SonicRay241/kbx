import { useState } from 'react'
import { ArchiveRestoreIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSyncConnected } from '@/hooks/use-sync-connected'
import { syncArchives } from '@/sync/sync-engine'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

/**
 * Explicit archive fetch. Archive partitions are not part of the routine sync,
 * so the UI offers this where archived rows are about to be shown.
 */
export function SyncArchivesButton({ className }: { className?: string }) {
  const connected = useSyncConnected()
  const [busy, setBusy] = useState(false)
  if (!connected) return null

  const run = () => {
    setBusy(true)
    syncArchives()
      .catch((error: unknown) => {
        if (error instanceof Error && error.message) toast.error(error.message)
      })
      .finally(() => setBusy(false))
  }

  return (
    <Button
      variant="outline"
      size="sm"
      className={cn('h-7 gap-1.5 px-2 text-xs', className)}
      onClick={run}
      disabled={busy}
      aria-label="Sync archives"
    >
      <ArchiveRestoreIcon className={cn('size-3.5', busy && 'animate-pulse')} />
      {busy ? 'Syncing archives…' : 'Sync archives'}
    </Button>
  )
}
