import { db, type BoardRow, type Card, type Tag, type Workspace } from '@/lib/db'
import { sha256Hex, type DriveIndex } from './wire'
import { activeAdapter, type SyncAdapter } from './sync-sources'
import { isWebdavConnected } from './adapters/webdav'
import { isDriveConnected } from './google-auth'

export interface SyncResult {
  pushed: number
  pulled: number
  deleted: number
}

const PUSH_DEBOUNCE_MS = 2000
let pushTimer: number | undefined = undefined
let syncing = false

/** Schedule a debounced cloud sync, e.g. after any board edit. */
export function scheduleSync(): void {
  clearTimeout(pushTimer)
  pushTimer = setTimeout(async () => {
    pushTimer = undefined
    if (!hasSyncSession()) return
    try {
      await syncAll()
    } catch (error) {
      setSyncStatus({
        state: 'error',
        message: error instanceof Error ? error.message : 'unknown error',
      })
    }
  }, PUSH_DEBOUNCE_MS)
}

/** Connection check across every adapter. Both config readers touch
 * localStorage only at call time, so a static module import stays safe under
 * node tests, which load this module without a DOM.
 */
function hasSyncSession(): boolean {
  return isDriveConnected() || isWebdavConnected()
}

/** Google Drive needs an OAuth client id at build time; WebDAV needs nothing. */
export function isGdriveConfigured(): boolean {
  return Boolean(import.meta.env.VITE_GDRIVE_CLIENT_ID)
}

// --- Sync status store (consumed by the sidebar footer) ---
export type SyncStatus =
  | { state: 'idle' }
  | { state: 'syncing' }
  | { state: 'error'; message: string }

let statusListeners: ((status: SyncStatus) => void)[] = []
let currentStatus: SyncStatus = { state: 'idle' }

export function setSyncStatus(status: SyncStatus): void {
  currentStatus = status
  for (const listener of statusListeners) listener(status)
}

export function getSyncStatus(): SyncStatus {
  return currentStatus
}

export function subscribeSyncStatus(listener: (status: SyncStatus) => void): () => void {
  statusListeners.push(listener)
  return () => {
    statusListeners = statusListeners.filter((l) => l !== listener)
  }
}

/** Run syncAll with status reporting for the footer. */
export async function syncNow(): Promise<void> {
  setSyncStatus({ state: 'syncing' })
  try {
    await syncAll()
    setSyncStatus({ state: 'idle' })
  } catch (error) {
    setSyncStatus({
      state: 'error',
      message: error instanceof Error ? error.message : 'unknown error',
    })
    throw error
  }
}

// --- Refocus sync: pull remote changes when the tab regains focus. ---
const REFOCUS_THROTTLE_MS = 10_000
let lastRefocusSync = 0

async function refocusSync(): Promise<void> {
  // Reserve the throttle slot synchronously: visibilitychange and focus can
  // fire in the same refocus, and this must reject the second before either
  // hits its first await.
  const now = Date.now()
  if (now - lastRefocusSync < REFOCUS_THROTTLE_MS) return
  lastRefocusSync = now
  if (!hasSyncSession()) return
  try {
    await syncAll()
  } catch {
    // Silent: refocus pulls are opportunistic; footer shows manual errors.
    lastRefocusSync = 0 // allow an immediate retry on the next focus
  }
}

/** Install the visibility-change listener (called once from main.tsx). */
export function installRefocusSync(): void {
  if (typeof document === 'undefined') return
  // visibilitychange alone covers tab switches; window focus events on the
  // same transition would just race it through the shared throttle.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refocusSync()
  })
}

// --- Unit abstraction -------------------------------------------------------
// The cloud stores three unit kinds: 'board' (row metadata incl. column list),
// 'card', 'tag'. Each is an independent LWW unit — like characters in
// charasheet — so moving one card neither fetches nor clobbers other rows.
//
// Cross-device identity: units key by `<kind>:<uid>` where uid is a UUID
// minted at row creation (v4 schema). Numeric Dexie ids are device-local;
// boardId / upstreamIds / tagIds references are translated per device at
// write time (uid on the wire, local id in the DB) and never enter the hash.

