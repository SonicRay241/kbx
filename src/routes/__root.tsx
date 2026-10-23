import { Outlet, createRootRoute } from '@tanstack/react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { AppShell } from '@/components/app-shell'
import { SyncToastBridge } from '@/components/sync/sync-toast'

export const Route = createRootRoute({
  component: () => (
    <TooltipProvider>
      <AppShell>
        <Outlet />
      </AppShell>
      <SyncToastBridge />
      <Toaster />
    </TooltipProvider>
  ),
})