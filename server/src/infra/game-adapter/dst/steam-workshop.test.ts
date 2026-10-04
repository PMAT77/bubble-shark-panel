import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it } from 'node:test'
import {
  __steamWorkshopTestUtils,
  fetchDstSteamWorkshopMods,
  fetchWorkshopFileDetail,
  fetchWorkshopModMetadata,
  getSteamUpstreamStatus,
  getSteamWorkshopMetricsSnapshot,
} from './steam-workshop.ts'

const originalFetch = globalThis.fetch
const testDir = path.dirname(fileURLToPath(import.meta.url))
const steamSampleHtmlPath = path.resolve(testDir, '../../../scripts/steam-sample.html')

function createSteamWorkshopHtml(page = 1, withRating = false): string {
  const nextPage = page + 1
  const ratingMarkup = withRating
    ? '<div class="fileRating" data-tooltip-html="&lt;b&gt;Positive ratings&lt;/b&gt;&lt;br&gt;80% of the 100 ratings are positive"></div>'
    : ''
  return `
  <div id="searchResultsRows">
    <div class="workshopItem" data-publishedfileid="1234567890">
      <a href="https://steamcommunity.com/sharedfiles/filedetails/?id=1234567890">
        <img class="workshopItemPreviewImage" src="https://example.com/a.png">
      </a>
      <div class="workshopItemTitle">Test &amp; Mod</div>
      ${ratingMarkup}
    </div></div>
  </div>
  <div class="workshopBrowsePagingControls">
    <a href="https://steamcommunity.com/workshop/browse/?appid=322330&p=${nextPage}">Next</a>
  </div>
  `
}

function createSsrWorkshopHtml(): string {
  const queryData = JSON.stringify({
    queries: [{
      state: {
        data: {
          current_page: 1,
          total_pages: 3,
          total_count: 2,
          next_cursor: 'abc',
          results: [
            {
              publishedfileid: '3733207761',
              title: 'SSR Test Mod',
              preview_url: 'https://example.com/ssr.png',
              star_rating: 4,
              total_votes: 44,
            },
            {
              publishedfileid: '3732945756',
              title: 'Another SSR Mod',
              preview_url: '',
            },
          ],
        },
      },
    }],
  })
  const payload = JSON.stringify({
    queryData,
  })
  const escaped = JSON.stringify(payload).slice(1, -1)
  return `<html><body><script>JSON.parse("${escaped}")</script></body></html>`
}

afterEach(() => {
  globalThis.fetch = originalFetch
  __steamWorkshopTestUtils.resetRuntimeForTests()
})

