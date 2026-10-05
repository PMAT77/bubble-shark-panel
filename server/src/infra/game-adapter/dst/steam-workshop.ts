import { readBrandEnv } from '../../../../../shared/brand-env'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { observeSteamAccess, observeSteamMarketCache } from './steam-access-observation'
import type {
  ModContentLocale,
  ModInstallStatus,
  ModLocalizedTextMap,
  SteamModDetailDto,
  SteamModListMeta,
  SteamModListQueryResult,
  SteamModSort,
  SteamModTrendDays,
  SteamModUpstreamSource,
} from '../../../../../shared/contracts/mod'
import {
  DEFAULT_MOD_CONTENT_LOCALE,
  resolveModLocalizedText,
} from '../../../../../shared/contracts/mod'
import {
  describeSteamProxy,
  isSteamWorkshopFetchError,
  resolveSteamProxyConfig,
  SteamWorkshopFetchError,
  steamHttpRequest,
} from './steam-http'

export { isSteamWorkshopFetchError, SteamWorkshopFetchError } from './steam-http'

/** DST 专用服务器 Mod 标签，与 Steam 创意工坊「server_only_mod」筛选一致 */
const DST_SERVER_ONLY_MOD_TAG = 'server_only_mod'

/**
 * 反代地址归一化：**必须以 `/` 结尾**才算作「带路径前缀」。
 *
 * 早先这里直接用 `new URL('/IPublishedFileService/...', base)`，前导斜杠会把反代的
 * 路径前缀整段吃掉（`https://proxy.example/steam` 会打到 `https://proxy.example/...`）。
 */
