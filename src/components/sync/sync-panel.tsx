import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { db } from '@/lib/db'
import { useLiveQuery } from 'dexie-react-hooks'
import { CloudIcon, CloudOffIcon, Loader2Icon, RefreshCwIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { subscribeSyncStatus, type SyncStatus } from '@/sync/sync-engine'
import { activeAdapter } from '@/sync/sync-sources'
import { useSyncConnected } from '@/hooks/use-sync-connected'
import { DriveProviderDialog } from '@/components/sync/drive-provider-dialog'
import { runSyncNow } from '@/components/sync/sync-actions'
import { ConfirmDialog } from '@/components/confirm-dialog'

function useSyncStatus(): SyncStatus {
  const [status, setStatus] = useState<SyncStatus>({ state: 'idle' })
  useEffect(() => subscribeSyncStatus(setStatus), [])
  return status
}

function formatLastSync(iso: string | undefined): string {
  if (!iso) return 'never'
  const date = new Date(iso)
  const diff = Date.now() - date.getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return date.toLocaleDateString()
}

/**
 * Sidebar footer button. One entry point: closed it shows connection state;
 * open (click) it shows the sync status + provider, with sync-now and
 * disconnect actions when connected, or the connect CTA when not.
 */
export function SyncPanel() {
  const connected = useSyncConnected()
  const status = useSyncStatus()
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [signOutOpen, setSignOutOpen] = useState(false)

  const label = activeAdapter().label
  const lastSync = useLiveQuery(async () => (await db.syncMeta.get('index'))?.lastSyncedAt)

  const syncing = status.state === 'syncing'
  const statusText = status.state === 'error'
    ? `Sync error: ${status.message}`
    : syncing
      ? 'Syncing…'
      : lastSync
        ? `Synced ${formatLastSync(lastSync)}`
        : 'Not synced yet'

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-full justify-start gap-1.5 px-1.5 text-xs text-muted-foreground"
          >
            {connected ? <CloudIcon className="size-3.5 shrink-0" /> : <CloudOffIcon className="size-3.5 shrink-0" />}
            <span className="min-w-0 truncate">
              {connected ? `Synced via ${label}` : 'Cloud sync off'}
            </span>
            {syncing && <Loader2Icon className="size-3 animate-spin" />}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64">
          {connected ? (
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center gap-2">
                <CloudIcon className="size-4 shrink-0" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{label}</p>
                  <p className="text-muted-foreground truncate text-xs" title={statusText}>
                    {statusText}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => runSyncNow()}
                  disabled={syncing}
                >
                  {syncing ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
                  Sync now
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setSignOutOpen(true)}
                >
                  Disconnect
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              <p className="flex items-center gap-2 text-sm font-medium">
                <CloudOffIcon className="size-4" />
                Cloud sync is off
              </p>
              <p className="text-muted-foreground text-xs">
                Boards live only in this browser. Connect Google Drive or a
                WebDAV server to sync across devices.
              </p>
              <Button size="sm" onClick={() => {
                setPopoverOpen(false)
                setPickerOpen(true)
              }}>
                Set up sync
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>

      <DriveProviderDialog open={pickerOpen} onOpenChange={setPickerOpen} />
      <ConfirmDialog
        open={signOutOpen}
        onOpenChange={setSignOutOpen}
        title={`Disconnect ${label}?`}
        description="Cloud copies stay on the server; edits stop syncing until you reconnect."
        confirmLabel="Disconnect"
        onConfirm={() => {
          activeAdapter().disconnect()
          setSignOutOpen(false)
          toast.success(`Disconnected from ${label}`)
        }}
      />
    </>
  )
}