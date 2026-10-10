import { AsyncLocalStorage } from 'node:async_hooks'
/** 内部注入请求的来源不接受 HTTP 字段，客户端不能伪装调用来源。 */
export const instanceStartSource = new AsyncLocalStorage<'manual' | 'automatic'>()
