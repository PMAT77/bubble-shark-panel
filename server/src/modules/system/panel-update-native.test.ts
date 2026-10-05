import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { GITHUB_PROXY_SITES } from './panel-update-offline'
import {
  NATIVE_UPDATE_REQUEST_FILENAME,
  NATIVE_UPDATE_STATE_FILENAME,
  buildNativeReleaseAssetName,
  buildNativeReleaseUrls,
  cleanupStalePrefetchedArchives,
  isValidReleaseTag,
  mergeNativeUpdateRuntime,
  readNativeUpdateState,
  resolveNativeUpdateSupport,
  resolvePrefetchedArchive,
  writeNativeUpdateRequest,
} from './panel-update-native'

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-native-update-'))
}

function writeStateFile(dir: string, content: string): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, NATIVE_UPDATE_STATE_FILENAME), content, 'utf8')
}

describe('buildNativeReleaseAssetName', () => {
  it('matches the release asset published by the build script', () => {
    assert.equal(
      buildNativeReleaseAssetName('v0.4.5'),
      'game-server-hub-native-v0.4.5-linux-x64.tar.gz',
    )
  })
})

describe('buildNativeReleaseUrls', () => {
  it('tries accelerator proxies before the direct release URL', () => {
    const urls = buildNativeReleaseUrls({ githubRepo: 'PMAT77/bubble-shark-panel', releaseTag: 'v0.4.5' })
    assert.equal(urls.length, GITHUB_PROXY_SITES.length + 1)
    assert.equal(
      urls[0],
      'https://gh-proxy.com/https://github.com/PMAT77/bubble-shark-panel/releases/download/v0.4.5/game-server-hub-native-v0.4.5-linux-x64.tar.gz',
    )
    assert.match(urls[urls.length - 1] ?? '', /^https:\/\/github\.com\/PMAT77\/bubble-shark-panel\/releases\/download\/v0\.4\.5\//)
  })

  it('uses the configured proxy alone when BSP_GITHUB_PROXY is set', () => {
    const urls = buildNativeReleaseUrls({
      githubRepo: 'PMAT77/bubble-shark-panel',
      releaseTag: 'v0.4.5',
      githubProxy: 'https://my-mirror.example.com/',
    })
    assert.equal(urls.length, 2)
    assert.match(urls[0] ?? '', /^https:\/\/my-mirror\.example\.com\/https:\/\/github\.com\//)
    assert.match(urls[1] ?? '', /^https:\/\/github\.com\//)
  })
})

describe('isValidReleaseTag', () => {
  it('accepts release tags and rejects anything else', () => {
    assert.equal(isValidReleaseTag('v0.4.5'), true)
    assert.equal(isValidReleaseTag('v0.4.5-beta.1'), true)
    assert.equal(isValidReleaseTag('  v0.4.5  '), true)
    assert.equal(isValidReleaseTag('0.4.5'), false)
    assert.equal(isValidReleaseTag('v0.4'), false)
    assert.equal(isValidReleaseTag('v0.4.5; rm -rf /'), false)
    assert.equal(isValidReleaseTag(''), false)
  })
})

describe('writeNativeUpdateRequest', () => {
  it('writes a single-line tag the executor can validate', () => {
    const dir = makeTempDir()
    try {
      writeNativeUpdateRequest(dir, 'v0.4.5')
      const content = fs.readFileSync(path.join(dir, NATIVE_UPDATE_REQUEST_FILENAME), 'utf8')
      assert.equal(content, 'v0.4.5\n')
      assert.ok(Buffer.byteLength(content) <= 64)
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('replaces a previous request and refuses a malformed tag', () => {
    const dir = makeTempDir()
    try {
      writeNativeUpdateRequest(dir, 'v0.4.5')
      writeNativeUpdateRequest(dir, 'v0.4.6')
      assert.equal(fs.readFileSync(path.join(dir, NATIVE_UPDATE_REQUEST_FILENAME), 'utf8'), 'v0.4.6\n')
      assert.throws(() => writeNativeUpdateRequest(dir, 'v0.4.6; reboot'), /版本号不合法/)
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('readNativeUpdateState', () => {
  it('parses the state written by the executor', () => {
    const dir = makeTempDir()
    try {
      writeStateFile(dir, JSON.stringify({
        version: 1,
        phase: 'failed',
        tag: 'v0.4.5',
        message: '安装失败，已回滚',
        startedAt: '2026-09-15T00:00:00Z',
        updatedAt: '2026-09-15T00:05:00Z',
        rolledBack: true,
      }))
      const state = readNativeUpdateState(dir)
      assert.equal(state?.phase, 'failed')
      assert.equal(state?.tag, 'v0.4.5')
      assert.equal(state?.rolledBack, true)
      assert.equal(state?.message, '安装失败，已回滚')
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('treats missing, malformed and oversized files as "no state"', () => {
    const dir = makeTempDir()
    try {
      assert.equal(readNativeUpdateState(dir), null)

      writeStateFile(dir, '{ not json')
      assert.equal(readNativeUpdateState(dir), null)

      writeStateFile(dir, JSON.stringify({ phase: 'whatever', tag: 'v0.4.5' }))
      assert.equal(readNativeUpdateState(dir), null)

      writeStateFile(dir, `{"phase":"running","tag":"v0.4.5","message":"${'x'.repeat(9 * 1024)}"}`)
      assert.equal(readNativeUpdateState(dir), null)

      writeStateFile(dir, JSON.stringify({ phase: 'done', tag: 42, message: null, rolledBack: 'yes' }))
      const state = readNativeUpdateState(dir)
      assert.equal(state?.phase, 'done')
      assert.equal(state?.tag, '')
      assert.equal(state?.message, '')
      assert.equal(state?.rolledBack, false)
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('resolveNativeUpdateSupport', () => {
  it('never claims support outside Native deployments', () => {
    const dir = makeTempDir()
    try {
      const support = resolveNativeUpdateSupport({ runtimeMode: 'docker', nativeUpdateDir: dir })
      assert.equal(support.supported, false)
      assert.equal(support.hint, null)
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('asks for an installer rerun when the path unit is missing', () => {
    const dir = makeTempDir()
    try {
      const support = resolveNativeUpdateSupport(
        { runtimeMode: 'native', nativeUpdateDir: dir },
        {
          pathUnitFile: path.join(dir, 'missing.path'),
          helperFile: path.join(dir, 'missing-helper'),
        },
      )
      assert.equal(support.supported, false)
      assert.match(support.hint ?? '', /重跑一次安装脚本/)
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports unsupported when the executor itself is gone', () => {
    const dir = makeTempDir()
    const unitFile = path.join(dir, 'bubblesharkpanel-update.path')
    fs.writeFileSync(unitFile, '[Path]\n', 'utf8')
    try {
      const support = resolveNativeUpdateSupport(
        { runtimeMode: 'native', nativeUpdateDir: dir },
        { pathUnitFile: unitFile, helperFile: path.join(dir, 'missing-helper') },
      )
      assert.equal(support.supported, false)
      assert.match(support.hint ?? '', /重跑一次安装脚本/)
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is unsupported when the exchange directory does not exist yet', () => {
    const dir = makeTempDir()
    const unitFile = path.join(dir, 'bubblesharkpanel-update.path')
    const helperFile = path.join(dir, 'bsp-native-update')
    fs.writeFileSync(unitFile, '[Path]\n', 'utf8')
    fs.writeFileSync(helperFile, '#!/usr/bin/env bash\n', 'utf8')
    try {
      const support = resolveNativeUpdateSupport(
        { runtimeMode: 'native', nativeUpdateDir: path.join(dir, 'nope') },
        { pathUnitFile: unitFile, helperFile },
      )
      assert.equal(support.supported, false)
      assert.match(support.hint ?? '', /重跑一次安装脚本/)
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('enables panel updates when the unit and executor exist and the directory is writable', () => {
    const dir = makeTempDir()
    const unitFile = path.join(dir, 'bubblesharkpanel-update.path')
    const helperFile = path.join(dir, 'bsp-native-update')
    fs.writeFileSync(unitFile, '[Path]\n', 'utf8')
    fs.writeFileSync(helperFile, '#!/usr/bin/env bash\n', 'utf8')
    try {
      const support = resolveNativeUpdateSupport(
        { runtimeMode: 'native', nativeUpdateDir: dir },
        { pathUnitFile: unitFile, helperFile },
      )
      assert.equal(support.supported, true)
      assert.equal(support.hint, null)
      assert.equal(support.dir, dir)
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('resolvePrefetchedArchive', () => {  it('reports the archive only when a non-empty file is present', () => {
    const dir = makeTempDir()
    try {
      assert.equal(resolvePrefetchedArchive(dir, 'v0.4.5'), null)
      const archiveDir = path.join(dir, 'v0.4.5')
      fs.mkdirSync(archiveDir, { recursive: true })
      const archiveFile = path.join(archiveDir, buildNativeReleaseAssetName('v0.4.5'))
      fs.writeFileSync(archiveFile, '')
      assert.equal(resolvePrefetchedArchive(dir, 'v0.4.5'), null)
      fs.writeFileSync(archiveFile, 'payload')
      assert.equal(resolvePrefetchedArchive(dir, 'v0.4.5'), archiveFile)
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('cleanupStalePrefetchedArchives', () => {
  it('keeps only the target tag and never touches root-owned entries', () => {
    const dir = makeTempDir()
    try {
      for (const name of ['v0.4.4', 'v0.4.5', '.root']) {
        fs.mkdirSync(path.join(dir, name), { recursive: true })
      }
      fs.writeFileSync(path.join(dir, NATIVE_UPDATE_STATE_FILENAME), '{}', 'utf8')
      cleanupStalePrefetchedArchives(dir, 'v0.4.5')
      assert.equal(fs.existsSync(path.join(dir, 'v0.4.5')), true)
      assert.equal(fs.existsSync(path.join(dir, 'v0.4.4')), false)
      assert.equal(fs.existsSync(path.join(dir, '.root')), true)
      assert.equal(fs.existsSync(path.join(dir, NATIVE_UPDATE_STATE_FILENAME)), true)
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('mergeNativeUpdateRuntime', () => {
  const base: Parameters<typeof mergeNativeUpdateRuntime>[0] = {
    runtimePhase: 'idle',
    runtimeMessage: null,
    runtimeError: null,
    runtimeTargetTag: null,
    runtimeTargetReady: false,
    state: null,
    targetTag: 'v0.4.5',
    prefetchedReady: false,
    updateAvailable: true,
  }

  it('keeps an in-flight download ahead of everything else', () => {
    const merged = mergeNativeUpdateRuntime({
      ...base,
      runtimePhase: 'downloading',
      runtimeMessage: '正在下载更新包',
      state: { phase: 'running', tag: 'v0.4.5', message: '安装中', startedAt: null, updatedAt: null, rolledBack: false },
    })
    assert.equal(merged.phase, 'downloading')
    assert.equal(merged.message, '正在下载更新包')
  })

  it('follows the executor state while it is installing', () => {
    const merged = mergeNativeUpdateRuntime({
      ...base,
      state: {
        phase: 'running',
        tag: 'v0.4.5',
        message: 'Installing v0.4.5',
        startedAt: null,
        updatedAt: null,
        rolledBack: false,
      },
    })
    assert.equal(merged.phase, 'recreating')
    assert.equal(merged.targetTag, 'v0.4.5')
    assert.equal(merged.targetReady, true)
  })

  it('reports a failed install but keeps the downloaded package usable', () => {
    const merged = mergeNativeUpdateRuntime({
      ...base,
      prefetchedReady: true,
      state: {
        phase: 'failed',
        tag: 'v0.4.5',
        message: '安装失败，已回滚到 v0.4.4',
        startedAt: null,
        updatedAt: null,
        rolledBack: true,
      },
    })
    assert.equal(merged.phase, 'failed')
    assert.match(merged.error ?? '', /已回滚/)
    assert.equal(merged.targetReady, true)
  })

  it('offers the install step when the package is already downloaded', () => {
    const merged = mergeNativeUpdateRuntime({ ...base, prefetchedReady: true })
    assert.equal(merged.phase, 'downloaded')
    assert.equal(merged.targetReady, true)
  })

  it('does not let a previous failure hide a freshly downloaded package', () => {
    const merged = mergeNativeUpdateRuntime({
      ...base,
      runtimePhase: 'downloaded',
      runtimeTargetTag: 'v0.4.5',
      runtimeTargetReady: true,
      state: {
        phase: 'failed',
        tag: 'v0.4.5',
        message: '上一次安装失败，已回滚',
        startedAt: null,
        updatedAt: null,
        rolledBack: true,
      },
    })
    assert.equal(merged.phase, 'downloaded')
    assert.equal(merged.error, null)
    assert.equal(merged.targetReady, true)
  })

  it('stays idle without a pending package or state', () => {
    const merged = mergeNativeUpdateRuntime(base)
    assert.equal(merged.phase, 'idle')
    assert.equal(merged.targetReady, false)
  })

  it('keeps the download failure visible when the executor never wrote a state', () => {
    const merged = mergeNativeUpdateRuntime({
      ...base,
      runtimePhase: 'failed',
      runtimeError: '全部下载来源都失败了',
    })
    assert.equal(merged.phase, 'failed')
    assert.match(merged.error ?? '', /全部下载来源都失败了/)
  })

  it('treats a stale running state as an interrupted update', () => {
    const merged = mergeNativeUpdateRuntime({
      ...base,
      nowMs: Date.parse('2026-09-15T02:00:00Z'),
      state: {
        phase: 'running',
        tag: 'v0.4.5',
        message: 'Installing v0.4.5...',
        startedAt: '2026-09-15T00:00:00Z',
        updatedAt: '2026-09-15T00:00:30Z',
        rolledBack: false,
      },
    })
    assert.equal(merged.phase, 'failed')
    assert.match(merged.error ?? '', /中断/)
  })

  it('stops nagging about an old failure once the panel is already up to date', () => {
    const merged = mergeNativeUpdateRuntime({
      ...base,
      updateAvailable: false,
      state: {
        phase: 'failed',
        tag: 'v0.4.5',
        message: '上一次安装失败，已回滚',
        startedAt: null,
        updatedAt: null,
        rolledBack: true,
      },
    })
    assert.equal(merged.phase, 'idle')
    assert.equal(merged.error, null)
  })
})
