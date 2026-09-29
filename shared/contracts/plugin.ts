import { z } from 'zod'
import { licenseCapabilitySchema } from './license'

/**
 * 插件清单与宿主契约。
 *
 * 边界（与 `docs_local/ARCHITECTURE.md` 的 Open-Core 一节一致，改动前先读）：
 *
 * 1. **核心不依赖插件**：没有任何插件时，Community 的全部能力照常可用。
 * 2. **插件进程外运行**：插件是独立进程，通过本机回环 HTTP 与宿主通信。
 *    插件崩溃、挂死或版本不兼容，都不影响核心，更不影响正在运行的游戏实例。
 * 3. **能力必须显式声明**：插件要用什么（读实例、管生命周期、读日志…）写在清单里，
 *    宿主只授予声明过的能力；未声明即拒绝，而不是"先跑起来再说"。
 * 4. **商业插件必须带签名**：`commercial` 类型的插件缺少或伪造签名时拒绝加载；
 *    社区插件可以不签名，但宿主会把"未签名"如实显示给管理员。
 */

/**
 * 插件类型。
 * - `community`：第三方或自用插件，可不签名；
 * - `commercial`：随 Pro 授权交付的插件，必须有有效签名，且需要授权文件里有对应能力。
 */
export const pluginKindSchema = z.enum(['community', 'commercial'])
export type PluginKind = z.infer<typeof pluginKindSchema>

/**
 * 插件可申请的能力（宿主授予的最小权限集合）。
 * 命名用「资源:动作」，与面板自身的权限点风格一致，便于管理员理解。
 */
export const pluginCapabilitySchema = z.enum([
  /** 读取实例列表与状态 */
  'instances:read',
  /** 启停重启实例（危险：会影响线上玩家） */
  'instances:lifecycle',
  /** 读取控制台日志与历史 */
  'console:read',
  /** 下发控制台命令（危险） */
  'console:write',
  /** 读取主机与实例指标 */
  'metrics:read',
  /** 读取备份列表并触发备份 */
  'backups:read',
  'backups:write',
  /** 删除备份（保留策略需要，属危险操作） */
  'backups:delete',
  /** 在宿主面板内注册自己的页面入口 */
  'ui:panel',
  /** 使用宿主提供的键值存储（插件自己的数据） */
  'storage:kv',
  /** 发起外部网络请求（用于对象存储、告警平台等） */
  'network:outbound',
  /** 读取面板的用户操作审计（谁在什么时候改了什么） */
  'operations:read',
])
export type PluginCapability = z.infer<typeof pluginCapabilitySchema>

/** 危险能力：管理员启用时需要额外确认 */
export const DANGEROUS_PLUGIN_CAPABILITIES: readonly PluginCapability[] = [
  'instances:lifecycle',
  'console:write',
  'backups:write',
  'backups:delete',
  'network:outbound',
]

export function isDangerousPluginCapability(capability: PluginCapability): boolean {
  return DANGEROUS_PLUGIN_CAPABILITIES.includes(capability)
}

/** 插件标识：小写字母开头，允许小写字母、数字与连字符，长度 3～64 */
export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{2,63}$/
/** 语义化版本（允许预发布后缀），宿主与插件的兼容判断都基于它 */
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export const pluginManifestSchema = z.object({
  id: z.string().regex(PLUGIN_ID_PATTERN, '插件标识需为小写字母、数字与连字符，且以字母开头'),
  name: z.string().trim().min(1).max(80),
  version: z.string().regex(SEMVER_PATTERN, '插件版本需为语义化版本，如 1.0.0'),
  /** 插件所面向的宿主 API 版本；与宿主当前 API 不兼容时拒绝加载 */
  apiVersion: z.number().int().positive(),
  kind: pluginKindSchema,
  /** 可执行入口，相对于插件目录；打包时由发布方写入 */
  entry: z.string().trim().min(1).max(200),
  capabilities: z.array(pluginCapabilitySchema).max(16),
  description: z.string().trim().max(400).optional(),
  author: z.string().trim().max(120).optional(),
  /** 许可提示（例如「商业授权」），仅用于管理员界面显示 */
  license: z.string().trim().max(120).optional(),
  /** 插件自带的、需要宿主显示的说明（如「需要 Pro 授权」） */
  requiresLicense: z.boolean().optional(),
})
export type PluginManifest = z.infer<typeof pluginManifestSchema>

