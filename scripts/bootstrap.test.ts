import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { it } from 'node:test'

const source = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  .match(/<script id="bsp-bootstrap">([\s\S]*?)<\/script>/)![1]

function createBootstrap() {
  const window = new EventTarget() as EventTarget & {
    setTimeout: (fn: () => void, ms: number) => number
    clearTimeout: (id: number) => void
    __BSP_BOOTSTRAP__: { state: string, message: string, fail: (message: string) => void, ready: () => boolean }
  }
  let timeout: (() => void) | undefined
  window.setTimeout = (fn, ms) => {
    assert.equal(ms, 30_000)
    timeout = fn
    return 1
  }
  window.clearTimeout = () => { timeout = undefined }
  vm.runInNewContext(source, { window, Event })
  return { window, bootstrap: window.__BSP_BOOTSTRAP__, expire: () => timeout?.() }
}

it('starts before module loading, clears the watchdog and ignores errors after ready', () => {
  const { window, bootstrap, expire } = createBootstrap()
  assert.equal(bootstrap.state, 'pending')
  assert.equal(bootstrap.ready(), true)
  expire()
  window.dispatchEvent(new Event('unhandledrejection'))
  window.dispatchEvent(new Event('vite:preloadError'))
  assert.equal(bootstrap.state, 'ready')
  assert.equal(bootstrap.message, '')
})

it('shows timeout without refreshing and allows a delayed successful start', () => {
  const { bootstrap, expire } = createBootstrap()
  expire()
  assert.equal(bootstrap.state, 'failed')
  assert.match(bootstrap.message, /超时/)
  assert.equal(bootstrap.ready(), true)
  assert.equal(bootstrap.state, 'ready')
})

it('keeps fatal module/runtime failures visible, and ignores optional image failures', () => {
  for (const type of ['error', 'unhandledrejection', 'vite:preloadError']) {
    const { window, bootstrap } = createBootstrap()
    window.dispatchEvent(new Event(type))
    assert.equal(bootstrap.state, 'failed')
    assert.equal(bootstrap.ready(), false)
  }
  const { window, bootstrap } = createBootstrap()
  const imageError = new Event('error')
  Object.defineProperty(imageError, 'target', { value: { tagName: 'IMG' } })
  window.dispatchEvent(imageError)
  assert.equal(bootstrap.state, 'pending')
  const scriptError = new Event('error')
  Object.defineProperty(scriptError, 'target', { value: { tagName: 'SCRIPT' } })
  window.dispatchEvent(scriptError)
  assert.equal(bootstrap.state, 'failed')
})
