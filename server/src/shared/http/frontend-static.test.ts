import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { it } from 'node:test'
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from 'node:zlib'
import Fastify from 'fastify'
import { registerFrontendStatic } from './frontend-static.ts'

it('serves compressed frontend variants with correct caches, resource 404s and SPA fallback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-frontend-'))
  const app = Fastify({ logger: false })
  const html = '<!doctype html><title>panel</title>'
  const js = 'export const panel = true;'.repeat(100)
  try {
    fs.mkdirSync(path.join(root, 'assets'))
    for (const [file, text] of [['index.html', html], ['assets/main-hash.js', js]]) {
      fs.writeFileSync(path.join(root, file), text)
      fs.writeFileSync(path.join(root, `${file}.gz`), gzipSync(text))
      fs.writeFileSync(path.join(root, `${file}.br`), brotliCompressSync(text))
    }
    registerFrontendStatic(app, root)
    for (const [encoding, decompress] of [['gzip', gunzipSync], ['br', brotliDecompressSync]] as const) {
      for (const url of ['/', '/index.html', '/node/instance/detail/demo', '/assets/main-hash.js']) {
        const response = await app.inject({ url, headers: { 'accept-encoding': encoding } })
        assert.equal(response.statusCode, 200)
        assert.equal(response.headers['content-encoding'], encoding)
        assert.match(String(response.headers.vary), /accept-encoding/i)
        const asset = url.startsWith('/assets/')
        assert.equal(response.headers['cache-control'], asset ? 'public, max-age=31536000, immutable' : 'no-cache')
        assert.equal(decompress(response.rawPayload).toString(), asset ? js : html)
        assert.match(String(response.headers['content-type']), asset ? /javascript/ : /text\/html/)
      }
    }
    for (const url of ['/', '/index.html', '/node/instance/detail/demo', '/assets/main-hash.js']) {
      const response = await app.inject({ url, headers: { 'accept-encoding': 'identity' } })
      assert.equal(response.statusCode, 200)
      assert.equal(response.headers['content-encoding'], undefined)
      assert.match(String(response.headers.vary), /accept-encoding/i)
      assert.equal(response.body, url.startsWith('/assets/') ? js : html)
    }
    for (const url of ['/assets/missing.js?v=old', '/assets/%6dissing%2ejs', '/assets/missing', '/browser_upgrade/missing.png', '/missing.css', '/app/missing', '/api/missing', '/health?check=1']) {
      const response = await app.inject({ url, headers: { accept: 'text/html', 'accept-encoding': 'gzip' } })
      assert.equal(response.statusCode, 404, url)
      assert.equal(response.headers['cache-control'], 'no-cache')
      assert.match(String(response.headers['content-type']), /application\/json/)
    }
    // 没有压缩副本的旧发布包也可继续提供原始资源。
    fs.writeFileSync(path.join(root, 'assets/plain.js'), js)
    const plain = await app.inject({ url: '/assets/plain.js', headers: { 'accept-encoding': 'br, gzip' } })
    assert.equal(plain.statusCode, 200)
    assert.equal(plain.headers['content-encoding'], undefined)
    assert.equal(plain.body, js)
  }
  finally {
    await app.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
