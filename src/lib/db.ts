import Dexie, { type EntityTable } from 'dexie'

export type BoardRow = {
  id?: number
  /** Cross-device identity: UUID minted at creation, travels with sync. */
  uid: string
  name: string
  columns: { id: string; title: string }[]
  /** Done cards completed before this instant are archived (hidden on the board, listed on /list). 0 = never archived. */
  archiveCutoff: number
  createdAt: number
  updatedAt?: number
  /** Per-field last-write timestamps for LWW merge (sync metadata). */
  fieldTimestamps?: Record<string, number>
}

export type Tag = {
  id?: number
  uid: string
  boardId: number
  name: string
  color: string
  createdAt: number
  updatedAt?: number
  fieldTimestamps?: Record<string, number>
}

export type Card = {
  id: number
  uid: string
  boardId: number
  column: string
  title: string
  description?: string
  order: number
  upstreamIds: number[]
  tagIds: number[]
  /** Set when the card enters the finished column; cleared on leaving it. */
  completedAt: number | null
  createdAt: number
  updatedAt?: number
  fieldTimestamps?: Record<string, number>
}

/** Per-unit sync bookkeeping: unit id is `<kind>:<uid>`. */
export type EntitySyncMeta = {
  id: string
  /** Whether this device opted the unit into cloud sync. */
  cloudSynced?: boolean
  /** When the current opt-in happened; guards against stale opt-out tombstones. */
  cloudSyncedAt?: number
  /** Hash of the cloud payload at the last successful push. */
  lastPushedHash?: string
  /** Backend file token (Drive file id / WebDAV name) at the last push. */
  fileId?: string
}

export type SyncMetaRow = {
  key: string
  fileId?: string
  lastSyncedAt?: string
}

/** Tombstone for locally deleted entities not yet propagated to the cloud. */
export type DeletedEntity = {
  id: string
  deletedAt: number
}

const db = new Dexie('kanban') as Dexie & {
  boards: EntityTable<BoardRow, 'id'>
  tags: EntityTable<Tag, 'id'>
  cards: EntityTable<Card, 'id'>
  entitySyncMeta: EntityTable<EntitySyncMeta, 'id'>
  syncMeta: EntityTable<SyncMetaRow, 'key'>
  deletedEntities: EntityTable<DeletedEntity, 'id'>
}

db.version(2)
  .stores({
    boards: '++id, createdAt',
    cards: '++id, boardId, column, [boardId+column]',
  })
  .upgrade(async (tx) => {
    // profiles was the v1 name of the boards table; carry rows and the card foreign key over.
    const oldBoards = await tx.table('profiles').toArray()
    const newIds = await tx.table('boards').bulkAdd(oldBoards, { allKeys: true })
    await tx.table('cards').toCollection().modify((card: Card & { profileId?: number }) => {
      card.boardId = newIds[card.profileId!]
      delete card.profileId
    })
    await tx.table('profiles').delete(oldBoards.map((b: BoardRow) => b.id!))
  })

db.version(3)
  .stores({
    boards: '++id, createdAt',
    tags: '++id, boardId, [boardId+name]',
    cards: '++id, boardId, column, [boardId+column]',
  })
  .upgrade(async tx => {
    // v2 → v3: add tagIds to every card.
    await tx.table('cards').toCollection().modify((card: Card & { tagIds?: number[] }) => {
      card.tagIds ??= []
    })
  })

db.version(4)
  .stores({
    boards: '++id, createdAt, uid',
    tags: '++id, boardId, [boardId+name], uid',
    cards: '++id, boardId, column, [boardId+column], uid',
    entitySyncMeta: 'id',
    syncMeta: 'key',
    deletedEntities: 'id',
  })
  .upgrade(async tx => {
    // v3 → v4: mint cross-device uids for rows that predate sync.
    const uuid = () => crypto.randomUUID()
    await tx.table('boards').toCollection().modify((board: BoardRow & { uid?: string }) => {
      board.uid ??= uuid()
    })
    await tx.table('tags').toCollection().modify((tag: Tag & { uid?: string }) => {
      tag.uid ??= uuid()
    })
    await tx.table('cards').toCollection().modify((card: Card & { uid?: string }) => {
      card.uid ??= uuid()
    })
  })

db.version(5)
  .stores({
    boards: '++id, createdAt, uid',
    tags: '++id, boardId, [boardId+name], uid',
    cards: '++id, boardId, column, [boardId+column], uid',
    entitySyncMeta: 'id',
    syncMeta: 'key',
    deletedEntities: 'id',
  })
  .upgrade(async tx => {
    // v4 → v5: archive feature — completedAt on cards, archiveCutoff on boards.
    await tx.table('cards').toCollection().modify((card: Card & { completedAt?: number | null }) => {
      card.completedAt ??= null
    })
    await tx.table('boards').toCollection().modify((board: BoardRow & { archiveCutoff?: number }) => {
      board.archiveCutoff ??= 0
    })
  })

// Rightmost column is the finished state (leftmost for RTL boards): cards become draggable once all their upstream cards are here.
export const DEFAULT_COLUMNS = [
  { id: 'todo', title: 'To do' },
  { id: 'doing', title: 'Doing' },
  { id: 'done', title: 'Done' }
]

export { db }

/**
 * Cards archived on the board: finished (last column) before the board's cutoff.
 * Hidden from the board and the lineage view by default; still selectable in the lineage picker.
 */
export function archivedCardIds(board: BoardRow | null | undefined, cards: Card[]): Set<number> {
  const set = new Set<number>()
  const cutoff = board?.archiveCutoff ?? 0
  if (cutoff <= 0 || !board?.columns?.length) return set
  const finished = board.columns[board.columns.length - 1].id
  for (const card of cards) {
    if (card.column === finished && card.completedAt !== null && card.completedAt < cutoff) set.add(card.id)
  }
  return set
}