type UnitKind = 'workspace' | 'board' | 'card' | 'tag'

const MERGEABLE_FIELDS: Record<UnitKind, readonly string[]> = {
  workspace: ['name', 'order'],
  // workspaceId travels as the workspace uid; sidebarOrder keeps the sidebar
  // arrangement identical across devices.
  board: ['name', 'columns', 'archiveCutoff', 'workspaceId', 'sidebarOrder'],
  // boardId is mergeable: it travels as the board uid so a pulled card/tag can
  // find its local board row. Without it every pulled child is orphaned.
  card: ['boardId', 'column', 'title', 'description', 'order', 'upstreamIds', 'tagIds', 'completedAt'],
  tag: ['boardId', 'name', 'color'],
}

interface LocalUnit {
  id: string // '<kind>:<uid>'
  kind: UnitKind
  /** Numeric row id on THIS device. */
  rowId: number
  /** Field stamps as written: mergeable fields only. */
  stamps: Record<string, number>
  rowTs: number
  /** Max(rowTs, field stamps) — races against tombstones. */
  updatedAt: number
  row: BoardRow | Card | Tag | Workspace
}

interface CloudUnitDoc {
  fields: Record<string, unknown>
  ts: Record<string, number>
  /** Row updatedAt on the writer device. */
  rowTs: number
}

interface RefMaps {
  workspaceUidById: Map<number, string>
  workspaceIdByUid: Map<string, number>
  boardUidById: Map<number, string>
  cardUidById: Map<number, string>
  tagUidById: Map<number, string>
  /** uid → local numeric id. */
  boardIdByUid: Map<string, number>
  cardIdByUid: Map<string, number>
  tagIdByUid: Map<string, number>
}

async function loadRefMaps(): Promise<RefMaps> {
  const [boards, cards, tags, workspaces] = await Promise.all([
    db.boards.toArray(),
    db.cards.toArray(),
    db.tags.toArray(),
    db.workspaces.toArray(),
  ])
  return {
    workspaceUidById: new Map(workspaces.map((w) => [w.id!, w.uid])),
    workspaceIdByUid: new Map(workspaces.map((w) => [w.uid, w.id!])),
    boardUidById: new Map(boards.map((b) => [b.id!, b.uid])),
    cardUidById: new Map(cards.map((c) => [c.id, c.uid])),
    tagUidById: new Map(tags.map((t) => [t.id!, t.uid])),
    boardIdByUid: new Map(boards.map((b) => [b.uid, b.id!])),
    cardIdByUid: new Map(cards.map((c) => [c.uid, c.id])),
    tagIdByUid: new Map(tags.map((t) => [t.uid, t.id!])),
  }
}

/** Numeric FK → uid (null when dangling; dropped on the wire). */
function refOut(map: Map<number, string>, id: unknown): string | null {
  const numeric = Number(id)
  return map.get(numeric) ?? null
}

/** uid → device-local numeric id (null when dangling; healed by later syncs). */
function refIn(map: Map<string, number>, uid: unknown): number | null {
  if (typeof uid !== 'string') return null
  return map.get(uid) ?? null
}

function asRefArray(value: unknown, byUid: Map<string, number>): number[] {
  if (!Array.isArray(value)) return []
  return value.map((u) => refIn(byUid, u)).filter((id): id is number => id !== null)
}

