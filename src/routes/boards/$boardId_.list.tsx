import { useMemo, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import { RotateCcwIcon, SearchIcon } from 'lucide-react'
import { db, DEFAULT_COLUMNS, type Card, type BoardRow, type Tag } from '@/lib/db'
import { moveCards } from '@/lib/mutations'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'

export const Route = createFileRoute('/boards/$boardId_/list')({
  component: BoardListRoute,
})

function BoardListRoute() {
  const { boardId } = Route.useParams()
  return <BoardList boardId={Number(boardId)} />
}

/** Per-board archive list: done cards completed before the board's cutoff. */
function BoardList({ boardId }: { boardId: number }) {
  const [query, setQuery] = useState('')

  const board = useLiveQuery(() => db.boards.get(boardId))
  const cards = useLiveQuery(() => db.cards.where('boardId').equals(boardId).toArray())
  const tags = useLiveQuery(() => db.tags.where('boardId').equals(boardId).toArray())

  const rows = useMemo(() => {
    if (!board || !cards) return []
    const finished = board.columns[board.columns.length - 1]?.id
    const cutoff = board.archiveCutoff ?? 0
    const q = query.trim().toLowerCase()
    return cards
      .filter((card: Card) => {
        if (card.column !== finished || card.completedAt === null) return false
        return cutoff > 0 && card.completedAt < cutoff
      })
      .filter((card: Card) => !q || card.title.toLowerCase().includes(q))
      .sort((a: Card, b: Card) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
  }, [board, cards, query])

  const tagById = useMemo(() => new Map((tags ?? []).map((t: Tag) => [t.id!, t])), [tags])

  const restore = async (card: Card, board: BoardRow) => {
    const finished = board.columns[board.columns.length - 1]?.id ?? DEFAULT_COLUMNS[DEFAULT_COLUMNS.length - 1].id
    const firstActive = board.columns.find(c => c.id !== finished)?.id
    if (!firstActive) return
    await moveCards([{ key: card.id, changes: { order: 0, column: firstActive } }], finished)
  }

  if (!board) return null

  return (
    <div className="flex min-h-full flex-col gap-4 p-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">
          <Link to="/boards/$boardId" params={{ boardId: String(board.id) }} className="hover:underline">
            {board.name}
          </Link>
          <span className="text-muted-foreground font-normal"> / archived</span>
        </h1>
      </div>
      <div className="relative max-w-md">
        <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2" />
        <Input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search archived tasks…"
          className="pl-8"
          aria-label="Search archived tasks"
        />
      </div>

      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {query ? 'No archived tasks match.' : 'Nothing archived. Use the board’s Archive button to hide old done tasks.'}
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border">
          {rows.map(card => (
            <li key={card.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{card.title}</p>
                {card.tagIds.length > 0 && (
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {card.tagIds.map(id => {
                      const tag = tagById.get(id)
                      if (!tag) return null
                      return (
                        <span key={id} className="text-muted-foreground flex h-4.5 items-center gap-1 rounded-sm bg-muted px-1.5 text-[11px] font-medium whitespace-nowrap" aria-label={`Tag ${tag.name}`}>
                          <span className={`size-1.5 rounded-full ${tag.color}`} />
                          {tag.name}
                        </span>
                      )
                    })}
                  </div>
                )}
              </div>
              <Badge variant="outline" className="text-muted-foreground shrink-0 font-normal tabular-nums">
                {card.completedAt ? new Date(card.completedAt).toLocaleDateString() : '—'}
              </Badge>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                aria-label={`Restore ${card.title}`}
                onClick={() => void restore(card, board)}
              >
                <RotateCcwIcon />
                Restore
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}