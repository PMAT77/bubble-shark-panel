<script setup lang="ts">
import type { ModConfigDefinition, ModConfigValues } from '@/api/modules/mod'
import { NButton, NInput, NInputNumber, NModal, NSelect, NSpin, NSwitch, NTag, NTooltip, useMessage } from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import { computed, ref, watch } from 'vue'
import apiMod from '@/api/modules/mod'

defineOptions({
  name: 'ModConfigModal',
})

// 保存 Mod 配置要 mod:config：只读账号即使打开了这个弹窗也提交不了
const { auth: hasPermission } = useAppAuth()

interface KvRow {
  key: string
  value: string
}

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
const editValues = ref<Record<string, string>>({})
/** 加载时的原始值：未修改的项原样提交，避免 string 化破坏类型 */
const originalValues = ref<Record<string, string | number | boolean>>({})
const kvRows = ref<KvRow[]>([])
const definitionsParsed = computed(() => definitions.value.length > 0)

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
  try {
    const response = await apiMod.getModConfig(props.instanceId, props.workshopId)
    definitions.value = response.data.definitions
    const loaded = response.data.options
    originalValues.value = { ...loaded }
    const next: Record<string, string> = {}
    for (const [key, value] of Object.entries(loaded)) {
      next[key] = String(value)
    }
    editValues.value = next
    kvRows.value = Object.entries(loaded).map(([key, value]) => ({
      key,
      value: String(value),
    }))
  }
  catch (error: unknown) {
    message.error(getErrorMessage(error, '加载 Mod 配置失败'))
    visible.value = false
  }
  finally {
    loading.value = false
  }
}

watch(() => props.show, (show) => {
  if (show) {
    void loadConfig()
  }
})

function resolveControlKind(def: ModConfigDefinition): 'select' | 'switch' | 'number' | 'text' {
  if (def.options.length > 0) {
    return 'select'
  }
  const current = editValues.value[def.name] ?? String(def.default ?? '')
  const raw = originalValues.value[def.name] ?? def.default
  if (typeof raw === 'boolean' || current === 'true' || current === 'false') {
    return 'switch'
  }
  if (typeof raw === 'number' || (current !== '' && Number.isFinite(Number(current)))) {
    return 'number'
  }
  return 'text'
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

function inferKvValue(rawValue: string): string | number | boolean {
  if (rawValue === 'true') {
    return true
  }
  if (rawValue === 'false') {
    return false
  }
  if (rawValue.trim() !== '' && Number.isFinite(Number(rawValue))) {
    return Number(rawValue)
  }
  return rawValue
}

/** 定义模式：把编辑值还原为原始类型（未修改保持原样，修改按控件类型转换） */
function resolveTypedValue(def: ModConfigDefinition, edited: string): string | number | boolean | undefined {
  if (edited === '') {
    return undefined
  }
  const original = originalValues.value[def.name]
  if (original !== undefined && String(original) === edited) {
    return original
  }
  const kind = resolveControlKind(def)
  if (kind === 'switch') {
    return edited === 'true'
  }
  if (kind === 'number') {
    return Number(edited)
  }
  if (kind === 'select') {
    const candidate = def.options.find(option => String(option.data) === edited)
    return candidate ? candidate.data : edited
  }
  return edited
}

function buildOptionsPayload(): ModConfigValues | null {
  if (!definitionsParsed.value) {
    const result: ModConfigValues = {}
    for (const row of kvRows.value) {
      const key = row.key.trim()
      if (!key) {
        continue
      }
      result[key] = inferKvValue(row.value)
    }
    return Object.keys(result).length > 0 ? result : null
  }
  const result: ModConfigValues = {}
  for (const def of definitions.value) {
    const edited = editValues.value[def.name] ?? ''
    const typed = resolveTypedValue(def, edited)
    if (typed !== undefined) {
      result[def.name] = typed
    }
  }
  return Object.keys(result).length > 0 ? result : null
}

async function saveConfig() {
  if (!props.instanceId || !props.workshopId || saving.value) {
    return
  }
  if (!definitionsParsed.value) {
    const invalidRow = kvRows.value.find(row => !row.key.trim() && row.value.trim() !== '')
    if (invalidRow) {
      message.warning('存在未填写键名的配置行，请填写键名或删除该行')
      return
    }
  }
  const options = buildOptionsPayload()
  saving.value = true
  try {
    const response = await apiMod.updateModConfig(props.instanceId, props.workshopId, {
      options: options ?? {},
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
    class="w-[min(680px,94vw)]"
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
            <div v-for="def in definitions" :key="def.name" class="flex flex-col gap-1">
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium">{{ def.label || def.name }}</span>
                <NTag size="tiny" :bordered="false" type="default">{{ def.name }}</NTag>
                <NTooltip v-if="def.hover" trigger="hover">
                  <template #trigger>
                    <span class="cursor-help text-xs text-muted-foreground">?</span>
                  </template>
                  {{ def.hover }}
                </NTooltip>
              </div>
              <NSelect
                v-if="resolveControlKind(def) === 'select'"
                size="small"
                :value="editValues[def.name] ?? ''"
                :options="buildSelectOptions(def)"
                placeholder="未设置"
                clearable
                @update:value="(value: string | null) => { editValues[def.name] = value ?? '' }"
              />
              <NSwitch
                v-else-if="resolveControlKind(def) === 'switch'"
                size="small"
                :value="editValues[def.name] === 'true'"
                @update:value="(value: boolean) => { editValues[def.name] = value ? 'true' : 'false' }"
              />
              <NInputNumber
                v-else-if="resolveControlKind(def) === 'number'"
                size="small"
                :value="editValues[def.name] === '' || editValues[def.name] === undefined ? null : Number(editValues[def.name])"
                placeholder="未设置"
                class="w-full"
                @update:value="(value: number | null) => { editValues[def.name] = value === null ? '' : String(value) }"
              />
              <NInput
                v-else
                v-model:value="editValues[def.name]"
                size="small"
                placeholder="未设置"
                clearable
              />
            </div>
          </div>
        </template>

        <template v-else>
          <p class="mb-2 text-xs text-muted-foreground">
            无法读取这个 Mod 的配置选项，请手动填写键和值。
          </p>
          <div class="space-y-2">
            <div v-for="(row, index) in kvRows" :key="index" class="flex items-center gap-2">
              <NInput
                v-model:value="row.key"
                size="small"
                placeholder="配置键"
                class="w-48 shrink-0"
              />
              <NInput
                v-model:value="row.value"
                size="small"
                placeholder="配置值"
                class="min-w-0 flex-1"
              />
              <NButton size="tiny" quaternary type="error" @click="removeKvRow(index)">
                删除
              </NButton>
            </div>
          </div>
          <NButton size="small" dashed class="mt-3 w-full" @click="addKvRow">
            添加配置项
          </NButton>
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