/** Stable payload the hash covers: mergeable fields with uid-translated FKs. */
function unitPayload(kind: UnitKind, row: BoardRow | Card | Tag | Workspace, refs: RefMaps): string {
  const raw = row as unknown as Record<string, unknown>
  const fields: Record<string, unknown> = {}
  for (const field of MERGEABLE_FIELDS[kind]) {
    if (field === 'boardId') fields[field] = refOut(refs.boardUidById, raw[field])
    else if (field === 'workspaceId') fields[field] = refOut(refs.workspaceUidById, raw[field])
    else if (field === 'upstreamIds') fields[field] = Array.isArray(raw[field]) ? (raw[field] as number[]).map((id) => refOut(refs.cardUidById, id)) : []
    else if (field === 'tagIds') fields[field] = Array.isArray(raw[field]) ? (raw[field] as number[]).map((id) => refOut(refs.tagUidById, id)) : []
    else fields[field] = raw[field]
  }
  const stamps = row.fieldTimestamps ?? {}
  const ts: Record<string, number> = {}
  for (const field of MERGEABLE_FIELDS[kind]) ts[field] = stamps[field] ?? row.updatedAt ?? row.createdAt
  const doc: CloudUnitDoc = { fields, ts, rowTs: row.updatedAt ?? row.createdAt }
  return JSON.stringify(doc)
}

async function loadLocalUnits(): Promise<LocalUnit[]> {
  const [boards, cards, tags, workspaces] = await Promise.all([
    db.boards.toArray(),
    db.cards.toArray(),
    db.tags.toArray(),
    db.workspaces.toArray(),
  ])
  const units: LocalUnit[] = []
  const addUnit = (kind: UnitKind, row: BoardRow | Card | Tag | Workspace): void => {
    const stamps = row.fieldTimestamps ?? {}
    const rowTs = row.updatedAt ?? row.createdAt
    const stampValues = MERGEABLE_FIELDS[kind].map((field) => stamps[field] ?? rowTs)
    units.push({
      id: unitId(kind, row.uid),
      kind,
      rowId: kind === 'card' ? (row as Card).id : row.id ?? 0,
      stamps,
      rowTs,
      updatedAt: Math.max(rowTs, ...(stampValues.length ? stampValues : [0])),
      row,
    })
  }
  for (const workspace of workspaces) addUnit('workspace', workspace)
  for (const board of boards) addUnit('board', board)
  for (const card of cards) addUnit('card', card)
  for (const tag of tags) addUnit('tag', tag)
  return units
}

/** Full two-way sync for all units, using the active source's adapter. */
export async function syncAll(): Promise<SyncResult> {
  if (syncing) return { pushed: 0, pulled: 0, deleted: 0 }
  syncing = true
  try {
    const adapter = activeAdapter()

    const { index, fileId: indexFileId } = await adapter.readIndex()
    const result: SyncResult = { pushed: 0, pulled: 0, deleted: 0 }
    await reconcile(adapter, index, result)

    const newIndexFileId = await adapter.writeIndex(index, indexFileId ?? undefined)
    await db.syncMeta.put({
      key: 'index',
      fileId: newIndexFileId,
      lastSyncedAt: new Date().toISOString(),
    })
    return result
  } finally {
    syncing = false
  }
}

/**
 * Per-unit reconciliation. Mutates `index.entries` in place; tallies
 * pulls/pushes/deletes into `result`. All backend access goes through the
 * adapter, so logic is identical for Drive and WebDAV.
 */
