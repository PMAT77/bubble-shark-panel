import type { FastifyInstance } from 'fastify'
import process from 'node:process'
import { createServerApp } from './app'
import { startScheduleScheduler } from './modules/schedule/scheduler'
import { finalizePendingDatabaseRestore, resolveMigrationsFolder } from './modules/system/db-restore-service'
import { syncPanelPortSettingIfStale } from './modules/system/panel-port'
import type { AdminCredentialOutcome } from './shared/config/credentials-file'
import { shouldWriteAdminCredentialsFile, writeAdminCredentialsFile } from './shared/config/credentials-file'
import { ensureServerRuntimeDirs, loadServerConfig } from './shared/config'
import { InstanceConsoleLogFile, resolveConsoleLogsDir, setActiveConsoleLogFile } from './shared/instance-runtime/console-log-file'
import { instanceConsoleLogStore } from './shared/instance-runtime/console-log-store'
import { initDatabase } from './shared/db/index'

/**
 * 后端启动入口。
 * 说明：
 * - 负责启动顺序控制（配置加载 -> 依赖初始化 -> 模块注册 -> 启动监听）。
 * - 目前为骨架占位，后续按选定框架补齐。
 */
export async function bootstrap() {
  const config = loadServerConfig()
  ensureServerRuntimeDirs(config)
  // 控制台日志落盘：内存里只留最近 2000 行，面板重启后仍能从文件里翻出上一次运行的游戏日志
  const consoleLogFile = new InstanceConsoleLogFile(resolveConsoleLogsDir(config.dbPath))
  setActiveConsoleLogFile(consoleLogFile)
  instanceConsoleLogStore.setSink(consoleLogFile)
  const app = await createServerApp(config)
  let isClosing = false
  let isListening = false

  async function gracefulShutdown(reason: string) {
    if (isClosing) {
      return
    }
    isClosing = true
    app.log.info(`收到退出信号，准备关闭服务（${reason}）`)
    try {
      if (isListening) {
        await app.close()
      }
    }
    catch (error) {
      app.log.error(error, '服务关闭异常')
    }
    finally {
      process.exit(0)
    }
  }

  bindProcessLifecycle(app, gracefulShutdown)

  // 打包后 bundle 位于 dist-server/，固定相对路径失效；改从仓库根定位（server/drizzle）
  const migrationsFolder = resolveMigrationsFolder()
  // 上一次「恢复面板数据」的收尾：恢复后的库不可用时要在这里回退，必须在打开数据库之前判完，
  // 否则面板会卡在「启动即崩」的重启循环里，而用户没有任何界面可用。
  await finalizePendingDatabaseRestore({ app, dbPath: config.dbPath, migrationsFolder })
  let adminCredentialOutcome: AdminCredentialOutcome = 'absent'
  const dbFilePath = await initDatabase(config.dbPath, migrationsFolder, {
    forcePasswordChange: config.forcePasswordChange,
    adminUsername: config.adminUsername,
    adminPassword: config.adminPassword,
    syncAdminPasswordFromEnv: config.syncAdminPasswordFromEnv,
    seedDevelopmentUsers: config.mode !== 'production',
    onAdminCredentialOutcome: (outcome) => {
      adminCredentialOutcome = outcome
    },
    onRbacMigrationOutcome: (outcome) => {
      // 只在真正跑过迁移的那一次启动里打印：老账号被映射成什么角色、补了多少条实例授权，
      // 都写进日志，便于升级后排查「为什么这个账号看不到菜单」。
      app.log.info(
        `权限体系迁移完成：新建角色 ${outcome.rolesCreated} 个（${outcome.guestRoleCreated ? '含内置游客角色' : '未新建游客角色'}），`
        + `为 ${outcome.usersAssigned} 个账号分配了角色，补充实例授权 ${outcome.grantsCreated} 条`,
      )
      if (outcome.usersWithoutPermission.length > 0) {
        app.log.warn(
          `以下账号在迁移后没有任何权限点，登录后看不到菜单（如果本来就不需要它们登录，可忽略；否则请在「成员与角色」里分配角色）：${outcome.usersWithoutPermission.join('、')}`,
        )
      }
    },
  })
  if (config.adminPasswordGenerated) {
    if (shouldWriteAdminCredentialsFile(adminCredentialOutcome)) {
      // 初始密码只落 0600 凭据文件，绝不写入日志（journald/日志采集管道不可信）。
      const credentialsFile = writeAdminCredentialsFile(config.dbPath, config.adminUsername, config.adminPassword)
      app.log.warn(
        `生产环境未配置 ADMIN_PASSWORD，已为管理员「${config.adminUsername}」自动生成初始密码，已写入 0600 权限凭据文件（请立即读取保存，首次登录改密后可删除）: ${credentialsFile}`,
      )
    }
    else {
      // 管理员已存在且未开启 GSH_SYNC_ADMIN_PASSWORD_FROM_ENV 时，本次随机密码并没有写进数据库。
      // 此时若照旧落盘，用户会拿到一个永远登录不上的密码，而且每次启动都会被新的随机值覆盖；
      // 已有的凭据文件保持原样 —— 它记录的是首次创建管理员时的初始密码，仍可能是用户唯一的一手记录。
      app.log.warn(
        `生产环境未配置 ADMIN_PASSWORD，但管理员「${config.adminUsername}」已存在于数据库且未开启 GSH_SYNC_ADMIN_PASSWORD_FROM_ENV，本次自动生成的随机密码未写入数据库，已忽略（不会覆盖初始凭据文件）。如需用环境变量中的密码覆盖数据库密码，请设置 GSH_SYNC_ADMIN_PASSWORD_FROM_ENV=1 后重启面板。`,
      )
    }
  }
  await syncPanelPortSettingIfStale({ mode: config.mode })

  // 计划任务调度器必须在数据库初始化之后启动：
  // 启动恢复要读 scheduled_tasks 并把面板离线期间错过的任务标记为 skipped 顺延（绝不补跑）。
  // 放在 createServerApp（模块注册）里启动会因为 SQLite 尚未就绪而必然失败。
  startScheduleScheduler(app)

  try {
    await app.listen({ port: config.port, host: config.host })
    isListening = true
    app.log.info(`后端配置文件: ${config.envFile}`)
    app.log.info(`SQLite 数据库已就绪: ${dbFilePath}`)
    app.log.info(`日志目录: ${config.logDir}`)
    app.log.info(`后端服务已启动: http://${config.host}:${config.port}`)
  }
  catch (error) {
    app.log.error(error, '后端服务启动失败')
    await app.close()
    throw error
  }
}

function bindProcessLifecycle(app: FastifyInstance, shutdown: (reason: string) => Promise<void>) {
  process.once('SIGINT', () => {
    void shutdown('SIGINT')
  })
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM')
  })
  process.once('SIGHUP', () => {
    void shutdown('SIGHUP')
  })
  process.once('disconnect', () => {
    void shutdown('disconnect')
  })

  if (process.stdin?.isTTY) {
    process.stdin.once('close', () => {
      void shutdown('stdin close')
    })
    process.stdin.once('end', () => {
      void shutdown('stdin end')
    })
    process.stdin.resume()
  }

  app.log.debug('后端进程生命周期监听已注册')
}
