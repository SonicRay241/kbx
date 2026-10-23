import { useEffect } from 'react'
import { CloudAlertIcon, CloudCheckIcon, LoaderCircleIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { subscribeSyncProgress, type SyncProgress } from '@/sync/sync-engine'

/** Seconds of quiet before a sync is worth announcing: fast follow-up syncs
 * (debounced pushes after an edit) stay silent, slow ones get a progress card. */
export const SHOW_AFTER = 60

const TOAST_ID = 'sync-progress'

/** Mounts once: turns engine progress events into a sonner progress card. */
export function SyncToastBridge() {
  useEffect(() => {
    let runStartedAt = 0
    let visible = false
    return subscribeSyncProgress((progress) => {
      if (progress.startedAt !== runStartedAt) {
        runStartedAt = progress.startedAt
        visible =
          progress.previousSyncedAt === null ||
          Date.now() - progress.previousSyncedAt > SHOW_AFTER * 1000
      }
      if (!visible) return
      toast.custom(() => <SyncToastCard progress={progress} />, {
        id: TOAST_ID,
        duration: progress.status === 'running' ? Infinity : progress.status === 'done' ? 3000 : 8000,
        dismissible: progress.status !== 'running',
        // Custom toasts are width:fit-content by default; without this the card
        // shrink-wraps and hugs the left edge of the centered toaster.
        className: 'w-full',
      })
    })
  }, [])
  return null
}

function SyncToastCard({ progress }: { progress: SyncProgress }) {
  const done = progress.status === 'done'
  const failed = progress.status === 'error'
  const pct = Math.round(Math.min(Math.max(progress.progress, 0), 1) * 100)
  const fill = failed ? Math.max(pct, 8) : pct

  return (
    <div className="bg-card text-card-foreground border-border w-full rounded-xl border p-4 shadow-lg">
      <div className="flex items-start gap-3">
        <div
          className={cn(
            'flex size-12 shrink-0 items-center justify-center rounded-lg border [&_svg]:size-6',
            done && 'border-green-600/40 bg-green-600/10 text-green-600 dark:border-green-400/40 dark:text-green-400',
            failed && 'border-destructive/40 bg-destructive/10 text-destructive',
            !done && !failed && 'bg-muted text-muted-foreground',
          )}
        >
          {failed ? (
            <CloudAlertIcon />
          ) : done ? (
            <CloudCheckIcon />
          ) : (
            <LoaderCircleIcon className="animate-spin" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">
            {failed ? 'Sync Failed' : done ? 'Sync Complete!' : 'Syncing…'}
          </p>
          <p className="text-muted-foreground mt-0.5 line-clamp-1 text-xs">
            {failed
              ? `Error message: ${progress.message ?? 'Unknown error'}`
              : done
                ? `Synced to ${progress.source}`
                : `Progress ${pct}%`}
          </p>
          <Progress
            value={fill}
            className={cn(
              'mt-2 h-1.5',
              failed && '**:data-[slot=progress-indicator]:bg-destructive',
              done && '**:data-[slot=progress-indicator]:bg-green-600 dark:**:data-[slot=progress-indicator]:bg-green-400',
            )}
          />
        </div>
      </div>
    </div>
  )
}
