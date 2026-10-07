import { createFileRoute } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { PlusIcon } from 'lucide-react'
import { useCreateBoard } from '@/components/app-shell'

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  const create = useCreateBoard()

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