describe('steam workshop parser', () => {
  it('parses legacy item and detects next page', () => {
    const html = createSteamWorkshopHtml(1)
    const items = __steamWorkshopTestUtils.parseWorkshopItems(html)
    assert.equal(items.length, 1)
    assert.equal(items[0].workshopId, '1234567890')
    assert.equal(items[0].title, 'Test & Mod')
    assert.equal(__steamWorkshopTestUtils.detectHasMoreFromHtml(html, 1, 20), true)
  })

  it('parses SSR embedded workshop results', () => {
    const html = createSsrWorkshopHtml()
    const items = __steamWorkshopTestUtils.parseWorkshopItems(html)
    assert.equal(items.length, 2)
    assert.equal(items[0].workshopId, '3733207761')
    assert.equal(items[0].title, 'SSR Test Mod')
    assert.equal(items[0].previewImage, 'https://example.com/ssr.png')
    assert.equal(items[0].rating, 4)
    assert.equal(items[0].detailUrl, 'https://steamcommunity.com/sharedfiles/filedetails/?id=3733207761')
    const pagination = __steamWorkshopTestUtils.resolveHtmlPaginationMeta(html, 1, 20)
    assert.equal(pagination.totalCount, 2)
    assert.equal(pagination.totalPages, 3)
    assert.equal(pagination.hasMore, true)
    assert.equal(__steamWorkshopTestUtils.detectHasMoreFromHtml(html, 1, 20), true)
    assert.equal(__steamWorkshopTestUtils.resolveHtmlPaginationMeta(html, 3, 20).hasMore, false)
  })

  it('derives totalPages from totalCount when upstream pages missing', () => {
    const totals = __steamWorkshopTestUtils.resolvePaginationTotals({
      page: 1,
      pageSize: 20,
      totalCount: 1965,
      totalPages: null,
    })
    assert.equal(totals.totalPages, 99)
    assert.equal(totals.hasMore, true)
  })

  it('cache key includes schema version and page size', () => {
    const key = __steamWorkshopTestUtils.createCacheKey(__steamWorkshopTestUtils.normalizeQuery({
      keyword: '',
      page: 2,
      pageSize: 20,
      sort: 'trend',
      trendDays: 7,
    }))
    const parsed = JSON.parse(key) as { schemaVersion?: number, pageSize?: number, page?: number }
    assert.equal(parsed.schemaVersion, 10)
    assert.equal(parsed.pageSize, 20)
    assert.equal(parsed.page, 2)
  })

  it('normalizes relevance sort and maps to ranked-by-text-search query type', () => {
    assert.equal(__steamWorkshopTestUtils.normalizeSort('relevance'), 'relevance')
    assert.equal(__steamWorkshopTestUtils.resolveQueryType('relevance'), 12)
    assert.equal(__steamWorkshopTestUtils.resolveQueryType('mostrecent'), 1)
    assert.equal(__steamWorkshopTestUtils.resolveQueryType('totaluniquesubscribers'), 9)
    assert.equal(__steamWorkshopTestUtils.resolveQueryType('trend'), 3)
  })

  it('maps relevance browse sort to Steam textsearch URL parameter', () => {
    assert.equal(__steamWorkshopTestUtils.resolveBrowseSort('relevance'), 'textsearch')
    assert.equal(__steamWorkshopTestUtils.resolveBrowseSort('trend'), 'trend')
    const url = __steamWorkshopTestUtils.buildBrowseUrl('backpack', 1, 20, 'relevance', 7)
    assert.match(url, /browsesort=textsearch/)
    assert.match(url, /actualsort=textsearch/)
    assert.match(url, /searchtext=backpack/)
    assert.match(url, /requiredtags(%5B%5D|\[\])=server_only_mod/)
  })

  it('parses real Steam SSR sample when available', () => {
    if (!fs.existsSync(steamSampleHtmlPath)) {
      return
    }
    const html = fs.readFileSync(steamSampleHtmlPath, 'utf8')
    const items = __steamWorkshopTestUtils.parseWorkshopItems(html)
    assert.ok(items.length > 0)
    assert.equal(typeof items[0].workshopId, 'string')
    assert.equal(typeof items[0].title, 'string')
    assert.equal(__steamWorkshopTestUtils.detectHasMoreFromHtml(html, 1, 20), true)
    assert.equal(__steamWorkshopTestUtils.isKnownEmptyWorkshopBrowse(html), false)
  })

  it('parses legacy item rating from fileRating tooltip', () => {
    const html = createSteamWorkshopHtml(1, true)
    const items = __steamWorkshopTestUtils.parseWorkshopItems(html)
    assert.equal(items.length, 1)
    assert.equal(items[0].rating, 4)
  })

  it('enriches missing ratings via GetDetails when api key is set', async () => {
    const previousKey = process.env.GSH_STEAM_WEBAPI_KEY
    process.env.GSH_STEAM_WEBAPI_KEY = 'test-key'
    try {
      globalThis.fetch = async (input: string | URL | Request) => {
        const url = String(input)
        if (url.includes('GetDetails')) {
          assert.ok(url.includes('includevotes=true'))
          return new Response(JSON.stringify({
            response: {
              publishedfiledetails: [{
                publishedfileid: '1234567890',
                title: 'Rated Mod',
                vote_data: { score: 0.9 },
              }],
            },
          }), { status: 200 })
        }
        return new Response('', { status: 404 })
      }
      const items = [{
        workshopId: '1234567890',
        title: 'Rated Mod',
        previewImage: null,
        detailUrl: 'https://example.com',
        rating: null,
      }]
      await __steamWorkshopTestUtils.enrichWorkshopItemRatings(items)
      assert.equal(items[0].rating, 4.5)
    }
    finally {
      if (previousKey === undefined) {
        delete process.env.GSH_STEAM_WEBAPI_KEY
      }
      else {
        process.env.GSH_STEAM_WEBAPI_KEY = previousKey
      }
    }
  })
})

