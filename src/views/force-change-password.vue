<script setup lang="ts">
import { NAlert } from 'naive-ui'
import EditPassword from '@/components/AppAccountForm/edit-password.vue'
import { ensureDynamicRoutes, resetEnsureDynamicRoutes } from '@/router/ensure-dynamic-routes'

defineOptions({
  name: 'ForceChangePassword',
})

const router = useRouter()
const appSettingsStore = useAppSettingsStore()

async function handlePasswordChanged() {
  try {
    resetEnsureDynamicRoutes()
    await ensureDynamicRoutes(router)
  }
  catch {
    faToast.error('无法进入系统', {
      description: '菜单与路由加载失败，请刷新后重试',
    })
    return
  }
  await router.replace(appSettingsStore.settings.app.home.fullPath)
}
</script>

<template>
  <div class="bg-background flex-col-center min-h-screen w-full">
    <div class="p-8 w-full max-w-lg">
      <NAlert
        type="warning"
        title="首次登录须修改初始密码"
        class="mb-6"
      >
        请设置符合强度要求的新密码后再进入面板。
      </NAlert>
      <EditPassword force-mode @on-success="handlePasswordChanged" />
    </div>
  </div>
</template>
