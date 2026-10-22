import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";
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
import "@xyflow/react/dist/style.css";
import { archivedCardIds, db, type Card, type Tag } from "@/lib/db";
import { TaskSelector } from "@/components/task-selector";
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
  onMeasure: (id: number, height: number) => void;
};
type TaskFlowNode = Node<TaskNodeData, "task">;

function TaskNode({ id, data }: NodeProps<TaskFlowNode>) {
  const ref = useRef<HTMLDivElement>(null);
  const { onMeasure } = data;

  // Cards vary in height (title wraps, tag chips, progress row) — report the real
  // box so the layout can stack layers without overlaps.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => onMeasure(Number(id), el.offsetHeight);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [id, onMeasure]);

  return (
    <div ref={ref} className="relative w-56">
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

const NODE_WIDTH = 224;
const COLUMN_GAP = 96;
const ROW_GAP = 20;
const ESTIMATED_HEIGHT = 120;

/**
 * Layered DAG layout: depth = longest upstream chain, so upstream cards sit left of
 * the cards that depend on them. Within a layer, nodes are ordered by their parents'
 * vertical center (barycenter sweeps), which keeps siblings of the same downstream
 * card adjacent instead of scattering them. Heights come from the rendered cards, so
 * tall cards (long titles, many tags) never overlap.
 * Relaxation is bounded by node count, so an accidental cycle (impossible via the
 * upstream picker) cannot hang.
 */
function layoutGraph(
  cards: Card[],
  selected: Set<number>,
  cardById: Map<number, Card>,
  tagById: Map<number, Tag>,
  finishedColumnId: string,
  statusOf: (column: string) => { label: string; className: string },
  heights: Map<number, number>,
  onMeasure: (id: number, height: number) => void,
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
  for (const layer of layers.values()) layer.sort((a, b) => a.createdAt - b.createdAt);

  const heightOf = (id: number) => heights.get(id) ?? ESTIMATED_HEIGHT;

  // Order each layer by neighbour position; alternating direction reduces crossings.
  const index = new Map<number, number>();
  const reindex = () => layers.forEach((layer) => layer.forEach((card, i) => index.set(card.id, i)));
  reindex();
  const depths = [...layers.keys()].sort((a, b) => a - b);
  for (let pass = 0; pass < 4; pass++) {
    const downward = pass % 2 === 0;
    for (const d of downward ? depths : [...depths].reverse()) {
      const layer = layers.get(d) ?? [];
      const barycenter = (card: Card) => {
        const neighbours = downward ? (parents.get(card.id) ?? []) : (children.get(card.id) ?? []);
        if (neighbours.length === 0) return index.get(card.id) ?? 0;
        return neighbours.reduce((sum, id) => sum + (index.get(id) ?? 0), 0) / neighbours.length;
      };
      const before = new Map(layer.map((card) => [card.id, index.get(card.id) ?? 0]));
      layer.sort((a, b) => barycenter(a) - barycenter(b) || (before.get(a.id) ?? 0) - (before.get(b.id) ?? 0));
      layer.forEach((card, i) => index.set(card.id, i));
    }
  }

  // Top coordinate per card: pull each card toward its parents' center, then push
  // down to clear the previous card in the layer.
  const top = new Map<number, number>();
  let cursor = 0;
  for (const card of layers.get(depths[0]) ?? []) {
    top.set(card.id, cursor);
    cursor += heightOf(card.id) + ROW_GAP;
  }
  for (const d of depths.slice(1)) {
    const layer = layers.get(d) ?? [];
    const desired = new Map<number, number>();
    cursor = Number.NEGATIVE_INFINITY;
    for (const card of layer) {
      const placedParents = (parents.get(card.id) ?? []).filter((id) => top.has(id));
      const want = placedParents.length
        ? placedParents.reduce((sum, id) => sum + top.get(id)! + heightOf(id) / 2, 0) / placedParents.length -
          heightOf(card.id) / 2
        : cursor;
      const y = Math.max(want, cursor);
      desired.set(card.id, want);
      top.set(card.id, y);
      cursor = y + heightOf(card.id) + ROW_GAP;
    }
    // Greedy stacking drifts downward when the first card sits high; nudge the whole
    // layer by the median offset so its cards straddle their parents instead.
    if (layer.length > 1) {
      const offsets = layer.map((card) => desired.get(card.id)! - top.get(card.id)!).sort((a, b) => a - b);
      const shift = offsets[Math.floor(offsets.length / 2)];
      for (const card of layer) top.set(card.id, top.get(card.id)! + shift);
    }
  }

  // Upward pass: parents drift toward their children's center so edges stay short
  // and don't cross their neighbours. Deepest layer keeps the anchor.
  for (const d of [...depths].reverse().slice(1)) {
    const layer = layers.get(d) ?? [];
    if (layer.length === 0) continue;
    cursor = Number.NEGATIVE_INFINITY;
    for (const card of layer) {
      const placedChildren = (children.get(card.id) ?? []).filter((id) => top.has(id));
      const want = placedChildren.length
        ? placedChildren.reduce((sum, id) => sum + top.get(id)! + heightOf(id) / 2, 0) / placedChildren.length -
          heightOf(card.id) / 2
        : top.get(card.id)!;
      const y = Math.max(want, cursor);
      top.set(card.id, y);
      cursor = y + heightOf(card.id) + ROW_GAP;
    }
  }

  // Leaf layers were positioned from stale parent anchors; re-center the leaves
  // that have no children of their own on their (now aligned) parents.
  for (const d of depths.slice(1)) {
    const layer = layers.get(d) ?? [];
    cursor = Number.NEGATIVE_INFINITY;
    for (const card of layer) {
      const placedChildren = (children.get(card.id) ?? []).filter((id) => top.has(id));
      const placedParents = (parents.get(card.id) ?? []).filter((id) => top.has(id));
      const want =
        placedChildren.length === 0 && placedParents.length > 0
          ? placedParents.reduce((sum, id) => sum + top.get(id)! + heightOf(id) / 2, 0) / placedParents.length -
            heightOf(card.id) / 2
          : top.get(card.id)!;
      const y = Math.max(want, cursor);
      top.set(card.id, y);
      cursor = y + heightOf(card.id) + ROW_GAP;
    }
  }

  const minTop = Math.min(...top.values(), 0);

  const nodes: TaskFlowNode[] = [];
  for (const [d, layer] of layers) {
    for (const card of layer) {
      nodes.push({
        id: String(card.id),
        type: "task",
        position: {
          x: d * (NODE_WIDTH + COLUMN_GAP),
          y: (top.get(card.id) ?? 0) - minTop,
        },
        data: {
          card,
          cardById,
          tagById,
          finishedColumnId,
          status: statusOf(card.column),
          hasUpstream: (parents.get(card.id) ?? []).length > 0,
          hasDownstream: (children.get(card.id) ?? []).length > 0,
          onMeasure,
        },
      });
    }
  }
  return nodes;
}

/** Keep the graph in view after heights land and node positions shift. */
function FitViewOnLayout({ version }: { version: number }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    // React Flow measures nodes after commit; fit once that frame has settled.
    const timer = setTimeout(() => fitView({ padding: 0.15 }), 60);
    return () => clearTimeout(timer);
  }, [version, fitView]);
  return null;
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
  // Measured card heights; layout reads them so tall cards never overlap.
  const heights = useRef(new Map<number, number>());
  const [heightVersion, setHeightVersion] = useState(0);
  const onMeasure = useCallback((id: number, height: number) => {
    if (heights.current.get(id) === height) return;
    heights.current.set(id, height);
    setHeightVersion((v) => v + 1);
  }, []);

  const nodes = useMemo(
    () => layoutGraph(allCards, selected, cardById, tagById, finishedColumnId, statusOf, heights.current, onMeasure),
    // heightVersion invalidates the memo when a card reports a new size
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allCards, selected, cardById, tagById, finishedColumnId, board, heightVersion, onMeasure],
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
          triggerLabel={`${selected.size} of ${allCards.length} tasks`}
          onToggle={toggle}
          onClear={() => setPicked(new Set())}
          onSelectAll={() => setPicked(new Set(allCards.map((c) => c.id)))}
          onReset={() => setPicked(null)}
          columnTitle={columnTitle}
        />
      </BoardHeaderSlot>
      <div className="size-full rounded border">
        <ReactFlowProvider>
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} nodesConnectable={false} fitView>
            <Background />
            <FitViewOnLayout version={heightVersion} />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    </div>
  );
}
