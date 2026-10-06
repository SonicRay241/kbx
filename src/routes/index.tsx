import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Board } from '@/lib/db'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

const addBoard = (title: string) => db.boards.add({ title, createdAt: Date.now() })

function Index() {
  const [title, setTitle] = useState('')
  const boards = useLiveQuery(() => db.boards.orderBy('createdAt').toArray())

  return (
    <div className="flex flex-col gap-4 p-4">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (!title.trim()) return
          addBoard(title.trim())
          setTitle('')
        }}
      >
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New board" />
        <Button type="submit">Add</Button>
      </form>
      <div className="flex flex-wrap gap-4">
        {boards?.map((b: Board) => (
          <Card key={b.id} className="w-64">
            <CardHeader>
              <CardTitle>{b.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <Button variant="outline" onClick={() => b.id && db.boards.delete(b.id)}>
                Delete
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

export const Route = createFileRoute('/')({
  component: Index,
})