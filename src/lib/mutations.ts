import { db, type BoardRow, type Card, type Tag, type Workspace } from '@/lib/db'
import { scheduleSync } from '@/sync/sync-engine'

/**
 * Merge metadata written on every mutation: `updatedAt` + per-field
 * `fieldTimestamps` (LWW). Keys are top-level field names; foreign keys
 * (boardId, upstreamIds, tagIds) are stamped under their own names.
 */
interface StampMeta {
  updatedAt: number
  fieldTimestamps: Record<string, number>
}

function stamped<T extends object>(patch: T, baseTs?: Record<string, number>): Partial<T> & StampMeta {
  const now = Date.now()
  const fieldTimestamps: Record<string, number> = { ...(baseTs ?? {}) }
  for (const key of Object.keys(patch)) {
    if (key === 'updatedAt' || key === 'fieldTimestamps') continue
    fieldTimestamps[key] = now
  }
  return { ...patch, updatedAt: now, fieldTimestamps } as Partial<T> & StampMeta
}

const uuid = () => crypto.randomUUID()

export async function createBoard(name: string, columns: BoardRow['columns']): Promise<BoardRow> {
  const now = Date.now()
  const last = await db.boards.orderBy('sidebarOrder').last()
  const board: BoardRow = {
    uid: uuid(),
    name,
    workspaceId: null,
    sidebarOrder: (last?.sidebarOrder ?? -1) + 1,
    columns: columns.map((c) => ({ ...c })),
    archiveCutoff: 0,
    createdAt: now,
    updatedAt: now,
    fieldTimestamps: { name: now, columns: now, archiveCutoff: now, sidebarOrder: now, workspaceId: now },
  }
  board.id = await db.boards.add(board)
  scheduleSync()
  return board
}

export async function renameBoard(id: number, name: string): Promise<void> {
  await db.boards.update(id, stamped({ name }) as unknown as Partial<BoardRow>)
  scheduleSync()
}

/** Persist a new column list (reorder, add, or remove-after-migrate). */
export async function setBoardColumns(id: number, columns: BoardRow['columns']): Promise<void> {
  await db.boards.update(id, stamped({ columns }) as unknown as Partial<BoardRow>)
  scheduleSync()
}

export async function deleteBoard(id: number): Promise<void> {
  await db.transaction('rw', db.boards, db.cards, db.tags, db.deletedEntities, db.entitySyncMeta, async () => {
    const board = await db.boards.get(id)
    const cards = await db.cards.where('boardId').equals(id).toArray()
    const tags = await db.tags.where('boardId').equals(id).toArray()
    // Tombstones propagate the cascade to other devices.
    const deletedAt = Date.now()
    if (board?.uid) {
      await db.deletedEntities.put({ id: `board:${board.uid}`, deletedAt })
    }
    for (const card of cards) {
      await db.deletedEntities.put({ id: `card:${card.uid}`, deletedAt })
    }
    for (const tag of tags) {
      await db.deletedEntities.put({ id: `tag:${tag.uid}`, deletedAt })
    }
    await db.cards.where('boardId').equals(id).delete()
    await db.tags.where('boardId').equals(id).delete()
    await db.boards.delete(id)
  })
  scheduleSync()
}

export async function createCard(input: Omit<Card, 'id' | 'uid' | 'completedAt'>): Promise<Card> {
  const now = Date.now()
  const card: Omit<Card, 'id'> = {
    ...input,
    completedAt: null,
    uid: uuid(),
    createdAt: input.createdAt || now,
    updatedAt: now,
    fieldTimestamps: {
      boardId: now,
      column: now,
      title: now,
      order: now,
      upstreamIds: now,
      tagIds: now,
      completedAt: now,
    },
  }
  const newId = await db.cards.add(card as Card)
  scheduleSync()
  return { ...card, id: newId } as Card
}

/** General card edit (title, tags, upstream list). */
export async function updateCard(id: number, changes: Partial<Omit<Card, 'id' | 'uid' | 'createdAt'>>): Promise<void> {
  await db.cards.update(id, stamped(changes) as unknown as Partial<Card>)
  scheduleSync()
}

/** Move/reorder: order + column change, stamped for LWW. completedAt flips
 * with transitions across the finished column (set on entering, cleared on
 * leaving it). Reorders (no column change) leave completedAt untouched. */
export async function moveCards(changes: { key: number; changes: { order: number; column?: string } }[], finishedColumnId?: string): Promise<void> {
  const now = Date.now()
  const keys = changes.map(c => c.key)
  const prev = await db.cards.bulkGet(keys)
  const prevById = new Map<number, Card>()
  for (const row of prev) {
    if (row) prevById.set(row.id, row)
  }
  await db.cards.bulkUpdate(
    changes.map(({ key, changes: c }) => {
      const prior = prevById.get(key)
      const wasFinished = prior?.column === finishedColumnId
      const isFinished = c.column !== undefined && c.column === finishedColumnId
      const transition = c.column !== undefined && isFinished !== wasFinished
      return {
        key,
        changes: {
          ...c,
          // A pure reorder keeps completedAt as-is (undefined → untouched);
          // a column change rewrites it per the transition above.
          ...(c.column !== undefined ? { completedAt: isFinished ? now : null } : {}),
          updatedAt: now,
          fieldTimestamps: {
            order: now,
            ...(c.column !== undefined
              ? { column: now, ...(transition ? { completedAt: now } : {}) }
              : {}),
          },
        },
      }
    }),
  )
  scheduleSync()
}

