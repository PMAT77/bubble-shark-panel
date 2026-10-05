import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { RuntimeEnvironmentInput } from './steamcmdPanelPresentation.ts'
import { resolveRuntimeEnvironmentView } from './steamcmdPanelPresentation.ts'

const UNIFIED_REF = 'ghcr.io/pmat77/bubblesharkpanel:v0.4.2'

function baseInput(overrides: Partial<RuntimeEnvironmentInput> = {}): RuntimeEnvironmentInput {
  return {
    isNativeMode: false,
    runtimeAvailable: true,
    steamcmdInstalled: true,
    gameDstInstalled: true,
    steamcmdImage: UNIFIED_REF,
    gameDstImage: UNIFIED_REF,
    ...overrides,
  }
}

function tagsOf(input: RuntimeEnvironmentInput): string[] {
  return resolveRuntimeEnvironmentView(input).tags.map(tag => tag.text)
}

describe('resolveRuntimeEnvironmentView', () => {
  it('Docker 同源：合并为一行游戏镜像与一条就绪标签', () => {
    const view = resolveRuntimeEnvironmentView(baseInput())

    assert.equal(view.imageUnified, true)
    assert.deepEqual(view.imageRows, [{ label: '游戏镜像', value: UNIFIED_REF }])
    assert.deepEqual(tagsOf(baseInput()), ['Docker 可用', '游戏镜像已就绪'])
    assert.equal(view.primaryActionLabel, '准备游戏镜像')
    assert.equal(view.secondaryPullVisible, false)
    assert.equal(view.hint, null)
  })

  it('Docker 同源且镜像缺失：标签与提示都说游戏镜像，且不给出等价的第二入口', () => {
    const input = baseInput({ steamcmdInstalled: false, gameDstInstalled: false })
    const view = resolveRuntimeEnvironmentView(input)

    assert.deepEqual(tagsOf(input), ['Docker 可用', '游戏镜像未就绪'])
    assert.equal(view.hint?.tone, 'warning')
    assert.match(view.hint?.text ?? '', /提前准备/)
    // 同源时两个入口拉同一个引用，第二个按钮只是主按钮的重复
    assert.equal(view.secondaryPullVisible, false)
  })

  it('Docker 异构：退回两行镜像与三条标签', () => {
    const input = baseInput({
      steamcmdInstalled: true,
      gameDstInstalled: false,
      gameDstImage: 'ghcr.io/pmat77/bubblesharkpanel:v0.3.10',
    })
    const view = resolveRuntimeEnvironmentView(input)

    assert.equal(view.imageUnified, false)
    assert.deepEqual(view.imageRows, [
      { label: '安装镜像', value: UNIFIED_REF },
      { label: '运行镜像', value: 'ghcr.io/pmat77/bubblesharkpanel:v0.3.10' },
    ])
    assert.deepEqual(tagsOf(input), ['Docker 可用', '安装镜像已就绪', '安装实例后自动准备'])
    assert.equal(view.secondaryPullVisible, true)
  })

  it('Docker 异构且运行镜像已就绪：不再需要第二个入口', () => {
    const input = baseInput({
      gameDstInstalled: true,
      gameDstImage: 'ghcr.io/pmat77/bubblesharkpanel:v0.3.10',
    })

    assert.equal(resolveRuntimeEnvironmentView(input).secondaryPullVisible, false)
  })

  it('Docker 异构时运行镜像已就绪也单独成标签', () => {
    const input = baseInput({ steamcmdInstalled: false, gameDstInstalled: true, steamcmdImage: '' })

    assert.deepEqual(tagsOf(input), ['Docker 可用', '安装镜像未就绪', '运行镜像已就绪'])
  })

  it('两侧均为空不误判为同源，也不误报已就绪', () => {
    const input = baseInput({ steamcmdImage: '', gameDstImage: '' })
    const view = resolveRuntimeEnvironmentView(input)

    assert.equal(view.imageUnified, false)
    assert.equal(view.imageRows.length, 2)
    assert.deepEqual(tagsOf(input), ['Docker 可用', '安装镜像已就绪', '运行镜像已就绪'])
  })

  it('只有一侧为空按异构处理', () => {
    const view = resolveRuntimeEnvironmentView(baseInput({ gameDstImage: '' }))

    assert.equal(view.imageUnified, false)
    assert.equal(view.imageRows[1]?.value, '')
  })

  it('首尾空格不影响同源判定', () => {
    const view = resolveRuntimeEnvironmentView(baseInput({ steamcmdImage: ` ${UNIFIED_REF} `, gameDstImage: UNIFIED_REF }))

    assert.equal(view.imageUnified, true)
  })

  it('Docker 不可用时给出连接排障提示，而不是「镜像未就绪」提示', () => {
    const input = baseInput({ runtimeAvailable: false, steamcmdInstalled: false, gameDstInstalled: false })
    const view = resolveRuntimeEnvironmentView(input)

    assert.deepEqual(tagsOf(input), ['Docker 不可用', '游戏镜像未就绪'])
    assert.equal(view.hint?.tone, 'error')
    assert.match(view.hint?.text ?? '', /Docker 已启动/)
  })

  it('Native 模式：SteamCMD 路径单行、无运行镜像行与 Docker 标签', () => {
    const input = baseInput({
      isNativeMode: true,
      steamcmdImage: '/opt/bubblesharkpanel/runtime/steamcmd/steamcmd.sh',
      gameDstImage: '',
    })
    const view = resolveRuntimeEnvironmentView(input)

    assert.equal(view.imageUnified, false)
    assert.deepEqual(view.imageRows, [{ label: 'SteamCMD 路径', value: '/opt/bubblesharkpanel/runtime/steamcmd/steamcmd.sh' }])
    assert.deepEqual(tagsOf(input), ['运行环境正常', 'SteamCMD 已就绪'])
    assert.equal(view.primaryActionLabel, '检查 SteamCMD')
    assert.equal(view.secondaryPullVisible, false)
    assert.equal(view.hint, null)
  })

  it('Native 模式且运行环境不可用：提示 systemd 排障', () => {
    const view = resolveRuntimeEnvironmentView(baseInput({
      isNativeMode: true,
      runtimeAvailable: false,
      steamcmdInstalled: false,
    }))

    assert.equal(view.hint?.tone, 'error')
    assert.match(view.hint?.text ?? '', /运行环境不可用/)
  })

  it('Native 模式且运行环境不可用时运行镜像恒为未就绪，也不能因此漏出第二入口', () => {
    // Native 下 isGameDstImageInstalled 跟随 runtimeStatus，环境不可用时为 false；
    // 若只用「!imageUnified」判断，这个 false 会把 Docker 专有的第二入口漏到 Native 界面上。
    const view = resolveRuntimeEnvironmentView(baseInput({
      isNativeMode: true,
      runtimeAvailable: false,
      steamcmdInstalled: false,
      gameDstInstalled: false,
    }))

    assert.equal(view.secondaryPullVisible, false)
  })

  it('界面文案不含部署变量名与容器内路径这类实现细节', () => {
    const inputs = [
      baseInput(),
      baseInput({ steamcmdInstalled: false, gameDstInstalled: false }),
      baseInput({ gameDstImage: 'other:tag' }),
      baseInput({ runtimeAvailable: false }),
      baseInput({ isNativeMode: true, gameDstImage: '' }),
    ]

    const texts = inputs.flatMap((input) => {
      const view = resolveRuntimeEnvironmentView(input)
      return [
        ...view.imageRows.map(row => row.label),
        ...view.tags.map(tag => tag.text),
        view.primaryActionLabel,
        view.hint?.text ?? '',
      ]
    }).join('\n')

    for (const forbidden of ['PANEL_INSTANCES_DIR', '容器内', '数据卷', '统一镜像', '面板更新', 'BSP_', 'systemd', 'linger', 'user bus', 'Compose', 'panel.env']) {
      assert.equal(texts.includes(forbidden), false, `界面文案不应出现「${forbidden}」`)
    }
  })
})
