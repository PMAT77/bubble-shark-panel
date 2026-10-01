import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import type { HostMemoryPressureData } from '../../shared/contracts/host-memory-pressure'
import {
  buildHostMemoryPressureSummaryLines,
  buildMonitorHref,
  HOST_MEMORY_PRESSURE_FOOTER,
  HOST_MEMORY_PRESSURE_NO_SWAP_HINT,
  HOST_MEMORY_PRESSURE_SETUP_SWAP_COMMAND,
  HOST_MEMORY_PRESSURE_SWAP_READY_HINT,
  HOST_MEMORY_PRESSURE_TITLE,
  isSwapConfigured,
  renderMonitorAction,
  showHostMemoryPressureNotification,
} from './hostMemoryPressure'

/**
 * 内存不足通知：文案要短到一眼能看完，按钮要真的能跳。
 *
 * 两件事都在这里钉住：
 * 1. 有没有 swap 决定中间那段是「先执行 sudo gsh setup-swap」还是「启动继续」——判据来自契约字段
 *    `swapFreeMb`，0 与 null 都要按「没有」处理；
 * 2. 「查看内存占用」点击后必须先销毁通知再导航，并且带 `<a href>` 兜底——此前是点击时才
 *    动态 import router 的写法，加载失败即静默中止，表现就是「点了没反应」。
 */

function makeData(overrides: Partial<HostMemoryPressureData> = {}): HostMemoryPressureData {
  return {
    availableMb: 3359,
    requiredMb: 3456,
    totalMb: 3915,
    capMb: 1536,
    swapFreeMb: 0,
    detail: '当前可用约 3359 MiB，可用 swap 约 0 MiB，本操作建议至少 3456 MiB（总内存约 3915 MiB）。',
    ...overrides,
  }
}

interface VNodeLike {
  type?: unknown
  props?: Record<string, unknown>
  children?: unknown
}

/** 把 VNode 树里所有字符串片段收集出来，以便对渲染出来的文案做断言 */
function collectText(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return out
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      collectText(child, out)
    }
    return out
  }
  collectText((node as VNodeLike).children, out)
  return out
}

/** naive-ui 的 NotificationApi 只用到 warning 一个方法，这里给最小替身并交回捕获到的配置 */
interface CapturedNotice {
  title: string
  content: () => unknown
}

function captureNotice(data: HostMemoryPressureData): CapturedNotice {
  let captured: CapturedNotice | null = null
  const notification = {
    warning: ((options: CapturedNotice) => {
      captured = options
      return { destroy: () => {} }
    }) as unknown,
  }
  showHostMemoryPressureNotification(
    notification as never,
    {
      code: 'HOST_MEMORY_PRESSURE',
      error: '宿主机可用内存不足',
      data,
    },
  )
  assert.ok(captured, '通知没有被创建')
  return captured
}

describe('isSwapConfigured', () => {
  it('swapFreeMb 为 0 或 null 时按未配置处理', () => {
    assert.equal(isSwapConfigured({ swapFreeMb: 0 }), false)
    assert.equal(isSwapConfigured({ swapFreeMb: null }), false)
  })

  it('只要有 swap 余量就算已配置', () => {
    assert.equal(isSwapConfigured({ swapFreeMb: 1 }), true)
    assert.equal(isSwapConfigured({ swapFreeMb: 2048 }), true)
  })
})

describe('buildHostMemoryPressureSummaryLines', () => {
  it('两个数字取自守卫的读数', () => {
    assert.deepEqual(buildHostMemoryPressureSummaryLines(makeData()), [
      '当前可用内存：3359 MiB',
      '本次启动预计需要：3456 MiB',
    ])
  })
})

describe('buildMonitorHref', () => {
  it('hash 模式给 # 开头的地址', () => {
    assert.equal(buildMonitorHref('http://127.0.0.1:9527/#/games/dst/rooms', '/'), '#/console/monitor')
  })

  it('history 模式带 base 前缀', () => {
    assert.equal(buildMonitorHref('http://example.com/gsh/games/dst/rooms', '/gsh/'), '/gsh/console/monitor')
    assert.equal(buildMonitorHref('http://example.com/games/dst/rooms', '/'), '/console/monitor')
  })
})