async function reconcile(adapter: SyncAdapter, index: DriveIndex, result: SyncResult): Promise<void> {
  // Snapshot for the pull phase only; the push phase re-reads fresh state
  // below (the pull can persist merged rows and stamped meta).
  const localUnits = await loadLocalUnits()
  const localById = new Map(localUnits.map((u) => [u.id, u]))
  const pullRefs = await loadRefMaps()
  const localHashById = new Map<string, string>()
  for (const unit of localUnits) localHashById.set(unit.id, await sha256Hex(unitPayload(unit.kind, unit.row, pullRefs)))

  // --- Pull phase: remote entries new or changed relative to local. Boards
  // first: pulled cards/tags must find their board row (uid FK translation).
  const kindRank = (unitId: string) =>
    unitId.startsWith('workspace:') ? 0 : unitId.startsWith('board:') ? 1 : unitId.startsWith('tag:') ? 2 : 3
  /** Refs dropped during the pull because the target row wasn't inserted yet. */
  const pendingRefs = new Map<number, { upstreamIds?: unknown; tagIds?: unknown }>()
  for (const [id, entry] of Object.entries(index.entries).sort(([a], [b]) => kindRank(a) - kindRank(b))) {
    const local = localById.get(id)
    const [kind, uid] = splitUnitId(id)

    if (entry.deletedAt) {
      // Tombstone: apply only if newer than the last local edit (optimistic
      // concurrency on timestamps).
      const newerThanEdit = entry.deletedAt >= (local?.updatedAt ?? 0)
      if (local && newerThanEdit) {
        await deleteUnitRow(kind, uid)
        await db.entitySyncMeta.delete(id)
        result.deleted += 1
      } else if (!local) {
        // Remote delete of something this device never had — nothing to do
        // except drop the tombstone once recorded locally.
        await db.deletedEntities.delete(id)
      }
      continue
    }

    if (!local) {
      // A local delete may be pending upload as a tombstone; don't resurrect.
      const pendingDelete = await db.deletedEntities.get(id)
      if (pendingDelete) {
        index.entries[id] = { ...entry, deletedAt: pendingDelete.deletedAt }
        try {
          await adapter.deleteFile(entry.fileId)
        } catch {
          // Already gone.
        }
        await db.entitySyncMeta.delete(id)
        result.deleted += 1
        continue
      }
      let json: string
      try {
        json = await adapter.downloadFile(entry.fileId)
      } catch (error) {
        if (adapter.isNotFound(error)) {
          // Cloud file vanished (crash between deleteFile and writeIndex, or
          // manual deletion): nothing to pull. Clearing the index entry lets
          // the push phase re-create it from another device's copy.
          delete index.entries[id]
          continue
        }
        throw error
      }
      try {
        const inserted = await putUnitRow(kind, uid, json, entry.updatedAt)
        if (kind === 'card') {
          pendingRefs.set(inserted.id, {
            upstreamIds: inserted.fields.upstreamIds,
            tagIds: inserted.fields.tagIds,
          })
        }
        await db.entitySyncMeta.put({ id, lastPushedHash: entry.hash, fileId: entry.fileId })
        result.pulled += 1
      } catch (error) {
        // Boards sort first (see loop head), so an orphan means its board uid
        // is absent from the index entirely (partial push on another device):
        // heals on a later sync.
        if (error instanceof OrphanedUnitError) continue
        throw error
      }
      continue
    }

    const localHash = localHashById.get(id)
    if (localHash === entry.hash) {
      // Content identical — nothing to transfer.
      await db.entitySyncMeta.put({ id, lastPushedHash: entry.hash, fileId: entry.fileId })
      continue
    }
    // Diverged: merge field-by-field, later timestamp wins per field (a
    // LWW-Register CRDT).
    let json: string
    try {
      json = await adapter.downloadFile(entry.fileId)
    } catch (error) {
      if (adapter.isNotFound(error)) {
        // Cloud file gone: adopt local as the merge winner and let the push
        // phase re-create the file (uploadFile also self-heals stale ids).
        continue
      }
      throw error
    }
    const remote = parseCloudDoc(json)
    const merge = mergeUnit(local, kind, remote, entry.updatedAt)
    if (merge.changed) {
      await updateUnitRow(kind, local.rowId, merge)
      if (kind === 'card') {
        pendingRefs.set(local.rowId, {
          upstreamIds: 'upstreamIds' in merge.remoteWins ? remote.fields.upstreamIds : undefined,
          tagIds: 'tagIds' in merge.remoteWins ? remote.fields.tagIds : undefined,
        })
      }
      const mergedRow = await getUnitRow(kind, local.rowId)
      const mergedHash = mergedRow
        ? await sha256Hex(unitPayload(kind, mergedRow, await loadRefMaps()))
        : entry.hash
      await db.entitySyncMeta.put({
        id,
        lastPushedHash: mergedHash,
        fileId: entry.fileId,
      })
      result.pulled += 1
    }
    // Merge resolved entirely to local content: push phase uploads it.
  }

  // --- Local deletes pending propagation: tombstone the cloud copy.
  const pendingDeletes = await db.deletedEntities.toArray()
  for (const pending of pendingDeletes) {
    const entry = index.entries[pending.id]
    if (!entry) {
      // Nothing in the cloud (never pushed, or opt-out already cleaned it).
      await db.deletedEntities.delete(pending.id)
      continue
    }
    // A newer cloud edit beats an older local delete: give up the tombstone.
    if (entry.updatedAt > pending.deletedAt && !entry.deletedAt) {
      await db.deletedEntities.delete(pending.id)
      continue
    }
    index.entries[pending.id] = { ...entry, deletedAt: pending.deletedAt }
    try {
      await adapter.deleteFile(entry.fileId)
    } catch {
      // Already gone.
    }
    await db.deletedEntities.delete(pending.id)
    result.deleted += 1
  }

  // Rows inserted earlier in this pass may reference tags/cards that only
  // landed later (index order is arbitrary). Re-resolve the cloud refs now
  // that every row exists; otherwise the partial local row would push back
  // and clobber the cloud links.
  if (pendingRefs.size > 0) {
    const healRefs = await loadRefMaps()
    for (const [rowId, raw] of pendingRefs) {
      const row = await db.cards.get(rowId)
      if (!row) continue
      const patch: Partial<Card> = {}
      if (raw.upstreamIds !== undefined) {
        const healed = [...new Set([...row.upstreamIds, ...asRefArray(raw.upstreamIds, healRefs.cardIdByUid)])]
        if (healed.length !== row.upstreamIds.length) patch.upstreamIds = healed
      }
      if (raw.tagIds !== undefined) {
        const healed = [...new Set([...row.tagIds, ...asRefArray(raw.tagIds, healRefs.tagIdByUid)])]
        if (healed.length !== row.tagIds.length) patch.tagIds = healed
      }
      if (Object.keys(patch).length > 0) await db.cards.update(rowId, patch)
    }
  }

  // --- Push phase: units flagged cloudSynced.
  // Re-read state: the pull phase may have persisted merged rows and stamped
  // meta. Iterating the pre-pull snapshot here would resurrect stale content
  // and clobber remote-won fields in the freshly written cloud file.
  const [pushUnits, pushMetas, pushRefs] = await Promise.all([
    loadLocalUnits(),
    db.entitySyncMeta.toArray(),
    loadRefMaps(),
  ])
  const pushMetaById = new Map(pushMetas.map((m) => [m.id, m]))
  for (const unit of pushUnits) {
    const meta = pushMetaById.get(unit.id)
    const hash = await sha256Hex(unitPayload(unit.kind, unit.row, pushRefs))
    const entry = index.entries[unit.id]

    // The cloud index is the source of truth for file identity: if it
    // disagrees with local meta (other device re-created or removed the
    // file), adopt the index's fileId.
    const knownFileId = entry?.fileId ?? meta?.fileId

    // Skip only when the local content hash matches BOTH the last push we
    // recorded AND the index's current hash. entry.hash must be checked too:
    // a hybrid merge during the pull phase stamps meta with the merged hash
    // while the index still holds the old remote hash — without that check
    // the push would skip and the merged content would never reach the
    // cloud (it only healed if another device pushed later).
    if (
      meta?.lastPushedHash === hash &&
      entry &&
      entry.hash === hash &&
      entry.fileId === knownFileId
    ) {
      continue // unchanged since last push — skip upload entirely
    }

    // id-suffixed filename: renames never collide, ids stay traceable.
    const fileName = syncFileName(unit.kind, unit.row)
    const fileId = await adapter.uploadFile(
      fileName,
      cloudDoc(unit.kind, unit.row, pushRefs),
      knownFileId,
    )
    index.entries[unit.id] = {
      id: unit.id,
      fileId,
      hash,
      name: fileName,
      updatedAt: unit.updatedAt,
    }
    await db.entitySyncMeta.put({
      id: unit.id,
      lastPushedHash: hash,
      fileId,
    })
    result.pushed += 1
  }
}

