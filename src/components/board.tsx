import { useContext, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import type { KanbanMoveEvent } from '@/components/ui/kanban'

import { archivedCardIds, db, DEFAULT_COLUMNS, type Card as CardData, type BoardRow, type Tag } from '@/lib/db'
import { createCard, updateCard, deleteCard, moveCards, migrateCardsColumn, setBoardColumns } from '@/lib/mutations'
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
import { ArchiveIcon, ColumnsSettingsIcon, GripVerticalIcon, PlusIcon } from 'lucide-react'
import { BoardCard } from '@/components/board-card'
import { UpstreamDialog } from '@/components/upstream-dialog'
import { ColumnsDialog } from '@/components/columns-dialog'
import { ArchiveDialog } from '@/components/archive-dialog'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { BoardHeaderSlot } from '@/routes/boards/$boardId'
import { ACCENTS } from './constants/colors'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

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
  tagById: Map<number, Tag>
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
  tagById,
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
        'rounded-lg bg-muted border h-full',
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
            <Badge variant="outline" className='bg-card'>{cards.length}</Badge>
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
            <BoardCard key={String(card.id)} card={card} cardById={cardById} tagById={tagById} finishedColumnId={finishedColumnId} onEdit={overlay ? undefined : onCardClick} />
          ))}
        </KanbanColumnContent>
      </div>
    </KanbanColumn>
  )
}

