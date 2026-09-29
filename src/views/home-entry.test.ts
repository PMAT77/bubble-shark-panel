import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FRONTEND_ROUTE_PATHS } from '../../shared/constants/frontend-routes.ts'
import { resolveHomeEntryPath } from './home-entry.ts'

const HOME_PATH = '/'

describe('首页 Hero 按钮的目标', () => {
  it('有实例管理权限时进实例管理', () => {
    assert.equal(
      resolveHomeEntryPath({ canReadInstance: true, firstAccessiblePath: '/console/monitor', homePath: HOME_PATH }),
      FRONTEND_ROUTE_PATHS.nodeInstance,
    )
  })

  it('没有实例管理权限时退到第一个可访问模块，而不是一条不存在的路由', () => {
    // 这是报错现场：账号没有 instance:read，nodeInstance 路由从未注册，
    // 按 name 跳转会直接抛 `No match for {"name":"nodeInstance"}`
    assert.equal(
      resolveHomeEntryPath({ canReadInstance: false, firstAccessiblePath: '/console/monitor', homePath: HOME_PATH }),
      '/console/monitor',
    )
  })

  it('一个模块都进不去时不跳转（跳了只会落在 404）', () => {
    assert.equal(
      resolveHomeEntryPath({ canReadInstance: false, firstAccessiblePath: HOME_PATH, homePath: HOME_PATH }),
      null,
    )
  })
})
