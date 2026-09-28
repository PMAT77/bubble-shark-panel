/** 后端菜单 activeMenu 与前端跳转共用的路径（不含 origin） */
export const FRONTEND_ROUTE_PATHS = {
  consoleMonitor: '/console/monitor',
  nodeInstance: '/node/instance',
  dstRooms: '/games/dst/rooms',
  dstPlayers: '/games/dst/players',
  dstWorlds: '/games/dst/worlds',
  dstMods: '/games/dst/mods',
  dstModDetail: '/games/dst/mods/:workshopId/detail',
  opsBackups: '/ops/backups',
  opsSchedules: '/ops-schedule/schedules',
  /** 「系统设置」页：菜单 activeMenu 与页面路径都取它（页内 tab 不再有各自的路由） */
  systemSettings: '/system/settings',
  /** 旧地址别名：只用于把 `/system/notify` 重定向到系统设置页的通知渠道 tab */
  systemNotify: '/system/notify',
  systemCommercial: '/system/commercial',
  /** 「插件」主导航模块（页面路由，不再是系统设置组下的隐藏项） */
  plugins: '/plugins',
  /** 「商业支持与 Pro」主导航模块 */
  commercial: '/commercial',
  /** 「成员与角色」主导航模块下的两个页面 */
  members: '/members',
  membersList: '/members/list',
  roles: '/members/roles',
} as const
