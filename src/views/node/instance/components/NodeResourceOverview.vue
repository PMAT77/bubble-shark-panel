<script setup lang="ts">
import type { NodeListItem } from '@/api/modules/node'
import { NAlert, NButton, NEmpty, NStatistic, NTag } from 'naive-ui'
import { onActivated, onDeactivated, onMounted, onUnmounted, ref } from 'vue'
import apiNode from '@/api/modules/node'
import { useAdminPageState } from '@/composables/useAdminPageState'
import { formatDateTime, formatPercent } from '../utils'

defineOptions({
  name: 'NodeInstanceNodeOverview',
})

const emit = defineEmits<{
  nodesChange: [nodes: NodeListItem[]]
}>()

/** 节点资源变化较慢，10 秒与监控台系统信息的默认频率对齐 */
const NODE_POLL_MS = 10_000

const registerLoading = ref(false)
const nodes = ref<NodeListItem[]>([])

/** 节点列表两个权限点都能读（服务端放行），但「重注册」仍归监控读权限 */
const { auth: hasPermission } = useAppAuth()
const canMonitor = computed(() => hasPermission('console.monitor:read'))

const {
  loading,
  error,
  showEmpty,
  showError,
  runLoad,
} = useAdminPageState(nodes)

let pollTimer: ReturnType<typeof setInterval> | undefined
let isPolling = false

async function fetchNodes() {
  await runLoad(async () => {
    const res = await apiNode.getNodeList()
    nodes.value = res.data
    emit('nodesChange', nodes.value)
  })
}

/**
 * 轮询走静默路径：不触发 loading，失败时保留上次数据，
 * 否则「刷新节点」按钮每 10 秒转圈一次、卡片同步闪烁。
 */
async function pollNodesSilently() {
  if (isPolling) {
    return
  }
  isPolling = true
  try {
    const res = await apiNode.getNodeList()
    nodes.value = res.data
    emit('nodesChange', nodes.value)
  }
  catch {
    // 静默失败：保留上次数据，不打断轮询
  }
  finally {
    isPolling = false
  }
}

function startNodePolling() {
  if (pollTimer) {
    return
  }
  pollTimer = setInterval(() => {
    void pollNodesSilently()
  }, NODE_POLL_MS)
}

function stopNodePolling() {
  if (!pollTimer) {
    return
  }
  clearInterval(pollTimer)
  pollTimer = undefined
}

async function registerLocalNode() {
  registerLoading.value = true
  try {
    await apiNode.registerLocalNode()
    faToast.success('本地节点已重新注册')
    await fetchNodes()
  }
  finally {
    registerLoading.value = false
  }
}

onMounted(() => {
  void fetchNodes()
  startNodePolling()
})

// 页面被 KeepAlive 缓存时不会触发 unmounted，用 activated / deactivated 控制轮询
onActivated(startNodePolling)
onDeactivated(stopNodePolling)
onUnmounted(stopNodePolling)
</script>

<template>
  <div class="space-y-4">
    <p class="text-sm text-muted-foreground">
      节点离线时请先重注册本地节点。
    </p>
    <section class="p-4 border border-border rounded-xl bg-card space-y-4">
      <div class="flex flex-wrap gap-3 items-center justify-between">
        <div class="flex gap-2">
          <NButton :loading="loading" @click="fetchNodes">
            刷新节点
          </NButton>
          <!--
            「重注册本地节点」走 `/app/node/local/register`，归 console.monitor:read。
            这一页对 instance:read 也开着（实例创建要选节点），所以按钮必须自己判权——
            否则只有实例权限的账号会看到一个点了必然 403 的按钮。
          -->
          <NButton
            v-if="canMonitor"
            type="error"
            strong
            secondary
            :loading="registerLoading"
            @click="registerLocalNode"
          >
            重注册本地节点
          </NButton>
        </div>
      </div>

      <div v-if="showError" class="space-y-3" role="alert">
        <NAlert type="error" title="加载失败">
          {{ error }}
        </NAlert>
        <NButton size="small" @click="fetchNodes">
          重试
        </NButton>
      </div>
      <NEmpty
        v-else-if="showEmpty"
        description="暂无可用节点"
      >
        <template #extra>
          <NButton type="primary" @click="registerLocalNode">
            重注册本地节点
          </NButton>
        </template>
      </NEmpty>
      <div v-else class="gap-3 grid md:grid-cols-2 xl:grid-cols-3">
        <article
          v-for="node in nodes"
          :key="node.id"
          class="p-4 border border-border/80 rounded-lg bg-background"
        >
          <div class="flex gap-2 items-start justify-between">
            <div>
              <p class="text-sm font-semibold">
                {{ node.name }}
              </p>
              <p class="text-xs text-muted-foreground mt-1">
                {{ node.host }}:{{ node.sshPort }}
              </p>
            </div>
            <NTag
              size="small"
              :bordered="false"
              :type="node.status === 'online' ? 'success' : 'error'"
            >
              {{ node.status === 'online' ? '在线' : '离线' }}
            </NTag>
          </div>
          <div class="text-xs mt-3 gap-2 grid grid-cols-3">
            <div class="p-2 rounded-md bg-muted/50">
              <NStatistic label="CPU" tabular-nums>
                <template #default>
                  <span class="text-sm font-semibold">{{ formatPercent(node.resources.cpu.usageRate) }}</span>
                </template>
              </NStatistic>
            </div>
            <div class="p-2 rounded-md bg-muted/50">
              <NStatistic label="内存" tabular-nums>
                <template #default>
                  <span class="text-sm font-semibold">{{ formatPercent(node.resources.memory.usageRate) }}</span>
                </template>
              </NStatistic>
            </div>
            <div class="p-2 rounded-md bg-muted/50">
              <NStatistic label="磁盘" tabular-nums>
                <template #default>
                  <span class="text-sm font-semibold">{{ formatPercent(node.resources.disk.usageRate) }}</span>
                </template>
              </NStatistic>
            </div>
          </div>
          <p class="text-xs text-muted-foreground mt-3">
            最近上报：{{ formatDateTime(node.lastHeartbeatAt) }}
          </p>
        </article>
      </div>
    </section>
  </div>
</template>
