import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dbPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/bubblesharkpanel.sqlite')
const [action, instanceId] = process.argv.slice(2)

if (!action || !instanceId) {
  console.error('Usage: patch-instance-status.ts <read|stopped> <instanceId>')
  process.exit(1)
}

const db = new DatabaseSync(dbPath)
if (action === 'stopped') {
  db.prepare(`UPDATE game_instances SET status = 'stopped', container_id = NULL WHERE id = ?`).run(instanceId)
  console.log('patched')
}
else if (action === 'read') {
  const row = db.prepare('SELECT status, container_id FROM game_instances WHERE id = ?').get(instanceId)
  console.log(JSON.stringify(row))
}
db.close()
