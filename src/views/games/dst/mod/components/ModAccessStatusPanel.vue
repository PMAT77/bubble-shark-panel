<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton } from 'naive-ui'
import apiMod from '@/api/modules/mod'
import type { ModAccessStatusDto, ModAccessObservation, ModDownloadQueueDto } from '../../../../../../shared/contracts/mod'
import { resolveModDownloadHelp } from '../modDownloadPresentation'
const props = defineProps<{ instanceId: string, queue: ModDownloadQueueDto | null }>()
const { auth: hasPermission } = useAppAuth()
const open = ref(false)
const loading = ref(false)
const result = ref<ModAccessStatusDto | null>(null)
const error = ref('')
const help = computed(() => resolveModDownloadHelp(props.queue, result.value?.files))
const failedItems = computed(() => props.queue?.items.filter(item => item.error) ?? [])
let generation = 0
const label = (value: ModAccessObservation) => value.status === 'unknown' ? '尚未验证'
  : (value.message ?? (value.status === 'success' ? '最近一次请求成功' : value.status === 'cancelled' ? '已取消' : '最近一次请求失败'))
const time = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : ''
async function load() {
  const id = props.instanceId
  const current = ++generation
  if (!id) return
  loading.value = true
  error.value = ''
  try {
    const { data } = await apiMod.getModAccessStatus(id)
    if (current === generation && id === props.instanceId) result.value = data
  }
  catch { if (current === generation) error.value = '暂时无法读取诊断记录，请稍后重试' }
  finally { if (current === generation) loading.value = false }
}
watch(() => props.instanceId, () => { generation += 1; result.value = null; open.value = false; error.value = ''; loading.value = false })
function toggle(event: Event) {
  if (event.target !== event.currentTarget) return
  open.value = (event.target as HTMLDetailsElement).open
  if (open.value) void load()
}
</script>

<template>
  <details :key="instanceId" :open="open" class="mb-2 max-h-64 shrink-0 overflow-auto rounded-md border px-3 py-2 text-xs" @toggle="toggle">
    <summary class="cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">下载遇到问题</summary>
    <div class="mt-2 flex flex-col gap-2">
      <p>{{ help.summary }}</p>
      <p v-for="reason in help.reasons" :key="reason">{{ reason }}</p>
      <template v-if="hasPermission('mod:install')">
        <p v-if="help.retryHint">{{ help.retryHint }}</p>
        <p>已有 Mod 的 ZIP？点击上方“从本地导入”。</p>
      </template>
      <p v-else>需要下载或导入时，请联系有权限的管理员。</p>
      <details>
        <summary class="cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">技术信息</summary>
        <div class="mt-2 flex flex-col gap-2 break-words">
          <p v-if="error" role="status">{{ error }}</p>
          <p v-if="loading">正在读取最近记录…</p>
          <p v-for="item in failedItems" :key="item.workshopId">Mod {{ item.workshopId }}：{{ item.error }}</p>
          <p v-if="queue?.lastError">任务错误：{{ queue.lastError }}</p>
          <template v-if="result">
            <p>市场列表：{{ label(result.market) }} {{ time(result.market.observedAt) }}
              <template v-if="result.market.cached"> · 使用缓存（获取时间 {{ time(result.market.fetchedAt) }}）</template>
            </p>
            <p>详情与版本：{{ label(result.metadata) }} {{ time(result.metadata.observedAt) }}</p>
            <p>文件下载：{{ label(result.files) }} {{ time(result.files.observedAt) }}</p>
            <p>记录来自实际请求，不会主动探测。尚未验证表示没有记录；面板重启后记录会清空。</p>
          </template>
          <div><NButton size="tiny" :disabled="!instanceId" :loading="loading" @click="load">刷新记录</NButton></div>
        </div>
      </details>
      <details>
        <summary class="cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">管理员配置说明</summary>
        <div class="mt-2 flex flex-col gap-2 break-words">
          <p v-if="result">运行环境：{{ result.configuration.runtime }}；文件下载代理{{ result.configuration.steamcmdProxyConfigured ? '已配置' : '未配置' }}；市场与详情代理{{ result.configuration.httpProxyConfigured ? '已配置' : '未配置' }}。</p>
          <ol class="list-decimal space-y-2 pl-5">
            <li>在服务器上打开面板的 panel.env 配置文件。</li>
            <li>文件下载需要代理时，设置 BSP_STEAMCMD_HTTP_PROXY / BSP_STEAMCMD_HTTPS_PROXY；市场、详情与版本查询需要代理时，设置 BSP_STEAM_HTTP_PROXY / BSP_STEAM_HTTPS_PROXY。填写实际可用的 HTTP 代理地址，例如 http://proxy.example:7890。</li>
            <li>保存并重启面板，然后重新尝试对应操作。</li>
          </ol>
          <p>已配置代理或市场访问成功，不能证明文件下载正常。</p>
          <p v-if="result?.configuration.runtime === 'docker'">代理须从下载容器可达；面板的 host.docker.internal 映射不会自动传给下载容器。下载容器网络模式：{{ result.configuration.networkMode }}。</p>
          <p v-else>代理地址须从对应运行环境可达。</p>
          <p>BSP_STEAM_WEBAPI_BASE_URL 可配置 Web API 地址。Relay 仅提供市场列表，不代理文件下载。</p>
        </div>
      </details>
    </div>
  </details>
</template>
