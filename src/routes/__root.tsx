import { Outlet, createRootRoute, useRouterState } from '@tanstack/react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { AppShell } from '@/components/app-shell'
import { SyncToastBridge } from '@/components/sync/sync-toast'
import { LegalHashDialog } from '@/components/legal-dialog'

/** Legal documents render as plain pages — no sidebar, no app chrome. */
const BARE_ROUTES = new Set(['/privacy-policy', '/terms'])

export const Route = createRootRoute({
  component: RootLayout,
})

function RootLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const bare = BARE_ROUTES.has(pathname)
  return (
    <TooltipProvider>
      {bare ? (
        <Outlet />
      ) : (
        <AppShell>
          <Outlet />
        </AppShell>
      )}
      <SyncToastBridge />
      <LegalHashDialog />
      <Toaster />
    </TooltipProvider>
  )
}