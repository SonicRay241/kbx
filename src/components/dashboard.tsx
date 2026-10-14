import { useLiveQuery } from 'dexie-react-hooks'
import { Link } from '@tanstack/react-router'
import { useMemo } from 'react'

import { db, type Card } from '@/lib/db'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { PlusIcon } from 'lucide-react'
import { useCreateBoard } from '@/components/app-shell'

const ACCENTS = [
  'bg-sky-600 dark:bg-sky-400',
  'bg-amber-600 dark:bg-amber-400',
  'bg-green-600 dark:bg-green-400',
  'bg-violet-600 dark:bg-violet-400',
  'bg-rose-600 dark:bg-rose-400'
]

export function Dashboard() {
  const create = useCreateBoard()
  const boards = useLiveQuery(() => db.boards.orderBy('createdAt').toArray())
  const cards = useLiveQuery(() => db.cards.toArray())

  const stats = useMemo(() => {
    if (!boards || !cards) return null
    const finishedByBoard = new Map(boards.map(b => [b.id!, b.columns[b.columns.length - 1]?.id]))
    const byBoard = new Map(boards.map(b => [b.id!, [] as Card[]]))
    for (const c of cards) {
      const list = byBoard.get(c.boardId)
      if (list) list.push(c)
    }
    const perBoard = boards.map((b, i) => {
      const list = byBoard.get(b.id!) ?? []
      const finishedColumnId = finishedByBoard.get(b.id!) ?? ''
      const cols = b.columns.map(col => ({ title: col.title, count: list.filter(c => c.column === col.id).length }))
      const finished = list.filter(c => c.column === finishedColumnId).length
      return {
        id: b.id!,
        name: b.name,
        accent: ACCENTS[i % ACCENTS.length],
        columns: cols,
        total: list.length,
        finished,
        pct: list.length ? Math.round((finished / list.length) * 100) : 0
      }
    })
    return {
      perBoard,
      ongoing: cards.length - cards.filter(c => c.column === (finishedByBoard.get(c.boardId) ?? '')).length,
      completed: cards.filter(c => c.column === (finishedByBoard.get(c.boardId) ?? '')).length
    }
  }, [boards, cards])

  if (!stats) return null

  if (stats.perBoard.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
        <p className="text-sm">Select a board</p>
        <Button variant="outline" size="sm" onClick={() => create.open()}>
          <PlusIcon />
          New board
        </Button>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 grid-rows-[auto_auto_1fr] gap-3 p-6">
      <div className="col-span-1 flex flex-col justify-between rounded-xl bg-card p-5 ring-1 ring-foreground/10">
        <p className="text-muted-foreground text-sm">Total ongoing tasks</p>
        <p className="text-4xl font-semibold tabular-nums">{stats.ongoing}</p>
      </div>
      <div className="col-span-1 flex flex-col justify-between rounded-xl bg-card p-5 ring-1 ring-foreground/10">
        <p className="text-muted-foreground text-sm">Total completed tasks</p>
        <p className="text-4xl font-semibold tabular-nums">{stats.completed}</p>
      </div>

      {stats.perBoard.map(b => (
        <Link
          key={b.id}
          to="/boards/$boardId"
          params={{ boardId: String(b.id) }}
          className="col-span-2 flex flex-col gap-3 rounded-xl bg-card p-5 ring-1 ring-foreground/10 transition-colors hover:bg-sidebar-accent sm:col-span-1"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className={`size-2 shrink-0 rounded-full ${b.accent}`} />
              <h3 className="truncate text-sm font-semibold">{b.name}</h3>
            </div>
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
              {b.finished}/{b.total}
            </span>
          </div>
          <Progress value={b.pct} className="h-1.5" />
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {b.columns.map(col => (
              <span key={col.title} className="text-muted-foreground text-xs tabular-nums">
                {col.title} <span className="text-foreground font-medium">{col.count}</span>
              </span>
            ))}
          </div>
        </Link>
      ))}
    </div>
  )
}