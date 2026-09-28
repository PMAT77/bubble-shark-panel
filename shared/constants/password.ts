/**
 * 密码强度规则（前后端共用）。
 *
 * 为什么单独抽出来：**改密**与**管理员建号 / 重置密码**是两条独立的代码路径。
 * 各自写一份正则迟早会漂，而漂移的表现很隐蔽：管理员能给子账号设一个
 * 「用户自己改不回来」的弱密码（改密时被强度校验拦住），或者反过来——
 * 建号时被拦住而改密放行。放在这里，两边引用同一份判定与同一句提示。
 */

/** 规则的一句话说明，用于拼提示文案 */
export const PASSWORD_POLICY_HINT = '8-64 位，且包含大小写字母、数字和特殊字符'

/** 完整提示（改密场景用「新密码」措辞） */
export const PASSWORD_POLICY_MESSAGE = `密码必须为 ${PASSWORD_POLICY_HINT}`

/** 至少 8 位，且包含大小写字母、数字与特殊字符 */
export function isStrongPassword(password: string): boolean {
  return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,64}$/.test(password)
}