// ---------------------------------------------------------------------------
// API 版本兼容
// ---------------------------------------------------------------------------

/**
 * 宿主当前实现的插件 API 版本。
 *
 * 递增规则：只在**破坏性**变更时 +1（移除或改变已有能力语义）。
 * 只增能力（新方法、新可选字段）时不递增，老插件继续可用。
 */
export const PLUGIN_HOST_API_VERSION = 1

export type PluginApiCompatibility
  = | { ok: true }
  | { ok: false, message: string }

/**
 * 判断插件与宿主的 API 是否兼容。
 *
 * 刻意不做「向后兼容 N 个版本」的模糊策略：插件是进程外运行的，宿主无法替它兜住
 * 缺失的接口。声明版本不等于宿主版本就直接拒绝，并给出明确原因——
 * 「装了但静默失效」比「装不上」难排查得多。
 */
export function checkPluginApiCompatibility(
  manifestApiVersion: number,
  hostApiVersion: number = PLUGIN_HOST_API_VERSION,
): PluginApiCompatibility {
  if (manifestApiVersion === hostApiVersion) {
    return { ok: true }
  }
  if (manifestApiVersion < hostApiVersion) {
    return {
      ok: false,
      message: `插件面向的接口版本 ${manifestApiVersion} 低于当前面板的 ${hostApiVersion}：请更新插件。`,
    }
  }
  return {
    ok: false,
    message: `插件需要的接口版本 ${manifestApiVersion} 高于当前面板的 ${hostApiVersion}：请先升级面板。`,
  }
}

// ---------------------------------------------------------------------------
// 签名
// ---------------------------------------------------------------------------

/**
 * 商业插件签名文件（`plugin.signature.json`）。
 *
 * 为什么签名对象是清单而不是整个压缩包：tar.gz 的字节会因打包工具与时间戳变化，
 * 对包体签名会让「同一份内容、两次打包」无法复现。而清单里已经包含 id、version、
 * apiVersion、capabilities 等**全部授权相关的字段**，签清单等价于签授权；
 * 包体完整性由发布方的 `.sha256` 负责（与面板自身的发布纪律一致）。
 */
export const pluginSignatureSchema = z.object({
  version: z.literal(1),
  pluginId: z.string().regex(PLUGIN_ID_PATTERN),
  /** 发布方标识（例如 gsh-official），便于区分第三方签名 */
  publisher: z.string().trim().min(1).max(80),
  /** 签发时间（ISO 8601） */
  signedAt: z.string().trim().min(1),
  /** 对规范化后的清单 JSON 的 Ed25519 签名（base64） */
  signature: z.string().trim().min(1),
})
export type PluginSignature = z.infer<typeof pluginSignatureSchema>

/**
 * 清单的规范化形式，签名与验签共用。
 *
 * 与授权许可同一套做法（见 `shared/contracts/license.ts` 的 `canonicalizeLicensePayload`）：
 * 按键名排序、剔除 `undefined`，保证「同一份清单、两种字节、验签随机失败」不会发生。
 */
export function canonicalizePluginManifest(manifest: PluginManifest): string {
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
  return JSON.stringify(normalize(manifest))
}

// ---------------------------------------------------------------------------
// 宿主侧状态
// ---------------------------------------------------------------------------

