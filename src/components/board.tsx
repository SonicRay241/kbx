import { useLiveQuery } from 'dexie-react-hooks'
import { useContext, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { Link } from '@tanstack/react-router'
import type { KanbanMoveEvent } from '@/components/ui/kanban'

import { db, DEFAULT_COLUMNS, type Card as CardData } from '@/lib/db'
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

/** Layout signature (per-column card-id order), keyed by the column order of `cols`. */
const layoutSig = (cols: { id: string }[], layout: Record<string, CardData[]>) =>
  cols.map(col => (layout[col.id] ?? []).map(c => c.id).join(',')).join('|')

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
  const cardsAll = useLiveQuery(() => db.cards.where('profileId').equals(profileId).toArray(), [profileId])
  const profile = useLiveQuery(() => db.profiles.get(profileId), [profileId])
  const [dialogCardId, setDialogCardId] = useState<number | null>(null)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [confirm, setConfirm] = useState<{ title: string; description: string; action: () => void } | null>(null)

  // The kanban primitive mutates layout only in local state; here DB truth is async and
  // always authoritative, so the move handler maintains an optimistic mirror: dnd previews
  // compose against it via a ref (React state alone lags a frame behind drag RAF bursts →
  // stacked splices), and it is retired once liveQuery data matches the committed layout.
  const [pendingCards, setPendingCards] = useState<CardData[] | null>(null)
  // Layout signature of the last committed move; when liveQuery data matches it, the
  // optimistic mirror is retired (fresh DB data takes over).
  const [committedSig, setCommittedSig] = useState<string | null>(null)

  const columns = profile?.columns?.length ? profile.columns : DEFAULT_COLUMNS
  // Rightmost column is the finished anchor (leftmost when the board is rendered RTL).
  const finishedColumnId = columns[columns.length - 1].id

  const base = useMemo(
    () => (cardsAll ?? []).slice().sort((a, b) => a.order - b.order || a.createdAt - b.createdAt),
    [cardsAll]
  )

  // Latest drag layout, ref-synchronized: handleMove mutates this directly and mirrors
  // it into pendingCards for rendering.
  const dragLayoutRef = useRef<Record<string, CardData[]> | null>(null)
  const cards = useMemo(() => {
    if (!pendingCards) return base
    // The mirror only owns ORDER/column. Object CONTENT (title, upstreamIds, …) always comes
    // from the fresh liveQuery data, so mid-drag edits by other clients stay visible.
    const fresh = new Map(base.map(c => [c.id!, c]))
    return pendingCards.map(c => fresh.get(c.id!) ?? c)
  }, [pendingCards, base])
  const cardById = useMemo(() => new Map(cards.map(c => [c.id!, c])), [cards])

  // Column grouping used by both the board render and the drag handlers.
  const cardsByColumn = useMemo(() => groupByColumn(cards, columns), [cards, columns])

  // DB-truth grouping for the mirror-retirement check below.
  const baseByColumn = useMemo(() => groupByColumn(base, columns), [base, columns])

  // Retire the mirror as soon as liveQuery data reflects the committed layout, so a
  // mirror never outlives reality.
  useEffect(() => {
    if (pendingCards && cardsAll && layoutSig(columns, baseByColumn) === committedSig) {
      dragLayoutRef.current = null
      setPendingCards(null)
      setCommittedSig(null)
    }
  }, [cardsAll, pendingCards, baseByColumn, committedSig, columns])

  const blockedByUpstream = (id: number) => {
    const card = cardById.get(id)
    return !!card && card.upstreamIds.some(uId => (cardById.get(uId)?.column ?? finishedColumnId) !== finishedColumnId)
  }

  function handleAddCard(column: string) {
    void db.cards.add({
      profileId,
      column,
      title: 'New card',
      order: cardsByColumn[column]?.length ?? 0,
      upstreamIds: [],
      createdAt: Date.now()
    })
  }

  const discardMirror = () => {
    dragLayoutRef.current = null
    setPendingCards(null)
  }

  const handleMove = ({ event, commit, activeContainer, overContainer, activeIndex, overIndex }: KanbanMoveEvent) => {
    const movedId = Number(event.active.id)
    const layout = dragLayoutRef.current ?? cardsByColumn
    // Copies: the splices below compose live previews; they must never mutate the
    // memoized cardsByColumn arrays (in-place mutation makes dnd's next preview read
    // a half-composed layout → oscillating indices → no-op commits).
    const sourceItems = [...(layout[activeContainer] ?? [])]
    const targetItems = activeContainer === overContainer ? sourceItems : [...(layout[overContainer] ?? [])]

    // Veto: only *entering* the finished column is refused; reordering within it is fine.
    if (commit && overContainer === finishedColumnId && activeContainer !== overContainer && blockedByUpstream(movedId)) {
      discardMirror() // card animates back to its source spot
      // ponytail: silently refuses the move; surface a toast once the app has one
      return
    }

    let withoutMoved: CardData[] = []
    if (activeContainer !== overContainer) {
      // Cross-column drop: committed at drop (live preview is skipped for cross-column);
      // identify the moved card by id (indices are measured against the previewed layout)
      // and splice it into the target at the hover index.
      const moved = sourceItems.find(c => c.id === movedId)
      if (!moved) return
      withoutMoved = sourceItems.filter(c => c.id !== movedId)
      targetItems.splice(overIndex, 0, { ...moved, column: overContainer })
    } else if (activeIndex !== overIndex) {
      if (commit) {
        // Same-column drop: the drag-over preview already reordered `value`, and the
        // drop indices are computed against that previewed layout — persist it as-is,
        // do NOT splice again (that would insert a duplicate).
      } else {
        targetItems.splice(overIndex, 0, sourceItems.splice(activeIndex, 1)[0])
      }
    } else {
      // No positional change.
      return
    }

    // Rebuild the full layout record with the target column's new ordering.
    const nextRecord: Record<string, CardData[]> = {}
    for (const col of columns) {
      nextRecord[col.id] = col.id === overContainer ? targetItems : col.id === activeContainer ? withoutMoved : (layout[col.id] ?? [])
    }
    setPendingCards(Object.values(nextRecord).flat())
    dragLayoutRef.current = nextRecord

    if (commit) {
      // Once the liveQuery delivers rows in this exact layout, the mirror is retired.
      setCommittedSig(layoutSig(columns, nextRecord))
      // bulkUpdate opens its own rw transaction internally; wrapping it in another
      // transaction inside dnd's RAF context leaves the outer promise unsettled.
      void db.cards.bulkUpdate(nextRecord[overContainer].map((card, order) => ({ key: card.id!, changes: { order, column: card.column } })))
    }
  }

  const handleBoardDragCancel = discardMirror

  // A new drag always starts from the DB truth.
  const resetDragLayout = () => {
    dragLayoutRef.current = null
  }

  const removeColumn = (columnId: string, updateColumns: () => void) => {
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
        void db.transaction('rw', db.cards, db.profiles, async () => {
          if (moved && migrateTo) {
            await db.cards.where('[profileId+column]').equals([profileId, columnId]).modify({ column: migrateTo })
          }
          updateColumns()
        })
      }
    })
  }

  if (!cardsAll || !profile) return null

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
            // Column drags arrive here; persist the new key order.
            void db.profiles.update(profileId, { columns: Object.keys(next).map(id => columns.find(c => c.id === id)!) })
          }}
          getItemValue={item => String(item.id)}
          onMove={handleMove}
          onDragBegin={resetDragLayout}
          onDragCancel={handleBoardDragCancel}
          isDropVetoed={(activeId, containerId) => containerId === finishedColumnId && blockedByUpstream(activeId)}
          registerDragLayout={adopt => {
            // Publish the optimistic mirror so dnd-kit's preview/commit index math reads
            // the latest composed layout, not the (possibly stale) rendered value.
            adopt(dragLayoutRef)
          }}
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
      />

      <ColumnsDialog
        open={columnsOpen}
        onOpenChange={setColumnsOpen}
        profileId={profileId}
        columns={columns}
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