import { createWorkshopSession, downloadWorkshopContent } from './workshop-cdn.mjs'
import { pruneWorkshopCache } from './workshop-cache.mjs'

if (process.argv.includes('--check-runtime')) process.exit(0)

// One bounded worker owns the cache. Subscribers hold a lease until installation
// finishes, so idle eviction can never remove a source being copied by the parent.
let config
let session
let active = 0
let idleTimer
let lastOwner
const queue = []
const inFlight = new Map()
const subscribers = new Map()
const runningIds = new Set()
const send = value => { if (process.connected) process.send?.(value, () => {}) }
const failure = error => String(error?.message || error).replace(/https?:\/\/\S+/g, '[URL]')

function idle() {
  clearTimeout(idleTimer)
  if (active || queue.length || subscribers.size) return
  session?.transport.save()
  idleTimer = setTimeout(() => { session?.close(); process.exit(0) }, 60_000)
}

function pump() {
  while (active < 2) {
    let index = queue.findIndex(job => !runningIds.has(job.id) && job.owner !== lastOwner)
    if (index < 0) index = queue.findIndex(job => !runningIds.has(job.id))
    if (index < 0) break
    const job = queue.splice(index, 1)[0]
    if (!job.listeners.size) continue
    active++
    runningIds.add(job.id)
    job.started = true
    job.startedAt = Date.now()
    lastOwner = job.owner
    job.lastActivity = Date.now()
    const hardTimeout = setTimeout(() => job.controller.abort(new Error('Mod 下载超时，请重试')), job.timeoutMs)
    const progressTimeout = setInterval(() => {
      if (Date.now() - job.lastActivity > 120_000) job.controller.abort(new Error('Steam 请求无进展超时，请重试'))
    }, 1000)
    const run = async () => {
      if (!session || session.signal.aborted) { session?.close(); session = createWorkshopSession(config) }
      const results = await downloadWorkshopContent({ ...config, ids: [job.id], existingRoot: job.existingRoot,
        legacyCacheRoot: job.legacyCacheRoot, session, signal: job.controller.signal,
        onEvent: event => {
          if (event.phase === 'activity' || event.phase === 'checkpoint' || event.progress?.downloadedBytes > (job.lastBytes || 0)) job.lastActivity = Date.now()
          job.lastBytes = event.progress?.downloadedBytes ?? job.lastBytes
          if (event.phase === 'activity') return
          job.event = event
          for (const requestId of job.listeners) send({ type: 'progress', requestId, event })
        } })
      return { ...results[0], diagnostics: { ...results[0]?.diagnostics, queueWaitMs: job.startedAt - job.queuedAt } }
    }
    void run().catch(error => ({ workshopId: job.id, ok: false, error: failure(error), failureStage: error.failureStage || 'content',
      errorCode: /超时/.test(error.message) ? 'WORKSHOP_TIMEOUT' : job.controller.signal.aborted ? 'WORKSHOP_CANCELLED' : 'WORKSHOP_WORKER_FAILED' }))
      .then(result => {
        for (const requestId of job.listeners) send({ type: 'result', requestId, result })
      }).finally(() => {
        clearTimeout(hardTimeout)
        clearInterval(progressTimeout)
        job.done = true
        active--
        runningIds.delete(job.id)
        if (inFlight.get(job.id) === job) inFlight.delete(job.id)
        for (const requestId of job.cancelled || []) send({ type: 'cancelled', requestId })
        pump()
        idle()
      })
  }
}

process.on('message', input => {
  clearTimeout(idleTimer)
  if (input?.type === 'init' && !config) { config = input.config; return }
  if (input?.type === 'prune' && config && !active && !queue.length && !subscribers.size) {
    try { pruneWorkshopCache(config.cacheRoot, config.maxCacheBytes) }
    catch (error) { send({ type: 'diagnostic', message: `缓存清理未完成：${failure(error)}` }) }
    idle()
    return
  }
  if (!config || typeof input?.requestId !== 'string') return
  const requestId = input.requestId
  if (input.type === 'download' && /^[1-9]\d{0,19}$/.test(input.workshopId)) {
    if (subscribers.has(requestId)) return
    let job = inFlight.get(input.workshopId)
    if (!job || job.controller.signal.aborted) {
      job = { id: input.workshopId, owner: input.instanceId, queuedAt: Date.now(), existingRoot: input.existingRoot, legacyCacheRoot: input.legacyCacheRoot,
        timeoutMs: input.timeoutMs, controller: new AbortController(), listeners: new Set() }
      inFlight.set(job.id, job)
      queue.push(job)
    }
    job.listeners.add(requestId)
    subscribers.set(requestId, job)
    if (job.event) send({ type: 'progress', requestId, event: job.event })
    else send({ type: 'progress', requestId, event: { workshopId: job.id, phase: 'waiting_download', progress: null } })
    pump()
  }
  else if (input.type === 'cancel' || input.type === 'release') {
    const job = subscribers.get(requestId)
    subscribers.delete(requestId)
    job?.listeners.delete(requestId)
    if (job && !job.listeners.size && !job.done) {
      job.controller.abort(new Error('下载已取消'))
      if (inFlight.get(job.id) === job) inFlight.delete(job.id)
      if (job.started) (job.cancelled ||= []).push(requestId)
      else {
        const index = queue.indexOf(job)
        if (index >= 0) queue.splice(index, 1)
        send({ type: 'cancelled', requestId })
      }
    }
    else if (input.type === 'cancel') send({ type: 'cancelled', requestId })
    idle()
  }
})
process.once('disconnect', () => process.exit(1))
