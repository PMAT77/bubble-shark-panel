<script setup lang="ts">
/** 当前账号的权限判定；按钮级隐藏用，后端仍是唯一的安全边界 */
const { auth: hasPermission } = useAppAuth()

import type { PlayerListKind, PlayerOnlineEntry, PlayerOnlineRosterDto, PlayerShard } from '@/api/modules/player'
import { NButton, NCard, NEmpty, NSpace, NSpin, NTag } from 'naive-ui'
import { computed } from 'vue'

const props = defineProps<{
  roster: PlayerOnlineRosterDto | null
  loading: boolean
  /** 正在对该玩家执行操作的 ID：期间禁用所有操作按钮，避免重复点 */
  actingKuId: string | null
}>()

const emit = defineEmits<{
  kick: [player: PlayerOnlineEntry]
  ban: [player: PlayerOnlineEntry]
  addToList: [payload: { player: PlayerOnlineEntry, kind: PlayerListKind }]
}>()

defineOptions({
  name: 'DstPlayerOnlinePanel',
})

const SHARD_LABELS: Record<PlayerShard, string> = {
  master: '地上',
  caves: '洞穴',
}

/** 按世界分组展示：同一个人只会在其中一个世界里 */
const groups = computed(() => {
  const roster = props.roster
  if (!roster) {
    return []
  }
  const shards: PlayerShard[] = roster.shards.caves.configured ? ['master', 'caves'] : ['master']
  return shards.map(shard => ({
    shard,
    label: SHARD_LABELS[shard],
    running: roster.shards[shard].running,
    queried: roster.shards[shard].players !== null,
    players: roster.players.filter(player => player.shard === shard),
    /** 有人却列不出来的数量：游戏没给出可用 ID */
    unlistedCount: roster.shards[shard].unlistedCount,
  }))
})

const acting = computed(() => props.actingKuId !== null)

const emptyDescription = computed(() => {
  const roster = props.roster
  if (!roster) {
    return '正在获取在线玩家…'
  }
  if (!roster.running) {
    return '房间未运行，启动后即可在这里看到在线玩家'
  }
  if (roster.partial) {
    return '这次没能取到完整的在线玩家，稍后会自动重试'
  }
  if (roster.unlistedPlayerCount > 0) {
    // 人数与实例详情页同源（游戏侧读数）：这里确实有人，只是拿不到可列的 ID
    return `房间里有 ${roster.unlistedPlayerCount} 人在线，但游戏没有给出可用的玩家 ID，列不出来`
  }
  return '当前没有玩家在线'
})

function displayName(player: PlayerOnlineEntry): string {
  return player.name.trim() || '（未取名）'
}

/** 没有 Klei 账号的玩家可能拿不到 ID，别显示成空白让人以为是渲染坏了 */
function displayId(player: PlayerOnlineEntry): string {
  return player.kuId.trim() || '游戏未给出 ID'
}
</script>

<template>
  <NCard title="在线玩家" size="small">
    <template #header-extra>
      <span class="text-xs text-muted-foreground">每 15 秒自动刷新</span>
    </template>

    <NSpin :show="loading && !roster">
      <NEmpty v-if="!roster || roster.players.length === 0" :description="emptyDescription" size="small" />
      <div v-else class="flex flex-col gap-4">
        <section v-for="group in groups" :key="group.shard">
          <header class="mb-2 flex flex-wrap items-center gap-2">
            <h3 class="text-sm font-medium">
              {{ group.label }}
            </h3>
            <NTag size="tiny" :bordered="false" :type="group.running ? 'success' : 'default'">
              {{ group.running ? '运行中' : '未运行' }}
            </NTag>
            <span class="text-xs text-muted-foreground">
              {{ group.players.length }} 人在线
            </span>
          </header>

          <p v-if="!group.running" class="text-xs text-muted-foreground">
            {{ group.label }}的分片没有运行，这个世界的玩家列表暂时看不到。
          </p>
          <p v-else-if="!group.queried" class="text-xs text-muted-foreground">
            这次没取到{{ group.label }}的玩家列表，稍后会自动重试。
          </p>
          <p v-else-if="group.players.length === 0 && group.unlistedCount > 0" class="text-xs text-muted-foreground">
            {{ group.label }}有 {{ group.unlistedCount }} 人在线，但游戏没有给出可用的玩家 ID，列不出来。
          </p>
          <p v-else-if="group.players.length === 0" class="text-xs text-muted-foreground">
            {{ group.label }}当前没有玩家。
          </p>

          <ul v-else class="flex flex-col gap-2">
            <li
              v-for="player in group.players"
              :key="player.kuId"
              class="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
            >
              <div class="min-w-0">
                <p class="text-sm truncate">
                  {{ displayName(player) }}
                  <NTag v-if="!player.kleiAccount" size="tiny" :bordered="false" class="ml-1">
                    临时身份
                  </NTag>
                </p>
                <p class="font-mono text-xs text-muted-foreground truncate">
                  {{ displayId(player) }}
                </p>
                <p v-if="!player.kleiAccount" class="text-xs text-muted-foreground">
                  没有 Klei 账号（离线或局域网进来的），ID 每次进服都会变：可以踢出，不能封禁或加入名单
                </p>
              </div>
              <NSpace :size="8" class="flex-wrap">
                <NButton size="small" :disabled="acting" @click="emit('kick', player)" v-if="hasPermission('player:kick')">
                  踢出
                </NButton>
                <NButton size="small" type="error" secondary :disabled="acting || !player.kleiAccount" @click="emit('ban', player)" v-if="hasPermission('player:ban')">
                  封禁
                </NButton>
                <NButton size="small" quaternary :disabled="acting || !player.kleiAccount" @click="emit('addToList', { player, kind: 'whitelist' })" v-if="hasPermission('player:write')">
                  加入白名单
                </NButton>
                <NButton size="small" quaternary :disabled="acting || !player.kleiAccount" @click="emit('addToList', { player, kind: 'admin' })" v-if="hasPermission('player:write')">
                  设为管理员
                </NButton>
              </NSpace>
            </li>
          </ul>
          <p v-if="group.queried && group.players.length > 0 && group.unlistedCount > 0" class="mt-2 text-xs text-muted-foreground">
            另有 {{ group.unlistedCount }} 人游戏没有给出可用的玩家 ID，无法在这里列出。
          </p>
        </section>
      </div>
    </NSpin>
  </NCard>
</template>
