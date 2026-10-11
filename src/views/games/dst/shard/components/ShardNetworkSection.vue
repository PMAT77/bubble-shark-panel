<script setup lang="ts">
import { NFormItem, NInputNumber } from 'naive-ui'

defineProps<{
  shardFolder: 'Master' | 'Caves'
  showPortHint?: boolean
}>()

const serverPort = defineModel<number>('serverPort', { required: true })
const steamAuthPort = defineModel<number>('steamAuthPort', { required: true })
const steamMasterPort = defineModel<number>('steamMasterPort', { required: true })
</script>

<template>
  <div class="space-y-2">
    <p class="text-sm text-muted-foreground mb-4">
      公网联机前，请在防火墙或云安全组放行游戏所需的 UDP 端口。
    </p>
    <NFormItem label="游戏端口" path="serverPort">
      <NInputNumber v-model:value="serverPort" :input-props="{ 'aria-label': '游戏端口' }" :min="1" :max="65535" class="w-40" />
      <template v-if="showPortHint" #feedback>
        须与地上游戏端口不同
      </template>
    </NFormItem>
    <NFormItem label="Steam 认证端口" path="steamAuthPort">
      <NInputNumber v-model:value="steamAuthPort" :input-props="{ 'aria-label': 'Steam 认证端口' }" :min="1" :max="65535" class="w-40" />
    </NFormItem>
    <NFormItem label="Steam 主服端口" path="steamMasterPort">
      <NInputNumber v-model:value="steamMasterPort" :input-props="{ 'aria-label': 'Steam 主服端口' }" :min="1" :max="65535" class="w-40" />
    </NFormItem>
  </div>
</template>