function splitUnitId(id: string): [UnitKind, string] {
  const [kind, rest] = id.split(':')
  if ((kind !== 'workspace' && kind !== 'board' && kind !== 'card' && kind !== 'tag') || !rest) {
    throw new Error(`Unknown sync unit id: ${id}`)
  }
  return [kind, rest]
}

function unitId(kind: UnitKind, uid: string): string {
  return `${kind}:${uid}`
}

/** Pulled a child (card/tag) whose board row does not exist locally yet. */
class OrphanedUnitError extends Error {
  constructor() {
    super('Pulled a unit whose board is missing locally.')
  }
}

function parseCloudDoc(json: string): CloudUnitDoc {
  const parsed = JSON.parse(json) as Partial<CloudUnitDoc>
  if (typeof parsed.fields !== 'object' || parsed.fields === null) {
    throw new Error('Synced unit file is malformed.')
  }
  return { fields: parsed.fields, ts: parsed.ts ?? {}, rowTs: parsed.rowTs ?? 0 }
}

/**
 * LWW merge: per mergeable field, later `ts[field]` wins; ties go to remote
 * (deterministic across devices). A side missing a stamp for the field falls
 * back to its rowTs.
 */
interface UnitMerge {
  stamps: Record<string, number>
  rowTs: number
  /** Remote-won field values (raw, uid-keyed). */
  remoteWins: Record<string, unknown>
  changed: boolean
}

