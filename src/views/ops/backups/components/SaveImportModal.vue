<script setup lang="ts">
import type { SaveImportCandidate, SaveImportProbeResult, SaveImportResult, SaveImportTokenSource } from '@/api/modules/backup'
import { NAlert, NButton, NInput, NModal, NProgress, NSelect, NTag, useDialog } from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import { computed, ref, watch } from 'vue'
import apiBackup from '@/api/modules/backup'

defineOptions({
  name: 'SaveImportModal',
})

const props = defineProps<{
  show: boolean
  instanceId: string | null
  instanceName: string
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  'imported': []
}>()

const dialog = useDialog()

/** 与服务端上传上限默认值对齐的前置校验：超限直接本地拦截，不发起上传 */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024
const ACCEPT_EXTENSIONS = ['.zip', '.tar.gz', '.tgz']

const fileInputRef = ref<HTMLInputElement | null>(null)
const selectedFile = ref<File | null>(null)
const uploading = ref(false)
const uploadPercent = ref(0)
const uploadError = ref<string | null>(null)
const submitting = ref(false)
const probeResult = ref<SaveImportProbeResult | null>(null)
const selectedPath = ref<string | null>(null)
const clusterToken = ref('')
const importResult = ref<SaveImportResult | null>(null)

const selectedCandidate = computed<SaveImportCandidate | null>(() => {
  const candidates = probeResult.value?.candidates ?? []
  return candidates.find(item => item.clusterPath === selectedPath.value) ?? null
})

const candidateOptions = computed<SelectOption[]>(() => {
  return (probeResult.value?.candidates ?? []).map((candidate) => {
    const label = candidate.clusterName
      ? candidate.dirName + '（' + candidate.clusterName + '）'
      : candidate.dirName
    return { label, value: candidate.clusterPath }
  })
})

const tokenSourceLabels: Record<SaveImportTokenSource, string> = {
  provided: '使用导入时填写的令牌',
  existing: '沿用实例已有令牌',
  source: '使用源存档自带的令牌',
  none: '未配置令牌（公网游玩需到房间设置补填）',
}

const canSubmit = computed(() => Boolean(props.instanceId) && Boolean(selectedCandidate.value) && !submitting.value)

function resetForm() {
  selectedFile.value = null
  uploading.value = false
  uploadPercent.value = 0
  uploadError.value = null
  submitting.value = false
  probeResult.value = null
  selectedPath.value = null
  clusterToken.value = ''
  importResult.value = null
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return (bytes / 1024).toFixed(1) + ' KB'
  }
  if (bytes < 1024 * 1024 * 1024) {
    return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  }
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

function shardLabel(shard: 'master' | 'caves'): string {
  return shard === 'master' ? '主世界' : '洞穴'
}

function pickFile() {
  fileInputRef.value?.click()
}

function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  // 重置 input 以便连续两次选择同一文件也能触发 change
  input.value = ''
  if (!file) {
    return
  }
  const lowerName = file.name.toLowerCase()
  if (!ACCEPT_EXTENSIONS.some(ext => lowerName.endsWith(ext))) {
    selectedFile.value = null
    uploadError.value = '仅支持 zip 压缩包或面板备份包'
    return
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    selectedFile.value = null
    uploadError.value = '存档包超过 2GB 上限，请清理无关文件后重新压缩'
    return
  }
  selectedFile.value = file
  void uploadArchive(file)
}

async function uploadArchive(file: File) {
  uploading.value = true
  uploadPercent.value = 0
  uploadError.value = null
  probeResult.value = null
  selectedPath.value = null
  try {
    const response = await apiBackup.uploadSaveImportArchive(file, (percent) => {
      uploadPercent.value = percent
    })
    probeResult.value = response.data
    const candidates = response.data.candidates ?? []
    if (candidates.length === 1) {
      selectedPath.value = candidates[0]!.clusterPath
    }
  }
  catch (err) {
    const message = err instanceof Error
      ? err.message
      : (err as { error?: string } | null)?.error || '存档包上传或识别失败'
    uploadError.value = message
  }
  finally {
    uploading.value = false
  }
}

