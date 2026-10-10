import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { ShardId } from '../../../../shared/contracts/shard'
import type { WorldMaintenancePayload, WorldMaintenanceOperation } from '../../../../shared/contracts/world-maintenance'
import type { ResolvedLocalDstInstance } from '../../shared/dst/local-dst-instance'
import type { AuthorizedUser } from '../system/auth'
import { getGameInstanceById } from '../../shared/db'
import { withInstanceContentOperation } from '../../shared/instance-content/operation'
import { appendOperationAudit } from '../../shared/audit/operation-audit'
import { readWorldSeeds, writeWorldSeed, markObservedWorldSeedStale, writeObservedWorldSeed } from '../../infra/game-adapter/dst/panel-config-meta'
import { configuredWorldShards, listShardSnapshots, buildSnapshotRollbackCommand, buildResetWorldCommand, readShardSessionId, worldIsOnline } from '../../infra/game-adapter/dst/world-maintenance'
import { isCavesShardConfigured, removeShardSaveDir } from '../../infra/game-adapter/dst/shard-layout'
import { createInstanceBackupUnlocked } from '../backup/backup-service'
import { syncInstanceModFilesFromDb } from '../mod/mod-file-sync-service'
import { inspectInstanceShardRuntime, sendInstanceContainerCommand } from '../instance/container-lifecycle'
import { startAfterWorldMaintenance } from '../instance/world-maintenance-entry'
import { resolveInstanceResourceSettings } from '../instance/resource-settings'
import { queryRoomWorlds, saveRoomConfirmed, pause, consoleCursor, waitMaintenanceAcknowledgement } from '../console/world-maintenance-probe'
import { isPendingMaintenance, maintenanceRecords, persistMaintenance, publicMaintenance, type MaintenanceCheckpoint } from './world-maintenance-store'

