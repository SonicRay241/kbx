import type { DriveIndex } from '../wire'

export type SyncSourceId = 'gdrive' | 'webdav'

/**
 * Storage contract every sync backend implements. The engine calls these
 * functions identically regardless of source; `fileId` is an opaque token the
 * adapter mints (Drive file id, WebDAV file name under the collection) and is
 * persisted in the index for later updates.
 */
export interface SyncAdapter {
  id: SyncSourceId
  label: string
  isConnected(): boolean
  disconnect(): void
  /**
   * Ensure `name` holds `content` in the app folder. When `fileId` names an
   * existing backend file it is reused (updated); renaming is the adapter's
   * job. Returns the token future calls must use.
   */
  uploadFile(name: string, content: string, fileId?: string): Promise<string>
  downloadFile(fileId: string): Promise<string>
  deleteFile(fileId: string): Promise<void>
  readIndex(): Promise<{ index: DriveIndex; fileId: string | null }>
  writeIndex(index: DriveIndex, fileId?: string): Promise<string>
  isNotFound(error: unknown): boolean
}

export function httpError(message: string, status: number): Error & { status: number } {
  const error = new Error(message) as Error & { status: number }
  error.status = status
  return error
}

export function isStatusNotFound(error: unknown): boolean {
  return (error as (Error & { status?: number }) | null)?.status === 404
}