/**
 * 插件在宿主里的状态。
 * - `ready`：清单、签名、版本、能力都通过，且已启用，可以启动；
 * - `disabled`：装载通过但被管理员停用；
 * - `invalid`：装载失败（清单错误、签名无效、版本不兼容等），`message` 说明原因；
 * - `missing_license`：商业插件，但当前授权不含它需要的能力。
 */
export const pluginStateSchema = z.enum(['ready', 'disabled', 'invalid', 'missing_license'])
export type PluginState = z.infer<typeof pluginStateSchema>

// ---------------------------------------------------------------------------
// 插件商店（货架）
// ---------------------------------------------------------------------------

/**
 * 商店卡片的来源说明。三态刻意分开，因为它们对用户意味着完全不同的下一步：
 *
 * - `bundled`：随面板分发，本机却检测不到 —— 属于异常，需要提示重新安装面板；
 * - `obtainable`：已有实现，通过面板之外的渠道获取插件包 —— 唯一能给出「订阅」入口的一态；
 * - `planned`：尚未开发 —— **不得**出现任何订阅或获取入口，否则就是虚假承诺。
 *
 * 这个枚举是「不暗示 Pro 可用」那条纪律在类型层面的落点：文案纪律有测试钉住，
 * 而状态本身让界面无法在 planned 上错放按钮。
 */
export const pluginStoreAccessSchema = z.object({
  state: z.enum(['bundled', 'obtainable', 'planned']),
  label: z.string(),
  detail: z.string(),
})
export type PluginStoreAccess = z.infer<typeof pluginStoreAccessSchema>

/**
 * 官方插件目录里的一条。
 *
 * 为什么需要一份静态目录而不是只靠本地扫描：空插件目录时，用户看不到任何东西，
 * 也就无从知道「有什么可装、在哪拿」——那是商店页最该回答的问题。
 * 目录只描述**官方插件**，用户自装的第三方插件不在其中（它们以本地扫描为准）。
 */
export const pluginStoreEntrySchema = z.object({
  id: z.string().regex(PLUGIN_ID_PATTERN),
  name: z.string().trim().min(1).max(80),
  /** 发布方标识；与插件签名里的 publisher 对得上，用户据此判断来源 */
  publisher: z.string().trim().min(1).max(80),
  /** 卡片上的一句话 */
  summary: z.string().trim().min(1).max(200),
  /** 详情弹窗里的完整说明 */
  detail: z.string().trim().min(1).max(600),
  /** 该插件会申请哪些宿主能力（用于卡片上的能力标签与风险提示） */
  requiredCapabilities: z.array(pluginCapabilitySchema),
  /** 需要哪一项商业授权；null 表示无需授权 */
  requiredLicense: licenseCapabilitySchema.nullable(),
  access: pluginStoreAccessSchema,
})
export type PluginStoreEntry = z.infer<typeof pluginStoreEntrySchema>

