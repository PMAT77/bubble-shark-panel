export interface WorkshopChunk { sha: string, size: number, offset?: number, compressedSize?: number }
export function sha1(data: Uint8Array): string
export function atomicCacheWrite(file: string, data: string | Uint8Array): void
export function fileMatches(file: string, size: number, hash: string, signal?: AbortSignal): Promise<boolean>
export class WorkshopChunkCache {
  constructor(root: string)
  filename(chunk: WorkshopChunk): string
  has(chunk: WorkshopChunk, signal?: AbortSignal): Promise<boolean>
  put(chunk: WorkshopChunk, bytes: Buffer): void
  seed(chunk: WorkshopChunk, file: string, offset: number, signal: AbortSignal): Promise<boolean>
}
export function pruneWorkshopCache(root: string, maxBytes?: number, now?: number): number
export class DownloadSlots {
  constructor(limit?: number)
  active: number
  limit: number
  run<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T>
}
