import { useEffect, useMemo, useRef, useState } from "react";
import { PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { db, type Tag } from "@/lib/db";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  Combobox,
  ComboboxChips,
  ComboboxChip,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxSeparator,
  useComboboxAnchor,
} from "@/components/ui/combobox";

// 12 tailwind tag colors; assigned round-robin at creation so tags stay distinct.
const TAG_COLORS = [
  "bg-sky-600 dark:bg-sky-400",
  "bg-amber-600 dark:bg-amber-400",
  "bg-green-600 dark:bg-green-400",
  "bg-violet-600 dark:bg-violet-400",
  "bg-rose-600 dark:bg-rose-400",
  "bg-cyan-600 dark:bg-cyan-400",
  "bg-orange-600 dark:bg-orange-400",
  "bg-emerald-600 dark:bg-emerald-400",
  "bg-indigo-600 dark:bg-indigo-400",
  "bg-fuchsia-600 dark:bg-fuchsia-400",
  "bg-lime-600 dark:bg-lime-400",
  "bg-red-600 dark:bg-red-400",
] as const;

const nextColor = (existing: Tag[]) =>
  TAG_COLORS[existing.length % TAG_COLORS.length];

interface TagsComboboxProps {
  boardId: number;
  /** All tags for this board (parent state — kept current via onTagCreated). */
  tags: Tag[];
  /** Called after a new tag row lands in the DB so the parent can update its list. */
  onTagCreated: (tag: Tag) => void;
  /** Ids of tags referenced by any card (to power the remove-unused action). */
  usedTagIds: number[];
  /** Write-through: unused tags were deleted; parent updates its tag list. */
  onUnusedTagsDeleted: (ids: number[]) => void;
  /** Currently selected tag ids (the card's tagIds). */
  selected: number[];
  /** Write-through setter (updates card state + persists). */
  onChange: (tagIds: number[]) => void;
}

