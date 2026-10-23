import { archivedCardIds, db, type BoardRow, type Card, type Tag, type Workspace } from '@/lib/db'
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
  board: ['name', 'columns', 'archiveCutoff', 'archiveSpan', 'workspaceId', 'sidebarOrder'],
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

function toLocalUnit(kind: UnitKind, row: BoardRow | Card | Tag | Workspace): LocalUnit {
  const stamps = row.fieldTimestamps ?? {}
  const rowTs = row.updatedAt ?? row.createdAt
  const stampValues = MERGEABLE_FIELDS[kind].map((field) => stamps[field] ?? rowTs)
  return {
    id: unitId(kind, row.uid),
    kind,
    rowId: kind === 'card' ? (row as Card).id : row.id ?? 0,
    stamps,
    rowTs,
    updatedAt: Math.max(rowTs, ...(stampValues.length ? stampValues : [0])),
    row,
  }
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
    units.push(toLocalUnit(kind, row))
  }
  for (const workspace of workspaces) addUnit('workspace', workspace)
  for (const board of boards) addUnit('board', board)
  for (const card of cards) addUnit('card', card)
  for (const tag of tags) addUnit('tag', tag)
  return units
}

/**
 * Bounded parallelism for backend calls. A full sync issues two round trips per
 * unit; on Drive that is 100–300 ms each, so the wall clock is all latency.
 * Local DB work stays sequential (and FK-ordered) outside these pools.
 */
const SYNC_CONCURRENCY = 4

async function runPool<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]
      await task(item)
    }
  })
  await Promise.all(workers)
}

/**
 * Two-way sync. Active bundles always travel; archive partitions only when the
 * user asks for them (`syncArchives`), so a board never waits on history.
 */
