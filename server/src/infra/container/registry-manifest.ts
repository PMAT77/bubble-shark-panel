import { readBrandEnv } from '../../../../shared/brand-env'
import {
  buildRegistryBlobUrl,
  buildRegistryManifestUrl,
  normalizeDigest,
  parseImageRef,
} from './image-ref'

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

export interface RegistryAuthOptions {
  username?: string | null
  password?: string | null
}

interface BearerChallenge {
  realm: string
  service: string
  scope: string
}

interface ManifestIndex {
  manifests?: Array<{
    digest: string
    platform?: {
      os?: string
      architecture?: string
    }
  }>
}

interface ImageManifest {
  config?: {
    digest?: string
  }
}

interface ImageConfig {
  rootfs?: {
    diff_ids?: string[]
  }
}

/**
 * 远端镜像的身份信息。
 * 同一个镜像在不同层级各有一个摘要：manifest list（多架构索引入口）、
 * 各平台清单、平台清单里的 config，以及 config 内部的未压缩层摘要 ——
 * 本地镜像只会持有其中某几个，所以必须成套比对，否则永远对不上号。
 */
export interface RemoteImageIdentity {
  /** 与 `docker pull` / `docker inspect .RepoDigests` 同口径的摘要；多架构镜像下即 manifest list 摘要 */
  primary: string | null
  /** 同一镜像的其它等价摘要：各平台清单摘要，以及平台清单指向的 config 摘要（等同本地 image Id） */
  aliases: string[]
  /** 平台清单 config 里的未压缩层摘要，等同本地 `RootFS.Layers`：打包方式变了也能认出同一份内容 */
  layers: string[]
}

function readContentDigest(response: Response): string | null {
  return normalizeDigest(
    response.headers.get('docker-content-digest')
    ?? response.headers.get('Docker-Content-Digest'),
  )
}

export function parseBearerChallenge(wwwAuthenticate: string | null | undefined): BearerChallenge | null {
  if (!wwwAuthenticate?.startsWith('Bearer ')) {
    return null
  }
  const params = new Map<string, string>()
  const body = wwwAuthenticate.slice('Bearer '.length)
  for (const part of body.split(',')) {
    const match = part.trim().match(/^(\w+)="([^"]*)"$/)
    if (match) {
      params.set(match[1], match[2])
    }
  }
  const realm = params.get('realm')
  const service = params.get('service')
  const scope = params.get('scope')
  if (!realm || !service || !scope) {
    return null
  }
  return { realm, service, scope }
}

export function resolvePreferredPlatform(): { os: string, architecture: string } {
  return {
    os: process.platform === 'win32' ? 'windows' : 'linux',
    architecture: process.arch === 'arm64' ? 'arm64' : 'amd64',
  }
}

export function pickManifestDigestFromIndex(index: ManifestIndex): string | null {
  const preferred = resolvePreferredPlatform()
  const candidates = (index.manifests ?? []).filter((item) => {
    const os = item.platform?.os ?? ''
    return os !== 'unknown'
  })
  const exact = candidates.find((item) => {
    const os = item.platform?.os ?? ''
    const architecture = item.platform?.architecture || 'amd64'
    return os === preferred.os && architecture === preferred.architecture
  })
  if (exact?.digest) {
    return normalizeDigest(exact.digest)
  }
  const linuxFallback = candidates.find((item) => {
    const os = item.platform?.os ?? ''
    const architecture = item.platform?.architecture || 'amd64'
    return os === 'linux' && architecture === preferred.architecture
  })
  if (linuxFallback?.digest) {
    return normalizeDigest(linuxFallback.digest)
  }
  const first = candidates[0]?.digest
  return first ? normalizeDigest(first) : null
}

/** 列出索引里所有平台清单摘要（跳过 attestation 这类 os=unknown 的条目） */
export function collectIndexManifestDigests(index: ManifestIndex): string[] {
  const digests = (index.manifests ?? [])
    .filter(item => (item.platform?.os ?? '') !== 'unknown')
    .map(item => normalizeDigest(item.digest))
    .filter((digest): digest is string => Boolean(digest))
  return [...new Set(digests)]
}

function isManifestIndexContentType(contentType: string | null): boolean {
  if (!contentType) {
    return false
  }
  return contentType.includes('manifest.list')
    || contentType.includes('image.index')
}

function resolveRegistryAuthOptions(auth?: RegistryAuthOptions): RegistryAuthOptions {
  return {
    username: auth?.username?.trim()
      || readBrandEnv('BSP_REGISTRY_USERNAME')?.trim()
      || null,
    password: auth?.password?.trim()
      || readBrandEnv('BSP_REGISTRY_PASSWORD')?.trim()
      || null,
  }
}

