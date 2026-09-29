<script setup lang="ts">
import type { PluginImportInspectResult } from '@/api/modules/system'
import { NAlert, NButton, NModal, NSpin, NTag } from 'naive-ui'
import { computed, ref } from 'vue'
import apiSystem from '@/api/modules/system'
import { capabilityLabel, isDangerousCapability } from '../pluginStorePresentation'

/**
 * 插件包导入。
 *
 * 两步式，且**校验在读盘之前**：
 * 第一步把包上传到临时目录解压并校验（清单、入口、接口版本、签名），把结论摆给用户看；
 * 第二步才真正写进插件目录。这样签名不对、清单损坏、接口版本不兼容的包
 * 永远不会在插件目录里留下一个只能人工去删的残留。
 *
 * 「还缺哪项授权」必须在确认之前说出来：安装成功却启用不了，
 * 比导入失败更让人困惑——因为用户会以为是自己弄错了。
 */
const props = defineProps<{
  show: boolean
}>()

const emit = defineEmits<{
  (event: 'update:show', value: boolean): void
  (event: 'imported', message: string): void
}>()

const fileInput = ref<HTMLInputElement | null>(null)
// 导入插件包要 plugin:manage：只读账号看不到入口，这里再兜一层
const { auth: hasPermission } = useAppAuth()
const inspecting = ref(false)
const importing = ref(false)
const inspected = ref<PluginImportInspectResult | null>(null)
const errorMessage = ref<string | null>(null)

const analysis = computed(() => inspected.value?.analysis ?? null)

function close() {
  if (importing.value) {
    return
  }
  emit('update:show', false)
  reset()
}

function reset() {
  inspected.value = null
  errorMessage.value = null
  if (fileInput.value) {
    fileInput.value.value = ''
  }
}

function pickFile() {
  reset()
  fileInput.value?.click()
}

async function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) {
    return
  }
  inspecting.value = true
  errorMessage.value = null
  try {
    const { data } = await apiSystem.inspectPluginPackage(file)
    inspected.value = data
  }
  catch (error) {
    errorMessage.value = readErrorMessage(error, '插件包校验失败，请确认拿到的是完整的插件包。')
  }
  finally {
    inspecting.value = false
  }
}

async function confirmImport() {
  if (!inspected.value) {
    return
  }
  importing.value = true
  try {
    const { data } = await apiSystem.importPluginPackage({ uploadId: inspected.value.uploadId })
    emit('imported', data.message)
    emit('update:show', false)
    reset()
  }
  catch (error) {
    // 后端把「目录已存在」「签名校验失败」等原因写在 error 里，尽量原样展示
    errorMessage.value = readErrorMessage(error, '导入失败，请重新选择插件包。')
  }
  finally {
    importing.value = false
  }
}

/**
 * 业务错误由 axios 拦截器统一 reject（信封里的 `error` 字段），
 * 与 `PluginsSection.vue` 里的启停失败处理同一套取法。
 */
function readErrorMessage(error: unknown, fallback: string): string {
  const detail = (error as { error?: unknown })?.error ?? (error as { message?: unknown })?.message
  return typeof detail === 'string' && detail.trim() ? detail : fallback
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    class="max-w-2xl"
    title="导入插件包"
    :mask-closable="!importing"
    @update:show="value => (value ? emit('update:show', true) : close())"
  >
    <div class="space-y-3 text-sm">
      <p class="text-muted-foreground">
        选择从面板之外拿到的插件包（.zip 或 .tar.gz）。面板会先校验清单与签名，
        通过后才会写入插件目录；导入完成默认停用，确认无误再启用。
      </p>

      <input
        ref="fileInput"
        type="file"
        accept=".zip,.tar.gz,.tgz,application/zip,application/gzip"
        class="hidden"
        @change="onFileChange"
      >

      <div class="flex flex-wrap items-center gap-2">
        <NButton size="small" :loading="inspecting" :disabled="importing" @click="pickFile">
          {{ analysis ? '重新选择' : '选择插件包' }}
        </NButton>
        <span v-if="inspecting" class="text-xs text-muted-foreground">正在校验……</span>
      </div>

      <NAlert v-if="errorMessage" type="error" :bordered="false">
        {{ errorMessage }}
      </NAlert>

      <NSpin :show="inspecting">
        <div v-if="analysis" class="space-y-2 rounded-md border px-3 py-2">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-medium">{{ analysis.name }}</span>
            <span class="text-xs text-muted-foreground">v{{ analysis.version }}</span>
            <NTag size="small" :bordered="false" type="success">
              校验通过
            </NTag>
            <NTag size="small" :bordered="false">
              {{ analysis.signed ? `已签名：${analysis.publisher ?? '未知发布方'}` : '未签名' }}
            </NTag>
          </div>

          <div class="text-xs text-muted-foreground">
            标识 {{ analysis.pluginId }} · 接口版本 {{ analysis.apiVersion }}
          </div>

          <div v-if="analysis.capabilities.length > 0" class="flex flex-wrap items-center gap-1">
            <span class="text-xs text-muted-foreground">申请的能力：</span>
            <NTag
              v-for="capability in analysis.capabilities"
              :key="capability"
              size="tiny"
              :bordered="false"
              :type="isDangerousCapability(capability) ? 'warning' : 'default'"
            >
              {{ capabilityLabel(capability) }}
            </NTag>
          </div>

          <NAlert v-if="analysis.requiredLicenseGap" type="warning" :bordered="false">
            导入后还不能启用：{{ analysis.requiredLicenseGap }}
          </NAlert>
          <NAlert v-else type="success" :bordered="false">
            授权要求已满足，导入后可直接启用。
          </NAlert>
        </div>
      </NSpin>
    </div>

    <template #footer>
      <div class="flex justify-end gap-2">
        <NButton :disabled="importing" @click="close">
          取消
        </NButton>
        <NButton
          type="primary"
          :disabled="!analysis"
          :loading="importing"
          @click="confirmImport"
          v-if="hasPermission('plugin:manage')"
        >
          确认导入
        </NButton>
      </div>
    </template>
  </NModal>
</template>
