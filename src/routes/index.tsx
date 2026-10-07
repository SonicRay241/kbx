import { createFileRoute } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { PlusIcon } from 'lucide-react'
import { useCreateProfile } from '@/components/app-shell'

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  const create = useCreateProfile()

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
      <p className="text-sm">Select a profile</p>
      <Button variant="outline" size="sm" onClick={() => create.open()}>
        <PlusIcon />
        New profile
      </Button>
    </div>
  )
}