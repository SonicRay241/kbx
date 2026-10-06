import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { db, DEFAULT_COLUMNS } from '@/lib/db'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/confirm-dialog'

function Profiles() {
  const [name, setName] = useState('')
  const [pendingDelete, setPendingDelete] = useState<{ id: number; name: string } | null>(null)
  const navigate = useNavigate()
  const profiles = useLiveQuery(() => db.profiles.orderBy('createdAt').toArray())

  return (
    <div className="flex flex-col gap-4 p-4">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (!name.trim()) return
          void db.profiles
            .add({ name: name.trim(), columns: DEFAULT_COLUMNS.map(c => ({ ...c })), createdAt: Date.now() })
            .then((id) => {
              setName('')
              void navigate({ to: '/boards/$profileId', params: { profileId: String(id) } })
            })
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New profile" />
        <Button type="submit">Add</Button>
      </form>
      <div className="flex flex-wrap gap-4">
        {profiles?.map((p) => (
          <Card key={p.id} className="w-64">
            <CardHeader>
              <CardTitle>{p.name}</CardTitle>
            </CardHeader>
            <CardContent className="flex gap-2">
              <Button asChild variant="outline">
                <Link to="/boards/$profileId" params={{ profileId: String(p.id) }}>
                  Open
                </Link>
              </Button>
              <Button
                variant="destructive"
                onClick={() => setPendingDelete({ id: p.id!, name: p.name })}
              >
                Delete
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title={`Delete profile “${pendingDelete?.name}”?`}
        description="All cards and upstream links in this profile will be permanently removed."
        onConfirm={() => {
          if (!pendingDelete) return
          void db.transaction('rw', db.cards, db.profiles, async () => {
            await db.cards.where('profileId').equals(pendingDelete.id).delete()
            await db.profiles.delete(pendingDelete.id)
          })
          setPendingDelete(null)
        }}
      />
    </div>
  )
}

export const Route = createFileRoute('/')({
  component: Profiles,
})