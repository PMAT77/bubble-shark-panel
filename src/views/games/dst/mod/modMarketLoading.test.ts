import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { it } from 'node:test'
import { build } from 'esbuild'
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc'
import { createRenderer, reactive, ref } from 'vue'
import type { SteamModListQueryResult, SteamModListMeta } from '../../../../../shared/contracts/mod'

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function marketResult(overrides: Partial<SteamModListMeta> = {}): SteamModListQueryResult {
  return {
    keyword: '', page: 1, pageSize: 20, sort: 'trend', trendDays: 7, hasMore: false, totalCount: 1, totalPages: 1,
    sourceUrl: 'https://steamcommunity.com/workshop/', pendingWorkshopIds: [],
    items: [{ workshopId: '123', title: 'Test Mod' } as SteamModListQueryResult['items'][number]],
    meta: { cached: false, stale: false, cacheAgeMs: 0, source: 'live', upstreamSource: 'html', fetchTraceId: 'fixture',
      dataFetchedAt: '2026-10-19T00:00:00Z', ...overrides },
  }
}

interface ModPage {
  activeTab: 'market' | 'subscribed'
  steamKeyword: string
  steamSort: string
  steamMods: SteamModListQueryResult['items']
  steamMeta: SteamModListMeta | null
  steamMetaText: string
  steamLoadError: string | null
  marketConnectionTitle: string
  marketEmptyDescription: string
  loadingSteam: boolean
  loadSteamMods: (resetPage?: boolean) => Promise<void>
  onInstanceChange: (id: string) => void
}