export async function syncAll(options: { archives?: boolean } = {}): Promise<SyncResult> {
  if (syncing) return { pushed: 0, pulled: 0, deleted: 0 }
  syncing = true
  try {
    const adapter = activeAdapter()

    const { index, fileId: indexFileId } = await adapter.readIndex()
    const result: SyncResult = { pushed: 0, pulled: 0, deleted: 0 }
    if ((index.version ?? 1) < BUNDLE_VERSION) await migrateLegacyIndex(adapter, index, result)
    await reconcileBundles(adapter, index, result, options.archives === true)

    const newIndexFileId = await adapter.writeIndex(index, indexFileId ?? undefined)
    await db.syncMeta.put({
      key: 'index',
      fileId: newIndexFileId,
      lastSyncedAt: new Date().toISOString(),
    })
    // Anything that touched rows may have changed what an open page shows.
    if (result.pushed || result.pulled || result.deleted) {
      for (const listener of syncAppliedListeners) listener(result)
    }
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
async function reconcileLegacy(
  adapter: SyncAdapter,
  index: DriveIndex,
  result: SyncResult,
  push = true,
): Promise<void> {
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
  // Fetch every unit we will need in parallel; the apply loop below stays
  // sequential (boards before their cards) but pays no per-unit round trip.
  const remoteJson = new Map<string, string>()
  await runPool(
    Object.entries(index.entries).filter(([id, entry]) => {
      if (entry.deletedAt) return false
      const local = localById.get(id)
      return !local || localHashById.get(id) !== entry.hash
    }),
    SYNC_CONCURRENCY,
    async ([id, entry]) => {
      try {
        remoteJson.set(id, await adapter.downloadFile(entry.fileId))
      } catch (error) {
        if (!adapter.isNotFound(error)) throw error
      }
    },
  )
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
      const json = remoteJson.get(id)
      if (json === undefined) {
        // Cloud file vanished (crash between deleteFile and writeIndex, or
        // manual deletion): nothing to pull. Clearing the index entry lets
        // the push phase re-create it from another device's copy.
        delete index.entries[id]
        continue
      }
      try {
        const inserted = await putUnitRow(kind, uid, parseCloudDoc(json), entry.updatedAt)
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
    const json = remoteJson.get(id)
    if (json === undefined) {
      // Cloud file gone: adopt local as the merge winner and let the push
      // phase re-create the file (uploadFile also self-heals stale ids).
      continue
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

  if (!push) return

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
  await runPool(pushUnits, SYNC_CONCURRENCY, async (unit) => {
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
      return // unchanged since last push — skip upload entirely
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
  })
}

/**
 * Bundle protocol (index version 2).
 *
 * One file per board instead of one per card: a board's tags + active cards
 * travel together, archived cards go to month partitions keyed by
 * `completedAt`, and everything else (workspaces, board rows) lives in two
 * small control bundles. A sync therefore costs one read per *changed* bundle
 * instead of two round trips per card.
 *
 * The file is a container only: each unit keeps its own `{fields, ts, rowTs}`
 * doc, so merges stay field-level LWW. Tombstones live in the index itself
 * (`index.graves`) — the index is always fetched, so a partition pulled later
 * can never resurrect a deleted card.
 */
const BUNDLE_VERSION = 2
const BUNDLE_WORKSPACES = 'bundle:workspaces'
const BUNDLE_BOARDS = 'bundle:boards'

interface BundleDoc {
  v: 2
  units: Record<string, CloudUnitDoc>
}

type BundleKind = 'workspaces' | 'boards' | 'board' | 'archive'

interface LocalBundle {
  id: string
  kind: BundleKind
  boardUid: string | null
  units: { id: string; kind: UnitKind; doc: CloudUnitDoc }[]
  json: string
  hash: string
  name: string
}

const boardBundleId = (boardUid: string) => `bundle:board:${boardUid}`
const archiveBundleId = (boardUid: string, month: string) => `bundle:archive:${boardUid}:${month}`

/** Partition key: immutable once written, so edits never move a card between files. */
function monthKey(completedAt: number | null | undefined): string {
  if (!completedAt) return 'unknown'
  const date = new Date(completedAt)
  if (Number.isNaN(date.getTime())) return 'unknown'
  return date.toISOString().slice(0, 7)
}

function bundleRank(id: string): number {
  if (id === BUNDLE_WORKSPACES) return 0
  if (id === BUNDLE_BOARDS) return 1
  if (id.startsWith('bundle:board:')) return 2
  return 3
}

async function makeBundle(
  id: string,
  kind: BundleKind,
  boardUid: string | null,
  units: LocalBundle['units'],
  name: string,
): Promise<LocalBundle> {
  // Deterministic key order → stable hashes across devices.
  const sorted = [...units].sort((a, b) => a.id.localeCompare(b.id))
  const map: Record<string, CloudUnitDoc> = {}
  for (const unit of sorted) map[unit.id] = unit.doc
  const json = JSON.stringify({ v: 2, units: map } satisfies BundleDoc)
  return { id, kind, boardUid, units: sorted, json, hash: await sha256Hex(json), name }
}

/** Every bundle this device would write, rebuilt from local state. */
async function buildLocalBundles(): Promise<LocalBundle[]> {
  const [boards, cards, tags, workspaces] = await Promise.all([
    db.boards.toArray(),
    db.cards.toArray(),
    db.tags.toArray(),
    db.workspaces.toArray(),
  ])
  const refs = await loadRefMaps()
  const bundles: LocalBundle[] = []

  if (workspaces.length) {
    bundles.push(
      await makeBundle(
        BUNDLE_WORKSPACES,
        'workspaces',
        null,
        workspaces.map((w) => ({ id: unitId('workspace', w.uid), kind: 'workspace' as const, doc: unitDoc('workspace', w, refs) })),
        'bundle-workspaces.json',
      ),
    )
  }
  if (boards.length) {
    bundles.push(
      await makeBundle(
        BUNDLE_BOARDS,
        'boards',
        null,
        boards.map((b) => ({ id: unitId('board', b.uid), kind: 'board' as const, doc: unitDoc('board', b, refs) })),
        'bundle-boards.json',
      ),
    )
  }

  const cardUnits = (list: Card[]): LocalBundle['units'] =>
    list.map((c) => ({ id: unitId('card', c.uid), kind: 'card' as const, doc: unitDoc('card', c, refs) }))

  for (const board of boards) {
    const boardId = board.id!
    const archived = archivedCardIds(board, cards)
    const tagsHere = tags.filter((t) => t.boardId === boardId)
    const active = cards.filter((c) => c.boardId === boardId && !archived.has(c.id))
    bundles.push(
      await makeBundle(
        boardBundleId(board.uid),
        'board',
        board.uid,
        [
          ...tagsHere.map((t) => ({ id: unitId('tag', t.uid), kind: 'tag' as const, doc: unitDoc('tag', t, refs) })),
          ...cardUnits(active),
        ],
        `bundle-board-${board.uid.slice(0, 8)}.json`,
      ),
    )
    const byMonth = new Map<string, Card[]>()
    for (const card of cards) {
      if (card.boardId !== boardId || !archived.has(card.id)) continue
      const key = monthKey(card.completedAt)
      const list = byMonth.get(key)
      if (list) list.push(card)
      else byMonth.set(key, [card])
    }
    for (const [month, list] of [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      bundles.push(
        await makeBundle(
          archiveBundleId(board.uid, month),
          'archive',
          board.uid,
          cardUnits(list),
          `archive-${board.uid.slice(0, 8)}-${month}.json`,
        ),
      )
    }
  }
  return bundles
}

/** Board uid a bundle id belongs to, or null for the global control bundles. */
function bundleBoardUid(id: string): string | null {
  if (id.startsWith('bundle:board:')) return id.slice('bundle:board:'.length)
  if (id.startsWith('bundle:archive:')) {
    const rest = id.slice('bundle:archive:'.length)
    const cut = rest.lastIndexOf(':')
    return cut === -1 ? rest : rest.slice(0, cut)
  }
  return null
}

async function healPendingRefs(
  pendingRefs: Map<number, { upstreamIds?: unknown; tagIds?: unknown }>,
): Promise<void> {
  if (pendingRefs.size === 0) return
  const refs = await loadRefMaps()
  for (const [rowId, raw] of pendingRefs) {
    const row = await db.cards.get(rowId)
    if (!row) continue
    const patch: Partial<Card> = {}
    if (raw.upstreamIds !== undefined) {
      const healed = [...new Set([...row.upstreamIds, ...asRefArray(raw.upstreamIds, refs.cardIdByUid)])]
      if (healed.length !== row.upstreamIds.length) patch.upstreamIds = healed
    }
    if (raw.tagIds !== undefined) {
      const healed = [...new Set([...row.tagIds, ...asRefArray(raw.tagIds, refs.tagIdByUid)])]
      if (healed.length !== row.tagIds.length) patch.tagIds = healed
    }
    if (Object.keys(patch).length > 0) await db.cards.update(rowId, patch)
  }
}

/** Merge one unit out of a pulled bundle into the local row. */
async function applyRemoteUnit(
  index: DriveIndex,
  kind: UnitKind,
  uid: string,
  doc: CloudUnitDoc,
  entryUpdatedAt: number,
  byUid: Record<UnitKind, Map<string, LocalUnit>>,
  pendingRefs: Map<number, { upstreamIds?: unknown; tagIds?: unknown }>,
  result: SyncResult,
): Promise<void> {
  const id = unitId(kind, uid)
  const grave = index.graves?.[id]
  if (grave !== undefined && grave >= (doc.rowTs || entryUpdatedAt)) return

  const local = byUid[kind].get(uid)
  if (!local) {
    if (await db.deletedEntities.get(id)) return
    try {
      const inserted = await putUnitRow(kind, uid, doc, entryUpdatedAt)
      if (kind === 'card') {
        pendingRefs.set(inserted.id, { upstreamIds: doc.fields.upstreamIds, tagIds: doc.fields.tagIds })
      }
      const row = await getUnitRow(kind, inserted.id)
      if (row) byUid[kind].set(uid, toLocalUnit(kind, row))
      result.pulled += 1
    } catch (error) {
      // Boards ship in the control bundle and are applied first, so an orphan
      // means the other device pushed a partial state; it heals next sync.
      if (error instanceof OrphanedUnitError) return
      throw error
    }
    return
  }

  const merge = mergeUnit(local, kind, doc, entryUpdatedAt)
  if (!merge.changed) return
  await updateUnitRow(kind, local.rowId, merge)
  if (kind === 'card') {
    pendingRefs.set(local.rowId, {
      upstreamIds: 'upstreamIds' in merge.remoteWins ? doc.fields.upstreamIds : undefined,
      tagIds: 'tagIds' in merge.remoteWins ? doc.fields.tagIds : undefined,
    })
  }
  const row = await getUnitRow(kind, local.rowId)
  if (row) byUid[kind].set(uid, toLocalUnit(kind, row))
  result.pulled += 1
}

async function reconcileBundles(
  adapter: SyncAdapter,
  index: DriveIndex,
  result: SyncResult,
  pullArchives: boolean,
): Promise<void> {
  index.graves ??= {}
  // Local deletes become shared tombstones before anything else is applied.
  for (const pending of await db.deletedEntities.toArray()) {
    index.graves[pending.id] = Math.max(index.graves[pending.id] ?? 0, pending.deletedAt)
    await db.deletedEntities.delete(pending.id)
  }

  const byUid: Record<UnitKind, Map<string, LocalUnit>> = {
    workspace: new Map(),
    board: new Map(),
    card: new Map(),
    tag: new Map(),
  }
  for (const unit of await loadLocalUnits()) byUid[unit.kind].set(unit.id.slice(unit.kind.length + 1), unit)

  // Tombstones first: a delete that lost the race is re-applied, an edit that
  // is newer than the grave survives and will be pushed back.
  for (const [id, deletedAt] of Object.entries(index.graves)) {
    const [kind, uid] = id.split(':') as [UnitKind, string]
    if (!byUid[kind]) continue
    const local = byUid[kind].get(uid)
    if (!local) continue
    if (deletedAt < local.updatedAt) continue
    await deleteUnitRow(kind, uid)
    byUid[kind].delete(uid)
    result.deleted += 1
  }

  const localHashes = new Map((await buildLocalBundles()).map((bundle) => [bundle.id, bundle.hash]))
  const toPull = Object.entries(index.entries)
    .filter(([id, entry]) => {
      if (!id.startsWith('bundle:') || entry.deletedAt) return false
      // Archives are pulled on demand: their partitions can be large and a
      // board must not wait for history it may never open.
      if (!pullArchives && id.startsWith('bundle:archive:')) return false
      return entry.hash !== localHashes.get(id)
    })
    .sort(([a], [b]) => bundleRank(a) - bundleRank(b))

  const bodies = new Map<string, string>()
  await runPool(toPull, SYNC_CONCURRENCY, async ([id, entry]) => {
    try {
      bodies.set(id, await adapter.downloadFile(entry.fileId))
    } catch (error) {
      if (!adapter.isNotFound(error)) throw error
    }
  })

  const pendingRefs = new Map<number, { upstreamIds?: unknown; tagIds?: unknown }>()
  for (const [id, entry] of toPull) {
    const json = bodies.get(id)
    if (json === undefined) {
      delete index.entries[id]
      continue
    }
    let bundleDoc: BundleDoc
    try {
      bundleDoc = JSON.parse(json) as BundleDoc
    } catch {
      continue // unreadable bundle: the push phase overwrites it from local state
    }
    if (!bundleDoc?.units) continue
    for (const [id, unit] of Object.entries(bundleDoc.units)) {
      const [kind, uid] = id.split(':') as [UnitKind, string]
      if (!byUid[kind]) continue
      await applyRemoteUnit(index, kind, uid, unit, entry.updatedAt, byUid, pendingRefs, result)
    }
  }
  await healPendingRefs(pendingRefs)

  // Push: rebuild from post-pull state so a merge is never masked by a stale hash.
  const bundles = await buildLocalBundles()
  await runPool(bundles, SYNC_CONCURRENCY, async (bundle) => {
    const entry = index.entries[bundle.id]
    if (entry && entry.hash === bundle.hash && !entry.deletedAt) return
    // A partition we have not pulled yet may hold another device's archives;
    // uploading now would overwrite them. Wait for an explicit archive sync.
    if (!pullArchives && bundle.kind === 'archive' && entry && !entry.deletedAt) return
    const fileId = await adapter.uploadFile(bundle.name, bundle.json, entry?.fileId)
    index.entries[bundle.id] = {
      id: bundle.id,
      fileId,
      hash: bundle.hash,
      name: bundle.name,
      updatedAt: Date.now(),
    }
    result.pushed += 1
  })

  // Bundles we no longer produce: a deleted board, or a partition whose cards
  // were unarchived/re-bucketed. Skip boards this device has never seen — the
  // pull may simply not have reached them yet.
  const keep = new Set(bundles.map((bundle) => bundle.id))
  for (const [id, entry] of Object.entries(index.entries)) {
    if (!id.startsWith('bundle:') || keep.has(id)) continue
    // Without an archive pull we cannot tell an empty partition from one this
    // device never fetched — leave archive files alone until then.
    if (!pullArchives && id.startsWith('bundle:archive:')) continue
    const boardUid = bundleBoardUid(id)
    if (boardUid !== null && !byUid.board.has(boardUid)) continue
    try {
      await adapter.deleteFile(entry.fileId)
    } catch {
      // Already gone.
    }
    delete index.entries[id]
    result.deleted += 1
  }
}

/** Notified after a sync that actually changed local rows (pulls, pushes, deletes). */
type SyncAppliedListener = (result: SyncResult) => void
const syncAppliedListeners = new Set<SyncAppliedListener>()

export function subscribeSyncApplied(listener: SyncAppliedListener): () => void {
  syncAppliedListeners.add(listener)
  return () => {
    syncAppliedListeners.delete(listener)
  }
}

/** Explicit archive fetch: check every partition's hash, download the stale ones. */
export async function syncArchives(): Promise<SyncResult> {
  return syncAll({ archives: true })
}

/** Fold the v1 one-file-per-unit layout into bundles, deleting the old files. */
async function migrateLegacyIndex(
  adapter: SyncAdapter,
  index: DriveIndex,
  result: SyncResult,
): Promise<void> {
  // Pull v1 units only: local state reaches the cloud through bundles below.
  // Snapshot tombstones first — the legacy pull consumes them.
  const tombstones = await db.deletedEntities.toArray()
  await reconcileLegacy(adapter, index, result, false)

  index.graves ??= {}
  for (const pending of tombstones) {
    index.graves[pending.id] = Math.max(index.graves[pending.id] ?? 0, pending.deletedAt)
  }
  const legacy = Object.entries(index.entries).filter(([id]) => !id.startsWith('bundle:'))
  await runPool(legacy, SYNC_CONCURRENCY, async ([id, entry]) => {
    if (entry.deletedAt) {
      index.graves![id] = Math.max(index.graves![id] ?? 0, entry.deletedAt)
      return
    }
    try {
      await adapter.deleteFile(entry.fileId)
    } catch {
      // Already gone.
    }
  })
  for (const [id] of legacy) delete index.entries[id]
  await db.entitySyncMeta.clear()
  await db.deletedEntities.clear()
  index.version = BUNDLE_VERSION
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
  doc: CloudUnitDoc,
  entryUpdatedAt: number,
): Promise<{ id: number; fields: Record<string, unknown> }> {
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
      archiveSpan: fields.archiveSpan == null ? null : Number(fields.archiveSpan),
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
function unitDoc(kind: UnitKind, row: BoardRow | Card | Tag | Workspace, refs: RefMaps): CloudUnitDoc {
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
  return { fields, ts, rowTs: row.updatedAt ?? row.createdAt }
}

function cloudDoc(kind: UnitKind, row: BoardRow | Card | Tag | Workspace, refs: RefMaps): string {
  return JSON.stringify(unitDoc(kind, row, refs))
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