import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PanelUpdateStatus } from '../../../shared/contracts/system.ts'
import {
  buildPanelUpdatePresentation,
  formatByteSize,
  MANUAL_UPDATE_NOTE,
} from './panelUpdatePresentation.ts'

type StatusOverrides = Partial<Omit<PanelUpdateStatus, 'image' | 'release'>> & {
  image?: Partial<PanelUpdateStatus['image']>
  release?: PanelUpdateStatus['release']
}

function buildStatus(overrides: StatusOverrides = {}): PanelUpdateStatus {
  const { image, release, ...rest } = overrides
  return {
    runtimeMode: 'docker',
    image: {
      image: 'ghcr.io/pmat77/bubblesharkpanel:v0.2.2',
      tag: 'v0.2.2',
      releaseVersion: 'v0.2.2',
      localDigest: 'sha256:1111',
      localDigestShort: '1111',
      remoteDigest: 'sha256:2222',
      remoteDigestShort: '2222',
      updateAvailable: true,
      localPresent: true,
      checkError: null,
      ...image,
    },
    release: release === undefined
      ? {
          tagName: 'v0.2.2',
          name: 'v0.2.2',
          body: '本 Release 的统一镜像……',
          publishedAt: '2026-09-08T00:00:00Z',
          htmlUrl: 'https://github.com/PMAT77/bubble-shark-panel/releases/tag/v0.2.2',
        }
      : release,
    lastCheckedAt: '2026-09-10T03:19:14.000Z',
    checking: false,
    updating: false,
    applySupported: true,
    imageApplySupported: false,
    nativeUpdateSupported: false,
    applyHint: '未配置 BSP_STACK_DIR，无法一键更新面板。',
    updateKind: 'same-version-changed',
    manualUpdateCommand: 'cd /opt/bubblesharkpanel && docker compose --env-file panel.env pull',
    offlineImageCommand: null,
    checkError: null,
    updatePhase: 'idle',
    updateMessage: null,
    updateError: null,
    targetImage: null,
    targetImageReady: false,
    downloadBytes: null,
    downloadTotalBytes: null,
    ...rest,
  }
}

