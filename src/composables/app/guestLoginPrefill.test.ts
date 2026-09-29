import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveGuestLoginPrefill } from './guestLoginPrefill.ts'

/**
 * 「游客登录」的自动填充。
 *
 * 这个文件的全部价值就是**钉住密码永远是空串**。
 *
 * 需求原话是"点击游客登录自动填充账号密码"，而密码那一半做不到也不该做：
 * 游客账号的口令是服务端启动时生成的随机值，从不落盘、从不返回、从不写进前端产物。
 * 一旦有人"顺手把密码也填上"，游客口令就从"不可知"变成"公开在 `dist/` 里"——
 * 而 `dist/` 是公开静态资源，拿到口令后绕开按钮直接调 `/app/account/login` 就能反复用。
 * 所以这里不是形式测试，而是这条设计约束唯一的守卫。
 */
describe('游客登录的自动填充', () => {
  it('只填账号，密码恒为空串', () => {
    const prefill = resolveGuestLoginPrefill({ account: 'guest' })
    assert.equal(prefill.account, 'guest')
    assert.equal(prefill.password, '', '密码必须永远是空串：游客口令不该存在任何客户端副本里')
  })

  it('无论服务端返回什么，密码都不会被填上', () => {
    /**
     * 服务端返回体里本来就不该有密码字段；这里刻意塞一个进去，
     * 断言它也**不会**被带进表单——防止将来有人把 LoginResponse 整体透传。
     */
    const withPassword = { account: 'guest', password: 'leaked-secret', token: 'x' }
    const prefill = resolveGuestLoginPrefill(withPassword as { account: string })
    assert.deepEqual(Object.keys(prefill).sort(), ['account', 'password'])
    assert.equal(prefill.password, '')
  })

  it('服务端没回账号名时退回配置里的展示名', () => {
    assert.equal(resolveGuestLoginPrefill(undefined, 'guest').account, 'guest')
    assert.equal(resolveGuestLoginPrefill({ account: '   ' }, 'guest').account, 'guest')
    assert.equal(resolveGuestLoginPrefill(undefined).account, '', '两个来源都空时不该编出一个账号名')
  })

  it('账号名两端的空白被去掉', () => {
    assert.equal(resolveGuestLoginPrefill({ account: '  guest  ' }).account, 'guest')
  })
})