function normalizeBaseUrl(raw: string, fallback: string): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    return fallback
  }
  try {
    const parsed = new URL(trimmed)
    const pathname = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`
    return `${parsed.origin}${pathname}${parsed.search}`
  }
  catch {
    return fallback
  }
}

const STEAM_API_BASE_URL = normalizeBaseUrl(
  readBrandEnv('BSP_STEAM_WEBAPI_BASE_URL') ?? '',
  'https://api.steampowered.com/',
)
const WORKSHOP_BROWSE_URL = normalizeBaseUrl(
  readBrandEnv('BSP_STEAM_COMMUNITY_BASE_URL') ?? '',
  'https://steamcommunity.com/',
)
const STEAM_WEBAPI_KEY = readBrandEnv('BSP_STEAM_WEBAPI_KEY')?.trim() || ''
const STEAM_RELAY_URL = readBrandEnv('BSP_STEAM_RELAY_URL')?.trim() || ''
const STEAM_RELAY_TOKEN = readBrandEnv('BSP_STEAM_RELAY_TOKEN')?.trim() || ''
const IS_UNIT_TEST = readBrandEnv('BSP_UNIT_TEST') === '1'
const FETCH_TIMEOUT_MS = readPositiveIntEnv('BSP_STEAM_WORKSHOP_FETCH_TIMEOUT_MS', 12_000)
const FETCH_RETRY_TIMES = readPositiveIntEnv('BSP_STEAM_WORKSHOP_FETCH_RETRY_TIMES', 2)
const FETCH_RETRY_BASE_DELAY_MS = readPositiveIntEnv('BSP_STEAM_WORKSHOP_FETCH_RETRY_BASE_DELAY_MS', 300)
/**
 * 按源拆分的超时。
 *
 * 官方 API 与 relay 都是小 JSON，3～5 秒足够；创意工坊列表页是整页 HTML，给宽一点。
 * 一个源失败之后，后面的源用 FAST_FAIL 超时且只试一次——被墙时「快速拿到一个能渲染的
 * 结果」比「多试几次」重要得多。
 */
const OFFICIAL_TIMEOUT_MS = readPositiveIntEnv('BSP_STEAM_WORKSHOP_OFFICIAL_TIMEOUT_MS', 5_000)
const RELAY_TIMEOUT_MS = readPositiveIntEnv('BSP_STEAM_WORKSHOP_RELAY_TIMEOUT_MS', 5_000)
const FAST_FAIL_TIMEOUT_MS = readPositiveIntEnv('BSP_STEAM_WORKSHOP_FAST_FAIL_TIMEOUT_MS', 3_500)
/** 单次列表拉取的总预算：耗尽即降到缓存/离线兜底，不再继续等上游 */
const TOTAL_BUDGET_MS = readPositiveIntEnv('BSP_STEAM_WORKSHOP_TOTAL_BUDGET_MS', 10_000)
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 50
const DEFAULT_SORT: SteamModSort = 'trend'
const DEFAULT_TREND_DAYS: SteamModTrendDays = 7
const CACHE_TTL_MS = readPositiveIntEnv('BSP_STEAM_WORKSHOP_CACHE_TTL_MS', 2 * 60 * 1000)
const STALE_CACHE_TTL_MS = readPositiveIntEnv('BSP_STEAM_WORKSHOP_STALE_TTL_MS', 30 * 60 * 1000)
/**
 * 离线缓存窗口：Steam 完全不可达时还能退回多久以前的那份列表。
 *
 * 与 `STALE_CACHE_TTL_MS` 的区别是「要不要立刻刷新」和「有没有内容可看」：
 * 30 分钟的 stale 窗口内会顺手后台刷新；超过之后就只剩这份离线数据，
 * 面板照常把列表渲染出来并标注「离线数据」，而不是白屏。
 */
const OFFLINE_CACHE_TTL_MS = readPositiveIntEnv(
  'BSP_STEAM_WORKSHOP_OFFLINE_TTL_MS',
  7 * 24 * 60 * 60 * 1000,
)
const WORKSHOP_DETAIL_CACHE_TTL_MS = readPositiveIntEnv('BSP_STEAM_WORKSHOP_DETAIL_CACHE_TTL_MS', 5 * 60 * 1000)
const WORKSHOP_RATING_CACHE_TTL_MS = readPositiveIntEnv('BSP_STEAM_WORKSHOP_RATING_CACHE_TTL_MS', 10 * 60 * 1000)
/** Mod 元数据（标题/缩略图/版本时间）缓存：版本检测与名称补全共用同一份响应 */
const WORKSHOP_METADATA_CACHE_TTL_MS = readPositiveIntEnv('BSP_STEAM_WORKSHOP_METADATA_CACHE_TTL_MS', 10 * 60 * 1000)
/** GetPublishedFileDetails 单次请求的 ID 上限，超过则分批串行 */
const WORKSHOP_METADATA_BATCH_SIZE = readPositiveIntEnv('BSP_STEAM_WORKSHOP_METADATA_BATCH_SIZE', 100)
/** 单次调用的分批上限，防止异常大的清单把请求拖成几十次串行 */
const WORKSHOP_METADATA_MAX_BATCHES = readPositiveIntEnv('BSP_STEAM_WORKSHOP_METADATA_MAX_BATCHES', 10)
const RATE_LIMIT_WINDOW_MS = readPositiveIntEnv('BSP_STEAM_WORKSHOP_RATE_LIMIT_WINDOW_MS', 1000)
const RATE_LIMIT_PER_KEY = IS_UNIT_TEST
  ? 100_000
  : readPositiveIntEnv('BSP_STEAM_WORKSHOP_RATE_LIMIT_PER_KEY', 2)
const RATE_LIMIT_GLOBAL = IS_UNIT_TEST
  ? 100_000
  : readPositiveIntEnv('BSP_STEAM_WORKSHOP_RATE_LIMIT_GLOBAL', 8)
const CIRCUIT_BREAKER_FAIL_THRESHOLD = IS_UNIT_TEST
  ? 100_000
  : readPositiveIntEnv('BSP_STEAM_WORKSHOP_CIRCUIT_FAIL_THRESHOLD', 6)
const CIRCUIT_BREAKER_OPEN_MS = readPositiveIntEnv('BSP_STEAM_WORKSHOP_CIRCUIT_OPEN_MS', 30 * 1000)
const SHOULD_DISABLE_DISK_CACHE = readBrandEnv('BSP_STEAM_WORKSHOP_DISABLE_DISK_CACHE') === '1'
  || process.env.NODE_ENV === 'test'
  || process.argv.includes('--test')
const DISK_CACHE_FILE = SHOULD_DISABLE_DISK_CACHE
  ? ''
  : readBrandEnv('BSP_STEAM_WORKSHOP_CACHE_FILE')?.trim()
      || path.resolve(process.cwd(), 'data', 'cache', 'steam-workshop-mod-cache.json')

interface SteamModRawItem {
  workshopId: string
  title: string
  previewImage: string | null
  detailUrl: string
  rating: number | null
}

interface SteamModRawResult {
  keyword: string
  page: number
  pageSize: number
  sort: SteamModSort
  trendDays: SteamModTrendDays
  hasMore: boolean
  totalCount: number | null
  totalPages: number | null
  sourceUrl: string
  upstreamSource: SteamModUpstreamSource
  items: SteamModRawItem[]
}

interface SteamModCacheEntry {
  refreshFailed?: boolean
  fetchedAt: number
  expiresAt: number
  staleExpiresAt: number
  /** 离线兜底窗口的截止时间；超过之后这份缓存才真正作废 */
  offlineExpiresAt: number
  data: SteamModRawResult
}

interface PersistedCachePayload {
  entries: Record<string, SteamModCacheEntry>
  details?: Record<string, { fetchedAt: number, schemaVersion: number, data: WorkshopDetailCacheData }>
}

interface NormalizedSteamQuery {
  keyword: string
  page: number
  requestedPageSize: number
  sort: SteamModSort
  trendDays: SteamModTrendDays
}

/**
 * 交给某个上游源的查询：除筛选条件外还带上这次调用允许花多久。
 *
 * 超时随对象传递而不是存在模块变量里——列表请求可能并发，用共享状态会让
 * 一个用户的失败影响另一个用户的超时预算。
 */
interface SourceQuery extends NormalizedSteamQuery {
  deadline?: number
  timeoutMs: number
  /** 已有一个源失败过：后续源不重试 */
  fastFail: boolean
}

interface SteamWorkshopSource {
  name: SteamModUpstreamSource
  enabled: boolean
  /** 该源的请求超时；失败过一次之后会改用 FAST_FAIL 超时 */
  timeoutMs: number
  /** 健康状态下允许的额外重试次数 */
  retryTimes: number
  queryMods: (query: SourceQuery) => Promise<SteamModRawResult>
}

/** 每个上游源各自的健康状态：一个源挂掉不该连坐其他源 */
interface SourceHealth {
  consecutiveFailures: number
  openUntil: number
  lastSuccessAt: number | null
}

/** 调用来源。后台预热/定时检查与用户前台请求分开统计，避免互相污染熔断计数 */
type SteamCallChannel = 'user' | 'background'

interface SteamVoteData {
  score?: number
  votes_up?: number
  votes_down?: number
}

interface SteamQueryFilesResponseItem {
  publishedfileid?: string
  title?: string
  preview_url?: string
  file_url?: string
  url?: string
  vote_data?: SteamVoteData
}

interface SteamQueryFilesResponse {
  response?: {
    total?: number
    numperpage?: number
    next_cursor?: string
    publishedfiledetails?: SteamQueryFilesResponseItem[]
  }
}

interface SteamFetchMetrics {
  steam_fetch_success_total: number
  steam_fetch_success_by_source: Record<SteamModUpstreamSource, number>
  steam_fetch_fail_total: Record<string, number>
  steam_fetch_fail_by_source: Record<SteamModUpstreamSource, number>
  steam_fetch_latency_ms: number[]
  steam_cache_hit_total: {
    fresh: number
    stale: number
    miss: number
  }
  steam_circuit_open_total: number
  steam_last_success_source: SteamModUpstreamSource | null
  steam_last_success_at: number | null
}

const CACHE_SCHEMA_VERSION = 10
const steamModCache = new Map<string, SteamModCacheEntry>()
const WORKSHOP_DETAIL_CACHE_SCHEMA = 3

interface WorkshopDetailCacheData {
  workshopId: string
  previewImage: string | null
  fileSize: number | null
  tags: string[]
  publishedAt: string | null
  updatedAt: string | null
  detailUrl: string
  creatorName: string | null
  titles: ModLocalizedTextMap
  descriptions: ModLocalizedTextMap
}

const workshopDetailCache = new Map<string, { fetchedAt: number, schemaVersion: number, data: WorkshopDetailCacheData }>()
const workshopRatingCache = new Map<string, { rating: number | null, expiresAt: number }>()
const steamModInFlight = new Map<string, Promise<SteamModRawResult>>()
const steamBackgroundRefreshing = new Set<string>()
const execFileAsync = promisify(execFile)
const perKeyRequestBuckets = new Map<string, number[]>()
const globalRequestBucket: number[] = []
const steamFetchMetrics: SteamFetchMetrics = {
  steam_fetch_success_total: 0,
  steam_fetch_success_by_source: {
    official: 0,
    relay: 0,
    html: 0,
  },
  steam_fetch_fail_total: {},
  steam_fetch_fail_by_source: {
    official: 0,
    relay: 0,
    html: 0,
  },
  steam_fetch_latency_ms: [],
  steam_cache_hit_total: {
    fresh: 0,
    stale: 0,
    miss: 0,
  },
  steam_circuit_open_total: 0,
  steam_last_success_source: null,
  steam_last_success_at: null,
}
const steamCircuitState = new Map<SteamModUpstreamSource, SourceHealth>()
let diskCacheLoaded = false
let diskPersistTimer: NodeJS.Timeout | null = null

function readPositiveIntEnv(key: string, fallback: number): number {
  const rawValue = readBrandEnv(key)
  if (!rawValue) {
    return fallback
  }
  const parsed = Number.parseInt(rawValue, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback
  }
  return parsed
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => {
      const value = Number.parseInt(String(code), 10)
      return Number.isFinite(value) ? String.fromCharCode(value) : ''
    })
}

function normalizePage(value: number | undefined): number {
  if (!Number.isInteger(value) || !value || value < 1) {
    return 1
  }
  return value
}

function normalizePageSize(value: number | undefined): number {
  if (!Number.isInteger(value) || !value || value < 1) {
    return DEFAULT_PAGE_SIZE
  }
  return Math.min(MAX_PAGE_SIZE, value)
}

function normalizeSort(value: string | undefined): SteamModSort {
  if (value === 'mostrecent' || value === 'totaluniquesubscribers' || value === 'relevance') {
    return value
  }
  return DEFAULT_SORT
}

function normalizeTrendDays(value: number | undefined): SteamModTrendDays {
  const accepted: SteamModTrendDays[] = [1, 7, 30, 90, 180, 365, -1]
  if (typeof value === 'number' && accepted.includes(value as SteamModTrendDays)) {
    return value as SteamModTrendDays
  }
  return DEFAULT_TREND_DAYS
}

function resolveBrowseSort(sort: SteamModSort): string {
  if (sort === 'relevance') {
    return 'textsearch'
  }
  return sort
}

function buildBrowseUrl(
  keyword: string,
  page: number,
  pageSize: number,
  sort: SteamModSort,
  trendDays: SteamModTrendDays,
): string {
  const browseSort = resolveBrowseSort(sort)
  const url = new URL('workshop/browse/', WORKSHOP_BROWSE_URL)
  url.searchParams.set('appid', '322330')
  url.searchParams.append('requiredtags[]', DST_SERVER_ONLY_MOD_TAG)
  url.searchParams.set('section', 'readytouseitems')
  url.searchParams.set('browsesort', browseSort)
  url.searchParams.set('actualsort', browseSort)
  if (sort === 'trend') {
    url.searchParams.set('days', String(trendDays))
  }
  url.searchParams.set('searchtext', keyword)
  url.searchParams.set('p', String(page))
  url.searchParams.set('numperpage', String(pageSize))
  return url.toString()
}

interface SsrWorkshopBrowseResult {
  publishedfileid?: string
  title?: string
  preview_url?: string
  score?: number
  star_rating?: number
  total_votes?: number
  vote_data?: SteamVoteData
}

interface SsrWorkshopBrowseData {
  current_page?: number
  total_pages?: number
  total_count?: number
  results?: SsrWorkshopBrowseResult[]
  next_cursor?: string
}

function decodeEmbeddedJsonParse(rawEscaped: string): unknown {
  return JSON.parse(JSON.parse(`"${rawEscaped}"`) as string)
}

function extractSsrWorkshopBrowseData(html: string): SsrWorkshopBrowseData | null {
  for (const match of html.matchAll(/JSON\.parse\("((?:\\.|[^"\\])*)"\)/g)) {
    try {
      const payload = decodeEmbeddedJsonParse(match[1]) as { queryData?: string }
      if (!payload.queryData) {
        continue
      }
      const queryData = JSON.parse(payload.queryData) as {
        queries?: Array<{ state?: { data?: SsrWorkshopBrowseData } }>
      }
      for (const query of queryData.queries ?? []) {
        const data = query.state?.data
        if (!data || !Array.isArray(data.results)) {
          continue
        }
        return data
      }
    }
    catch {
      // 尝试下一个 JSON.parse 块
    }
  }
  return null
}

function normalizeSteamRatingScore(score: unknown): number | null {
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    return null
  }
  const normalized = Math.min(1, Math.max(0, score))
  return Math.round(normalized * 50) / 10
}

function normalizePublishedFileVoteData(item: SteamQueryFilesResponseItem): SteamQueryFilesResponseItem {
  const voteDataRaw = (item as { vote_data?: unknown }).vote_data
  if (typeof voteDataRaw === 'string') {
    try {
      const parsed = JSON.parse(voteDataRaw) as SteamVoteData
      return { ...item, vote_data: parsed }
    }
    catch {
      return item
    }
  }
  return item
}

function resolveSsrStarRating(starRating: unknown): number | null {
  if (typeof starRating !== 'number' || !Number.isFinite(starRating)) {
    return null
  }
  if (starRating >= 1 && starRating <= 5) {
    return Math.round(starRating * 10) / 10
  }
  return null
}

function resolveItemRating(source: {
  vote_data?: SteamVoteData
  score?: number
  votes_up?: number
  votes_down?: number
  star_rating?: number
}): number | null {
  const ssrRating = resolveSsrStarRating(source.star_rating)
  if (ssrRating !== null) {
    return ssrRating
  }
  const voteData = source.vote_data
  if (typeof voteData?.score === 'number') {
    return normalizeSteamRatingScore(voteData.score)
  }
  if (typeof source.score === 'number') {
    return normalizeSteamRatingScore(source.score)
  }
  const votesUp = voteData?.votes_up ?? source.votes_up
  const votesDown = voteData?.votes_down ?? source.votes_down
  if (typeof votesUp === 'number' && typeof votesDown === 'number' && votesUp + votesDown > 0) {
    return normalizeSteamRatingScore((votesUp + 1) / (votesUp + votesDown + 2))
  }
  return null
}

function parseLegacyWorkshopItemRating(block: string): number | null {
  const tooltipMatch = block.match(/data-tooltip-html="([^"]+)"/i)
    ?? block.match(/data-tooltip-text="([^"]+)"/i)
  if (!tooltipMatch?.[1]) {
    return null
  }
  const decoded = decodeHtmlEntities(
    tooltipMatch[1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, '\''),
  )
  const percentMatch = decoded.match(/(\d{1,3})%/)
  if (!percentMatch) {
    return null
  }
  const percent = Number.parseInt(percentMatch[1], 10)
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    return null
  }
  return normalizeSteamRatingScore(percent / 100)
}

function mapSsrWorkshopResults(results: SsrWorkshopBrowseResult[]): SteamModRawItem[] {
  const dedup = new Set<string>()
  const items: SteamModRawItem[] = []
  for (const result of results) {
    const workshopId = result.publishedfileid?.trim() ?? ''
    const title = result.title?.trim() ?? ''
    if (!workshopId || !title || dedup.has(workshopId)) {
      continue
    }
    items.push({
      workshopId,
      title,
      previewImage: result.preview_url?.trim() || null,
      detailUrl: buildWorkshopDetailUrl(workshopId),
      rating: resolveItemRating(result),
    })
    dedup.add(workshopId)
  }
  return items
}

function parseLegacyWorkshopItems(html: string): SteamModRawItem[] {
  const sectionMatch
    = html.match(/<div class="workshopBrowseItems">([\s\S]*?)<\/div>\s*<div class="workshopBrowsePagingControls">/i)
      ?? html.match(/<div id="searchResultsRows">([\s\S]*?)<\/div>\s*<div class="workshopBrowsePagingControls">/i)
  const source = sectionMatch?.[1] ?? html
  const cardRegex = /<div[^>]*class="workshopItem"[^>]*>[\s\S]*?<\/div>\s*<\/div>/gi
  const idRegex = /data-publishedfileid="(\d+)"/i
  const titleRegex = /<div class="workshopItemTitle[^"]*">([\s\S]*?)<\/div>/i
  const hrefRegex = /<a[^>]+href="(https:\/\/steamcommunity\.com\/sharedfiles\/filedetails\/\?id=\d+[^"]*)"/i
  const imageRegex = /<img[^>]+class="[^"]*workshopItemPreviewImage[^"]*"[^>]+(?:data-src|src)="([^"]+)"/i
  const items: SteamModRawItem[] = []
  const dedup = new Set<string>()

  for (const card of source.matchAll(cardRegex)) {
    const block = card[0] ?? ''
    const workshopId = block.match(idRegex)?.[1]?.trim()
    const rawTitle = (block.match(titleRegex)?.[1] ?? '').replace(/<[^>]+>/g, '')
    const title = decodeHtmlEntities(rawTitle).trim()
    const detailUrl = block.match(hrefRegex)?.[1]?.trim()
      ?? (workshopId ? buildWorkshopDetailUrl(workshopId) : '')
    if (!detailUrl || !workshopId || !title || dedup.has(workshopId)) {
      continue
    }
    const imageMatch = block.match(imageRegex)
    const previewImage = imageMatch?.[1]?.trim() || null
    items.push({
      workshopId,
      title,
      previewImage,
      detailUrl,
      rating: parseLegacyWorkshopItemRating(block),
    })
    dedup.add(workshopId)
  }
  return items
}

function parseWorkshopItems(html: string): SteamModRawItem[] {
  const ssrData = extractSsrWorkshopBrowseData(html)
  if (ssrData?.results) {
    const ssrItems = mapSsrWorkshopResults(ssrData.results)
    if (ssrItems.length > 0 || ssrData.total_count === 0) {
      return ssrItems
    }
  }
  return parseLegacyWorkshopItems(html)
}

function isKnownEmptyWorkshopBrowse(html: string): boolean {
  if (/searchNoResults/i.test(html)) {
    return true
  }
  const ssrData = extractSsrWorkshopBrowseData(html)
  return Boolean(ssrData && ssrData.total_count === 0)
}

function hasRecognizableWorkshopBrowsePayload(html: string): boolean {
  if (extractSsrWorkshopBrowseData(html)) {
    return true
  }
  if (/workshopItem/i.test(html)) {
    return true
  }
  if (/searchNoResults/i.test(html)) {
    return true
  }
  return false
}

function detectHasMoreFromHtml(html: string, page: number, pageSize: number): boolean {
  const pagination = resolveHtmlPaginationMeta(html, page, pageSize)
  return pagination.hasMore
}

function resolvePaginationTotals(input: {
  page: number
  pageSize: number
  totalCount: number | null
  totalPages: number | null
  hasMoreHint?: boolean
}): {
  hasMore: boolean
  totalCount: number | null
  totalPages: number | null
} {
  const { page, pageSize, totalCount } = input
  let totalPages = input.totalPages
  if (totalPages === null && totalCount !== null && pageSize > 0) {
    totalPages = totalCount === 0 ? 0 : Math.max(1, Math.ceil(totalCount / pageSize))
  }
  const hasMore = totalPages !== null
    ? page < totalPages
    : Boolean(input.hasMoreHint)
  return {
    hasMore,
    totalCount,
    totalPages,
  }
}

function resolveHtmlPaginationMeta(html: string, page: number, pageSize: number): {
  hasMore: boolean
  totalCount: number | null
  totalPages: number | null
} {
  const ssrData = extractSsrWorkshopBrowseData(html)
  if (ssrData) {
    const totalCount = typeof ssrData.total_count === 'number' && ssrData.total_count >= 0
      ? ssrData.total_count
      : null
    const upstreamTotalPages = typeof ssrData.total_pages === 'number' && ssrData.total_pages >= 0
      ? ssrData.total_pages
      : null
    const nextCursor = ssrData.next_cursor?.trim()
    const hasMoreHint = upstreamTotalPages !== null
      ? page < upstreamTotalPages
      : Boolean(nextCursor && nextCursor !== '*' && nextCursor !== '0')
    return resolvePaginationTotals({
      page,
      pageSize,
      totalCount,
      totalPages: upstreamTotalPages,
      hasMoreHint,
    })
  }
  const nextPage = page + 1
  const nextPagePattern = new RegExp(`[?&]p=${nextPage}(?:&|")`)
  return resolvePaginationTotals({
    page,
    pageSize,
    totalCount: null,
    totalPages: null,
    hasMoreHint: nextPagePattern.test(html),
  })
}

async function fetchWorkshopHtmlByPowerShell(sourceUrl: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string> {
  if (process.platform !== 'win32') {
    throw new Error('native fetch failed')
  }
  const script = buildPowerShellWorkshopFetchScript(sourceUrl, timeoutMs)
  const result = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: timeoutMs + 3000,
    maxBuffer: 20 * 1024 * 1024,
  })
  const output = result.stdout?.trim()
  if (!output) {
    throw new Error('Steam 页面内容为空')
  }
  return output
}