function confirmImport() {
  const candidate = selectedCandidate.value
  if (!candidate || !props.instanceId || !probeResult.value) {
    return
  }
  const content = '将把实例「' + props.instanceName + '」的世界存档整体替换为所选房间存档（'
    + candidate.dirName + '）。已有存档会先自动备份为「导入前」，可在备份列表恢复。'
    + (candidate.migration ? '迁移包中的 Mod 列表与文件也会替换目标内容；缺文件项保留为待下载，不自动联网。' : '')
    + '导入前请先停止实例，并确认游戏已安装。'
  dialog.warning({
    title: '确认导入存档',
    content,
    positiveText: '开始导入',
    negativeText: '取消',
    onPositiveClick: async () => {
      submitting.value = true
      try {
        const response = await apiBackup.importSave({
          instanceId: props.instanceId!,
          uploadId: probeResult.value!.uploadId,
          sourceClusterPath: candidate.clusterPath,
          ...(clusterToken.value.trim() ? { clusterToken: clusterToken.value.trim() } : {}),
        })
        importResult.value = response.data
        emit('imported')
      }
      catch (err) {
        const message = err instanceof Error ? err.message : (err as { error?: string } | null)?.error || '存档导入失败'
        faToast.error(message)
      }
      finally {
        submitting.value = false
      }
    },
  })
}

