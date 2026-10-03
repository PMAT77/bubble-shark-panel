import type { InstanceItem } from '@/api/modules/instance'
import { NButton, NCheckbox, useDialog, useNotification } from 'naive-ui'
import type { Ref } from 'vue'
import { h, ref } from 'vue'
import apiCluster from '@/api/modules/cluster'
import apiInstance from '@/api/modules/instance'
import apiShard from '@/api/modules/shard'
import { routeToConsoleMonitor, routeToDstRoomSettings, routeToDstWorldSettings } from '@/navigation/game-routes'
import { blurFocusedElement } from '@/utils'
import { tryNotifyHostMemoryPressure } from '@/utils/hostMemoryPressure'
import {
  formatPortConflictDetail,
  getPortConflictDialogLabels,
  isInstancePortConflictError,
  type InstancePortConflictAction,
} from '@/utils/instancePortConflict'
import { getInstanceState } from '../instanceDisplay'
import { canRepairInstance, isInstanceUpToDate } from '../instanceUpdatePresentation'
export { canRepairInstance, isInstanceUpToDate } from '../instanceUpdatePresentation'
import {
  blocksDefaultStart,
  buildInstanceStartGuideContext,
  buildStartGuideParagraphs,
  buildStartGuidePositiveText,
  buildStartGuideTitle,
  setStartGuideSkipped,
  shouldOfferStartGuide,
  type InstanceStartGuideContext,
} from '../instanceStartGuide'

/** 实例生命周期动作（cancel_install 在确认后按 stop 执行） */
export type InstanceLifecycleAction = 'start' | 'stop' | 'restart' | 'delete'

export interface UseInstanceLifecycleActionsOptions {
  /** 操作成功后的刷新回调（列表页刷新列表，详情页重载详情） */
  refresh: () => Promise<void> | void
  /** 更新操作发起前的钩子（列表页用于抑制本批次更新通知） */
  onBeforeUpdate?: () => void
  /** 更新请求受理后的钩子（列表页打开安装日志弹窗） */
  onUpdateAccepted?: (row: InstanceItem) => Promise<void> | void
}

/**
 * 实例生命周期操作（启动引导 / 端口冲突 / 危险操作确认 / loading 互斥）。
 *
 * 从 InstanceManagement.vue 原样搬移，列表页与实例详情页共用，保证行为一致。
 */
