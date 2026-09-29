import axios from 'axios'
import router from '@/router'
import { resolveApiBaseUrl } from './base-url'
import { isBinaryResponse, parseBinaryErrorPayload } from './binary-response'
import { isPermissionSnapshotStale } from './permission-snapshot'

// 请求重试配置
const MAX_RETRY_COUNT = 3 // 最大重试次数
const RETRY_DELAY = 1000 // 重试延迟时间（毫秒）

// 扩展 AxiosRequestConfig 类型
declare module 'axios' {
  export interface AxiosRequestConfig {
    retry?: boolean
    retryCount?: number
    fake?: boolean
    skipAuthRefresh?: boolean
  }
}

let refreshingAuthPromise: Promise<boolean> | null = null

/** 同文案业务错误 8 秒内只提示一次，避免轮询期间 toast 刷屏 */
let lastToastMessage = ''
let lastToastAt = 0
function toastBusinessErrorOnce(message: string) {
  const now = Date.now()
  if (message === lastToastMessage && now - lastToastAt < 8000) {
    return
  }
  lastToastMessage = message
  lastToastAt = now
  faToast.warning('操作失败', {
    description: message,
  })
}

const api = axios.create({
  baseURL: resolveApiBaseUrl({
    dev: import.meta.env.DEV,
    proxyEnabled: import.meta.env.VITE_ENABLE_PROXY,
    configured: import.meta.env.VITE_APP_API_BASEURL,
  }),
  timeout: 1000 * 60,
  responseType: 'json',
})

/**
 * 权限被改过但页面没刷新时的自愈。
 *
 * 菜单与"我能进哪些页面"是**登录时的一次快照**（`/app/route/list` 注册路由、
 * `/app/account/permission` 决定按钮），而服务端每次请求都查库。管理员改完角色的那一刻，
 * 那个已登录的账号就进入错位状态：菜单和页面还在，请求开始 403——用户看着像坏了，
 * 唯一的解法是自己想到"刷新一下页面"。
 *
 * 这里在收到 403 时重新拉一次权限，**只有快照确实变了**才提示并重新加载：
 * 权限没变的 403 属于这个功能本身无权（或实例授权不足），刷新只会白闪一次。
 */
let permissionRefreshPromise: Promise<void> | null = null
let permissionRefreshNotified = false

function healStalePermissionSnapshot(): Promise<void> {
  const appAccountStore = useAppAccountStore()
  // 游客角色的权限点由代码固化、登录前也没有快照可谈
  if (!appAccountStore.isLogin || appAccountStore.isGuestRole) {
    return Promise.resolve()
  }
  if (permissionRefreshPromise) {
    return permissionRefreshPromise
  }
  permissionRefreshPromise = (async () => {
    const before = [...appAccountStore.permissions]
    try {
      await appAccountStore.getPermissions()
    }
    catch {
      // 拉取失败就当作没变化：这条 403 已经提示过一次，不必再打扰用户
      return
    }
    if (!isPermissionSnapshotStale(before, appAccountStore.permissions)) {
      return
    }
    if (!permissionRefreshNotified) {
      permissionRefreshNotified = true
      faToast.info('权限已变更', {
        description: '正在按最新权限重新加载菜单与页面',
      })
    }
    window.setTimeout(() => window.location.reload(), 800)
  })().finally(() => {
    permissionRefreshPromise = null
  })
  return permissionRefreshPromise
}

api.interceptors.request.use(
  (request) => {
    // 开发环境可通过 VITE_USE_FAKE 全局开启 fake，也支持单请求 fake 强制走 mock。
    const shouldUseFake = Boolean(request.fake) || (import.meta.env.DEV && import.meta.env.VITE_USE_FAKE === true)
    if (shouldUseFake) {
      request.baseURL = '/fake/'
    }
    // 全局拦截请求发送前提交的参数
    const appAccountStore = useAppAccountStore()
    // 设置请求头
    if (request.headers) {
      request.headers['Accept-Language'] = 'zh-CN'
      if (appAccountStore.isLogin) {
        request.headers.Token = appAccountStore.token
      }
    }
    // 是否将 POST 请求参数进行字符串化处理
    if (request.method === 'post') {
      // request.data = qs.stringify(request.data, {
      //   arrayFormat: 'brackets',
      // })
    }
    return request
  },
)

