<script setup lang="ts">
import { NTag } from 'naive-ui'
import { computed, onMounted, shallowRef } from 'vue'
import apiSystem from '@/api/modules/system'
import { resolveRuntimeEnvironmentView } from '../steamcmdPanelPresentation'

defineOptions({
  name: 'NodeInstanceSteamcmdPanel',
})

const emit = defineEmits<{
  stateChange: [payload: { installed: boolean }]
}>()

/** 当前账号的权限判定；按钮级隐藏用，后端仍是唯一的安全边界 */
const { auth: hasPermission } = useAppAuth()

const steamcmdInstalling = shallowRef(false)
const gameDstPulling = shallowRef(false)
const steamcmdInstalled = shallowRef(false)
const gameDstInstalled = shallowRef(false)
const runtimeMode = shallowRef<'docker' | 'native'>('docker')
const runtimeStatus = shallowRef<'running' | 'stopped'>('stopped')
const steamcmdImage = shallowRef('')
const gameDstImage = shallowRef('')
const installRoot = shallowRef('')

const isNativeMode = computed(() => runtimeMode.value === 'native')
const runtimeAvailable = computed(() => runtimeStatus.value === 'running')

/**
 * 镜像行 / 状态标签 / 按钮文案 / 提示全部由纯函数决定：
 * 默认部署下安装镜像与运行镜像是同一个统一镜像引用，展示为一行；
 * 仅在显式配置了两个不同引用时才退回两行，保留诊断能力。
 */
const environmentView = computed(() => resolveRuntimeEnvironmentView({
  isNativeMode: isNativeMode.value,
  runtimeAvailable: runtimeAvailable.value,
  steamcmdInstalled: steamcmdInstalled.value,
  gameDstInstalled: gameDstInstalled.value,
  steamcmdImage: steamcmdImage.value,
  gameDstImage: gameDstImage.value,
}))

function emitStateChange() {
  emit('stateChange', {
    installed: steamcmdInstalled.value,
  })
}

async function fetchSteamcmdConfig() {
  const res = await apiSystem.getSteamcmdConfig()
  steamcmdImage.value = res.data.steamcmdImage?.trim() || res.data.steamcmdPath?.trim() || ''
  gameDstImage.value = res.data.gameDstImage?.trim() || ''
  installRoot.value = res.data.installRoot?.trim() || ''
  runtimeMode.value = res.data.runtimeMode
  runtimeStatus.value = res.data.runtimeStatus
  steamcmdInstalled.value = Boolean(res.data.isSteamcmdInstalled)
  gameDstInstalled.value = Boolean(res.data.isGameDstImageInstalled)
  emitStateChange()
}

async function ensureSteamcmdImage() {
  steamcmdInstalling.value = true
  try {
    const res = await apiSystem.installSteamcmd()
    faToast.success(res.data.message || '运行环境已就绪')
    await fetchSteamcmdConfig()
  }
  finally {
    steamcmdInstalling.value = false
  }
}

/**
 * 两个入口各自维护 loading：异构部署下它们拉的是不同镜像，共用一个状态会让另一个
 * 按钮无端转圈，看起来像有两个任务在跑。同源部署下副按钮不渲染（见 presentation 的
 * secondaryPullVisible），此时只有一个入口持有 loading。
 */
async function ensureGameDstImageManual() {
  gameDstPulling.value = true
  try {
    const res = await apiSystem.installGameDstImage()
    faToast.success(res.data.message || 'DST 运行镜像已就绪')
    await fetchSteamcmdConfig()
  }
  finally {
    gameDstPulling.value = false
  }
}

onMounted(() => {
  void fetchSteamcmdConfig()
})
</script>

<template>
  <div class="space-y-4">
    <div class="p-4 border border-border/70 rounded-lg bg-muted/20 space-y-4">
      <div class="flex flex-wrap gap-3 items-start justify-between">
        <div class="flex flex-wrap gap-2">
          <NTag
            v-for="tag in environmentView.tags"
            :key="tag.text"
            size="small"
            :bordered="false"
            :type="tag.type"
          >
            {{ tag.text }}
          </NTag>
        </div>
        <div class="flex flex-wrap gap-2">
          <NButton
            type="primary"
            secondary
            :loading="steamcmdInstalling"
            :disabled="!runtimeAvailable"
            @click="ensureSteamcmdImage"
            v-if="hasPermission('settings:write')"
          >
            {{ environmentView.primaryActionLabel }}
          </NButton>
          <NButton
            v-if="environmentView.secondaryPullVisible && hasPermission('settings:write')"
            type="default"
            secondary
            :loading="gameDstPulling"
            :disabled="!runtimeAvailable"
            @click="ensureGameDstImageManual"
          >
            手动拉取运行镜像
          </NButton>
        </div>
      </div>

      <div class="gap-3 grid md:grid-cols-2">
        <div v-for="row in environmentView.imageRows" :key="row.label" class="space-y-1">
          <div class="text-xs text-muted-foreground">
            {{ row.label }}
          </div>
          <NInput
            :value="row.value"
            readonly
            placeholder="未配置"
          />
        </div>
        <div class="space-y-1" :class="{ 'md:col-span-2': environmentView.imageRows.length > 1 }">
          <div class="text-xs text-muted-foreground">
            实例数据目录
          </div>
          <NInput
            :value="installRoot"
            readonly
            placeholder="未配置"
          />
        </div>
      </div>

      <p class="text-xs text-muted-foreground">
        以上运行环境由部署时写入的服务器配置决定，面板内不提供修改入口；需要变更请改服务器上的配置后重启面板。
      </p>

      <p
        v-if="environmentView.hint"
        class="text-xs"
        :class="environmentView.hint.tone === 'error'
          ? 'text-rose-600 dark:text-rose-400'
          : 'text-amber-600 dark:text-amber-400'"
      >
        {{ environmentView.hint.text }}
      </p>
    </div>
  </div>
</template>
