<script setup lang="ts">
/** 当前账号的权限判定；按钮级隐藏用，后端仍是唯一的安全边界 */
const { auth: hasPermission } = useAppAuth()

import type { PlayerListEntry, PlayerListKind, PlayerProfileDto } from '@/api/modules/player'
import {
  NAlert,
  NButton,
  NCard,
  NEmpty,
  NInput,
  NModal,
  NSpin,
  NTabPane,
  NTabs,
  NTag,
  useDialog,
  useMessage,
} from 'naive-ui'
import { computed, reactive, ref, watch } from 'vue'
import apiInstance from '@/api/modules/instance'
import apiPlayer from '@/api/modules/player'
import { routeToDstRoomSettings } from '@/navigation/game-routes'
import { PLAYER_KU_ID_PATTERN } from '../../../../../../shared/constants/player'
import { splitRoomSettingsLinks, WHITELIST_DISABLED_WARNING } from '../playerListWarning'

const props = defineProps<{
  instanceId: string
  /** 白名单预留位；为 0 时白名单不生效 */
  whitelistSlots: number
  /** 当前在线玩家的 ID（用于在名单里标出「在线」） */
  onlineKuIds: string[]
  /** 房间是否正在运行：决定「移出黑名单」是否需要重启才能解封 */
  instanceRunning: boolean
}>()

const emit = defineEmits<{
  /** 名单发生变化（或房间被重启），父级据此刷新 */
  changed: []
}>()

defineOptions({
  name: 'DstPlayerListsPanel',
})

const message = useMessage()
const dialog = useDialog()

// 判断输入的是不是一串玩家 ID（而不是游戏名）。字符集与后端共用同一份：
// Klei userid 含 `-`（实测 KU_3rpxG-xy），漏掉它这类 ID 会被当成游戏名去搜索，
// 永远加不进名单。这里额外忽略大小写，容忍手输的小写 ku_。
const KU_ID_PATTERN = new RegExp(PLAYER_KU_ID_PATTERN.source, 'i')

const LIST_META: { kind: PlayerListKind, label: string, hint: string }[] = [
  { kind: 'admin', label: '管理员', hint: '管理员可在游戏内使用控制台命令。' },
  { kind: 'whitelist', label: '白名单', hint: '预留位大于 0 时，白名单用于给指定玩家保留席位。' },
  { kind: 'block', label: '黑名单', hint: '名单内的玩家无法加入房间。' },
]

interface ListState {
  entries: PlayerListEntry[]
  fileExists: boolean
  loading: boolean
  saving: boolean
  error: string | null
}

function createListState(): ListState {
  return { entries: [], fileExists: false, loading: false, saving: false, error: null }
}

const activeKind = ref<PlayerListKind>('admin')
const lists = reactive<Record<PlayerListKind, ListState>>({
  admin: createListState(),
  whitelist: createListState(),
  block: createListState(),
})

const slotsFromApi = ref<number | null>(null)
const whitelistSlots = computed(() => slotsFromApi.value ?? props.whitelistSlots)
const whitelistDisabled = computed(() => whitelistSlots.value <= 0)

/** 白名单没启用时不该再往里加人：加了也不生效，先去把预留位填成大于 0 */
function whitelistBlocked(kind: PlayerListKind): boolean {
  return kind === 'whitelist' && whitelistDisabled.value
}

const router = useRouter()

/** 点警告里的「房间设置」直接进这个实例的房间设置页 */
function goRoomSettings() {
  router.push(routeToDstRoomSettings(props.instanceId))
}

const keyword = ref('')
const searching = ref(false)
const candidates = ref<PlayerProfileDto[]>([])
const syncing = ref(false)

const noteTarget = ref<PlayerListEntry | null>(null)
const noteDraft = ref('')
const savingNote = ref(false)

const onlineSet = computed(() => new Set(props.onlineKuIds.map(kuId => kuId.toLowerCase())))

function labelOf(kind: PlayerListKind): string {
  return LIST_META.find(item => item.kind === kind)?.label ?? ''
}

function displayName(entry: PlayerListEntry): string {
  const name = (entry.name ?? '').trim()
  const note = (entry.note ?? '').trim()
  if (name && note) {
    return `${name}（${note}）`
  }
  return name || note || '（未取名）'
}

function isOnline(entry: PlayerListEntry): boolean {
  return onlineSet.value.has(entry.kuId.toLowerCase())
}

