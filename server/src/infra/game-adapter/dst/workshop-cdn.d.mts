import type { WorkshopContentResult } from './workshop-worker'

export interface WorkshopContentInput {
  ids: string[]
  cacheRoot: string
  existingRoot?: string
  legacyCacheRoot?: string
  signal?: AbortSignal
  onEvent?: (event: any) => void
  httpProxy?: string
  noProxy?: string[]
  /** Steam SDK objects are confined to the isolated worker. */
  session?: any
}
export function createWorkshopSession(options: { cacheRoot: string, httpProxy?: string, noProxy?: string[] }): any
export function downloadWorkshopContent(input: WorkshopContentInput): Promise<WorkshopContentResult[]>
