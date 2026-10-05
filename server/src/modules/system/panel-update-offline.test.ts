import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  buildOfflineArchiveName,
  buildOfflineArchiveUrls,
  ensureDiskSpace,
  formatBytes,
  GITHUB_PROXY_SITES,
  parseContentRangeTotal,
  parseSha256File,
  readPartSize,
  resolvePartPath,
} from './panel-update-offline'

describe('buildOfflineArchiveName', () => {
  it('matches the release asset naming', () => {
    assert.equal(buildOfflineArchiveName('v0.4.2'), 'game-server-hub-v0.4.2-docker-image.tar.gz')
  })
})

describe('buildOfflineArchiveUrls', () => {
  it('tries accelerator proxies before the direct release URL', () => {
    const urls = buildOfflineArchiveUrls({ githubRepo: 'PMAT77/bubble-shark-panel', releaseTag: 'v0.4.2' })
    assert.equal(urls.length, GITHUB_PROXY_SITES.length + 1)
    assert.equal(
      urls[0],
      'https://gh-proxy.com/https://github.com/PMAT77/bubble-shark-panel/releases/download/v0.4.2/game-server-hub-v0.4.2-docker-image.tar.gz',
    )
    assert.match(urls[urls.length - 1] ?? '', /^https:\/\/github\.com\/PMAT77\/bubble-shark-panel\/releases\/download\/v0\.4\.2\//)
  })

  it('uses the configured proxy alone when BSP_GITHUB_PROXY is set', () => {
    const urls = buildOfflineArchiveUrls({
      githubRepo: 'PMAT77/bubble-shark-panel',
      releaseTag: 'v0.4.2',
      githubProxy: 'https://my-mirror.example.com/',
    })
    assert.equal(urls.length, 2)
    assert.match(urls[0] ?? '', /^https:\/\/my-mirror\.example\.com\/https:\/\/github\.com\//)
    assert.match(urls[1] ?? '', /^https:\/\/github\.com\//)
  })
})

describe('parseSha256File', () => {
  it('reads the digest from a sha256sum line', () => {
    const digest = 'a'.repeat(64)
    assert.equal(parseSha256File(`${digest}  game-server-hub-v0.4.2-docker-image.tar.gz\n`), digest)
    assert.equal(parseSha256File(digest.toUpperCase()), digest)
  })

  it('rejects anything that is not a digest', () => {
    assert.equal(parseSha256File(''), null)
    assert.equal(parseSha256File('<html>Not Found</html>'), null)
  })
})

describe('parseContentRangeTotal', () => {
  it('reads the complete size from a resumed response', () => {
    assert.equal(parseContentRangeTotal('bytes 1024-2047/524288000'), 524_288_000)
    assert.equal(parseContentRangeTotal('bytes */1000'), 1_000)
  })

  it('returns null when the header is missing or malformed', () => {
    assert.equal(parseContentRangeTotal(null), null)
    assert.equal(parseContentRangeTotal('bytes 0-0/*'), null)
  })
})

describe('formatBytes', () => {
  it('formats the sizes used in disk-space messages', () => {
    assert.equal(formatBytes(0), '0 B')
    assert.equal(formatBytes(2_048), '2 KB')
    assert.equal(formatBytes(536_870_912), '512 MB')
    assert.equal(formatBytes(1_288_490_189), '1.2 GB')
  })
})

describe('断点续传的分片文件', () => {
  it('reports the downloaded size of a partial archive', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-archive-'))
    try {
      const filePath = path.join(dir, 'game-server-hub-v0.4.2-docker-image.tar.gz')
      const partPath = resolvePartPath(filePath)
      assert.equal(partPath, `${filePath}.part`)
      assert.equal(readPartSize(partPath), 0)
      fs.writeFileSync(partPath, Buffer.alloc(1_024))
      assert.equal(readPartSize(partPath), 1_024)
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('ensureDiskSpace', () => {
  it('accepts a small requirement and rejects an impossible one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-space-'))
    try {
      assert.equal((await ensureDiskSpace(dir, 1_024)).ok, true)
      const huge = await ensureDiskSpace(dir, Number.MAX_SAFE_INTEGER)
      assert.equal(huge.ok, false)
      assert.ok((huge.availableBytes ?? 0) > 0)
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
