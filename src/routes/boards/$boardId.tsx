import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  createFileRoute,
  Link,
  Outlet,
  useLocation,
} from "@tanstack/react-router";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { db, type BoardRow } from "@/lib/db";

export const Route = createFileRoute("/boards/$boardId")({
  component: BoardRoute,
});

const BoardHeaderSlotContext = createContext<HTMLDivElement | null>(null);

/**
 * Portals children into the board layout header, next to the title.
 * Pages render actions here instead of threading props through the layout.
 */
export function BoardHeaderSlot({ children }: { children: ReactNode }) {
  const target = useContext(BoardHeaderSlotContext);
  return target ? createPortal(children, target) : null;
}

function getAnchorPosition(suffix: string | undefined) {
  switch (suffix) {
    case "list":
      return "position-anchor-[--list]";

    case "lineage":
      return "position-anchor-[--lineage]";

    default:
      return "position-anchor-[--board]";
  }
}

function BoardRoute() {
  const { boardId } = Route.useParams();

  const [board, setBoard] = useState<BoardRow | null>(null)
  const suffix = useLocation({ select: (l) => l.pathname.split("/").at(-1) });
  const [headerSlot, setHeaderSlot] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
      void (async () => {
        const [p] = await Promise.all([
          db.boards.get(Number(boardId)),
          db.cards.where('boardId').equals(boardId).toArray(),
          db.tags.where('boardId').equals(boardId).toArray()
        ])
        setBoard(p ?? null)
      })()
    }, [boardId])

  if (!board) return "Loading...";

  return (
    <BoardHeaderSlotContext.Provider value={headerSlot}>
      <div className="h-full w-full pt-4 flex flex-col">
        <div className="px-4 space-y-4 pb-4">
          <h1 className="text-xl font-medium pl-8 md:pl-0">{board.name}</h1>
          <div className="flex justify-between flex-wrap gap-2">
            <div className="bg-muted shadow-inner isolate flex rounded-md border h-7">
              {/* One pill, re-anchored to the active tab. The anchor-name lives on each link. */}
              <span
                aria-hidden
                className={cn(
                  "bg-card border pointer-events-none absolute -z-10 rounded-sm transition-all shadow-xs",
                  "top-[anchor(top)] right-[anchor(right)] bottom-[anchor(bottom)] left-[anchor(left)]",
                  getAnchorPosition(suffix),
                )}
              />
              <Link
                to="/boards/$boardId"
                params={{ boardId: String(boardId) }}
                className={cn(
                  "flex items-center justify-center text-muted-foreground anchor-[--board] rounded-md px-4 h-full text-xs transition-all",
                )}
                activeProps={{ className: "text-card-foreground" }}
                activeOptions={{ exact: true }}
              >
                Board
              </Link>
              <Link
                to="/boards/$boardId/list"
                params={{ boardId: String(boardId) }}
                className={cn(
                  "flex items-center justify-center text-muted-foreground anchor-[--list] rounded-md px-4 h-full text-xs transition-all",
                )}
                activeProps={{ className: "text-card-foreground" }}
              >
                List
              </Link>
              <Link
                to="/boards/$boardId/lineage"
                params={{ boardId: String(boardId) }}
                className={cn(
                  "flex items-center justify-center text-muted-foreground anchor-[--lineage] rounded-md px-4 h-full text-xs transition-all",
                )}
                activeProps={{ className: "text-card-foreground" }}
              >
                Lineage
              </Link>
            </div>
            <div
              ref={setHeaderSlot}
              className="flex items-center gap-2"
            />
          </div>
        </div>
        <Outlet />
      </div>
    </BoardHeaderSlotContext.Provider>
  );
}
