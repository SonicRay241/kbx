import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";
import {
  Background,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ChevronsUpDownIcon, ListChecksIcon, ListXIcon, RotateCcwIcon, SearchIcon } from "lucide-react";
import { archivedCardIds, db, type Card, type Tag } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { BoardHeaderSlot } from "@/routes/boards/$boardId";
import { TaskCard } from "@/components/board-card";
import { softAccentBadge } from "@/components/constants/colors";

export const Route = createFileRoute("/boards/$boardId/lineage")({
  component: RouteComponent,
});

type TaskNodeData = {
  card: Card;
  cardById: Map<number, Card>;
  tagById: Map<number, Tag>;
  finishedColumnId: string;
  status: { label: string; className: string };
  hasUpstream: boolean;
  hasDownstream: boolean;
};
type TaskFlowNode = Node<TaskNodeData, "task">;

function TaskNode({ data }: NodeProps<TaskFlowNode>) {
  return (
    <div className="relative w-56">
      <TaskCard
        card={data.card}
        cardById={data.cardById}
        tagById={data.tagById}
        finishedColumnId={data.finishedColumnId}
        status={data.status}
        />
      {data.hasUpstream && (
        <Handle type="target" position={Position.Left} className="size-1.5! border-0! bg-muted-foreground!" />
      )}
      {data.hasDownstream && (
        <Handle type="source" position={Position.Right} className="size-1.5! border-0! bg-muted-foreground!" />
      )}
    </div>
  );
}

const nodeTypes = { task: TaskNode };

const NODE_GAP_Y = 150;
const LAYER_GAP_X = 300;

/**
 * Layered DAG layout: depth = longest upstream chain, so upstream cards sit left of
 * the cards that depend on them. Relaxation is bounded by node count, so an
 * accidental cycle (should be impossible via the upstream picker) cannot hang.
 */
