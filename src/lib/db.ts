import Dexie, { type EntityTable } from 'dexie'

export type Profile = {
  id?: number
  name: string
  columns: { id: string; title: string }[]
  createdAt: number
}

export type Card = {
  id: number
  profileId: number
  column: string
  title: string
  order: number
  upstreamIds: number[]
  createdAt: number
}

const db = new Dexie('kanban') as Dexie & {
  profiles: EntityTable<Profile, 'id'>
  cards: EntityTable<Card, 'id'>
}

db.version(1).stores({
  profiles: '++id, createdAt',
  cards: '++id, profileId, column, [profileId+column]',
})

// Rightmost column is the finished state (leftmost for RTL boards): cards become draggable once all their upstream cards are here.
export const DEFAULT_COLUMNS = [
  { id: 'todo', title: 'To do' },
  { id: 'doing', title: 'Doing' },
  { id: 'done', title: 'Done' }
]

export { db }