describe('renderMonitorAction', () => {
  const globalWithLocation = globalThis as { location?: { assign: (url: string) => void } }

  it('渲染成带 href 的 <a>，并保留可点击样式', () => {
    const action = renderMonitorAction({ destroy: () => {} }) as VNodeLike
    assert.equal(action.type, 'a')
    assert.match(String(action.props?.href), /console\/monitor$/)
    assert.match(String(action.props?.class), /cursor-pointer/)
  })

  it('点击后先销毁通知再走命名路由导航', async () => {
    const destroy = mock.fn()
    const navigate = mock.fn(async () => undefined)
    const action = renderMonitorAction({ destroy }, navigate) as VNodeLike

    let defaultPrevented = false
    const onClick = action.props?.onClick as (event: unknown) => Promise<void>
    await onClick({
      preventDefault: () => {
        defaultPrevented = true
      },
    })

    assert.equal(defaultPrevented, true)
    assert.equal(destroy.mock.callCount(), 1)
    assert.equal(navigate.mock.callCount(), 1)
  })

  it('导航失败时回落到浏览器跳转，不让这次点击白点', async () => {
    const assign = mock.fn()
    const previousLocation = globalWithLocation.location
    globalWithLocation.location = { assign }
    const consoleError = mock.method(console, 'error', () => {})
    try {
      const action = renderMonitorAction(
        { destroy: () => {} },
        async () => {
          throw new Error('navigation aborted')
        },
      ) as VNodeLike
      const onClick = action.props?.onClick as (event: unknown) => Promise<void>
      await onClick({ preventDefault: () => {} })
      assert.equal(assign.mock.callCount(), 1)
      assert.match(String(assign.mock.calls[0].arguments[0]), /console\/monitor$/)
    }
    finally {
      consoleError.mock.restore()
      if (previousLocation === undefined) {
        delete globalWithLocation.location
      }
      else {
        globalWithLocation.location = previousLocation
      }
    }
  })
})

describe('showHostMemoryPressureNotification', () => {
  it('没有 swap 时给出可直接执行的那行命令', () => {
    const options = captureNotice(makeData({ swapFreeMb: 0 }))
    const text = collectText(options.content())
    assert.equal(options.title, HOST_MEMORY_PRESSURE_TITLE)
    // 命令单独成行：拼进段落里会被当成一句话读，照抄时容易带上多余字符
    assert.deepEqual(text.slice(0, 2), ['当前可用内存：3359 MiB', '本次启动预计需要：3456 MiB'])
    assert.deepEqual(text.slice(2), [
      HOST_MEMORY_PRESSURE_NO_SWAP_HINT,
      HOST_MEMORY_PRESSURE_SETUP_SWAP_COMMAND,
      HOST_MEMORY_PRESSURE_FOOTER,
    ])
    // 长版 detail 不再进通知，但 API 响应里仍然带着它
    assert.ok(!text.some(line => line.includes('本操作建议至少')))
  })

  it('已有 swap 时只说启动继续', () => {
    const text = collectText(captureNotice(makeData({ swapFreeMb: 2048 })).content())
    assert.deepEqual(text, [
      '当前可用内存：3359 MiB',
      '本次启动预计需要：3456 MiB',
      HOST_MEMORY_PRESSURE_SWAP_READY_HINT,
      HOST_MEMORY_PRESSURE_FOOTER,
    ])
    assert.ok(!text.includes(HOST_MEMORY_PRESSURE_SETUP_SWAP_COMMAND))
  })

  it('读不到 meminfo（null）时按没有 swap 提示', () => {
    const text = collectText(captureNotice(makeData({ swapFreeMb: null })).content())
    assert.ok(text.includes(HOST_MEMORY_PRESSURE_SETUP_SWAP_COMMAND))
  })
})
