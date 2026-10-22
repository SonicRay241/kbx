import { useState } from 'react'
import { ChevronsUpDownIcon, ListChecksIcon, ListXIcon, RotateCcwIcon, SearchIcon } from 'lucide-react'
import type { Card } from '@/lib/db'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

type TaskSelectorProps = {
  cards: Card[]
  /** Picked ids — drives the row dots. */
  selected: Set<number>
  onToggle: (id: number) => void
  columnTitle: (id: string) => string
  triggerLabel: string
  /** Rows that cannot be picked (e.g. would create an upstream cycle). */
  disabledIds?: Set<number>
  onSelectAll?: () => void
  onClear?: () => void
  onReset?: () => void
  align?: 'start' | 'end'
  triggerClassName?: string
}

/** Searchable task picker. Shared by the lineage view and the card dialog. */
export function TaskSelector({
  cards,
  selected,
  onToggle,
  columnTitle,
  triggerLabel,
  disabledIds,
  onSelectAll,
  onClear,
  onReset,
  align = 'end',
  triggerClassName,
}: TaskSelectorProps) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const visible = q ? cards.filter((c) => c.title.toLowerCase().includes(q)) : cards

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={triggerClassName ?? 'min-w-56 justify-between'}>
          <span>{triggerLabel}</span>
          <ChevronsUpDownIcon className="text-muted-foreground size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-80 p-0">
        <div className="p-2">
          <div className="relative">
            <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="bg-muted h-8 border-0 pl-8"
              aria-label="Search tasks"
            />
          </div>
        </div>
        <div className="max-h-72 overflow-y-auto border-t p-1">
          {visible.map((card) => {
            const disabled = disabledIds?.has(card.id) ?? false
            return (
              <button
                key={card.id}
                type="button"
                disabled={disabled}
                onClick={() => onToggle(card.id)}
                aria-pressed={selected.has(card.id)}
                className="hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm disabled:pointer-events-none disabled:opacity-50"
              >
                <span className="truncate font-medium">{card.title}</span>
                <span className="text-muted-foreground truncate text-xs">{columnTitle(card.column)}</span>
                <span
                  className={`ml-auto size-2 shrink-0 rounded-full ${selected.has(card.id) ? 'bg-primary' : 'border'}`}
                />
              </button>
            )
          })}
          {visible.length === 0 && <p className="text-muted-foreground px-2 py-1.5 text-sm">No tasks match.</p>}
        </div>
        {(onClear || onSelectAll || onReset) && (
          <div className="grid grid-cols-2 gap-1 border-t p-2">
            {onClear && (
              <Button variant="secondary" size="sm" className="justify-between" onClick={onClear}>
                Clear
                <ListXIcon />
              </Button>
            )}
            {onSelectAll && (
              <Button
                variant="secondary"
                size="sm"
                className={`justify-between ${onClear ? '' : 'col-span-2'}`}
                onClick={onSelectAll}
              >
                Select all
                <ListChecksIcon />
              </Button>
            )}
            {onReset && (
              <Button variant="secondary" size="sm" className="col-span-2 justify-between" onClick={onReset}>
                Reset (to default)
                <RotateCcwIcon />
              </Button>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}