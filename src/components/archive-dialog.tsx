import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { setBoardArchiveCutoff } from '@/lib/mutations'

const MS_PER = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000, // 30 days; calendar-month arithmetic is not worth the edge cases here
} as const

type Unit = keyof typeof MS_PER

const PRESETS: { label: string; value: number; unit: Unit }[] = [
  { label: '1 day', value: 1, unit: 'day' },
  { label: '1 week', value: 1, unit: 'week' },
  { label: '2 weeks', value: 2, unit: 'week' },
  { label: '1 month', value: 1, unit: 'month' },
]

/** Decompose a cutoff ms value back to (n, unit); falls back to the smallest
 * unit that represents it exactly, else days with decimals hidden. */
function decompose(cutoff: number): { n: number; unit: Unit } {
  for (const unit of ['minute', 'hour', 'day', 'week', 'month'] as Unit[]) {
    const ms = MS_PER[unit]
    if (cutoff % ms === 0) return { n: cutoff / ms, unit }
  }
  return { n: 1, unit: 'day' }
}

interface ArchiveDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  boardId: number
  /** Current cutoff in ms since epoch (0 = none). */
  archiveCutoff: number
}

/**
 * Lets the user pick how old a done task must be to archive: a preset, or a
 * custom amount via number input + unit dropdown. Saving sets the board's
 * cutoff — done cards completed before it are hidden from the board and
 * listed on /list.
 */
export function ArchiveDialog({ open, onOpenChange, boardId, archiveCutoff }: ArchiveDialogProps) {
  const initial = archiveCutoff > 0 ? decompose(archiveCutoff) : { n: 1, unit: 'day' as Unit }
  const [n, setN] = useState(initial.n)
  const [unit, setUnit] = useState<Unit>(initial.unit)
  const [activePreset, setActivePreset] = useState<string | null>(
    archiveCutoff > 0 ? PRESETS.find(p => p.value === initial.n && p.unit === initial.unit)?.label ?? null : null,
  )

  useEffect(() => {
    if (!open) return
    const d = archiveCutoff > 0 ? decompose(archiveCutoff) : { n: 1, unit: 'day' as Unit }
    setN(d.n)
    setUnit(d.unit)
    setActivePreset(archiveCutoff > 0 ? PRESETS.find(p => p.value === d.n && p.unit === d.unit)?.label ?? null : null)
  }, [open, archiveCutoff])

  const pickPreset = (label: string, value: number, unit: Unit) => {
    setActivePreset(label)
    setN(value)
    setUnit(unit)
  }

  const save = () => {
    const valid = Math.max(0, Math.floor(n) || 0)
    onOpenChange(false)
    if (valid === 0) {
      // Reset: keep every done card on the board.
      void setBoardArchiveCutoff(boardId, 0)
      return
    }
    // Cutoff is anchored to NOW: cards completed before (now − span) archive.
    void setBoardArchiveCutoff(boardId, Date.now() - valid * MS_PER[unit])
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Archive done tasks</DialogTitle>
          <DialogDescription>
            Done tasks completed before the cutoff are hidden from the board and
            stay searchable on the list page.
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
          <select
            value={unit}
            onChange={e => {
              setUnit(e.target.value as Unit)
              setActivePreset(null)
            }}
            className="h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none"
            aria-label="Unit"
          >
            {(Object.keys(MS_PER) as Unit[]).map(u => (
              <option key={u} value={u}>{u}</option>
            ))}
          </select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}