describe('fetchDstSteamWorkshopMods', () => {
  it('retries on 429 and eventually returns live payload', async () => {
    const uniqueKeyword = `retry-${Date.now()}`
    let requestCount = 0
    globalThis.fetch = async () => {
      requestCount += 1
      if (requestCount === 1) {
        return new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } })
      }
      return new Response(createSteamWorkshopHtml(1), { status: 200 })
    }
    const result = await fetchDstSteamWorkshopMods({
      keyword: uniqueKeyword,
      page: 1,
      pageSize: 20,
      sort: 'trend',
      trendDays: 7,
      subscribedModStatusByWorkshopId: new Map(),
    })
    assert.ok(requestCount >= 2)
    assert.equal(result.meta.source, 'live')
    assert.equal(result.meta.upstreamSource, 'html')
    assert.equal(result.meta.cached, false)
    assert.equal(result.items.length, 1)
  })

  it('maps subscribed mod status onto steam list items', async () => {
    __steamWorkshopTestUtils.clearSteamModListCache()
    globalThis.fetch = async () => new Response(createSteamWorkshopHtml(1), { status: 200 })
    const result = await fetchDstSteamWorkshopMods({
      keyword: `subscribed-${Date.now()}`,
      page: 1,
      pageSize: 20,
      sort: 'trend',
      trendDays: 7,
      subscribedModStatusByWorkshopId: new Map([['1234567890', 'failed']]),
    })
    assert.equal(result.items.length, 1)
    assert.equal(result.items[0]?.subscribed, true)
    assert.equal(result.items[0]?.subscribeStatus, 'failed')
    assert.equal(result.items[0]?.installed, false)
    assert.equal(result.items[0]?.pendingDownload, false)
  })

  it('exposes metrics snapshot structure', () => {
    const snapshot = getSteamWorkshopMetricsSnapshot()
    assert.equal(typeof snapshot.steam_fetch_success_total, 'number')
    assert.equal(typeof snapshot.steam_fetch_success_by_source.html, 'number')
    assert.equal(typeof snapshot.steam_cache_hit_total.fresh, 'number')
    assert.equal(typeof snapshot.steam_circuit_open_total, 'number')
  })

  it('builds a valid PowerShell fetch script for workshop URLs', () => {
    const url = 'https://steamcommunity.com/workshop/browse/?appid=322330&requiredtags%5B%5D=server_only_mod&section=readytouseitems&p=1'
    const script = __steamWorkshopTestUtils.buildPowerShellWorkshopFetchScript(url)
    assert.ok(!script.includes('@{;'))
    assert.ok(script.includes(`'${url}'`))
    assert.ok(!script.includes('param([string]$Url)'))
  })

  it('sanitizes technical PowerShell errors for user-facing messages', () => {
    const technical = 'Command failed: powershell -NoProfile -Command $headers = @{; At line:1 char:156 ParserError'
    const sanitized = __steamWorkshopTestUtils.sanitizeSteamUserFacingMessage(technical)
    assert.equal(sanitized, '无法连接 Steam 创意工坊')
    const mapped = __steamWorkshopTestUtils.mapUnknownToSteamError(new Error(technical))
    assert.equal(mapped.code, 'STEAM_UPSTREAM_UNAVAILABLE')
    assert.equal(mapped.message, '无法连接 Steam 创意工坊')
  })

  it('returns degraded empty result when live fetch fails without cache', async () => {
    __steamWorkshopTestUtils.clearSteamModListCache()
    const keyword = `degraded-${Date.now()}`
    const previousFallbackFlag = process.env.GSH_STEAM_WORKSHOP_DISABLE_POWERSHELL_FALLBACK
    process.env.GSH_STEAM_WORKSHOP_DISABLE_POWERSHELL_FALLBACK = '1'
    globalThis.fetch = async () => new Response('upstream down', { status: 503 })
    try {
      const result = await fetchDstSteamWorkshopMods({
        keyword,
        page: 1,
        pageSize: 20,
        sort: 'trend',
        trendDays: 7,
        subscribedModStatusByWorkshopId: new Map(),
      })
      assert.equal(result.items.length, 0)
      assert.equal(result.meta.upstreamUnavailable, true)
      assert.equal(result.meta.upstreamMessage, '暂时无法连接 Steam 创意工坊，请稍后点击刷新重试')
      assert.equal(result.meta.steamErrorCode, 'STEAM_UPSTREAM_UNAVAILABLE')
    }
    finally {
      if (previousFallbackFlag === undefined) {
        delete process.env.GSH_STEAM_WORKSHOP_DISABLE_POWERSHELL_FALLBACK
      }
      else {
        process.env.GSH_STEAM_WORKSHOP_DISABLE_POWERSHELL_FALLBACK = previousFallbackFlag
      }
    }
  })

  it('falls back to the offline window instead of an empty list', async () => {
    __steamWorkshopTestUtils.clearSteamModListCache()
    const keyword = `offline-${Date.now()}`
    const previousFallbackFlag = process.env.GSH_STEAM_WORKSHOP_DISABLE_POWERSHELL_FALLBACK
    process.env.GSH_STEAM_WORKSHOP_DISABLE_POWERSHELL_FALLBACK = '1'
    // 8 天前拉到过、早已过了 30 分钟的 stale 窗口，但还在 7 天离线窗口…… 这里用 8 天
    // 之内的值：默认离线窗口是 7 天，所以取 3 天前，确保仍在窗口内
    __steamWorkshopTestUtils.seedCacheEntry(
      { keyword, page: 1, pageSize: 20, sort: 'trend', trendDays: 7 },
      3 * 24 * 60 * 60 * 1000,
    )
    globalThis.fetch = async () => new Response('upstream down', { status: 503 })
    try {
      const result = await fetchDstSteamWorkshopMods({
        keyword,
        page: 1,
        pageSize: 20,
        sort: 'trend',
        trendDays: 7,
        subscribedModStatusByWorkshopId: new Map(),
      })
      // 关键：有内容（不是空白页），并且明确标注为离线数据
      assert.equal(result.items.length, 1)
      assert.equal(result.items[0]?.title, 'Cached Mod')
      assert.equal(result.meta.offline, true)
      assert.equal(result.meta.stale, true)
      assert.ok(result.meta.dataFetchedAt)
      // 有数据就不该同时报「上游不可用」，否则前端会把列表清掉
      assert.notEqual(result.meta.upstreamUnavailable, true)
    }
    finally {
      if (previousFallbackFlag === undefined) {
        delete process.env.GSH_STEAM_WORKSHOP_DISABLE_POWERSHELL_FALLBACK
      }
      else {
        process.env.GSH_STEAM_WORKSHOP_DISABLE_POWERSHELL_FALLBACK = previousFallbackFlag
      }
    }
  })

  it('still reports upstream unavailable when the cache is older than the offline window', async () => {
    __steamWorkshopTestUtils.clearSteamModListCache()
    const keyword = `expired-${Date.now()}`
    const previousFallbackFlag = process.env.GSH_STEAM_WORKSHOP_DISABLE_POWERSHELL_FALLBACK
    process.env.GSH_STEAM_WORKSHOP_DISABLE_POWERSHELL_FALLBACK = '1'
    // 30 天前：超出默认 7 天离线窗口，此时只能老实降级
    __steamWorkshopTestUtils.seedCacheEntry(
      { keyword, page: 1, pageSize: 20, sort: 'trend', trendDays: 7 },
      30 * 24 * 60 * 60 * 1000,
    )
    globalThis.fetch = async () => new Response('upstream down', { status: 503 })
    try {
      const result = await fetchDstSteamWorkshopMods({
        keyword,
        page: 1,
        pageSize: 20,
        sort: 'trend',
        trendDays: 7,
        subscribedModStatusByWorkshopId: new Map(),
      })
      assert.equal(result.items.length, 0)
      assert.equal(result.meta.upstreamUnavailable, true)
      assert.notEqual(result.meta.offline, true)
    }
    finally {
      if (previousFallbackFlag === undefined) {
        delete process.env.GSH_STEAM_WORKSHOP_DISABLE_POWERSHELL_FALLBACK
      }
      else {
        process.env.GSH_STEAM_WORKSHOP_DISABLE_POWERSHELL_FALLBACK = previousFallbackFlag
      }
    }
  })

  it('reports the upstream source chain without hitting the network', () => {
    const status = getSteamUpstreamStatus()
    assert.ok(Array.isArray(status.configuredSources))
    assert.ok(status.sourceOrder.length > 0, '至少 HTML 源应当可用')
    assert.ok(Array.isArray(status.openSources))
    assert.equal(typeof status.proxy.enabled, 'boolean')
  })
})

