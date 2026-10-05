/**
 * 面板页面版本与运行中面板版本的比对（纯函数，便于单测）。
 *
 * 背景：面板在浏览器里是一个长时间驻留的单页应用。升级面板只会换掉服务器上的前端产物，
 * **已经打开的标签页仍然执行升级前的脚本**——更新流程也没有任何重新加载页面的动作。
 * 结果是升级成功后用户继续看着旧界面（旧按钮、旧文案），并以为新功能没生效。
 *
 * 这里只回答一个问题：页面里跑的这份前端，和正在提供服务的面板是不是同一个版本。
 */

/** 统一版本写法：去掉 v 前缀与空白，便于 package.json 的数字版本与 Release tag 的 vX.Y.Z 互比 */
export function normalizePanelVersion(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/^v/i, '')
}

/** 页面自身的构建版本；开发构建与测试环境没有注入，返回空串表示「不判定」 */
export function readBuiltPanelVersion(): string {
  // 构建期由 vite define 注入（见 vite.config.ts 的 __SYSTEM_INFO__）；
  // 未注入时用 typeof 判断，不会抛 ReferenceError。
  if (typeof __SYSTEM_INFO__ === 'undefined') {
    return ''
  }
  return normalizePanelVersion(__SYSTEM_INFO__?.pkg?.version)
}

export interface PanelVersionMismatch {
  /** 页面里这份前端的版本 */
  builtVersion: string
  /** 正在运行的面板上报的版本 */
  runningVersion: string
  /** true = 页面落后（或与后端不同源），需要刷新 */
  stale: boolean
}

/**
 * 比对两侧版本。
 * 任一侧为空时返回 null（不判定）：开发构建、未设置 BSP_RELEASE_VERSION 的部署、
 * 以及拿不到 /health 的情况都不该弹提示——宁可不提示，也不能误报。
 */
export function resolvePanelVersionMismatch(
  builtVersion: string | null | undefined,
  runningVersion: string | null | undefined,
): PanelVersionMismatch | null {
  const built = normalizePanelVersion(builtVersion)
  const running = normalizePanelVersion(runningVersion)
  if (!built || !running) {
    return null
  }
  return {
    builtVersion: built,
    runningVersion: running,
    stale: built !== running,
  }
}