watch(() => props.show, (visible) => {
  if (visible) {
    resetForm()
  }
})
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    title="导入外部存档"
    style="width: min(720px, 94vw)"
    @update:show="(value: boolean) => emit('update:show', value)"
  >
    <div class="importer">
      <template v-if="!importResult">
        <NAlert type="info" :show-icon="false">
          上传你电脑上的 Klei 存档压缩包（如压缩后的房间目录），导入为所选实例的世界存档。
          世界进度与房间设置来自源档；端口会自动改成这个实例能用的，避免冲突。
        </NAlert>

        <div class="importer-field">
          <div class="importer-label">
            存档压缩包（你电脑上的文件）
          </div>
          <div class="importer-path-row">
            <input
              ref="fileInputRef"
              type="file"
              accept=".zip,.tar.gz,.tgz"
              class="importer-file-input"
              @change="onFileChange"
            >
            <NButton size="small" :disabled="uploading" @click="pickFile">
              {{ selectedFile ? '重新选择文件' : '选择文件…' }}
            </NButton>
            <span v-if="selectedFile" class="importer-file-name">
              {{ selectedFile.name }}（{{ formatSize(selectedFile.size) }}）
            </span>
          </div>
          <NProgress v-if="uploading" type="line" :percentage="uploadPercent" :height="6" />
          <div class="importer-hint">
            支持 zip 压缩包：可直接压缩 DoNotStarveTogether 目录；面板下载的备份包也可直接导入。
          </div>
        </div>

        <NAlert v-if="uploadError" type="error" :show-icon="false">
          {{ uploadError }}
        </NAlert>

        <div v-if="probeResult" class="importer-probe">
          <NAlert
            v-if="!probeResult.candidates || probeResult.candidates.length === 0"
            type="error"
            :show-icon="false"
          >
            {{ probeResult.warnings?.[0] ?? '未识别到可导入的房间存档' }}
          </NAlert>

          <template v-else>
            <div v-if="probeResult.candidates.length > 1" class="importer-field">
              <div class="importer-label">
                识别到多个房间，请选择要导入的存档
              </div>
              <NSelect
                :value="selectedPath"
                size="small"
                :options="candidateOptions"
                placeholder="选择房间存档"
                @update:value="(value: string) => selectedPath = value"
              />
            </div>

            <div v-if="selectedCandidate" class="importer-candidate">
              <div class="importer-candidate-row">
                <span class="importer-label">房间名</span>
                <span>{{ selectedCandidate.clusterName ?? '未知' }}</span>
                <NTag
                  size="small"
                  :bordered="false"
                  :type="selectedCandidate.worldGenerated ? 'success' : 'default'"
                >
                  {{ selectedCandidate.worldGenerated ? '世界已生成' : '世界未生成' }}
                </NTag>
              </div>
              <div class="importer-candidate-row">
                <span class="importer-label">包含世界</span>
                <span>{{ selectedCandidate.shards.map(shardLabel).join('、') || '无' }}</span>
                <span class="importer-label">存档大小</span>
                <span>
                  {{ formatSize(selectedCandidate.sizeBytes) }}{{ selectedCandidate.sizeIncomplete ? '（存档过大，未完全统计）' : '' }}
                </span>
              </div>
              <div class="importer-candidate-row">
                <span class="importer-label">Mod</span>
                <span>{{ selectedCandidate.modCount }} 个</span>
                <span class="importer-label">令牌</span>
                <span>{{ selectedCandidate.hasTokenFile ? '源档自带' : '源档未带' }}</span>
              </div>
              <NAlert v-if="selectedCandidate.migration" type="info" :show-icon="false">
                迁移包：包含 {{ selectedCandidate.migration.includedModCount }} 个 Mod 的文件。
                <template v-if="selectedCandidate.migration.missingModIds.length">仅配置、恢复后待下载：{{ selectedCandidate.migration.missingModIds.join('、') }}。</template>
                恢复过程不访问创意工坊。
              </NAlert>
              <div v-if="selectedCandidate.warnings.length > 0" class="importer-warns">
                <div v-for="warning in selectedCandidate.warnings" :key="warning" class="importer-warn">
                  ⚠ {{ warning }}
                </div>
              </div>
            </div>
          </template>
        </div>

        <div class="importer-field">
          <div class="importer-label">
            Klei 集群令牌（可选）
          </div>
          <NInput
            v-model:value="clusterToken"
            size="small"
            placeholder="留空则沿用实例已有令牌；公网游玩需填 pds- 开头的令牌"
            maxlength="512"
          />
        </div>
      </template>

      <template v-else>
        <NAlert type="success" :show-icon="false">
          存档导入完成，可启动实例验证世界进度。
        </NAlert>
        <div class="importer-result">
          <div class="importer-candidate-row">
            <span class="importer-label">导入世界</span>
            <span>{{ importResult.importedShards.map(shardLabel).join('、') || '无' }}</span>
          </div>
          <div class="importer-candidate-row">
            <span class="importer-label">Mod</span>
            <span>{{ importResult.modCount }} 个已导入</span>
          </div>
          <div class="importer-candidate-row">
            <span class="importer-label">令牌</span>
            <span>{{ tokenSourceLabels[importResult.tokenSource] }}</span>
          </div>
          <div class="importer-candidate-row">
            <span class="importer-label">安全备份</span>
            <span>{{ importResult.safetyBackupId ? '已创建（导入前自动备份，可在列表恢复）' : '实例原本无存档，未创建' }}</span>
          </div>
          <div v-if="importResult.gamePortSynced" class="importer-candidate-row">
            <span class="importer-label">端口</span>
            <span>端口已自动改成这个实例能用的</span>
          </div>
          <div v-if="importResult.missingWorkshopContent.length > 0" class="importer-warn">
            ⚠ 以下 Mod 的创意工坊内容尚未下载：{{ importResult.missingWorkshopContent.join('、') }}。面板不会自动下载：请到「世界设置 → 模组」点「开始下载」，队列会按批处理。
          </div>
          <div v-for="warning in importResult.warnings" :key="warning" class="importer-warn">
            ⚠ {{ warning }}
          </div>
          <div class="importer-warn">
            ⚠ 建议到「房间设置」核对导入的房间信息后重新保存一次。
          </div>
        </div>
      </template>
    </div>

    <template #footer>
      <div class="importer-footer">
        <NButton size="small" @click="emit('update:show', false)">
          {{ importResult ? '关闭' : '取消' }}
        </NButton>
        <NButton
          v-if="!importResult"
          size="small"
          type="warning"
          :loading="submitting"
          :disabled="!canSubmit"
          @click="confirmImport"
        >
          导入并覆盖实例存档
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.importer {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.importer-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.importer-label {
  font-size: 12px;
  color: #909090;
  flex-shrink: 0;
}

.importer-path-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.importer-file-input {
  display: none;
}

.importer-file-name {
  font-size: 12px;
  color: #606070;
  word-break: break-all;
}

.importer-hint {
  font-size: 12px;
  color: #b8b8c0;
}

.importer-candidate {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--custom-border-color, #efeff5);
  border-radius: 6px;
}

.importer-candidate-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  flex-wrap: wrap;
}

.importer-warns {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.importer-warn {
  font-size: 12px;
  color: #d48806;
}

.importer-result {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.importer-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
