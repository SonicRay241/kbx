import { useCallback, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useNavigate } from "@tanstack/react-router";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowDownIcon,
  ArrowDownToLineIcon,
  ArrowUpIcon,
  ArrowUpToLineIcon,
  CheckIcon,
  ChevronRightIcon,
  FolderInputIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";

import { db, type BoardRow, type Workspace } from "@/lib/db";
import {
  createWorkspace,
  deleteBoard,
  deleteWorkspace,
  renameBoard,
  renameWorkspace,
  saveSidebarLayout,
  setBoardWorkspace,
} from "@/lib/mutations";
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Separator } from "@base-ui/react";

/**
 * Sidebar as one flat, sortable list: optional ungrouped boards first, then a
 * header per workspace followed by its boards. Membership is positional — the
 * boards after a header belong to it — so a single SortableContext handles
 * reordering, dragging into a group and dragging out of one.
 */
type Entry =
  | { key: string; kind: "group"; workspace: Workspace | null }
  | { key: string; kind: "board"; board: BoardRow };

/** Sentinel header for boards outside every workspace, so a dragged workspace
 * has a slot above them without swallowing them. */
const UNGROUPED = "w:null";

const COLLAPSED_KEY = "sidebar-collapsed";

function loadCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "{}");
  } catch {
    return {};
  }
}

/** Sortable row: drag listeners on the row itself (4px threshold keeps clicks). */
function SortableRow({ id, className, children }: { id: string; className?: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <SidebarMenuItem
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`touch-none ${isDragging ? "z-10 opacity-70" : ""} ${className ?? ""}`}
      {...listeners}
      {...attributes}
      role={undefined}
      tabIndex={undefined}
    >
      {children}
    </SidebarMenuItem>
  );
}

function MoveItems({ onMove }: { onMove: (mode: MoveMode) => void }) {
  return (
    <>
      <DropdownMenuItem onClick={() => onMove("up")}>
        <ArrowUpIcon className="size-3.5" />
        Move up
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => onMove("down")}>
        <ArrowDownIcon className="size-3.5" />
        Move down
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => onMove("top")}>
        <ArrowUpToLineIcon className="size-3.5" />
        Move to top
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => onMove("bottom")}>
        <ArrowDownToLineIcon className="size-3.5" />
        Move to bottom
      </DropdownMenuItem>
    </>
  );
}

type MoveMode = "up" | "down" | "top" | "bottom";