export async function deleteCard(id: number): Promise<void> {
  await db.transaction('rw', db.cards, db.deletedEntities, async () => {
    const card = await db.cards.get(id)
    if (card) {
      await db.deletedEntities.put({ id: `card:${card.uid}`, deletedAt: Date.now() })
    }
    // Cascade into other cards' upstreamIds references.
    const affected = await db.cards.filter((c) => c.upstreamIds.includes(id)).toArray()
    await db.cards.delete(id)
    for (const other of affected) {
      await db.cards.update(other.id, stamped({ upstreamIds: other.upstreamIds.filter((u) => u !== id) }) as unknown as Partial<Card>)
    }
  })
  scheduleSync()
}

/** Column removal migration: bulk-move cards between columns (stamped,
 * completedAt flips when migrating into/out of the finished column). */
export async function migrateCardsColumn(boardId: number, from: string, to: string, finishedColumnId?: string): Promise<void> {
  const now = Date.now()
  const completing = finishedColumnId !== undefined && to === finishedColumnId
  // When the migrated-from column IS the finished column the cards lose their
  // done state (they move into a non-finished column).
  const completingFlip = finishedColumnId !== undefined && from === finishedColumnId
  await db.cards
    .where('[boardId+column]')
    .equals([boardId, from])
    .modify((card: Card) => {
      card.column = to
      card.completedAt = completing ? now : completingFlip ? null : card.completedAt
      card.updatedAt = now
      card.fieldTimestamps = { ...card.fieldTimestamps, column: now, completedAt: now }
    })
  scheduleSync()
}

/** Archive: set the board's done-card cutoff (0 = keep everything). */
export async function setBoardArchiveCutoff(boardId: number, cutoff: number): Promise<void> {
  await db.boards.update(boardId, stamped({ archiveCutoff: cutoff }) as unknown as Partial<BoardRow>)
  scheduleSync()
}

// --- Tags -------------------------------------------------------------------

export async function createTag(input: { boardId: number; name: string; color: string }): Promise<Tag> {
  const now = Date.now()
  const tag: Tag = {
    ...input,
    uid: uuid(),
    createdAt: now,
    updatedAt: now,
    fieldTimestamps: { boardId: now, name: now, color: now },
  }
  tag.id = await db.tags.add(tag)
  scheduleSync()
  return tag
}

export async function deleteTags(ids: number[]): Promise<void> {
  if (ids.length === 0) return
  // Unused by definition (the combobox only offers tags no card references),
  // so no tagIds cascade is needed.
  await db.transaction('rw', db.tags, db.deletedEntities, async () => {
    const now = Date.now()
    for (const id of ids) {
      const tag = await db.tags.get(id)
      if (tag) await db.deletedEntities.put({ id: `tag:${tag.uid}`, deletedAt: now })
    }
    await db.tags.bulkDelete(ids)
  })
  scheduleSync()
}
/** Sidebar grouping. Workspaces sync like boards; the folded state stays local
 * (per device) in localStorage, keyed by uid. */
export async function createWorkspace(name: string): Promise<Workspace> {
  const now = Date.now()
  const last = await db.workspaces.orderBy('order').last()
  const workspace: Workspace = {
    uid: uuid(),
    name,
    order: (last?.order ?? -1) + 1,
    createdAt: now,
    updatedAt: now,
    fieldTimestamps: { name: now, order: now },
  }
  workspace.id = await db.workspaces.add(workspace)
  scheduleSync()
  return workspace
}

export async function renameWorkspace(id: number, name: string): Promise<void> {
  await db.workspaces.update(id, stamped({ name }) as unknown as Partial<Workspace>)
  scheduleSync()
}

/** Delete a workspace, leaving its boards ungrouped. */
export async function deleteWorkspace(id: number): Promise<void> {
  await db.transaction('rw', db.boards, db.workspaces, db.deletedEntities, async () => {
    const workspace = await db.workspaces.get(id)
    if (!workspace) return
    const members = await db.boards.where('workspaceId').equals(id).toArray()
    for (const board of members) {
      await db.boards.update(board.id!, stamped({ workspaceId: null }) as unknown as Partial<BoardRow>)
    }
    await db.deletedEntities.put({ id: `workspace:${workspace.uid}`, deletedAt: Date.now() })
    await db.workspaces.delete(id)
  })
  scheduleSync()
}

/** Assign a board to a workspace (null = ungrouped) and append it to the end. */
export async function setBoardWorkspace(boardId: number, workspaceId: number | null): Promise<void> {
  const siblings = await db.boards.where('workspaceId').equals(workspaceId ?? -1).toArray()
  const last = await db.boards.orderBy('sidebarOrder').last()
  const maxSibling = siblings.reduce((max, row) => Math.max(max, row.sidebarOrder ?? 0), -1)
  await db.boards.update(
    boardId,
    stamped({ workspaceId, sidebarOrder: Math.max(last?.sidebarOrder ?? -1, maxSibling) + 1 }) as unknown as Partial<BoardRow>,
  )
  scheduleSync()
}

/** Persist a full sidebar arrangement: workspace order + per-board group/order. */
export async function saveSidebarLayout(input: {
  workspaces: number[]
  boards: { id: number; workspaceId: number | null }[]
}): Promise<void> {
  await db.transaction('rw', db.boards, db.workspaces, async () => {
    for (const [index, id] of input.workspaces.entries()) {
      const row = await db.workspaces.get(id)
      if (!row || row.order === index) continue
      await db.workspaces.update(id, stamped({ order: index }) as unknown as Partial<Workspace>)
    }
    for (const [index, entry] of input.boards.entries()) {
      const row = await db.boards.get(entry.id)
      const workspaceId = entry.workspaceId ?? null
      if (!row || (row.workspaceId ?? null) === workspaceId && row.sidebarOrder === index) continue
      await db.boards.update(
        entry.id,
        stamped({ workspaceId, sidebarOrder: index }) as unknown as Partial<BoardRow>,
      )
    }
  })
  scheduleSync()
}