function normalizeQuery(input: {
  keyword?: string
  page?: number
  pageSize?: number
  sort?: string
  trendDays?: number
}): NormalizedSteamQuery {
  return {
    keyword: input.keyword?.trim() ?? '',
    page: normalizePage(input.page),
    requestedPageSize: normalizePageSize(input.pageSize),
    sort: normalizeSort(input.sort),
    trendDays: normalizeTrendDays(input.trendDays),
  }
}

function createCacheKey(query: NormalizedSteamQuery): string {
  return JSON.stringify({
    schemaVersion: CACHE_SCHEMA_VERSION,
    keyword: query.keyword,
    page: query.page,
    pageSize: query.requestedPageSize,
    sort: query.sort,
    trendDays: query.trendDays,
  })
}

function isPersistedCacheEntryCompatible(cacheKey: string, entry: SteamModCacheEntry): boolean {
  try {
    const parsed = JSON.parse(cacheKey) as { schemaVersion?: number }
    if (parsed.schemaVersion === CACHE_SCHEMA_VERSION) {
      return true
    }
  }
  catch {
    // ignore invalid cache key
  }
  return entry.data.totalPages != null || entry.data.totalCount != null
}

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function isRetryableSteamError(error: SteamWorkshopFetchError): boolean {
  return error.code === 'STEAM_TIMEOUT'
    || error.code === 'STEAM_RATE_LIMIT'
    || error.code === 'STEAM_UPSTREAM_UNAVAILABLE'
}

const STEAM_UPSTREAM_USER_MESSAGE = '无法连接 Steam 创意工坊'

const TECHNICAL_STEAM_ERROR_PATTERNS = [
  /^Command failed:/i,
  /powershell/i,
  /ParserError/i,
  /CategoryInfo/i,
  /FullyQualifiedErrorId/i,
  /At line:\d+/i,
  /Invoke-WebRequest/i,
  /IncompleteHashLiteral/i,
  /Unexpected token/i,
]

function escapePowerShellSingleQuotedString(value: string): string {
  return value.replace(/'/g, "''")
}

function sanitizeSteamUserFacingMessage(message: string, fallback = STEAM_UPSTREAM_USER_MESSAGE): string {
  const normalized = message.trim()
  if (!normalized) {
    return fallback
  }
  if (TECHNICAL_STEAM_ERROR_PATTERNS.some(pattern => pattern.test(normalized))) {
    return fallback
  }
  return normalized
}

function buildPowerShellWorkshopFetchScript(sourceUrl: string, timeoutMs = FETCH_TIMEOUT_MS): string {
  const escapedUrl = escapePowerShellSingleQuotedString(sourceUrl)
  const timeoutSeconds = Math.max(1, Math.round(timeoutMs / 1000))
  return [
    '$ProgressPreference = \'SilentlyContinue\'',
    '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
    '$headers = @{ \'Accept-Language\' = \'zh-CN,zh;q=0.9,en;q=0.8\'; \'User-Agent\' = \'bubblesharkpanel-mod-fetcher/1.0\' }',
    `(Invoke-WebRequest -UseBasicParsing -Uri '${escapedUrl}' -TimeoutSec ${timeoutSeconds} -Headers $headers).Content`,
  ].join('; ')
}

function mapUnknownToSteamError(error: unknown): SteamWorkshopFetchError {
  if (isSteamWorkshopFetchError(error)) {
    return error
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return new SteamWorkshopFetchError('STEAM_TIMEOUT', '请求 Steam 超时')
    }
    if (error.message.includes('fetch failed')) {
      return new SteamWorkshopFetchError('STEAM_UPSTREAM_UNAVAILABLE', STEAM_UPSTREAM_USER_MESSAGE)
    }
    return new SteamWorkshopFetchError(
      'STEAM_UPSTREAM_UNAVAILABLE',
      sanitizeSteamUserFacingMessage(error.message),
    )
  }
  return new SteamWorkshopFetchError('STEAM_UPSTREAM_UNAVAILABLE', STEAM_UPSTREAM_USER_MESSAGE)
}

function pruneTimestampBucket(bucket: number[], now: number): number[] {
  const threshold = now - RATE_LIMIT_WINDOW_MS
  return bucket.filter(timestamp => timestamp > threshold)
}

function consumeRateLimit(map: Map<string, number[]>, key: string, limit: number, now: number): number {
  const current = pruneTimestampBucket(map.get(key) ?? [], now)
  map.set(key, current)
  if (current.length >= limit) {
    const retryAfter = RATE_LIMIT_WINDOW_MS - (now - current[0])
    return Math.max(100, retryAfter)
  }
  current.push(now)
  map.set(key, current)
  return 0
}

function assertRateLimit(cacheKey: string) {
  const now = Date.now()
  const globalRetryAfter = (() => {
    const next = pruneTimestampBucket(globalRequestBucket, now)
    globalRequestBucket.length = 0
    globalRequestBucket.push(...next)
    if (globalRequestBucket.length >= RATE_LIMIT_GLOBAL) {
      return Math.max(100, RATE_LIMIT_WINDOW_MS - (now - globalRequestBucket[0]))
    }
    globalRequestBucket.push(now)
    return 0
  })()
  const keyRetryAfter = consumeRateLimit(perKeyRequestBuckets, cacheKey, RATE_LIMIT_PER_KEY, now)
  const retryAfterMs = Math.max(globalRetryAfter, keyRetryAfter)
  if (retryAfterMs > 0) {
    throw new SteamWorkshopFetchError('STEAM_RATE_LIMIT', 'Steam 拉取频率过高，请稍后重试', retryAfterMs)
  }
}

/** 单个上游源是否还在熔断冷却中 */
function isSourceOpen(name: SteamModUpstreamSource, now = Date.now()): boolean {
  const state = steamCircuitState.get(name)
  return Boolean(state && state.openUntil > now)
}

/**
 * 源健康度排序：按「最近成功过的排前面」。
 *
 * 之前是写死的 official → relay → html，于是配了代理/反代之后，每次请求仍要先撞一遍
 * 不可达的 official 源；现在让上次成功的源优先，命中缓存之外还能少等几秒。
 */
function healthRank(name: SteamModUpstreamSource): number {
  const state = steamCircuitState.get(name)
  if (!state || state.lastSuccessAt === null) {
    return 1
  }
  return 0
}

function assertCircuitBreaker(name: SteamModUpstreamSource) {
  const now = Date.now()
  const state = steamCircuitState.get(name)
  if (state && state.openUntil > now) {
    throw new SteamWorkshopFetchError(
      'STEAM_UPSTREAM_UNAVAILABLE',
      'Steam 创意工坊暂时不可用，请稍后重试',
      state.openUntil - now,
    )
  }
}

function markCircuitSuccess(name: SteamModUpstreamSource) {
  steamCircuitState.set(name, {
    consecutiveFailures: 0,
    openUntil: 0,
    lastSuccessAt: Date.now(),
  })
}

/**
 * 记一次失败。`channel === 'background'` 时只记录不计入熔断——预热和 6 小时一次的
 * 定时检查不该让用户前台打开市场时撞上「暂时不可用」。
 */
function markCircuitFailure(name: SteamModUpstreamSource, channel: SteamCallChannel = 'user') {
  const state = steamCircuitState.get(name)
    ?? { consecutiveFailures: 0, openUntil: 0, lastSuccessAt: null }
  if (channel === 'background') {
    steamCircuitState.set(name, state)
    return
  }
  state.consecutiveFailures += 1
  if (state.consecutiveFailures >= CIRCUIT_BREAKER_FAIL_THRESHOLD) {
    state.openUntil = Date.now() + CIRCUIT_BREAKER_OPEN_MS
    state.consecutiveFailures = 0
    steamFetchMetrics.steam_circuit_open_total += 1
  }
  steamCircuitState.set(name, state)
}

function persistSteamCache(filePath: string) {
  const now = Date.now()
  for (const [key, entry] of steamModCache) if (entry.offlineExpiresAt <= now) steamModCache.delete(key)
  for (const [key, entry] of workshopDetailCache) if (entry.fetchedAt + OFFLINE_CACHE_TTL_MS <= now) workshopDetailCache.delete(key)
  const entries = Object.fromEntries(steamModCache)
  const details = Object.fromEntries(workshopDetailCache)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp`
  fs.writeFileSync(temporary, JSON.stringify({ entries, details } satisfies PersistedCachePayload), 'utf8')
  fs.renameSync(temporary, filePath)
}

function scheduleCachePersist() {
  if (!DISK_CACHE_FILE) {
    return
  }
  if (diskPersistTimer) {
    return
  }
  diskPersistTimer = setTimeout(() => {
    diskPersistTimer = null
    try {
      persistSteamCache(DISK_CACHE_FILE)
    }
    catch {
      // 持久缓存写入失败不影响主流程
    }
  }, 200)
}

function loadDiskCacheOnce(filePath = DISK_CACHE_FILE, force = false) {
  if (diskCacheLoaded && !force) {
    return
  }
  diskCacheLoaded = true
  if (!filePath) {
    return
  }
  try {
    if (!fs.existsSync(filePath)) {
      return
    }
    const raw = fs.readFileSync(filePath, 'utf8')
    if (!raw.trim()) {
      return
    }
    const payload = JSON.parse(raw) as PersistedCachePayload
    const now = Date.now()
    for (const [id, entry] of Object.entries(payload.details ?? {})) {
      if (entry?.schemaVersion === WORKSHOP_DETAIL_CACHE_SCHEMA && entry.fetchedAt + OFFLINE_CACHE_TTL_MS > now && entry.data?.workshopId === id) workshopDetailCache.set(id, entry)
    }
    for (const [cacheKey, entry] of Object.entries(payload.entries ?? {})) {
      // 只要还在离线窗口内就留着：过期条目还有离线兜底的价值，
      // 以前按 staleExpiresAt（30 分钟）过滤，重启后面板就彻底没有列表可显示了
      const offlineExpiresAt = entry?.offlineExpiresAt ?? entry?.staleExpiresAt ?? 0
      if (offlineExpiresAt > now && entry.data) {
        if (!isPersistedCacheEntryCompatible(cacheKey, entry)) {
          continue
        }
        const normalizedEntry: SteamModCacheEntry = {
          ...entry,
          offlineExpiresAt,
          data: {
            ...entry.data,
            upstreamSource: entry.data.upstreamSource ?? 'html',
            totalCount: entry.data.totalCount ?? null,
            totalPages: entry.data.totalPages ?? null,
          },
        }
        steamModCache.set(cacheKey, normalizedEntry)
      }
    }
  }
  catch {
    // 读取失败时忽略持久缓存
  }
}

function toSteamResult(
  raw: SteamModRawResult,
  subscribedModStatusByWorkshopId: Map<string, ModInstallStatus>,
  pendingWorkshopIds: Set<string>,
  meta: SteamModListMeta,
): SteamModListQueryResult {
  return {
    ...raw,
    sourceUrl: sanitizeSteamSourceUrl(raw.sourceUrl),
    totalCount: raw.totalCount ?? null,
    totalPages: raw.totalPages ?? null,
    meta,
    pendingWorkshopIds: [...pendingWorkshopIds],
    items: raw.items.map((item) => {
      const subscribeStatus = subscribedModStatusByWorkshopId.get(item.workshopId) ?? null
      const subscribed = subscribeStatus !== null
      const isPending = pendingWorkshopIds.has(item.workshopId)
        || subscribeStatus === 'pending'
      return {
        ...item,
        rating: item.rating ?? null,
        subscribed,
        subscribeStatus,
        installed: subscribeStatus === 'ready',
        pendingDownload: isPending,
      }
    }),
  }
}

function sanitizeSteamSourceUrl(value: string): string {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    url.username = ''; url.password = ''
    const sensitiveKeys = Array.from(url.searchParams.keys()).filter(key => /key|token|password|secret|authorization/i.test(key))
    for (const key of sensitiveKeys) url.searchParams.delete(key)
    return url.toString()
  }
  catch { return '' }
}

function buildWorkshopDetailUrl(workshopId: string): string {
  return `https://steamcommunity.com/sharedfiles/filedetails/?id=${workshopId}`
}

