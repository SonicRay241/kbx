import Dexie, { type EntityTable } from 'dexie'

type Board = {
  id?: number
  title: string
  createdAt: number
}

const db = new Dexie('kanban') as Dexie & {
  boards: EntityTable<Board, 'id'>
}

db.version(1).stores({
  boards: '++id, title, createdAt',
})

export { db, type Board }