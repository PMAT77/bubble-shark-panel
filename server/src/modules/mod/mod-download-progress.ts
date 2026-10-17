import type { ModDownloadProgress } from '../../../../shared/contracts/mod'

/** Never count repeated SDK callbacks, or trust a caller-provided percentage. */
export function normalizeModDownloadProgress(value: ModDownloadProgress, previous?: ModDownloadProgress | null): ModDownloadProgress | null {
  if (!Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0 || !Number.isSafeInteger(value.downloadedBytes) || value.downloadedBytes < 0) return previous ?? null
  const totalBytes = value.totalBytes
  const downloadedBytes = Math.min(totalBytes, Math.max(value.downloadedBytes, previous?.totalBytes === totalBytes ? previous.downloadedBytes : 0))
  return { totalBytes, downloadedBytes, percent: totalBytes ? downloadedBytes * 100 / totalBytes : 100 }
}
