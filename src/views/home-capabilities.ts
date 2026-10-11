import type { RouteLocationRaw } from 'vue-router'
import type { PermissionKey } from '../../shared/constants/permissions'
import {
  routeToConsoleMonitor,
  routeToDstModList,
  routeToDstPlayerList,
  routeToDstRoomList,
  routeToDstWorldList,
  routeToNodeInstance,
  routeToOpsBackups,
  routeToOpsSchedules,
} from '@/navigation/game-routes'

/**
 * 首页「核心能力」卡片的数据。
 *
 * 两个约定（有测试钉住，见 `home-capabilities.test.ts`）：
 *
 * 1. **顺序与左侧菜单一致**（监控台 → 实例管理 → 房间 → 世界 → 玩家 → Mod → 备份 → 计划任务）。
 *    主页讲的和菜单里点的应该是同一套顺序，否则用户看完主页回来还要自己重新找一遍。
 * 2. **每张卡片跳到面板内的对应页面**，而不是外链文档——能在面板里完成的事，
 *    不该把用户送到浏览器另一个标签页去读说明。文档入口留在 Hero 区。
 *
 * 「游戏控制台」不是独立菜单项（它挂在实例详情下），因此并入「实例管理」卡片，
 * 保持卡片总数与菜单任务数一致。
 */

export interface CapabilityCard {
  /** 与左侧菜单的任务名一致 */
  name: string
  tagline: string
  route: RouteLocationRaw
  /**
   * 访问该页面需要的权限点，与菜单里该模块的 `auth` 一致；不满足时卡片置灰并说明原因。
   *
   * 只要**模块自己的**读权限：每个模块的列表接口都按它自己的权限放行（房间页 `room:read`、
   * 备份页 `backup:read`…），所以卡片不需要再叠一个「查看实例」。
   */
  permission: PermissionKey
  features: string[]
}

export const HOME_CAPABILITIES: CapabilityCard[] = [
  {
    name: '监控台',
    tagline: '查看服务器负载与运行状况',
    route: routeToConsoleMonitor(),
    permission: 'console.monitor:read',
    features: [
      'CPU、内存、磁盘占用',
      '游戏服务运行状态',
      '实时网络流量',
    ],
  },
  {
    name: '实例管理',
    tagline: '安装、启停和维护游戏实例',
    route: routeToNodeInstance(),
    permission: 'instance:read',
    features: [
      '一键安装与更新游戏服务端',
      '创建、启动、停止实例，随时看运行状态',
      '安装进度与资源占用',
      '多开自动分配端口',
      '实例控制台：实时日志、下发命令、直连信息',
    ],
  },
  {
    name: '房间管理',
    tagline: '设置房间与联机方式',
    route: routeToDstRoomList(),
    permission: 'room:read',
    features: [
      '房间名称、密码与联网方式',
      '玩家人数上限与游戏模式',
      '洞穴分片开关与端口',
      '集群令牌与白名单预留位',
    ],
  },
  {
    name: '世界管理',
    tagline: '可视化编辑地上与洞穴世界',
    route: routeToDstWorldList(),
    permission: 'world:read',
    features: [
      '地上与洞穴两个世界分别配置',
      '地图与规则可视化调整',
      '设置种子、重新生成世界',
      '地形图：导出当前世界地形与关键地标',
    ],
  },
  {
    name: '玩家管理',
    tagline: '查看在线玩家，管理入服名单',
    route: routeToDstPlayerList(),
    permission: 'player:read',
    features: [
      '管理员、白名单、黑名单按游戏名维护',
      '查看地上与洞穴的在线玩家',
      '踢出在线玩家、封禁指定玩家',
      '玩家档案与备注',
    ],
  },
  {
    name: '模组管理',
    tagline: '订阅和配置创意工坊 Mod',
    route: routeToDstModList(),
    permission: 'mod:read',
    features: [
      '创意工坊搜索与订阅',
      '启用、停用与加载顺序调整',
      '单个 Mod 的参数配置',
      '看出哪些 Mod 有新版本',
    ],
  },
  {
    name: '备份与恢复',
    tagline: '备份存档与面板数据',
    route: routeToOpsBackups(),
    permission: 'backup:read',
    features: [
      '存档一键备份与恢复',
      '更新、删除与回档前可先备份',
      '面板数据库快照',
      '导入其他面板或裸机的存档',
    ],
  },
  {
    name: '计划任务',
    tagline: '安排日常维护任务',
    route: routeToOpsSchedules(),
    permission: 'schedule:read',
    features: [
      '定时重启、定时备份',
      '定时检查服务端更新',
      '面板数据库定时快照',
      '错过不补跑，只顺延',
    ],
  },
]