describe('resolveModLocalizedText', () => {
  it('prefers zh-CN when available', () => {
    const resolved = __steamWorkshopTestUtils.resolveModLocalizedText({
      'zh-CN': '中文描述',
      'en-US': 'English description',
    }, 'zh-CN')
    assert.equal(resolved.value, '中文描述')
    assert.equal(resolved.contentLocale, 'zh-CN')
  })

  it('falls back to en-US when zh-CN missing', () => {
    const resolved = __steamWorkshopTestUtils.resolveModLocalizedText({
      'en-US': 'English only',
    }, 'zh-CN')
    assert.equal(resolved.value, 'English only')
    assert.equal(resolved.contentLocale, 'en-US')
  })

  it('returns empty string when map has no content', () => {
    const resolved = __steamWorkshopTestUtils.resolveModLocalizedText({}, 'zh-CN')
    assert.equal(resolved.value, '')
    assert.equal(resolved.contentLocale, 'zh-CN')
  })
})

describe('fetchWorkshopFileDetail', () => {
  it('maps published file detail fields', () => {
    const dto = __steamWorkshopTestUtils.mapPublishedFileDetailToDto({
      publishedfileid: '1234567890',
      result: 1,
      title: 'Test Mod',
      description: 'A test mod description',
      preview_url: 'https://example.com/preview.png',
      file_size: 2048,
      time_created: 1_700_000_000,
      time_updated: 1_800_000_000,
      tags: [{ tag: 'server_only_mod' }, { tag: 'Mod' }],
    })
    assert.equal(dto.workshopId, '1234567890')
    assert.equal(dto.title, 'Test Mod')
    assert.equal(dto.description, 'A test mod description')
    assert.equal(dto.previewImage, 'https://example.com/preview.png')
    assert.equal(dto.fileSize, 2048)
    assert.deepEqual(dto.tags, ['server_only_mod', 'Mod'])
    assert.equal(dto.publishedAt, new Date(1_700_000_000 * 1000).toISOString())
    assert.equal(dto.updatedAt, new Date(1_800_000_000 * 1000).toISOString())
    assert.equal(dto.detailUrl, 'https://steamcommunity.com/sharedfiles/filedetails/?id=1234567890')
    assert.equal(dto.creatorName, null)
    assert.equal(dto.contentLocale, 'zh-CN')
    assert.equal(dto.titles['zh-CN'], 'Test Mod')
    assert.equal(dto.descriptions['zh-CN'], 'A test mod description')
  })

  it('parses creator name from community profile xml', () => {
    const name = __steamWorkshopTestUtils.parseSteamPersonaNameFromCommunityXml(
      '<?xml version="1.0"?><profile><steamID><![CDATA[Mod Author]]></steamID></profile>',
    )
    assert.equal(name, 'Mod Author')
  })

  it('fetches detail from Steam API and uses cache', async () => {
    __steamWorkshopTestUtils.clearWorkshopDetailCache()
    let requestCount = 0
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      requestCount += 1
      const url = String(input)
      if (url.includes('GetPlayerSummaries')) {
        return new Response(JSON.stringify({
          response: {
            players: [{ personaname: 'Workshop Creator' }],
          },
        }), { status: 200 })
      }
      if (url.includes('steamcommunity.com/profiles/')) {
        return new Response('', { status: 404 })
      }
      const headers = init?.headers
      let acceptLanguage = ''
      if (headers instanceof Headers) {
        acceptLanguage = headers.get('Accept-Language') ?? ''
      }
      else if (headers && typeof headers === 'object') {
        acceptLanguage = String((headers as Record<string, string>)['Accept-Language'] ?? '')
      }
      const isEnglish = acceptLanguage.startsWith('en-US')
      return new Response(JSON.stringify({
        response: {
          publishedfiledetails: [{
            publishedfileid: '9876543210',
            result: 1,
            creator: '76561198987654321',
            title: isEnglish ? 'English Mod' : '中文 Mod',
            description: isEnglish ? 'English body' : '中文描述',
            preview_url: 'https://example.com/cached.png',
            file_size: 4096,
            time_created: 1_700_000_000,
            time_updated: 1_800_000_000,
            tags: [{ tag: 'Mod' }],
          }],
        },
      }), { status: 200 })
    }
    const first = await fetchWorkshopFileDetail('9876543210')
    const second = await fetchWorkshopFileDetail('9876543210')
    assert.equal(requestCount, 3)
    assert.equal(first.title, '中文 Mod')
    assert.equal(first.description, '中文描述')
    assert.equal(first.contentLocale, 'zh-CN')
    assert.equal(first.titles['zh-CN'], '中文 Mod')
    assert.equal(first.titles['en-US'], 'English Mod')
    assert.equal(second.title, '中文 Mod')
    assert.equal(first.fileSize, 4096)
    assert.equal(first.creatorName, 'Workshop Creator')
  })

  it('resolves en-US locale from cache without refetch', async () => {
    __steamWorkshopTestUtils.clearWorkshopDetailCache()
    let requestCount = 0
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      requestCount += 1
      const url = String(input)
      if (url.includes('GetPublishedFileDetails')) {
        const headers = init?.headers
        let acceptLanguage = ''
        if (headers instanceof Headers) {
          acceptLanguage = headers.get('Accept-Language') ?? ''
        }
        else if (headers && typeof headers === 'object') {
          acceptLanguage = String((headers as Record<string, string>)['Accept-Language'] ?? '')
        }
        const isEnglish = acceptLanguage.startsWith('en-US')
        return new Response(JSON.stringify({
          response: {
            publishedfiledetails: [{
              publishedfileid: '555',
              result: 1,
              title: isEnglish ? 'English Mod' : '中文 Mod',
              description: isEnglish ? 'English body' : '中文描述',
            }],
          },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ response: { players: [] } }), { status: 200 })
    }
    await fetchWorkshopFileDetail('555')
    requestCount = 0
    const english = await fetchWorkshopFileDetail('555', 'en-US')
    assert.equal(requestCount, 0)
    assert.equal(english.title, 'English Mod')
    assert.equal(english.description, 'English body')
    assert.equal(english.contentLocale, 'en-US')
  })

  it('throws when mod detail is unavailable', async () => {
    __steamWorkshopTestUtils.clearWorkshopDetailCache()
    globalThis.fetch = async () => new Response(JSON.stringify({
      response: {
        publishedfiledetails: [{
          publishedfileid: '111',
          result: 9,
        }],
      },
    }), { status: 200 })
    await assert.rejects(
      () => fetchWorkshopFileDetail('111'),
      (error: unknown) => error instanceof Error && error.message.includes('Mod 不存在'),
    )
  })

  it('normalizes steam rating score to 0-5 stars', () => {
    assert.equal(__steamWorkshopTestUtils.normalizeSteamRatingScore(0.555555582046508789), 2.8)
    assert.equal(__steamWorkshopTestUtils.normalizeSteamRatingScore(1), 5)
    assert.equal(__steamWorkshopTestUtils.normalizeSteamRatingScore(null), null)
  })

  it('resolves vote_data score to star rating', () => {
    assert.equal(__steamWorkshopTestUtils.resolveItemRating({
      vote_data: { score: 0.8 },
    }), 4)
  })

  it('resolves votes_up and votes_down to star rating', () => {
    assert.equal(__steamWorkshopTestUtils.resolveItemRating({
      vote_data: { votes_up: 80, votes_down: 20 },
    }), 4)
  })

  it('treats star_rating -1 as missing rating', () => {
    assert.equal(__steamWorkshopTestUtils.resolveItemRating({
      star_rating: -1,
    }), null)
  })
})

