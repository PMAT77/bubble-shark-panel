import type { LookupFunction } from 'node:net'
import type { Writable } from 'node:stream'
import type { WorkshopChunk } from './workshop-cache.mjs'
export interface SteamByteOptions {
  signal?: AbortSignal
  proxy?: string
  host?: string
  maxBytes?: number
  onBytes?: (size: number) => void
  lookupAddress?: LookupFunction
  connectTimeoutMs?: number
  firstByteTimeoutMs?: number
  idleTimeoutMs?: number
  range?: { start: number, end: number, totalSize: number }
  output?: Writable
  redirects?: number
}
export interface SteamByteResponse { bytes: Buffer, receivedBytes: number, firstByteMs: number, elapsedMs: number, address?: string }
export function requestSteamBytes(url: string, options?: SteamByteOptions): Promise<SteamByteResponse>
export function unpackSteamContent(bytes: Buffer, maxBytes: number): Promise<Buffer>
export function retrySteamOperation<T>(action: () => Promise<T>, signal: AbortSignal): Promise<T>
export function steamContentRpc(client: any, method: string, input: object, signal?: AbortSignal): Promise<any>
export class WorkshopTransport {
  constructor(client: any, options?: { cacheRoot?: string, httpProxy?: string, noProxy?: string[], request?: typeof requestSteamBytes })
  health: Map<string, { cooldown?: number, updated: number, bytesPerMs?: number }>
  fetch<T = Buffer>(resource: string, signal: AbortSignal, options?: {
    manifest?: boolean, maxBytes?: number, onBytes?: (size: number) => void, validate?: (bytes: Buffer) => T | Promise<T>
  }): Promise<T>
  manifest(id: string, signal: AbortSignal): Promise<any>
  chunk(chunk: WorkshopChunk, signal: AbortSignal, onBytes?: (size: number) => void): Promise<Buffer>
  range(url: string, range: { start: number, end: number, totalSize: number }, signal: AbortSignal, output?: Writable, onBytes?: (size: number) => void): Promise<SteamByteResponse>
  save(): void
}