function mergeUnit(local: LocalUnit, kind: UnitKind, remote: CloudUnitDoc, entryUpdatedAt: number): UnitMerge {
  const localTs = local.row.fieldTimestamps ?? {}
  const localRowTs = local.row.updatedAt ?? local.row.createdAt
  const remoteRowTs = remote.rowTs || entryUpdatedAt
  const stamps: Record<string, number> = {}
  const remoteWins: Record<string, unknown> = {}
  let changed = false

  for (const field of MERGEABLE_FIELDS[kind]) {
    const lt = localTs[field] ?? localRowTs
    const rt = remote.ts[field] ?? remoteRowTs
    stamps[field] = Math.max(lt, rt)
    const localValue = (local.row as unknown as Record<string, unknown>)[field]
    // A local row that lost a field (older cloud docs omitted it) always
    // adopts the remote value, regardless of stamps.
    if (rt >= lt || (localValue === undefined && remote.fields[field] !== undefined)) {
      remoteWins[field] = remote.fields[field]
      if (JSON.stringify(remote.fields[field]) !== JSON.stringify(localValue)) {
        changed = true
      }
    }
  }
  // `changed` already covers remote-won-with-different-value. A tie on equal
  // values means identical content — no local write, no pulled tick.
  return { stamps, rowTs: Math.max(localRowTs, remoteRowTs), remoteWins, changed }
}

/** Persist merged fields + stamps onto the local row. */
async function updateUnitRow(
  kind: UnitKind,
  rowId: number,
  merge: UnitMerge,
): Promise<void> {
  const refs = await loadRefMaps()
  const patch: Record<string, unknown> = {}
  for (const [field, rawValue] of Object.entries(merge.remoteWins)) {
    // Docs written by older builds omit fields entirely; undefined must not
    // blank the local value on a merge.
    if (rawValue === undefined) continue
    if (field === 'boardId') patch[field] = refIn(refs.boardIdByUid, rawValue)
    else if (field === 'workspaceId') patch[field] = refIn(refs.workspaceIdByUid, rawValue)
    else if (field === 'upstreamIds') patch[field] = asRefArray(rawValue, refs.cardIdByUid)
    else if (field === 'tagIds') patch[field] = asRefArray(rawValue, refs.tagIdByUid)
    else patch[field] = rawValue
  }
  patch.fieldTimestamps = merge.stamps
  patch.updatedAt = merge.rowTs
  const table =
    kind === 'workspace' ? db.workspaces : kind === 'board' ? db.boards : kind === 'card' ? db.cards : db.tags
  await table.update(rowId, patch as never)
}

