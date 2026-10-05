import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = 'http://127.0.0.1:8888'
const INSTANCE_ID = process.argv[2]
if (!INSTANCE_ID) {
  console.error('Usage: tsx regression-case4.ts <instanceId>')
  process.exit(1)
}

const dbPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/bubblesharkpanel.sqlite')

async function requestJson(method: string, urlPath: string, token: string, body?: unknown) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  try {
    const res = await fetch(`${BASE}${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', token },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    return res.json() as Promise<Record<string, unknown>>
  }
  finally {
    clearTimeout(timer)
  }
}

async function main() {
  const login = await requestJson('POST', '/app/account/login', '', { account: 'superadmin', password: '123456' })
  const token = (login.data as { token: string }).token

  const db = new DatabaseSync(dbPath)
  const before = db.prepare('SELECT status, container_id FROM game_instances WHERE id = ?').get(INSTANCE_ID) as {
    status: string
    container_id: string | null
  }
  console.log('Before patch:', before)

  db.prepare(`UPDATE game_instances SET status = 'stopped', container_id = NULL WHERE id = ?`).run(INSTANCE_ID)

  const start2 = await requestJson('POST', '/app/instance/start', token, { id: INSTANCE_ID })
  console.log('Drift start response:', JSON.stringify(start2))

  const after = db.prepare('SELECT status, container_id FROM game_instances WHERE id = ?').get(INSTANCE_ID) as {
    status: string
    container_id: string | null
  }
  db.close()
  console.log('After start:', after)

  if (start2.status === 1 && after.status === 'running' && after.container_id) {
    console.log('PASS #4')
    process.exit(0)
  }
  if (start2.status === 1 && before.container_id && after.status === 'running') {
    console.log('PASS #4 (container id may match existing ref)')
    process.exit(0)
  }
  console.error('FAIL #4')
  process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
