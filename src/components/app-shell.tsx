import { createContext, useContext, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Link, useNavigate, useParams } from "@tanstack/react-router";

import { db, DEFAULT_COLUMNS } from "@/lib/db";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import {
  PlusIcon,
  MoreHorizontalIcon,
  PencilIcon,
  Trash2Icon,
  HomeIcon,
  SearchIcon,
} from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

/**
 * Persistent shell: sidebar with board switcher + the new-board dialog.
 * Wrap route content as children; nested routes keep it mounted across navigation.
 * Opening the dialog from inside children is exposed via context.
 */
const CreateBoardContext = createContext<{
  open: (prefill?: string) => void;
}>({ open: () => {} });

export const useCreateBoard = () => useContext(CreateBoardContext);

/** 3-dot menu button offering Rename / Remove. */
function BoardDotMenu({
  board,
  onRename,
  onRemove,
}: {
  board: { id: number; name: string };
  onRename: (p: { id: number; name: string }) => void;
  onRemove: (p: { id: number; name: string }) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuAction showOnHover aria-label={`Board options for ${board.name}`}>
          <MoreHorizontalIcon/>
        </SidebarMenuAction>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="end">
        <DropdownMenuItem
          onClick={() => {
            onRename(board);
          }}
        >
          <PencilIcon className="size-3.5" />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onClick={() => {
            onRemove(board);
          }}
        >
          <Trash2Icon className="size-3.5" />
          Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { boardId: routeBoardId } = useParams({ strict: false });
  const activeId = routeBoardId ? Number(routeBoardId) : null;

  const boards = useLiveQuery(() =>
    db.boards.orderBy("createdAt").toArray(),
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<{
    id: number;
    name: string;
  } | null>(null);
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(
    null,
  );

  const createBoard = () => {
    const name = newName.trim();
    if (!name) return;
    void db.boards
      .add({
        name,
        columns: DEFAULT_COLUMNS.map((c) => ({ ...c })),
        createdAt: Date.now(),
      })
      .then((id) => {
        setNewName("");
        setCreateOpen(false);
        void navigate({
          to: "/boards/$boardId",
          params: { boardId: String(id) },
        });
      });
  };

  const openCreateBoard = () => {
    setNewName("");
    setCreateOpen(true);
  };

  return (
    <CreateBoardContext.Provider value={{ open: openCreateBoard }}>
      <SidebarProvider>
        <Sidebar>
          <SidebarContent>
            <SidebarGroup>
              <SidebarContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton className="[&>svg]:size-3.5" asChild>
                    <Link to="/">
                      <HomeIcon/>
                      <span>Home</span>
                    </Link>
                    </SidebarMenuButton>
                    <SidebarMenuButton className="[&>svg]:size-3.5" asChild>
                    <button>
                      <SearchIcon/>
                      <span>Search</span>
                    </button>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarContent>
            </SidebarGroup>
            <SidebarGroup>
              <SidebarGroupLabel>Boards</SidebarGroupLabel>
              <SidebarGroupAction
                className="[&>svg]:size-3"
                onClick={openCreateBoard}
              >
                <PlusIcon aria-label="New board" />
              </SidebarGroupAction>
              <SidebarGroupContent>
                <SidebarMenu>
                  {boards?.map((p) => (
                    <SidebarMenuItem key={p.id} className="group/sidebar-item">
                      <BoardDotMenu
                        board={{ id: p.id!, name: p.name }}
                        onRename={setEditing}
                        onRemove={setPendingDelete}
                      />
                      <ContextMenu>
                        <ContextMenuTrigger asChild>
                          <SidebarMenuButton
                            asChild
                            isActive={p.id === activeId}
                          >
                            {editing?.id === p.id ? (
                              <input
                                defaultValue={p.name}
                                onClick={(e) => e.stopPropagation()}
                                onBlur={(e) => {
                                  const name = e.target.value.trim();
                                  if (name && name !== p.name)
                                    void db.boards.update(p.id!, { name });
                                  setEditing(null);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    e.currentTarget.blur();
                                  } else if (e.key === "Escape") {
                                    setEditing(null);
                                  }
                                }}
                                className="h-6 w-full rounded-sm border-none bg-sidebar-accent px-2 text-sm font-medium outline-hidden"
                                aria-label="Rename board"
                              />
                            ) : (
                              <button
                                type="button"
                                onClick={() =>
                                  void navigate({
                                    to: "/boards/$boardId",
                                    params: { boardId: String(p.id) },
                                  })
                                }
                              >
                                {p.name}
                              </button>
                            )}
                          </SidebarMenuButton>
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          <ContextMenuItem
                            onClick={() =>
                              setEditing({ id: p.id!, name: p.name })
                            }
                          >
                            <PencilIcon className="size-3.5" />
                            Rename
                          </ContextMenuItem>
                          <ContextMenuItem
                            variant="destructive"
                            onClick={() =>
                              setPendingDelete({ id: p.id!, name: p.name })
                            }
                          >
                            <Trash2Icon className="size-3.5" />
                            Remove
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
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
              onSubmit={(e) => {
                e.preventDefault();
                createBoard();
              }}
            >
              <DialogHeader>
                <DialogTitle>New board</DialogTitle>
              </DialogHeader>
              <Input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="BoardRow name"
                className="my-4"
              />
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setCreateOpen(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={!newName.trim()}>
                  Create
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        <ConfirmDialog
          open={pendingDelete !== null}
          onOpenChange={(o) => !o && setPendingDelete(null)}
          title={`Delete board “${pendingDelete?.name}”?`}
          description="All cards and upstream links in this board will be permanently removed."
          onConfirm={() => {
            if (!pendingDelete) return;
            const wasActive = pendingDelete.id === activeId;
            void db.transaction("rw", db.cards, db.boards, async () => {
              await db.cards
                .where('boardId')
                .equals(pendingDelete.id)
                .delete();
              await db.boards.delete(pendingDelete.id);
            });
            setPendingDelete(null);
            if (wasActive) void navigate({ to: "/" });
          }}
        />
      </SidebarProvider>
    </CreateBoardContext.Provider>
  );
}
