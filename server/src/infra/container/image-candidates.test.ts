import assert from 'node:assert/strict'

import { describe, it } from 'node:test'

import {
  buildImageCandidates,
  buildImageRef,
  createPullProgressAggregator,
  normalizeMirrorRegistries,
  OFFICIAL_UNIFIED_IMAGE_REPOSITORY,
  shareImagePreparation,
  pullImageWithCandidates,
} from './image-candidates.ts'
import { buildSteamcmdImageCandidates, resolvePanelSteamcmdPullRef } from './steamcmd-runner.ts'

it('only retries recoverable image download errors', async () => {
  for (const [message, expected] of [['ECONNRESET', 2], ['unauthorized', 1], ['ENOSPC', 1], ['unknown failure', 1]] as const) {
    let calls = 0
    const docker = {
      getImage: () => ({ inspect: async () => { throw new Error('not cached') } }),
      pull: (_ref: string, callback: (error: Error) => void) => { calls++; callback(new Error(message)) },
    } as unknown as Parameters<typeof pullImageWithCandidates>[0]
    const result = await pullImageWithCandidates(docker, ['fixture:latest'], 'fixture:latest', { maxAttempts: 2, sleep: async () => {} })
    assert.equal(result.ok, false)
    assert.equal(calls, expected)
  }
})

it('a shared pull keeps running for another subscriber and aborts when the last leaves', async () => {
  let release!: (value: string) => void
  let signal: AbortSignal | undefined
  const run = async (options: { signal?: AbortSignal }) => {
    signal = options.signal
    return new Promise<string>(resolve => { release = resolve })
  }
  const firstController = new AbortController()
  const first = shareImagePreparation('fixture', { signal: firstController.signal }, run)
  const rejected = assert.rejects(first, /cancel first/)
  const second = shareImagePreparation('fixture', {}, run)
  await Promise.resolve()
  firstController.abort(new Error('cancel first'))
  await rejected
  assert.equal(signal?.aborted, false)
  release('ready')
  assert.equal(await second, 'ready')
  const lastController = new AbortController()
  const last = shareImagePreparation('last', { signal: lastController.signal }, run)
  const lastRejected = assert.rejects(last, /cancel last/)
  await Promise.resolve()
  lastController.abort(new Error('cancel last'))
  await lastRejected
  assert.equal(signal?.aborted, true)
})

describe('normalizeMirrorRegistries', () => {
  it('splits, trims and dedupes mirror registries', () => {
    assert.deepEqual(
      normalizeMirrorRegistries(' https://a.example.com, b.example.com/ ,a.example.com ,'),
      ['a.example.com', 'b.example.com'],
    )
    assert.deepEqual(normalizeMirrorRegistries(''), [])
    assert.deepEqual(normalizeMirrorRegistries(undefined), [])
  })
})

describe('buildImageRef', () => {
  it('omits docker.io prefix', () => {
    assert.equal(buildImageRef('docker.io', 'pmat77/bubblesharkpanel', 'v1'), 'pmat77/bubblesharkpanel:v1')
    assert.equal(buildImageRef('ghcr.io', 'pmat77/bubblesharkpanel', 'v1'), 'ghcr.io/pmat77/bubblesharkpanel:v1')
  })
})

describe('buildImageCandidates', () => {
  it('uses the configured image when mirrors are not configured', () => {
    assert.deepEqual(
      buildImageCandidates('registry.example.com/ns/bubblesharkpanel:stable', ''),
      ['registry.example.com/ns/bubblesharkpanel:stable'],
    )
  })

  it('prioritizes configured mirrors before the configured fallback', () => {
    assert.deepEqual(
      buildImageCandidates('ghcr.io/pmat77/bubblesharkpanel:latest', 'docker.m.daocloud.io,hub-mirror.c.163.com'),
      [
        'docker.m.daocloud.io/pmat77/bubblesharkpanel:latest',
        'hub-mirror.c.163.com/pmat77/bubblesharkpanel:latest',
        'ghcr.io/pmat77/bubblesharkpanel:latest',
      ],
    )
  })

  it('skips mirrors equal to the configured registry', () => {
    assert.deepEqual(
      buildImageCandidates('ghcr.io/pmat77/bubblesharkpanel:latest', 'ghcr.io'),
      ['ghcr.io/pmat77/bubblesharkpanel:latest'],
    )
  })

  it('falls back to the official unified repository when ref is empty', () => {
    assert.deepEqual(
      buildImageCandidates('', ''),
      [`${OFFICIAL_UNIFIED_IMAGE_REPOSITORY}:latest`],
    )
  })
})