it('the real Mod page defers Steam, deduplicates loads, presents failures inline and rejects stale responses', async (t) => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.bsp-mod-page-'))
  const globals = globalThis as typeof globalThis & { __bspModPage?: unknown }
  const route = reactive({ query: {} as Record<string, string> })
  const settings = reactive({ mode: 'pc' })
  const canInstall = ref(true)
  const requests: Array<{ id: string, keyword?: string, signal: AbortSignal }> = []
  const notices: string[] = []
  const localRequests: unknown[] = []
  let respond: () => Promise<SteamModListQueryResult> = async () => ({ ...marketResult({ upstreamUnavailable: true }), items: [] })
  globals.__bspModPage = {
    route, settings, canInstall,
    api: {
      getModList: async (_id: string, options?: unknown) => {
        localRequests.push(options)
        return { data: { mods: [], instanceStatus: 'stopped' } }
      },
      getSteamModList: async (id: string, query: { keyword?: string }, { signal }: { signal: AbortSignal }) => {
        requests.push({ id, keyword: query.keyword, signal })
        return { data: await respond() }
      },
    },
    instanceApi: { getInstanceOptions: async () => ({ data: ['A', 'B'].map(id => ({ id, name: id, gameCode: '343050', status: 'stopped' })) }) },
    message: { error: (text: string) => notices.push(text) },
  }
  let unmount: (() => void) | undefined
  t.after(() => {
    unmount?.()
    delete globals.__bspModPage
    assert.equal(path.dirname(root), process.cwd())
    fs.rmSync(root, { recursive: true, force: true })
  })
  const pageFile = path.join(root, 'page.mjs')
  await build({
    entryPoints: [path.resolve('src/views/games/dst/mod/index.vue')], outfile: pageFile,
    bundle: true, platform: 'node', format: 'esm', external: ['vue', '@vueuse/core'], loader: { '.css': 'empty' },
    alias: { '@': path.resolve('src') },
    banner: { js: 'const useAppAuth=()=>({auth:p=>p!=="mod:install"||globalThis.__bspModPage.canInstall.value}); const useAppSettingsStore=()=>globalThis.__bspModPage.settings; const useRoute=()=>globalThis.__bspModPage.route; const useRouter=()=>({});' },
    plugins: [{ name: 'mod-page-fixture', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, args => {
        if (!args.path.endsWith(`${path.sep}mod${path.sep}index.vue`)) return { contents: 'import {h} from "vue"; export default {render:()=>h("div")}', loader: 'js' }
        const { descriptor } = parse(fs.readFileSync(args.path, 'utf8'))
        const script = compileScript(descriptor, { id: 'mod-market', genDefaultAs: 'ModPage' })
        const exposed = 'activeTab, steamKeyword, steamSort, steamMods, steamMeta, steamMetaText, steamLoadError, marketConnectionTitle, marketEmptyDescription, loadingSteam, loadSteamMods, onInstanceChange'
        const contents = script.content.replace('__expose();', '').replace('const __returned__ =', `__expose({ ${exposed} });\nconst __returned__ =`)
        const template = compileTemplate({ source: descriptor.template!.content, filename: args.path, id: 'mod-market', compilerOptions: { bindingMetadata: script.bindings } })
        assert.deepEqual(template.errors, [])
        return { contents: `${contents}\n${template.code.replace('export function render', 'function render')}\nModPage.render=render; export default ModPage;`, loader: 'ts' }
      })
      builder.onResolve({ filter: /^(?:@\/api\/modules\/(?:mod|instance)|@\/composables\/use(?:InstanceModState|TaskRowProgress)|@vueuse\/integrations\/useSortable|naive-ui|lucide-vue-next)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => {
        let contents
        if (args.path === 'naive-ui') contents = `import {h,inject,provide,toRef} from 'vue';
          const box={setup:(_p,{slots,attrs})=>()=>h('div',attrs,slots.default?.()??slots.empty?.()??[])};
          export {box as NAlert,box as NButton,box as NCard,box as NDataTable,box as NEmpty,box as NImage,box as NInput,box as NPagination,box as NRate,box as NSelect,box as NSwitch,box as NTag,box as NTooltip};
          export const NTabs={props:['value'],setup:(p,{slots})=>{provide('tab',toRef(p,'value'));return()=>h('div',null,slots.default?.())}};
          export const NTabPane={props:['name'],setup:(p,{slots})=>{const tab=inject('tab');return()=>tab.value===p.name?h('div',null,slots.default?.()):null}};
          export const useDialog=()=>({}); export const useNotification=()=>({}); export const useMessage=()=>globalThis.__bspModPage.message;`
        else if (args.path === 'lucide-vue-next') contents = 'export const GripVertical={}'
        else if (args.path.endsWith('useSortable')) contents = 'export const useSortable=()=>({option:()=>{}})'
        else if (args.path.endsWith('useTaskRowProgress')) contents = 'import {ref} from "vue"; export const useTaskRowProgress=()=>({surface:ref(null),reset:()=>{},scheduleMeasure:()=>{}})'
        else if (args.path.endsWith('useInstanceModState')) contents = 'import {ref} from "vue"; export const useInstanceModState=()=>({downloadingMods:ref([]),downloadQueue:ref(null),isPendingWorkshop:()=>false,restoreInstallJobs:()=>{},syncPendingWorkshopIds:()=>{},resetState:()=>{}})'
        else contents = `export default globalThis.__bspModPage.${args.path.endsWith('instance') ? 'instanceApi' : 'api'}`
        return { contents, loader: 'js' }
      })
    } }],
  })
  const { default: Component } = await import(pathToFileURL(pageFile).href)
  interface ViewNode { text: string, children: ViewNode[], parent: ViewNode | null, querySelector: () => null }
  const node = (text = ''): ViewNode => ({ text, children: [], parent: null, querySelector: () => null })
  const remove = (child: ViewNode) => {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
    child.parent = null
  }
  const renderer = createRenderer<ViewNode, ViewNode>({
    createElement: () => node(), createText: text => node(text), createComment: () => node(),
    insert(child, parent, anchor) { remove(child); parent.children.splice(anchor ? parent.children.indexOf(anchor) : parent.children.length, 0, child); child.parent = parent },
    remove, setText: (element, text) => { element.text = text }, setElementText: (element, text) => { element.text = text; element.children = [] },
    patchProp() {}, parentNode: element => element.parent, nextSibling: element => element.parent?.children[element.parent.children.indexOf(element) + 1] ?? null,
  })
  let container: ViewNode
  const text = (element: ViewNode): string => element.text + element.children.map(text).join('')
  const mount = () => {
    const app = renderer.createApp(Component)
    app.component('FaPageMain', { inheritAttrs: false, render() { return this.$slots.default?.() } })
    unmount = () => app.unmount()
    container = node()
    return app.mount(container) as unknown as ModPage
  }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let page = mount()
  await flush()
  assert.equal(page.activeTab, 'subscribed')
  assert.equal(localRequests.length, 1)
  assert.deepEqual(localRequests, [undefined], '首屏不自动请求补图')
  assert.equal(requests.length, 0)
  assert.match(text(container!), /直接订阅.*从本地导入/)
  settings.mode = 'mobile'
  await flush()
  assert.match(text(container!), /直接订阅.*从本地导入/)
  canInstall.value = false
  await flush()
  assert.doesNotMatch(text(container!), /直接订阅|从本地导入/)
  settings.mode = 'pc'
  canInstall.value = true
  await flush()
  page.steamKeyword = 'hidden'
  page.steamSort = 'mostrecent'
  await flush()
  t.mock.timers.tick(500)
  await flush()
  assert.equal(requests.length, 0, '隐藏市场的筛选变更不访问 Steam')

  page.activeTab = 'market'
  await flush()
  assert.equal(requests.length, 1)
  assert.equal(page.marketConnectionTitle, '暂时无法连接 Steam 创意工坊')
  assert.equal(page.marketEmptyDescription, '暂时无法连接 Steam 创意工坊')
  assert.match(text(container!), /重试.*代理配置说明/)
  page.activeTab = 'subscribed'
  await flush()
  page.activeTab = 'market'
  await flush()
  t.mock.timers.tick(2000)
  await flush()
  assert.equal(requests.length, 1, '失败后不因标签往返或定时器再次尝试')
  assert.deepEqual(notices, [])

  respond = async () => marketResult()
  await page.loadSteamMods()
  assert.equal(page.steamMods.length, 1)
  assert.equal(page.marketConnectionTitle, '')
  respond = async () => { throw new Error('Network Error') }
  await page.loadSteamMods()
  assert.equal(page.marketConnectionTitle, '市场列表加载失败')
  assert.equal(page.steamMods.length, 1, '同一查询失败保留已有内容')
  assert.equal(page.steamMeta?.offline, true)
  assert.match(page.steamMetaText, /离线缓存.*获取于/)
  assert.deepEqual(notices, [])

  page.steamKeyword = 'another'
  await flush()
  t.mock.timers.tick(400)
  await flush()
  assert.equal(page.steamMods.length, 0, '新查询不得沿用旧结果')
  assert.equal(page.marketConnectionTitle, '市场列表加载失败')
  respond = async () => ({ ...marketResult(), items: [], totalCount: 0, totalPages: 0 })
  await page.loadSteamMods()
  assert.equal(page.marketConnectionTitle, '')
  assert.equal(page.marketEmptyDescription, '未找到符合条件的 Mod')
  const emptyRequests = requests.length
  page.activeTab = 'subscribed'
  await flush()
  page.activeTab = 'market'
  await flush()
  assert.equal(requests.length, emptyRequests, '正常空结果也不会因标签切换反复加载')

  const releases: Array<(result: SteamModListQueryResult) => void> = []
  respond = () => new Promise(resolve => releases.push(resolve))
  const pending = page.loadSteamMods()
  const firstSignal = requests.at(-1)!.signal
  const pendingCount = requests.length
  await page.loadSteamMods()
  assert.equal(requests.length, pendingCount, '同一查询在途时刷新不重复请求')
  page.onInstanceChange('B')
  assert.equal(firstSignal.aborted, true)
  page.onInstanceChange('A')
  assert.equal(requests.at(-2)!.signal.aborted, true)
  releases[0](marketResult())
  releases[1](marketResult())
  await pending
  await flush()
  assert.equal(page.steamMods.length, 0, 'A → B → A 时旧代次响应无效')
  assert.equal(page.loadingSteam, true, '旧请求结束不能关闭新请求的加载状态')
  releases[2](marketResult({ cached: true, offline: true }))
  await flush()
  assert.equal(page.steamMods.length, 1)
  assert.equal(page.loadingSteam, false)
  assert.equal(page.marketConnectionTitle, '暂时无法连接 Steam 创意工坊')

  const leaving = page.loadSteamMods()
  const leavingSignal = requests.at(-1)!.signal
  unmount!()
  assert.equal(leavingSignal.aborted, true)
  releases[3]({ ...marketResult(), items: [] })
  await leaving
  assert.equal(page.steamMods.length, 1, '离开页面后迟到响应不再修改内容')

  route.query = { tab: 'market', instanceId: 'B' }
  respond = async () => marketResult()
  const beforeRemount = requests.length
  page = mount()
  await flush()
  assert.equal(page.activeTab, 'market')
  assert.equal(requests.length, beforeRemount + 1, '市场直达链接首屏只请求一次')
  assert.equal(requests.at(-1)!.id, 'B')
})
