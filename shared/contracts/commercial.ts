import { z } from 'zod'
import { licenseStateSchema } from './license'

/**
 * 商业支持与 Pro 计划（只读）。
 *
 * 为什么需要这个接口：面板的使用者（服主、托管商）看不到仓库，也无从判断
 * 「panel.env 里的 BSP_EDITION」是什么意思、能不能买到 Pro、出了问题找谁。
 * 这里把三件事在一次请求里说清楚，且**全部只读**：
 *
 * 1. 当前版本与版本形态（community / pro）；
 * 2. 核心能力永远免费，Pro 能力**未开发、无时间表**——界面不能暗示它可用；
 * 3. 可选的付费人工服务（代搭建、迁移、私有化部署等）与联系方式。
 *
 * 面板内不内嵌任何支付或下单能力：收款与合同走面板之外的人工流程，
 * 避免把「商业支持」做成一个没法对账的按钮。
 */

export const commercialServiceItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 交付物一句话，措辞与 README「赞助与商业合作」一致 */
  detail: z.string(),
  /** 参考价格区间，例如「50～200 元/次」 */
  priceRange: z.string(),
})

export type CommercialServiceItem = z.infer<typeof commercialServiceItemSchema>

export const commercialProItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  detail: z.string(),
})

export type CommercialProItem = z.infer<typeof commercialProItemSchema>

export const commercialSupportSchema = z.object({
  releaseVersion: z.string(),
  /** 版本形态；当前只可能取 community，pro 是授权机制落地后的预留 */
  edition: z.string(),
  /** 核心能力是否免费：恒为 true，写出来是为了让前端不必猜 */
  coreFree: z.boolean(),
  /** Pro 版本目前的状态说明，会直接显示在界面上 */
  proStatus: z.string(),
  /** 当前节点是否已获得 Pro 授权（由本地许可文件离线验签得出） */
  proLicensed: z.boolean(),
  /** 许可详情：未安装许可时为 community 常态的说明，不是错误 */
  license: licenseStateSchema,
  services: z.array(commercialServiceItemSchema),
  proCapabilities: z.array(commercialProItemSchema),
  /** 付费服务的不含项，交付前先讲清楚 */
  exclusions: z.array(z.string()),
  contact: z.object({
    wechat: z.string(),
    qqGroup: z.string(),
    /**
     * 可选的外部订阅入口（例如飞书表单/客服链接）。
     *
     * 为什么做成可配置而不是写死：渠道会换、会失效，写死的链接一旦挂掉，
     * 用户点「订阅」只会得到一个打不开的页面，而面板里没有任何信息能解释为什么。
     * 为空时界面回落到微信与 QQ 群，行为与引入这个字段之前完全一致。
     */
    feishu: z.string(),
    repository: z.string(),
    /** 添加微信时的备注建议格式 */
    noteHint: z.string(),
  }),
  /** 一句提醒：赞助不等于购买 */
  sponsorNote: z.string(),
})

export type CommercialSupport = z.infer<typeof commercialSupportSchema>
