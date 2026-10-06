import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, it } from 'node:test'
import type { ServerConfig } from '../../shared/config'
import {
  buildOfflineImageCommand,
  buildUpdaterImageCandidates,
  buildUpdaterImageFailureMessage,
  buildUpdaterShellCommand,
  hasStackRequiredFiles,
  isImageOutdated,
  isReleaseNewer,
  pickPanelUpdateSource,
  resolveApplySupport,
  resolveStackPaths,
  resolveTargetImageRef,
  resolveUpdateKind,
  resolveUpdaterImage,
} from './panel-update'

const tempDirs: string[] = []

function createTempStackDir(files: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-stack-'))
  tempDirs.push(dir)
  for (const file of files) {
    const filePath = path.join(dir, file)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, '')
  }
  return dir
}

function buildConfig(partial: Partial<ServerConfig>): ServerConfig {
  return {
    mode: 'production',
    host: '0.0.0.0',
    port: 3000,
    dbPath: '/tmp/db.sqlite',
    logDir: '/tmp/logs',
    logLevel: 'info',
    envFile: '/tmp/.env.production',
    forcePasswordChange: false,
    adminUsername: 'admin',
    adminPassword: 'admin',
    adminPasswordGenerated: false,
    dockerHost: 'unix:///var/run/docker.sock',
    instancesRoot: '/tmp/instances',
    backupsRoot: '/tmp/backups',
    gameDstImage: 'ghcr.io/pmat77/bubblesharkpanel:latest',
    steamcmdImage: 'ghcr.io/pmat77/bubblesharkpanel:latest',
    imageMirrors: [],
    edition: 'community',
    runtimeMode: 'docker',
    nativeRuntimeDir: '/tmp/runtime',
    nativeSteamcmdPath: '/opt/bubblesharkpanel/runtime/steamcmd/steamcmd.sh',
    nativeSystemdUnitDir: '/tmp/systemd',
    nativeUpdateDir: '/tmp/panel-update',
    panelImage: 'ghcr.io/pmat77/bubblesharkpanel:latest',
    panelUpdaterImage: '',
    stackDir: '',
    composeFiles: ['docker-compose.yml', 'docker-compose.bind.yml'],
    panelContainerName: 'bubblesharkpanel-panel',
    trustedProxies: [],
    installPathPolicy: 'instances-root',
    githubRepo: 'PMAT77/bubble-shark-panel',
    githubApiBase: 'https://api.github.com',
    githubProxy: '',
    panelUpdateSource: 'auto',
    releaseVersion: '',
    buildSha: '',
    syncAdminPasswordFromEnv: false,
    passwordRecoveryToken: '',
    corsOrigin: false,
    // 游客免密登录默认关闭；本文件只测面板更新链路，与它无关
    guestLoginEnabled: false,
    guestLoginRequested: false,
    guestLoginAccount: 'guest',
    ...partial,
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('hasStackRequiredFiles', () => {
  it('requires panel.env and all compose files', () => {
    const dir = createTempStackDir(['panel.env', 'docker-compose.yml'])
    assert.equal(hasStackRequiredFiles(dir, ['docker-compose.yml']), true)
    assert.equal(hasStackRequiredFiles(dir, ['docker-compose.yml', 'docker-compose.bind.yml']), false)
  })
})

describe('resolveStackPaths', () => {
  it('uses host dir when files are directly accessible', () => {
    const hostDir = createTempStackDir(['panel.env', 'docker-compose.yml', 'docker-compose.bind.yml'])
    assert.deepEqual(resolveStackPaths(hostDir, ['docker-compose.yml', 'docker-compose.bind.yml']), {
      hostDir,
      localDir: hostDir,
    })
  })

  it('falls back to container mount when host path is not visible in process', () => {
    const hostDir = '/opt/bubblesharkpanel'
    const mountDir = createTempStackDir(['panel.env', 'docker-compose.yml'])
    assert.deepEqual(resolveStackPaths(hostDir, ['docker-compose.yml'], mountDir), {
      hostDir,
      localDir: mountDir,
    })
  })

  it('returns null when stack files are missing everywhere', () => {
    const hostDir = createTempStackDir([])
    assert.equal(resolveStackPaths(hostDir, ['docker-compose.yml']), null)
  })
})

describe('resolveApplySupport', () => {
  it('still supports image pull when stack dir is missing', () => {
    const support = resolveApplySupport(buildConfig({ stackDir: '' }))
    assert.equal(support.imageSupported, false)
    assert.equal(support.nativeSupported, false)
    assert.equal(support.supported, true)
    assert.match(support.hint ?? '', /目录配置/)
  })

  it('asks for one installer rerun when the Native update helper is missing', () => {
    // 老安装（未重跑过安装脚本）没有更新组件：面板内更新不可用，但要说清怎么恢复。
    // 注入口让这条断言不再依赖「本机恰好没装过 Native」。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-native-support-'))
    tempDirs.push(dir)
    const support = resolveApplySupport(
      buildConfig({ runtimeMode: 'native', nativeUpdateDir: dir }),
      {
        nativePathUnitFile: path.join(dir, 'missing.path'),
        nativeHelperFile: path.join(dir, 'missing-helper'),
      },
    )
    assert.equal(support.imageSupported, false)
    assert.equal(support.nativeSupported, false)
    assert.equal(support.supported, false)
    assert.match(support.hint ?? '', /重跑一次安装脚本/)
  })

  it('enables in-panel updates once the installer has deployed the update components', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-native-support-'))
    tempDirs.push(dir)
    const unitFile = path.join(dir, 'bubblesharkpanel-update.path')
    const helperFile = path.join(dir, 'bsp-native-update')
    fs.writeFileSync(unitFile, '[Path]\n', 'utf8')
    fs.writeFileSync(helperFile, '#!/usr/bin/env bash\n', 'utf8')
    const support = resolveApplySupport(
      buildConfig({ runtimeMode: 'native', nativeUpdateDir: dir }),
      { nativePathUnitFile: unitFile, nativeHelperFile: helperFile },
    )
    assert.equal(support.nativeSupported, true)
    assert.equal(support.imageSupported, false)
    assert.equal(support.supported, true)
    assert.equal(support.hint, null)
  })

  it('enables image apply when stack files are reachable', () => {
    const hostDir = createTempStackDir(['panel.env', 'docker-compose.yml', 'docker-compose.bind.yml'])
    const support = resolveApplySupport(buildConfig({ stackDir: hostDir }))
    assert.equal(support.imageSupported, true)
    assert.equal(support.hint, null)
    assert.equal(support.stackPaths?.hostDir, hostDir)
    assert.equal(support.stackPaths?.localDir, hostDir)
  })
})

describe('resolveUpdateKind', () => {
  it('separates a newer release from the same version with different image content', () => {
    assert.equal(resolveUpdateKind({
      runtimeMode: 'docker',
      updateAvailable: true,
      currentVersion: 'v0.2.1',
      latestVersion: 'v0.2.2',
    }), 'newer')
    assert.equal(resolveUpdateKind({
      runtimeMode: 'docker',
      updateAvailable: true,
      currentVersion: 'v0.2.2',
      latestVersion: 'v0.2.2',
    }), 'same-version-changed')
    assert.equal(resolveUpdateKind({
      runtimeMode: 'docker',
      updateAvailable: true,
      currentVersion: '0.2.2',
      latestVersion: 'v0.2.2',
    }), 'same-version-changed')
  })

  it('never claims an update when the digests match', () => {
    assert.equal(resolveUpdateKind({
      runtimeMode: 'docker',
      updateAvailable: false,
      currentVersion: 'v0.2.2',
      latestVersion: 'v0.2.2',
    }), 'none')
  })

  it('stays unknown when the release tag cannot be read', () => {
    assert.equal(resolveUpdateKind({
      runtimeMode: 'docker',
      updateAvailable: true,
      currentVersion: 'v0.2.2',
      latestVersion: null,
    }), 'unknown')
    assert.equal(resolveUpdateKind({
      runtimeMode: 'docker',
      updateAvailable: true,
      currentVersion: null,
      latestVersion: 'v0.2.2',
    }), 'unknown')
  })

  it('treats a native upgrade as a plain newer version', () => {
    assert.equal(resolveUpdateKind({
      runtimeMode: 'native',
      updateAvailable: true,
      currentVersion: 'v0.2.1',
      latestVersion: 'v0.2.2',
    }), 'newer')
    assert.equal(resolveUpdateKind({
      runtimeMode: 'native',
      updateAvailable: false,
      currentVersion: 'v0.2.2',
      latestVersion: 'v0.2.2',
    }), 'none')
  })
})

describe('isReleaseNewer', () => {
  it('compares stable and prerelease versions without offering downgrades', () => {
    assert.equal(isReleaseNewer('v0.1.4', 'v0.2.0'), true)
    assert.equal(isReleaseNewer('v0.2.0', 'v0.1.4'), false)
    assert.equal(isReleaseNewer('v0.2.0-beta.1', 'v0.2.0'), true)
    assert.equal(isReleaseNewer('v0.2.0', 'v0.2.0-beta.1'), false)
  })
})

describe('isImageOutdated', () => {
  // docker pull 在本地记录 manifest list 摘要，registry 的 HEAD 返回同一个值；
  // 平台清单摘要、config 摘要与未压缩层摘要是同一镜像的另外几种写法。
  const indexDigest = `sha256:${'1'.repeat(64)}`
  const platformDigest = `sha256:${'2'.repeat(64)}`
  const configDigest = `sha256:${'3'.repeat(64)}`
  const otherDigest = `sha256:${'4'.repeat(64)}`
  const layers = [`sha256:${'a'.repeat(64)}`, `sha256:${'b'.repeat(64)}`]
  const remote = { digests: [indexDigest, platformDigest, configDigest], layers }

  it('accepts a local manifest list digest as the same image as its platform digests', () => {
    assert.equal(isImageOutdated({ local: { digests: [indexDigest], layers }, remote }), false)
  })

  it('accepts a local image pinned to a platform digest', () => {
    assert.equal(isImageOutdated({ local: { digests: [platformDigest], layers }, remote }), false)
  })

  it('accepts an offline image whose config digest still matches', () => {
    assert.equal(isImageOutdated({ local: { digests: [configDigest], layers }, remote }), false)
  })

  it('accepts an offline image whose config digest was rewritten but layers match', () => {
    assert.equal(isImageOutdated({
      local: { digests: [otherDigest], layers },
      remote,
    }), false)
  })

  it('reports an update when neither digests nor layers line up', () => {
    assert.equal(isImageOutdated({
      local: { digests: [otherDigest], layers: [`sha256:${'c'.repeat(64)}`] },
      remote,
    }), true)
  })

  it('reports an update when the layer list differs', () => {
    assert.equal(isImageOutdated({
      local: { digests: [otherDigest], layers: [...layers, `sha256:${'c'.repeat(64)}`] },
      remote,
    }), true)
  })

  it('pulls when the image is missing locally', () => {
    assert.equal(isImageOutdated({ local: { digests: [], layers: [] }, remote }), true)
  })

  it('never claims an update when the registry could not be read', () => {
    assert.equal(isImageOutdated({
      local: { digests: [indexDigest], layers },
      remote: { digests: [], layers: [] },
    }), false)
  })
})

describe('pickPanelUpdateSource', () => {
  it('prefers the panel setting over the environment default', () => {
    assert.equal(pickPanelUpdateSource('pull', 'auto'), 'pull')
    assert.equal(pickPanelUpdateSource('offline', 'auto'), 'offline')
    assert.equal(pickPanelUpdateSource('auto', 'pull'), 'auto')
  })

  it('falls back to the environment value when the setting is missing or bogus', () => {
    assert.equal(pickPanelUpdateSource(undefined, 'offline'), 'offline')
    assert.equal(pickPanelUpdateSource(null, 'pull'), 'pull')
    assert.equal(pickPanelUpdateSource('nonsense', 'auto'), 'auto')
  })
})

describe('resolveTargetImageRef', () => {
  it('targets the release tag so a one-click update actually crosses versions', () => {
    assert.equal(
      resolveTargetImageRef('v0.3.3', 'ghcr.io/pmat77/bubblesharkpanel:v0.3.2'),
      'ghcr.io/pmat77/bubblesharkpanel:v0.3.3',
    )
  })

  it('falls back to the configured tag when the release cannot be read', () => {
    assert.equal(
      resolveTargetImageRef(null, 'ghcr.io/pmat77/bubblesharkpanel:v0.3.2'),
      'ghcr.io/pmat77/bubblesharkpanel:v0.3.2',
    )
    assert.equal(
      resolveTargetImageRef('not-a-tag', 'ghcr.io/pmat77/bubblesharkpanel:v0.3.2'),
      'ghcr.io/pmat77/bubblesharkpanel:v0.3.2',
    )
  })

  it('keeps the registry and repository of the configured image', () => {
    assert.equal(
      resolveTargetImageRef('v0.3.3', 'registry.example.com:5000/bsp/panel:dev'),
      'registry.example.com:5000/bsp/panel:v0.3.3',
    )
  })
})

describe('buildOfflineImageCommand', () => {
  it('points at the release asset and how to load it', () => {
    const command = buildOfflineImageCommand('PMAT77/bubble-shark-panel', 'v0.3.3') ?? ''
    assert.match(command, /releases\/download\/v0\.3\.3\/game-server-hub-v0\.3\.3-docker-image\.tar\.gz/)
    assert.match(command, /gunzip -c game-server-hub-v0\.3\.3-docker-image\.tar\.gz \| docker load/)
  })

  it('returns null without a release tag or repo', () => {
    assert.equal(buildOfflineImageCommand('PMAT77/bubble-shark-panel', null), null)
    assert.equal(buildOfflineImageCommand('', 'v0.3.3'), null)
  })
})

describe('buildUpdaterShellCommand', () => {
  it('executes with the original project and refuses to edit configuration when the project label is missing', (t) => {
    const bash = process.env.BSP_BASH || 'bash'
    if (spawnSync(bash, ['--version']).status !== 0) {
      if (process.env.CI) {
        assert.fail('CI requires bash for the updater regression test')
      }
      t.skip('Set BSP_BASH to run the updater shell regression test')
      return
    }
    for (const project of ['custom-project', '']) {
      const dir = createTempStackDir(['panel.env'])
      fs.writeFileSync(path.join(dir, 'panel.env'), 'PANEL_IMAGE=img:old\n')
      const script = buildUpdaterShellCommand('img:v1', 'v1', buildConfig({}))
        .replace('cd /stack', 'cd "$TEST_STACK"')
      const result = spawnSync(bash, ['-c', [
        'docker() {',
        '  case "$1" in',
        '    inspect) printf "%s\\n" "$TEST_PROJECT" ;;',
        '    compose) printf "%s\\n" "$@" > "$TEST_STACK/compose-args" ;;',
        '    *) return 1 ;;',
        '  esac',
        '}',
        script,
      ].join('\n')], {
        env: { ...process.env, TEST_STACK: dir.replace(/\\/g, '/'), TEST_PROJECT: project },
        encoding: 'utf8',
      })
      if (project) {
        assert.equal(result.status, 0, result.stderr)
        assert.match(fs.readFileSync(path.join(dir, 'compose-args'), 'utf8'), /^compose\n-p\ncustom-project\n/)
        assert.match(fs.readFileSync(path.join(dir, 'panel.env'), 'utf8'), /PANEL_IMAGE=img:v1/)
      }
      else {
        assert.equal(result.status, 1, result.stderr)
        assert.equal(fs.readFileSync(path.join(dir, 'panel.env'), 'utf8'), 'PANEL_IMAGE=img:old\n')
        assert.equal(fs.existsSync(path.join(dir, 'compose-args')), false)
      }
    }
  })

  it('uses the running panel project for both rebuilding and rollback before editing panel.env', () => {
    const script = buildUpdaterShellCommand('img:v1', 'v1', buildConfig({
      panelContainerName: 'custom-panel',
    }))
    assert.ok(script.includes(`docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' 'custom-panel'`))
    assert.equal((script.match(/docker compose -p "\$project"/g) ?? []).length, 2)
    assert.ok(script.indexOf('无法读取现有面板的 Compose 项目名') < script.indexOf('cp panel.env'))
  })

  it('writes the target image into panel.env and rebuilds without pulling', () => {
    const script = buildUpdaterShellCommand('ghcr.io/pmat77/bubblesharkpanel:v0.3.3', 'v0.3.3', buildConfig({}))
    assert.match(script, /PANEL_IMAGE=ghcr\.io\/pmat77\/bubblesharkpanel:v0\.3\.3/)
    assert.match(script, /BSP_GAME_DST_IMAGE=ghcr\.io\/pmat77\/bubblesharkpanel:v0\.3\.3/)
    assert.match(script, /BSP_STEAMCMD_IMAGE=ghcr\.io\/pmat77\/bubblesharkpanel:v0\.3\.3/)
    assert.match(script, /BSP_RELEASE_VERSION=v0\.3\.3/)
    assert.match(script, /GSH_GAME_DST_IMAGE=ghcr\.io\/pmat77\/bubblesharkpanel:v0\.3\.3/)
    assert.match(script, /GSH_STEAMCMD_IMAGE=ghcr\.io\/pmat77\/bubblesharkpanel:v0\.3\.3/)
    assert.match(script, /GSH_RELEASE_VERSION=v0\.3\.3/)
    assert.match(script, /cp panel\.env "\$backup"/)
    assert.match(script, /up -d panel/)
    // 目标镜像此刻必然已在本地：多一次 pull 只会在国内网络下白等或直接失败
    assert.doesNotMatch(script, /compose[^\n]*pull/)
  })

  it('keeps every compose file of the stack in the rebuild command', () => {
    const script = buildUpdaterShellCommand('img:v1', 'v1', buildConfig({
      composeFiles: ['docker-compose.yml', 'docker-compose.bind.yml'],
    }))
    assert.match(script, /-f \/stack\/docker-compose\.yml/)
    assert.match(script, /-f \/stack\/docker-compose\.bind\.yml/)
  })
})

describe('updater 容器镜像选择', () => {
  const target = 'ghcr.io/pmat77/bubblesharkpanel:v0.3.10'
  const panel = 'ghcr.io/pmat77/bubblesharkpanel:v0.3.9'

  it('prefers the configured override, then the target image, then the panel image', () => {
    const candidates = buildUpdaterImageCandidates({
      configuredUpdaterImage: ' mirror.example.com/docker:27-cli ',
      targetImage: target,
      panelImage: panel,
    })
    assert.deepEqual(candidates.slice(0, 3), [
      { ref: 'mirror.example.com/docker:27-cli', canPull: true },
      { ref: target, canPull: false },
      { ref: panel, canPull: false },
    ])
    assert.deepEqual(candidates.slice(3).map(c => c.ref), [
      'docker.io/library/docker:27-cli',
      'docker.io/library/docker:cli',
    ])
  })

  it('probes local candidates before pulling anything', async () => {
    const probes: string[] = []
    const pulled: string[] = []
    const resolution = await resolveUpdaterImage(
      buildUpdaterImageCandidates({ targetImage: target, panelImage: panel }),
      {
        isPresent: async image => image === target || image === panel,
        probe: async (image) => {
          probes.push(image)
          return false
        },
        pull: async (image) => {
          pulled.push(image)
          return { ok: false as const, error: 'offline', tried: [image] }
        },
      },
    )
    assert.equal(resolution.image, null)
    // 本地候选先探测；兜底镜像本地没有，直接进入拉取（拉取失败就不必再探测）
    assert.deepEqual(probes, [target, panel])
    assert.deepEqual(pulled, ['docker.io/library/docker:27-cli', 'docker.io/library/docker:cli'])
  })

  it('falls back to the target image when the panel image lacks docker compose', async () => {
    const resolution = await resolveUpdaterImage(
      buildUpdaterImageCandidates({ targetImage: target, panelImage: panel }),
      {
        isPresent: async image => image === target || image === panel,
        probe: async image => image === target,
        pull: async () => {
          throw new Error('本地已有可用候选时不应触发拉取')
        },
      },
    )
    assert.equal(resolution.image, target)
  })

  it('pulls the official CLI image only when nothing local works', async () => {
    const pulled: string[] = []
    const resolution = await resolveUpdaterImage(
      buildUpdaterImageCandidates({ targetImage: target, panelImage: panel }),
      {
        isPresent: async () => false,
        probe: async () => true,
        pull: async (image) => {
          pulled.push(image)
          return { ok: true as const }
        },
      },
    )
    assert.deepEqual(pulled, ['docker.io/library/docker:27-cli'])
    assert.equal(resolution.image, 'docker.io/library/docker:27-cli')
  })

  it('reports every candidate plus the manual command when none is usable', async () => {
    const resolution = await resolveUpdaterImage(
      buildUpdaterImageCandidates({ targetImage: target, panelImage: panel }),
      {
        isPresent: async () => false,
        probe: async () => false,
        pull: async () => ({ ok: false as const, error: 'network unreachable', tried: ['docker.io/library/docker:27-cli'] }),
      },
    )
    assert.equal(resolution.image, null)
    const message = buildUpdaterImageFailureMessage(resolution, 'v0.3.10', buildConfig({
      stackDir: '/opt/bubblesharkpanel',
      runtimeMode: 'docker',
      composeFiles: ['docker-compose.yml', 'docker-compose.bind.yml'],
    }))
    assert.match(message, /无法准备面板更新容器/)
    assert.match(message, /up -d/)
    assert.match(message, /network unreachable/)
    assert.match(message, /ghcr\.io\/pmat77\/bubblesharkpanel:v0\.3\.10/)
  })
})

