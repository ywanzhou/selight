import type { Database } from 'better-sqlite3'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  createBatch,
  deleteBatch,
  getBatch,
  listBatches,
  renameBatch,
  touchBatch
} from './domain/batches'
import type { MediaRoots } from './media/resolve'
import { createFolder, listFolders, renameFolder } from './domain/folders'
import { counts, listPhotos } from './domain/photos'
import {
  assignToFolder,
  deleteFolderWithPhotos,
  moveToInbox,
  moveToTrash,
  restoreFromTrash
} from './domain/classify'
import { undoLastGroup } from './domain/actions'
import { importScanned, scanDirectory } from './scanner'
import { exportBatch as runExport } from './exporter'
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
  /** Background metadata enrichment (orientation/dimensions); main.ts wires the real service. */
  enrichment: {
    submit(ids: number[]): void
    stop(): void
  }
  /** Cache roots for best-effort thumbnail/preview cleanup when a batch is deleted. */
  mediaRoots: MediaRoots
  sessionStore: Pick<SessionStore, 'read' | 'write'>
  // Renderer push has no place in the pure factory: main.ts injects webContents.send,
  // contract tests inject a recording stub.
  onExportProgress: (done: number, total: number) => void
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
  const { db, thumbQueue, enrichment, mediaRoots, sessionStore, onExportProgress } = deps

  return {
    // ---- batches ----------------------------------------------------------
    async listBatches() {
      return listBatches(db)
    },

    async createBatch(name) {
      return createBatch(db, name)
    },

    async deleteBatch(batchId) {
      const photoIds = deleteBatch(db, batchId)
      // Best-effort cache cleanup: a locked or just-written file must not fail
      // the already-committed deletion. AUTOINCREMENT ids are never reused, so
      // any straggler is a harmless orphan covered by the cache-GC backlog.
      await Promise.all(
        photoIds.flatMap((id) => [
          fs.rm(path.join(mediaRoots.thumbDir, `${id}.jpg`), { force: true }).catch(() => undefined),
          fs
            .rm(path.join(mediaRoots.thumbDir, `${id}.jpg.placeholder`), { force: true })
            .catch(() => undefined),
          fs
            .rm(path.join(mediaRoots.previewDir, `${id}.jpg`), { force: true })
            .catch(() => undefined)
        ])
      )
      return photoIds.length
    },

    async renameBatch(batchId, name) {
      renameBatch(db, batchId, name)
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
      // fs-only discovery: no exiftool on the critical path; rows land with the
      // orientation DEFAULT 1 and NULL dimensions for the enrichment service.
      const { files, failures } = await scanDirectory(rootPath)
      const result = importScanned(db, batchId, sourceId, files)
      enrichment.submit(photoIdsForPaths(db, batchId, files.map((file) => file.absPath)))
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

    async unassign(photoIds) {
      return moveToInbox(db, photoIds)
    },

    async undo(batchId) {
      return undoLastGroup(db, batchId)
    },

    // ---- export -----------------------------------------------------------
    async exportBatch(batchId, outputDir) {
      return runExport(db, batchId, outputDir, onExportProgress)
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
