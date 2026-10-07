import { Outlet, createRootRoute } from '@tanstack/react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AppShell } from '@/components/app-shell'

export const Route = createRootRoute({
  component: () => (
    <TooltipProvider>
      <AppShell>
        <Outlet />
      </AppShell>
    </TooltipProvider>
  ),
})