interface PublishedFileDetailItem {
  publishedfileid?: string
  result?: number
  creator?: string
  title?: string
  description?: string
  preview_url?: string
  file_size?: number
  time_created?: number
  time_updated?: number
  tags?: Array<{ tag?: string }>
  vote_data?: SteamVoteData
}

function unixSecondsToIso(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null
  }
  return new Date(value * 1000).toISOString()
}

function parsePublishedFileTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) {
    return []
  }
  const unique = new Set<string>()
  for (const item of tags) {
    if (typeof item === 'object' && item && 'tag' in item) {
      const tag = String((item as { tag?: string }).tag ?? '').trim()
      if (tag) {
        unique.add(tag)
      }
    }
  }
  return [...unique]
}

function acceptLanguageForLocale(locale: ModContentLocale): string {
  return locale === 'zh-CN'
    ? 'zh-CN,zh;q=0.9,en;q=0.8'
    : 'en-US,en;q=0.9,zh;q=0.8'
}

function mergeLocalizedText(
  map: ModLocalizedTextMap,
  locale: ModContentLocale,
  value: string,
): void {
  const trimmed = value.trim()
  if (!trimmed) {
    return
  }
  for (const existing of Object.values(map)) {
    if (existing?.trim() === trimmed) {
      return
    }
  }
  map[locale] = trimmed
}

function buildWorkshopDetailFromCache(
  data: WorkshopDetailCacheData,
  preferredLocale: ModContentLocale,
): Omit<SteamModDetailDto, 'subscribed' | 'subscribeStatus' | 'installed'> {
  const titleResolved = resolveModLocalizedText(data.titles, preferredLocale)
  const descriptionResolved = resolveModLocalizedText(data.descriptions, preferredLocale)
  const contentLocale = titleResolved.contentLocale === descriptionResolved.contentLocale
    ? titleResolved.contentLocale
    : preferredLocale
  return {
    workshopId: data.workshopId,
    title: titleResolved.value || `Workshop Mod ${data.workshopId}`,
    description: descriptionResolved.value,
    contentLocale,
    titles: { ...data.titles },
    descriptions: { ...data.descriptions },
    previewImage: data.previewImage,
    fileSize: data.fileSize,
    tags: [...data.tags],
    publishedAt: data.publishedAt,
    updatedAt: data.updatedAt,
    detailUrl: data.detailUrl,
    creatorName: data.creatorName,
  }
}

function mapPublishedFileDetailBase(item: PublishedFileDetailItem): Omit<WorkshopDetailCacheData, 'titles' | 'descriptions' | 'creatorName'> & {
  creatorSteamId: string | null
} {
  const workshopId = item.publishedfileid?.trim() ?? ''
  return {
    workshopId,
    previewImage: item.preview_url?.trim() || null,
    fileSize: typeof item.file_size === 'number' && Number.isFinite(item.file_size) && item.file_size >= 0
      ? item.file_size
      : null,
    tags: parsePublishedFileTags(item.tags),
    publishedAt: unixSecondsToIso(item.time_created),
    updatedAt: unixSecondsToIso(item.time_updated),
    detailUrl: buildWorkshopDetailUrl(workshopId),
    creatorSteamId: item.creator?.trim() || null,
  }
}

function mapPublishedFileDetailToDto(item: PublishedFileDetailItem): Omit<SteamModDetailDto, 'subscribed' | 'subscribeStatus' | 'installed'> {
  const base = mapPublishedFileDetailBase(item)
  const titles: ModLocalizedTextMap = {}
  const descriptions: ModLocalizedTextMap = {}
  mergeLocalizedText(titles, DEFAULT_MOD_CONTENT_LOCALE, item.title?.trim() || `Workshop Mod ${base.workshopId}`)
  mergeLocalizedText(descriptions, DEFAULT_MOD_CONTENT_LOCALE, item.description?.trim() ?? '')
  return buildWorkshopDetailFromCache({
    ...base,
    creatorName: null,
    titles,
    descriptions,
  }, DEFAULT_MOD_CONTENT_LOCALE)
}

async function fetchWorkshopLocalizedContent(
  workshopId: string,
  preferredLocale: ModContentLocale = DEFAULT_MOD_CONTENT_LOCALE,
  deadline = Date.now() + TOTAL_BUDGET_MS,
): Promise<{
  base: Omit<WorkshopDetailCacheData, 'creatorName'>
  creatorSteamId: string | null
}> {
  const normalizedId = workshopId.trim()
  const fallbackLocale: ModContentLocale = preferredLocale === 'zh-CN' ? 'en-US' : 'zh-CN'

  async function fetchLocale(locale: ModContentLocale) {
    const items = await requestPublishedFileDetails([normalizedId], { locale, deadline })
    const item = items.find(row => row.publishedfileid?.trim() === normalizedId) ?? items[0]
    return { locale, item }
  }

  const primaryResult = await fetchLocale(preferredLocale)
  const localeResults: Array<{ locale: ModContentLocale, item: PublishedFileDetailItem | undefined }> = []
  if (primaryResult.item?.result === 1) {
    localeResults.push(primaryResult)
  }
  if ((primaryResult.item?.result !== 1 || preferredLocale !== fallbackLocale) && deadline > Date.now()) {
    const fallbackResult = await fetchLocale(fallbackLocale).catch((error) => {
      if (primaryResult.item?.result !== 1) throw error
      return { locale: fallbackLocale, item: undefined }
    })
    if (fallbackResult.item?.result === 1 && !localeResults.some(entry => entry.locale === fallbackLocale)) {
      localeResults.push(fallbackResult)
    }
  }
  const validItems = localeResults.filter(entry => entry.item?.result === 1)
  const primary = validItems.find(entry => entry.locale === preferredLocale)?.item
    ?? validItems.find(entry => entry.locale === DEFAULT_MOD_CONTENT_LOCALE)?.item
    ?? validItems[0]?.item
  if (!primary) {
    throw new SteamWorkshopFetchError('STEAM_PARSE_FAILED', 'Mod 不存在或无法读取')
  }
  const baseFields = mapPublishedFileDetailBase(primary)
  const titles: ModLocalizedTextMap = {}
  const descriptions: ModLocalizedTextMap = {}
  for (const { locale, item } of validItems) {
    if (!item) {
      continue
    }
    mergeLocalizedText(titles, locale, item.title?.trim() || `Workshop Mod ${baseFields.workshopId}`)
    mergeLocalizedText(descriptions, locale, item.description?.trim() ?? '')
  }
  return {
    base: {
      ...baseFields,
      titles,
      descriptions,
    },
    creatorSteamId: primary.creator?.trim() || null,
  }
}

function parseSteamPersonaNameFromCommunityXml(xml: string): string | null {
  const matched = xml.match(/<steamID><!\[CDATA\[([^\]]+)\]\]><\/steamID>/i)
    ?? xml.match(/<steamID>([^<]+)<\/steamID>/i)
  const name = matched?.[1]?.trim()
  return name || null
}

async function fetchSteamPersonaName(steamId: string, deadline = Date.now() + TOTAL_BUDGET_MS): Promise<string | null> {
  const normalizedId = steamId.trim()
  if (!normalizedId) {
    return null
  }
  try {
    const summaryUrl = new URL('ISteamUser/GetPlayerSummaries/v0002/', STEAM_API_BASE_URL)
    summaryUrl.searchParams.set('steamids', normalizedId)
    if (STEAM_WEBAPI_KEY) {
      summaryUrl.searchParams.set('key', STEAM_WEBAPI_KEY)
    }
    const summaryResponse = await steamHttpRequest(summaryUrl.toString(), {
      headers: {
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'User-Agent': 'bubblesharkpanel-mod-fetcher/1.0',
      },
      timeoutMs: remainingTimeout(deadline, FETCH_TIMEOUT_MS),
    })
    if (summaryResponse.status >= 200 && summaryResponse.status < 300) {
      const payload = await summaryResponse.json() as {
        response?: {
          players?: Array<{ personaname?: string }>
        }
      }
      const personaName = payload.response?.players?.[0]?.personaname?.trim()
      if (personaName) {
        return personaName
      }
    }
    const profileResponse = await steamHttpRequest(
      new URL(`profiles/${normalizedId}/?xml=1`, WORKSHOP_BROWSE_URL).toString(),
      {
        headers: {
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'User-Agent': 'bubblesharkpanel-mod-fetcher/1.0',
        },
        timeoutMs: remainingTimeout(deadline, FETCH_TIMEOUT_MS),
      },
    )
    if (profileResponse.status < 200 || profileResponse.status >= 300) {
      return null
    }
    const xml = await profileResponse.text()
    return parseSteamPersonaNameFromCommunityXml(xml)
  }
  catch {
    return null
  }
}

function remainingTimeout(deadline: number, maximum: number): number {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new SteamWorkshopFetchError('STEAM_TIMEOUT', 'Steam 请求等待超时')
  return Math.min(remaining, maximum)
}

const detailsInFlight = new Map<string, Promise<PublishedFileDetailItem[]>>()
async function requestPublishedFileDetails(workshopIds: string[], options?: { locale?: ModContentLocale, deadline?: number }): Promise<PublishedFileDetailItem[]> {
  const ids = [...new Set(workshopIds.map(id => id.trim()).filter(Boolean))].sort()
  const key = JSON.stringify([ids, options?.locale ?? DEFAULT_MOD_CONTENT_LOCALE])
  const existing = detailsInFlight.get(key)
  if (existing) return existing
  const task = performPublishedFileDetailsRequest(ids, options)
  detailsInFlight.set(key, task)
  try { return await task }
  finally { if (detailsInFlight.get(key) === task) detailsInFlight.delete(key) }
}

async function performPublishedFileDetailsRequest(
  workshopIds: string[],
  options?: { locale?: ModContentLocale, deadline?: number },
): Promise<PublishedFileDetailItem[]> {
  const uniqueIds = [...new Set(workshopIds.map(id => id.trim()).filter(Boolean))]
  if (uniqueIds.length === 0) {
    return []
  }
  const url = new URL('ISteamRemoteStorage/GetPublishedFileDetails/v1/', STEAM_API_BASE_URL).toString()
  const body = new URLSearchParams()
  body.set('itemcount', String(uniqueIds.length))
  for (let index = 0; index < uniqueIds.length; index++) {
    body.set(`publishedfileids[${index}]`, uniqueIds[index])
  }
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'bubblesharkpanel-mod-fetcher/1.0',
      'Accept-Language': acceptLanguageForLocale(options?.locale ?? DEFAULT_MOD_CONTENT_LOCALE),
    }
    const response = await steamHttpRequest(url, {
      method: 'POST',
      headers,
      body: body.toString(),
      timeoutMs: remainingTimeout(options?.deadline ?? Date.now() + TOTAL_BUDGET_MS, FETCH_TIMEOUT_MS),
    })
    if (response.status === 429) {
      const retryAfterSeconds = Number.parseInt(response.headers.get('Retry-After') ?? '', 10)
      const retryAfterMs = Number.isFinite(retryAfterSeconds) ? Math.max(1000, retryAfterSeconds * 1000) : 0
      throw new SteamWorkshopFetchError('STEAM_RATE_LIMIT', 'Steam 返回限流，请稍后重试', retryAfterMs || undefined)
    }
    if (response.status >= 400) {
      throw new SteamWorkshopFetchError('STEAM_UPSTREAM_UNAVAILABLE', `Steam 返回 ${response.status}`)
    }
    const payload = await response.json() as {
      response?: {
        publishedfiledetails?: PublishedFileDetailItem[]
      }
    }
    observeSteamAccess('metadata', { status: 'success', message: '最近一次详情或版本元数据请求成功' })
    return payload.response?.publishedfiledetails ?? []
  }
  catch (error) {
    observeSteamAccess('metadata', { status: 'failed', message: '最近一次详情或版本元数据请求失败，可继续管理本地 Mod' })
    throw mapUnknownToSteamError(error)
  }
}

