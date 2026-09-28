import type { FastifyInstance } from 'fastify'
import type { ApiErrorResponse, ApiSuccessResponse } from '../../../../shared/contracts/api'
import type { CommercialSupport } from '../../../../shared/contracts/commercial'
import process from 'node:process'
import { loadServerConfig } from '../../shared/config'
import { readLicenseState } from '../../shared/license'
import { SYSTEM_READ_PERMISSION } from '../../shared/menu-routes'
import { success } from '../../shared/http/response'
import { requirePermission } from './auth'

/**
 * Pro 能力的真实状态。界面文案由这里统一给，避免各处自己写。
 *
 * 措辞必须与交付现状一致：插件宿主、操作审计与异地备份已经能跑，
 * 但**还没有随包发布的插件**，客户拿到的面板里不会自带这些能力。
 * 写"已交付"会让人以为装上面板就有，写"尚未开发"又与仓库现状不符——所以分开说。
 */
const PRO_STATUS = '均尚未随包发布'

const PRO_CAPABILITIES: CommercialSupport['proCapabilities'] = [
  { id: 'multi-node', name: '多节点统一管理', detail: '一个面板管多台服务器的实例、日志与批量操作（开发中）' },
  { id: 'audit-log', name: '操作审计日志', detail: '谁在什么时候改了房间、重启了世界，可查询可导出（待随包发布）' },
  { id: 'remote-backup', name: '异地与云备份', detail: '把存档备份到对象存储或另一台服务器，支持定时与保留策略（待随包发布）' },
  { id: 'advanced-rbac', name: '高级权限与角色', detail: '角色模板、组织与租户、按实例归属隔离，供托管商与多团队场景（开发中）' },
]

/** 付费服务清单：与仓库 README「赞助与商业合作」一节同源，改一处必须同步另一处 */
const SERVICES: CommercialSupport['services'] = [
  {
    id: 'setup',
    name: '单机代搭建',
    detail: '装面板、建实例、世界能进，附端口与安全组清单和一份交接说明',
    priceRange: '50～200 元/次',
  },
  {
    id: 'migration',
    name: '存档与面板迁移',
    detail: '从旧机器或旧面板迁走存档、集群配置、Mod 与端口，迁完能进服，并给一份回滚包',
    priceRange: '150～400 元/次',
  },
  {
    id: 'private-deploy',
    name: '私有化部署',
    detail: '内网、代理受限或无公网环境的部署与反向代理，含离线安装包与校验流程',
    priceRange: '500～1000 元/次',
  },
  {
    id: 'custom',
    name: '功能定制开发',
    detail: '按你的玩法或运营需求做专属功能，交付形式按需求商定',
    priceRange: '1500～10000 元/项目',
  },
]

const EXCLUSIONS = [
  '不代买、不代付、不代办云厂商账号',
  '不改动游戏本体与官方接口；接口变更导致的适配按新工作量另算',
  'Windows 上开服与多用户权限隔离不在服务范围',
]

const SPONSOR_NOTE = '赞助是心意，不等同于购买 Pro 授权、故障处理时限或一对一支持。'

export interface CommercialSupportOptions {
  /** 联系方式与仓库地址允许用环境变量覆盖；默认值与 README 保持一致 */
  wechat: string
  qqGroup: string
  /** 外部订阅入口（可空）；为空时界面回落到微信与 QQ 群 */
  feishu: string
  repository: string
}

const DEFAULT_CONTACT: CommercialSupportOptions = {
  wechat: 'PMAT77',
  qqGroup: '1055694763',
  // 默认不给外链：面板里没有下单与支付，默认行为就是给出人工渠道
  feishu: '',
  repository: 'https://github.com/PMAT77/game-serve-hub',
}

/**
 * 联系方式直接读环境变量而不是进 panel.env.example：这三项是可选覆盖，
 * 不写也不影响任何功能，没必要为它们增加一份用户需要理解的配置项
 * （新增 GSH_* 变量会牵动面板配置预设一致性检查的使用面）。
 */
function resolveContact(): CommercialSupportOptions {
  return {
    wechat: process.env.GSH_COMMERCIAL_WECHAT?.trim() || DEFAULT_CONTACT.wechat,
    qqGroup: process.env.GSH_COMMERCIAL_QQ_GROUP?.trim() || DEFAULT_CONTACT.qqGroup,
    feishu: process.env.GSH_COMMERCIAL_FEISHU?.trim() || DEFAULT_CONTACT.feishu,
    repository: process.env.GSH_COMMERCIAL_REPOSITORY?.trim() || DEFAULT_CONTACT.repository,
  }
}

/** 只读的商业支持与 Pro 说明，任何已登录且具备只读权限的账号都能看 */
export function registerCommercialSupportRoutes(app: FastifyInstance): void {
  app.get('/app/system/commercial', async (request): Promise<ApiSuccessResponse<CommercialSupport> | ApiErrorResponse> => {
    const authError = await requirePermission(request, SYSTEM_READ_PERMISSION)
    if (authError) {
      return authError
    }
    const config = loadServerConfig()
    const contact = resolveContact()
    const license = readLicenseState()
    return success({
      releaseVersion: config.releaseVersion,
      // 有生效许可即视为 Pro 形态；没有则照实说 community
      edition: license.status === 'active' ? 'pro' : config.edition,
      coreFree: true,
      proStatus: PRO_STATUS,
      proLicensed: license.status === 'active',
      license,
      services: SERVICES,
      proCapabilities: PRO_CAPABILITIES,
      exclusions: EXCLUSIONS,
      contact: {
        ...contact,
        noteHint: '添加时请备注来意，建议格式：身份 / 需求 / 规模',
      },
      sponsorNote: SPONSOR_NOTE,
    }, request)
  })
}
