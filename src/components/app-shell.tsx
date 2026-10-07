import { createContext, useContext, useState, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link, useNavigate, useParams } from '@tanstack/react-router'

import { db, DEFAULT_COLUMNS } from '@/lib/db'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger
} from '@/components/ui/sidebar'
import { PlusIcon, MoreHorizontalIcon, PencilIcon, Trash2Icon } from 'lucide-react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'

/**
 * Persistent shell: sidebar with profile switcher + the new-profile dialog.
 * Wrap route content as children; nested routes keep it mounted across navigation.
 * Opening the dialog from inside children is exposed via context.
 */
const CreateProfileContext = createContext<{ open: (prefill?: string) => void }>({ open: () => {} })

export const useCreateProfile = () => useContext(CreateProfileContext)

/** 3-dot menu button offering Rename / Remove. */
function ProfileDotMenu({
  profile,
  onRename,
  onRemove
}: {
  profile: { id: number; name: string }
  onRename: (p: { id: number; name: string }) => void
  onRemove: (p: { id: number; name: string }) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuAction aria-label={`Profile options for ${profile.name}`}>
          <MoreHorizontalIcon />
        </SidebarMenuAction>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="end">
        <DropdownMenuItem
          onClick={() => {
            onRename(profile)
          }}
        >
          <PencilIcon />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onClick={() => {
            onRemove(profile)
          }}
        >
          <Trash2Icon />
          Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const { profileId: routeProfileId } = useParams({ strict: false })
  const activeId = routeProfileId ? Number(routeProfileId) : null

  const profiles = useLiveQuery(() => db.profiles.orderBy('createdAt').toArray())
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [pendingDelete, setPendingDelete] = useState<{ id: number; name: string } | null>(null)
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const createProfile = () => {
    const name = newName.trim()
    if (!name) return
    void db.profiles.add({ name, columns: DEFAULT_COLUMNS.map(c => ({ ...c })), createdAt: Date.now() }).then(id => {
      setNewName('')
      setCreateOpen(false)
      void navigate({ to: '/boards/$profileId', params: { profileId: String(id) } })
    })
  }

  const openCreate = () => {
    setNewName('')
    setCreateOpen(true)
  }

  return (
    <CreateProfileContext.Provider value={{ open: openCreate }}>
      <SidebarProvider>
        <Sidebar>
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton size="default" asChild>
                  <Link to="/">
                    <span className="text-base font-semibold">Kbx</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Profiles</SidebarGroupLabel>
              <SidebarGroupAction asChild onClick={openCreate}>
                <PlusIcon aria-label="New profile" className='size-4' />
              </SidebarGroupAction>
              <SidebarGroupContent>
                <SidebarMenu>
                  {profiles?.map(p => (
                    <SidebarMenuItem key={p.id}>
                      <ContextMenu>
                        <DropdownMenu>
                          <ContextMenuTrigger asChild>
                            <DropdownMenuTrigger asChild>
                              <SidebarMenuButton asChild isActive={p.id === activeId}>
                                <button
                                  type="button"
                                  onClick={() =>
                                    void navigate({
                                      to: '/boards/$profileId',
                                      params: { profileId: String(p.id) }
                                    })
                                  }
                                >
                                  {p.name}
                                </button>
                              </SidebarMenuButton>
                            </DropdownMenuTrigger>
                          </ContextMenuTrigger>
                          <DropdownMenuContent>
                            <DropdownMenuItem
                              onClick={() => {
                                setRenaming({ id: p.id!, name: p.name })
                                setRenameValue(p.name)
                              }}
                            >
                              <PencilIcon />
                              Rename
                            </DropdownMenuItem>
                            <DropdownMenuItem variant="destructive" onClick={() => setPendingDelete({ id: p.id!, name: p.name })}>
                              <Trash2Icon />
                              Remove
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                        <ContextMenuContent>
                          <ContextMenuItem
                            onClick={() => {
                              setRenaming({ id: p.id!, name: p.name })
                              setRenameValue(p.name)
                            }}
                          >
                            <PencilIcon />
                            Rename
                          </ContextMenuItem>
                          <ContextMenuItem variant="destructive" onClick={() => setPendingDelete({ id: p.id!, name: p.name })}>
                            <Trash2Icon />
                            Remove
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                      <ProfileDotMenu profile={{ id: p.id!, name: p.name }} onRename={profile => {
                        setRenaming(profile)
                        setRenameValue(profile.name)
                      }} onRemove={setPendingDelete} />
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
        <SidebarInset>
          <header className="flex items-center gap-2 p-4 pb-0">
            <SidebarTrigger />
          </header>
          {children}
        </SidebarInset>

        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogContent className="max-w-sm">
            <form
              onSubmit={e => {
                e.preventDefault()
                createProfile()
              }}
            >
              <DialogHeader>
                <DialogTitle>New profile</DialogTitle>
              </DialogHeader>
              <Input
                autoFocus
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="Profile name"
                className="my-4"
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!newName.trim()}>
                  Create
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        <Dialog open={renaming !== null} onOpenChange={o => !o && setRenaming(null)}>
          <DialogContent className="max-w-sm">
            <form
              onSubmit={e => {
                e.preventDefault()
                const name = renameValue.trim()
                if (!name || !renaming) return
                void db.profiles.update(renaming.id, { name })
                setRenaming(null)
              }}
            >
              <DialogHeader>
                <DialogTitle>Rename profile</DialogTitle>
              </DialogHeader>
              <Input
                autoFocus
                value={renameValue}
                onChange={e => setRenameValue(e.target.value)}
                placeholder="Profile name"
                className="my-4"
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setRenaming(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!renameValue.trim()}>
                  Save
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        <ConfirmDialog
          open={pendingDelete !== null}
          onOpenChange={o => !o && setPendingDelete(null)}
          title={`Delete profile “${pendingDelete?.name}”?`}
          description="All cards and upstream links in this profile will be permanently removed."
          onConfirm={() => {
            if (!pendingDelete) return
            const wasActive = pendingDelete.id === activeId
            void db.transaction('rw', db.cards, db.profiles, async () => {
              await db.cards.where('profileId').equals(pendingDelete.id).delete()
              await db.profiles.delete(pendingDelete.id)
            })
            setPendingDelete(null)
            if (wasActive) void navigate({ to: '/' })
          }}
        />
      </SidebarProvider>
    </CreateProfileContext.Provider>
  )
}