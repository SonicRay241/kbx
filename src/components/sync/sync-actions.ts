import { syncArchives, syncNow } from '@/sync/sync-engine'

/** syncNow that reports failures as toasts instead of unhandled rejections. */
export function runSyncNow(): void {
  syncNow().catch((error: unknown) => {
    if (error instanceof Error && error.message) {
      import('sonner').then(({ toast }) => toast.error(error.message))
    }
  })
}

/** Explicit archive pull that reports failures as toasts. */
export function runSyncArchives(): void {
  syncArchives().catch((error: unknown) => {
    if (error instanceof Error && error.message) {
      import('sonner').then(({ toast }) => toast.error(error.message))
    }
  })
}