export const pluginListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  apiVersion: z.number().int(),
  kind: pluginKindSchema,
  state: pluginStateSchema,
  enabled: z.boolean(),
  /** 需要用户注意的状态或错误说明（装载失败原因、缺哪个授权能力、进程侧错误）；一切正常时为空串 */
  message: z.string(),
  capabilities: z.array(pluginCapabilitySchema),
  /** 是否声明了危险能力（界面需要额外提示） */
  hasDangerousCapabilities: z.boolean(),
  /** 是否带（且通过了）签名验证 */
  signed: z.boolean(),
  publisher: z.string().nullable(),
  description: z.string().nullable(),
  author: z.string().nullable(),
  /** 插件目录名（相对插件根目录）；invalid 时也给出，便于人工排查 */
  directory: z.string(),
  /** 进程运行状态；宿主未管理进程（如装载失败）时为 stopped */
  runtime: z.object({
    /**
     * `finished` 专指插件以退出码 0 正常结束（一次性任务跑完）。
     * 它与 `crashed` 分开：前者宿主不会重启（否则跑完就退的插件会被无限拉起），
     * 后者会按退避策略重启，超过上限停在 `crashed`。
     */
    state: z.enum(['stopped', 'starting', 'running', 'finished', 'crashed']),
    pid: z.number().int().nullable(),
    startedAt: z.string().nullable(),
    /** 连续异常退出次数；成功启动后清零 */
    restarts: z.number().int().nonnegative(),
    /** 最近一次失败原因（启动失败、非零退出、被信号终止） */
    lastError: z.string().nullable(),
  }),
  /**
   * 本机插件目录里是否真的装着它。
   *
   * 可选是为了向后兼容：老调用方（例如只做本地扫描的测试）不传时按「已安装」理解，
   * 因为列表接口在引入商店之前返回的每一项都来自本地目录。
   */
  installed: z.boolean().optional(),
  /**
   * 商店卡片用的产品文案，来自官方目录（`server/src/plugins/store-catalog.ts`）。
   *
   * 为什么不复用清单里的 `description`：那个字段由插件自己写、不受我们控制，
   * 而卡片上这几句话是对客户的交付承诺，必须由发布方统一给。
   * 用户自装的第三方插件没有目录条目，这里为 null，界面回落到 `description`。
   */
  store: z.object({
    summary: z.string(),
    detail: z.string(),
    access: pluginStoreAccessSchema,
    /** 这项能力要哪一份商业授权；null 表示不需要授权 */
    requiredLicense: licenseCapabilitySchema.nullable(),
    /**
     * 当前许可是否已覆盖它需要的授权。
     *
     * 为什么需要这个字段：许可（`license.json`）与插件包是两件分开交付的东西，
     * 「已经买过、只是还没导入插件包」是人工交付链路上最常见的中间态。
     * 没有这个判断，「买过没装」会被界面说成「未获取」，
     * 用户会以为面板不认识他那笔购买，然后再买一次。
     *
     * 可选：未安装的条目由服务端算好给出；已安装的条目省略（其授权结论已经
     * 体现在 `state` 是否为 `missing_license` 上，界面不必再算一遍）。
     */
    licenseSatisfied: z.boolean().optional(),
  }).nullable().optional(),
})
export type PluginListItem = z.infer<typeof pluginListItemSchema>

export const pluginListResultSchema = z.object({
  /** 宿主当前实现的插件 API 版本，便于排查「插件太新/太旧」 */
  hostApiVersion: z.number().int(),
  /** 插件根目录绝对路径（管理员要往里放插件时需要知道） */
  pluginsRoot: z.string(),
  items: z.array(pluginListItemSchema),
  /**
   * 货架区的口径说明，例如「这里只列官方插件；付款与合同都在面板之外」。
   * 由服务端统一给：同一句话在多个组件里各写一遍，迟早会互相矛盾。
   */
  storeNotice: z.string(),
})
export type PluginListResult = z.infer<typeof pluginListResultSchema>

// ---------------------------------------------------------------------------
// 插件包导入
// ---------------------------------------------------------------------------

/**
 * 导入的第一步：上传包并校验，返回给用户确认。
 *
 * 分成两步是有意的——「这个包是谁签的、装完还缺哪项授权」必须出现在用户点确认之前，
 * 而不是落盘之后。`uploadId` 是服务端签发的 UUID，第二步凭它继续，
 * 不必让用户把同一个文件再传一遍。
 */
export const pluginPackageAnalysisSchema = z.object({
  pluginId: z.string(),
  name: z.string(),
  version: z.string(),
  apiVersion: z.number().int(),
  /** 是否带（且通过了）签名验证 */
  signed: z.boolean(),
  publisher: z.string().nullable(),
  capabilities: z.array(pluginCapabilitySchema),
  hasDangerousCapabilities: z.boolean(),
  /** 装完还缺哪项授权；null 表示不缺。命名用 gap 而不是 hasLicense，避免把「有包没许可」误读成错误 */
  requiredLicenseGap: z.string().nullable(),
})
export type PluginPackageAnalysis = z.infer<typeof pluginPackageAnalysisSchema>

