/**
 * WebDAV SyncAdapter. File tokens are UTF-8 file names under the configured
 * collection (`prefix` resolved against the server's kanban directory).
 * Credentials are Basic auth; the password is stored only in localStorage.
 */
import { INDEX_NAME, APP_FOLDER, type DriveIndex } from '../wire'
import { httpError, isStatusNotFound, type SyncAdapter } from './types'
import { emitConnectionChanged } from './connection'

const STORAGE_KEY = 'kanban-webdav-config'

export interface WebdavConfig {
  baseUrl: string
  username: string
  password: string
  /** Path prefix of the app collection; '' denotes the default ("/kanban"). */
  prefixKey?: string
}

export function readWebdavConfig(): WebdavConfig | null {
  const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as WebdavConfig
  } catch {
    localStorage.removeItem(STORAGE_KEY)
    return null
  }
}

export function connectWebdav(config: WebdavConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  emitConnectionChanged()
}

export function disconnectWebdav(): void {
  localStorage.removeItem(STORAGE_KEY)
  emitConnectionChanged()
}

export function isWebdavConnected(): boolean {
  return readWebdavConfig() !== null
}

/** Prove credentials + collection access (MKCOL + PROPFIND) before anything
 * is persisted to localStorage. Throws on auth failure or unreachable server. */
export async function verifyWebdav(config: WebdavConfig): Promise<void> {
  await ensureCollection(config)
  await listCollection(config)
}

/**
 * Resolves the collection path: prefix '/' or absent → "/kanban"; a
 * stored custom prefix (e.g. "/Sync/Docs") has the app folder appended
 * ("/Sync/Docs/kanban").
 */
function collectionPath(config: WebdavConfig): string {
  const prefix = (config.prefixKey ?? '').trim().replace(/^\/+|\/+$/g, '')
  return prefix === '' ? `/${APP_FOLDER}` : `/${prefix}/${APP_FOLDER}`
}

function joinPath(base: string, name: string): string {
  return `${base.replace(/\/+$/, '')}/${name}`
}

function headers(config: WebdavConfig, extra: Record<string, string> = {}): HeadersInit {
  const auth = btoa(`${config.username}:${config.password}`)
  return {
    Authorization: `Basic ${auth}`,
    ...extra,
  }
}

async function webdavFetch(
  config: WebdavConfig,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetch(joinPath(config.baseUrl.replace(/\/+$/, ''), path.replace(/^\/+/, '')), {
    method: init.method,
    headers: headers(config, (init.headers ?? {}) as Record<string, string>),
    body: init.body,
  })
  if (response.status === 401) {
    throw httpError('WebDAV authentication failed. Reconnect to continue.', 401)
  }
  if (!response.ok && response.status !== 404 && response.status !== 409) {
    const text = await response.text()
    throw httpError(`WebDAV request failed: ${response.status} ${text}`, response.status)
  }
  return response
}

/** Depth-1 PROPFIND of the collection; returns member names. */
async function listCollection(config: WebdavConfig): Promise<string[]> {
  const response = await webdavFetch(config, collectionPath(config), {
    method: 'PROPFIND',
    headers: { Depth: '1' },
  })
  if (response.status === 404) return []
  const xml = await response.text()
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const parserError = doc.getElementsByTagNameNS('http://www.w3.org/2000/xmlns/', 'parsererror')[0]
    ?? doc.getElementsByTagName('parsererror')[0]
  if (parserError) {
    throw new Error('Invalid PROPFIND response from the WebDAV server.')
  }
  // Namespace-agnostic: take the last URI segment of any <D:href>/<href>.
  const hrefs = Array.from(doc.getElementsByTagNameNS('*', 'href'))
  const base = new URL(joinPath(config.baseUrl.replace(/\/+$/, ''), collectionPath(config).replace(/^\/+/, '')))
  const names: string[] = []
  for (const href of hrefs) {
    let raw = href.textContent ?? ''
    if (!raw) continue
    try {
      const resolved = new URL(raw, base)
      if (resolved.origin !== base.origin) continue
      raw = resolved.pathname
    } catch {
      // Relative href: use as-is.
    }
    const trimmed = raw.replace(/\/+$/, '')
    if (!trimmed || trimmed === base.pathname.replace(/\/+$/, '')) continue
    names.push(decodeURIComponent(trimmed.slice(trimmed.lastIndexOf('/') + 1)))
  }
  return names
}

