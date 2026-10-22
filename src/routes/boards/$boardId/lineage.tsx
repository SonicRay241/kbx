import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";
import {
  Background,
  BaseEdge,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import type { ELK, ElkExtendedEdge, ElkNode, ElkPoint } from "elkjs/lib/elk-api";
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

function TaskNode({ data }: NodeProps<TaskFlowNode>) {
  const ref = useRef<HTMLDivElement>(null);
  const { onMeasure } = data;

  // Cards vary in height (title wraps, tag chips, progress row) — report the real
  // box so the layout can stack layers without overlaps.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => onMeasure(data.card.id, el.offsetHeight);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [data.card.id, onMeasure]);

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
        <Handle type="target" position={Position.Left} className="size-1! border-0! opacity-0!" />
      )}
      {data.hasDownstream && (
        <Handle type="source" position={Position.Right} className="size-1! border-0! opacity-0!" />
      )}
    </div>
  );
}

const nodeTypes = { task: TaskNode };

const NODE_WIDTH = 224;
const COLUMN_GAP = 96;
const ROW_GAP = 20;
const ESTIMATED_HEIGHT = 120;

/** elkjs is ~1.5MB of layout engine; keep it out of the main chunk. */
let elkPromise: Promise<ELK> | null = null;
const getElk = () => (elkPromise ??= import("elkjs/lib/elk.bundled.js").then((mod) => new mod.default()));

/**
 * ELK's layered algorithm replaces the hand-rolled layout: longest-path layering,
 * crossing minimisation, dummy nodes for edges that skip layers and orthogonal
 * routing all come from the engine. `considerModelOrder` keeps the createdAt order
 * whenever several orders are equally good, so the graph stays stable between
 * renders.
 */
const LAYOUT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  "elk.layered.crossingMinimization.greedySwitch.type": "TWO_SIDED",
  "elk.layered.thoroughness": "12",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.layered.nodePlacement.favorStraightEdges": "true",
  "elk.layered.spacing.nodeNodeBetweenLayers": String(COLUMN_GAP),
  "elk.spacing.nodeNode": String(ROW_GAP),
  "elk.spacing.edgeNode": "12",
  "elk.spacing.edgeEdge": "8",
  "elk.layered.spacing.edgeNodeBetweenLayers": "12",
};

function buildElkGraph(cards: Card[], selected: Set<number>, heights: Map<number, number>): ElkNode {
  const included = cards.filter((card) => selected.has(card.id));
  const shown = new Set(included.map((card) => card.id));
  return {
    id: "root",
    layoutOptions: LAYOUT_OPTIONS,
    children: included.map((card) => ({
      id: String(card.id),
      width: NODE_WIDTH,
      height: heights.get(card.id) ?? ESTIMATED_HEIGHT,
    })),
    edges: included.flatMap((card) =>
      card.upstreamIds
        .filter((id) => shown.has(id))
        .map((id) => ({ id: `${id}>${card.id}`, sources: [String(id)], targets: [String(card.id)] })),
    ),
  };
}

function edgePoints(edge: ElkExtendedEdge): ElkPoint[] {
  const points: ElkPoint[] = [];
  for (const section of edge.sections ?? []) {
    if (points.length === 0) points.push(section.startPoint);
    points.push(...(section.bendPoints ?? []), section.endPoint);
  }
  return points;
}

type TrunkEdgeData = { points?: ElkPoint[] };