describe('steamcmd pull ref helpers', () => {
  it('preserves the complete configured image reference', () => {
    assert.equal(
      resolvePanelSteamcmdPullRef('registry.cn-hangzhou.aliyuncs.com/bubblesharkpanel/steamcmd-base:stable'),
      'registry.cn-hangzhou.aliyuncs.com/bubblesharkpanel/steamcmd-base:stable',
    )
    assert.equal(
      resolvePanelSteamcmdPullRef('ghcr.io/pmat77/bubblesharkpanel:latest'),
      `${OFFICIAL_UNIFIED_IMAGE_REPOSITORY}:latest`,
    )
    assert.equal(resolvePanelSteamcmdPullRef(''), `${OFFICIAL_UNIFIED_IMAGE_REPOSITORY}:latest`)
  })

  it('delegates candidates to the generic builder', () => {
    const previous = process.env.BSP_STEAMCMD_IMAGE_MIRRORS
    delete process.env.BSP_STEAMCMD_IMAGE_MIRRORS
    try {
      assert.deepEqual(
        buildSteamcmdImageCandidates('registry.example.com/ns/steamcmd-base:stable'),
        ['registry.example.com/ns/steamcmd-base:stable'],
      )
    }
    finally {
      if (previous === undefined) {
        delete process.env.BSP_STEAMCMD_IMAGE_MIRRORS
      }
      else {
        process.env.BSP_STEAMCMD_IMAGE_MIRRORS = previous
      }
    }
  })
})

describe('createPullProgressAggregator', () => {
  it('sums the layers that still need downloading', () => {
    const aggregator = createPullProgressAggregator()
    aggregator.handle({ status: 'Pulling fs layer', id: 'a' })
    aggregator.handle({ status: 'Downloading', id: 'a', progressDetail: { current: 100, total: 1_000 } })
    aggregator.handle({ status: 'Downloading', id: 'b', progressDetail: { current: 50, total: 500 } })
    assert.deepEqual(aggregator.snapshot(), { downloadedBytes: 150, totalBytes: 1_500 })
  })

  it('never lets the byte count go backwards while docker extracts a layer', () => {
    const aggregator = createPullProgressAggregator()
    aggregator.handle({ status: 'Downloading', id: 'a', progressDetail: { current: 900, total: 1_000 } })
    aggregator.handle({ status: 'Extracting', id: 'a', progressDetail: { current: 10, total: 2_000 } })
    assert.equal(aggregator.snapshot().downloadedBytes, 900)
  })

  it('counts a completed layer as fully downloaded', () => {
    const aggregator = createPullProgressAggregator()
    aggregator.handle({ status: 'Downloading', id: 'a', progressDetail: { current: 400, total: 1_000 } })
    aggregator.handle({ status: 'Download complete', id: 'a' })
    assert.deepEqual(aggregator.snapshot(), { downloadedBytes: 1_000, totalBytes: 1_000 })
  })

  it('keeps the largest value per layer when a pull is retried', () => {
    const aggregator = createPullProgressAggregator()
    aggregator.handle({ status: 'Downloading', id: 'a', progressDetail: { current: 700, total: 1_000 } })
    aggregator.handle({ status: 'Downloading', id: 'a', progressDetail: { current: 200, total: 1_000 } })
    assert.deepEqual(aggregator.snapshot(), { downloadedBytes: 700, totalBytes: 1_000 })
  })

  it('reports a partial total without throwing on malformed events', () => {
    const aggregator = createPullProgressAggregator()
    aggregator.handle({ status: 'Pulling from pmat77/bubblesharkpanel', id: 'latest' })
    aggregator.handle({ status: 'Downloading', id: 'a', progressDetail: { current: 2_048 } })
    aggregator.handle({ status: 'Digest: sha256:abc', id: 'b', progressDetail: { current: 'n/a', total: null } })
    aggregator.handle(null)
    assert.deepEqual(aggregator.snapshot(), { downloadedBytes: 2_048, totalBytes: 0 })
  })
})