async function ensureCollection(config: WebdavConfig): Promise<void> {
  const target = collectionPath(config)
  // MKCOL parents bottom-up so a missing prefix (e.g. "/Sync/Docs") is
  // created too. RFC 4918: MKCOL on an ALREADY EXISTING collection answers
  // 405 Method Not Allowed — that is "already there", not a failure (the
  // exact behavior of Go x/net/webdav servers like Cloudreve). Confirm
  // existence with a Depth-0 PROPFIND before accepting the 405.
  const segments = target.split('/').filter(Boolean)
  let current = ''
  for (const segment of segments) {
    current = `${current}/${segment}`
    try {
      await webdavFetch(config, current, { method: 'MKCOL' })
    } catch (error) {
      if (
        error instanceof Error &&
        'status' in error &&
        error.status === 405
      ) {
        const probe = await webdavFetch(config, current, {
          method: 'PROPFIND',
          headers: { Depth: '0' },
        })
        if (probe.status === 207) continue
      }
      throw error
    }
  }
}

async function uploadFile(name: string, content: string, fileId?: string): Promise<string> {
  const config = readWebdavConfig()
  if (!config) throw new Error('Not connected to WebDAV.')
  await ensureCollection(config)
  const token = fileId ?? name
  const response = await webdavFetch(config, joinPath(collectionPath(config), token), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: content,
  })
  if (!response.ok) throw httpError(`WebDAV upload failed: ${response.status}`, response.status)
  // PUT is idempotent: the token is the name, so renames create a new file and
  // leave the old copy behind. The engine treats stale tokens as best-effort.
  return token
}

async function downloadFile(fileId: string): Promise<string> {
  const config = readWebdavConfig()
  if (!config) throw new Error('Not connected to WebDAV.')
  const response = await webdavFetch(config, joinPath(collectionPath(config), fileId), {
    method: 'GET',
  })
  if (response.status === 404) {
    throw httpError(`WebDAV file not found: ${fileId}`, 404)
  }
  return response.text()
}

async function deleteFile(fileId: string): Promise<void> {
  const config = readWebdavConfig()
  if (!config) throw new Error('Not connected to WebDAV.')
  await webdavFetch(config, joinPath(collectionPath(config), fileId), { method: 'DELETE' })
  // 404 counts as success: already gone.
}

async function readIndex(): Promise<{ index: DriveIndex; fileId: string | null }> {
  const config = readWebdavConfig()
  if (!config) throw new Error('Not connected to WebDAV.')
  await ensureCollection(config)
  try {
    const raw = await downloadFile(INDEX_NAME)
    // A missing index starts empty (absent ≠ corrupt). Only an unPARSEABLE
    // file resets to empty, with the same warning semantics as the Drive
    // adapter: a silent reset can quietly forget other devices' tombstones.
    // HTTP/network errors propagate — the engine reports them instead of
    // overwriting the cloud index from a transient failure.
    try {
      const parsed = JSON.parse(raw) as DriveIndex
      return { index: { entries: parsed.entries ?? {} }, fileId: INDEX_NAME }
    } catch (error) {
      console.error(
        'kanban index.json is corrupt and was reset to empty; ' +
          'deleted/opted-out tombstones may be forgotten. ' +
          (error instanceof Error ? error.message : String(error)),
      )
      return { index: { entries: {} }, fileId: INDEX_NAME }
    }
  } catch (error) {
    if (isStatusNotFound(error)) return { index: { entries: {} }, fileId: null }
    throw error
  }
}

async function writeIndex(index: DriveIndex, _fileId?: string): Promise<string> {
  const content = JSON.stringify(index, null, 2)
  return uploadFile(INDEX_NAME, content)
}

export const webdavAdapter: SyncAdapter = {
  id: 'webdav',
  label: 'WebDAV',
  isConnected: isWebdavConnected,
  disconnect: disconnectWebdav,
  uploadFile,
  downloadFile,
  deleteFile,
  readIndex,
  writeIndex,
  isNotFound: (error) => isStatusNotFound(error),
}