async function loadList(kind: PlayerListKind) {
  const state = lists[kind]
  state.loading = true
  state.error = null
  try {
    const { data } = await apiPlayer.getPlayerList(props.instanceId, kind)
    state.entries = data.entries
    state.fileExists = data.fileExists
    slotsFromApi.value = data.whitelistSlots
  }
  catch {
    state.entries = []
    state.error = '读取失败，请确认实例已安装后重试。'
  }
  finally {
    state.loading = false
  }
}

async function loadAll() {
  if (!props.instanceId) {
    return
  }
  candidates.value = []
  await Promise.all(LIST_META.map(item => loadList(item.kind)))
}

async function persist(kind: PlayerListKind, nextEntries: PlayerListEntry[]): Promise<boolean> {
  const state = lists[kind]
  state.saving = true
  try {
    const { data } = await apiPlayer.savePlayerList({
      instanceId: props.instanceId,
      kind,
      // 文件里只写玩家 ID：名字与备注是面板侧的信息，写进游戏名单文件有让整行失效的风险
      entries: nextEntries.map(entry => ({ kuId: entry.kuId })),
    })
    state.entries = data.entries
    state.fileExists = true
    emit('changed')
    return true
  }
  catch {
    message.error('保存失败，请稍后重试。')
    return false
  }
  finally {
    state.saving = false
  }
}

/** 加入名单：已有条目跳过，返回实际新增数量 */
async function addPlayers(kind: PlayerListKind, players: { kuId: string }[]): Promise<void> {
  const state = lists[kind]
  const existing = new Set(state.entries.map(entry => entry.kuId.toLowerCase()))
  const additions = players.filter(player => !existing.has(player.kuId.toLowerCase()))
  if (additions.length === 0) {
    message.warning(`这些玩家已经在${labelOf(kind)}名单里了`)
    return
  }
  const merged = [...state.entries, ...additions.map(player => ({ kuId: player.kuId }))]
  if (await persist(kind, merged)) {
    message.success(`已把 ${additions.length} 位玩家加入${labelOf(kind)}名单`)
  }
}

async function removeEntry(kind: PlayerListKind, kuId: string): Promise<boolean> {
  const state = lists[kind]
  if (await persist(kind, state.entries.filter(entry => entry.kuId !== kuId))) {
    message.success(`已移出${labelOf(kind)}名单`)
    return true
  }
  return false
}

/** 重启房间：让名单改动在运行中的房间里真正生效 */
async function restartRoom(): Promise<boolean> {
  try {
    await apiInstance.restartInstance(props.instanceId)
    message.success('房间已重启，名单改动现在完全生效')
    emit('changed')
    return true
  }
  catch {
    // 业务错误（端口冲突、内存不足等）由全局拦截器提示
    return false
  }
}

/**
 * 移出名单。
 *
 * 黑名单要单独对待：游戏只在启动时读取黑名单文件，运行中的房间把封禁记在内存里，
 * 光是删掉文件里那一行，人还是会被拒之门外（踩过一次坑）。
 * 所以房间在运行时直接问「要不要一并重启」，并把后果说清楚。
 *
 * 两个按钮都会发请求（移出名单，必要时还要重启房间），等待期间两个按钮一起转圈并禁用：
 * 重启要好几秒，点下去没反馈的话管理员只会以为没点上、再点一次。
 */
function confirmRemove(kind: PlayerListKind, entry: PlayerListEntry) {
  const busy = reactive({
    positive: { loading: false, disabled: false },
    negative: { loading: false, disabled: false },
  })
  function setBusy(value: boolean) {
    for (const side of [busy.positive, busy.negative]) {
      side.loading = value
      side.disabled = value
    }
  }

  if (kind === 'block' && props.instanceRunning) {
    dialog.warning({
      title: '移出黑名单',
      content: `房间正在运行，而游戏只在启动时读取黑名单：只把「${displayName(entry)}」移出名单，他仍然会被拒绝加入。要现在移出并重启房间吗？房间里的玩家会被断开。`,
      positiveText: '移出并重启',
      negativeText: '只移出',
      maskClosable: false,
      positiveButtonProps: busy.positive,
      negativeButtonProps: busy.negative,
      onPositiveClick: async () => {
        setBusy(true)
        try {
          if (await removeEntry(kind, entry.kuId)) {
            await restartRoom()
          }
        }
        finally {
          setBusy(false)
        }
      },
      onNegativeClick: async () => {
        setBusy(true)
        try {
          if (await removeEntry(kind, entry.kuId)) {
            message.warning('已移出黑名单，但需要重启房间后该玩家才能重新加入', { duration: 8000 })
          }
        }
        finally {
          setBusy(false)
        }
      },
    })
    return
  }

  dialog.warning({
    title: `移出${labelOf(kind)}名单`,
    content: kind === 'block'
      ? `将把「${displayName(entry)}」移出黑名单；房间未运行，下次启动即按新名单放行。`
      : `将把「${displayName(entry)}」移出${labelOf(kind)}名单。`,
    positiveText: '移出',
    negativeText: '取消',
    maskClosable: false,
    positiveButtonProps: busy.positive,
    onPositiveClick: async () => {
      setBusy(true)
      try {
        await removeEntry(kind, entry.kuId)
      }
      finally {
        setBusy(false)
      }
    },
  })
}

