import apiInstance from '@/api/modules/instance'

export async function waitForInstanceUpdateCheckJob(signal?: AbortSignal) {
  const deadline = Date.now() + 100_000
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException('检查已取消', 'AbortError')
    const res = await apiInstance.getInstanceUpdateCheckStatus({ signal })
    if (!res.data.checking) return res.data
    await new Promise<void>(resolve => setTimeout(resolve, 2000))
  }
  throw new Error('Steam 版本查询仍未完成，请稍后重新检查')
}
