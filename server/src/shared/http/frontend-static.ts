import type { FastifyInstance } from 'fastify'
import path from 'node:path'
import fastifyStatic from '@fastify/static'

/** 生产静态资源与 SPA 回退；独立注册以便用临时产物验证缓存和压缩协商。 */
export function registerFrontendStatic(app: FastifyInstance, distDir: string) {
  void app.register(fastifyStatic, {
    root: distDir,
    prefix: '/',
    preCompressed: true,
    cacheControl: false,
    setHeaders: (reply, filePath) => {
      // preCompressed 回调拿到的是 .br/.gz 文件名，入口仍必须每次校验。
      const originalPath = filePath.replace(/\.(?:br|gz)$/, '')
      reply.header('Cache-Control', originalPath.includes(`${path.sep}assets${path.sep}`)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache')
    },
  })
  app.setNotFoundHandler((request, reply) => {
    let pathname: string
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
    }
    catch {
      return reply.status(400).send({ status: 1, error: 'Bad Request' })
    }
    reply.header('Cache-Control', 'no-cache')
    if (
      pathname.startsWith('/app/') || pathname.startsWith('/api/') || pathname === '/health'
      || pathname.startsWith('/assets/') || pathname.startsWith('/browser_upgrade/')
      || path.posix.extname(pathname)
    ) {
      return reply.status(404).send({ status: 1, error: 'Not Found' })
    }
    return reply.sendFile('index.html')
  })
}