const runners = new Map<string, Promise<void>>()
const confirmations = new Map<string, (continueWithoutBackup: boolean) => void>()
export const maintenanceDependencies = {
  inspect: inspectInstanceShardRuntime, query: queryRoomWorlds, save: saveRoomConfirmed,
  send: sendInstanceContainerCommand, acknowledge: waitMaintenanceAcknowledgement, backup: createInstanceBackupUnlocked,
  syncMods: syncInstanceModFilesFromDb, start: startAfterWorldMaintenance, getInstance: getGameInstanceById,
}
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)
function audit(op: MaintenanceCheckpoint): void {
  appendOperationAudit({ account: op.actorAccount, userId: op.actorId, method: 'POST', path: '/internal/world-maintenance/result',
    body: { instanceId: op.instanceId, action: op.action, scope: op.scope, shards: op.shards.join(','), snapshotId: op.targetSnapshotId,
      worldDay: op.targetWorldDay, backupId: op.backupId, backupSkipped: op.backupSkipped, state: op.state, phase: op.phase, message: op.message },
    statusCode: op.state === 'completed' ? 200 : op.state === 'awaiting_confirmation' ? 409 : 500,
    durationMs: Date.now() - Date.parse(op.startedAt), requestId: op.requestId })
}
function update(instance: ResolvedLocalDstInstance, op: MaintenanceCheckpoint, patch: Partial<MaintenanceCheckpoint>): void {
  Object.assign(op, patch, { updatedAt: new Date().toISOString() })
  persistMaintenance(instance.installPath, op)
}
function target(instance: ResolvedLocalDstInstance, op: MaintenanceCheckpoint) {
  if (op.payload.action !== 'rollback') return null
  const payload = op.payload
  const selected = listShardSnapshots(instance.installPath, 'master').find(item => item.sessionId === payload.sessionId && item.snapshotId === payload.snapshotId && item.rollbackSteps !== null)
  if (!selected) throw new Error('回档列表已过期、会话已改变或目标不完整，请刷新存档点后重新选择')
  if (selected.cavesSessionId !== (payload.cavesSessionId ?? null)) throw new Error('洞穴会话已改变，请刷新后重新选择回档目标')
  if (op.baseline.caves?.sessionId && readShardSessionId(instance.installPath, 'caves') !== op.baseline.caves.sessionId) throw new Error('洞穴会话已改变，请刷新后重新选择回档目标')
  return selected
}
async function preflight(instance: ResolvedLocalDstInstance, op: MaintenanceCheckpoint): Promise<'running' | 'stopped'> {
  const current = await maintenanceDependencies.getInstance(instance.id)
  if (!current || ['pending_install', 'installing'].includes(current.status)) throw new Error('实例不存在或正在安装，无法维护世界')
  const configured = configuredWorldShards(instance.installPath)
  if (configured.includes('caves') && !isCavesShardConfigured(instance.installPath)) throw new Error('房间启用了洞穴，但洞穴配置不完整')
  if (op.shards.some(shard => !configured.includes(shard))) throw new Error('目标分片未配置或配置已改变')
  const probes = await Promise.all(configured.map(shard => maintenanceDependencies.inspect(instance.id, shard)))
  if (probes.some(probe => probe.unitExists && !probe.snapshot)) throw new Error('无法确认分片运行状态，已禁止维护操作')
  const running = probes.map(probe => probe.snapshot?.running === true)
  if (running.every(value => !value)) {
    if (current.status === 'running') throw new Error('实例状态与运行时不一致，请等待状态对账后重试')
    if (op.action === 'save' || op.action === 'rollback') throw new Error('保存和回档需要所有已配置分片加载完成')
    if (!Object.keys(op.baseline).length) update(instance, op, { baseline: Object.fromEntries(configured.map(shard => [shard, { loadId: null, sessionId: readShardSessionId(instance.installPath, shard), ready: false, snapshotId: null, seed: null, shardId: null, remoteConnected: false }])) })
    return 'stopped'
  }
  if (running.some(value => !value) || current.status !== 'running') throw new Error('分片仅部分运行或正在启动，请等待所有分片加载完成')
  const worlds = await maintenanceDependencies.query(instance.id, configured)
  if (configured.some(shard => !worlds[shard]?.ready || !worlds[shard]?.sessionId || !worlds[shard]?.remoteConnected)) throw new Error('未确认所有已配置分片加载完成及连接，已停止维护操作')
  if (Object.keys(op.baseline).length === 0) update(instance, op, { baseline: worlds })
  else if (configured.some(shard => op.baseline[shard]?.sessionId !== worlds[shard]?.sessionId)) throw new Error('世界会话已改变，请重新发起维护操作')
  target(instance, op)
  return 'running'
}
async function verify(instance: ResolvedLocalDstInstance, op: MaintenanceCheckpoint): Promise<void> {
  update(instance, op, { phase: 'verifying', canContinue: false })
  while (Date.now() < Date.parse(op.deadlineAt!)) {
    const configured = configuredWorldShards(instance.installPath)
    const worlds = await maintenanceDependencies.query(instance.id, configured)
    const ready = configured.every(shard => worlds[shard]?.ready && worlds[shard]?.remoteConnected && worlds[shard]?.sessionId)
    let verified = false
    if (ready && op.payload.action === 'rollback') {
      verified = configured.every(shard => worlds[shard]?.sessionId === op.baseline[shard]?.sessionId
        && worlds[shard]?.loadId !== op.baseline[shard]?.loadId
        && worlds[shard]?.snapshotId === op.targetSnapshotId
        && listShardSnapshots(instance.installPath, shard)[0]?.snapshotId === op.targetSnapshotId)
    }
    else if (ready && op.action === 'save') {
      verified = true // saveRoomConfirmed 已检查每个分片回调及落盘证据。
    }
    else if (ready) {
      verified = op.shards.every(shard => worlds[shard]?.sessionId !== op.baseline[shard]?.sessionId
        && readShardSessionId(instance.installPath, shard) === worlds[shard]?.sessionId)
      if (verified && op.payload.action === 'regenerate' && op.payload.worldSeed !== null) {
        verified = Number(worlds[op.payload.shard]?.seed) === Number(op.payload.worldSeed)
      }
    }
    if (verified) {
      for (const shard of configured) {
        const world = worlds[shard]!
        if (world.seed) writeObservedWorldSeed(instance.installPath, shard, { seed: world.seed, sessionId: world.sessionId, at: new Date().toISOString() })
      }
      update(instance, op, { state: 'completed', phase: 'finished', message: op.action === 'save' ? '整个房间的存档已保存' : op.action === 'rollback' ? `已回到存档点 #${op.targetSnapshotId}` : '世界已生成、加载并通过核验' })
      return
    }
    await pause(1000)
  }
  throw new Error(op.action === 'rollback' ? '未确认回档完成：主世界目标编号或洞穴同步结果尚未通过核验，请检查实际世界' : '未确认生成完成：世界会话或实际种子未通过核验，请检查实际世界；不会自动重发命令')
}
async function awaitBackupConfirmation(instance: ResolvedLocalDstInstance, op: MaintenanceCheckpoint): Promise<void> {
  const until = Date.parse(op.confirmationExpiresAt!)
  const proceed = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => { confirmations.delete(op.id); resolve(false) }, Math.max(0, until - Date.now()))
    confirmations.set(op.id, (value) => { clearTimeout(timer); confirmations.delete(op.id); resolve(value) })
  })
  if (!proceed) {
    update(instance, op, { state: 'cancelled', phase: 'finished', canContinue: false, message: '操作已取消或不备份确认已过期，未执行后续操作' })
    throw new Error(op.message!)
  }
  update(instance, op, { state: 'running', backupSkipped: true, canContinue: false, confirmationExpiresAt: null })
  audit(op)
}
async function restoreConfig(instance: ResolvedLocalDstInstance, op: MaintenanceCheckpoint): Promise<void> {
  if (!op.configChanged || op.commandAttempted || op.payload.action !== 'regenerate') return
  writeWorldSeed(instance.installPath, op.payload.shard, op.previousSeed)
  await maintenanceDependencies.syncMods(instance.id, instance.installPath)
  update(instance, op, { configChanged: false })
}
async function execute(instance: ResolvedLocalDstInstance, op: MaintenanceCheckpoint, recovering: boolean): Promise<void> {
  await withInstanceContentOperation(instance.id, async () => {
    if (recovering && op.commandAttempted) {
      // 面板重启后仅核验，绝不重发保存、回档或生成命令。
      if (op.action === 'save') throw new Error('面板在保存确认期间重启，回调证据已丢失，保存结果未确认；不会自动重发')
      await verify(instance, op)
      return
    }
    if (recovering && op.state !== 'awaiting_confirmation') {
      await restoreConfig(instance, op)
      throw new Error('面板在发送命令前重启，操作已中止，请重新发起')
    }
    let mode = await preflight(instance, op)
    if (op.action === 'save') {
      update(instance, op, { phase: 'saving', commandAttempted: true })
      await maintenanceDependencies.save(instance.id, instance.installPath, resolveInstanceResourceSettings(instance.resourceConfig).shardReadyWaitSec)
      update(instance, op, { state: 'completed', phase: 'finished', message: '整个房间的存档已保存' })
      return
    }
    if (op.state === 'awaiting_confirmation') await awaitBackupConfirmation(instance, op)
    else if (op.payload.backupBefore) {
      // 回档不强制保存；保存会增加快照并可能淘汰已确认的目标。
      if (mode === 'running' && op.action !== 'rollback') {
        update(instance, op, { phase: 'saving' })
        await maintenanceDependencies.save(instance.id, instance.installPath, resolveInstanceResourceSettings(instance.resourceConfig).shardReadyWaitSec)
      }
      update(instance, op, { phase: 'backing_up' })
      let backup: Awaited<ReturnType<typeof maintenanceDependencies.backup>>
      try {
        backup = await maintenanceDependencies.backup({ app: appByOperation.get(op.id), instanceId: instance.id,
          kind: op.action === 'rollback' ? 'pre_rollback' : 'pre_reset', note: `世界维护 ${op.id}（${instance.name}，${op.action}，${op.scope}）`, createdBy: op.actorId, saveBeforeArchive: false })
      }
      catch (error) { backup = { ok: false, message: errorMessage(error) } }
      if (!backup.ok || !backup.backup) {
        update(instance, op, { state: 'awaiting_confirmation', backupWarning: backup.message ?? '安全备份失败', canContinue: true,
          confirmationExpiresAt: new Date(Date.now() + 300000).toISOString(), message: '安全备份失败，操作已暂停；取消或再次确认不备份继续' })
        audit(op)
        await awaitBackupConfirmation(instance, op)
      }
      else update(instance, op, { backupId: backup.backup.id })
    }
    mode = await preflight(instance, op)
    const selected = target(instance, op)
    if (selected) update(instance, op, { targetWorldDay: selected.worldDay })
    if (op.payload.action === 'regenerate') {
      update(instance, op, { phase: 'applying_config', previousSeed: readWorldSeeds(instance.installPath)[op.payload.shard] ?? null, configChanged: true })
      writeWorldSeed(instance.installPath, op.payload.shard, op.payload.worldSeed)
    }
    if (op.action !== 'rollback') {
      // 普通重置也迁移旧版种子 Mod：沿用已保存配置，不提交页面草稿。
      update(instance, op, { phase: 'applying_config' })
      await maintenanceDependencies.syncMods(instance.id, instance.installPath)
      mode = await preflight(instance, op)
    }
    // 配置落位、备份与目标复查全部通过后，才进入不可自动重试的阶段。
    const waitSec = resolveInstanceResourceSettings(instance.resourceConfig).shardReadyWaitSec
    update(instance, op, { phase: 'executing', deadlineAt: new Date(Date.now() + waitSec * configuredWorldShards(instance.installPath).length * 1000).toISOString() })
    if (mode === 'running') {
      const shard = op.scope === 'cluster' ? 'master' : op.shards[0]!
      const command = op.payload.action === 'rollback'
        ? buildSnapshotRollbackCommand(op.payload.sessionId, op.payload.snapshotId, op.id, worldIsOnline(instance.installPath))
        : `print('BSPMAINT:${op.id}:accepted'); ${buildResetWorldCommand(op.scope)}`
      const after = consoleCursor(instance.id)
      update(instance, op, { commandAttempted: true })
      let cavesExecuted = false
      if (op.payload.action === 'rollback' && op.baseline.caves?.sessionId) {
        // 明确重载洞穴，包含回到最新存档点时丢弃洞穴未保存进度的情况。
        const caveCommand = buildSnapshotRollbackCommand(op.baseline.caves.sessionId, op.payload.snapshotId, op.id, worldIsOnline(instance.installPath), 'caves')
        const caveResult = await maintenanceDependencies.send(instance.id, caveCommand, 'caves')
        if (!caveResult.ok) throw new Error(caveResult.message ?? '洞穴回档发送结果未确认，请检查实际世界')
        const acknowledgement = await maintenanceDependencies.acknowledge(instance.id, 'caves', op.id, after)
        if (acknowledgement === 'rejected') {
          update(instance, op, { commandAttempted: false })
          throw new Error('洞穴正在保存或回档目标已过期，未执行房间回档，请刷新存档点')
        }
        if (acknowledgement !== 'accepted') throw new Error('洞穴回档执行结果未确认，未继续发送地上回档命令，请检查实际世界')
        cavesExecuted = true
      }
      appByOperation.get(op.id)?.log.info({ instanceId: instance.id, operationId: op.id, command }, '发送世界维护指令')
      const result = await maintenanceDependencies.send(instance.id, command, shard)
      if (!result.ok) throw new Error(result.message ?? '命令发送结果不确定，请检查实际世界')
      // 拒绝标记是明确的未执行证据；其他情况下不能假定失败并自动再次发送。
      const acknowledgement = await maintenanceDependencies.acknowledge(instance.id, shard, op.id, after)
      if (acknowledgement === 'rejected') {
        if (!cavesExecuted) update(instance, op, { commandAttempted: false })
        throw new Error(cavesExecuted ? '洞穴已回档，地上正在保存或目标已过期；房间回档结果未确认，请检查实际世界' : '游戏正在保存或回档目标已过期，未执行回档，请刷新存档点')
      }
      if (acknowledgement !== 'accepted') throw new Error('维护指令执行结果未确认，请检查实际世界；不会自动重发')
    }
    else {
      // 删除前再次核验运行时；实际文件清理只允许所有分片停止时进行。
      if (await preflight(instance, op) !== 'stopped') throw new Error('实例运行状态已改变，已停止存档清理')
      update(instance, op, { commandAttempted: true })
      for (const shard of op.shards) removeShardSaveDir(instance.installPath, shard)
      update(instance, op, { phase: 'starting' })
      await maintenanceDependencies.start(appByOperation.get(op.id)!, instance.id)
    }
    if (op.action !== 'rollback') for (const shard of op.shards) markObservedWorldSeedStale(instance.installPath, shard)
    await verify(instance, op)
  })
}
const appByOperation = new Map<string, FastifyInstance>()
function launch(app: FastifyInstance, instance: ResolvedLocalDstInstance, op: MaintenanceCheckpoint, recovering = false): void {
  if (runners.has(op.id)) return
  appByOperation.set(op.id, app)
  const runner = execute(instance, op, recovering).catch(async (error) => {
    let message = errorMessage(error)
    try { if (op.configChanged && !op.commandAttempted) await withInstanceContentOperation(instance.id, () => restoreConfig(instance, op)) }
    catch (restoreError) { message += `；恢复生成配置失败：${errorMessage(restoreError)}` }
    if (op.state !== 'cancelled') update(instance, op, { state: op.commandAttempted && op.action !== 'save' && op.phase !== 'starting' ? 'unknown' : 'failed', phase: 'finished', canContinue: false, message })
  }).finally(() => { audit(op); runners.delete(op.id); appByOperation.delete(op.id) })
  runners.set(op.id, runner)
}
export function beginWorldMaintenance(input: {
  app: FastifyInstance, instance: ResolvedLocalDstInstance, actor: AuthorizedUser, payload: WorldMaintenancePayload, legacyShard?: ShardId,
}): WorldMaintenanceOperation {
  const { app, instance, actor, payload } = input
  const records = maintenanceRecords(instance.installPath)
  const duplicate = records.find(op => op.requestId === payload.requestId)
  if (duplicate) {
    if (duplicate.actorId !== actor.id || JSON.stringify(duplicate.payload) !== JSON.stringify(payload)) throw new Error('请求 ID 已用于其他参数或操作人，请重新发起')
    return publicMaintenance(duplicate)
  }
  if (records.some(op => isPendingMaintenance(op) || op.state === 'unknown')) throw new Error('该实例有执行中或结果未确认的维护操作，请先查看并核验操作结果')
  if ((payload.action === 'reset' || payload.action === 'regenerate') && payload.confirmName.trim() !== instance.name.trim()) throw new Error('二次确认失败：请输入完整的实例名称')
  const scope = payload.action === 'regenerate' || input.legacyShard ? 'shard' : 'cluster'
  const now = new Date().toISOString()
  const op: MaintenanceCheckpoint = { id: randomUUID(), requestId: payload.requestId, instanceId: instance.id, action: payload.action, scope,
    shards: scope === 'cluster' ? configuredWorldShards(instance.installPath) : [payload.action === 'regenerate' ? payload.shard : input.legacyShard!],
    state: 'running', phase: 'preparing', startedAt: now, updatedAt: now, deadlineAt: null, confirmationExpiresAt: null,
    backupId: null, backupWarning: null, backupSkipped: !payload.backupBefore, message: null, canContinue: false,
    targetSnapshotId: payload.action === 'rollback' ? payload.snapshotId : null, targetWorldDay: null,
    payload, actorId: actor.id, actorAccount: actor.account, baseline: {}, commandAttempted: false, configChanged: false, previousSeed: null }
  if (payload.action === 'rollback') op.targetWorldDay = target(instance, op)!.worldDay
  persistMaintenance(instance.installPath, op)
  launch(app, instance, op)
  return publicMaintenance(op)
}
export function continueWorldMaintenance(_instance: ResolvedLocalDstInstance, op: MaintenanceCheckpoint, withoutBackup: boolean): WorldMaintenanceOperation {
  if (op.state !== 'awaiting_confirmation' || !op.confirmationExpiresAt || Date.parse(op.confirmationExpiresAt) <= Date.now()) throw new Error('不备份确认已失效，请重新发起操作')
  const confirm = confirmations.get(op.id)
  if (!confirm) throw new Error('正在恢复维护操作，请稍后再确认')
  confirm(withoutBackup)
  return publicMaintenance(op)
}
export function recoverWorldMaintenance(app: FastifyInstance, instance: ResolvedLocalDstInstance): void {
  for (const op of maintenanceRecords(instance.installPath)) if (isPendingMaintenance(op)) launch(app, instance, op, true)
}
export function recheckWorldMaintenance(app: FastifyInstance, instance: ResolvedLocalDstInstance, op: MaintenanceCheckpoint): WorldMaintenanceOperation {
  if (op.state !== 'unknown' || op.action === 'save') throw new Error('此操作无法重新核验；保存确认丢失时请检查存档点')
  update(instance, op, { state: 'running', phase: 'verifying', deadlineAt: new Date(Date.now() + resolveInstanceResourceSettings(instance.resourceConfig).shardReadyWaitSec * configuredWorldShards(instance.installPath).length * 1000).toISOString() })
  launch(app, instance, op, true)
  return publicMaintenance(op)
}
export async function waitWorldMaintenanceForTest(id: string): Promise<void> { await runners.get(id) }