/**
 * 添加按钮的两种走法：
 * - 输入的是完整玩家 ID（可多个，用空格/逗号分隔）→ 直接加入；
 * - 输入的是游戏名 → 先搜档案，唯一命中就直接加入，多条命中则列出来让管理员挑。
 *   绝不拿名字直接去操作游戏，同名的人必须由管理员自己认。
 */
async function handleAdd() {
  const raw = keyword.value.trim()
  if (!raw) {
    return
  }
  const tokens = raw.split(/[\s,，;；]+/).filter(Boolean)
  if (tokens.length > 0 && tokens.every(token => KU_ID_PATTERN.test(token))) {
    await addPlayers(activeKind.value, tokens.map(kuId => ({ kuId })))
    keyword.value = ''
    candidates.value = []
    return
  }

  searching.value = true
  try {
    const { data } = await apiPlayer.searchProfiles(props.instanceId, raw)
    if (data.items.length === 0) {
      candidates.value = []
      message.warning('没找到这位玩家。可以填写完整的玩家 ID，或等他在线过一次之后再按名字添加。')
      return
    }
    if (data.items.length === 1) {
      await addPlayers(activeKind.value, [{ kuId: data.items[0].kuId }])
      keyword.value = ''
      candidates.value = []
      return
    }
    candidates.value = data.items
  }
  catch {
    // 业务错误由全局拦截器提示
  }
  finally {
    searching.value = false
  }
}

async function addCandidate(profile: PlayerProfileDto) {
  await addPlayers(activeKind.value, [{ kuId: profile.kuId }])
  candidates.value = []
  keyword.value = ''
}

function openNote(entry: PlayerListEntry) {
  noteTarget.value = entry
  noteDraft.value = entry.note ?? ''
}

async function saveNote() {
  const target = noteTarget.value
  if (!target) {
    return
  }
  savingNote.value = true
  try {
    await apiPlayer.saveProfileNote({
      instanceId: props.instanceId,
      kuId: target.kuId,
      note: noteDraft.value,
    })
    noteTarget.value = null
    await loadAll()
    message.success('备注已保存')
  }
  catch {
    // 业务错误由全局拦截器提示
  }
  finally {
    savingNote.value = false
  }
}

/** 从游戏日志里把历史玩家名捞回档案：老名单也能显示出名字 */
async function syncFromLogs() {
  syncing.value = true
  try {
    const { data } = await apiPlayer.syncProfiles(props.instanceId)
    await loadAll()
    if (data.hints === 0) {
      message.info('日志里还没有带玩家 ID 的记录，等玩家上线后会自动记录。')
      return
    }
    message.success(`从日志里读到 ${data.hints} 位玩家的记录，已补全 ${data.applied} 条档案`)
  }
  catch {
    // 业务错误由全局拦截器提示
  }
  finally {
    syncing.value = false
  }
}

function formatLastSeen(iso: string): string {
  if (!iso) {
    return '从未上线'
  }
  const time = new Date(iso)
  if (Number.isNaN(time.getTime())) {
    return '从未上线'
  }
  return `最后在线 ${time.toLocaleString()}`
}

watch(() => props.instanceId, () => {
  void loadAll()
}, { immediate: true })

defineExpose({ loadAll })
</script>

