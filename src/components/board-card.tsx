import type { ComponentProps } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { KanbanItem, KanbanItemHandle } from '@/components/ui/kanban'
import { cn } from '@/lib/utils'
import { GitBranchIcon } from 'lucide-react'
import type { Card as CardData } from '@/lib/db'

interface BoardCardProps extends Omit<ComponentProps<typeof KanbanItem>, 'value' | 'children'> {
  card: CardData
  cardById: Map<number, CardData>
  finishedColumnId: string
  isOverlay?: boolean
  onEdit?: (id: number) => void
}

export function BoardCard({ card, cardById, finishedColumnId, isOverlay, onEdit, ...props }: BoardCardProps) {
  const upstreams = card.upstreamIds.map(id => cardById.get(id)).filter(c => c) as CardData[]
  const doneCount = upstreams.filter(c => c.column === finishedColumnId).length
  const pct = upstreams.length ? Math.round((doneCount / upstreams.length) * 100) : null
  const blocked = upstreams.length > 0 && doneCount < upstreams.length

  const inner = (
    <Card
      size="sm"
      // onClick={onEdit ? () => onEdit(card.id!) : undefined}
      className={cn(
        'overflow-hidden shadow-none transition-all rotate-0',
        !isOverlay && 'hover:-translate-y-0.5 cursor-pointer',
        isOverlay && 'ring-primary/20 rotate-1 ring-2'
      )}
    >
      <CardContent className="space-y-3">
        <h3 className="line-clamp-2 text-sm leading-snug font-semibold">{card.title}</h3>

        {pct === null ? (
          <p className="text-muted-foreground text-[11px]">No upstream tasks</p>
        ) : (
          <div className="space-y-1.5">
            <div className="text-muted-foreground flex items-center justify-between text-[11px]">
              <span>Upstream</span>
              <span className="font-medium tabular-nums">
                {pct}% · {doneCount}/{upstreams.length}
              </span>
            </div>
            <Progress value={pct} className="h-1.5" />
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          {blocked ? (
            <Badge variant="destructive" className="rounded">
              Blocked
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="rounded border-green-600/50 font-normal text-green-600 dark:border-green-400/50 dark:text-green-400"
            >
              Ready
            </Badge>
          )}
          {onEdit && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground h-7 text-xs"
              onClick={(e) => {
                e.stopPropagation()
                onEdit(card.id!)
              }}
            >
              <GitBranchIcon />
              Upstream {upstreams.length}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )

  return (
    <KanbanItem value={String(card.id)} disabled={blocked && !isOverlay ? { draggable: true } : undefined} {...props}>
      {isOverlay ? (
        inner
      ) : (
        <KanbanItemHandle className={cn(blocked && 'cursor-not-allowed!')}>
          <span className={cn('block', blocked && 'opacity-60')}>{inner}</span>
        </KanbanItemHandle>
      )}
    </KanbanItem>
  )
}