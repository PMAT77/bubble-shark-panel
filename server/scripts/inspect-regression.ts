import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = 'http://127.0.0.1:8888'
const dbPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/bubblesharkpanel.sqlite')
const db = new DatabaseSync(dbPath)

async function main() {
  const rows = db.prepare(`
    SELECT id, name, status, last_error
    FROM game_instances
    WHERE name LIKE 'reg-%'
    ORDER BY updated_at DESC
    LIMIT 5
  `).all() as Array<{ id: string, name: string, status: string, last_error: string | null }>
  console.log('Recent reg-* instances in DB:')
  for (const row of rows) {
    console.log(row.name, row.status, row.id)
    console.log('  error:', (row.last_error ?? '').slice(0, 400))
  }

  const stopped = db.prepare(`
    SELECT id, name, status FROM game_instances
    WHERE status = 'stopped' AND game_code = '343050'
    ORDER BY updated_at DESC LIMIT 1
  `).get() as { id: string, name: string } | undefined
  console.log('\nStopped DST instance for drift test:', stopped)

  const login = await fetch(`${BASE}/app/account/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: 'superadmin', password: '123456' }),
  }).then(r => r.json()) as { data: { token: string } }
  const token = login.data.token

  if (rows[0]?.id) {
    const log = await fetch(`${BASE}/app/instance/install-log?id=${rows[0].id}`, { headers: { token } })
      .then(r => r.json()) as { data: { content: string, status: string } }
    console.log('\nLatest install log tail:')
    console.log((log.data?.content ?? '').slice(-1200))
  }
}

main().catch(console.error)
