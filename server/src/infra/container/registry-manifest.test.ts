import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  collectIndexManifestDigests,
  fetchRemoteImageIdentity,
  parseBearerChallenge,
  pickManifestDigestFromIndex,
  resolvePreferredPlatform,
} from './registry-manifest.ts'

describe('registry-manifest', () => {
  it('includes the target image and HTTP status when its manifest is missing', async (t) => {
    const image = 'ghcr.io/pmat77/bubblesharkpanel:v0.15.4'
    const requests: Array<{ url: string, method?: string }> = []
    t.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
      requests.push({ url, method: options?.method })
      return new Response(null, { status: 404 })
    })
    await assert.rejects(fetchRemoteImageIdentity(image), (error: Error) => {
      assert.match(error.message, /Registry 返回 404/)
      assert.ok(error.message.includes(image))
      return true
    })
    assert.deepEqual(requests, [{
      url: 'https://ghcr.io/v2/pmat77/bubblesharkpanel/manifests/v0.15.4',
      method: 'HEAD',
    }])
  })

  it('parses bearer challenge header', () => {
    const challenge = parseBearerChallenge(
      'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:pmat77/bubblesharkpanel:pull"',
    )
    assert.deepEqual(challenge, {
      realm: 'https://ghcr.io/token',
      service: 'ghcr.io',
      scope: 'repository:pmat77/bubblesharkpanel:pull',
    })
  })

  it('picks platform digest from manifest index', () => {
    const preferred = resolvePreferredPlatform()
    const digest = pickManifestDigestFromIndex({
      manifests: [
        {
          digest: 'sha256:attestation',
          platform: { os: 'unknown', architecture: 'unknown' },
        },
        {
          digest: 'sha256:linux-amd64',
          platform: { os: 'linux', architecture: preferred.architecture },
        },
      ],
    })
    assert.equal(digest, 'sha256:linux-amd64')
  })

  it('collects every platform digest of an index and drops attestations', () => {
    const amd64 = `sha256:${'a'.repeat(64)}`
    const arm64 = `sha256:${'b'.repeat(64)}`
    const attestation = `sha256:${'c'.repeat(64)}`
    assert.deepEqual(
      collectIndexManifestDigests({
        manifests: [
          { digest: amd64, platform: { os: 'linux', architecture: 'amd64' } },
          { digest: attestation, platform: { os: 'unknown', architecture: 'unknown' } },
          { digest: arm64, platform: { os: 'linux', architecture: 'arm64' } },
          { digest: amd64, platform: { os: 'linux', architecture: 'amd64' } },
        ],
      }),
      [amd64, arm64],
    )
  })

  it('falls back to linux digest without explicit architecture', () => {
    const digest = pickManifestDigestFromIndex({
      manifests: [
        {
          digest: 'sha256:linux-default',
          platform: { os: 'linux' },
        },
      ],
    })
    assert.equal(digest, 'sha256:linux-default')
  })
})
