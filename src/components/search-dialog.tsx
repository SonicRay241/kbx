import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useNavigate } from "@tanstack/react-router";
import {
  Background,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { SearchIcon, SquareKanbanIcon } from "lucide-react";

import { archivedCardIds, db, type BoardRow, type Card, type Tag } from "@/lib/db";
import { requestCardHighlight } from "@/lib/card-highlight";
import { useLocalShortcut } from "@/lib/shortcuts";
import { SyncArchivesButton } from "@/components/sync/sync-archives-button";
import { TaskCard } from "@/components/board-card";
import { softAccentBadge } from "@/components/constants/colors";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import "@xyflow/react/dist/style.css";

const NODE_WIDTH = 224;
const COLUMN_GAP = 64;
const ROW_GAP = 24;
/** Rough card height for pre-measure placement; fit-view absorbs the slack. */
const ROW = 150;

type PreviewData = {
  card: Card;
  cardById: Map<number, Card>;
  tagById: Map<number, Tag>;
  status: { label: string; className: string };
  root: boolean;
};
type PreviewNode = Node<PreviewData, "preview">;

type SearchRow =
  | { kind: "board"; key: string; board: BoardRow }
  | {
      kind: "card";
      key: string;
      card: Card;
      board: BoardRow;
      status: { label: string; className: string };
      archived: boolean;
    };

function PreviewCard({ data }: NodeProps<PreviewNode>) {
  return (
    <div className={`w-56 rounded-lg ${data.root ? "ring-primary/40 ring-2" : ""}`}>
      <TaskCard
        card={data.card}
        cardById={data.cardById}
        tagById={data.tagById}
        finishedColumnId=""
        status={data.status}
      />
      <Handle type="target" position={Position.Left} className="opacity-0!" />
      <Handle type="source" position={Position.Right} className="opacity-0!" />
    </div>
  );
}

const nodeTypes = { preview: PreviewCard };

/** Wraps every case-insensitive occurrence of the query. */
function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  if (!needle) return <>{text}</>;
  const pattern = new RegExp(`(${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  return (
    <>
      {text.split(pattern).map((part, index) =>
        part.toLowerCase() === needle.toLowerCase() ? (
          <mark key={index} className="bg-primary/25 text-foreground">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** The dialog animates in; fit once its pane has its final size. */
function FitPreview() {
  const { fitView } = useReactFlow();
  useEffect(() => {
    const timer = setTimeout(() => void fitView({ padding: 0.2, duration: 120 }), 80);
    return () => clearTimeout(timer);
  }, [fitView]);
  return null;
}

/**
 * Search modal: results on the left (title *and* description, archived cards
 * excluded), lineage preview on the right. Hovering a row renders the card with
 * its direct upstreams and downstreams — archived neighbours included, since the
 * graph is context, not a result list. Clicking jumps to the card's board.
 */
export function SearchDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const boards = useLiveQuery(() => db.boards.toArray(), [], []);
  const cards = useLiveQuery(() => db.cards.toArray(), [], []);
  const tags = useLiveQuery(() => db.tags.toArray(), [], []);

  const boardById = useMemo(() => new Map(boards.map((board) => [board.id!, board])), [boards]);
  const cardById = useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards]);
  const tagById = useMemo(() => new Map(tags.map((tag) => [tag.id!, tag])), [tags]);

  const columnIndex = (board: BoardRow, column: string) =>
    Math.max(board.columns.findIndex((c) => c.id === column), 0);
  const statusOf = (board: BoardRow, column: string) => {
    const index = columnIndex(board, column);
    return { label: board.columns[index]?.title ?? column, className: softAccentBadge(index) };
  };

  // Boards are matched by name and listed above tasks; the group disappears
  // entirely when nothing matches, so tasks keep the whole panel.
  const boardMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return boards
      .filter((board) => board.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [boards, query]);

  const cardRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = cards.flatMap((card) => {
      const board = boardById.get(card.boardId);
      if (!board) return [];
      if (q && !card.title.toLowerCase().includes(q) && !(card.description ?? "").toLowerCase().includes(q)) {
        return [];
      }
      return [{ card, board, archived: archivedCardIds(board, cards).has(card.id) }];
    });
    // Archive is a fallback bucket, not a filter: archived cards only surface
    // when nothing active matches.
    const active = matched.filter((row) => !row.archived);
    const pool = active.length ? active : matched;
    const finished = (row: (typeof pool)[number]) =>
      row.card.column === row.board.columns[row.board.columns.length - 1]?.id;
    return pool
      .map((row) => ({
        kind: "card" as const,
        key: `card:${row.card.id}`,
        ...row,
        status: statusOf(row.board, row.card.column),
      }))
      .sort(
        (a, b) =>
          // Completed work is rarely what you are looking for — sink it.
          Number(finished(a)) - Number(finished(b)) ||
          // Otherwise closest to the finished column first, mirroring the dashboard.
          columnIndex(b.board, b.card.column) - columnIndex(a.board, a.card.column) ||
          (b.card.updatedAt ?? b.card.createdAt) - (a.card.updatedAt ?? a.card.createdAt),
      );
    // statusOf/columnIndex are pure helpers over `boards`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, query, boardById]);

  const rows = useMemo<SearchRow[]>(
    () => [
      ...boardMatches.map((board) => ({ kind: "board" as const, key: `board:${board.id}`, board })),
      ...cardRows,
    ],
    [boardMatches, cardRows],
  );

  // Search-bar state change → select the first result. Hovering moves the
  // selection; leaving the row keeps it, so the preview stays put.
  useEffect(() => {
    setSelectedKey(rows[0]?.key ?? null);
  }, [query, rows]);

  const selected = rows.find((row) => row.key === selectedKey) ?? null;
  const selectedCard = selected?.kind === "card" ? selected.card : null;
  const selectedBoard = selected?.kind === "board" ? selected.board : null;

  // Every match came from the archive bucket — local history may be behind.
  const archiveFallback =
    cardRows.length > 0 && cardRows.every((row) => row.archived) && boardMatches.length === 0;

  const graph = useMemo(() => {
    const card = selectedCard;
    if (!card) return null;
    const board = boardById.get(card.boardId);
    if (!board) return null;
    const statuses = new Map<number, { label: string; className: string }>();
    for (const other of cards) {
      const otherBoard = boardById.get(other.boardId);
      if (otherBoard) statuses.set(other.id, statusOf(otherBoard, other.column));
    }
    const parents = card.upstreamIds.map((id) => cardById.get(id)).filter((c): c is Card => !!c);
    const children = cards.filter((c) => c.upstreamIds.includes(card.id));

    const nodes: PreviewNode[] = [];
    const place = (list: Card[], x: number, root = false) =>
      list.forEach((item, index) => {
        nodes.push({
          id: String(item.id),
          type: "preview",
          position: { x, y: (index - (list.length - 1) / 2) * (ROW + ROW_GAP) },
          data: {
            card: item,
            cardById,
            tagById,
            status: statuses.get(item.id) ?? { label: item.column, className: "" },
            root,
          },
        });
      });
    place(parents, 0);
    place([card], NODE_WIDTH + COLUMN_GAP, true);
    place(children, (NODE_WIDTH + COLUMN_GAP) * 2);

    const edges: Edge[] = [
      ...parents.map((parent) => ({ source: String(parent.id), target: String(card.id) })),
      ...children.map((child) => ({ source: String(card.id), target: String(child.id) })),
    ].map(({ source, target }) => ({
      id: `${source}>${target}`,
      source,
      target,
      type: "smoothstep",
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      style: { strokeWidth: 1.25 },
    }));

    return { nodes, edges };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCard, cardById, boardById, tagById, cards]);

  const openBoard = (boardId: number) => {
    onOpenChange(false);
    setQuery("");
    setSelectedKey(null);
    void navigate({ to: "/boards/$boardId", params: { boardId: String(boardId) } });
  };

  const jump = (card: Card) => {
    // The board flashes this card once it renders (or right away if already open).
    requestCardHighlight(card.boardId, card.id);
    openBoard(card.boardId);
  };

  // Keyboard preview: arrows walk boards then tasks (wrapping), Enter opens the
  // selection. Registered locally so these keys never reach the global registry.
  const step = (delta: number) => {
    if (!rows.length) return;
    const index = rows.findIndex((row) => row.key === selectedKey);
    const next =
      index === -1
        ? delta > 0
          ? 0
          : rows.length - 1
        : (index + delta + rows.length) % rows.length;
    setSelectedKey(rows[next].key);
    // Keyboard navigation may move the selection out of view; hover never does.
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>('[role="dialog"] li button[aria-current="true"]')
        ?.scrollIntoView({ block: "nearest" });
    });
  };

  useLocalShortcut(
    {
      arrowdown: () => step(1),
      arrowup: () => step(-1),
      enter: () => {
        if (!selected) return;
        if (selected.kind === "board") openBoard(selected.board.id!);
        else jump(selected.card);
      },
    },
    open,
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setQuery("");
          setSelectedKey(null);
        }
      }}
    >
      <DialogContent className="grid h-[min(44rem,calc(100vh-4rem))] min-h-[24rem] max-w-5xl grid-cols-[minmax(0,26rem)_1fr] gap-0 overflow-hidden p-0 sm:max-w-5xl">
        <DialogTitle className="sr-only">Search boards and tasks</DialogTitle>
        <div className="flex min-h-0 flex-col border-r">
          <div className="relative border-b p-3">
            <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-5 size-4 -translate-y-1/2" />
            <Input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search boards and tasks…"
              aria-label="Search boards and tasks"
              className="h-9 border-0 bg-transparent pl-8 shadow-none focus-visible:ring-0"
            />
          </div>
          {archiveFallback && (
            <div className="text-muted-foreground flex items-center justify-between gap-2 border-b px-3 py-1.5 text-xs">
              <span className="min-w-0 truncate">Archived matches — history may not be synced.</span>
              <SyncArchivesButton />
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {rows.length === 0 ? (
              <p className="text-muted-foreground p-3 text-sm">No matches.</p>
            ) : (
              <div className="flex flex-col gap-0.5">
                {boardMatches.length > 0 && (
                  <section>
                    <h3 className="text-muted-foreground px-2.5 pt-1 pb-1 text-[11px] tracking-widest uppercase">
                      Boards
                    </h3>
                    <ul className="flex flex-col gap-0.5">
                      {boardMatches.map((board) => {
                        const key = `board:${board.id}`;
                        const active = selectedKey === key;
                        return (
                          <li key={key}>
                            <button
                              type="button"
                              onMouseEnter={() => setSelectedKey(key)}
                              onFocus={() => setSelectedKey(key)}
                              onClick={() => openBoard(board.id!)}
                              aria-current={active}
                              className={`hover:bg-accent focus-visible:bg-accent flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left outline-hidden ${
                                active ? "bg-accent" : ""
                              }`}
                            >
                              <SquareKanbanIcon className="text-muted-foreground size-4 shrink-0" />
                              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                                <Highlight text={board.name} query={query} />
                              </span>
                              <span className="text-muted-foreground shrink-0 text-xs">
                                {cards.filter((card) => card.boardId === board.id).length} tasks
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                )}
                {cardRows.length > 0 && (
                  <section className={boardMatches.length > 0 ? "mt-1" : undefined}>
                    {boardMatches.length > 0 && (
                      <h3 className="text-muted-foreground px-2.5 pt-1 pb-1 text-[11px] tracking-widest uppercase">
                        Tasks
                      </h3>
                    )}
                    <ul className="flex flex-col gap-0.5">
                      {cardRows.map(({ key, card, board, status }) => {
                        const active = selectedKey === key;
                        return (
                          <li key={key}>
                            <button
                              type="button"
                              onMouseEnter={() => setSelectedKey(key)}
                              onFocus={() => setSelectedKey(key)}
                              onClick={() => jump(card)}
                              aria-current={active}
                              className={`hover:bg-accent focus-visible:bg-accent flex w-full items-start gap-3 rounded-md px-2.5 py-2 text-left outline-hidden ${
                                active ? "bg-accent" : ""
                              }`}
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium">
                                  <Highlight text={card.title} query={query} />
                                </span>
                                {card.description && (
                                  <span className="text-muted-foreground line-clamp-2 text-xs">
                                    <Highlight text={card.description} query={query} />
                                  </span>
                                )}
                                <span className="text-muted-foreground mt-1 block truncate text-xs">
                                  {board.name}
                                </span>
                              </span>
                              <Badge variant="outline" className={`shrink-0 rounded ${status.className}`}>
                                {status.label}
                              </Badge>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="relative min-h-0">
          {graph ? (
            <ReactFlowProvider>
              <ReactFlow
                key={selectedCard?.id}
                nodes={graph.nodes}
                edges={graph.edges}
                nodeTypes={nodeTypes}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
                fitView
                fitViewOptions={{ padding: 0.2 }}
                minZoom={0.2}
                maxZoom={1}
              >
                <Background />
                <FitPreview />
              </ReactFlow>
            </ReactFlowProvider>
          ) : selectedBoard ? (
            <div className="flex h-full flex-col items-center justify-center gap-1.5 p-6 text-center">
              <p className="text-sm font-medium">{selectedBoard.name}</p>
              <p className="text-muted-foreground text-xs">
                {cards.filter((card) => card.boardId === selectedBoard.id).length} tasks ·{" "}
                {selectedBoard.columns.length} columns
              </p>
              <p className="text-muted-foreground mt-1 text-xs">Press Enter to open this board.</p>
            </div>
          ) : (
            <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
              Hover to view lineage
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
