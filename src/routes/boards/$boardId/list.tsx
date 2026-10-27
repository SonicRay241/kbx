import { useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";
import { SearchIcon } from "lucide-react";
import { archivedCardIds, db, type Card } from "@/lib/db";
import { deleteCard, updateCard } from "@/lib/mutations";
import { UpstreamDialog } from "@/components/upstream-dialog";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { BoardHeaderSlot } from "@/routes/boards/$boardId";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { softAccentBadge } from "@/components/constants/colors";
import { useShortcut } from "@/lib/shortcuts";
import { SyncArchivesButton } from "@/components/sync/sync-archives-button";

export const Route = createFileRoute("/boards/$boardId/list")({
  component: BoardListRoute,
});

function BoardListRoute() {
  const { boardId } = Route.useParams();
  return <BoardList boardId={Number(boardId)} />;
}

/** All tasks on one board, ordered: unfinished columns first, then by completion date. */
function BoardList({ boardId }: { boardId: number }) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useShortcut("focus-searchbar", () => searchRef.current?.focus());
  const board = useLiveQuery(() => db.boards.get(boardId));
  const cards = useLiveQuery(() =>
    db.cards.where("boardId").equals(boardId).toArray(),
  );
  const tags = useLiveQuery(() =>
    db.tags.where("boardId").equals(boardId).toArray(),
  );
  const [openCardId, setOpenCardId] = useState<number | null>(null);

  // Archived cards open the same task modal, read-only.
  const archived = useMemo(() => archivedCardIds(board, cards ?? []), [board, cards]);
  const openCard = cards?.find((card) => card.id === openCardId) ?? null;

  const rows = useMemo(() => {
    if (!board || !cards) return [];
    const columnIndex = new Map(board.columns.map((c, i) => [c.id, i]));
    const q = query.trim().toLowerCase();
    return cards
      .filter(
        (c: Card) =>
          !q ||
          c.title.toLowerCase().includes(q) ||
          (c.description ?? '').toLowerCase().includes(q),
      )
      .sort(
        (a: Card, b: Card) =>
          // null completedAt sorts first, so todo/doing come before finished cards
          (a.completedAt ?? 0) - (b.completedAt ?? 0) ||
          (columnIndex.get(a.column) ?? 0) - (columnIndex.get(b.column) ?? 0) ||
          a.createdAt - b.createdAt,
      );
  }, [board, cards, query]);

  if (!board) return null;

  const columnIdx = (id: string) => board.columns.findIndex((c) => c.id === id);
  const columnTitle = (id: string) =>
    board.columns.find((c) => c.id === id)?.title ?? id;
  const formatDate = (ms: number | null) =>
    ms ? new Date(ms).toLocaleDateString() : "—";

  return (
    <div className="px-4 pt-4">
      <BoardHeaderSlot>
        <div className="relative min-w-56">
          <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2" />
          <Input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="text-xs md:text-xs bg-muted h-7 border-0 pl-8"
            aria-label="Search tasks"
          />
        </div>
      </BoardHeaderSlot>
      <div className="mb-2 flex items-center justify-end">
        <SyncArchivesButton />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Task</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>Completed</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((card) => (
            <TableRow
              key={card.id}
              tabIndex={0}
              aria-label={`Open ${card.title}`}
              onClick={() => setOpenCardId(card.id)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                setOpenCardId(card.id);
              }}
              className="hover:bg-muted/50 focus-visible:bg-muted/50 cursor-pointer outline-hidden"
            >
              <TableCell className="font-medium">{card.title}</TableCell>
              <TableCell>
                <Badge
                  variant="outline"
                  className={softAccentBadge(columnIdx(card.column))}
                >
                  {columnTitle(card.column)}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground tabular-nums">
                {formatDate(card.createdAt)}
              </TableCell>
              <TableCell className="text-muted-foreground tabular-nums">
                {formatDate(card.completedAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {rows.length === 0 && (
        <p className="text-muted-foreground py-4 text-sm">
          {query ? "No tasks match." : "No tasks on this board yet."}
        </p>
      )}
      {openCard && (
        <UpstreamDialog
          cardId={openCard.id}
          cards={cards ?? []}
          columns={board.columns}
          tags={tags ?? []}
          readOnly={archived.has(openCard.id)}
          open
          onOpenChange={(next) => {
            if (!next) setOpenCardId(null);
          }}
          onTagCreated={() => {}}
          usedTagIds={(cards ?? []).flatMap((card) => card.tagIds)}
          onUnusedTagsDeleted={() => {}}
          onUpdateCard={(id, changes) => void updateCard(id, changes)}
          onDeleteCard={(id) => void deleteCard(id)}
        />
      )}
    </div>
  );
}
