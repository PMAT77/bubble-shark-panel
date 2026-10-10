<script setup lang="ts">
import type { ModConfigDefinition, ModConfigValues } from '@/api/modules/mod'
import { NButton, NInput, NInputNumber, NModal, NPopover, NSelect, NSpin, NSwitch, useMessage } from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import { computed, ref, watch } from 'vue'
import apiMod from '@/api/modules/mod'
import { buildDefinitionOptionsPayload, buildManualOptionsPayload, createConfigEditValues, resolveConfigControlKind, validateConfigKvRows } from '../modConfigState'
import type { ModConfigKvRow } from '../modConfigState'
import type { ModConfigDefinitionStatus } from '../../../../../../shared/contracts/mod'

defineOptions({
  name: 'ModConfigModal',
})

// 保存 Mod 配置要 mod:config：只读账号即使打开了这个弹窗也提交不了
const { auth: hasPermission } = useAppAuth()

const props = defineProps<{
  show: boolean
  instanceId: string
  workshopId: string
  modName: string
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  saved: [riskTip: string | null]
}>()

const message = useMessage()
const loading = ref(false)
const saving = ref(false)
const definitions = ref<ModConfigDefinition[]>([])
const editValues = ref<Record<string, string | null>>({})
/** 加载时的原始值：未修改的项原样提交，避免 string 化破坏类型 */
const originalValues = ref<Record<string, string | number | boolean>>({})
const kvRows = ref<ModConfigKvRow[]>([])
const definitionStatus = ref<ModConfigDefinitionStatus>()
const definitionMessage = ref<string | null>(null)
const definitionsParsed = computed(() => definitions.value.length > 0)
const manualEditorAvailable = computed(() => definitionStatus.value !== 'empty' || kvRows.value.length > 0)
let loadVersion = 0

const visible = computed({
  get: () => props.show,
  set: (value: boolean) => emit('update:show', value),
})

interface BusinessErrorLike {
  error?: string
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null && 'error' in error) {
    return String((error as BusinessErrorLike).error ?? fallback)
  }
  if (error instanceof Error && error.message) {
    return error.message
  }
  return fallback
}

async function loadConfig() {
  if (!props.instanceId || !props.workshopId) {
    return
  }
  loading.value = true
  const version = ++loadVersion
  try {
    const response = await apiMod.getModConfig(props.instanceId, props.workshopId)
    if (version !== loadVersion) return
    definitions.value = response.data.definitions
    definitionStatus.value = response.data.definitionStatus
    definitionMessage.value = response.data.definitionMessage ?? (definitions.value.length ? null : '暂时无法读取这个 Mod 的配置选项。')
    const loaded = response.data.options
    originalValues.value = { ...loaded }
    editValues.value = createConfigEditValues(definitions.value, loaded)
    kvRows.value = Object.entries(loaded).map(([key, value]) => ({
      key,
      value: String(value),
    }))
  }
  catch (error: unknown) {
    if (version !== loadVersion) return
    message.error(getErrorMessage(error, '加载 Mod 配置失败'))
    visible.value = false
  }
  finally {
    if (version === loadVersion) loading.value = false
  }
}

watch(() => [props.show, props.instanceId, props.workshopId] as const, ([show]) => {
  if (show) {
    void loadConfig()
  }
  else loadVersion += 1
}, { immediate: true })

function resolveControlKind(def: ModConfigDefinition): 'select' | 'switch' | 'number' | 'text' {
  return resolveConfigControlKind(def, originalValues.value)
}

function buildSelectOptions(def: ModConfigDefinition): SelectOption[] {
  const options: SelectOption[] = def.options.map(option => ({
    label: option.description,
    value: String(option.data),
  }))
  const current = editValues.value[def.name]
  if (current && !options.some(option => option.value === current)) {
    options.push({ label: '当前值（不在候选项中）', value: current })
  }
  return options
}

function addKvRow() {
  kvRows.value = [...kvRows.value, { key: '', value: '' }]
}

function removeKvRow(index: number) {
  kvRows.value = kvRows.value.filter((_, i) => i !== index)
}

