<script setup lang="ts">
import type { SelfCheckItem, SelfCheckReport, SelfCheckStatus } from '@/api/modules/system'
import { NAlert, NButton, NSpin } from 'naive-ui'
import { computed, ref } from 'vue'
import apiSystem from '@/api/modules/system'
import { copyTextToClipboard } from '@/utils/copyToClipboard'

defineOptions({
  name: 'SystemSelfCheckCard',
})

const loading = ref(false)
const report = ref<SelfCheckReport | null>(null)
const errorMessage = ref<string | null>(null)

const statusMeta: Record<SelfCheckStatus, { label: string, tone: 'success' | 'warning' | 'error' | 'default' }> = {
  ok: { label: '正常', tone: 'success' },
  warn: { label: '注意', tone: 'warning' },
  fail: { label: '异常', tone: 'error' },
  skipped: { label: '未启用', tone: 'default' },
}

const headline = computed(() => {
  if (!report.value) {
    return ''
  }
  const { fail, warn } = report.value.summary
  if (fail > 0) {
    return `发现 ${fail} 项异常${warn > 0 ? `、${warn} 项需要注意` : ''}`
  }
  if (warn > 0) {
    return `环境可用，有 ${warn} 项需要注意`
  }
  return '环境检查全部通过'
})

const toneClass: Record<SelfCheckStatus, string> = {
  ok: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-600 dark:text-amber-400',
  fail: 'text-rose-600 dark:text-rose-400',
  skipped: 'text-muted-foreground',
}

async function runSelfCheck() {
  if (loading.value) {
    return
  }
  loading.value = true
  errorMessage.value = null
  try {
    const { data } = await apiSystem.getSelfCheck()
    report.value = data
  }
  catch {
    report.value = null
    errorMessage.value = '自检失败：面板无法完成检查，请查看面板日志。'
  }
  finally {
    loading.value = false
  }
}

function buildCopyText(target: SelfCheckReport): string {
  const lines = [
    `BubbleShark Panel 环境自检（${target.generatedAt}）`,
    `版本：${target.releaseVersion || '开发构建'}　运行方式：${target.runtimeMode}`,
    '',
    ...target.items.map((item: SelfCheckItem) =>
      `[${statusMeta[item.status].label}] ${item.label}：${item.detail}`),
  ]
  return lines.join('\n')
}

async function copyReport() {
  if (!report.value) {
    return
  }
  const ok = await copyTextToClipboard(buildCopyText(report.value))
  if (ok) {
    faToast.success('自检结果已复制')
    return
  }
  faToast.error('复制失败，请手动选中文本复制')
}

defineExpose({ runSelfCheck })
</script>

<template>
  <div class="space-y-3">
    <p class="text-sm text-muted-foreground">
      一次性检查运行环境、磁盘余量、数据目录可写、实例状态与通知渠道，出问题时可以先跑一遍再问人。
    </p>

    <div class="flex flex-wrap items-center gap-2">
      <NButton size="small" type="primary" :loading="loading" @click="runSelfCheck">
        开始自检
      </NButton>
      <NButton v-if="report" size="small" @click="copyReport">
        复制结果
      </NButton>
      <span v-if="report" class="text-sm">{{ headline }}</span>
    </div>

    <NAlert v-if="errorMessage" type="error" :bordered="false">
      {{ errorMessage }}
    </NAlert>

    <NSpin :show="loading">
      <ul v-if="report" class="space-y-1">
        <li
          v-for="item in report.items"
          :key="item.id"
          class="rounded-md border px-3 py-2 text-sm"
        >
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-medium">{{ item.label }}</span>
            <span :class="toneClass[item.status]">[{{ statusMeta[item.status].label }}]</span>
            <span>{{ item.detail }}</span>
          </div>
          <p v-if="item.hint" class="mt-1 text-xs text-muted-foreground">
            {{ item.hint }}
          </p>
        </li>
      </ul>
    </NSpin>
  </div>
</template>
