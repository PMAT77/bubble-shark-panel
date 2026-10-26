import type {
  ScheduleListRequest,
  ScheduleMutationResult,
  ScheduleRunNowResult,
  ScheduleTaskIdRequest,
  ScheduleTaskItem,
  ScheduleUpdateRequest,
} from '../../../shared/contracts/schedule'
import type { ScheduleCreateRequest } from '../../../shared/contracts/schedule'
import api from '../index'

export type {
  ScheduleCreateRequest,
  ScheduleListRequest,
  ScheduleMutationResult,
  ScheduleRunNowResult,
  ScheduleTaskIdRequest,
  ScheduleTaskItem,
  ScheduleUpdateRequest,
}

export default {
  /** 计划任务列表；instanceId 缺省返回全部 */
  getScheduleList: (instanceId?: string, options?: { signal?: AbortSignal }) => api.post('app/schedule/list', instanceId ? { instanceId } : {}, options) as Promise<{ data: ScheduleTaskItem[] }>,
  /** 创建计划任务（定时重启/备份/定时更新/数据库快照） */
  createScheduleTask: (data: ScheduleCreateRequest) => api.post('app/schedule/create', data) as Promise<{ data: ScheduleMutationResult }>,
  /** 更新调度配置或启停状态 */
  updateScheduleTask: (data: ScheduleUpdateRequest) => api.post('app/schedule/update', data) as Promise<{ data: ScheduleMutationResult }>,
  /** 删除计划任务 */
  deleteScheduleTask: (data: ScheduleTaskIdRequest) => api.post('app/schedule/delete', data) as Promise<{ data: ScheduleMutationResult }>,
  /** 立即执行一次（写回最近执行结果并顺延周期） */
  runScheduleTaskNow: (data: ScheduleTaskIdRequest) => api.post('app/schedule/run-now', data) as Promise<{ data: ScheduleRunNowResult }>,
}
