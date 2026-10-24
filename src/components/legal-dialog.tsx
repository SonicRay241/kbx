import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { LegalContent } from '@/components/legal-content'
import { LEGAL_DOCS, LEGAL_HASHES, LEGAL_LAST_UPDATED, type LegalDoc } from '@/lib/legal'

/**
 * Legal notices live behind URL fragments (`#privacy-policy`, `#terms`) so any
 * link — in the sync popover, a README, or an OAuth consent screen — can open
 * them without a route. The `/privacy-policy` and `/terms` routes exist for
 * crawlers and hand off to these fragments. The dialog owns the hash: closing
 * it drops the fragment.
 */
export function LegalHashDialog() {
  const [doc, setDoc] = useState<LegalDoc | null>(null)

  useEffect(() => {
    const sync = () => setDoc(LEGAL_HASHES[window.location.hash] ?? null)
    sync()
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])

  const close = () => {
    setDoc(null)
    if (LEGAL_HASHES[window.location.hash]) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }

  return (
    <Dialog open={doc !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-h-[85vh] max-w-2xl gap-0 overflow-y-auto p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="text-base">{doc ? LEGAL_DOCS[doc].title : ''}</DialogTitle>
          <DialogDescription>Last updated: {LEGAL_LAST_UPDATED}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 px-5 py-4 text-sm text-muted-foreground">
          <LegalContent doc={doc ?? 'privacy'} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
