import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  GUEST_MODE_NOTICE_CONTENT,
  GUEST_MODE_NOTICE_TITLE,
  guestModeNoticeDismissKey,
  shouldShowGuestModeNotice,
} from './guestModeNotice.ts'

/**
 * 游客模式提示。
 *
 * 这是纯逻辑，通知本身弹不弹由边界决定：**只有游客角色、已登录、且没关过、
 * 也没正在显示**四条同时成立才提示。少任何一条都会变成"提示刷屏"或"该提示时不提示"。
 */
describe('游客模式提示', () => {
  it('文案说清了「只能查看」和「入口被隐藏」', () => {
    assert.ok(GUEST_MODE_NOTICE_TITLE.includes('游客'), '标题要点明是游客模式')
    assert.ok(GUEST_MODE_NOTICE_CONTENT.includes('只能查看'), '要说明只能查看')
    assert.ok(GUEST_MODE_NOTICE_CONTENT.includes('隐藏'), '要说明操作入口被隐藏了')
    assert.ok(GUEST_MODE_NOTICE_CONTENT.includes('成员管理'), '要给出下一步能找谁')
  })

  it('「关过」的记录按账号分开，空账号不给键', () => {
    assert.notEqual(guestModeNoticeDismissKey('alice'), guestModeNoticeDismissKey('bob'))
    assert.match(guestModeNoticeDismissKey('alice'), /alice/)
    assert.equal(guestModeNoticeDismissKey('   '), '', '账号为空时不该写出全局键')
  })

  it('只有游客角色、已登录、没关过、也没在显示时才提示', () => {
    const base = {
      isLogin: true,
      roleKind: 'guest' as const,
      dismissed: false,
      alreadyShown: false,
    }
    assert.equal(shouldShowGuestModeNotice(base), true, '游客身份进来就该提示')
    assert.equal(shouldShowGuestModeNotice({ ...base, roleKind: 'user' }), false, '自建角色不提示')
    assert.equal(shouldShowGuestModeNotice({ ...base, roleKind: null }), false, '角色未知时不提示')
    assert.equal(shouldShowGuestModeNotice({ ...base, isLogin: false }), false, '没登录不提示')
    assert.equal(shouldShowGuestModeNotice({ ...base, dismissed: true }), false, '关过一次就不再烦')
    assert.equal(shouldShowGuestModeNotice({ ...base, alreadyShown: true }), false, '屏幕上已经有就不重复弹')
  })
})