export async function fetchWorkshopFileDetail(
  workshopId: string,
  preferredLocale: ModContentLocale = DEFAULT_MOD_CONTENT_LOCALE,
): Promise<Omit<SteamModDetailDto, 'subscribed' | 'subscribeStatus' | 'installed'>> {
  const normalizedId = workshopId.trim()
  if (!normalizedId) {
    throw new SteamWorkshopFetchError('STEAM_PARSE_FAILED', '创意工坊 ID 不能为空')
  }
  loadDiskCacheOnce()
  const cached = workshopDetailCache.get(normalizedId)
  if (
    cached
    && cached.schemaVersion === WORKSHOP_DETAIL_CACHE_SCHEMA
    && Date.now() - cached.fetchedAt < WORKSHOP_DETAIL_CACHE_TTL_MS
  ) {
    return { ...buildWorkshopDetailFromCache(cached.data, preferredLocale), cache: { source: 'cache-fresh', fetchedAt: new Date(cached.fetchedAt).toISOString() } }
  }
  const deadline = Date.now() + TOTAL_BUDGET_MS
  try {
  const { base, creatorSteamId } = await fetchWorkshopLocalizedContent(normalizedId, preferredLocale, deadline)
  let creatorName: string | null = null
  if (creatorSteamId) {
    creatorName = await fetchSteamPersonaName(creatorSteamId, deadline)
  }
  const cacheData: WorkshopDetailCacheData = {
    ...base,
    creatorName,
  }
  const fetchedAt = Date.now()
  workshopDetailCache.set(normalizedId, {
    fetchedAt,
    schemaVersion: WORKSHOP_DETAIL_CACHE_SCHEMA,
    data: cacheData,
  })
  scheduleCachePersist()
  return { ...buildWorkshopDetailFromCache(cacheData, preferredLocale), cache: { source: 'live', fetchedAt: new Date(fetchedAt).toISOString() } }
  }
  catch (error) {
    if (cached?.schemaVersion === WORKSHOP_DETAIL_CACHE_SCHEMA && cached.fetchedAt + OFFLINE_CACHE_TTL_MS > Date.now()) {
      return { ...buildWorkshopDetailFromCache(cached.data, preferredLocale), cache: { source: 'cache-offline', fetchedAt: new Date(cached.fetchedAt).toISOString() } }
    }
    throw error
  }
}

function resolveDegradedUpstreamMessage(error: SteamWorkshopFetchError): string {
  if (error.code === 'STEAM_TIMEOUT') {
    return '暂时无法连接 Steam 创意工坊，请稍后点击刷新重试'
  }
  if (error.code === 'STEAM_RATE_LIMIT') {
    return 'Steam 请求频率过高，请稍后点击刷新重试'
  }
  if (error.code === 'STEAM_PARSE_FAILED') {
    return 'Steam 页面解析失败，请稍后点击刷新重试'
  }
  if (error.code === 'STEAM_UPSTREAM_UNAVAILABLE') {
    return '暂时无法连接 Steam 创意工坊，请稍后点击刷新重试'
  }
  return sanitizeSteamUserFacingMessage(
    error.message,
    '暂时无法连接 Steam 创意工坊，请稍后点击刷新重试',
  )
}

function buildDegradedEmptySteamResult(
  query: NormalizedSteamQuery,
  subscribedModStatusByWorkshopId: Map<string, ModInstallStatus>,
  pendingWorkshopIds: Set<string>,
  steamError: SteamWorkshopFetchError,
  traceId: string,
): SteamModListQueryResult {
  const sourceUrl = buildBrowseUrl(
    query.keyword,
    query.page,
    query.requestedPageSize,
    query.sort,
    query.trendDays,
  )
  return toSteamResult(
    {
      keyword: query.keyword,
      page: query.page,
      pageSize: query.requestedPageSize,
      sort: query.sort,
      trendDays: query.trendDays,
      hasMore: false,
      totalCount: null,
      totalPages: null,
      sourceUrl,
      upstreamSource: 'html',
      items: [],
    },
    subscribedModStatusByWorkshopId,
    pendingWorkshopIds,
    enrichMeta({
      cached: false,
      stale: false,
      cacheAgeMs: 0,
      source: 'live',
      fetchTraceId: traceId,
      upstreamUnavailable: true,
      upstreamMessage: resolveDegradedUpstreamMessage(steamError),
      retryAfterMs: steamError.retryAfterMs,
      steamErrorCode: steamError.code,
    }, 'html'),
  )
}

function enrichMeta(
  meta: Omit<SteamModListMeta, 'upstreamSource' | 'lastSuccessSource' | 'lastSuccessAt'>,
  upstreamSource: SteamModUpstreamSource,
): SteamModListMeta {
  return {
    ...meta,
    upstreamSource,
    lastSuccessSource: steamFetchMetrics.steam_last_success_source ?? undefined,
    lastSuccessAt: steamFetchMetrics.steam_last_success_at
      ? new Date(steamFetchMetrics.steam_last_success_at).toISOString()
      : undefined,
  }
}

