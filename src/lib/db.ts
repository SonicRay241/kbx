import Dexie, { type EntityTable } from 'dexie'

export type BoardRow = {
  id?: number
  name: string
  columns: { id: string; title: string }[]
  createdAt: number
}

export type Card = {
  id: number
  boardId: number
  column: string
  title: string
  order: number
  upstreamIds: number[]
  createdAt: number
}

const db = new Dexie('kanban') as Dexie & {
  boards: EntityTable<BoardRow, 'id'>
  cards: EntityTable<Card, 'id'>
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

// Rightmost column is the finished state (leftmost for RTL boards): cards become draggable once all their upstream cards are here.
export const DEFAULT_COLUMNS = [
  { id: 'todo', title: 'To do' },
  { id: 'doing', title: 'Doing' },
  { id: 'done', title: 'Done' }
]

export { db }