describe('buildPanelUpdatePresentation', () => {
  it('reports a higher release as a new version', () => {
    const view = buildPanelUpdatePresentation(buildStatus({
      updateKind: 'newer',
      release: {
        tagName: 'v0.3.0',
        name: 'v0.3.0',
        body: '',
        publishedAt: '2026-09-15T00:00:00Z',
        htmlUrl: 'https://github.com/PMAT77/bubble-shark-panel/releases/tag/v0.3.0',
      },
    }))
    assert.equal(view.versionLine, '当前版本：v0.2.2 · 有新版本 v0.3.0')
  })

  it('reports the same version with different image content', () => {
    const view = buildPanelUpdatePresentation(buildStatus())
    assert.equal(view.versionLine, '当前版本：v0.2.2 · 已发布更新')
  })

  it('says it is up to date when the digests match', () => {
    const view = buildPanelUpdatePresentation(buildStatus({
      updateKind: 'none',
      image: { updateAvailable: false, remoteDigest: 'sha256:1111', remoteDigestShort: '1111' },
    }))
    assert.equal(view.versionLine, '当前版本：v0.2.2 · 已是最新')
  })

  it('asks for a manual command only when an update cannot be applied here', () => {
    assert.equal(buildPanelUpdatePresentation(buildStatus()).needsManualCommand, true)
    assert.equal(buildPanelUpdatePresentation(buildStatus({ imageApplySupported: true })).needsManualCommand, false)
    assert.equal(buildPanelUpdatePresentation(buildStatus({
      updateKind: 'none',
      image: { updateAvailable: false },
    })).needsManualCommand, false)
  })

  it('prioritises the in-progress state and shows the running phase', () => {
    const view = buildPanelUpdatePresentation(buildStatus({ updating: true, updatePhase: 'downloading' }))
    assert.equal(view.versionLine, '当前版本：v0.2.2 · 正在下载更新')
    assert.equal(view.needsManualCommand, false)
    assert.match(view.phaseLine ?? '', /正在下载更新/)
    assert.equal(view.updateFailed, false)
  })

  it('shows the downloaded amount while downloading', () => {
    const view = buildPanelUpdatePresentation(buildStatus({
      updating: true,
      updatePhase: 'downloading',
      downloadBytes: 536_870_912,
      downloadTotalBytes: 1_288_490_189,
    }))
    assert.equal(view.progressText, '已下载 512 MB / 1.2 GB')
    assert.equal(view.action, 'busy')
    assert.equal(view.actionLabel, '下载中…')
  })

  it('omits the total when the registry reports no sizes', () => {
    const view = buildPanelUpdatePresentation(buildStatus({
      updating: true,
      updatePhase: 'downloading',
      downloadBytes: 1_048_576,
      downloadTotalBytes: null,
    }))
    assert.equal(view.progressText, '已下载 1 MB')
  })

  it('offers the install action once the image is downloaded', () => {
    const view = buildPanelUpdatePresentation(buildStatus({
      updatePhase: 'downloaded',
      targetImageReady: true,
      imageApplySupported: true,
    }))
    assert.equal(view.action, 'install')
    assert.equal(view.actionLabel, '立即安装')
    assert.equal(view.progressText, null)
    assert.match(view.phaseLine ?? '', /立即安装/)
  })

  it('asks for a download first and a re-download after a failure', () => {
    assert.equal(buildPanelUpdatePresentation(buildStatus({ imageApplySupported: true })).actionLabel, '下载更新')
    const failed = buildPanelUpdatePresentation(buildStatus({
      imageApplySupported: true,
      updatePhase: 'failed',
      updateError: '网络超时',
    }))
    assert.equal(failed.actionLabel, '重新下载')
    assert.equal(failed.progressText, null)
  })

  it('keeps the button inert when the panel cannot apply the update here', () => {
    assert.equal(buildPanelUpdatePresentation(buildStatus()).action, 'none')
  })

  it('uses the Native update channel once the installer has set it up', () => {
    const downloadable = buildPanelUpdatePresentation(buildStatus({
      runtimeMode: 'native',
      nativeUpdateSupported: true,
    }))
    assert.equal(downloadable.action, 'download')
    assert.equal(downloadable.actionLabel, '下载更新')
    assert.equal(downloadable.needsManualCommand, false)

    const ready = buildPanelUpdatePresentation(buildStatus({
      runtimeMode: 'native',
      nativeUpdateSupported: true,
      updatePhase: 'downloaded',
      targetImage: 'v0.3.0',
      targetImageReady: true,
    }))
    assert.equal(ready.action, 'install')
    assert.equal(ready.actionLabel, '立即安装')

    const running = buildPanelUpdatePresentation(buildStatus({
      runtimeMode: 'native',
      nativeUpdateSupported: true,
      updating: true,
      updatePhase: 'recreating',
      targetImage: 'v0.3.0',
      targetImageReady: true,
    }))
    assert.equal(running.action, 'busy')
    assert.match(running.phaseLine ?? '', /重启面板/)
  })

  it('keeps asking for a manual command on Native installs without the update helper', () => {
    const view = buildPanelUpdatePresentation(buildStatus({ runtimeMode: 'native' }))
    assert.equal(view.needsManualCommand, true)
    assert.equal(view.action, 'none')
  })

  it('formats byte sizes for the progress line', () => {
    assert.equal(formatByteSize(0), '0 B')
    assert.equal(formatByteSize(2_048), '2 KB')
    assert.equal(formatByteSize(536_870_912), '512 MB')
    assert.equal(formatByteSize(1_288_490_189), '1.2 GB')
  })

  it('prefers the backend message over the generic phase text', () => {
    const view = buildPanelUpdatePresentation(buildStatus({
      updating: true,
      updatePhase: 'preparing',
      updateMessage: '检测到本地已有目标镜像，跳过下载',
    }))
    assert.equal(view.phaseLine, '检测到本地已有目标镜像，跳过下载')
  })

  it('surfaces the failure reason instead of staying silent', () => {
    const view = buildPanelUpdatePresentation(buildStatus({
      updatePhase: 'failed',
      updateError: '无法从镜像仓库拉取镜像（网络超时或被阻断）',
    }))
    assert.equal(view.updateFailed, true)
    assert.match(view.phaseLine ?? '', /网络超时或被阻断/)
    assert.equal(view.needsManualCommand, true)
  })

  it('stays quiet when no update is running', () => {
    assert.equal(buildPanelUpdatePresentation(buildStatus()).phaseLine, null)
  })

  it('handles a null status without throwing', () => {
    const view = buildPanelUpdatePresentation(null)
    assert.equal(view.versionLine, '')
    assert.equal(view.needsManualCommand, false)
    assert.equal(view.phaseLine, null)
    assert.equal(view.updateFailed, false)
  })
})

describe('manual update note', () => {
  it('states the conclusion without deployment jargon', () => {
    assert.match(MANUAL_UPDATE_NOTE, /无法在面板里更新/)
    assert.doesNotMatch(MANUAL_UPDATE_NOTE, /digest|摘要|BSP_STACK_DIR|systemd|编排文件|compose|镜像|容器/)
  })
})
