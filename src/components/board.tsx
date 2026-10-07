import { useContext, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { Link } from '@tanstack/react-router'
import type { KanbanMoveEvent } from '@/components/ui/kanban'

import { db, DEFAULT_COLUMNS, type Card as CardData, type Profile } from '@/lib/db'
import { cn } from '@/lib/utils'
import {
  Kanban,
  KanbanBoard,
  KanbanColumn,
  KanbanColumnContent,
  KanbanColumnHandle,
  KanbanOverlay,
  VetoContext
} from '@/components/ui/kanban'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { GripVerticalIcon, ArrowLeftIcon, PlusIcon } from 'lucide-react'
import { BoardCard } from '@/components/board-card'
import { UpstreamDialog } from '@/components/upstream-dialog'
import { ColumnsDialog } from '@/components/columns-dialog'
import { ConfirmDialog } from '@/components/confirm-dialog'

const ACCENTS = [
  'bg-sky-600 dark:bg-sky-400',
  'bg-amber-600 dark:bg-amber-400',
  'bg-green-600 dark:bg-green-400',
  'bg-violet-600 dark:bg-violet-400',
  'bg-rose-600 dark:bg-rose-400'
]

/** Preserves unknown column ids (cards whose column no longer exists still render). */
function groupByColumn(cards: CardData[], columns: { id: string }[]): Record<string, CardData[]> {
  const cols: Record<string, CardData[]> = {}
  for (const col of columns) cols[col.id] = []
  for (const card of cards) (cols[card.column] ??= []).push(card)
  return cols
}

interface BoardColumnProps extends Omit<ComponentProps<typeof KanbanColumn>, 'children' | 'value'> {
  column: { id: string; title: string }
  accent: string
  cards: CardData[]
  cardById: Map<number, CardData>
  finishedColumnId: string
  blockedByUpstream: (id: number) => boolean
  onCardClick: (id: number) => void
  onAdd: (column: string) => void
  overlay?: boolean
}

function BoardColumn({
  column,
  accent,
  cards,
  cardById,
  finishedColumnId,
  blockedByUpstream,
  onCardClick,
  onAdd,
  overlay,
  ...props
} : BoardColumnProps) {
  // Inside Kanban's provider tree: vetoed=true while the hovered drop target refuses,
  // draggedCardId = the id of the card mid-drag (null when no card drag is active).
  const { vetoed, draggedCardId } = useContext(VetoContext)
  const vetoDrop =
    column.id === finishedColumnId && draggedCardId !== null && vetoed && blockedByUpstream(draggedCardId)
  return (
    <KanbanColumn
      value={column.id}
      className={cn(
        'rounded-lg',
        vetoDrop && 'bg-destructive/10 ring-destructive/40 ring-2 ring-inset'
      )}
      {...props}
    >
      <div className="flex h-full flex-col p-2">
        <div className="flex items-center justify-between gap-3 px-1 py-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className={`size-2 shrink-0 rounded-full ${accent}`} />
            <h2 className="truncate text-sm font-semibold">{column.title}</h2>
          </div>
          <div className="flex items-center gap-1.5">
            <Badge variant="outline">{cards.length}</Badge>
            {!overlay && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Add card into ${column.title}`}
                onClick={() => onAdd(column.id)}
              >
                <PlusIcon />
              </Button>
            )}
            <KanbanColumnHandle asChild className="opacity-100!">
              <Button size="icon-xs" variant="ghost" aria-label={`Move ${column.title} column`}>
                <GripVerticalIcon />
              </Button>
            </KanbanColumnHandle>
          </div>
        </div>
        <KanbanColumnContent value={column.id} className="mt-2 min-h-80 gap-2.5">
          {cards.map(card => (
            <BoardCard key={String(card.id)} card={card} cardById={cardById} finishedColumnId={finishedColumnId} onEdit={overlay ? undefined : onCardClick} />
          ))}
        </KanbanColumnContent>
      </div>
    </KanbanColumn>
  )
}

export function Board({ profileId }: { profileId: number }) {
  const [cards, setCards] = useState<CardData[]>([])
  const [profile, setProfile] = useState<Profile | null>(null)

  // DB is read once on mount; local state is the render truth and every mutation
  // writes through to IndexedDB in parallel (fire-and-forget).
  useEffect(() => {
    void (async () => {
      const [p, cs] = await Promise.all([db.profiles.get(profileId), db.cards.where('profileId').equals(profileId).toArray()])
      setProfile(p ?? null)
      setCards(cs.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt))
    })()
  }, [profileId])

  const [dialogCardId, setDialogCardId] = useState<number | null>(null)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [confirm, setConfirm] = useState<{ title: string; description: string; action: () => void } | null>(null)

  const columns = profile?.columns?.length ? profile.columns : DEFAULT_COLUMNS
  // Rightmost column is the finished anchor (leftmost when the board is rendered RTL).
  const finishedColumnId = columns[columns.length - 1].id

  const cardById = useMemo(() => new Map(cards.map(c => [c.id!, c])), [cards])

  // Column grouping used by both the board render and the drag handlers.
  const cardsByColumn = useMemo(() => groupByColumn(cards, columns), [cards, columns])

  // Mid-drag composed layout (RAF bursts land between React renders, so preview
  // composition must read a ref, not possibly-stale state). Scoped to a drag: set
  // at drag start, cleared on cancel / veto / commit — outside drags it is null.
  const dragLayoutRef = useRef<Record<string, CardData[]> | null>(null)
  // Column order + card layout at drag start; veto/cancel restores it so rejected
  // moves animate back and previews never leak into the settled board.
  const dragStartSnapshot = useRef<Record<string, CardData[]> | null>(null)

  const blockedByUpstream = (id: number) => {
    const card = cardById.get(id)
    return !!card && card.upstreamIds.some(uId => (cardById.get(uId)?.column ?? finishedColumnId) !== finishedColumnId)
  }

  function handleAddCard(column: string) {
    const card: CardData = {
      // negative ids never collide with Dexie's auto-increment — the temp id only
      // needs to survive until the write resolves and the true row replaces it.
      id: -Date.now(),
      profileId,
      column,
      title: 'New card',
      order: cardsByColumn[column]?.length ?? 0,
      upstreamIds: [],
      createdAt: Date.now()
    }
    setCards(cs => [...cs, card])
    // Dexie auto-increments only when the key is absent — strip the temp id and let
    // add() generate the real one, then swap it into state.
    const { id: _tmp, ...row } = card
    void db.cards.add(row).then(id => {
      setCards(cs => cs.map(c => (c.id === card.id ? { ...c, id } : c)))
    })
  }

  const restoreDragStart = () => {
    if (dragStartSnapshot.current) {
      setCards(Object.values(dragStartSnapshot.current).flat())
      dragLayoutRef.current = null
      dragStartSnapshot.current = null
    }
  }

  const handleMove = ({ event, commit, activeContainer, overContainer, activeIndex, overIndex }: KanbanMoveEvent) => {
    const movedId = Number(event.active.id)
    const layout = dragLayoutRef.current ?? cardsByColumn
    // Copies: the splices below compose live previews; they must never mutate the
    // memoized cardsByColumn arrays (in-place mutation makes dnd's next preview read
    // a half-composed layout → oscillating indices → no-op commits).
    const sourceItems = [...(layout[activeContainer] ?? [])]
    const targetItems = activeContainer === overContainer ? sourceItems : [...(layout[overContainer] ?? [])]
    const isCrossColumn = activeContainer !== overContainer

    // Veto: only *entering* the finished column is refused; reordering within it is fine.
    if (commit && isCrossColumn && overContainer === finishedColumnId && blockedByUpstream(movedId)) {
      restoreDragStart() // card animates back to its source spot
      // ponytail: silently refuses the move; surface a toast once the app has one
      return
    }

    let withoutMoved: CardData[] = []
    if (isCrossColumn) {
      // Cross-column drop: identified by id (indices are measured against the
      // previewed layout) and spliced into the target at the hover index.
      const moved = sourceItems.find(c => c.id === movedId)
      if (!moved) return
      withoutMoved = sourceItems.filter(c => c.id !== movedId)
      targetItems.splice(overIndex, 0, { ...moved, column: overContainer })
    } else if (activeIndex !== overIndex) {
      if (!commit) {
        targetItems.splice(overIndex, 0, sourceItems.splice(activeIndex, 1)[0])
      }
      // commit: the drag-over preview already reordered `value`, and the drop indices
      // are computed against that previewed layout — keep it as-is, no second splice
      // (that would insert a duplicate).
    } else {
      // No positional change.
      return
    }

    // Rebuild the full layout record with the target column's new ordering.
    const nextRecord: Record<string, CardData[]> = {}
    for (const col of columns) {
      nextRecord[col.id] = col.id === overContainer ? targetItems : col.id === activeContainer ? withoutMoved : (layout[col.id] ?? [])
    }

    // Preview (commit: false): mirror into the drag ref for continued composition.
    // Commit: this IS the settled layout — state and DB updated directly, ref cleared.
    dragLayoutRef.current = commit ? null : nextRecord
    if (!commit) return

    setCards(Object.values(nextRecord).flat())
    void db.cards.bulkUpdate(nextRecord[overContainer].map((card, order) => ({ key: card.id!, changes: { order, column: card.column } })))
  }

  // A new drag always starts from the current layout — compose previews against that.
  const resetDragLayout = () => {
    dragLayoutRef.current = { ...cardsByColumn }
    dragStartSnapshot.current = { ...cardsByColumn }
  }

  const removeColumn = (columnId: string, perform: () => void) => {
    const name = columns.find(c => c.id === columnId)?.title ?? columnId
    const moved = cardsByColumn[columnId]?.length ?? 0
    // Migrate its cards into the finished column — except when it IS the finished column; then the previous surviving column takes over.
    const migrateTo = columnId === finishedColumnId ? (columns.findLast(c => c.id !== columnId)?.id ?? null) : finishedColumnId
    setConfirm({
      title: `Delete column “${name}”?`,
      description: moved
        ? migrateTo
          ? `Its ${moved} ${moved === 1 ? 'card' : 'cards'} will be moved to “${columns.find(c => c.id === migrateTo)?.title}”.`
          : `Its ${moved} ${moved === 1 ? 'card' : 'cards'} will be deleted.`
        : 'Upstream links pointing into this column stay valid.',
      action: () => {
        const nextColumns = columns.filter(c => c.id !== columnId)
        setProfile(p => (p ? { ...p, columns: nextColumns } : p))
        if (moved) {
          setCards(cs => cs.map(c => (c.column === columnId ? { ...c, column: migrateTo! } : c)))
        }
        void db.transaction('rw', db.cards, db.profiles, async () => {
          if (moved && migrateTo) {
            await db.cards.where('[profileId+column]').equals([profileId, columnId]).modify({ column: migrateTo })
          }
          await db.profiles.update(profileId, { columns: nextColumns })
        })
        perform()
      }
    })
  }

  if (!profile) return null

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to="/" aria-label="Back to profiles">
            <ArrowLeftIcon />
          </Link>
        </Button>
        <h1 className="text-lg font-semibold">{profile.name}</h1>
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => setColumnsOpen(true)}>
          Columns
        </Button>
      </div>
      <div className="overflow-x-auto">
        <Kanban
          value={cardsByColumn}
          onValueChange={next => {
            // Column drags arrive here; commit to state and persist the new key order.
            setCards(Object.values(next).flat())
            const nextColumns = Object.keys(next).map(id => columns.find(c => c.id === id)!)
            setProfile(p => (p ? { ...p, columns: nextColumns } : p))
            void db.profiles.update(profileId, { columns: nextColumns })
          }}
          getItemValue={item => String(item.id)}
          onMove={handleMove}
          onDragBegin={resetDragLayout}
          onDragCancel={restoreDragStart}
          isDropVetoed={(activeId, containerId) => containerId === finishedColumnId && blockedByUpstream(activeId)}
          className="mx-auto w-full max-w-5xl"
        >
          <KanbanBoard
            className="grid auto-rows-fr gap-3"
            style={{ gridTemplateColumns: `repeat(${columns.length},minmax(15rem,1fr))` }}
          >
            {columns.map((col, i) => (
              <BoardColumn
                key={col.id}
                column={col}
                accent={ACCENTS[i % ACCENTS.length]}
                cards={cardsByColumn[col.id] ?? []}
                cardById={cardById}
                finishedColumnId={finishedColumnId}
                blockedByUpstream={blockedByUpstream}
                onCardClick={setDialogCardId}
                onAdd={handleAddCard}
              />
            ))}
          </KanbanBoard>
          <KanbanOverlay>
            {({ value, variant }) => {
              const activeValue = String(value)
              if (variant === 'column') {
                const idx = columns.findIndex(c => c.id === activeValue)
                return (
                  <BoardColumn
                    column={columns[idx] ?? { id: activeValue, title: activeValue }}
                    accent={ACCENTS[idx >= 0 ? idx % ACCENTS.length : 0]}
                    cards={cardsByColumn[activeValue] ?? []}
                    cardById={cardById}
                    finishedColumnId={finishedColumnId}
                    blockedByUpstream={blockedByUpstream}
                    onCardClick={setDialogCardId}
                    onAdd={handleAddCard}
                    overlay
                  />
                )
              }
              const card = cardById.get(Number(activeValue))
              return card ? <BoardCard card={card} cardById={cardById} finishedColumnId={finishedColumnId} isOverlay /> : null
            }}
          </KanbanOverlay>
        </Kanban>
      </div>

      <UpstreamDialog
        cardId={dialogCardId}
        cards={cards}
        columns={columns}
        open={dialogCardId !== null}
        onOpenChange={open => {
          if (!open) setDialogCardId(null)
        }}
        onUpdateCard={(id, changes) => {
          setCards(cs => cs.map(c => (c.id === id ? { ...c, ...changes } : c)))
          void db.cards.update(id, changes)
        }}
        onDeleteCard={id => {
          setCards(cs => cs.filter(c => c.id !== id))
          void db.cards.delete(id)
        }}
      />

      <ColumnsDialog
        open={columnsOpen}
        onOpenChange={setColumnsOpen}
        columns={columns}
        onChangeColumns={next => {
          setProfile(p => (p ? { ...p, columns: next } : p))
          void db.profiles.update(profileId, { columns: next })
        }}
        onRequestRemove={removeColumn}
      />

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={o => !o && setConfirm(null)}
        title={confirm?.title ?? ''}
        description={confirm?.description ?? ''}
        onConfirm={() => {
          confirm?.action()
          setConfirm(null)
        }}
      />
    </div>
  )
}