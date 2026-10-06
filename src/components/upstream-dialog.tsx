import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { CircleCheckIcon, GitBranchIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import { db, type Card as CardData } from '@/lib/db'
import { ConfirmDialog } from '@/components/confirm-dialog'

interface UpstreamDialogProps {
  cardId: number | null
  cards: CardData[]
  columns: { id: string; title: string }[]
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function UpstreamDialog({ cardId, cards, columns, open, onOpenChange }: UpstreamDialogProps) {
  const [selected, setSelected] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const card = cards.find(c => c.id === cardId)

  if (!card || !open) return null

  const finishedColumnId = columns[columns.length - 1].id

  // Would linking candidate → card create a cycle? (candidate can already reach card)
  const createsCycle = (candidateId: number) => {
    const reachable = new Set<number>([candidateId])
    let grew = true
    while (grew) {
      grew = false
      for (const c of cards) {
        if (c.id !== undefined && !reachable.has(c.id) && c.upstreamIds.some(uId => reachable.has(uId))) {
          reachable.add(c.id)
          grew = true
        }
      }
    }
    return reachable.has(card.id!)
  }

  const upstreams = card.upstreamIds.map(id => cards.find(c => c.id === id)).filter(c => c) as CardData[]
  const done = upstreams.filter(c => c.column === finishedColumnId).length
  const pct = upstreams.length ? Math.round((done / upstreams.length) * 100) : 0
  const candidates = cards
    .filter(c => c.id !== card.id && !card.upstreamIds.includes(c.id!) && !createsCycle(c.id!))
    .sort((a, b) => a.title.localeCompare(b.title))

  const addUpstream = () => {
    const id = Number(selected)
    if (!id) return
    void db.cards.update(card.id!, { upstreamIds: [...card.upstreamIds, id] })
    setSelected('')
  }

  const deleteCard = () => {
    const id = card.id!
    void db.transaction('rw', db.cards, async () => {
      const all = await db.cards.where('profileId').equals(card.profileId).toArray()
      await db.cards.delete(id)
      const referencing = all.filter(c => c.upstreamIds.includes(id))
      await db.cards.bulkUpdate(
        referencing.map(c => ({ key: c.id!, changes: { upstreamIds: c.upstreamIds.filter(u => u !== id) } }))
      )
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="inset-0 flex h-dvh max-w-none translate-x-0 translate-y-0 flex-col rounded-none border-none bg-background p-6 sm:max-w-none">
        <DialogHeader>
          <Input
            value={card.title}
            onChange={e => void db.cards.update(card.id!, { title: e.target.value })}
            className="border-none bg-transparent px-0 text-lg font-semibold shadow-none focus-visible:ring-0"
            aria-label="Card title"
          />
          <DialogTitle className="sr-only">{card.title} upstream tasks</DialogTitle>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <GitBranchIcon className="size-4" />
            <span>
              {done} of {upstreams.length} upstream tasks finished ({pct}%)
            </span>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          {upstreams.length === 0 ? (
            <p className="text-muted-foreground py-8 text-center text-sm">No upstream tasks.</p>
          ) : (
            upstreams.map(u => (
              <div key={u.id} className="flex items-center gap-3 rounded-lg border p-3">
                {u.column === finishedColumnId ? (
                  <CircleCheckIcon className="size-4 shrink-0 text-green-600 dark:text-green-400" />
                ) : (
                  <GitBranchIcon className="text-muted-foreground size-4 shrink-0" />
                )}
                <p className="min-w-0 flex-1 truncate text-sm font-medium">{u.title}</p>
                <span
                  className={cn(
                    'text-xs whitespace-nowrap',
                    u.column === finishedColumnId ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'
                  )}
                >
                  {columns.find(c => c.id === u.column)?.title ?? u.column}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove upstream ${u.title}`}
                  onClick={() => void db.cards.update(card.id!, { upstreamIds: card.upstreamIds.filter(uId => uId !== u.id) })}
                >
                  <XIcon />
                </Button>
              </div>
            ))
          )}
        </div>

        <div className="flex items-center gap-2 border-t pt-4">
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="h-9 flex-1 rounded-md border bg-background px-3 text-sm outline-none"
            aria-label="Select a card to add as upstream"
          >
            <option value="" disabled>
              Select a card…
            </option>
            {candidates.map(c => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
          <Button onClick={addUpstream} disabled={!selected}>
            Add upstream
          </Button>
          <Button
            variant="destructive"
            onClick={() => setConfirmDelete(true)}
          >
            Delete card
          </Button>
        </div>

        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={`Delete “${card.title}”?`}
          description="Upstream links pointing to this card will be removed from other cards."
          onConfirm={deleteCard}
        />
      </DialogContent>
    </Dialog>
  )
}