describe('fetchWorkshopModMetadata', () => {
  function mockPublishedFileDetails(
    items: Array<{ id: string, title?: string, preview?: string, updated?: number, size?: number }>,
    options?: { status?: number, onRequest?: (body: string) => void },
  ) {
    let requestCount = 0
    globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      requestCount += 1
      options?.onRequest?.(String(init?.body ?? ''))
      if (options?.status && options.status !== 200) {
        return new Response('nope', { status: options.status })
      }
      return new Response(JSON.stringify({
        response: {
          publishedfiledetails: items.map(item => ({
            publishedfileid: item.id,
            result: 1,
            title: item.title,
            preview_url: item.preview,
            time_updated: item.updated,
            file_size: item.size,
          })),
        },
      }), { status: 200 })
    }
    return () => requestCount
  }

  it('maps title, preview image and version time per workshop id', async () => {
    const requests = mockPublishedFileDetails([
      { id: '111', title: ' 空格 Mod ', preview: 'https://example.com/a.png', updated: 1_800_000_000, size: 2048 },
      { id: '222', title: '', updated: undefined },
    ])
    const result = await fetchWorkshopModMetadata(['111', '222', '111'])
    assert.equal(result.ok, true)
    assert.equal(requests(), 1)
    assert.equal(result.items.get('111')?.title, '空格 Mod')
    assert.equal(result.items.get('111')?.previewImage, 'https://example.com/a.png')
    assert.equal(result.items.get('111')?.updatedAt, new Date(1_800_000_000 * 1000).toISOString())
    assert.equal(result.items.get('111')?.fileSize, 2048)
    // 上游没给标题/版本时间 → null（版本判定会落到「未知」而不是「已最新」）
    assert.equal(result.items.get('222')?.title, null)
    assert.equal(result.items.get('222')?.updatedAt, null)
  })

  it('caches results until force is requested', async () => {
    const requests = mockPublishedFileDetails([{ id: '333', title: 'Cached Mod', updated: 1_700_000_000 }])
    await fetchWorkshopModMetadata(['333'])
    await fetchWorkshopModMetadata(['333'])
    assert.equal(requests(), 1)
    await fetchWorkshopModMetadata(['333'], { force: true })
    assert.equal(requests(), 2)
  })

  it('splits oversized id lists into multiple batches', async () => {
    const requests = mockPublishedFileDetails([{ id: '1', title: 'Batch Mod', updated: 1_700_000_000 }])
    const ids = Array.from({ length: 205 }, (_value, index) => String(index + 1))
    const result = await fetchWorkshopModMetadata(ids)
    assert.equal(requests(), 3)
    assert.equal(result.ok, true)
  })

  it('keeps the batch result when one batch fails and reports upstream failure', async () => {
    let calls = 0
    globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      calls += 1
      if (calls > 1) {
        return new Response('boom', { status: 503 })
      }
      const body = String(init?.body ?? '')
      const firstId = /publishedfileids\[0\]=(\d+)/.exec(body)?.[1] ?? '1'
      return new Response(JSON.stringify({
        response: {
          publishedfiledetails: [{ publishedfileid: firstId, result: 1, title: 'Part Mod', time_updated: 1_800_000_000 }],
        },
      }), { status: 200 })
    }
    const ids = Array.from({ length: 150 }, (_value, index) => String(index + 1))
    const result = await fetchWorkshopModMetadata(ids)
    assert.equal(result.ok, false)
    assert.equal(Boolean(result.message), true)
    // 成功的批次照常返回，失败批次不写入「查无此 Mod」的结论
    assert.equal(result.items.get('1')?.title, 'Part Mod')
    assert.equal(result.items.has('101'), false)
  })

  it('returns an empty successful result for empty input', async () => {
    const requests = mockPublishedFileDetails([])
    const result = await fetchWorkshopModMetadata([])
    assert.equal(result.ok, true)
    assert.equal(result.items.size, 0)
    assert.equal(requests(), 0)
  })
})


