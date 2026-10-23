import { createContext, useContext, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";

import { DEFAULT_COLUMNS } from "@/lib/db";
import { createBoard as createBoardRow } from "@/lib/mutations";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Kbd } from "@/components/ui/kbd";
import { useShortcut, useShortcutLabel } from "@/lib/shortcuts";
import { HomeIcon, SearchIcon, LayersPlusIcon } from "lucide-react";
import { SyncPanel } from "@/components/sync/sync-panel";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SidebarTree } from "@/components/sidebar-tree";
import { SearchDialog } from "@/components/search-dialog";

/**
 * Persistent shell: sidebar with board switcher + the new-board dialog.
 * Wrap route content as children; nested routes keep it mounted across navigation.
 * Opening the dialog from inside children is exposed via context.
 */
const CreateBoardContext = createContext<{
  open: (prefill?: string) => void;
}>({ open: () => {} });

export const useCreateBoard = () => useContext(CreateBoardContext);

/** Sidebar toggle lives here because it needs the provider context. */
function SidebarShortcuts() {
  const { toggleSidebar } = useSidebar();
  useShortcut("toggle-sidebar", toggleSidebar);
  return null;
}

export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { boardId: routeBoardId } = useParams({ strict: false });
  const activeId = routeBoardId ? Number(routeBoardId) : null;
  const searchShortcut = useShortcutLabel("toggle-search-modal");

  const [createOpen, setCreateOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  useShortcut("toggle-search-modal", () => setSearchOpen((open) => !open));
  const [newName, setNewName] = useState("");

  const createBoard = () => {
    const name = newName.trim();
    if (!name) return;
    void createBoardRow(name, DEFAULT_COLUMNS).then((id) => {
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
        <SidebarShortcuts />
        <Sidebar collapsible="icon">
          <SidebarHeader className="pb-0">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton className="p-0.5 group-data-[collapsible=icon]:p-0.5!">
                  <div className="relative px-0.5 flex w-full gap-4 [&_svg]:size-3.5">
                    <Link
                      to="/"
                      className="flex h-8 shrink-0 items-center gap-2 py-2 overflow-hidden rounded-md text-sm outline-hidden sidebar-menu-button hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring active:bg-sidebar-accent"
                    >
                      <div className="flex aspect-square size-6 items-center justify-center rounded-sm bg-blue-600 text-white">
                        <LayersPlusIcon strokeWidth={2.5} />
                      </div>
                      <span className="font-medium">kbx.</span>
                    </Link>
                    <SidebarTrigger className="p-1 absolute right-0 top-0.5 z-10 hover:opacity-100 group-data-[collapsible=icon]:bg-sidebar group-data-[collapsible=icon]:opacity-0" />
                  </div>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton className="[&>svg]:size-3.5" asChild tooltip="Home">
                    <Link to="/">
                      <HomeIcon />
                      <span className="transition-opacity group-data-[collapsible=icon]:opacity-0">Home</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    className="[&>svg]:size-3.5"
                    onClick={() => setSearchOpen(true)}
                    tooltip={
                      searchShortcut
                        ? {
                            // SidebarMenuButton spreads a props object into
                            // TooltipContent; a bare element renders nothing.
                            children: (
                              <span className="flex items-center gap-1.5">
                                Search
                                <Kbd>{searchShortcut}</Kbd>
                              </span>
                            ),
                          }
                        : "Search"
                    }
                  >
                    <SearchIcon />
                    <span className="transition-opacity group-data-[collapsible=icon]:opacity-0">Search</span>
                    {searchShortcut && (
                      <Kbd className="ml-auto opacity-0 transition-opacity group-hover/menu-button:opacity-100 group-data-[collapsible=icon]:hidden">
                        {searchShortcut}
                      </Kbd>
                    )}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
            <SidebarTree activeId={activeId} onCreateBoard={openCreateBoard} />
          </SidebarContent>
          <SidebarFooter className="pt-0">
            <div className="flex items-center gap-1">
              <div className="min-w-0 flex-1">
                <SyncPanel />
              </div>
              <ThemeToggle />
            </div>
          </SidebarFooter>
        </Sidebar>
        <SidebarInset className="relative min-h-dvh">
          <header className="absolute top-4 left-4 md:hidden">
            <SidebarTrigger/>
          </header>
          {children}
        </SidebarInset>

        <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />

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
                placeholder="Board name"
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

      </SidebarProvider>
    </CreateBoardContext.Provider>
  );
}