export function useInstanceLifecycleActions(options: UseInstanceLifecycleActionsOptions) {
  const dialog = useDialog()
  const notification = useNotification()
  const router = useRouter()

  /** 正在执行的实例操作（格式 action:instanceId），驱动按钮 loading 与同实例操作互斥 */
  const actionLoadingIds = ref<Set<string>>(new Set())

  /** 操作按钮是否处于 loading（格式 action:instanceId） */
  function isActionLoading(instanceId: string, action: InstanceLifecycleAction | 'update') {
    return actionLoadingIds.value.has(`${action}:${instanceId}`)
  }

  function isInstanceActionRunning(instanceId: string) {
    return [...actionLoadingIds.value].some(key => key.endsWith(`:${instanceId}`))
  }

  function describeInstanceActionError(error: unknown, fallback: string): string {
    if (error instanceof Error) {
      return error.message
    }
    if (typeof error === 'object' && error && 'error' in error) {
      return String((error as { error?: string }).error)
    }
    return fallback
  }

  function showInstancePortConflictDialog(
    instanceId: string,
    action: InstancePortConflictAction,
    payload: { error: string, data?: { conflictingPorts?: number[], suggestedGamePort?: number | null } },
    onAutoResolve?: () => void | Promise<void>,
  ) {
    const labels = getPortConflictDialogLabels(action)
    const detail = formatPortConflictDetail(payload.data ?? {})
    dialog.warning({
      title: labels.title,
      content: () => h('div', { class: 'space-y-2 max-w-prose text-sm' }, [
        h('p', payload.error),
        h('p', { class: 'text-muted-foreground' }, detail),
      ]),
      positiveText: labels.positiveText,
      negativeText: '自行配置',
      onPositiveClick: () => {
        // 自动换端口后会重新走完整启动流程，同样不能让冲突框被启动耗时绑住
        void onAutoResolve?.()
      },
      onNegativeClick: () => {
        router.push(routeToDstWorldSettings(instanceId, { tab: 'network' }))
      },
    })
  }

  async function runInstanceLifecycleWithPortHandling(
    instanceId: string,
    action: InstancePortConflictAction,
    lifecycleOptions?: { autoAllocatePorts?: boolean },
  ) {
    const labels = getPortConflictDialogLabels(action)
    const apiCall = action === 'restart'
      ? () => apiInstance.restartInstance(instanceId, { autoAllocatePorts: lifecycleOptions?.autoAllocatePorts })
      : () => apiInstance.startInstance(instanceId, { autoAllocatePorts: lifecycleOptions?.autoAllocatePorts })

    try {
      // 弹窗（若有）已经关闭，这里先给一条即时反馈，避免用户面对一段没有任何提示的等待
      faToast.info(action === 'restart' ? '正在重启实例，请稍候…' : '正在启动实例，请稍候…')
      await apiCall()
      faToast.success(labels.successToast)
      await options.refresh()
    }
    catch (error) {
      if (isInstancePortConflictError(error)) {
        showInstancePortConflictDialog(instanceId, action, error, () => runInstanceLifecycleWithPortHandling(instanceId, action, {
          autoAllocatePorts: true,
        }))
        return
      }
      if (tryNotifyHostMemoryPressure(notification, error, () => router.push(routeToConsoleMonitor()))) {
        return
      }
      faToast.error(action === 'restart' ? '重启失败' : '启动失败', {
        description: describeInstanceActionError(error, '请稍后重试'),
      })
    }
  }

  async function runInstanceAction(
    instanceId: string,
    action: InstanceLifecycleAction,
  ) {
    if (isInstanceActionRunning(instanceId)) {
      return
    }
    const operationKey = `${action}:${instanceId}`
    actionLoadingIds.value = new Set([...actionLoadingIds.value, operationKey])
    /**
     * 停止要等在跑的进程落盘退出，删除还要先停实例再清目录，都不是转眼能完成的：
     * 先挂一条常驻提示，结束时（成功或失败）原地换成结果，中途一直有反馈。
     */
    let pendingToastId: number | string | undefined
    try {
      if (action === 'start') {
        await runInstanceLifecycleWithPortHandling(instanceId, 'start')
        return
      }
      if (action === 'restart') {
        await runInstanceLifecycleWithPortHandling(instanceId, 'restart')
        return
      }
      if (action === 'stop') {
        pendingToastId = faToast.loading('正在停止实例，请稍候…')
        await apiInstance.stopInstance(instanceId)
        faToast.success('实例已停止', { id: pendingToastId })
      }
      else {
        pendingToastId = faToast.loading('正在删除实例，请稍候…')
        await apiInstance.deleteInstance(instanceId)
        faToast.success('实例已删除', { id: pendingToastId })
      }
      await options.refresh()
    }
    catch (error) {
      if (action !== 'start' && action !== 'restart') {
        // 同一条 toast 换成失败结果，别让「正在删除…」一直转下去
        faToast.error('操作失败', {
          description: describeInstanceActionError(error, '请稍后重试'),
          ...(pendingToastId === undefined ? {} : { id: pendingToastId }),
        })
      }
    }
    finally {
      const next = new Set(actionLoadingIds.value)
      next.delete(operationKey)
      actionLoadingIds.value = next
    }
  }

  function renderStartGuideContent(
    ctx: InstanceStartGuideContext,
    instanceId: string,
    dontShowAgainRef: Ref<boolean>,
  ) {
    const paragraphs = buildStartGuideParagraphs(ctx)
    const children: ReturnType<typeof h>[] = paragraphs.map(text =>
      h('p', { class: 'text-sm leading-relaxed text-foreground' }, text),
    )

    if (!blocksDefaultStart(ctx)) {
      children.push(
        h('div', { class: 'flex flex-wrap gap-2 pt-1' }, [
          h(
            NButton,
            {
              size: 'small',
              tertiary: true,
              onClick: () => {
                dialog.destroyAll()
                router.push(routeToDstRoomSettings(instanceId))
              },
            },
            { default: () => '先去配置房间' },
          ),
          h(
            NButton,
            {
              size: 'small',
              tertiary: true,
              onClick: () => {
                dialog.destroyAll()
                router.push(routeToDstWorldSettings(instanceId))
              },
            },
            { default: () => '先去配置世界' },
          ),
        ]),
        h(NCheckbox, {
          checked: dontShowAgainRef.value,
          'onUpdate:checked': (v: boolean) => {
            dontShowAgainRef.value = v
          },
        }, { default: () => '下次启动不再提示' }),
      )
    }

    return h('div', { class: 'space-y-3 max-w-prose' }, children)
  }

  async function confirmStartInstance(row: InstanceItem) {
    blurFocusedElement()

    const quickStart = () => runInstanceAction(row.id, 'start')

    if (!shouldOfferStartGuide(row, undefined)) {
      await quickStart()
      return
    }

    let guideContext: InstanceStartGuideContext
    try {
      const [clusterRes, shardRes] = await Promise.all([
        apiCluster.getClusterConfig(row.id),
        apiShard.getShardList(row.id),
      ])
      const master = shardRes.data.shards.find(s => s.id === 'master')
      if (!shouldOfferStartGuide(row, master?.worldGenerated)) {
        await quickStart()
        return
      }
      guideContext = buildInstanceStartGuideContext(row, clusterRes.data, shardRes.data)
    }
    catch {
      // 引导信息读取失败不阻塞启动：直接启动并提示用户稍后可配置
      faToast.warning('房间配置读取失败，已直接启动；可稍后在「房间设置」中检查配置')
      await quickStart()
      return
    }

    // 必须是响应式 ref：naive-ui 的 NCheckbox 在传入 checked 时按受控处理，
    // 普通对象不会触发重渲染，复选框会永远停在未勾选状态。
    const dontShowAgain = ref(false)
    const publicBlocked = blocksDefaultStart(guideContext)

    dialog.warning({
      title: buildStartGuideTitle(),
      content: () => renderStartGuideContent(guideContext, row.id, dontShowAgain),
      positiveText: buildStartGuidePositiveText(guideContext),
      negativeText: '取消',
      onPositiveClick: () => {
        if (dontShowAgain.value) {
          setStartGuideSkipped(row.id)
        }
        if (publicBlocked) {
          router.push(routeToDstRoomSettings(row.id))
          return
        }
        // 刻意不返回 Promise：naive-ui 会等到 onPositiveClick 的返回值 resolve 后才关闭弹窗
        // （DialogEnvironment: Promise.resolve(...).then(() => hide())），而启动请求可能包含
        // 镜像准备等耗时步骤，弹窗就会一直卡在「等待实例启动」。这里立即关闭，
        // 进度交给按钮 loading 与 toast 反馈，失败仍会弹端口冲突框或错误提示。
        void quickStart()
      },
    })
  }

  function confirmUpdateInstance(row: InstanceItem, force = false) {
    if (force && !canRepairInstance(row)) {
      return
    }
    blurFocusedElement()
    const isRepair = getInstanceState(row).key === 'install_failed'
    dialog.warning({
      title: force ? '确认校验并更新游戏文件' : isRepair ? '确认修复安装' : '确认更新服务端',
      content: force
        ? `将通过 SteamCMD 校验并更新「${row.name}」的游戏文件，可能重新下载部分内容。存档会保留，过程可在安装日志中查看。`
        : isRepair
        ? `上次安装未完成。将重新拉取「${row.name}」的游戏服务端文件，已有配置会保留，过程可在「查看日志」中查看进度。`
        : `将拉取「${row.name}」的最新游戏服务端文件。更新前请确保实例已停止，过程可在「查看日志」中查看进度。`,
      positiveText: '开始更新',
      negativeText: '取消',
      positiveButtonProps: {
        type: 'warning',
      },
      onPositiveClick: () => {
        // 更新请求本身是后台受理，不阻塞弹窗：先关闭确认框，安装日志弹窗按自己的节奏打开
        void runUpdateInstance(row, force)
      },
    })
  }

  async function runUpdateInstance(row: InstanceItem, force = false) {
    if (isInstanceActionRunning(row.id)) {
      return
    }
    options.onBeforeUpdate?.()
    const operationKey = `update:${row.id}`
    actionLoadingIds.value = new Set([...actionLoadingIds.value, operationKey])
    try {
      await apiInstance.updateInstance(row.id, { force: force || row.status === 'error' || !row.localBuildId })
      faToast.success('已开始更新服务端，请查看安装日志了解进度')
      await options.refresh()
      await options.onUpdateAccepted?.(row)
    }
    catch (error) {
      if (tryNotifyHostMemoryPressure(notification, error, () => router.push(routeToConsoleMonitor()))) {
        await options.refresh()
        return
      }
      await options.refresh()
    }
    finally {
      const next = new Set(actionLoadingIds.value)
      next.delete(operationKey)
      actionLoadingIds.value = next
    }
  }

  function confirmDangerousInstanceAction(row: InstanceItem, action: 'stop' | 'cancel_install' | 'restart' | 'delete') {
    blurFocusedElement()
    const actionConfig = {
      stop: {
        title: '确认停止',
        content: `确认停止实例「${row.name}」吗？`,
        positiveText: '停止',
        type: 'warning' as const,
      },
      cancel_install: {
        title: '确认取消安装',
        content: `将中断「${row.name}」的安装，实例将标记为异常。可查看安装日志后删除并重新创建。`,
        positiveText: '取消安装',
        type: 'warning' as const,
      },
      restart: {
        title: '确认重启',
        content: `确认重启实例「${row.name}」吗？`,
        positiveText: '重启',
        type: 'warning' as const,
      },
      delete: {
        title: '确认删除',
        content: `确认删除实例「${row.name}」吗？实例文件会一并清除。`,
        positiveText: '删除',
        type: 'error' as const,
      },
    }[action]

    dialog.warning({
      title: actionConfig.title,
      content: actionConfig.content,
      positiveText: actionConfig.positiveText,
      negativeText: '取消',
      positiveButtonProps: {
        type: actionConfig.type,
      },
      onPositiveClick: () => {
        // 同启动引导：不返回 Promise，否则弹窗要等停止/删除跑完才关闭；
        // 进度由按钮 loading 承载，失败仍有 toast 反馈。
        void runInstanceAction(row.id, action === 'cancel_install' ? 'stop' : action)
      },
    })
  }

  return {
    actionLoadingIds,
    isActionLoading,
    isInstanceActionRunning,
    runInstanceAction,
    confirmStartInstance,
    confirmUpdateInstance,
    confirmDangerousInstanceAction,
  }
}

/** 是否允许点击「更新服务端」 */
export function canUpdateInstance(instance: InstanceItem) {
  if (instance.status === 'running') {
    return false
  }
  if (instance.status === 'pending_install' || instance.status === 'installing') {
    return false
  }
  if (instance.status === 'error') {
    return true
  }
  if (!instance.localBuildId) {
    return true
  }
  if (instance.updateAvailable) {
    return true
  }
  return instance.status === 'stopped' && !isInstanceUpToDate(instance)
}

/** 「更新服务端」按钮禁用时的 tooltip */
export function getUpdateInstanceButtonTitle(instance: InstanceItem) {
  if (instance.status === 'running') {
    return '请先停止实例'
  }
  if (instance.status === 'pending_install' || instance.status === 'installing') {
    return '安装进行中'
  }
  if (instance.status === 'error') {
    return '实例异常，点击重新拉取服务端文件'
  }
  if (!instance.localBuildId) {
    return '尚未安装，点击开始安装'
  }
  if (isInstanceUpToDate(instance)) {
    return '已是最新版本'
  }
  return '更新游戏服务端'
}