async function fetchWorkshopHtmlByNative(sourceUrl: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string> {
  try {
    const response = await steamHttpRequest(sourceUrl, {
      headers: {
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'User-Agent': 'bubblesharkpanel-mod-fetcher/1.0',
      },
      timeoutMs,
    })
    if (response.status === 429) {
      const retryAfterSeconds = Number.parseInt(response.headers.get('Retry-After') ?? '', 10)
      const retryAfterMs = Number.isFinite(retryAfterSeconds) ? Math.max(1000, retryAfterSeconds * 1000) : 0
      throw new SteamWorkshopFetchError('STEAM_RATE_LIMIT', 'Steam 返回限流，请稍后重试', retryAfterMs || undefined)
    }
    if (response.status >= 400) {
      throw new SteamWorkshopFetchError('STEAM_UPSTREAM_UNAVAILABLE', `Steam 返回 ${response.status}`)
    }
    const html = await response.text()
    if (!html.trim()) {
      throw new SteamWorkshopFetchError('STEAM_PARSE_FAILED', 'Steam 页面内容为空')
    }
    return html
  }
  catch (error) {
    throw mapUnknownToSteamError(error)
  }
}

async function fetchJsonWithTimeout(
  url: string,
  headers?: Record<string, string>,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<unknown> {
  const response = await steamHttpRequest(url, {
    headers: {
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'User-Agent': 'bubblesharkpanel-mod-fetcher/1.0',
      ...headers,
    },
    timeoutMs,
  })
  if (response.status === 429) {
    const retryAfterSeconds = Number.parseInt(response.headers.get('Retry-After') ?? '', 10)
    const retryAfterMs = Number.isFinite(retryAfterSeconds) ? Math.max(1000, retryAfterSeconds * 1000) : 0
    throw new SteamWorkshopFetchError('STEAM_RATE_LIMIT', 'Steam 返回限流，请稍后重试', retryAfterMs || undefined)
  }
  if (response.status >= 400) {
    throw new SteamWorkshopFetchError('STEAM_UPSTREAM_UNAVAILABLE', `Steam 返回 ${response.status}`)
  }
  return await response.json()
}

async function fetchSteamWorkshopHtml(sourceUrl: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string> {
  const deadline = Date.now() + timeoutMs
  try {
    return await fetchWorkshopHtmlByNative(sourceUrl, timeoutMs)
  }
  catch (error) {
    if (process.platform !== 'win32' || readBrandEnv('BSP_STEAM_WORKSHOP_DISABLE_POWERSHELL_FALLBACK') === '1') {
      throw error
    }
    if (isSteamWorkshopFetchError(error) && error.code === 'STEAM_RATE_LIMIT') {
      throw error
    }
    try {
      return await fetchWorkshopHtmlByPowerShell(sourceUrl, remainingTimeout(deadline, timeoutMs))
    }
    catch (fallbackError) {
      throw mapUnknownToSteamError(fallbackError)
    }
  }
}

function resolveQueryType(sort: SteamModSort): number {
  if (sort === 'relevance') {
    return 12
  }
  if (sort === 'mostrecent') {
    return 1
  }
  if (sort === 'totaluniquesubscribers') {
    return 9
  }
  return 3
}

function normalizeQueryFilesItems(payload: unknown): SteamQueryFilesResponseItem[] {
  if (typeof payload !== 'object' || !payload) {
    return []
  }
  const typed = payload as SteamQueryFilesResponse
  if (!Array.isArray(typed.response?.publishedfiledetails)) {
    return []
  }
  return typed.response.publishedfiledetails
}

function hasNextCursor(payload: unknown): boolean {
  if (typeof payload !== 'object' || !payload) {
    return false
  }
  const typed = payload as SteamQueryFilesResponse
  const nextCursor = typed.response?.next_cursor?.trim()
  return Boolean(nextCursor && nextCursor !== '*' && nextCursor !== '0')
}

function resolveTotalFromQueryFiles(payload: unknown): number | null {
  if (typeof payload !== 'object' || !payload) {
    return null
  }
  const typed = payload as SteamQueryFilesResponse
  const total = typed.response?.total
  return typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : null
}

function mapPublishedFileDetailsToRatingMap(items: SteamQueryFilesResponseItem[]): Map<string, number | null> {
  const result = new Map<string, number | null>()
  for (const rawItem of items) {
    const item = normalizePublishedFileVoteData(rawItem)
    const workshopId = item.publishedfileid?.trim() ?? ''
    if (!workshopId) {
      continue
    }
    result.set(workshopId, resolveItemRating(item))
  }
  return result
}

function mapQueryFilesItems(items: SteamQueryFilesResponseItem[]): SteamModRawItem[] {
  const dedup = new Set<string>()
  const result: SteamModRawItem[] = []
  for (const item of items) {
    const workshopId = item.publishedfileid?.trim() ?? ''
    const title = item.title?.trim() ?? ''
    if (!workshopId || !title || dedup.has(workshopId)) {
      continue
    }
    const normalizedItem = normalizePublishedFileVoteData(item)
    result.push({
      workshopId,
      title,
      previewImage: normalizedItem.preview_url?.trim() || null,
      detailUrl: normalizedItem.file_url?.trim() || normalizedItem.url?.trim() || buildWorkshopDetailUrl(workshopId),
      rating: resolveItemRating(normalizedItem),
    })
    dedup.add(workshopId)
  }
  return result
}

async function fetchSteamDetailsMap(workshopIds: string[], deadline = Date.now() + TOTAL_BUDGET_MS): Promise<Map<string, SteamModRawItem>> {
  const apiKey = readBrandEnv('BSP_STEAM_WEBAPI_KEY')?.trim() || ''
  if (!apiKey || workshopIds.length === 0) {
    return new Map()
  }
  const detailsUrl = new URL('IPublishedFileService/GetDetails/v1/', STEAM_API_BASE_URL)
  detailsUrl.searchParams.set('key', apiKey)
  detailsUrl.searchParams.set('includevotes', 'true')
  detailsUrl.searchParams.set('return_vote_data', 'true')
  detailsUrl.searchParams.set('appid', '322330')
  for (let index = 0; index < workshopIds.length; index++) {
    detailsUrl.searchParams.set(`publishedfileids[${index}]`, workshopIds[index])
  }
  const payload = await fetchJsonWithTimeout(detailsUrl.toString(), undefined, remainingTimeout(deadline, OFFICIAL_TIMEOUT_MS))
  const items = normalizeQueryFilesItems(payload)
  const ratingMap = mapPublishedFileDetailsToRatingMap(items)
  const fullItems = mapQueryFilesItems(items)
  const result = new Map(fullItems.map(item => [item.workshopId, item]))
  for (const workshopId of workshopIds) {
    if (result.has(workshopId)) {
      const existing = result.get(workshopId)!
      if (existing.rating === null) {
        existing.rating = ratingMap.get(workshopId) ?? null
      }
      continue
    }
    const rating = ratingMap.get(workshopId)
    if (rating === undefined) {
      continue
    }
    result.set(workshopId, {
      workshopId,
      title: '',
      previewImage: null,
      detailUrl: buildWorkshopDetailUrl(workshopId),
      rating,
    })
  }
  return result
}

async function fetchWorkshopRatingsByGetDetails(workshopIds: string[], deadline = Date.now() + TOTAL_BUDGET_MS): Promise<Map<string, number | null>> {
  const uniqueIds = [...new Set(workshopIds.map(id => id.trim()).filter(Boolean))]
  const result = new Map<string, number | null>()
  if (uniqueIds.length === 0) {
    return result
  }
  const apiKey = readBrandEnv('BSP_STEAM_WEBAPI_KEY')?.trim() || ''
  if (!apiKey) {
    for (const workshopId of uniqueIds) {
      result.set(workshopId, null)
    }
    return result
  }
  const detailsUrl = new URL('IPublishedFileService/GetDetails/v1/', STEAM_API_BASE_URL)
  detailsUrl.searchParams.set('key', apiKey)
  detailsUrl.searchParams.set('includevotes', 'true')
  detailsUrl.searchParams.set('return_vote_data', 'true')
  detailsUrl.searchParams.set('appid', '322330')
  for (let index = 0; index < uniqueIds.length; index++) {
    detailsUrl.searchParams.set(`publishedfileids[${index}]`, uniqueIds[index])
  }
  const payload = await fetchJsonWithTimeout(detailsUrl.toString(), undefined, remainingTimeout(deadline, OFFICIAL_TIMEOUT_MS))
  const ratingMap = mapPublishedFileDetailsToRatingMap(normalizeQueryFilesItems(payload))
  for (const workshopId of uniqueIds) {
    result.set(workshopId, ratingMap.get(workshopId) ?? null)
  }
  return result
}

async function enrichWorkshopItemRatings(items: SteamModRawItem[], deadline = Date.now() + TOTAL_BUDGET_MS): Promise<void> {
  const missingIds = items
    .filter(item => item.rating === null)
    .map(item => item.workshopId)
  const apiKey = readBrandEnv('BSP_STEAM_WEBAPI_KEY')?.trim() || ''
  if (missingIds.length === 0 || !apiKey) {
    return
  }
  try {
    const ratingMap = await fetchWorkshopRatingsByGetDetails(missingIds, deadline)
    for (const item of items) {
      if (item.rating === null) {
        item.rating = ratingMap.get(item.workshopId) ?? null
      }
    }
  }
  catch {
    // 评分补全失败不影响主流程
  }
}

function parseRelayItems(payload: unknown): SteamModRawItem[] {
  if (typeof payload !== 'object' || !payload) {
    return []
  }
  const directItems = (payload as { items?: unknown }).items
  if (!Array.isArray(directItems)) {
    return []
  }
  const dedup = new Set<string>()
  const result: SteamModRawItem[] = []
  for (const item of directItems) {
    if (typeof item !== 'object' || !item) {
      continue
    }
    const row = item as Record<string, unknown>
    const workshopId = typeof row.workshopId === 'string' ? row.workshopId.trim() : ''
    const title = typeof row.title === 'string' ? row.title.trim() : ''
    if (!workshopId || !title || dedup.has(workshopId)) {
      continue
    }
    result.push({
      workshopId,
      title,
      previewImage: typeof row.previewImage === 'string' && row.previewImage.trim() ? row.previewImage : null,
      detailUrl: typeof row.detailUrl === 'string' && row.detailUrl.trim()
        ? row.detailUrl
        : buildWorkshopDetailUrl(workshopId),
      rating: typeof row.rating === 'number'
        ? normalizeSteamRatingScore(row.rating)
        : resolveItemRating(row as { vote_data?: SteamVoteData, score?: number }),
    })
    dedup.add(workshopId)
  }
  return result
}

async function queryByOfficialApi(query: SourceQuery): Promise<SteamModRawResult> {
  if (query.sort === 'relevance' && !query.keyword) {
    throw new SteamWorkshopFetchError('STEAM_PARSE_FAILED', '相关性排序需要搜索关键词')
  }
  const queryFilesUrl = new URL('IPublishedFileService/QueryFiles/v1/', STEAM_API_BASE_URL)
  queryFilesUrl.searchParams.set('key', STEAM_WEBAPI_KEY)
  const inputJson: Record<string, unknown> = {
    query_type: resolveQueryType(query.sort),
    cursor: '*',
    page: query.page,
    numperpage: query.requestedPageSize,
    creator_appid: 322330,
    appid: 322330,
    search_text: query.keyword,
    filetype: 18,
    return_previews: true,
    return_short_description: true,
    return_vote_data: true,
    strip_description_bbcode: true,
    requiredtags: DST_SERVER_ONLY_MOD_TAG,
    cache_max_age_seconds: query.sort === 'relevance' ? 0 : Math.max(30, Math.floor(CACHE_TTL_MS / 1000)),
  }
  if (query.sort === 'relevance') {
    Object.assign(inputJson, {
      search_text_target: 0,
    })
  }
  else {
    inputJson.language = 6 // schinese
  }
  if (query.sort === 'trend') {
    const trendDays = query.trendDays === -1 ? 7 : Math.min(7, query.trendDays)
    Object.assign(inputJson, {
      days: trendDays,
      include_recent_votes_only: true,
    })
  }
  queryFilesUrl.searchParams.set('input_json', JSON.stringify(inputJson))
  const payload = await fetchJsonWithTimeout(
    queryFilesUrl.toString(),
    undefined,
    query.timeoutMs,
  )
  const items = mapQueryFilesItems(normalizeQueryFilesItems(payload))
  const total = resolveTotalFromQueryFiles(payload)
  const totalCount = total
  const pagination = resolvePaginationTotals({
    page: query.page,
    pageSize: query.requestedPageSize,
    totalCount,
    totalPages: null,
    hasMoreHint: hasNextCursor(payload),
  })
  const { hasMore, totalPages } = pagination
  if (items.length === 0 && query.keyword && !hasNextCursor(payload)) {
    return {
      keyword: query.keyword,
      page: query.page,
      pageSize: query.requestedPageSize,
      sort: query.sort,
      trendDays: query.trendDays,
      hasMore,
      totalCount,
      totalPages,
      sourceUrl: queryFilesUrl.toString(),
      upstreamSource: 'official',
      items: [],
    }
  }
  if (items.length === 0) {
    throw new SteamWorkshopFetchError('STEAM_PARSE_FAILED', 'Steam QueryFiles 返回空结果')
  }
  const missingDetailIds = items
    .filter(item => !item.previewImage || !item.detailUrl)
    .map(item => item.workshopId)
  if (missingDetailIds.length > 0) {
    const detailsMap = await fetchSteamDetailsMap(missingDetailIds, query.deadline).catch(() => new Map<string, SteamModRawItem>())
    for (const item of items) {
      const detail = detailsMap.get(item.workshopId)
      if (!detail) {
        continue
      }
      item.previewImage = item.previewImage || detail.previewImage
      item.detailUrl = item.detailUrl || detail.detailUrl
      item.rating = item.rating ?? detail.rating
    }
  }
  await enrichWorkshopItemRatings(items, query.deadline)
  return {
    keyword: query.keyword,
    page: query.page,
    pageSize: query.requestedPageSize,
    sort: query.sort,
    trendDays: query.trendDays,
    hasMore,
    totalCount: pagination.totalCount,
    totalPages,
    sourceUrl: queryFilesUrl.toString(),
    upstreamSource: 'official',
    items,
  }
}

async function queryByRelayApi(query: SourceQuery): Promise<SteamModRawResult> {
  const relayUrl = new URL('/query-files', STEAM_RELAY_URL.endsWith('/') ? STEAM_RELAY_URL : `${STEAM_RELAY_URL}/`)
  relayUrl.searchParams.set('keyword', query.keyword)
  relayUrl.searchParams.set('page', String(query.page))
  relayUrl.searchParams.set('pageSize', String(query.requestedPageSize))
  relayUrl.searchParams.set('sort', query.sort)
  relayUrl.searchParams.set('trendDays', String(query.trendDays))
  relayUrl.searchParams.set('requiredtags', DST_SERVER_ONLY_MOD_TAG)
  const payload = await fetchJsonWithTimeout(relayUrl.toString(), STEAM_RELAY_TOKEN
    ? {
        Authorization: `Bearer ${STEAM_RELAY_TOKEN}`,
      }
    : undefined, query.timeoutMs)
  const relayItems = parseRelayItems(payload)
  const items = relayItems.length > 0 ? relayItems : mapQueryFilesItems(normalizeQueryFilesItems(payload))
  if (items.length === 0) {
    throw new SteamWorkshopFetchError('STEAM_PARSE_FAILED', 'Relay 返回空结果')
  }
  const relayMeta = payload as {
    hasMore?: unknown
    totalCount?: unknown
    totalPages?: unknown
    sourceUrl?: unknown
    next_cursor?: unknown
    response?: { next_cursor?: unknown, total?: unknown }
  }
  const relayTotalCount = typeof relayMeta.totalCount === 'number'
    ? relayMeta.totalCount
    : typeof relayMeta.response?.total === 'number'
      ? relayMeta.response.total
      : null
  const relayUpstreamTotalPages = typeof relayMeta.totalPages === 'number'
    ? relayMeta.totalPages
    : null
  const relayHasMoreHint = typeof relayMeta.hasMore === 'boolean'
    ? relayMeta.hasMore
    : Boolean(
        relayMeta.next_cursor
        || relayMeta.response?.next_cursor,
      )
  const relayPagination = resolvePaginationTotals({
    page: query.page,
    pageSize: query.requestedPageSize,
    totalCount: relayTotalCount,
    totalPages: relayUpstreamTotalPages,
    hasMoreHint: relayHasMoreHint,
  })
  await enrichWorkshopItemRatings(items, query.deadline)
  return {
    keyword: query.keyword,
    page: query.page,
    pageSize: query.requestedPageSize,
    sort: query.sort,
    trendDays: query.trendDays,
    hasMore: relayPagination.hasMore,
    totalCount: relayPagination.totalCount,
    totalPages: relayPagination.totalPages,
    sourceUrl: typeof relayMeta.sourceUrl === 'string' && relayMeta.sourceUrl.trim()
      ? relayMeta.sourceUrl
      : relayUrl.toString(),
    upstreamSource: 'relay',
    items,
  }
}

async function queryByHtml(query: SourceQuery): Promise<SteamModRawResult> {
  const sourceUrl = buildBrowseUrl(
    query.keyword,
    query.page,
    query.requestedPageSize,
    query.sort,
    query.trendDays,
  )
  const html = await fetchSteamWorkshopHtml(sourceUrl, query.timeoutMs)
  const items = parseWorkshopItems(html)
  if (items.length === 0 && !isKnownEmptyWorkshopBrowse(html) && !hasRecognizableWorkshopBrowsePayload(html)) {
    throw new SteamWorkshopFetchError('STEAM_PARSE_FAILED', 'Steam 页面结构变更，解析失败')
  }
  const pagination = resolveHtmlPaginationMeta(html, query.page, query.requestedPageSize)
  await enrichWorkshopItemRatings(items, query.deadline)
  return {
    keyword: query.keyword,
    page: query.page,
    pageSize: query.requestedPageSize,
    sort: query.sort,
    trendDays: query.trendDays,
    hasMore: pagination.hasMore,
    totalCount: pagination.totalCount,
    totalPages: pagination.totalPages,
    sourceUrl,
    upstreamSource: 'html',
    items,
  }
}

const steamSources: SteamWorkshopSource[] = [
  {
    name: 'official',
    enabled: Boolean(STEAM_WEBAPI_KEY),
    timeoutMs: OFFICIAL_TIMEOUT_MS,
    retryTimes: FETCH_RETRY_TIMES,
    queryMods: queryByOfficialApi,
  },
  {
    name: 'relay',
    enabled: Boolean(STEAM_RELAY_URL),
    timeoutMs: RELAY_TIMEOUT_MS,
    retryTimes: FETCH_RETRY_TIMES,
    queryMods: queryByRelayApi,
  },
  {
    name: 'html',
    enabled: true,
    timeoutMs: FETCH_TIMEOUT_MS,
    retryTimes: FETCH_RETRY_TIMES,
    queryMods: queryByHtml,
  },
]

function resolveSteamSourcesForQuery(query: NormalizedSteamQuery): SteamWorkshopSource[] {
  const now = Date.now()
  // 熔断中的源直接跳过：以前会先撞一遍再失败，白等一个超时
  const usable = steamSources.filter(source => source.enabled && !isSourceOpen(source.name, now))
  const byHealth = (list: SteamWorkshopSource[]) => [...list].sort((a, b) => {
    const rankDiff = healthRank(a.name) - healthRank(b.name)
    if (rankDiff !== 0) {
      return rankDiff
    }
    return steamSources.indexOf(a) - steamSources.indexOf(b)
  })
  if (query.sort === 'relevance' && query.keyword) {
    // 相关性排序只能靠搜索结果页，Steam 的 QueryFiles 给不出同样的排序
    const preferredOrder = ['html', 'official', 'relay']
    return byHealth(preferredOrder
      .map(name => usable.find(source => source.name === name))
      .filter((source): source is SteamWorkshopSource => Boolean(source)))
  }
  return byHealth(usable)
}

async function fetchLiveWithPolicy(
  query: NormalizedSteamQuery,
  cacheKey: string,
  traceId: string,
  channel: SteamCallChannel = 'user',
): Promise<SteamModRawResult> {
  let lastError: SteamWorkshopFetchError | null = null
  const enabledSources = resolveSteamSourcesForQuery(query)
  const deadline = Date.now() + TOTAL_BUDGET_MS
  let failedSourceSeen = false

  for (const source of enabledSources) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      // 预算耗尽：不再继续试下一个源，直接交给缓存/离线兜底
      break
    }
    // 已有源失败过 → 后面的源快速失败且不重试
    const sourceQuery: SourceQuery = {
      ...query,
      deadline,
      timeoutMs: failedSourceSeen
        ? Math.min(FAST_FAIL_TIMEOUT_MS, remaining)
        : Math.min(source.timeoutMs, remaining),
      fastFail: failedSourceSeen,
    }
    const retryTimes = failedSourceSeen ? 0 : source.retryTimes
    for (let attempt = 0; attempt <= retryTimes; attempt++) {
      if (Date.now() >= deadline) break
      sourceQuery.timeoutMs = Math.min(sourceQuery.timeoutMs, deadline - Date.now())
      try {
        assertCircuitBreaker(source.name)
        assertRateLimit(cacheKey)
        const startedAt = Date.now()
        const payload = await source.queryMods(sourceQuery)
        steamFetchMetrics.steam_fetch_success_total += 1
        steamFetchMetrics.steam_fetch_success_by_source[source.name] += 1
        steamFetchMetrics.steam_fetch_latency_ms.push(Date.now() - startedAt)
        steamFetchMetrics.steam_last_success_source = source.name
        steamFetchMetrics.steam_last_success_at = Date.now()
        markCircuitSuccess(source.name)
        observeSteamAccess('market', { status: 'success', message: '最近一次市场列表请求成功', cached: false })
        if (process.env.NODE_ENV !== 'test') {
          console.info(`[steam-workshop] fetch_success trace=${traceId} key=${cacheKey} source=${source.name} channel=${channel}`)
        }
        return payload
      }
      catch (error) {
        const steamError = mapUnknownToSteamError(error)
        lastError = steamError
        observeSteamAccess('market', { status: 'failed', message: '最近一次市场列表请求失败', cached: false })
        steamFetchMetrics.steam_fetch_fail_total[steamError.code] = (steamFetchMetrics.steam_fetch_fail_total[steamError.code] ?? 0) + 1
        steamFetchMetrics.steam_fetch_fail_by_source[source.name] += 1
        markCircuitFailure(source.name, channel)
        const shouldRetry = isRetryableSteamError(steamError) && attempt < retryTimes
        if (!shouldRetry) {
          break
        }
        const retryAfter = steamError.retryAfterMs ?? 0
        const jitter = Math.floor(Math.random() * 100)
        const backoff = FETCH_RETRY_BASE_DELAY_MS * 2 ** attempt + jitter
        const wait = Math.max(backoff, retryAfter)
        if (wait >= deadline - Date.now()) break
        await waitFor(wait)
      }
    }
    failedSourceSeen = true
  }
  throw (lastError ?? new SteamWorkshopFetchError('STEAM_UPSTREAM_UNAVAILABLE', 'Steam 上游不可用'))
}

function setCacheEntry(cacheKey: string, raw: SteamModRawResult) {
  const now = Date.now()
  steamModCache.set(cacheKey, {
    fetchedAt: now,
    expiresAt: now + CACHE_TTL_MS,
    staleExpiresAt: now + STALE_CACHE_TTL_MS,
    offlineExpiresAt: now + OFFLINE_CACHE_TTL_MS,
    data: { ...raw, sourceUrl: sanitizeSteamSourceUrl(raw.sourceUrl) },
  })
  scheduleCachePersist()
}

async function getOrCreateLiveFetchTask(
  cacheKey: string,
  query: NormalizedSteamQuery,
  traceId: string,
  channel: SteamCallChannel = 'user',
): Promise<SteamModRawResult> {
  const currentTask = steamModInFlight.get(cacheKey)
  if (currentTask) {
    return await currentTask
  }
  const task = (async () => {
    const raw = await fetchLiveWithPolicy(query, cacheKey, traceId, channel)
    setCacheEntry(cacheKey, raw)
    return raw
  })()
  steamModInFlight.set(cacheKey, task)
  try {
    return await task
  }
  catch (error) {
    const cached = steamModCache.get(cacheKey)
    if (cached) cached.refreshFailed = true
    throw error
  }
  finally {
    steamModInFlight.delete(cacheKey)
  }
}

function scheduleBackgroundRefresh(cacheKey: string, query: NormalizedSteamQuery) {
  if (steamBackgroundRefreshing.has(cacheKey) || steamModInFlight.has(cacheKey)) {
    return
  }
  steamBackgroundRefreshing.add(cacheKey)
  const traceId = randomUUID()
  void getOrCreateLiveFetchTask(cacheKey, query, traceId, 'background')
    .catch(() => {
      // 后台刷新失败不影响本次请求
    })
    .finally(() => {
      steamBackgroundRefreshing.delete(cacheKey)
    })
}

export async function fetchDstSteamWorkshopMods(input: {
  keyword?: string
  page?: number
  pageSize?: number
  sort?: string
  trendDays?: number
  subscribedModStatusByWorkshopId: Map<string, ModInstallStatus>
  pendingWorkshopIds?: Set<string>
}): Promise<SteamModListQueryResult> {
  loadDiskCacheOnce()
  const query = normalizeQuery(input)
  const pendingWorkshopIds = input.pendingWorkshopIds ?? new Set<string>()
  const subscribedModStatusByWorkshopId = input.subscribedModStatusByWorkshopId
  const cacheKey = createCacheKey(query)
  const traceId = randomUUID()
  const now = Date.now()
  const cacheEntry = steamModCache.get(cacheKey)
  if (cacheEntry && cacheEntry.expiresAt > now) {
    observeSteamMarketCache(true, cacheEntry.fetchedAt)
    steamFetchMetrics.steam_cache_hit_total.fresh += 1
    return toSteamResult(cacheEntry.data, subscribedModStatusByWorkshopId, pendingWorkshopIds, enrichMeta({
      cached: true,
      stale: false,
      dataFetchedAt: new Date(cacheEntry.fetchedAt).toISOString(),
      cacheAgeMs: now - cacheEntry.fetchedAt,
      source: 'cache-fresh',
      fetchTraceId: traceId,
    }, cacheEntry.data.upstreamSource))
  }
  if (cacheEntry && cacheEntry.staleExpiresAt > now) {
    observeSteamMarketCache(true, cacheEntry.fetchedAt)
    steamFetchMetrics.steam_cache_hit_total.stale += 1
    scheduleBackgroundRefresh(cacheKey, query)
    return toSteamResult(cacheEntry.data, subscribedModStatusByWorkshopId, pendingWorkshopIds, enrichMeta({
      cached: true,
      stale: true,
      offline: cacheEntry.refreshFailed === true,
      dataFetchedAt: new Date(cacheEntry.fetchedAt).toISOString(),
      cacheAgeMs: now - cacheEntry.fetchedAt,
      source: 'cache-stale',
      fetchTraceId: traceId,
    }, cacheEntry.data.upstreamSource))
  }
  steamFetchMetrics.steam_cache_hit_total.miss += 1
  try {
    const liveData = await getOrCreateLiveFetchTask(cacheKey, query, traceId)
    observeSteamMarketCache(false, steamModCache.get(cacheKey)?.fetchedAt ?? Date.now())
    return toSteamResult(liveData, subscribedModStatusByWorkshopId, pendingWorkshopIds, enrichMeta({
      cached: false,
      stale: false,
      dataFetchedAt: new Date(steamModCache.get(cacheKey)?.fetchedAt ?? Date.now()).toISOString(),
      cacheAgeMs: 0,
      source: 'live',
      fetchTraceId: traceId,
    }, liveData.upstreamSource))
  }
  catch (error) {
    const stale = steamModCache.get(cacheKey)
    const failedAt = Date.now()
    if (stale && stale.staleExpiresAt > failedAt) {
      observeSteamMarketCache(true, stale.fetchedAt)
      const steamError = mapUnknownToSteamError(error)
      return toSteamResult(stale.data, subscribedModStatusByWorkshopId, pendingWorkshopIds, enrichMeta({
        cached: true,
        stale: true,
        offline: true,
        dataFetchedAt: new Date(stale.fetchedAt).toISOString(),
        cacheAgeMs: failedAt - stale.fetchedAt,
        source: 'cache-stale',
        retryAfterMs: steamError.retryAfterMs,
        fetchTraceId: traceId,
      }, stale.data.upstreamSource))
    }
    // 过了 stale 窗口但还在离线窗口内：照常把列表渲染出来并标注离线，
    // 这比给用户一个空白页有用得多（丢的只是「新鲜度」，不是「能不能用」）
    if (stale && stale.offlineExpiresAt > failedAt) {
      observeSteamMarketCache(true, stale.fetchedAt)
      const steamError = mapUnknownToSteamError(error)
      return toSteamResult(stale.data, subscribedModStatusByWorkshopId, pendingWorkshopIds, enrichMeta({
        cached: true,
        stale: true,
        offline: true,
        dataFetchedAt: new Date(stale.fetchedAt).toISOString(),
        cacheAgeMs: failedAt - stale.fetchedAt,
        source: 'cache-stale',
        retryAfterMs: steamError.retryAfterMs,
        steamErrorCode: steamError.code,
        fetchTraceId: traceId,
      }, stale.data.upstreamSource))
    }
    return buildDegradedEmptySteamResult(
      query,
      subscribedModStatusByWorkshopId,
      pendingWorkshopIds,
      mapUnknownToSteamError(error),
      traceId,
    )
  }
}

/** 面板启动后后台预热默认 Mod 市场列表（sort=trend, page=1） */
export function scheduleWarmSteamWorkshopModCache(): void {
  if (IS_UNIT_TEST) return
  if (readBrandEnv('BSP_STEAM_WORKSHOP_WARM_CACHE') === '0') {
    return
  }
  loadDiskCacheOnce()
  const query = normalizeQuery({
    keyword: '',
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    sort: DEFAULT_SORT,
    trendDays: DEFAULT_TREND_DAYS,
  })
  const cacheKey = createCacheKey(query)
  const entry = steamModCache.get(cacheKey)
  const now = Date.now()
  if (entry && entry.expiresAt > now) {
    return
  }
  scheduleBackgroundRefresh(cacheKey, query)
}

export async function fetchWorkshopPreviewImages(workshopIds: string[]): Promise<Map<string, string | null>> {
  const uniqueIds = [...new Set(workshopIds.map(id => id.trim()).filter(Boolean))]
  const result = new Map<string, string | null>()
  if (uniqueIds.length === 0) {
    return result
  }
  try {
    const items = await requestPublishedFileDetails(uniqueIds, { locale: DEFAULT_MOD_CONTENT_LOCALE })
    for (const item of items) {
      const workshopId = item.publishedfileid?.trim()
      if (!workshopId) {
        continue
      }
      result.set(workshopId, item.preview_url?.trim() || null)
    }
  }
  catch {
    // 补图失败不影响主流程
  }
  for (const workshopId of uniqueIds) {
    if (!result.has(workshopId)) {
      result.set(workshopId, null)
    }
  }
  return result
}

/** 工坊单条元数据：名称、缩略图、最新版本时间（ISO）与体积 */
export interface WorkshopModMetadata {
  /** 工坊标题；查询不到时为 null */
  title: string | null
  previewImage: string | null
  /** time_updated 转 ISO；上游未返回时为 null */
  updatedAt: string | null
  fileSize: number | null
}

const EMPTY_WORKSHOP_METADATA: WorkshopModMetadata = {
  title: null,
  previewImage: null,
  updatedAt: null,
  fileSize: null,
}

const workshopMetadataCache = new Map<string, { value: WorkshopModMetadata, expiresAt: number }>()

function mapPublishedFileDetailToMetadata(item: PublishedFileDetailItem): WorkshopModMetadata {
  return {
    title: item.title?.trim() || null,
    previewImage: item.preview_url?.trim() || null,
    updatedAt: unixSecondsToIso(item.time_updated),
    fileSize: typeof item.file_size === 'number' && Number.isFinite(item.file_size) ? item.file_size : null,
  }
}

/**
 * 批量取工坊元数据（名称/缩略图/最新版本时间），供 Mod 名称回填与「是否有更新」判定使用。
 *
 * 分两件事：命中的条目走内存缓存（默认 10 分钟），未命中的按 100 个一批调用公开的
 * GetPublishedFileDetails。**单批失败不抛错**：已取到的条目照常返回，`ok:false` 让调用方
 * 决定是沿用旧状态还是提示用户；失败批次里查不到的条目不会被写成「工坊上没有该 Mod」。
 */
export async function fetchWorkshopModMetadata(
  workshopIds: string[],
  options?: { force?: boolean },
): Promise<{ ok: boolean, message?: string, items: Map<string, WorkshopModMetadata> }> {
  const uniqueIds = [...new Set(workshopIds.map(id => id.trim()).filter(Boolean))]
  const deadline = Date.now() + TOTAL_BUDGET_MS
  const items = new Map<string, WorkshopModMetadata>()
  if (uniqueIds.length === 0) {
    return { ok: true, items }
  }

  const now = Date.now()
  const pendingIds: string[] = []
  for (const workshopId of uniqueIds) {
    const cached = workshopMetadataCache.get(workshopId)
    if (!options?.force && cached && cached.expiresAt > now) {
      items.set(workshopId, cached.value)
      continue
    }
    pendingIds.push(workshopId)
  }
  if (pendingIds.length === 0) {
    return { ok: true, items }
  }

  const batches: string[][] = []
  for (let index = 0; index < pendingIds.length; index += WORKSHOP_METADATA_BATCH_SIZE) {
    batches.push(pendingIds.slice(index, index + WORKSHOP_METADATA_BATCH_SIZE))
  }
  const truncated = batches.length > WORKSHOP_METADATA_MAX_BATCHES
  const plannedBatches = truncated ? batches.slice(0, WORKSHOP_METADATA_MAX_BATCHES) : batches

  let failedMessage: string | undefined
  let failed = truncated
  if (truncated) {
    failedMessage = 'Mod 数量超出单次检查上限，本次只检查了前一部分'
  }

  for (const batch of plannedBatches) {
    const batchIds = new Set(batch)
    try {
      const responseItems = await requestPublishedFileDetails(batch, { locale: DEFAULT_MOD_CONTENT_LOCALE, deadline })
      const found = new Set<string>()
      for (const item of responseItems) {
        const workshopId = item.publishedfileid?.trim()
        if (!workshopId || !batchIds.has(workshopId)) {
          continue
        }
        const metadata = mapPublishedFileDetailToMetadata(item)
        found.add(workshopId)
        items.set(workshopId, metadata)
        workshopMetadataCache.set(workshopId, {
          value: metadata,
          expiresAt: Date.now() + WORKSHOP_METADATA_CACHE_TTL_MS,
        })
      }
      // 工坊上确实没有这些 ID（已下架/私密）：缓存这个结论，但只在批次成功时才敢下
      for (const workshopId of batch) {
        if (found.has(workshopId)) {
          continue
        }
        items.set(workshopId, EMPTY_WORKSHOP_METADATA)
        workshopMetadataCache.set(workshopId, {
          value: EMPTY_WORKSHOP_METADATA,
          expiresAt: Date.now() + WORKSHOP_METADATA_CACHE_TTL_MS,
        })
      }
    }
    catch (error) {
      failed = true
      failedMessage = failedMessage
        ?? sanitizeSteamUserFacingMessage(
          error instanceof Error ? error.message : '',
          STEAM_UPSTREAM_USER_MESSAGE,
        )
    }
  }

  return failed ? { ok: false, message: failedMessage, items } : { ok: true, items }
}

export async function fetchWorkshopRatings(workshopIds: string[]): Promise<Map<string, number | null>> {
  const uniqueIds = [...new Set(workshopIds.map(id => id.trim()).filter(Boolean))]
  const result = new Map<string, number | null>()
  if (uniqueIds.length === 0) {
    return result
  }
  const now = Date.now()
  const missingIds: string[] = []
  for (const workshopId of uniqueIds) {
    const cached = workshopRatingCache.get(workshopId)
    if (cached && cached.expiresAt > now) {
      result.set(workshopId, cached.rating)
    }
    else {
      missingIds.push(workshopId)
    }
  }
  if (missingIds.length === 0) {
    return result
  }
  const apiKey = readBrandEnv('BSP_STEAM_WEBAPI_KEY')?.trim() || ''
  if (apiKey) {
    try {
      const fromGetDetails = await fetchWorkshopRatingsByGetDetails(missingIds)
      for (const [workshopId, rating] of fromGetDetails) {
        if (rating !== null) {
          result.set(workshopId, rating)
          workshopRatingCache.set(workshopId, { rating, expiresAt: now + WORKSHOP_RATING_CACHE_TTL_MS })
        }
      }
    }
    catch {
      // fallback below
    }
  }
  const stillMissingIds = missingIds.filter(workshopId => !result.has(workshopId))
  if (stillMissingIds.length > 0) {
    try {
      const items = await requestPublishedFileDetails(stillMissingIds, { locale: DEFAULT_MOD_CONTENT_LOCALE })
      for (const item of items) {
        const workshopId = item.publishedfileid?.trim()
        if (!workshopId) {
          continue
        }
        const rating = resolveItemRating(item)
        if (rating !== null) {
          result.set(workshopId, rating)
          workshopRatingCache.set(workshopId, { rating, expiresAt: now + WORKSHOP_RATING_CACHE_TTL_MS })
        }
      }
    }
    catch {
      // 评分补全失败不影响主流程
    }
  }
  for (const workshopId of uniqueIds) {
    if (!result.has(workshopId)) {
      result.set(workshopId, null)
      workshopRatingCache.set(workshopId, { rating: null, expiresAt: now + WORKSHOP_RATING_CACHE_TTL_MS })
    }
  }
  return result
}

/** 上游链路快照：面板「环境自检」据此说明 Mod 市场为什么连不上、该配什么 */
export interface SteamUpstreamStatus {
  configuredSources: SteamModUpstreamSource[]
  /** 当前源顺序（健康度排序后的实际尝试顺序） */
  sourceOrder: SteamModUpstreamSource[]
  /** 处于熔断冷却中的源 */
  openSources: SteamModUpstreamSource[]
  lastSuccessSource: SteamModUpstreamSource | null
  lastSuccessAt: string | null
  proxy: { enabled: boolean, source: string | null, host: string | null }
}

export function getSteamUpstreamStatus(): SteamUpstreamStatus {
  const now = Date.now()
  const enabled = steamSources.filter(source => source.enabled)
  return {
    configuredSources: enabled.map(source => source.name),
    sourceOrder: resolveSteamSourcesForQuery({
      keyword: '',
      page: 1,
      requestedPageSize: DEFAULT_PAGE_SIZE,
      sort: DEFAULT_SORT,
      trendDays: DEFAULT_TREND_DAYS,
    }).map(source => source.name),
    openSources: enabled.filter(source => isSourceOpen(source.name, now)).map(source => source.name),
    lastSuccessSource: steamFetchMetrics.steam_last_success_source,
    lastSuccessAt: steamFetchMetrics.steam_last_success_at
      ? new Date(steamFetchMetrics.steam_last_success_at).toISOString()
      : null,
    proxy: describeSteamProxy(resolveSteamProxyConfig()),
  }
}

export function getSteamWorkshopMetricsSnapshot(): Readonly<SteamFetchMetrics> {
  return {
    steam_fetch_success_total: steamFetchMetrics.steam_fetch_success_total,
    steam_fetch_success_by_source: { ...steamFetchMetrics.steam_fetch_success_by_source },
    steam_fetch_fail_total: { ...steamFetchMetrics.steam_fetch_fail_total },
    steam_fetch_fail_by_source: { ...steamFetchMetrics.steam_fetch_fail_by_source },
    steam_fetch_latency_ms: [...steamFetchMetrics.steam_fetch_latency_ms],
    steam_cache_hit_total: { ...steamFetchMetrics.steam_cache_hit_total },
    steam_circuit_open_total: steamFetchMetrics.steam_circuit_open_total,
    steam_last_success_source: steamFetchMetrics.steam_last_success_source,
    steam_last_success_at: steamFetchMetrics.steam_last_success_at,
  }
}

function resetSteamWorkshopRuntimeForTests() {
  steamModCache.clear()
  steamModInFlight.clear()
  steamBackgroundRefreshing.clear()
  workshopDetailCache.clear()
  workshopRatingCache.clear()
  workshopMetadataCache.clear()
  perKeyRequestBuckets.clear()
  globalRequestBucket.length = 0
  steamCircuitState.clear()
  if (diskPersistTimer) {
    clearTimeout(diskPersistTimer)
    diskPersistTimer = null
  }
}

export const __steamWorkshopTestUtils = {
  waitForListRefresh: async (query: Parameters<typeof normalizeQuery>[0]) => {
    await steamModInFlight.get(createCacheKey(normalizeQuery(query)))?.catch(() => {})
  },
  persistCacheTo: persistSteamCache,
  loadCacheFrom: (filePath: string) => loadDiskCacheOnce(filePath, true),
  ageDetailCache: (workshopId: string, ageMs: number) => {
    const entry = workshopDetailCache.get(workshopId)
    if (entry) entry.fetchedAt = Date.now() - ageMs
  },
  sanitizeSteamSourceUrl,
  buildPowerShellWorkshopFetchScript,
  sanitizeSteamUserFacingMessage,
  parseWorkshopItems,
  detectHasMoreFromHtml,
  resolveHtmlPaginationMeta,
  resolvePaginationTotals,
  extractSsrWorkshopBrowseData,
  isKnownEmptyWorkshopBrowse,
  createCacheKey,
  normalizeQuery,
  normalizeSort,
  resolveQueryType,
  resolveBrowseSort,
  buildBrowseUrl,
  mapUnknownToSteamError,
  mapPublishedFileDetailToDto,
  parseSteamPersonaNameFromCommunityXml,
  resolveModLocalizedText,
  normalizeSteamRatingScore,
  resolveItemRating,
  parseLegacyWorkshopItemRating,
  enrichWorkshopItemRatings,
  clearWorkshopDetailCache: () => {
    workshopDetailCache.clear()
  },
  clearSteamModListCache: () => {
    steamModCache.clear()
    steamModInFlight.clear()
    steamBackgroundRefreshing.clear()
  },
  /**
   * 直接往列表缓存里塞一条记录，用来验证「过期但还在离线窗口内」的兜底行为。
   * 真实路径要写磁盘缓存 + 重启进程才能造出这个状态，测试里不必绕那一圈。
   */
  seedCacheEntry: (query: {
    keyword?: string
    page?: number
    pageSize?: number
    sort?: string
    trendDays?: number
  }, ageMs: number) => {
    const normalized = normalizeQuery(query)
    const cacheKey = createCacheKey(normalized)
    const fetchedAt = Date.now() - ageMs
    steamModCache.set(cacheKey, {
      fetchedAt,
      expiresAt: fetchedAt + CACHE_TTL_MS,
      staleExpiresAt: fetchedAt + STALE_CACHE_TTL_MS,
      offlineExpiresAt: fetchedAt + OFFLINE_CACHE_TTL_MS,
      data: {
        keyword: normalized.keyword,
        page: normalized.page,
        pageSize: normalized.requestedPageSize,
        sort: normalized.sort,
        trendDays: normalized.trendDays,
        hasMore: false,
        totalCount: 1,
        totalPages: 1,
        sourceUrl: 'https://steamcommunity.com/workshop/browse/',
        upstreamSource: 'html',
        items: [{
          workshopId: '1234567890',
          title: 'Cached Mod',
          previewImage: null,
          detailUrl: buildWorkshopDetailUrl('1234567890'),
          rating: null,
        }],
      },
    })
  },
  resetRuntimeForTests: resetSteamWorkshopRuntimeForTests,
}
