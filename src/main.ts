// 加载 iconify 图标
import { loadingFadeOut } from 'virtual:app-loading'
import { downloadAndInstall } from '@/iconify'
import icons from '@/iconify/index.json'
// 自定义指令
import directive from '@/utils/directive'

import App from './App.vue'
import router from './router'
import pinia from './store'
import '@/utils/storage'

// UnoCSS
import 'virtual:uno.css'
// 全局样式
import '@/assets/styles/globals.css'

const app = createApp(App)
app.config.errorHandler = (error) => {
  console.error('[app] 页面运行异常:', error)
  window.__BSP_BOOTSTRAP__?.fail('页面启动失败，请重新加载后重试。')
}
app.use(pinia)
app.use(router)
directive(app)
if (icons.isOfflineUse) {
  for (const info of icons.collections) {
    downloadAndInstall(info)
  }
}

app.mount('#app')

// 挂载成功且首个路由已渲染后再移除遮罩；导入模块失败由入口内联脚本捕获。
void router.isReady().then(async () => {
  await nextTick()
  if (window.__BSP_BOOTSTRAP__?.ready() !== false) {
    loadingFadeOut()
  }
}).catch(() => {
  window.__BSP_BOOTSTRAP__?.fail('页面初始化失败，请重新加载后重试。')
})