// 处理错误信息的函数
async function handleError(error: any) {
  const config = error?.config
  /**
   * 下载类接口失败时后端同样返回 JSON 业务信封（HTTP 4xx + { status, error, code }），
   * 但 responseType: 'blob' 会把它包成 Blob，中文原因就此丢失。这里先把 Blob 读回对象，
   * 未授权、强制改密与失败原因才能按业务语义处理；非二进制响应完全沿用原来的逻辑。
   */
  const binaryRequest = isBinaryResponse(config, error?.response?.data)
  const responseData = binaryRequest
    ? await parseBinaryErrorPayload(error?.response?.data)
    : error?.response?.data
  /** 二进制请求失败时把业务信封透出给调用方（含中文 error），其余仍是原来的 AxiosError */
  const rejectRequest = () => Promise.reject(binaryRequest ? (responseData ?? error) : error)

  if (responseData?.code === 'AUTH_FORCE_PASSWORD_CHANGE') {
    useAppAccountStore().setMustChangePassword(true)
    if (router.currentRoute.value.name !== 'forceChangePassword') {
      void router.replace('/force-change-password')
    }
    return rejectRequest()
  }
  if (responseData?.code === 'AUTH_UNAUTHORIZED') {
    if (config?.skipAuthRefresh !== true) {
      const refreshed = await tryRefreshAuthSession()
      if (refreshed) {
        return api({ ...config, skipAuthRefresh: true })
      }
    }
    useAppAccountStore().requestLogout()
    return rejectRequest()
  }
  // 下载失败时如实显示后端给的原因，而不是 "Request failed with status code 404"
  if (binaryRequest && typeof responseData?.error === 'string' && responseData.error) {
    if (responseData.code === 'AUTH_FORBIDDEN') {
      void healStalePermissionSnapshot()
    }
    toastBusinessErrorOnce(responseData.error)
    return rejectRequest()
  }
  if (error.status === 401) {
    useAppAccountStore().requestLogout()
  }
  else {
    faToast.error('请求失败', {
      description: error.message,
    })
  }
  return rejectRequest()
}

async function tryRefreshAuthSession(): Promise<boolean> {
  if (refreshingAuthPromise) {
    return refreshingAuthPromise
  }
  refreshingAuthPromise = (async () => {
    const appAccountStore = useAppAccountStore()
    const refreshToken = appAccountStore.refreshToken?.trim()
    if (!refreshToken) {
      return false
    }
    try {
      const res = await api.post('app/account/token/refresh', { refreshToken }, {
        skipAuthRefresh: true,
      })
      appAccountStore.applySessionTokens({
        token: String(res.data.token ?? ''),
        refreshToken: String(res.data.refreshToken ?? ''),
      })
      return Boolean(res.data.token && res.data.refreshToken)
    }
    catch {
      return false
    }
    finally {
      refreshingAuthPromise = null
    }
  })()
  return refreshingAuthPromise
}

api.interceptors.response.use(
  async (response) => {
    /**
     * 下载类接口（responseType: 'blob'）的响应体不是 { status, data } 业务信封：
     * 原样透传整个响应，调用方按 { data: Blob } 取用。
     * 否则 Blob 没有 status 字段，会被下面的业务分支判成登录失效并触发
     * requestLogout()，表现为「点下载就直接退出登录」。
     */
    if (isBinaryResponse(response.config, response.data)) {
      return response
    }
    /**
     * 全局拦截请求发送后返回的数据，如果数据有报错则在这做全局的错误提示
     * 约定的数据格式：{ status: 1 | 0, error: string, data: object }
     * status 只有两种状态，1 表示请求成功，0 表示接口需要登录或者登录状态失效，需要重新登录
     * error 只有在请求出错时才会有值，表示错误信息
     * data 只有在请求成功时才会有值，表示请求返回的数据
     */
    if (typeof response.data === 'object') {
      if (response.data.status === 1) {
        if (response.data.error) {
          if (
            response.data.code !== 'INSTANCE_PORT_CONFLICT'
            && response.data.code !== 'HOST_MEMORY_PRESSURE'
          ) {
            toastBusinessErrorOnce(response.data.error)
          }
          /**
           * 403 可能是"我的权限刚被改过、页面还是旧快照"：这种情况自动重新拉权限、
           * 提示并重新加载，而不是只告诉用户"你没权限"（他根本不知道该刷新页面）。
           */
          if (response.data.code === 'AUTH_FORBIDDEN') {
            void healStalePermissionSnapshot()
          }
          return Promise.reject(response.data)
        }
      }
      else {
        const requestConfig = response.config
        if (response.data.code === 'AUTH_FORCE_PASSWORD_CHANGE') {
          useAppAccountStore().setMustChangePassword(true)
          if (router.currentRoute.value.name !== 'forceChangePassword') {
            void router.replace('/force-change-password')
          }
          return Promise.reject(response.data)
        }
        const canRetryAuth = response.data.code === 'AUTH_UNAUTHORIZED' && requestConfig.skipAuthRefresh !== true
        if (canRetryAuth) {
          const refreshed = await tryRefreshAuthSession()
          if (refreshed) {
            return api({
              ...requestConfig,
              skipAuthRefresh: true,
            })
          }
        }
        useAppAccountStore().requestLogout()
        return Promise.reject(response.data)
      }
      return Promise.resolve(response.data)
    }
    else {
      return Promise.reject(response.data)
    }
  },
  async (error) => {
    // 获取请求配置
    const config = error.config
    // 如果配置不存在或未启用重试，则直接处理错误
    if (!config || !config.retry) {
      return handleError(error)
    }
    // 设置重试次数
    config.retryCount = config.retryCount || 0
    // 判断是否超过重试次数
    if (config.retryCount >= MAX_RETRY_COUNT) {
      return handleError(error)
    }
    // 重试次数自增
    config.retryCount += 1
    // 延迟重试
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY))
    // 重新发起请求
    return api(config)
  },
)

export default api
