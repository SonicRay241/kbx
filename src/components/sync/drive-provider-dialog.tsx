import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { connectDrive } from '@/sync/google-auth'
import { isGdriveConfigured } from '@/sync/sync-engine'
import { setActiveSource, getAdapter, type SyncSourceId } from '@/sync/sync-sources'
import { runSyncNow } from '@/components/sync/sync-actions'
import { WebdavConnectDialog } from '@/components/sync/webdav-connect-dialog'
import { useState } from 'react'

interface DriveProviderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Source picker shown when the user wants to connect a drive provider.
 * Choosing a provider persists it as the sync source; WebDAV additionally
 * opens its login form, Google Drive starts the OAuth popup flow.
 */
export function DriveProviderDialog({ open, onOpenChange }: DriveProviderDialogProps) {
  const [webdavFormOpen, setWebdavFormOpen] = useState(false)

  function selectProvider(source: SyncSourceId): void {
    if (source === 'webdav') {
      // The WebDAV form persists the source only after credentials verify.
      setWebdavFormOpen(true)
      return
    }
    onOpenChange(false)
    // Persist the source only after auth succeeds: cancelling the popup would
    // otherwise strand a connected WebDAV config behind an inactive source.
    connectDrive()
      .then(() => {
        setActiveSource('gdrive')
        toast.success('Connected to Google Drive')
        runSyncNow()
      })
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : 'Connection failed'),
      )
  }

  // When the WebDAV form succeeds it has already activated the source; closing
  // it without connecting means the picker stays usable.
  function handleWebdavFormChange(next: boolean): void {
    setWebdavFormOpen(next)
    if (!next && getAdapter('webdav').isConnected()) onOpenChange(false)
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect cloud sync</DialogTitle>
            <DialogDescription>
              Choose where boards are stored. You can switch providers later
              from the sidebar.

            </DialogDescription>
          </DialogHeader>
          {isGdriveConfigured() && (
            <Button variant="outline" className="flex-col items-start h-fit py-2" onClick={() => selectProvider('gdrive')}>
              <p>Google Drive</p>
              <p className='font-normal text-xs text-muted-foreground'>Connect to Google Drive</p>
            </Button>
          )}
          <Button variant="outline" className="flex-col items-start h-fit py-2" onClick={() => selectProvider('webdav')}>
            <p>WebDAV</p>
            <p className='font-normal text-xs text-muted-foreground'>Bring your own cloud via WebDAV</p>
          </Button>
        </DialogContent>
      </Dialog>
      <WebdavConnectDialog
        open={webdavFormOpen}
        onOpenChange={handleWebdavFormChange}
      />
    </>
  )
}