function layoutGraph(
  cards: Card[],
  selected: Set<number>,
  cardById: Map<number, Card>,
  tagById: Map<number, Tag>,
  finishedColumnId: string,
  statusOf: (column: string) => { label: string; className: string },
): TaskFlowNode[] {
  const included = cards.filter((c) => selected.has(c.id));
  const byId = new Map(included.map((c) => [c.id, c]));
  const parents = new Map<number, number[]>();
  const children = new Map<number, number[]>();
  for (const card of included) {
    const upstreams = card.upstreamIds.filter((id) => byId.has(id));
    parents.set(card.id, upstreams);
    for (const id of upstreams) children.set(id, [...(children.get(id) ?? []), card.id]);
  }

  const depth = new Map<number, number>(included.map((c) => [c.id, 0]));
  for (let pass = 0; pass < included.length; pass++) {
    let changed = false;
    for (const card of included) {
      for (const parent of parents.get(card.id) ?? []) {
        const next = (depth.get(parent) ?? 0) + 1;
        if (next > (depth.get(card.id) ?? 0)) {
          depth.set(card.id, next);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  const layers = new Map<number, Card[]>();
  for (const card of included) {
    const d = depth.get(card.id) ?? 0;
    const layer = layers.get(d) ?? [];
    layer.push(card);
    layers.set(d, layer);
  }

  const nodes: TaskFlowNode[] = [];
  for (const [d, layer] of layers) {
    layer.sort((a, b) => a.createdAt - b.createdAt);
    layer.forEach((card, i) => {
      nodes.push({
        id: String(card.id),
        type: "task",
        position: {
          x: d * LAYER_GAP_X,
          y: (i - (layer.length - 1) / 2) * NODE_GAP_Y,
        },
        data: {
          card,
          cardById,
          tagById,
          finishedColumnId,
          status: statusOf(card.column),
          hasUpstream: (parents.get(card.id) ?? []).length > 0,
          hasDownstream: (children.get(card.id) ?? []).length > 0,
        },
      });
    });
  }
  return nodes;
}

function RouteComponent() {
  const { boardId } = Route.useParams();
  return <Lineage boardId={Number(boardId)} />;
}

function Lineage({ boardId }: { boardId: number }) {
  const board = useLiveQuery(() => db.boards.get(boardId));
  const cards = useLiveQuery(() => db.cards.where("boardId").equals(boardId).toArray());
  const tags = useLiveQuery(() => db.tags.where("boardId").equals(boardId).toArray());
  // null = follow the default selection (everything not archived)
  const [picked, setPicked] = useState<Set<number> | null>(null);

  const allCards = useMemo(() => [...(cards ?? [])].sort((a, b) => a.createdAt - b.createdAt), [cards]);

  const defaultSelection = useMemo(() => {
    const archived = archivedCardIds(board, allCards);
    return new Set(allCards.filter((c) => !archived.has(c.id)).map((c) => c.id));
  }, [board, allCards]);

  const explicit = picked ?? defaultSelection;

  const columnTitle = (id: string) => board?.columns.find((c) => c.id === id)?.title ?? id;
  const cardById = useMemo(() => new Map(allCards.map((c) => [c.id, c])), [allCards]);
  const tagById = useMemo(() => new Map((tags ?? []).map((t) => [t.id!, t])), [tags]);
  const finishedColumnId = board?.columns[board.columns.length - 1]?.id ?? "done";

  // Shown = explicit picks + every unfinished upstream they depend on, transitively.
  // Finished upstreams stay hidden unless picked, so past work doesn't creep back in.
  const selected = useMemo(() => {
    const shown = new Set(explicit);
    const queue = [...explicit];
    while (queue.length > 0) {
      const card = cardById.get(queue.pop()!);
      for (const id of card?.upstreamIds ?? []) {
        const upstream = cardById.get(id);
        if (!upstream || shown.has(id) || upstream.column === finishedColumnId) continue;
        shown.add(id);
        queue.push(id);
      }
    }
    return shown;
  }, [explicit, cardById, finishedColumnId]);

  const toggle = (id: number) => {
    const next = new Set(explicit);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };
  const statusOf = (column: string) => {
    const index = board?.columns.findIndex((c) => c.id === column) ?? 0;
    return { label: columnTitle(column), className: softAccentBadge(Math.max(index, 0)) };
  };
  const nodes = useMemo(
    () => layoutGraph(allCards, selected, cardById, tagById, finishedColumnId, statusOf),
    [allCards, selected, cardById, tagById, finishedColumnId, board],
  );
  const edges = useMemo<Edge[]>(() => {
    const byId = new Map(allCards.map((c) => [c.id, c]));
    return allCards
      .filter((c) => selected.has(c.id))
      .flatMap((card) =>
        card.upstreamIds
          .filter((id) => selected.has(id) && byId.has(id))
          .map((id) => ({
            id: `${id}-${card.id}`,
            source: String(id),
            target: String(card.id),
            type: "smoothstep",
            markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
          })),
      );
  }, [allCards, selected]);

  if (!board) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col px-4 pb-4">
      <BoardHeaderSlot>
        <TaskSelector
          cards={allCards}
          selected={explicit}
          shownCount={selected.size}
          onToggle={toggle}
          onClear={() => setPicked(new Set())}
          onSelectAll={() => setPicked(new Set(allCards.map((c) => c.id)))}
          onReset={() => setPicked(null)}
          columnTitle={columnTitle}
        />
      </BoardHeaderSlot>
      <div className="size-full rounded border">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes} 
          nodesConnectable={false}
          fitView
        >
          <Background />
          {/* <Controls /> */}
        </ReactFlow>
      </div>
    </div>
  );
}

function TaskSelector({
  cards,
  selected,
  shownCount,
  onToggle,
  onClear,
  onSelectAll,
  onReset,
  columnTitle,
}: {
  cards: Card[];
  /** Explicit picks — drives the row dots. `shownCount` includes auto-added upstreams. */
  selected: Set<number>;
  shownCount: number;
  onToggle: (id: number) => void;
  onClear: () => void;
  onSelectAll: () => void;
  onReset: () => void;
  columnTitle: (id: string) => string;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const visible = q ? cards.filter((c) => c.title.toLowerCase().includes(q)) : cards;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="w-56 justify-between">
          <span>
            {shownCount} of {cards.length} tasks
          </span>
          <ChevronsUpDownIcon className="text-muted-foreground size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="p-2">
          <div className="relative">
            <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="bg-muted h-8 border-0 pl-8"
              aria-label="Search tasks"
            />
          </div>
        </div>
        <div className="max-h-72 overflow-y-auto border-t p-1">
          {visible.map((card) => (
            <button
              key={card.id}
              type="button"
              onClick={() => onToggle(card.id)}
              aria-pressed={selected.has(card.id)}
              className="hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
            >
              <span className="truncate font-medium">{card.title}</span>
              <span className="text-muted-foreground truncate text-xs">{columnTitle(card.column)}</span>
              <span
                className={`ml-auto size-2 shrink-0 rounded-full ${selected.has(card.id) ? "bg-primary" : "border"}`}
              />
            </button>
          ))}
          {visible.length === 0 && <p className="text-muted-foreground px-2 py-1.5 text-sm">No tasks match.</p>}
        </div>
        <div className="grid grid-cols-2 gap-1 border-t p-2">
          <Button variant="secondary" size="sm" className="justify-between" onClick={onClear}>
            Clear
            <ListXIcon />
          </Button>
          <Button variant="secondary" size="sm" className="justify-between" onClick={onSelectAll}>
            Select all
            <ListChecksIcon />
          </Button>
          <Button variant="secondary" size="sm" className="col-span-2 justify-between" onClick={onReset}>
            Reset (to default)
            <RotateCcwIcon />
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}