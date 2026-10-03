import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { isAllowedBrowsePath, listChildEntries } from './filesystem-browse'

let workDir: string
let rootDir: string
let outsideDir: string

before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsh-browse-test-'))
  rootDir = path.join(workDir, 'root')
  outsideDir = path.join(workDir, 'outside')
  fs.mkdirSync(path.join(rootDir, 'inner'), { recursive: true })
  fs.mkdirSync(outsideDir, { recursive: true })
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), '不应被浏览到')
  // junction 在 Windows 上无需管理员权限，在 Linux 上按普通目录符号链接创建
  fs.symlinkSync(outsideDir, path.join(rootDir, 'escape'), 'junction')
})

after(() => {
  // 先清接入，再清来源，夹具不留下悬空链接。
  fs.unlinkSync(path.join(rootDir, 'escape'))
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe('filesystem browse sandbox', () => {
  it('allows paths inside the allowed roots', () => {
    assert.equal(isAllowedBrowsePath(path.join(rootDir, 'inner'), [rootDir]), true)
  })

  // 回归：只校验字面路径时，允许根内的一个符号链接就能把浏览引到根外目录
  it('rejects a symlink that points outside the allowed roots', () => {
    assert.equal(isAllowedBrowsePath(path.join(rootDir, 'escape'), [rootDir]), false)
  })

  it('keeps accepting paths that do not exist yet', () => {
    assert.equal(isAllowedBrowsePath(path.join(rootDir, 'not-created-yet'), [rootDir]), true)
  })

  it('filters symlinked entries out of directory listings', () => {
    // 必须显式传入窄范围的允许根：默认根在 Windows 上是盘符根（C:\ 之类），
    // 临时目录正好落在其中，符号链接与普通目录都会被放行，断言就失去意义。
    const names = listChildEntries(rootDir, [rootDir]).map(item => item.name)
    assert.ok(names.includes('inner'))
    assert.ok(!names.includes('escape'))
  })
})
