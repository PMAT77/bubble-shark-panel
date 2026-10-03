<script setup lang="ts">
import type { CommercialSupport } from '@/api/modules/system'
import { NAlert, NButton, NSpin, NTag } from 'naive-ui'
import { computed, onMounted, ref } from 'vue'
import apiSystem from '@/api/modules/system'
import { copyTextToClipboard } from '@/utils/copyToClipboard'

defineOptions({
  name: 'SystemCommercialSupportSection',
})

const loading = ref(false)
const support = ref<CommercialSupport | null>(null)
const errorMessage = ref<string | null>(null)

/** 版本形态：授权机制落地前只可能出现「通用版」，这里不做任何「升级解锁」的暗示 */
const editionLabel = computed(() => {
  if (!support.value) {
    return ''
  }
  return support.value.edition === 'pro' ? 'Pro 授权' : '通用版'
})

async function loadSupport() {
  loading.value = true
  errorMessage.value = null
  try {
    const { data } = await apiSystem.getCommercialSupport()
    support.value = data
  }
  catch {
    support.value = null
    errorMessage.value = '暂时读不到商业支持信息，不影响面板的任何功能。'
  }
  finally {
    loading.value = false
  }
}

async function copyWechat() {
  if (!support.value) {
    return
  }
  const ok = await copyTextToClipboard(support.value.contact.wechat)
  if (ok) {
    faToast.success('微信号已复制')
    return
  }
  faToast.error('复制失败，请手动记录微信号')
}

onMounted(loadSupport)
</script>

<template>
  <div class="space-y-3">
    <NAlert v-if="errorMessage" type="warning" :bordered="false">
      {{ errorMessage }}
    </NAlert>

    <NSpin :show="loading">
      <div v-if="support" class="space-y-4">
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <span>当前版本：{{ support.releaseVersion || '开发构建' }}</span>
          <NTag size="small" :bordered="false">
            {{ editionLabel }}
          </NTag>
        </div>

        <div class="rounded-md border px-3 py-2 text-sm">
          <div class="font-medium">
            授权状态
          </div>
          <p class="mt-1 text-muted-foreground">
            {{ support.license.message }}
          </p>
          <div v-if="support.license.status === 'active'" class="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-xs text-muted-foreground">
            <div>客户：{{ support.license.customer || '—' }}</div>
            <div>到期：{{ support.license.expiresAt || '永久' }}</div>
            <div class="col-span-2">
              设备绑定：{{ support.license.bound ? '是（换机器需重新签发）' : '否（可自由换机器）' }}
            </div>
            <div class="col-span-2">
              已授权能力：{{ support.license.capabilities.join('、') || '—' }}
            </div>
          </div>
        </div>

        <div class="space-y-2">
          <div class="text-sm font-medium">
            可选付费服务
          </div>
          <ul class="grid gap-2 sm:grid-cols-2">
            <li
              v-for="item in support.services"
              :key="item.id"
              class="rounded-md border px-3 py-2 text-sm"
            >
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-medium">{{ item.name }}</span>
                <span class="ml-auto font-medium tabular-nums">{{ item.priceRange }}</span>
              </div>
              <p class="mt-1 text-xs text-muted-foreground">
                {{ item.detail }}
              </p>
            </li>
          </ul>
          <p class="text-xs text-muted-foreground">
            参考价按常规环境估算，实际报价沟通后确认。
          </p>
        </div>

        <div class="space-y-2 text-sm">
          <div class="font-medium">
            联系方式
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <span>微信：{{ support.contact.wechat }}</span>
            <NButton size="tiny" @click="copyWechat">
              复制
            </NButton>
            <span class="text-muted-foreground">QQ 群：{{ support.contact.qqGroup }}</span>
          </div>
          <p class="text-xs text-muted-foreground">
            {{ support.contact.noteHint }}
          </p>
          <a
            class="text-xs underline"
            :href="support.contact.repository"
            target="_blank"
            rel="noopener noreferrer"
          >
            项目仓库与完整文档
          </a>
        </div>
      </div>
    </NSpin>
  </div>
</template>