async function getUnitRow(kind: UnitKind, rowId: number): Promise<BoardRow | Card | Tag | Workspace | undefined> {
  if (kind === 'workspace') return db.workspaces.get(rowId)
  if (kind === 'board') return db.boards.get(rowId)
  if (kind === 'card') return db.cards.get(rowId)
  return db.tags.get(rowId)
}

/** Insert a locally-missing row from its cloud doc (Dexie mints the local id). */
async function putUnitRow(
  kind: UnitKind,
  uid: string,
  json: string,
  entryUpdatedAt: number,
): Promise<{ id: number; fields: Record<string, unknown> }> {
  const doc = parseCloudDoc(json)
  const refs = await loadRefMaps()
  const fields = doc.fields
  const fallbackCreated = doc.rowTs || entryUpdatedAt || Date.now()
  const boardId = refIn(refs.boardIdByUid, fields.boardId)
  // Workspaces have no board parent; cards and tags must not outlive theirs.
  if (kind !== 'board' && kind !== 'workspace' && boardId === null) throw new OrphanedUnitError()

  if (kind === 'workspace') {
    const row: Omit<Workspace, 'id'> = {
      uid,
      name: typeof fields.name === 'string' ? fields.name : 'Workspace',
      order: Number(fields.order ?? 0),
      createdAt: fallbackCreated,
      updatedAt: doc.rowTs || entryUpdatedAt,
      fieldTimestamps: doc.ts,
    }
    return { id: (await db.workspaces.add(row as Workspace))!, fields }
  }
  if (kind === 'board') {
    const row: Omit<BoardRow, 'id'> = {
      uid,
      name: typeof fields.name === 'string' ? fields.name : 'Untitled',
      workspaceId: refIn(refs.workspaceIdByUid, fields.workspaceId),
      sidebarOrder: Number(fields.sidebarOrder ?? 0),
      columns: Array.isArray(fields.columns) ? (fields.columns as BoardRow['columns']) : [],
      archiveCutoff: Number(fields.archiveCutoff ?? 0) || 0,
      createdAt: fallbackCreated,
      updatedAt: doc.rowTs || entryUpdatedAt,
      fieldTimestamps: doc.ts,
    }
    return { id: (await db.boards.add(row as BoardRow))!, fields }
  }
  if (kind === 'card') {
    const row: Omit<Card, 'id'> = {
      uid,
      boardId: boardId as number,
      column: typeof fields.column === 'string' ? fields.column : 'todo',
      title: typeof fields.title === 'string' ? fields.title : 'Untitled',
      order: Number(fields.order ?? 0),
      upstreamIds: asRefArray(fields.upstreamIds, refs.cardIdByUid),
      tagIds: asRefArray(fields.tagIds, refs.tagIdByUid),
      completedAt: typeof fields.completedAt === 'number' ? fields.completedAt : null,
      createdAt: fallbackCreated,
      updatedAt: doc.rowTs || entryUpdatedAt,
      fieldTimestamps: doc.ts,
    }
    return { id: (await db.cards.add(row as Card))!, fields }
  }
  const row: Omit<Tag, 'id'> = {
    uid,
    boardId: boardId as number,
    name: typeof fields.name === 'string' ? fields.name : 'tag',
    color: typeof fields.color === 'string' ? fields.color : 'bg-sky-600 dark:bg-sky-400',
    createdAt: fallbackCreated,
    updatedAt: doc.rowTs || entryUpdatedAt,
    fieldTimestamps: doc.ts,
  }
  return { id: (await db.tags.add(row as Tag))!, fields }
}

