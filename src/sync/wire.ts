/** App folder in the backend (Drive folder name; WebDAV default collection). */
export const APP_FOLDER = 'kanban'
export const INDEX_NAME = 'index.json'

export interface IndexEntry {
  /** Entity id: numeric Dexie key, stringified for index-map keys. */
  id: string
  /** Backend file token: Drive file id, or WebDAV file name under the collection. */
  fileId: string
  /** SHA-256 (hex) of the entity JSON at last push. */
  hash: string
  /** Filename without extension, used as the human-readable backend file name. */
  name: string
  updatedAt: number
  /** Set when the entity was deleted by any device. */
  deletedAt?: number
  /** Tombstone kind. 'delete' removes it from other devices; 'optout' lets them keep a private copy. */
  optout?: boolean
}

export interface DriveIndex {
  /** 2 = board bundles; absent/1 = legacy one-file-per-unit layout. */
  version?: 2
  /** Shared tombstones: unit id (`card:<uid>`, `board:<uid>`, …) → deletedAt. */
  graves?: Record<string, number>
  entries: Record<string, IndexEntry>
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}