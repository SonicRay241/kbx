/**
 * Google Drive SyncAdapter. File tokens are Drive file ids. The folder
 * "kanban" is looked up or created lazily; index.json lives inside it.
 */
import { getValidAccessToken, isDriveConnected, disconnectDrive } from '../google-auth'
import { APP_FOLDER, INDEX_NAME, type DriveIndex } from '../wire'
import { httpError, isStatusNotFound, type SyncAdapter } from './types'
import { emitConnectionChanged } from './connection'

async function driveFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getValidAccessToken()
  if (!token) throw new Error('Not connected to Google Drive.')
  const response = await fetch(`https://www.googleapis.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  })
  if (response.status === 401) {
    throw new Error('Google Drive session expired. Reconnect to continue.')
  }
  if (!response.ok) {
    const text = await response.text()
    throw httpError(`Drive request failed: ${response.status} ${text}`, response.status)
  }
  return response
}

interface DriveFile {
  id: string
  name: string
}

async function listFiles(folderId: string): Promise<DriveFile[]> {
  const files: DriveFile[] = []
  let pageToken: string | undefined
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id,name)',
      pageSize: '200',
    })
    if (pageToken) params.set('pageToken', pageToken)
    const response = await driveFetch(`/drive/v3/files?${params}`)
    const json = (await response.json()) as {
      files?: DriveFile[]
      nextPageToken?: string
    }
    files.push(...(json.files ?? []))
    pageToken = json.nextPageToken
  } while (pageToken)
  return files
}

async function findFileByName(folderId: string, name: string): Promise<string | null> {
  const files = await listFiles(folderId)
  return files.find((file) => file.name === name)?.id ?? null
}

let cachedFolderId: string | null = null

async function ensureFolder(): Promise<string> {
  if (cachedFolderId) return cachedFolderId
  const query = encodeURIComponent(
    `mimeType = 'application/vnd.google-apps.folder' and name = '${APP_FOLDER}' and trashed = false`,
  )
  const response = await driveFetch('/drive/v3/files?q=' + query + '&fields=files(id)')
  const json = (await response.json()) as { files: { id: string }[] }
  if (json.files?.length) {
    cachedFolderId = json.files[0].id
    return cachedFolderId
  }

  const created = await driveFetch('/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: APP_FOLDER, mimeType: 'application/vnd.google-apps.folder' }),
  })
  const folder = (await created.json()) as { id: string }
  cachedFolderId = folder.id
  return folder.id
}

async function multipartUpload(
  name: string,
  content: string,
  fileId: string | undefined,
  parents?: string[],
): Promise<string> {
  const metadata = JSON.stringify(parents ? { name, parents } : { name })
  const blob = new Blob([content], { type: 'application/json' })
  const form = new FormData()
  form.append('metadata', new Blob([metadata], { type: 'application/json' }))
  form.append('file', blob)
  const response = fileId
    ? await driveFetch(`/upload/drive/v3/files/${fileId}?uploadType=multipart`, {
        method: 'PATCH',
        body: form,
      })
    : await driveFetch('/upload/drive/v3/files?uploadType=multipart&fields=id', {
        method: 'POST',
        body: form,
      })
  const json = (await response.json()) as { id: string }
  return json.id
}

/** Content-addressed upload: patch when file id is known, else create. */
async function uploadFile(name: string, content: string, fileId?: string): Promise<string> {
  if (fileId) {
    try {
      return await multipartUpload(name, content, fileId)
    } catch (error) {
      // The file may have been deleted by another device (opt-out, delete)
      // while this machine still held a stale fileId — fall back to a
      // fresh create rather than failing the whole sync.
      if (isStatusNotFound(error)) {
        // Fall through to create below.
      } else {
        throw error
      }
    }
  }
  const folderId = await ensureFolder()
  return multipartUpload(name, content, undefined, [folderId])
}

async function downloadFile(fileId: string): Promise<string> {
  const response = await driveFetch(`/drive/v3/files/${fileId}?alt=media`)
  return response.text()
}

async function deleteFile(fileId: string): Promise<void> {
  await driveFetch(`/drive/v3/files/${fileId}`, { method: 'DELETE' })
}

export async function readIndex(): Promise<{ index: DriveIndex; fileId: string | null }> {
  const folderId = await ensureFolder()
  const fileId = await findFileByName(folderId, INDEX_NAME)
  if (!fileId) return { index: { entries: {} }, fileId: null }
  // Download failure is not a corrupt index: it propagates so the engine
  // reports it instead of overwriting the cloud index from a transient
  // error (which would forget other devices' tombstones).
  const raw = await downloadFile(fileId)
  try {
    const parsed = JSON.parse(raw) as DriveIndex
    return { index: { version: parsed.version, graves: parsed.graves, entries: parsed.entries ?? {} }, fileId }
  } catch (error) {
    // Corrupt index: start fresh rather than failing forever, but say so —
    // a silent reset can quietly forget tombstones.
    console.error(
      'kanban index.json is corrupt and was reset to empty; ' +
        'deleted/opted-out tombstones may be forgotten. ' +
        (error instanceof Error ? error.message : String(error)),
    )
    return { index: { entries: {} }, fileId }
  }
}

async function writeIndex(index: DriveIndex, fileId?: string): Promise<string> {
  const content = JSON.stringify(index, null, 2)
  return uploadFile(INDEX_NAME, content, fileId)
}

export const gdriveAdapter: SyncAdapter = {
  id: 'gdrive',
  label: 'Google Drive',
  isConnected: () => isDriveConnected(),
  disconnect: () => {
    disconnectDrive()
    emitConnectionChanged()
  },
  uploadFile,
  downloadFile,
  deleteFile,
  readIndex,
  writeIndex,
  isNotFound: (error) => isStatusNotFound(error),
}