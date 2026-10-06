import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { db, type Profile } from '@/lib/db'
import { GripVerticalIcon, PlusIcon, Trash2Icon } from 'lucide-react'

interface ColumnsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  profileId: number
  columns: Profile['columns']
  /** Board opens a confirm dialog; resolved promise performs the removal after approval. */
  onRequestRemove: (columnId: string, perform: () => void) => void
}

let columnSeq = 0
const nextColumnId = () => `col-${Date.now().toString(36)}-${(columnSeq++).toString(36)}`

export function ColumnsDialog({ open, onOpenChange, profileId, columns, onRequestRemove }: ColumnsDialogProps) {
  const rename = (id: string, title: string) => {
    void db.profiles.update(profileId, { columns: columns.map(c => (c.id === id ? { ...c, title } : c)) })
  }

  const addColumn = () => {
    void db.profiles.update(profileId, {
      columns: [...columns, { id: nextColumnId(), title: `Column ${columns.length + 1}` }]
    })
  }

  const removeColumn = (id: string) => {
    onRequestRemove(id, () => {
      void db.profiles.update(profileId, { columns: columns.filter(c => c.id !== id) })
    })
  }

  const setAsFinished = (id: string) => {
    const target = columns.find(c => c.id === id)
    if (!target) return
    void db.profiles.update(profileId, { columns: [...columns.filter(c => c.id !== id), target] })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Columns</DialogTitle>
          <DialogDescription>
            The rightmost column is the finished state (leftmost for RTL boards). Cards are draggable once all their upstream cards are there.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {columns.map((c, i) => (
            <div key={c.id} className="flex items-center gap-2">
              {i === columns.length - 1 ? (
                <span className="w-5 shrink-0 text-center text-xs text-muted-foreground" title="Finished column (rightmost)">
                  ✓
                </span>
              ) : (
                <GripVerticalIcon className="text-muted-foreground size-4 shrink-0" />
              )}
              <Input
                value={c.title}
                onChange={e => rename(c.id, e.target.value)}
                aria-label={`Rename column ${c.title}`}
                className={i === columns.length - 1 ? 'border-green-600/40' : ''}
              />
              {i !== columns.length - 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground h-8 shrink-0 text-xs"
                  aria-label={`Set ${c.title} as finished`}
                  onClick={() => setAsFinished(c.id)}
                >
                  ✓ Finished
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete column ${c.title}`}
                className="text-muted-foreground"
                disabled={columns.length <= 1}
                onClick={() => removeColumn(c.id)}
              >
                <Trash2Icon />
              </Button>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-end">
          <Button variant="outline" size="sm" onClick={addColumn}>
            <PlusIcon />
            Add column
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}