<template>
  <NCard title="玩家名单" size="small">
    <template #header-extra>
      <NButton size="tiny" :loading="syncing" @click="syncFromLogs" v-if="hasPermission('player:write')">
        从日志补全玩家名
      </NButton>
    </template>

    <NTabs v-model:value="activeKind" type="line" animated>
      <NTabPane
        v-for="item in LIST_META"
        :key="item.kind"
        :name="item.kind"
        :tab="`${item.label}（${lists[item.kind].entries.length}）`"
      >
        <NAlert
          v-if="item.kind === 'whitelist' && whitelistDisabled"
          type="warning"
          :bordered="false"
          class="mb-3"
        >
          <template
            v-for="(segment, segmentIndex) in splitRoomSettingsLinks(WHITELIST_DISABLED_WARNING)"
            :key="segmentIndex"
          >
            <NButton
              v-if="segment.link && hasPermission('room:read')"
              text
              type="primary"
              size="tiny"
              class="align-baseline px-0.5"
              @click="goRoomSettings"
            >
              {{ segment.text }}
            </NButton>
            <template v-else>{{ segment.text }}</template>
          </template>
        </NAlert>

        <div class="flex flex-wrap items-center gap-2">
          <NInput
            v-model:value="keyword"
            class="max-w-96"
            placeholder="游戏名或玩家 ID"
            :disabled="lists[item.kind].saving || searching || whitelistBlocked(item.kind)"
            @keyup.enter="handleAdd"
          />
          <NButton
            type="primary"
            :loading="searching"
            :disabled="!keyword.trim() || lists[item.kind].saving || whitelistBlocked(item.kind)"
            @click="handleAdd"
           v-if="hasPermission('player:write')">
            加入名单
          </NButton>
        </div>
        <p class="mt-2 text-xs text-muted-foreground">
          多个 ID 用空格或逗号分隔。
        </p>

        <div v-if="candidates.length > 0" class="mt-3 rounded-md border p-3">
          <p class="mb-2 text-xs text-muted-foreground">
            找到 {{ candidates.length }} 位可能的玩家，请确认后加入：
          </p>
          <ul class="flex flex-col gap-2">
            <li
              v-for="candidate in candidates"
              :key="candidate.kuId"
              class="flex flex-wrap items-center justify-between gap-2"
            >
              <div class="min-w-0">
                <p class="text-sm truncate">
                  {{ candidate.name || candidate.note || '（未取名）' }}
                  <NTag v-if="onlineSet.has(candidate.kuId.toLowerCase())" size="tiny" :bordered="false" type="success" class="ml-1">
                    在线
                  </NTag>
                </p>
                <p class="font-mono text-xs text-muted-foreground truncate">
                  {{ candidate.kuId }} · {{ formatLastSeen(candidate.lastSeenAt) }}
                </p>
              </div>
              <NButton size="small" @click="addCandidate(candidate)" v-if="hasPermission('player:write')">
                加入
              </NButton>
            </li>
          </ul>
        </div>

        <p class="mt-2 text-xs text-muted-foreground">
          {{ item.hint }}
        </p>

        <NSpin :show="lists[item.kind].loading" class="mt-3 block">
          <p v-if="lists[item.kind].error" class="text-sm text-rose-600 dark:text-rose-400">
            {{ lists[item.kind].error }}
          </p>
          <NEmpty
            v-else-if="lists[item.kind].entries.length === 0"
            size="small"
            description="名单为空"
          />
          <ul v-else class="flex flex-col gap-1">
            <li
              v-for="entry in lists[item.kind].entries"
              :key="entry.kuId"
              class="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-1.5"
            >
              <div class="min-w-0">
                <p class="text-sm truncate">
                  {{ displayName(entry) }}
                  <NTag v-if="isOnline(entry)" size="tiny" :bordered="false" type="success" class="ml-1">
                    在线
                  </NTag>
                </p>
                <p class="font-mono text-xs text-muted-foreground truncate">
                  {{ entry.kuId }}
                </p>
              </div>
              <div class="flex items-center gap-3">
                <NButton text size="small" :disabled="lists[item.kind].saving" @click="openNote(entry)">
                  备注
                </NButton>
                <NButton
                  text
                  type="error"
                  size="small"
                  :disabled="lists[item.kind].saving"
                  @click="confirmRemove(item.kind, entry)"
                  v-if="hasPermission('player:write')"
                >
                  移出
                </NButton>
              </div>
            </li>
          </ul>
        </NSpin>
      </NTabPane>
    </NTabs>

    <NModal
      :show="noteTarget !== null"
      preset="card"
      title="玩家备注名"
      class="max-w-md"
      @update:show="(value: boolean) => { if (!value) noteTarget = null }"
    >
      <p class="mb-2 text-xs text-muted-foreground">
        {{ noteTarget?.kuId }}
      </p>
      <NInput v-model:value="noteDraft" placeholder="例如：服主小号 / 常客老王" maxlength="64" show-count />
      <p class="mt-2 text-xs text-muted-foreground">
        备注只保存在面板里，不会写进游戏，也不会影响玩家能否加入。
      </p>
      <template #footer>
        <div class="flex justify-end gap-2">
          <NButton @click="noteTarget = null">
            取消
          </NButton>
          <NButton type="primary" :loading="savingNote" @click="saveNote" v-if="hasPermission('player.profile:write')">
            保存
          </NButton>
        </div>
      </template>
    </NModal>
  </NCard>
</template>
