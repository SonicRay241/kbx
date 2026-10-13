import { useState } from 'react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { connectWebdav, verifyWebdav } from '@/sync/adapters/webdav'
import { findStrandedSource, setActiveSource, getAdapter } from '@/sync/sync-sources'
import { runSyncNow } from './sync-actions'
import { ConfirmDialog } from '@/components/confirm-dialog'

interface WebdavConnectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface PendingSwitch {
  label: string
  onConfirm: () => void
}

/** Login form for a WebDAV server. An empty prefix defaults to "/kanban". */
export function WebdavConnectDialog({ open, onOpenChange }: WebdavConnectDialogProps) {
  const [baseUrl, setBaseUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [prefix, setPrefix] = useState('/')
  const [connecting, setConnecting] = useState(false)
  const [switchDialog, setSwitchDialog] = useState<PendingSwitch | null>(null)

  function handleConnect(): void {
    let url: URL
    try {
      url = new URL(baseUrl)
    } catch {
      toast.error('Base URL must be a valid URL, e.g. https://example.com/dav')
      return
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      toast.error('Base URL must start with http:// or https://')
      return
    }
    if (!username) {
      toast.error('Username is required')
      return
    }
    setConnecting(true)
    // Verify credentials and collection access with a real PROPFIND before
    // persisting anything. Also check for cloud data a switch would strand
    // on the previous provider (e.g. an active Google Drive index).
    Promise.all([
      verifyWebdav({ baseUrl, username, password, prefixKey: prefix }),
      findStrandedSource('webdav'),
    ])
      .then(([, stranded]) => {
        if (stranded) {
          setSwitchDialog({
            label: getAdapter(stranded).label,
            // Continue stores the verified credentials and switches.
            onConfirm: () => {
              connectWebdav({ baseUrl, username, password, prefixKey: prefix })
              setActiveSource('webdav')
              onOpenChange(false)
              toast.success('Connected to WebDAV')
              runSyncNow()
            },
          })
          return
        }
        connectWebdav({ baseUrl, username, password, prefixKey: prefix })
        setActiveSource('webdav')
        onOpenChange(false)
        toast.success('Connected to WebDAV')
        runSyncNow()
      })
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : 'Connection failed'),
      )
      .finally(() => setConnecting(false))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect to WebDAV</DialogTitle>
          <DialogDescription>
            Boards are stored in a “kanban” folder on your server. The prefix
            defaults to /; set it to relocate that folder (e.g. /Sync/Docs →
            /Sync/Docs/kanban).
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <label htmlFor="webdav-base-url" className="text-sm font-medium">
              Base URL
            </label>
            <Input
              id="webdav-base-url"
              placeholder="https://example.com/remote.php/dav/files/me"
              value={baseUrl}
              autoComplete="url"
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <label htmlFor="webdav-username" className="text-sm font-medium">
              Username
            </label>
            <Input
              id="webdav-username"
              value={username}
              autoComplete="username"
              onChange={(event) => setUsername(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <label htmlFor="webdav-password" className="text-sm font-medium">
              Password
            </label>
            <Input
              id="webdav-password"
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <label htmlFor="webdav-prefix" className="text-sm font-medium">
              Prefix path (optional)
            </label>
            <Input
              id="webdav-prefix"
              placeholder="/"
              value={prefix}
              onChange={(event) => setPrefix(event.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleConnect} disabled={connecting}>
            {connecting ? 'Connecting…' : 'Connect'}
          </Button>
        </DialogFooter>
      </DialogContent>
      <WebdavSwitchDialog
        pending={switchDialog}
        onClose={() => setSwitchDialog(null)}
      />
    </Dialog>
  )
}

function WebdavSwitchDialog({
  pending,
  onClose,
}: {
  pending: PendingSwitch | null
  onClose: () => void
}) {
  return (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      title={`${pending?.label ?? ''} still active`}
      description={`Boards are still syncing to ${pending?.label}. Switching to WebDAV leaves those cloud files in place — other devices using ${pending?.label} keep syncing there. Switch anyway?`}
      confirmLabel="Switch to WebDAV"
      onConfirm={() => {
        pending?.onConfirm()
        onClose()
      }}
    />
  )
}