async function fetchBearerToken(
  challenge: BearerChallenge,
  auth: RegistryAuthOptions,
): Promise<string> {
  const url = new URL(challenge.realm)
  url.searchParams.set('service', challenge.service)
  url.searchParams.set('scope', challenge.scope)
  const headers: Record<string, string> = {}
  if (auth.username && auth.password) {
    headers.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`
  }
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    throw new Error(`Registry 鉴权失败 (${response.status})`)
  }
  const json = await response.json() as { token?: string, access_token?: string }
  const token = json.token?.trim() || json.access_token?.trim()
  if (!token) {
    throw new Error('Registry 未返回有效 token')
  }
  return token
}

async function registryRequest(
  url: string,
  method: 'HEAD' | 'GET',
  accept: string,
  auth?: RegistryAuthOptions,
): Promise<Response> {
  const resolvedAuth = resolveRegistryAuthOptions(auth)
  const headers: Record<string, string> = {
    Accept: accept,
  }

  let response = await fetch(url, {
    method,
    headers,
    signal: AbortSignal.timeout(15_000),
  })

  if (response.status === 401) {
    const challenge = parseBearerChallenge(response.headers.get('WWW-Authenticate'))
    if (!challenge) {
      throw new Error('Registry 鉴权失败')
    }
    const token = await fetchBearerToken(challenge, resolvedAuth)
    response = await fetch(url, {
      method,
      headers: {
        ...headers,
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(15_000),
    })
  }

  if (!response.ok) {
    throw new Error(`Registry 返回 ${response.status}`)
  }
  return response
}

async function fetchRegistryManifest(
  image: string,
  method: 'HEAD' | 'GET',
  auth?: RegistryAuthOptions,
  reference?: string,
): Promise<Response> {
  const parsed = parseImageRef(image)
  return registryRequest(buildRegistryManifestUrl(parsed, reference), method, MANIFEST_ACCEPT, auth)
}

async function fetchRegistryBlob(
  image: string,
  digest: string,
  auth?: RegistryAuthOptions,
): Promise<Response> {
  const parsed = parseImageRef(image)
  return registryRequest(buildRegistryBlobUrl(parsed, digest), 'GET', '*/*', auth)
}

function normalizeLayers(layers: string[] | undefined): string[] {
  return (layers ?? [])
    .map(layer => normalizeDigest(layer))
    .filter((layer): layer is string => Boolean(layer))
}

/**
 * 读取平台清单的 config：摘要等同本地 image Id，层摘要等同本地 `RootFS.Layers`。
 * 两者都是"打包方式被改变但镜像内容没变"时唯一还能对上的凭据。
 */
async function fetchManifestConfig(
  image: string,
  manifestDigest: string,
  auth?: RegistryAuthOptions,
): Promise<{ digest: string | null, layers: string[] }> {
  const manifestResponse = await fetchRegistryManifest(image, 'GET', auth, manifestDigest)
  const manifest = await manifestResponse.json() as ImageManifest
  const digest = normalizeDigest(manifest.config?.digest)
  if (!digest) {
    return { digest: null, layers: [] }
  }
  const configResponse = await fetchRegistryBlob(image, digest, auth)
  const config = await configResponse.json() as ImageConfig
  return { digest, layers: normalizeLayers(config.rootfs?.diff_ids) }
}

/**
 * 读出远端镜像的身份信息。
 *
 * primary 与 `docker pull` 记录进 RepoDigests 的摘要同口径（多架构镜像下即
 * manifest list 摘要），是最直接可比的一项；aliases 与 layers 是同一个镜像的
 * 其它写法 —— 各平台清单摘要、config 摘要、未压缩层摘要，用来识别"内容相同但
 * 打包方式不同"的镜像：`docker load` 导入的离线包、buildx 重新导出、
 * 第三方镜像站重打包都会让 manifest 摘要甚至 config 摘要变化，层内容却不变。
 *
 * 下钻失败只降级为"只有 primary"，不影响主判断。
 */
export async function fetchRemoteImageIdentity(
  image: string,
  auth?: RegistryAuthOptions,
): Promise<RemoteImageIdentity> {
  const headResponse = await fetchRegistryManifest(image, 'HEAD', auth)
  const headDigest = readContentDigest(headResponse)

  try {
    let primary = headDigest
    let manifestDigest = headDigest
    const aliases: string[] = []

    if (isManifestIndexContentType(headResponse.headers.get('content-type'))) {
      const indexResponse = await fetchRegistryManifest(image, 'GET', auth)
      primary = primary ?? readContentDigest(indexResponse)
      const index = await indexResponse.json() as ManifestIndex
      aliases.push(...collectIndexManifestDigests(index))
      manifestDigest = pickManifestDigestFromIndex(index) ?? primary
    }

    if (!manifestDigest) {
      return { primary, aliases, layers: [] }
    }

    const config = await fetchManifestConfig(image, manifestDigest, auth)
    if (config.digest) {
      aliases.push(config.digest)
    }
    return { primary, aliases, layers: config.layers }
  }
  catch {
    return { primary: headDigest, aliases: [], layers: [] }
  }
}