/** Cloud doc for a unit's row: mergeable fields with uid-translated FKs. */
function cloudDoc(kind: UnitKind, row: BoardRow | Card | Tag | Workspace, refs: RefMaps): string {
  const raw = row as unknown as Record<string, unknown>
  const fields: Record<string, unknown> = {}
  for (const field of MERGEABLE_FIELDS[kind]) {
    if (field === 'boardId') fields[field] = refOut(refs.boardUidById, raw[field])
    else if (field === 'workspaceId') fields[field] = refOut(refs.workspaceUidById, raw[field])
    else if (field === 'upstreamIds') fields[field] = Array.isArray(raw[field]) ? (raw[field] as number[]).map((id) => refOut(refs.cardUidById, id)) : []
    else if (field === 'tagIds') fields[field] = Array.isArray(raw[field]) ? (raw[field] as number[]).map((id) => refOut(refs.tagUidById, id)) : []
    else fields[field] = raw[field]
  }
  const stamps = row.fieldTimestamps ?? {}
  const ts: Record<string, number> = {}
  for (const field of MERGEABLE_FIELDS[kind]) ts[field] = stamps[field] ?? row.updatedAt ?? row.createdAt
  const doc: CloudUnitDoc = { fields, ts, rowTs: row.updatedAt ?? row.createdAt }
  return JSON.stringify(doc)
}

function syncFileName(kind: UnitKind, row: BoardRow | Card | Tag | Workspace): string {
  const raw = row as unknown as Record<string, unknown>
  const label = sanitizeFilename(String(raw.name ?? raw.title ?? kind))
  const numericId = kind === 'card' ? (row as Card).id : row.id ?? 0
  return `${label}.${row.uid.slice(0, 8)}.${numericId}.${kind}.json`
}

function sanitizeFilename(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? 'unit' : slug
}

/**
 * Delete a row (by uid) locally, cascading device-local references:
 * board → its cards + tags; card → other cards' upstreamIds; tag → cards' tagIds.
 */
async function deleteUnitRow(kind: UnitKind, uid: string): Promise<void> {
  if (kind === 'workspace') {
    const workspace = await db.workspaces.where('uid').equals(uid).first()
    if (!workspace?.id) return
    await db.transaction('rw', db.boards, db.workspaces, async () => {
      await db.boards
        .where('workspaceId')
        .equals(workspace.id!)
        .modify({ workspaceId: null })
      await db.workspaces.delete(workspace.id!)
    })
  } else if (kind === 'board') {
    const board = await db.boards.where('uid').equals(uid).first()
    if (!board?.id) return
    await db.transaction('rw', db.boards, db.cards, db.tags, async () => {
      await db.cards.where('boardId').equals(board.id!).delete()
      await db.tags.where('boardId').equals(board.id!).delete()
      await db.boards.delete(board.id!)
    })
  } else if (kind === 'card') {
    const card = await db.cards.where('uid').equals(uid).first()
    if (!card) return
    await db.transaction('rw', db.cards, async () => {
      const affected = await db.cards.filter((c) => c.upstreamIds.includes(card.id)).toArray()
      await db.cards.delete(card.id)
      for (const c of affected) {
        await db.cards.update(c.id, { upstreamIds: c.upstreamIds.filter((u) => u !== card.id) })
      }
    })
  } else {
    const tag = await db.tags.where('uid').equals(uid).first()
    if (!tag?.id) return
    await db.transaction('rw', db.cards, db.tags, async () => {
      const affected = await db.cards.filter((c) => c.tagIds.includes(tag.id!)).toArray()
      await db.tags.delete(tag.id!)
      for (const c of affected) {
        await db.cards.update(c.id, { tagIds: c.tagIds.filter((t) => t !== tag.id!) })
      }
    })
  }
}

/** Delete all cloud files and local sync bookkeeping (keep boards local).
 * Only the ACTIVE source's backend is touched: switching providers orphans the
 * previous one's files and index (the stranded-provider switch warning covers
 * this) — unshareAll cannot clean what it can no longer see. */
export async function unshareAll(): Promise<void> {
  const adapter = activeAdapter()
  const { index, fileId: indexFileId } = await adapter.readIndex()
  for (const entry of Object.values(index.entries)) {
    if (!entry.deletedAt) {
      try {
        await adapter.deleteFile(entry.fileId)
      } catch {
        // Already gone.
      }
    }
  }
  if (indexFileId) await adapter.deleteFile(indexFileId)
  await db.entitySyncMeta.clear()
  await db.syncMeta.clear()
  await db.deletedEntities.clear()
}

export type { IndexEntry } from './wire'