async function saveConfig() {
  if (!props.instanceId || !props.workshopId || saving.value) {
    return
  }
  if (!definitionsParsed.value) {
    const invalid = validateConfigKvRows(kvRows.value)
    if (invalid) {
      message.warning(invalid)
      return
    }
  }
  const options: ModConfigValues = definitionsParsed.value
    ? buildDefinitionOptionsPayload(definitions.value, editValues.value, originalValues.value)
    : buildManualOptionsPayload(kvRows.value, originalValues.value)
  saving.value = true
  try {
    const response = await apiMod.updateModConfig(props.instanceId, props.workshopId, {
      options,
    })
    message.success('Mod 配置已保存，重启实例后生效')
    emit('saved', response.data.riskTip ?? null)
    visible.value = false
  }
  catch (error: unknown) {
    message.error(getErrorMessage(error, '保存 Mod 配置失败，请稍后重试'))
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <NModal
    v-model:show="visible"
    preset="card"
    :title="'配置 - ' + (modName || workshopId)"
    class="mod-config-modal"
    :bordered="false"
    size="small"
  >
    <NSpin :show="loading">
      <div class="min-h-24">
        <p class="mb-3 text-xs text-muted-foreground">
          保存后重启实例生效。
        </p>

        <template v-if="definitionsParsed">
          <div class="space-y-4">
            <div v-for="(def, index) in definitions" :key="`${index}:${def.name}`" class="min-w-0 flex flex-col gap-1">
              <div class="min-w-0 flex items-center gap-2">
                <span class="min-w-0 break-words text-sm font-medium">{{ def.label || def.name }}</span>
                <NPopover v-if="!def.isHeader || def.hover" trigger="click">
                  <template #trigger>
                    <NButton size="tiny" quaternary aria-label="查看配置说明">?</NButton>
                  </template>
                  <div class="max-w-[min(320px,80vw)] break-words text-xs">
                    <p v-if="!def.isHeader">配置键：{{ def.name }}</p>
                    <p v-if="def.hover" class="whitespace-pre-wrap">{{ def.hover }}</p>
                  </div>
                </NPopover>
              </div>
              <template v-if="!def.isHeader">
                <NSelect
                  v-if="resolveControlKind(def) === 'select'"
                  size="small"
                  :value="editValues[def.name] ?? null"
                  :options="buildSelectOptions(def)"
                  placeholder="未设置"
                  :aria-label="def.label || def.name"
                  clearable
                  @update:value="(value: string | null) => { editValues[def.name] = value }"
                />
                <NSwitch
                  v-else-if="resolveControlKind(def) === 'switch'"
                  size="small"
                  :aria-label="def.label || def.name"
                  :value="(editValues[def.name] ?? String(def.default ?? false)) === 'true'"
                  @update:value="(value: boolean) => { editValues[def.name] = value ? 'true' : 'false' }"
                />
                <NInputNumber
                  v-else-if="resolveControlKind(def) === 'number'"
                  size="small"
                  :value="editValues[def.name] == null ? null : Number(editValues[def.name])"
                  placeholder="未设置"
                  :aria-label="def.label || def.name"
                  class="w-full"
                  @update:value="(value: number | null) => { editValues[def.name] = value === null ? null : String(value) }"
                />
                <NInput
                  v-else
                  :value="editValues[def.name]"
                  size="small"
                  placeholder="未设置"
                  :aria-label="def.label || def.name"
                  clearable
                  @update:value="(value: string) => { editValues[def.name] = value === '' ? null : value }"
                />
                <div class="flex items-center gap-2 text-xs text-muted-foreground">
                  <span v-if="editValues[def.name] == null">未设置，保存后使用默认值</span>
                  <NButton v-else size="tiny" quaternary @click="editValues[def.name] = null">使用默认值</NButton>
                </div>
              </template>
            </div>
          </div>
        </template>

        <template v-else>
          <p class="mb-2 text-xs text-muted-foreground">
            {{ definitionMessage }}
          </p>
          <template v-if="manualEditorAvailable">
            <p class="mb-3 text-xs text-muted-foreground">
              已有配置可以修改。新增项请使用 Mod 作者提供的键和值，随意填写不会增加新功能。
            </p>
            <div class="space-y-2">
              <div v-for="(row, index) in kvRows" :key="index" class="mod-config-kv-row">
                <div class="mod-config-kv-key">
                  <NInput
                    v-model:value="row.key"
                    size="small"
                    placeholder="配置键"
                    :aria-label="`第 ${index + 1} 项配置键`"
                  />
                </div>
                <div class="min-w-0">
                  <NInput
                    v-model:value="row.value"
                    size="small"
                    placeholder="配置值"
                    :aria-label="`第 ${index + 1} 项配置值`"
                  />
                </div>
                <NButton size="tiny" quaternary type="error" :aria-label="`删除第 ${index + 1} 项配置`" @click="removeKvRow(index)">
                  删除
                </NButton>
              </div>
            </div>
            <NButton size="small" dashed class="mt-3 w-full" @click="addKvRow">
              添加配置项
            </NButton>
          </template>
        </template>
      </div>
    </NSpin>

    <template #footer>
      <div class="flex justify-end gap-2">
        <NButton size="small" @click="visible = false">
          取消
        </NButton>
        <NButton size="small" type="primary" :loading="saving" :disabled="loading" @click="saveConfig" v-if="hasPermission('mod:config')">
          保存
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
:global(.n-card.mod-config-modal) {
  width: min(680px, 94vw);
  max-height: 90dvh;
}

:global(.mod-config-modal > .n-card-content) {
  min-height: 0;
  overflow-y: auto;
}

.mod-config-kv-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
}

.mod-config-kv-key {
  min-width: 0;
  grid-column: 1 / -1;
}

@media (min-width: 640px) {
  .mod-config-kv-row {
    grid-template-columns: minmax(0, 2fr) minmax(0, 3fr) auto;
  }

  .mod-config-kv-key {
    grid-column: auto;
  }
}
</style>
