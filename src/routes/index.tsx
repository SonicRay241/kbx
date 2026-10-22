import { createFileRoute } from '@tanstack/react-router'
import { Dashboard } from '@/components/dashboard'
import { useEffect } from 'react'

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  useEffect(() => {
    document.title = "kbx"
  })
  return <Dashboard />
}