import fs from 'node:fs'
import path from 'node:path'

/** The CDN SDK reads a public key and dynamically chooses an LZMA package.
 * Embed the public resource and use its pure JS decoder in isolated workers. */
export function steamCdnBundlePlugin() {
  return { name: 'steam-cdn-static-resources', setup(builder) {
    builder.onLoad({ filter: /[\\/]steam-crypto[\\/]index\.js$/ }, args => {
      const key = fs.readFileSync(path.join(path.dirname(args.path), 'system.pem'), 'utf8')
      return { contents: fs.readFileSync(args.path, 'utf8').replace("require('fs').readFileSync(__dirname + '/system.pem')", `Buffer.from(${JSON.stringify(key)})`), loader: 'js' }
    })
    builder.onLoad({ filter: /[\\/]steam-user[\\/]components[\\/]cdn_compression\.js$/ }, args => ({
      contents: fs.readFileSync(args.path, 'utf8').replace("requireWithFallback('lzma-native', 'lzma')", "require('lzma/src/lzma_worker.js').LZMA_WORKER"), loader: 'js',
    }))
  } }
}
