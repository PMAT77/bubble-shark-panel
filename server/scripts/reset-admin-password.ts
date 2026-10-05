import process from 'node:process'
import { closeDatabase, findUserByAccount, initDatabase, updateUserPassword } from '../src/shared/db/index'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function readArg(name: string): string {
  const prefix = `--${name}=`
  const matched = process.argv.find(item => item.startsWith(prefix))
  return matched ? matched.slice(prefix.length).trim() : ''
}

async function main() {
  const account = readArg('account') || process.env.ADMIN_USERNAME?.trim() || 'superadmin'
  const password = readArg('password') || process.env.ADMIN_PASSWORD?.trim() || ''
  if (!password) {
    console.error('用法: pnpm exec tsx server/scripts/reset-admin-password.ts --account=superadmin --password=YourNewPass#123')
    process.exit(1)
  }

  const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const dbPath = process.env.DB_PATH?.trim() || path.join(serverRoot, 'data', 'bubblesharkpanel.sqlite')
  const migrationsFolder = path.resolve(serverRoot, 'drizzle')

  await initDatabase(dbPath, migrationsFolder, {
    seedDevelopmentUsers: false,
    adminUsername: account,
    adminPassword: password,
    syncAdminPasswordFromEnv: false,
  })

  const user = await findUserByAccount(account)
  if (!user) {
    console.error(`账号不存在: ${account}`)
    closeDatabase()
    process.exit(1)
  }

  await updateUserPassword(user.id, password)
  closeDatabase()
  console.log(`管理员「${account}」密码已重置。请使用该密码登录并立即修改。`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
