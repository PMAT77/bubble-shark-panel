import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  collectIndexManifestDigests,
  parseBearerChallenge,
  pickManifestDigestFromIndex,
  resolvePreferredPlatform,
} from './registry-manifest.ts'

describe('registry-manifest', () => {
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