describe('offline detail persistence and shared metadata requests', () => {
  it('persists details atomically, prunes expired lists and preserves fetched time on offline fallback', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsh-workshop-cache-'))
    const file = path.join(root, 'cache.json')
    __steamWorkshopTestUtils.resetRuntimeForTests()
    globalThis.fetch = async () => new Response(JSON.stringify({ response: { publishedfiledetails: [{ publishedfileid: '910', result: 1, title: 'Stored', description: 'Offline content' }] } }), { status: 200 })
    try {
      await fetchWorkshopFileDetail('910')
      __steamWorkshopTestUtils.ageDetailCache('910', 6 * 60_000)
      __steamWorkshopTestUtils.seedCacheEntry({ keyword: 'expired-entry' }, 8 * 24 * 60 * 60_000)
      __steamWorkshopTestUtils.persistCacheTo(file)
      const persisted = JSON.parse(fs.readFileSync(file, 'utf8'))
      assert.equal(Object.keys(persisted.entries).length, 0)
      const fetchedAt = new Date(persisted.details['910'].fetchedAt).toISOString()
      assert.equal(fs.existsSync(file + '.tmp'), false)
      __steamWorkshopTestUtils.resetRuntimeForTests()
      __steamWorkshopTestUtils.loadCacheFrom(file)
      globalThis.fetch = async () => { throw new Error('offline') }
      const result = await fetchWorkshopFileDetail('910')
      assert.equal(result.title, 'Stored')
      assert.equal(result.cache?.source, 'cache-offline')
      assert.equal(result.cache?.fetchedAt, fetchedAt)
    }
    finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('coalesces identical ID sets regardless of their order', async () => {
    __steamWorkshopTestUtils.resetRuntimeForTests()
    let count = 0
    let release!: (response: Response) => void
    globalThis.fetch = async () => { count += 1; return new Promise(resolve => release = resolve) }
    const first = fetchWorkshopModMetadata(['921', '920'], { force: true })
    const second = fetchWorkshopModMetadata(['920', '921'], { force: true })
    release(new Response(JSON.stringify({ response: { publishedfiledetails: [
      { publishedfileid: '920', result: 1, title: 'A' }, { publishedfileid: '921', result: 1, title: 'B' },
    ] } }), { status: 200 }))
    const results = await Promise.all([first, second])
    assert.equal(count, 1)
    assert.equal(results[0].items.size, 2)
    assert.equal(results[1].items.size, 2)
  })

  it('does not wait beyond the request budget for Retry-After', async () => {
    __steamWorkshopTestUtils.resetRuntimeForTests()
    let count = 0
    globalThis.fetch = async () => { count += 1; return new Response('', { status: 429, headers: { 'Retry-After': '99999' } }) }
    const result = await fetchDstSteamWorkshopMods({ keyword: 'budget-' + Date.now(), subscribedModStatusByWorkshopId: new Map() })
    assert.equal(result.meta?.upstreamUnavailable, true)
    assert.equal(count, 1)
  })

  it('redacts credentials and API keys from public source links', () => {
    const safe = __steamWorkshopTestUtils.sanitizeSteamSourceUrl('https://name:password@example.test/path?key=secret&token=hidden&page=2')
    assert.equal(safe, 'https://example.test/path?page=2')
    assert.equal(__steamWorkshopTestUtils.sanitizeSteamSourceUrl('javascript:alert(1)'), '')
  })

  it('preserves the list acquisition time and reports a failed stale refresh as offline', async () => {
    const previous = process.env.GSH_STEAM_WORKSHOP_DISABLE_POWERSHELL_FALLBACK
    process.env.GSH_STEAM_WORKSHOP_DISABLE_POWERSHELL_FALLBACK = '1'
    const keyword = 'stale-status'
    __steamWorkshopTestUtils.seedCacheEntry({ keyword }, 3 * 60_000)
    globalThis.fetch = async () => { throw new Error('offline') }
    try {
      const first = await fetchDstSteamWorkshopMods({ keyword, subscribedModStatusByWorkshopId: new Map() })
      const acquired = first.meta.dataFetchedAt
      assert.ok(acquired)
      assert.ok(Date.now() - Date.parse(acquired) >= 3 * 60_000)
      await __steamWorkshopTestUtils.waitForListRefresh({ keyword })
      const next = await fetchDstSteamWorkshopMods({ keyword, subscribedModStatusByWorkshopId: new Map() })
      assert.equal(next.meta.offline, true)
      assert.equal(next.meta.dataFetchedAt, acquired)
      assert.equal(next.items.length, first.items.length)
    }
    finally {
      await __steamWorkshopTestUtils.waitForListRefresh({ keyword })
      if (previous === undefined) delete process.env.GSH_STEAM_WORKSHOP_DISABLE_POWERSHELL_FALLBACK
      else process.env.GSH_STEAM_WORKSHOP_DISABLE_POWERSHELL_FALLBACK = previous
    }
  })

})