export function TagsCombobox({
  boardId,
  tags,
  onTagCreated,
  usedTagIds,
  onUnusedTagsDeleted,
  selected,
  onChange,
}: TagsComboboxProps) {
  const [confirmClean, setConfirmClean] = useState(false);
  const usedSet = useMemo(() => new Set(usedTagIds), [usedTagIds]);
  const unusedTags = useMemo(
    () => tags.filter((t) => !usedSet.has(t.id!)),
    [tags, usedSet],
  );
  const [query, setQuery] = useState("");
  const anchor = useComboboxAnchor();
  // Portal the popup into the modal dialog itself: base-ui's modal Dialog locks
  // pointer events on everything outside it, which would swallow dropdown clicks.
  const [portalContainer, setPortalContainer] = useState<
    HTMLElement | undefined
  >(undefined);
  useEffect(() => {
    if (!anchor.current) return;
    setPortalContainer(
      anchor.current.closest('[data-slot="dialog-content"]') ?? undefined,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- anchor identity is stable; resolve once mounted
  }, []);
  const creatingRef = useRef(false);

  const tagById = useMemo(() => new Map(tags.map((t) => [t.id!, t])), [tags]);
  const selectedTags = selected
    .map((id) => tagById.get(id))
    .filter((t) => t) as Tag[];
  const items = useMemo(
    () => [...tags].sort((a, b) => a.name.localeCompare(b.name)),
    [tags],
  );
  const q = query.trim().toLowerCase();
  // Keep selected tags visible so their chips can resolve; filter the rest by substring.
  const matches = items.filter(
    (t) => selected.includes(t.id!) || t.name.toLowerCase().includes(q),
  );
  const exactMatch = tags.some((t) => t.name.toLowerCase() === q);
  const canCreate = q.length > 0 && !exactMatch;

  const createTag = () => {
    const name = query.trim();
    if (!name || exactMatch) return;
    creatingRef.current = true;
    void (
      db.tags.add({
        boardId,
        name,
        color: nextColor(tags),
        createdAt: Date.now(),
      }) as Promise<number>
    )
      .then((id) => {
        creatingRef.current = false;
        onTagCreated({
          id,
          boardId,
          name,
          color: nextColor(tags),
          createdAt: Date.now(),
        });
        onChange([...selected, id]);
        setQuery("");
      })
      .catch(() => {
        creatingRef.current = false;
      });
  };

  return (
    <Combobox
      multiple
      autoHighlight
      items={items.map((t) => String(t.id))}
      itemToStringLabel={(id) => tagById.get(Number(id))?.name ?? ""}
      itemToStringValue={(id) => id}
      inputValue={query}
      onInputValueChange={setQuery}
      value={selected.map(String)}
      onValueChange={(value, details) => {
        if (creatingRef.current) return; // our own create path already updated selection
        // Only react to real selections. Popup-close 'validation' commits may carry a
        // stale store snapshot that would wipe unrelated tags.
        if (
          details &&
          !(
            details.reason === "item-press" ||
            details.reason === "chip-remove-press" ||
            details.reason === "input-clear"
          )
        )
          return;
        if (!Array.isArray(value)) return;
        const ids = (value as string[]).map(Number);
        const added = ids.find((id) => !selected.includes(id));
        const removed = selected.find((id) => !ids.includes(id));
        if (added !== undefined) {
          onChange([...selected, added]);
        } else if (removed !== undefined) {
          onChange(selected.filter((id) => id !== removed));
        }
      }}
    >
      <ComboboxChips ref={anchor}>
        {selectedTags.map((t) => (
          <ComboboxChip
            key={t.id}
            aria-label={`Chip ${t.name}`}
            showRemove={false}
          >
            <span className={`size-2 shrink-0 rounded-full ${t.color}`} />
            {t.name}
            {/* base-ui ChipRemove resolves by chip index against its internal selectedValue and
                the controlled `value` prop snaps it back before our onChange round-trips;
                a plain button avoids that fight entirely. */}
            <button
              type="button"
              data-slot="combobox-chip-remove"
              aria-label={`Remove tag ${t.name}`}
              className="mr-0.5 opacity-50 hover:opacity-100"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                onChange(selected.filter((id) => id !== t.id));
              }}
            >
              <XIcon className="size-3 pointer-events-none" />
            </button>
          </ComboboxChip>
        ))}
        <ComboboxChipsInput
          placeholder="Add tag…"
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            // Enter with text that matches no existing tag creates a new tag instead of submitting/closing.
            if (q && !exactMatch) {
              e.preventDefault();
              e.stopPropagation();
              createTag();
            }
          }}
        />
      </ComboboxChips>
      <ComboboxContent anchor={anchor} container={portalContainer}>
        <ComboboxList className="data-empty:p-1">
          {matches.map((t) => (
            <ComboboxItem key={t.id} value={String(t.id)}>
              <span className={`size-2 shrink-0 rounded-full ${t.color}`} />
              {t.name}
            </ComboboxItem>
          ))}
          {(canCreate || unusedTags.length > 0) && matches.length > 0 && (
            <ComboboxSeparator />
          )}
          {canCreate && (
            <ComboboxItem
              key={`create:${q}`}
              value={`create:${q}`}
              onClick={createTag}
              className=""
            >
              <PlusIcon className="size-3.5 " />
              Create <span className="font-medium">“{query.trim()}”</span>
            </ComboboxItem>
          )}
          {/* Plain div, not ComboboxItem: item machinery would fold this action row into
              the value model — clicks toggle item values (eats the highlighted tag)
              instead of running our onClick. */}
          {unusedTags.length > 0 && (
            <div
              role="button"
              data-slot="combobox-item"
              data-variant="destructive"
              className="relative flex w-full cursor-default items-center gap-2 rounded-md py-1 px-1.5 mb-1 text-sm text-destructive outline-none select-none hover:bg-destructive/10"
              onClick={() => setConfirmClean(true)}
            >
              <Trash2Icon className="size-3.5" />
              Remove unused tags ({unusedTags.length})
            </div>
          )}
          {matches.length === 0 && !canCreate && (
            <span className="text-muted-foreground px-2 py-1.5 text-sm">
              No tags yet
            </span>
          )}
        </ComboboxList>
      </ComboboxContent>

      <ConfirmDialog
        open={confirmClean}
        onOpenChange={setConfirmClean}
        title={`Remove ${unusedTags.length} unused ${unusedTags.length === 1 ? "tag" : "tags"}?`}
        description={
          unusedTags.length <= 6
            ? unusedTags.map((t) => `“${t.name}”`).join(", ") +
              " — no card uses them."
            : `${unusedTags
                .slice(0, 6)
                .map((t) => `“${t.name}”`)
                .join(
                  ", ",
                )} and ${unusedTags.length - 6} more — no card uses them.`
        }
        onConfirm={() => {
          const ids = unusedTags.map((t) => t.id!);
          void db.tags.bulkDelete(ids);
          onUnusedTagsDeleted(ids);
        }}
      />
    </Combobox>
  );
}