export function Board({ boardId }: { boardId: number }) {
  const [cards, setCards] = useState<CardData[]>([])
  const [board, setBoard] = useState<BoardRow | null>(null)
  const [tags, setTags] = useState<Tag[]>([])

  // DB is read once on mount; local state is the render truth and every mutation
  // writes through to IndexedDB in parallel (fire-and-forget).
  useEffect(() => {
    void (async () => {
      const [p, cs, ts] = await Promise.all([
        db.boards.get(boardId),
        db.cards.where('boardId').equals(boardId).toArray(),
        db.tags.where('boardId').equals(boardId).toArray()
      ])
      setBoard(p ?? null)
      setCards(cs.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt))
      setTags(ts.sort((a, b) => a.name.localeCompare(b.name)))
    })()
  }, [boardId])

  const [dialogCardId, setDialogCardId] = useState<number | null>(null)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [hideBlocked, setHideBlocked] = useState(false)
  const [confirm, setConfirm] = useState<{ title: string; description: string; action: () => void } | null>(null)

  const columns = board?.columns?.length ? board.columns : DEFAULT_COLUMNS
  // Rightmost column is the finished anchor (leftmost when the board is rendered RTL).
  const finishedColumnId = columns[columns.length - 1].id

  // Archived = finished before the board's cutoff. Hidden from the board,
  // still listed on /list (searchable + restorable).
  const archivedById = useMemo(() => archivedCardIds(board, cards), [board, cards])

  const cardById = useMemo(() => new Map(cards.map(c => [c.id!, c])), [cards])
  const tagById = useMemo(() => new Map(tags.map(t => [t.id!, t])), [tags])

  // Blocked = at least one upstream is not finished yet. A card whose upstream
  // row is gone counts as unblocked (same fallback as the drop veto).
  const blockedIds = useMemo(() => {
    const set = new Set<number>()
    for (const card of cards) {
      if (archivedById.has(card.id)) continue
      if (card.upstreamIds.some(uId => (cardById.get(uId)?.column ?? finishedColumnId) !== finishedColumnId)) {
        set.add(card.id)
      }
    }
    return set
  }, [cards, archivedById, cardById, finishedColumnId])

  // Column grouping used by both the board render and the drag handlers —
  // archived cards stay out of it entirely (board shows active work only).
  const cardsByColumn = useMemo(
    () => groupByColumn(cards.filter(c => !archivedById.has(c.id) && !(hideBlocked && blockedIds.has(c.id))), columns),
    [cards, columns, archivedById, hideBlocked, blockedIds],
  )

  // Mid-drag composed layout (RAF bursts land between React renders, so preview
  // composition must read a ref, not possibly-stale state). Scoped to a drag: set
  // at drag start, cleared on cancel / veto / commit — outside drags it is null.
  const dragLayoutRef = useRef<Record<string, CardData[]> | null>(null)
  // Column order + card layout at drag start; veto/cancel restores it so rejected
  // moves animate back and previews never leak into the settled board.
  const dragStartSnapshot = useRef<Record<string, CardData[]> | null>(null)

  const blockedByUpstream = (id: number) => blockedIds.has(id)

  function handleAddCard(column: string) {
    // negative ids never collide with Dexie's auto-increment — the temp id only
    // needs to survive until the write resolves and the true row replaces it.
    const tempId = -Date.now()
    const siblings = cardsByColumn[column] ?? []
    // New cards land on top: a lower order than everything in the column, and the
    // card is prepended to the state array (grouping preserves that order).
    const topOrder = siblings.length ? Math.min(...siblings.map(c => c.order)) - 1 : 0
    const card: CardData = {
      id: tempId,
      uid: '', // minted by createCard; swap lands before any drag can use it
      boardId,
      column,
      title: 'New card',
      order: topOrder,
      upstreamIds: [],
      tagIds: [],
      completedAt: null,
      createdAt: Date.now()
    }
    setCards(cs => [card, ...cs])
    const { id: _tmp, uid: _uid, completedAt: _completedAt, ...row } = card
    void createCard(row).then(signed => {
      setCards(cs => cs.map(c => (c.id === card.id ? { ...c, id: signed.id!, uid: signed.uid } : c)))
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

    // A card whose last upstream just finished jumps to the top of its column so
    // it is easy to spot. Only *entering* the finished column can unblock others.
    const promoted = new Set<number>()
    if (commit && isCrossColumn && overContainer === finishedColumnId) {
      const columnOf = new Map<number, string>()
      for (const card of cards) columnOf.set(card.id, card.id === movedId ? finishedColumnId : card.column)
      for (const card of cards) {
        if (card.id === movedId || card.column === finishedColumnId) continue
        if (!card.upstreamIds.includes(movedId)) continue
        if (card.upstreamIds.every(uId => (columnOf.get(uId) ?? finishedColumnId) === finishedColumnId)) promoted.add(card.id)
      }
      for (const col of columns) {
        const list = nextRecord[col.id] ?? []
        if (!list.some(c => promoted.has(c.id))) continue
        nextRecord[col.id] = [...list.filter(c => promoted.has(c.id)), ...list.filter(c => !promoted.has(c.id))]
      }
    }

    // Preview (commit: false): mirror into the drag ref for continued composition.
    // Commit: this IS the settled layout — state and DB updated directly, ref cleared.
    dragLayoutRef.current = commit ? null : nextRecord
    if (!commit) return

    // Hidden (filtered) cards are not part of the composed layout; carry them
    // through so toggling the filter back does not lose them until reload.
    const visibleIds = new Set(Object.values(nextRecord).flat().map(c => c.id))
    setCards([...cards.filter(c => !visibleIds.has(c.id)), ...Object.values(nextRecord).flat()])
    // Persist every column whose ordering changed (the drop target plus any
    // column that received a promoted card).
    const changedColumns = columns.filter(col => {
      const before = layout[col.id] ?? []
      const after = nextRecord[col.id] ?? []
      return before.length !== after.length || before.some((card, i) => card.id !== after[i]?.id)
    })
    void moveCards(
      changedColumns.flatMap(col =>
        (nextRecord[col.id] ?? []).map((card, order) => ({ key: card.id!, changes: { order, column: card.column } })),
      ),
      finishedColumnId,
    )
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
        setBoard(p => (p ? { ...p, columns: nextColumns } : p))
        if (moved && migrateTo) {
          setCards(cs => cs.map(c => (c.column === columnId ? { ...c, column: migrateTo!, completedAt: migrateTo === finishedColumnId ? Date.now() : null } : c)))
          void migrateCardsColumn(boardId, columnId, migrateTo, finishedColumnId)
        }
        void setBoardColumns(boardId, nextColumns)
        perform()
      }
    })
  }

  if (!board) return null

  return (
    <div className="w-full h-full gap-4">
      <BoardHeaderSlot>
        <label className="text-muted-foreground flex cursor-pointer items-center gap-2 text-xs select-none">
          <Switch
            size="sm"
            checked={hideBlocked}
            onCheckedChange={setHideBlocked}
            aria-label="Hide blocked tasks"
          />
          Hide blocked
        </label>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="icon" className='size-7 rounded-md' onClick={() => setArchiveOpen(true)}>
              <ArchiveIcon className='size-3 stroke-2'/>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Archive</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="icon" className='size-7 rounded-md' onClick={() => setColumnsOpen(true)}>
              <ColumnsSettingsIcon className='size-3 stroke-2'/>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Columns settings</TooltipContent>
        </Tooltip>
      </BoardHeaderSlot>
      <div className="overflow-x-auto h-full">
        <Kanban
          value={cardsByColumn}
          onValueChange={next => {
            // Column drags arrive here; commit to state and persist the new key order.
            setCards(Object.values(next).flat())
            const nextColumns = Object.keys(next).map(id => columns.find(c => c.id === id)!)
            setBoard(p => (p ? { ...p, columns: nextColumns } : p))
            void setBoardColumns(boardId, nextColumns)
          }}
          getItemValue={item => String(item.id)}
          onMove={handleMove}
          onDragBegin={resetDragLayout}
          onDragCancel={restoreDragStart}
          isDropVetoed={(activeId, containerId) => containerId === finishedColumnId && blockedByUpstream(activeId)}
          className="relative px-4 w-fit h-full"
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
                tagById={tagById}
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
                    tagById={tagById}
                    finishedColumnId={finishedColumnId}
                    blockedByUpstream={blockedByUpstream}
                    onCardClick={setDialogCardId}
                    onAdd={handleAddCard}
                    overlay
                  />
                )
              }
              const card = cardById.get(Number(activeValue))
              return card ? <BoardCard card={card} cardById={cardById} tagById={tagById} finishedColumnId={finishedColumnId} isOverlay /> : null
            }}
          </KanbanOverlay>
        </Kanban>
      </div>

      <UpstreamDialog
        cardId={dialogCardId}
        cards={cards}
        columns={columns}
        tags={tags}
        onTagCreated={tag => setTags(ts => [...ts, tag].sort((a, b) => a.name.localeCompare(b.name)))}
        usedTagIds={cards.flatMap(c => c.tagIds)}
        onUnusedTagsDeleted={ids => setTags(ts => ts.filter(t => !ids.includes(t.id!)))}
        open={dialogCardId !== null}
        onOpenChange={open => {
          if (!open) setDialogCardId(null)
        }}
        onUpdateCard={(id, changes) => {
          setCards(cs => cs.map(c => (c.id === id ? { ...c, ...changes } : c)))
          void updateCard(id, changes)
        }}
        onDeleteCard={id => {
          setCards(cs => cs.filter(c => c.id !== id))
          void deleteCard(id)
        }}
      />

      <ColumnsDialog
        open={columnsOpen}
        onOpenChange={setColumnsOpen}
        columns={columns}
        onChangeColumns={next => {
          setBoard(p => (p ? { ...p, columns: next } : p))
          void setBoardColumns(boardId, next)
        }}
        onRequestRemove={removeColumn}
      />

      <ArchiveDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        boardId={boardId}
        archiveCutoff={board.archiveCutoff ?? 0}
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