export const pluginImportInspectResultSchema = z.object({
  uploadId: z.string(),
  analysis: pluginPackageAnalysisSchema,
})
export type PluginImportInspectResult = z.infer<typeof pluginImportInspectResultSchema>

export const pluginImportRequestSchema = z.object({
  /** 第一步返回的 uploadId（服务端签发的 UUID） */
  uploadId: z.string().trim().min(1).max(64),
})
export type PluginImportRequest = z.infer<typeof pluginImportRequestSchema>

/**
 * 导入的最终结果。
 *
 * `state` 直接复用 `pluginStateSchema`，让「导进来的包现在是什么状态」与列表里的状态
 * 用同一套语义：导入成功不等于能启用（商业插件还缺授权时是 `missing_license`），
 * 界面据此就能说清「已导入，但还需要某个授权」，而不是给一个含糊的「导入成功」。
 */
export const pluginImportResultSchema = z.object({
  pluginId: z.string(),
  name: z.string(),
  version: z.string(),
  apiVersion: z.number().int(),
  /** 是否带（且通过了）签名验证 */
  signed: z.boolean(),
  publisher: z.string().nullable(),
  capabilities: z.array(pluginCapabilitySchema),
  hasDangerousCapabilities: z.boolean(),
  state: pluginStateSchema,
  /** 面向用户的一句话结论（缺哪个授权、下一步做什么） */
  message: z.string(),
  /** 落位后的目录绝对路径，便于管理员排查 */
  directory: z.string(),
})
export type PluginImportResult = z.infer<typeof pluginImportResultSchema>

export const pluginToggleRequestSchema = z.object({
  pluginId: z.string().regex(PLUGIN_ID_PATTERN),
  enabled: z.boolean(),
  /** 启用声明了危险能力的插件时，需要显式确认 */
  acknowledgeDangerous: z.boolean().optional(),
})
export type PluginToggleRequest = z.infer<typeof pluginToggleRequestSchema>

// ---------------------------------------------------------------------------
// 插件调用审计
// ---------------------------------------------------------------------------

/**
 * 一次插件能力调用的留痕。
 *
 * 为什么这件事必须由宿主做、而不是"让插件自己记日志"：插件日志是插件自己写的，
 * 它可以选择不写、写错或事后修改。宿主侧的审计是**对第三方代码的唯一客观记录**，
 * 也是 B 端客户问的第一个问题（「这个插件到底动过什么」）的答案。
 */
export const pluginAuditRecordSchema = z.object({
  id: z.number().int().positive(),
  at: z.string(),
  pluginId: z.string(),
  /** 被调用的能力（宿主 API 权限名） */
  capability: z.string(),
  /** 操作名，例如 lifecycle:stop */
  action: z.string(),
  /** 参数摘要（已剔除令牌、密码等敏感键） */
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  /** ok=已受理；denied=能力未授予；error=执行失败 */
  outcome: z.enum(['ok', 'denied', 'error']),
  /** 失败原因或结果说明 */
  message: z.string().nullable(),
  /** 处理耗时（毫秒） */
  durationMs: z.number().int().nonnegative(),
})
export type PluginAuditRecord = z.infer<typeof pluginAuditRecordSchema>

export const pluginAuditQuerySchema = z.object({
  pluginId: z.string().regex(PLUGIN_ID_PATTERN).optional(),
  /** 查询参数是字符串，这里显式转成数字：手写 Number() 的转换容易漏掉 NaN 与负数 */
  limit: z.coerce.number().int().positive().max(500).optional(),
})
export type PluginAuditQuery = z.infer<typeof pluginAuditQuerySchema>

export const pluginAuditResultSchema = z.object({
  /** 审计文件所在目录，管理员排查时可以直接看原始 NDJSON */
  auditRoot: z.string(),
  records: z.array(pluginAuditRecordSchema),
})
export type PluginAuditResult = z.infer<typeof pluginAuditResultSchema>