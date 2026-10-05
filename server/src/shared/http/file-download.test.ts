import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
// 相对导入写明 .ts：这样本文件用 Node 原生 TypeScript 支持（node --test）也能直接跑，
// tsx 同样兼容；tsconfig 已开启 allowImportingTsExtensions。
import { sendFileDownload } from './file-download.ts'

const tempDirs: string[] = []
const apps: FastifyInstance[] = []

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-file-download-'))
  tempDirs.push(dir)
  return dir
}

/**
 * 起一个真实 Fastify 实例，注册与生产路由同构的 async 下载 handler。
 *
 * 回归点是「handler 必须把 helper 的返回值 return 出去」。此前三处下载路由都写成
 * `reply.send(fs.createReadStream(...))` 而不返回，Fastify 认为 handler 什么都没发，
 * 遂以空 payload 结束响应：HTTP 200 + Content-Length: 0，用户下载到 0 字节文件。
 * 下面的字节数断言正是为了守住这条 —— 去掉 `return` 时它会是 0。
 */
async function buildDownloadApp(options: {
  filePath: string
  fileName: string
  contentType: string
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  apps.push(app)
  app.get('/download', async (_request, reply) => {
    return sendFileDownload(reply, options)
  })
  await app.ready()
  return app
}

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close()
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('sendFileDownload', () => {
  it('streams the whole file, byte for byte', async () => {
    const dir = createTempDir()
    const filePath = path.join(dir, 'inst-console.log')
    const text = [
      '2026-09-16T12:00:00.000Z [panel] 实例已启动',
      '2026-09-16T12:00:01.000Z [master] 世界已生成',
      '2026-09-16T12:00:02.000Z [caves] 洞穴已连接',
    ].join('\n')
    fs.writeFileSync(filePath, text, 'utf8')

    const app = await buildDownloadApp({
      filePath,
      fileName: 'inst-console.log',
      contentType: 'text/plain; charset=utf-8',
    })
    const response = await app.inject({ method: 'GET', url: '/download' })

    assert.equal(response.statusCode, 200)
    // 流式响应没有 content-length（实际走 chunked），以实际收到的字节数为准
    assert.equal(response.rawPayload.length, Buffer.byteLength(text, 'utf8'))
    assert.equal(response.body, text)
  })

  it('sets the download headers as given', async () => {
    const dir = createTempDir()
    const filePath = path.join(dir, 'backup.tar.gz')
    fs.writeFileSync(filePath, 'not really a gzip', 'utf8')

    const app = await buildDownloadApp({
      filePath,
      fileName: 'backup-2026-09-16.tar.gz',
      contentType: 'application/gzip',
    })
    const response = await app.inject({ method: 'GET', url: '/download' })

    assert.equal(response.headers['content-type'], 'application/gzip')
    // 头部同时给出 ASCII 回退与 RFC 5987 编码名，客户端优先取后者
    assert.equal(
      response.headers['content-disposition'],
      'attachment; filename="backup-2026-09-16.tar.gz"; filename*=UTF-8\'\'backup-2026-09-16.tar.gz',
    )
  })

  /**
   * 回归：房间名是中文时，迁移包名也带中文，而 HTTP 头只允许 latin1，
   * 直接拼进 `filename="..."` 会让 Node 抛 `ERR_INVALID_CHAR` —— 接口 500、点了导出什么都没下到。
   */
  it('serves a download whose file name contains non-ASCII characters', async () => {
    const dir = createTempDir()
    const filePath = path.join(dir, 'archive.tar.gz')
    fs.writeFileSync(filePath, 'gzip-ish bytes', 'utf8')

    const app = await buildDownloadApp({
      filePath,
      fileName: '迁移测试房.tar.gz',
      contentType: 'application/gzip',
    })
    const response = await app.inject({ method: 'GET', url: '/download' })

    assert.equal(response.statusCode, 200)
    assert.equal(response.rawPayload.length, Buffer.byteLength('gzip-ish bytes', 'utf8'))
    const disposition = String(response.headers['content-disposition'] ?? '')
    assert.match(disposition, /filename="[^"]*\.tar\.gz"/)
    assert.match(disposition, /filename\*=UTF-8''%E8%BF%81%E7%A7%BB/)
  })

  it('still serves an empty file as an empty download', async () => {
    const dir = createTempDir()
    const filePath = path.join(dir, 'empty.log')
    fs.writeFileSync(filePath, '', 'utf8')

    const app = await buildDownloadApp({
      filePath,
      fileName: 'empty.log',
      contentType: 'text/plain; charset=utf-8',
    })
    const response = await app.inject({ method: 'GET', url: '/download' })

    // 文件存在但内容为空，与「没有日志文件」的 404 是两回事
    assert.equal(response.statusCode, 200)
    assert.equal(response.rawPayload.length, 0)
  })

  it('fails loudly when the file disappeared instead of answering 200 with nothing', async () => {
    const dir = createTempDir()
    const app = await buildDownloadApp({
      filePath: path.join(dir, 'gone.log'),
      fileName: 'gone.log',
      contentType: 'text/plain; charset=utf-8',
    })
    const response = await app.inject({ method: 'GET', url: '/download' })

    // 读流失败必须报错：静默回一个 200 空响应正是本次缺陷的表现
    assert.notEqual(response.statusCode, 200)
  })
})
