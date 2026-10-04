import type { ModUpdateCheckSummary } from '@/api/modules/mod'

/**
 * 「检查更新」结束后的提示决策。
 *
 * 这里唯一不能妥协的是：**无法判断的 Mod 绝不能和「已是最新」混在同一句话里**。
 * 面板的版本结论只在两侧都有凭据时才成立，剩下的都是「未检查」；把两者一起说成
 * 「当前 Mod 都是最新版本」，用户就会带着一台装着旧 Mod 的服务器去开服，然后被
 * 客户端的版本校验挡在门外（「服务器启用了一些旧版本的 Mod」）。
 */

export type ModUpdateCheckNoticeTone = 'success' | 'info' | 'warning'

export interface ModUpdateCheckNotice {
  /** notification 更醒目：确实发现新版本、需要用户接着操作时用它 */
  kind: 'notification' | 'message'
  tone: ModUpdateCheckNoticeTone
  title: string | null
  content: string
}

export interface ModUpdateCheckNoticeInput {
  summary: ModUpdateCheckSummary
  upstreamOk: boolean
  message: string | null
}

/** 无法判断版本的可行出口：面板已经为这类行准备了「重新下载」按钮 */
const REDOWNLOAD_HINT = '本机缺少这些 Mod 的版本记录，或工坊信息没取到；可对这几行点「重新下载」重新入账。'

export function resolveModUpdateCheckNotice(input: ModUpdateCheckNoticeInput): ModUpdateCheckNotice {
  const { total, outdated, upToDate, unknown } = input.summary
  if (total === 0) {
    return { kind: 'message', tone: 'info', title: null, content: '该实例还没有已订阅的 Mod。' }
  }
  if (!input.upstreamOk) {
    return {
      kind: 'message', tone: 'warning', title: null,
      content: `本次未能完整检查版本，未获取的条目沿用上次结果；请查看各条目的检查时间。保存的结果：${outdated} 个需要更新，${upToDate} 个检查时最新，${unknown} 个无法判断。 ${input.message?.trim() || 'Steam 元数据暂时不可达'} 可展开「下载遇到问题」查看记录，或使用本地 ZIP 导入。`,
    }
  }
  if (outdated > 0) {
    const tail = unknown > 0 ? `另有 ${unknown} 个 Mod 无法判断版本。` : ''
    return {
      kind: 'notification',
      tone: 'info',
      title: `发现 ${outdated} 个 Mod 有新版本`,
      content: `点列表里的「更新」或工具条的「全部更新」，更新完成后重启实例生效。${tail}`,
    }
  }
  if (unknown === 0) {
    return {
      kind: 'message',
      tone: 'success',
      title: null,
      content: `当前 ${upToDate} 个 Mod 都是创意工坊上的最新版本。`,
    }
  }
  const lead = upToDate === 0
    ? `有 ${unknown} 个 Mod 无法判断版本`
    : `${upToDate} 个 Mod 已是最新，另有 ${unknown} 个无法判断版本`
  return {
    kind: 'message',
    tone: 'warning',
    title: null,
    content: `${lead}：${REDOWNLOAD_HINT}`,
  }
}
