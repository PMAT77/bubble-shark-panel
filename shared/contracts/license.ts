import { z } from 'zod'

/**
 * Pro 授权的离线许可文件。
 *
 * 设计约束（来自 `docs_local/ARCHITECTURE.md` 的 Open-Core 边界，改动前先读那一节）：
 *
 * 1. **Community 核心能力不因授权缺失而下降**：许可只影响 Pro 插件的可用性；
 *    许可无效、过期或文件缺失时，**绝不停止正在运行的游戏实例**。
 * 2. **离线可用**：许可是一个带签名的 JSON 文件，不需要联网校验，也不需要授权服务器。
 * 3. **签名先于一切**：载荷用 Ed25519 验签，核心只内置公钥；私钥只存在于发布方的离线环境。
 * 4. **设备绑定可选**：`fingerprint` 为空表示不绑定机器（便于客户更换服务器与迁移）；
 *    填写后只有指纹一致才生效，适用于按机器计价的场景。
 *
 * 载荷与签名的分界：`payload` 里的每个字段都受签名保护，`signature` 是载荷的 Ed25519 签名
 * （对 `canonicalizeLicensePayload(payload)` 的 UTF-8 字节）。任何字段被改动都会验签失败。
 */

/** 授权能力标识：与 Pro 插件的 capabilities 对应，由发布方在签发时写入 */
export const licenseCapabilitySchema = z.enum([
  'multi-node',
  'audit-log',
  'remote-backup',
  'advanced-rbac',
])
export type LicenseCapability = z.infer<typeof licenseCapabilitySchema>

export const licensePayloadSchema = z.object({
  /** 许可格式版本：将来变更载荷结构时递增，旧核心拒绝新格式而不是误读 */
  version: z.literal(1),
  /** 客户标识（账号、公司或群昵称），仅用于面板显示与对账 */
  customer: z.string().trim().min(1).max(120),
  /** 授权能力清单；空数组表示这是一份无效授权（签发工具会拒绝生成） */
  capabilities: z.array(licenseCapabilitySchema).min(1),
  /** 签发时间（ISO 8601） */
  issuedAt: z.string().trim().min(1),
  /** 到期时间（ISO 8601）；为 null 表示永久授权 */
  expiresAt: z.string().trim().min(1).nullable(),
  /**
   * 设备指纹；null 或省略表示不绑定机器。
   * 绑定时必须与运行机器的 `resolveMachineFingerprint()` 完全一致。
   */
  fingerprint: z.string().trim().min(1).max(128).nullable().optional(),
  /** 可选的备注（订单号、渠道等），仅用于人工对账 */
  note: z.string().trim().max(200).optional(),
})
export type LicensePayload = z.infer<typeof licensePayloadSchema>

export const licenseFileSchema = z.object({
  payload: licensePayloadSchema,
  /** 载荷签名的 base64（Ed25519，64 字节） */
  signature: z.string().trim().min(1),
})
export type LicenseFile = z.infer<typeof licenseFileSchema>

/**
 * 许可的判定结果。`status` 的语义：
 * - `none`：没有许可文件（Community 常态，不是错误）；
 * - `invalid`：文件存在但格式错误、验签失败或设备不匹配；
 * - `expired`：验签通过但已过期；
 * - `active`：验签通过且未过期。
 */
export const licenseStatusSchema = z.enum(['none', 'invalid', 'expired', 'active'])
export type LicenseStatus = z.infer<typeof licenseStatusSchema>

export const licenseStateSchema = z.object({
  status: licenseStatusSchema,
  /** 面向用户的一句话说明；`none` 时说明「核心功能不受影响」 */
  message: z.string(),
  /** 当前生效的能力清单：只有 status 为 active 时才可能非空 */
  capabilities: z.array(licenseCapabilitySchema),
  customer: z.string().nullable(),
  issuedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  /** 是否绑定了机器（用于界面提示「换机器需要重新签发」） */
  bound: z.boolean(),
  /** 距离到期的天数；永久授权或未生效时为 null */
  daysRemaining: z.number().int().nullable(),
})
export type LicenseState = z.infer<typeof licenseStateSchema>

/**
 * 载荷的规范化形式，签名与验签共用。
 *
 * 为什么不能直接 `JSON.stringify(payload)`：对象键顺序取决于构造方式，签发工具与核心
 * 若各自拼 JSON，就会出现「同一份载荷、两种字节、验签随机失败」。这里统一为
 * **按键名排序、无多余空白** 的确定性序列化，签名方与验签方都调这一个函数。
 *
 * 还需处理的第二种不确定性：可选字段「缺失」与「显式为 null」在 JSON 里是两种字节。
 * `fingerprint` 恰恰是这种字段（schema 上 `.nullable().optional()`），签发工具写 null、
 * 手写文件或程序化构造时又可能整个省略——所以这里把缺失补成 null，让两种写法等价。
 */
export function canonicalizeLicensePayload(payload: LicensePayload): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(normalize)
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      return Object.fromEntries(entries.map(([key, item]) => [key, normalize(item)]))
    }
    return value
  }
  const normalized = normalize({
    ...payload,
    fingerprint: payload.fingerprint ?? null,
  }) as Record<string, unknown>
  return JSON.stringify(normalized)
}
