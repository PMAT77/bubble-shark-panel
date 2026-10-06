/** 合并并发读；失败或期间发生生命周期写入时不复用快照。 */
export function createReconciliationCache(run: () => Promise<boolean>, revision: () => number, now = Date.now) {
  let pending: Promise<void> | undefined
  let pendingRevision = -1
  let cachedRevision = -1
  let expires = 0
  return async function reconcile(): Promise<void> {
    if (pending) {
      const sameRevision = pendingRevision === revision()
      await pending
      if (sameRevision) return
      return reconcile()
    }
    if (cachedRevision === revision() && now() < expires) return
    pendingRevision = revision()
    pending = (async () => {
      const complete = await run()
      if (complete && pendingRevision === revision()) {
        cachedRevision = pendingRevision
        expires = now() + 1000
      }
    })()
    try { await pending }
    finally { pending = undefined }
  }
}
