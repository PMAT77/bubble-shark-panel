import type {
  MemberCreatePayload,
  MemberInstanceGrantPayload,
  MemberListItem,
  MemberMutationResult,
  MemberPasswordResetPayload,
  MemberUpdatePayload,
  RoleCreatePayload,
  RoleListItem,
  RoleMutationResult,
  RoleOptionItem,
  RoleUpdatePayload,
} from '../../../shared/contracts/rbac'
import api from '../index'

export type {
  MemberCreatePayload,
  MemberInstanceGrantPayload,
  MemberListItem,
  MemberMutationResult,
  MemberPasswordResetPayload,
  MemberUpdatePayload,
  RoleCreatePayload,
  RoleListItem,
  RoleMutationResult,
  RoleOptionItem,
  RoleUpdatePayload,
}

/**
 * 成员与角色接口。
 *
 * 权限点清单不在这里——它是 `shared/constants/permissions.ts` 的 `PERMISSION_SPECS`，
 * 页面直接 import 那份常量渲染勾选面板（本地计算，零请求，也不会与后端漂移）。
 */
export default {
  roleList: () => api.get('app/system/roles') as Promise<{ data: RoleListItem[] }>,
  /**
   * 角色选项：只够"选一个角色"用。
   *
   * 成员管理用它做角色下拉（不需要权限点清单与成员数），因此成员页只需要 `member:read`，
   * 不必再要求 `role:read`。
   */
  roleOptions: () => api.get('app/system/role-options') as Promise<{ data: RoleOptionItem[] }>,
  roleCreate: (data: RoleCreatePayload) => api.post('app/system/roles/create', data) as Promise<{ data: RoleMutationResult }>,
  roleUpdate: (data: RoleUpdatePayload) => api.post('app/system/roles/update', data) as Promise<{ data: RoleMutationResult }>,
  roleDelete: (roleId: string) => api.post('app/system/roles/delete', { roleId }) as Promise<{ data: RoleMutationResult }>,

  memberList: () => api.get('app/system/members') as Promise<{ data: MemberListItem[] }>,
  memberCreate: (data: MemberCreatePayload) => api.post('app/system/members/create', data) as Promise<{ data: MemberMutationResult }>,
  memberUpdate: (data: MemberUpdatePayload) => api.post('app/system/members/update', data) as Promise<{ data: MemberMutationResult }>,
  memberPassword: (data: MemberPasswordResetPayload) => api.post('app/system/members/password', data) as Promise<{ data: MemberMutationResult }>,
  memberInstances: (data: MemberInstanceGrantPayload) => api.post('app/system/members/instances', data) as Promise<{ data: MemberMutationResult }>,
  memberDelete: (userId: string) => api.post('app/system/members/delete', { userId }) as Promise<{ data: MemberMutationResult }>,
}
