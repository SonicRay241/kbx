import { useLiveQuery } from "dexie-react-hooks";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { db, type BoardRow, type Card as CardData } from "@/lib/db";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PlusIcon, SquareCheckIcon, SquarePlayIcon } from "lucide-react";
import { ACCENTS, accentText, softAccentBadge } from "@/components/constants/colors";
import { useCreateBoard } from "@/components/app-shell";

type BoardStats = {
  board: BoardRow;
  accent: string;
  counts: { id: string; title: string; count: number }[];
  total: number;
  finished: number;
  pct: number;
};

export function Dashboard() {
  const create = useCreateBoard();
  const boards = useLiveQuery(() => db.boards.orderBy("createdAt").toArray());
  const cards = useLiveQuery(() => db.cards.toArray());

  const stats = useMemo(() => {
    if (!boards || !cards) return null;

    const byBoard = new Map<number, CardData[]>(boards.map((b) => [b.id!, []]));
    for (const card of cards) byBoard.get(card.boardId)?.push(card);

    const finishedColumn = (board: BoardRow) => board.columns[board.columns.length - 1]?.id ?? "";
    const columnTitle = (board: BoardRow, columnId: string) =>
      board.columns.find((c) => c.id === columnId)?.title ?? columnId;
    const columnIndex = (board: BoardRow, columnId: string) =>
      Math.max(board.columns.findIndex((c) => c.id === columnId), 0);

    const perBoard: BoardStats[] = boards.map((board, i) => {
      const list = byBoard.get(board.id!) ?? [];
      const finished = finishedColumn(board);
      const done = list.filter((c) => c.column === finished).length;
      return {
        board,
        accent: ACCENTS[i % ACCENTS.length],
        counts: board.columns.map((col) => ({
          id: col.id,
          title: col.title,
          count: list.filter((c) => c.column === col.id).length,
        })),
        total: list.length,
        finished: done,
        pct: list.length ? Math.round((done / list.length) * 100) : 0,
      };
    });

    const ongoing = cards
      .map((card) => {
        const board = boards.find((b) => b.id === card.boardId);
        if (!board || card.column === finishedColumn(board)) return null;
        return {
          card,
          board,
          state: columnTitle(board, card.column),
          rank: columnIndex(board, card.column),
          badge: softAccentBadge(columnIndex(board, card.column)),
        };
      })
      .filter((row) => row !== null)
      // Closest to done first: a later column is nearer the finished column, so
      // "in review" outranks "todo". Newest breaks ties.
      .sort((a, b) => b.rank - a.rank || b.card.createdAt - a.card.createdAt);

    return {
      perBoard,
      ongoingTasks: ongoing,
      ongoing: ongoing.length,
      completed: cards.length - ongoing.length,
    };
  }, [boards, cards]);

  if (!stats) return null;

  if (stats.perBoard.length === 0) {
    return (
      <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3">
        <p className="text-sm">Select a board</p>
        <Button variant="outline" size="sm" onClick={() => create.open()}>
          <PlusIcon />
          New board
        </Button>
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 w-full gap-4 px-4 pt-4">
      <div className="flex min-h-0 flex-col gap-4 pb-4">
        <h1 className="text-xl font-medium pl-8 md:pl-0">Tasks overview</h1>

        <div className="grid grid-cols-2 xl:grid-cols-4 gap-4 w-full">
          <div className="col-span-2">
            <div className="grid grid-cols-2 gap-4">
              <StatCard icon={<SquarePlayIcon className="size-5" />} label="Ongoing tasks" value={stats.ongoing} />
              <StatCard icon={<SquareCheckIcon className="size-5" />} label="Completed tasks" value={stats.completed} />
            </div>

            <section className="space-y-4 pt-4">
              <h2 className="text-lg font-medium">Projects</h2>
              <div className="grid grid-cols-2 gap-4">
                {stats.perBoard.map((entry) => (
                  <ProjectCard key={entry.board.id} entry={entry} />
                ))}
              </div>
            </section>
          </div>
          <div className="col-span-2">
            <section className="ring-foreground/10 bg-card flex min-h-0 flex-col rounded-xl ring-1">
              <h2 className="px-5 pt-5 text-lg font-medium">Ongoing tasks</h2>
              <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
                {stats.ongoingTasks.length === 0 ? (
                  <p className="text-muted-foreground px-2 py-6 text-sm">Nothing in progress.</p>
                ) : (
                  <Table className="text-xs">
                    <TableHeader className="bg-card sticky top-0">
                      <TableRow>
                        <TableHead className="h-8">Task</TableHead>
                        <TableHead className="h-8">Project</TableHead>
                        <TableHead className="h-8">State</TableHead>
                        <TableHead className="h-8">Created</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {stats.ongoingTasks.map(({ card, board, state, badge }) => (
                        <TableRow key={card.id}>
                          <TableCell className="max-w-32 truncate font-medium">{card.title}</TableCell>
                          <TableCell className="text-muted-foreground max-w-20 truncate">
                            <Link
                              to="/boards/$boardId"
                              params={{ boardId: String(board.id) }}
                              className="hover:text-foreground hover:underline"
                            >
                              {board.name}
                            </Link>
                          </TableCell>
                          <TableCell>
                            {state ? (
                              <Badge variant="outline" className={badge}>
                                {state}
                              </Badge>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground tabular-nums">
                            {new Date(card.createdAt).toLocaleDateString()}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            </section>
          </div>
        </div>
      </div>

    </div>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="ring-foreground/10 bg-card flex flex-col gap-3 rounded-xl p-5 ring-1">
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        {icon}
        <span>{label}</span>
      </div>
      <p className="text-4xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function ProjectCard({ entry }: { entry: BoardStats }) {
  const { board, accent, counts, finished, total, pct } = entry;
  return (
    <Link
      to="/boards/$boardId"
      params={{ boardId: String(board.id) }}
      className="ring-foreground/10 bg-card col-span-2 sm:col-span-1 hover:bg-sidebar-accent flex flex-col gap-3 rounded-xl p-5 ring-1 transition-colors"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className={`size-2 shrink-0 rounded-full ${accent}`} />
        <h3 className="truncate text-sm font-semibold">{board.name}</h3>
        <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
          {finished}/{total}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        {counts.map((col, i) => (
          <div key={col.id} className="flex items-baseline justify-between gap-2 text-xs">
            <span className={`truncate ${accentText(i)}`}>{col.title}</span>
            <span className="font-medium tabular-nums">{col.count}</span>
          </div>
        ))}
      </div>
      <div className="space-y-1.5">
        <div className="text-muted-foreground flex items-center justify-between text-xs">
          <span>Progress</span>
          <span className="text-foreground font-medium tabular-nums">{pct}%</span>
        </div>
        <Progress value={pct} className="h-1.5" />
      </div>
    </Link>
  );
}