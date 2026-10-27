import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Textarea } from '@/components/ui/textarea'
import { AlignLeftIcon, GitBranchIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import type { Card as CardData, Tag } from '@/lib/db'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { TagsCombobox } from '@/components/tags-combobox'
import { TaskSelector } from '@/components/task-selector'
import { softAccentBadge } from '@/components/constants/colors'
import { cn } from '@/lib/utils'

interface UpstreamDialogProps {
  cardId: number | null
  cards: CardData[]
  columns: { id: string; title: string }[]
  /** All tags for this card's board. */
  tags: Tag[]
  /** Write-through: a newly created tag row (persisted in DB) joins the board's tag list. */
  onTagCreated: (tag: Tag) => void
  /** Ids of tags referenced by any card (powers the remove-unused action). */
  usedTagIds: number[]
  /** Write-through: unused tags were deleted; parent drops them from its tag list. */
  onUnusedTagsDeleted: (ids: number[]) => void
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Write-through updates so the board's local state is the single render truth. */
  onUpdateCard: (id: number, changes: Partial<CardData>) => void
  onDeleteCard: (id: number) => void
  /** Archived cards open the same modal, read-only: no edits, no delete. */
  readOnly?: boolean
}

export function UpstreamDialog({ cardId, cards, columns, tags, onTagCreated, usedTagIds, onUnusedTagsDeleted, open, onOpenChange, onUpdateCard, onDeleteCard, readOnly = false }: UpstreamDialogProps) {
  const [confirmDelete, setConfirmDelete] = useState(false)

  const card = cards.find(c => c.id === cardId)

  if (!card || !open) return null

  const finishedColumnId = columns[columns.length - 1].id
  const columnTitle = (id: string) => columns.find(c => c.id === id)?.title ?? id
  const badgeFor = (id: string) => softAccentBadge(Math.max(columns.findIndex(c => c.id === id), 0))

  const upstreamIds = new Set(card.upstreamIds)
  const upstreams = card.upstreamIds.map(id => cards.find(c => c.id === id)).filter(c => c) as CardData[]
  const done = upstreams.filter(c => c.column === finishedColumnId).length
  const pct = upstreams.length ? Math.round((done / upstreams.length) * 100) : 0

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

  // Self and anything that would close a loop. Already-linked cards stay enabled so they can be unticked.
  const blockedIds = new Set(
    cards.filter(c => c.id === card.id || (!upstreamIds.has(c.id!) && createsCycle(c.id!))).map(c => c.id!)
  )
  const addable = cards.filter(c => !blockedIds.has(c.id!) && !upstreamIds.has(c.id!))

  const toggleUpstream = (id: number) => {
    onUpdateCard(card.id!, {
      upstreamIds: upstreamIds.has(id)
        ? card.upstreamIds.filter(uId => uId !== id)
        : [...card.upstreamIds, id],
    })
  }

  const deleteCard = () => {
    const id = card.id!
    onDeleteCard(id)
    for (const other of cards) {
      if (other.upstreamIds.includes(id)) {
        onUpdateCard(other.id!, { upstreamIds: other.upstreamIds.filter(u => u !== id) })
      }
    }
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-5/6 min-h-5/6 w-full max-w-[min(calc(5/6*100%),var(--container-3xl))] flex-col gap-0 p-4 sm:max-w-[min(calc(5/6*100%),var(--container-3xl))]">
        <DialogHeader className="gap-2 border-b pb-4">
          <Input
            value={card.title}
            readOnly={readOnly}
            onChange={e => onUpdateCard(card.id!, { title: e.target.value })}
            className="border-none bg-transparent px-0 pr-4 text-base font-semibold shadow-none focus-visible:ring-0 md:text-lg dark:bg-card"
            aria-label="Card title"
          />
          <DialogTitle className="sr-only">{card.title}</DialogTitle>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">
              in list{' '}
              <span className="text-foreground font-medium underline decoration-border underline-offset-2">
                {columnTitle(card.column)}
              </span>
            </span>
            {readOnly && (
              <span className="text-muted-foreground ring-border rounded px-1.5 py-0.5 text-[11px] uppercase tracking-wide ring-1">
                Archived · read-only
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">Labels</span>
            {readOnly ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {card.tagIds.length === 0 ? (
                  <span className="text-muted-foreground text-xs">None</span>
                ) : (
                  tags
                    .filter(tag => card.tagIds.includes(tag.id!))
                    .map(tag => (
                      <span key={tag.id} className={cn('rounded px-2 py-0.5 text-xs', tag.color)}>
                        {tag.name}
                      </span>
                    ))
                )}
              </div>
            ) : (
              <TagsCombobox
                boardId={card.boardId}
                tags={tags}
                onTagCreated={onTagCreated}
                usedTagIds={usedTagIds}
                onUnusedTagsDeleted={onUnusedTagsDeleted}
                selected={card.tagIds}
                onChange={tagIds => onUpdateCard(card.id!, { tagIds })}
              />
            )}
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto py-4">
          <section className="space-y-2">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <AlignLeftIcon className="text-muted-foreground size-4" />
              Description
            </h3>
            <Textarea
              value={card.description ?? ''}
              readOnly={readOnly}
              onChange={e => onUpdateCard(card.id!, { description: e.target.value })}
              placeholder={readOnly ? 'No description.' : 'Add a more detailed description…'}
              aria-label="Description"
              className="bg-muted max-h-48 min-h-24 resize-none overflow-y-auto border-0 focus-visible:ring-0"
            />
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <GitBranchIcon className="text-muted-foreground size-4" />
                Upstream
              </h3>
              {!readOnly && (
                <TaskSelector
                  cards={cards.filter(c => c.id !== card.id)}
                  selected={upstreamIds}
                  disabledIds={blockedIds}
                  onToggle={toggleUpstream}
                  onSelectAll={() => onUpdateCard(card.id!, { upstreamIds: [...card.upstreamIds, ...addable.map(c => c.id!)] })}
                  columnTitle={columnTitle}
                  triggerLabel={upstreams.length ? `${upstreams.length} selected` : 'Add upstream'}
                  triggerClassName="w-40 justify-between"
                />
              )}
            </div>

            <div className="flex items-center gap-2">
              <span className="text-muted-foreground w-8 shrink-0 text-xs tabular-nums">{pct}%</span>
              <Progress value={pct} className="h-1.5" />
            </div>

            {upstreams.length === 0 ? (
              <p className="text-muted-foreground py-6 text-center text-sm">No upstream tasks.</p>
            ) : (
              <div className="space-y-1">
                {upstreams.map(u => (
                  <div key={u.id} className="flex items-center gap-2 rounded-lg border px-3 py-2">
                    <p className="min-w-0 flex-1 truncate text-sm font-medium">{u.title}</p>
                    <span className={cn('flex h-5 items-center rounded px-2 text-xs', badgeFor(u.column))}>
                      {columnTitle(u.column)}
                    </span>
                    {!readOnly && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove upstream ${u.title}`}
                        onClick={() => toggleUpstream(u.id!)}
                      >
                        <XIcon />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {!readOnly && (
          <div className="flex justify-end border-t pt-4">
            <Button variant="destructive" onClick={() => setConfirmDelete(true)}>
              Delete card
            </Button>
          </div>
        )}

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