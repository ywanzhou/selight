import type { Database } from 'better-sqlite3'
import { createBatch, getBatch, listBatches, touchBatch } from './domain/batches'
import { createFolder, listFolders, renameFolder } from './domain/folders'
import { counts, listPhotos } from './domain/photos'
import {
  assignToFolder,
  deleteFolderWithPhotos,
  moveToTrash,
  restoreFromTrash
} from './domain/classify'
import { undoLastGroup } from './domain/actions'
import { importScanned, scanDirectory, type ExifReader } from './scanner'
import type { MediaQueue } from './media/queue'
import type { SessionStore } from './session'
import type {
  BatchState,
  ImportResult,
  SelightHandlers,
  SessionState
} from './shared/api'

// No electron import in this file: every dependency is injected so the whole handler
// contract runs under bare Node in tests/ipc.contract.test.ts. Domain errors are never
// wrapped here, so their .name (FolderNameConflictError, MixedBatchError, …) reaches the
// renderer intact for branching.
export interface HandlerDeps {
  db: Database
  thumbQueue: Pick<MediaQueue, 'enqueue' | 'prioritize'>
  exifReader: ExifReader
  sessionStore: Pick<SessionStore, 'read' | 'write'>
}

// 500 bound variables per statement, matching the scanner/photos chunking and staying
// far below SQLite's 32766 parameter limit.
const ID_CHUNK = 500

// Reuse the (batch_id, abs_path) source row on re-import; the unique index
// idx_sources_batch_path is the backing guarantee against duplicates.
function upsertSource(db: Database, batchId: number, absPath: string): number {
  const existing = db
    .prepare('SELECT id FROM sources WHERE batch_id = ? AND abs_path = ?')
    .get(batchId, absPath) as { id: number } | undefined
  if (existing) {
    db.prepare('UPDATE sources SET last_scan_at = ? WHERE id = ?').run(
      Date.now(),
      existing.id
    )
    return existing.id
  }
  const info = db
    .prepare('INSERT INTO sources (batch_id, abs_path, last_scan_at) VALUES (?, ?, ?)')
    .run(batchId, absPath, Date.now())
  return Number(info.lastInsertRowid)
}

// Resolve the just-imported scans back to their photo ids, chunked to keep the IN clause
// within the bind limit. importScanned upserted exactly these (batch_id, abs_path) rows.
function photoIdsForPaths(db: Database, batchId: number, paths: string[]): number[] {
  const ids: number[] = []
  for (let i = 0; i < paths.length; i += ID_CHUNK) {
    const slice = paths.slice(i, i + ID_CHUNK)
    const rows = db
      .prepare(
        `SELECT id FROM photos WHERE batch_id = ? AND abs_path IN (${slice
          .map(() => '?')
          .join(', ')})`
      )
      .all(batchId, ...slice) as { id: number }[]
    ids.push(...rows.map((row) => row.id))
  }
  return ids
}

export function createHandlers(deps: HandlerDeps): SelightHandlers {
  const { db, thumbQueue, exifReader, sessionStore } = deps

  return {
    // ---- batches ----------------------------------------------------------
    async listBatches() {
      return listBatches(db)
    },

    async createBatch(name) {
      return createBatch(db, name)
    },

    async openBatch(batchId) {
      touchBatch(db, batchId)
      const batch = getBatch(db, batchId)
      if (!batch) throw new Error(`batch not found: ${batchId}`)
      const state: BatchState = {
        batch,
        folders: listFolders(db, batchId),
        counts: counts(db, batchId),
        photos: listPhotos(db, batchId, { kind: 'inbox' })
      }
      return state
    },

    // ---- folders ----------------------------------------------------------
    async listFolders(batchId) {
      return listFolders(db, batchId)
    },

    async createFolder(batchId, name) {
      return createFolder(db, batchId, name)
    },

    async renameFolder(folderId, name) {
      renameFolder(db, folderId, name)
    },

    // Ruling: delete via deleteFolderWithPhotos so the move is one undoable action group.
    async deleteFolder(folderId) {
      return deleteFolderWithPhotos(db, folderId)
    },

    // ---- photos -----------------------------------------------------------
    async importDirectory(batchId, rootPath) {
      const sourceId = upsertSource(db, batchId, rootPath)
      const { files, failures } = await scanDirectory(rootPath, exifReader)
      const result = importScanned(db, batchId, sourceId, files)
      thumbQueue.enqueue(photoIdsForPaths(db, batchId, files.map((file) => file.absPath)))
      const out: ImportResult = { ...result, failures }
      return out
    },

    async listView(batchId, view) {
      return listPhotos(db, batchId, view)
    },

    async counts(batchId) {
      return counts(db, batchId)
    },

    // Pure URL construction; all filesystem authorization lives in the media protocol.
    async mediaUrl(photoId, kind) {
      return `selight://${kind}/${photoId}`
    },

    async markSelection(ids) {
      thumbQueue.prioritize(ids)
    },

    // ---- classification ---------------------------------------------------
    async assign(photoIds, folderId) {
      return assignToFolder(db, photoIds, folderId)
    },

    async trash(photoIds) {
      return moveToTrash(db, photoIds)
    },

    async restore(photoIds) {
      return restoreFromTrash(db, photoIds)
    },

    async undo(batchId) {
      return undoLastGroup(db, batchId)
    },

    // ---- session ----------------------------------------------------------
    async getSession(): Promise<SessionState | null> {
      return sessionStore.read()
    },

    async saveSession(state: SessionState): Promise<void> {
      sessionStore.write(state)
    }
  }
}
