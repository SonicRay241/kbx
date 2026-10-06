import { Outlet, createRootRoute, Link } from '@tanstack/react-router'

export const Route = createRootRoute({
  component: () => (
    <>
      <nav className="border-b px-4 py-2">
        <Link to="/" className="text-sm font-semibold">
          Kanban
        </Link>
      </nav>
      <Outlet />
    </>
  ),
})