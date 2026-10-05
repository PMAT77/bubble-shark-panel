import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildRegistryManifestUrl, normalizeDigest, parseImageRef, shortDigest } from './image-ref.ts'

describe('image-ref', () => {
  it('parses ghcr image with tag', () => {
    const parsed = parseImageRef('ghcr.io/pmat77/bubblesharkpanel:latest')
    assert.equal(parsed.registry, 'ghcr.io')
    assert.equal(parsed.repository, 'pmat77/bubblesharkpanel')
    assert.equal(parsed.tag, 'latest')
    assert.equal(
      buildRegistryManifestUrl(parsed),
      'https://ghcr.io/v2/pmat77/bubblesharkpanel/manifests/latest',
    )
  })

  it('normalizes digest values', () => {
    const digest = 'sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
    assert.equal(normalizeDigest(`repo@${digest}`), digest)
    assert.equal(shortDigest(digest), 'abcdef012345')
  })
})
