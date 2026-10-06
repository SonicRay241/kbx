import { createFileRoute } from '@tanstack/react-router'

import { Board } from '@/components/board'

export const Route = createFileRoute('/boards/$profileId')({
  component: BoardRoute,
})

function BoardRoute() {
  const { profileId } = Route.useParams()

  return (
    <div className="p-4">
      <Board profileId={Number(profileId)} />
    </div>
  )
}