export function SidebarTree({ activeId, onCreateBoard }: { activeId: number | null; onCreateBoard: () => void }) {
  const navigate = useNavigate();
  // Empty-array default keeps the live query result referentially stable.
  const boards = useLiveQuery(() => db.boards.toArray(), [], []);
  const workspaces = useLiveQuery(() => db.workspaces.toArray(), [], []);

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);
  const [editing, setEditing] = useState<{ kind: "board" | "workspace"; id: number; name: string } | null>(null);
  const [removing, setRemoving] = useState<BoardRow | null>(null);
  const [removingWorkspace, setRemovingWorkspace] = useState<Workspace | null>(null);
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");

  const entries = useMemo<Entry[]>(() => {
    const order = (row: { sidebarOrder?: number; createdAt: number }) => row.sidebarOrder ?? row.createdAt;
    const sortedBoards = [...boards].sort((a, b) => order(a) - order(b));
    const sortedWorkspaces = [...workspaces].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
    const known = new Set(sortedWorkspaces.map((w) => w.id));
    const list: Entry[] = [];
    const ungrouped = sortedBoards.filter((board) => !board.workspaceId || !known.has(board.workspaceId));
    if (ungrouped.length > 0) {
      list.push({ key: UNGROUPED, kind: "group", workspace: null });
      for (const board of ungrouped) list.push({ key: `b:${board.id}`, kind: "board", board });
    }
    for (const workspace of sortedWorkspaces) {
      list.push({ key: `w:${workspace.id}`, kind: "group", workspace });
      for (const board of sortedBoards) {
        if (board.workspaceId === workspace.id) list.push({ key: `b:${board.id}`, kind: "board", board });
      }
    }
    return list;
  }, [boards, workspaces]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  // The click that follows a drop (pointerup on the row) would otherwise open the
  // board. Navigation is a plain navigate() call, gated on both signals: a drag
  // just ended, or the pointer travelled past the 4px drag threshold.
  const draggedAt = useRef(0);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const wasDrag = useCallback((event: React.MouseEvent) => {
    if (event.detail === 0) return false; // keyboard activation, no pointer travel
    if (Date.now() - draggedAt.current < 200) return true;
    const start = pressStart.current;
    return !!start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4;
  }, []);
  const rememberPress = useCallback((event: React.PointerEvent) => {
    pressStart.current = { x: event.clientX, y: event.clientY };
  }, []);

  const persist = (list: Entry[]) => {
    const workspaceIds: number[] = [];
    const rows: { id: number; workspaceId: number | null }[] = [];
    let current: number | null = null;
    for (const entry of list) {
      if (entry.kind === "group") {
        current = entry.workspace?.id ?? null;
        if (current !== null) workspaceIds.push(current);
      } else {
        rows.push({ id: entry.board.id!, workspaceId: current });
      }
    }
    void saveSidebarLayout({ workspaces: workspaceIds, boards: rows });
  };

  /** Move a board next to `over`, or into the group when dropped on its header. */
  const moveBoardTo = (list: Entry[], from: number, overKey: string, after: boolean): Entry[] => {
    const next = [...list];
    const [moved] = next.splice(from, 1);
    let target = next.findIndex((entry) => entry.key === overKey);
    if (target < 0) return list;
    if (next[target].kind === "group") target += 1;
    // Dropping on the lower half of a row inserts after it, so dragging one
    // slot down is not a no-op.
    else if (after) target += 1;
    next.splice(target, 0, moved);
    return next;
  };

  /** Group headers travel with their boards. */
  const moveGroupTo = (list: Entry[], from: number, overKey: string): Entry[] => {
    let end = from + 1;
    while (end < list.length && list[end].kind === "board") end++;
    const block = list.slice(from, end);
    const rest = [...list.slice(0, from), ...list.slice(end)];
    const overIndex = rest.findIndex((entry) => entry.key === overKey);
    if (overIndex < 0) return list;
    let target = overIndex;
    if (rest[overIndex].kind !== "group") {
      // Dropped on a board: take that board's group's slot.
      for (let i = overIndex; i >= 0; i--) {
        if (rest[i].kind === "group") {
          target = i;
          break;
        }
      }
    }
    return [...rest.slice(0, target), ...block, ...rest.slice(target)];
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    draggedAt.current = Date.now();
    if (!over || active.id === over.id) return;
    const from = entries.findIndex((entry) => entry.key === active.id);
    if (from < 0) return;
    const entry = entries[from];
    const translated = active.rect.current.translated;
    const after = translated
      ? translated.top + translated.height / 2 > over.rect.top + over.rect.height / 2
      : false;
    const next =
      entry.kind === "group"
        ? moveGroupTo(entries, from, String(over.id))
        : moveBoardTo(entries, from, String(over.id), after);
    if (next !== entries) persist(next);
  };

  /** Menu equivalent of a drag: up/down/top/bottom inside the item's group. */
  const moveEntry = (key: string, mode: MoveMode) => {
    const from = entries.findIndex((entry) => entry.key === key);
    if (from < 0) return;
    const entry = entries[from];
    const siblings = entries
      .map((item, index) => ({ item, index }))
      .filter(({ item }) =>
        entry.kind === "group"
          ? item.kind === "group"
          : item.kind === "board" && (item.board.workspaceId ?? null) === (entry.board.workspaceId ?? null),
      );
    const position = siblings.findIndex(({ index }) => index === from);
    const target =
      mode === "up" ? position - 1 : mode === "down" ? position + 1 : mode === "top" ? 0 : siblings.length - 1;
    if (target < 0 || target >= siblings.length || target === position) return;
    const destination = siblings[target];
    if (entry.kind === "group") {
      persist(moveGroupTo(entries, from, destination.item.key));
    } else {
      persist(arrayMove(entries, from, destination.index));
    }
  };

  const toggleCollapsed = (workspace: Workspace) => {
    setCollapsed((prev) => {
      const next = { ...prev, [workspace.uid]: !prev[workspace.uid] };
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
      return next;
    });
  };

  const submitWorkspace = () => {
    const name = newWorkspaceName.trim();
    if (!name) return;
    void createWorkspace(name);
    setNewWorkspaceName("");
    setNewWorkspaceOpen(false);
  };

  const editingInput = (current: { id: number; name: string }, save: (name: string) => void, label: string) => (
    <input
      autoFocus
      defaultValue={current.name}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onBlur={(event) => {
        const name = event.target.value.trim();
        if (name && name !== current.name) save(name);
        setEditing(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          setEditing(null);
        }
      }}
      className="h-6 w-full rounded-sm border-none bg-sidebar-accent px-2 text-sm font-medium outline-hidden"
      aria-label={label}
    />
  );

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Workspaces</SidebarGroupLabel>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarGroupAction aria-label="Add board or workspace">
            <PlusIcon className="[&>svg]:size-3" />
          </SidebarGroupAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="bottom">
          <DropdownMenuItem onClick={onCreateBoard}>
            <PlusIcon className="size-3.5" />
            New board
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              setNewWorkspaceName("");
              setNewWorkspaceOpen(true);
            }}
          >
            <FolderInputIcon className="size-3.5" />
            New workspace
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SidebarGroupContent className="group-data-[collapsible=icon]:hidden">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={entries.map((entry) => entry.key)} strategy={verticalListSortingStrategy}>
            <SidebarMenu>
              {entries.map((entry) => {
                if (entry.kind === "group" && !entry.workspace) {
                  return (
                    <SidebarMenuItem key={entry.key} className="pointer-events-none">
                      <div className="text-muted-foreground px-2 pt-2 pb-1 text-xs">Ungrouped</div>
                    </SidebarMenuItem>
                  );
                }
                if (entry.kind === "group") {
                  // The null-workspace sentinel returned above.
                  const workspace = entry.workspace!;
                  const members = entries.filter(
                    (item) => item.kind === "board" && item.board.workspaceId === workspace.id,
                  ).length;
                  const folded = collapsed[workspace.uid] ?? false;
                  return (
                    <SortableRow key={entry.key} id={entry.key} className="group/workspace">
                      {editing?.kind === "workspace" && editing.id === workspace.id ? (
                        <div className="flex h-8 items-center px-2">
                          {editingInput(
                            editing,
                            (name) => void renameWorkspace(workspace.id!, name),
                            "Rename workspace",
                          )}
                        </div>
                      ) : (
                        <SidebarMenuButton
                          onPointerDown={rememberPress}
                          onClick={(event) => {
                            if (!wasDrag(event)) toggleCollapsed(workspace);
                          }}
                          className="text-sm font-medium"
                          title={workspace.name}
                        >
                          <ChevronRightIcon
                            className={`size-3.5 transition-transform ${folded ? "" : "rotate-90"}`}
                          />
                          <span className="truncate">{workspace.name}</span>
                          <span className="text-muted-foreground ml-auto text-xs translate-x-5 tabular-nums">{members}</span>
                        </SidebarMenuButton>
                      )}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <SidebarMenuAction className="bg-sidebar-accent" showOnHover aria-label={`Workspace options for ${workspace.name}`}>
                            <MoreHorizontalIcon />
                          </SidebarMenuAction>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent side="bottom" align="end">
                          <DropdownMenuItem
                            onClick={() => setEditing({ kind: "workspace", id: workspace.id!, name: workspace.name })}
                          >
                            <PencilIcon className="size-3.5" />
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <MoveItems onMove={(mode) => moveEntry(entry.key, mode)} />
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onClick={() => setRemovingWorkspace(workspace)}>
                            <Trash2Icon className="size-3.5" />
                            Delete workspace
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </SortableRow>
                  );
                }

                const board = entry.board;
                const folded = board.workspaceId
                  ? (collapsed[workspaces.find((w) => w.id === board.workspaceId)?.uid ?? ""] ?? false)
                  : false;
                if (folded) return null;
                return (
                  <SortableRow key={entry.key} id={entry.key} className={board.workspaceId ? "relative pl-6" : ""}>
                    {board.workspaceId &&
                      <Separator orientation="vertical" className="absolute left-4 w-px h-full bg-border"/>
                    }
                    {editing?.kind === "board" && editing.id === board.id ? (
                      <SidebarMenuButton asChild>
                        {editingInput(editing, (name) => void renameBoard(board.id!, name), "Rename board")}
                      </SidebarMenuButton>
                    ) : (
                      <SidebarMenuButton
                        isActive={board.id === activeId}
                        onPointerDown={rememberPress}
                        onClick={(event) => {
                          if (wasDrag(event)) return;
                          void navigate({ to: "/boards/$boardId", params: { boardId: String(board.id) } });
                        }}
                      >
                        <span className="truncate">{board.name}</span>
                      </SidebarMenuButton>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <SidebarMenuAction showOnHover aria-label={`Board options for ${board.name}`}>
                          <MoreHorizontalIcon />
                        </SidebarMenuAction>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent side="bottom" align="end">
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger>
                            <FolderInputIcon className="size-3.5" />
                            Move to workspace
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent>
                            <DropdownMenuItem onClick={() => void setBoardWorkspace(board.id!, null)}>
                              <span className="flex-1">No workspace</span>
                              {!board.workspaceId && <CheckIcon className="size-3.5" />}
                            </DropdownMenuItem>
                            {[...workspaces]
                              .sort((a, b) => a.order - b.order)
                              .map((workspace) => (
                                <DropdownMenuItem
                                  key={workspace.id}
                                  onClick={() => void setBoardWorkspace(board.id!, workspace.id!)}
                                >
                                  <span className="flex-1 truncate">{workspace.name}</span>
                                  {board.workspaceId === workspace.id && <CheckIcon className="size-3.5" />}
                                </DropdownMenuItem>
                              ))}
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                        <DropdownMenuSeparator />
                        <MoveItems onMove={(mode) => moveEntry(entry.key, mode)} />
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => setEditing({ kind: "board", id: board.id!, name: board.name })}>
                          <PencilIcon className="size-3.5" />
                          Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onClick={() => setRemoving(board)}>
                          <Trash2Icon className="size-3.5" />
                          Remove
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </SortableRow>
                );
              })}
            </SidebarMenu>
          </SortableContext>
        </DndContext>
      </SidebarGroupContent>

      <Dialog open={newWorkspaceOpen} onOpenChange={setNewWorkspaceOpen}>
        <DialogContent className="max-w-sm">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submitWorkspace();
            }}
          >
            <DialogHeader>
              <DialogTitle>New workspace</DialogTitle>
            </DialogHeader>
            <Input
              autoFocus
              value={newWorkspaceName}
              onChange={(event) => setNewWorkspaceName(event.target.value)}
              placeholder="Workspace name"
              className="my-4"
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setNewWorkspaceOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!newWorkspaceName.trim()}>
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Delete board “${removing?.name}”?`}
        description="All cards and upstream links in this board will be permanently removed."
        onConfirm={() => {
          if (!removing) return;
          const wasActive = removing.id === activeId;
          void deleteBoard(removing.id!);
          setRemoving(null);
          if (wasActive) void navigate({ to: "/" });
        }}
      />

      <ConfirmDialog
        open={removingWorkspace !== null}
        onOpenChange={(open) => !open && setRemovingWorkspace(null)}
        title={`Delete workspace “${removingWorkspace?.name}”?`}
        description="Its boards are kept, but they move out of the workspace."
        confirmLabel="Delete workspace"
        onConfirm={() => {
          if (!removingWorkspace) return;
          void deleteWorkspace(removingWorkspace.id!);
          setRemovingWorkspace(null);
        }}
      />
    </SidebarGroup>
  );
}
