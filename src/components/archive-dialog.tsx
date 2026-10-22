import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ChevronDownIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { setBoardArchive } from '@/lib/mutations'

const MS_PER = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000, // 30 days; calendar-month arithmetic is not worth the edge cases here
} as const

type Unit = keyof typeof MS_PER

const PRESETS: { label: string; value: number; unit: Unit }[] = [
  { label: 'Now', value: 0, unit: 'minute' },
  { label: '1 day', value: 1, unit: 'day' },
  { label: '1 week', value: 1, unit: 'week' },
  { label: '2 weeks', value: 2, unit: 'week' },
  { label: '1 month', value: 1, unit: 'month' },
]

/** The stored value is a window (`n × unit`), so it decomposes exactly. */
function decompose(after: number): { n: number; unit: Unit } {
  if (after <= 0) return { n: 0, unit: 'minute' }
  for (const unit of ['minute', 'hour', 'day', 'week', 'month'] as Unit[]) {
    if (after % MS_PER[unit] === 0) return { n: after / MS_PER[unit], unit }
  }
  return { n: Math.round(after / MS_PER.minute), unit: 'minute' }
}

interface ArchiveDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  boardId: number
  /** Window the checkpoint was derived from; null when off. */
  archiveSpan: number | null
  /** Applied locally so the board re-renders without a reload. */
  onSaved: (cutoff: number, span: number | null) => void
}

/**
 * Archive checkpoint: saving freezes "now − span" and hides every done card
 * completed before it. The checkpoint only moves when saved again — pick the
 * span again to advance it ("Now" archives everything that is already done).
 */
export function ArchiveDialog({ open, onOpenChange, boardId, archiveSpan, onSaved }: ArchiveDialogProps) {
  const initial = archiveSpan == null ? { n: 1, unit: 'day' as Unit } : decompose(archiveSpan)
  const [n, setN] = useState(initial.n)
  const [unit, setUnit] = useState<Unit>(initial.unit)
  const [activePreset, setActivePreset] = useState<string | null>(
    archiveSpan == null ? null : PRESETS.find(p => p.value === initial.n && p.unit === initial.unit)?.label ?? null,
  )

  useEffect(() => {
    if (!open) return
    const d = archiveSpan == null ? { n: 1, unit: 'day' as Unit } : decompose(archiveSpan)
    setN(d.n)
    setUnit(d.unit)
    setActivePreset(archiveSpan == null ? null : PRESETS.find(p => p.value === d.n && p.unit === d.unit)?.label ?? null)
  }, [open, archiveSpan])

  const pickPreset = (label: string, value: number, unit: Unit) => {
    setActivePreset(label)
    setN(value)
    setUnit(unit)
  }

  const save = () => {
    const valid = Math.max(0, Math.floor(n) || 0)
    const span = valid * MS_PER[unit]
    const cutoff = Date.now() - span
    onOpenChange(false)
    void setBoardArchive(boardId, cutoff, span)
    onSaved(cutoff, span)
  }

  /** Archive everything that is already done: a zero-length window. */
  const archiveAll = () => {
    const cutoff = Date.now()
    onOpenChange(false)
    void setBoardArchive(boardId, cutoff, 0)
    onSaved(cutoff, 0)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Archive done tasks</DialogTitle>
          <DialogDescription>
            Done tasks completed more than this long ago are hidden from the board
            and stay searchable on the list page.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map(p => (
            <Button
              key={p.label}
              type="button"
              size="sm"
              variant={activePreset === p.label ? 'default' : 'outline'}
              onClick={() => pickPreset(p.label, p.value, p.unit)}
            >
              {p.label}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={0}
            value={n}
            onChange={e => {
              setN(Number(e.target.value))
              setActivePreset(null)
            }}
            className="w-24"
            aria-label="Archive after amount"
          />
          {/* appearance-none: the native control ignores border-radius, so its
              corners never matched the number input. */}
          <div className="relative">
            <select
              value={unit}
              onChange={e => {
                setUnit(e.target.value as Unit)
                setActivePreset(null)
              }}
              className="h-8 w-full appearance-none rounded-lg border border-input bg-transparent pr-7 pl-2.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              aria-label="Unit"
            >
              {(Object.keys(MS_PER) as Unit[]).map(u => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
            <ChevronDownIcon className="text-muted-foreground pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={archiveAll}>Archive all</Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
