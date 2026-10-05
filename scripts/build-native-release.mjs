import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { build } from 'esbuild'

const repoRoot = path.resolve(import.meta.dirname, '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const version = String(packageJson.version)
const includeNode = process.argv.includes('--include-node')
const outputFlagIndex = process.argv.indexOf('--output')
const outputRoot = outputFlagIndex >= 0 && process.argv[outputFlagIndex + 1]
  ? path.resolve(process.argv[outputFlagIndex + 1])
  : path.join(
      repoRoot,
      '.artifacts',
      'native',
      `bubblesharkpanel-native-v${version}-linux-x64`,
    )

function assertSafeOutputDir(target) {
  const parsed = path.parse(target)
  if (!parsed.base.startsWith('bubblesharkpanel-native-')) {
    throw new Error(`Refusing unsafe native release output directory: ${target}`)
  }
  if (!parsed.dir || parsed.dir === parsed.root || target === repoRoot) {
    throw new Error(`Refusing broad native release output directory: ${target}`)
  }
}

function copyRequired(source, destination) {
  if (!fs.existsSync(source)) {
    throw new Error(`Required release input is missing: ${source}`)
  }
  fs.cpSync(source, destination, { recursive: true })
}

assertSafeOutputDir(outputRoot)
if (!fs.existsSync(path.join(repoRoot, 'dist', 'index.html'))) {
  throw new Error('Frontend dist is missing. Run pnpm run build before build:native.')
}

fs.rmSync(outputRoot, { recursive: true, force: true })
fs.mkdirSync(path.join(outputRoot, 'server', 'dist'), { recursive: true })

await build({
  entryPoints: [path.join(repoRoot, 'server', 'src', 'main.ts')],
  outfile: path.join(outputRoot, 'server', 'dist', 'main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'bundle',
  external: ['cpu-features'],
  banner: {
    js: [
      'import { createRequire as __gshCreateRequire } from "node:module";',
      'import { fileURLToPath as __gshFileURLToPath } from "node:url";',
      'import { dirname as __gshDirname } from "node:path";',
      'const require = __gshCreateRequire(import.meta.url);',
      'const __filename = __gshFileURLToPath(import.meta.url);',
      'const __dirname = __gshDirname(__filename);',
    ].join(' '),
  },
})

copyRequired(path.join(repoRoot, 'dist'), path.join(outputRoot, 'dist'))
copyRequired(path.join(repoRoot, 'server', 'drizzle'), path.join(outputRoot, 'server', 'drizzle'))
for (const filename of ['LICENSE', 'NOTICE']) {
  copyRequired(path.join(repoRoot, filename), path.join(outputRoot, filename))
}

fs.writeFileSync(
  path.join(outputRoot, 'package.json'),
  `${JSON.stringify({
    name: packageJson.name,
    version,
    type: 'module',
    private: true,
  }, null, 2)}\n`,
  'utf8',
)

const binDir = path.join(outputRoot, 'bin')
fs.mkdirSync(binDir, { recursive: true })
const launcher = `#!/usr/bin/env bash
set -Eeuo pipefail
release_root="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
bundled_node="\${release_root}/runtime/node/bin/node"
if [[ -x "\${bundled_node}" ]]; then
  exec "\${bundled_node}" "\${release_root}/server/dist/main.mjs"
fi
exec node "\${release_root}/server/dist/main.mjs"
`
fs.writeFileSync(path.join(binDir, 'bubblesharkpanel'), launcher, { encoding: 'utf8', mode: 0o755 })
fs.writeFileSync(path.join(binDir, 'game-server-hub'), launcher, { encoding: 'utf8', mode: 0o755 })

if (includeNode) {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('--include-node must run on Linux x64')
  }
  const nodeBinDir = path.join(outputRoot, 'runtime', 'node', 'bin')
  fs.mkdirSync(nodeBinDir, { recursive: true })
  fs.copyFileSync(process.execPath, path.join(nodeBinDir, 'node'))
  fs.chmodSync(path.join(nodeBinDir, 'node'), 0o755)
}

fs.writeFileSync(
  path.join(outputRoot, 'release.json'),
  `${JSON.stringify({
    version: `v${version}`,
    platform: 'linux',
    arch: 'x64',
    nodeVersion: process.version,
    bundledNode: includeNode,
    entrypoint: 'bin/bubblesharkpanel',
  }, null, 2)}\n`,
  'utf8',
)

console.log(`[native-release] prepared ${outputRoot}`)
