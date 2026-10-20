import { Board } from '@/components/board'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/boards/$boardId/')({
  component: RouteComponent,
})

function RouteComponent() {
  const { boardId } = Route.useParams()

  return <Board boardId={Number(boardId)}/>
}
