import { createFileRoute } from '@tanstack/react-router'

import { Board } from '@/components/board'

export const Route = createFileRoute('/boards/$boardId')({
  component: BoardRoute,
})

function BoardRoute() {
  const { boardId } = Route.useParams()

  return (
    <div className="w-full h-full py-4">
      <Board boardId={Number(boardId)} />
    </div>
  )
}