import type { ComponentProps } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { KanbanItem, KanbanItemHandle } from "@/components/ui/kanban";
import { cn } from "@/lib/utils";
import type { Card as CardData, Tag } from "@/lib/db";

interface BoardCardProps extends Omit<
  ComponentProps<typeof KanbanItem>,
  "value" | "children"
> {
  card: CardData;
  cardById: Map<number, CardData>;
  tagById: Map<number, Tag>;
  finishedColumnId: string;
  isOverlay?: boolean;
  onEdit?: (id: number) => void;
}

type TaskCardProps = {
  card: CardData;
  cardById: Map<number, CardData>;
  tagById: Map<number, Tag>;
  finishedColumnId: string;
  /** Column state badge; only rendered where the column is not implied by layout (lineage view). */
  status?: { label: string; className?: string };
  isOverlay?: boolean;
  onEdit?: (id: number) => void;
};

export function TaskCard({
  card,
  cardById,
  tagById,
  finishedColumnId,
  status,
  isOverlay,
  onEdit,
}: TaskCardProps) {
  const upstreams = card.upstreamIds
    .map((id) => cardById.get(id))
    .filter((c) => c) as CardData[];
  const doneCount = upstreams.filter(
    (c) => c.column === finishedColumnId,
  ).length;
  const pct = upstreams.length
    ? Math.round((doneCount / upstreams.length) * 100)
    : null;
  const blocked = upstreams.length > 0 && doneCount < upstreams.length;

  return (
    <Card
      size="sm"
      onClick={onEdit ? () => onEdit(card.id!) : undefined}
      className={cn(
        "overflow-hidden shadow-none transition-all rotate-0",
        onEdit && "hover:-translate-y-0.5 cursor-pointer",
        isOverlay && "ring-primary/20 rotate-1 ring-2",
      )}
    >
      <CardContent className="space-y-2">
        <div className="flex flex-wrap gap-2 justify-between">
          <h3 className="line-clamp-2 text-sm leading-snug font-semibold">
            {card.title}
          </h3>
          <div className="flex flex-wrap items-center justify-between gap-1">
            {status && (
              <Badge variant="outline" className={cn("rounded", status.className)}>
                {status.label}
              </Badge>
            )}
            {blocked ? (
              <Badge variant="destructive" className="rounded">
                Blocked
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="rounded border-green-600/50 font-normal text-green-600 dark:border-green-400/50 dark:text-green-400"
              >
                Ready
              </Badge>
            )}
          </div>
        </div>

        {card.tagIds.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {card.tagIds.map((id) => {
              const tag = tagById.get(id);
              if (!tag) return null;
              return (
                <span
                  key={id}
                  className="text-muted-foreground flex h-5 items-center gap-1 rounded-sm bg-muted px-1.5 text-xs font-medium whitespace-nowrap"
                  aria-label={`Tag ${tag.name}`}
                >
                  <span className={`size-1.5 rounded-full ${tag.color}`} />
                  {tag.name}
                </span>
              );
            })}
          </div>
        )}

        {pct === null ? (
          <p className="text-muted-foreground text-[11px]">No upstream tasks</p>
        ) : (
          <div className="space-y-1.5">
            <div className="text-muted-foreground flex items-center justify-between text-[11px]">
              <span>Upstream</span>
              <span className="font-medium tabular-nums">
                {pct}% · {doneCount}/{upstreams.length}
              </span>
            </div>
            <Progress value={pct} className="h-1.5" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function BoardCard({
  card,
  cardById,
  tagById,
  finishedColumnId,
  isOverlay,
  onEdit,
  ...props
}: BoardCardProps) {
  const upstreams = card.upstreamIds
    .map((id) => cardById.get(id))
    .filter((c) => c) as CardData[];
  const doneCount = upstreams.filter(
    (c) => c.column === finishedColumnId,
  ).length;
  const blocked = upstreams.length > 0 && doneCount < upstreams.length;

  const inner = (
    <TaskCard
      card={card}
      cardById={cardById}
      tagById={tagById}
      finishedColumnId={finishedColumnId}
      isOverlay={isOverlay}
      onEdit={onEdit}
    />
  );

  return (
    <KanbanItem
      value={String(card.id)}
      disabled={blocked && !isOverlay ? { draggable: true } : undefined}
      {...props}
    >
      {isOverlay ? (
        inner
      ) : (
        <KanbanItemHandle className={cn(blocked && "cursor-not-allowed!")}>
          <span className={cn("block", blocked && "opacity-60")}>{inner}</span>
        </KanbanItemHandle>
      )}
    </KanbanItem>
  );
}