/** Rounds ELK's right-angle bends, the way React Flow's smoothstep edges do. */
function roundedPath(points: ElkPoint[], radius = 8): string {
  const at = (point: ElkPoint) => `${point.x} ${point.y}`;
  if (points.length < 3) return `M ${at(points[0])} L ${at(points[points.length - 1])}`;
  let path = `M ${at(points[0])}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [previous, corner, next] = [points[i - 1], points[i], points[i + 1]];
    const inLength = Math.hypot(corner.x - previous.x, corner.y - previous.y);
    const outLength = Math.hypot(next.x - corner.x, next.y - corner.y);
    const turn = Math.min(radius, inLength / 2, outLength / 2);
    if (turn < 0.5) {
      path += ` L ${at(corner)}`;
      continue;
    }
    const start = {
      x: corner.x - ((corner.x - previous.x) / inLength) * turn,
      y: corner.y - ((corner.y - previous.y) / inLength) * turn,
    };
    const end = {
      x: corner.x + ((next.x - corner.x) / outLength) * turn,
      y: corner.y + ((next.y - corner.y) / outLength) * turn,
    };
    path += ` L ${at(start)} Q ${at(corner)} ${at(end)}`;
  }
  return `${path} L ${at(points[points.length - 1])}`;
}

/** Draws ELK's routed polyline instead of letting React Flow guess a path. */
function TrunkEdge({ data, markerEnd, style, sourceX, sourceY, targetX, targetY }: EdgeProps<Edge<TrunkEdgeData>>) {
  const points = data?.points;
  const path = points?.length
    ? roundedPath(points)
    : `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`;
  return <BaseEdge path={path} markerEnd={markerEnd} style={{ strokeLinejoin: "round", ...style }} />;
}

const edgeTypes = { trunk: TrunkEdge };

/** Keep the graph in view after heights land, the selection changes, or node
 * positions shift. */
function FitViewOnLayout({ nodes }: { nodes: TaskFlowNode[] }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (nodes.length === 0) return;
    // React Flow measures nodes after commit; fit once that frame has settled.
    const timer = setTimeout(() => fitView({ padding: 0.15 }), 60);
    return () => clearTimeout(timer);
  }, [nodes, fitView]);
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
  // Measured card heights; layout reads them so tall cards never overlap.
  const heights = useRef(new Map<number, number>());
  const [heightVersion, setHeightVersion] = useState(0);
  const onMeasure = useCallback((id: number, height: number) => {
    if (heights.current.get(id) === height) return;
    heights.current.set(id, height);
    setHeightVersion((v) => v + 1);
  }, []);

  const [layout, setLayout] = useState<{ nodes: TaskFlowNode[]; edges: Edge[] }>({ nodes: [], edges: [] });

  const graph = useMemo(
    () => buildElkGraph(allCards, selected, heights.current),
    // heightVersion invalidates the memo when a card reports a new size
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allCards, selected, heightVersion],
  );

  useEffect(() => {
    let cancelled = false;
    const columns = board?.columns ?? [];
    getElk()
      .then((elk) => elk.layout(graph))
      .then((result) => {
        if (cancelled) return;
        const sources = new Set((graph.edges ?? []).map((edge) => edge.sources[0]));
        const targets = new Set((graph.edges ?? []).map((edge) => edge.targets[0]));
        const nodes: TaskFlowNode[] = [];
        for (const node of result.children ?? []) {
          const card = cardById.get(Number(node.id));
          if (!card) continue;
          const index = Math.max(
            columns.findIndex((column) => column.id === card.column),
            0,
          );
          nodes.push({
            id: node.id,
            type: "task",
            position: { x: node.x ?? 0, y: node.y ?? 0 },
            data: {
              card,
              cardById,
              tagById,
              finishedColumnId,
              status: { label: columns[index]?.title ?? card.column, className: softAccentBadge(index) },
              hasUpstream: targets.has(node.id),
              hasDownstream: sources.has(node.id),
              onMeasure,
            },
          });
        }
        const edges: Edge[] = (result.edges ?? []).map((edge) => ({
          id: edge.id ?? `${edge.sources[0]}>${edge.targets[0]}`,
          source: edge.sources[0],
          target: edge.targets[0],
          type: "trunk",
          data: { points: edgePoints(edge) },
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
          style: { strokeWidth: 1.25 },
        }));
        setLayout({ nodes, edges });
      })
      .catch(() => {
        if (!cancelled) setLayout({ nodes: [], edges: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [graph, cardById, tagById, finishedColumnId, board, onMeasure]);

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
          <ReactFlow
            nodes={layout.nodes}
            edges={layout.edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            nodesConnectable={false}
            minZoom={0.02}
          >
            <Background />
            <FitViewOnLayout nodes={layout.nodes} />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    </div>
  );
}
