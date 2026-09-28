<script setup lang="ts">
import { NButton, NCard, NDataTable, NEmpty, NForm, NFormItem, NInput, NModal, NPopconfirm, NSelect, NSpace, NSpin, NSwitch, NTag, useMessage } from 'naive-ui'
import { h, onMounted, reactive, ref } from 'vue'
import apiInstance from '@/api/modules/instance'
import apiRbac from '@/api/modules/rbac'
import type { MemberListItem, RoleListItem } from '@/api/modules/rbac'
import { apiErrorMessage } from '@/utils/apiErrorMessage'

/**
 * 成员管理：建子账号、分角色、授权实例。
 *
 * 页面要把「能力」与「范围」两件事分开讲清楚：
 * - **角色**决定这个账号能做什么（能不能启停实例、能不能改房间配置）；
 * - **实例授权**决定它能在哪些实例上做。
 * 两者同时满足才生效——只给角色不给实例，账号登录后看不到任何实例；
 * 只给实例不给角色，它进去点什么都报无权限。
 */

defineOptions({
  name: 'MembersSection',
})

const message = useMessage()

const loading = ref(false)
const saving = ref(false)
const members = ref<MemberListItem[]>([])
const roles = ref<RoleListItem[]>([])
const instances = ref<Array<{ id: string, name: string }>>([])

const editorVisible = ref(false)
const editingUserId = ref<string | null>(null)
const form = reactive({
  account: '',
  password: '',
  roleId: '' as string | null,
  status: 1,
  instanceIds: [] as string[],
  mustChangePassword: true,
})

const passwordVisible = ref(false)
const passwordForm = reactive({ userId: '', account: '', password: '', mustChangePassword: true })

const roleOptions = ref<Array<{ label: string, value: string }>>([])
const instanceOptions = ref<Array<{ label: string, value: string }>>([])

async function loadAll() {
  loading.value = true
  try {
    const [memberRes, roleRes, instanceRes] = await Promise.all([
      apiRbac.memberList(),
      apiRbac.roleList(),
      apiInstance.getInstanceList({}),
    ])
    members.value = memberRes.data ?? []
    roles.value = roleRes.data ?? []
    roleOptions.value = roles.value.map(role => ({
      label: role.isBuiltin ? `${role.name}（只读）` : role.name,
      value: role.id,
    }))
    const list = (instanceRes as { data?: Array<{ id: string, name: string }> }).data ?? []
    instances.value = list.map(item => ({ id: item.id, name: item.name }))
    instanceOptions.value = instances.value.map(item => ({
      label: `${item.name}（${item.id.slice(0, 8)}）`,
      value: item.id,
    }))
  }
  catch (error) {
    message.error(apiErrorMessage(error, '读取成员列表失败'))
  }
  finally {
    loading.value = false
  }
}

function openCreate() {
  editingUserId.value = null
  form.account = ''
  form.password = ''
  form.roleId = roleOptions.value[0]?.value ?? null
  form.status = 1
  form.instanceIds = []
  form.mustChangePassword = true
  editorVisible.value = true
}

function openEdit(member: MemberListItem) {
  editingUserId.value = member.id
  form.account = member.account
  form.password = ''
  form.roleId = member.roleId
  form.status = member.status
  form.instanceIds = [...member.instanceIds]
  form.mustChangePassword = member.mustChangePassword
  editorVisible.value = true
}

async function submit() {
  if (!editingUserId.value && (!form.account.trim() || !form.password)) {
    message.warning('账号与初始密码都是必填')
    return
  }
  if (!form.roleId) {
    message.warning('请选择角色')
    return
  }
  saving.value = true
  try {
    if (editingUserId.value) {
      await apiRbac.memberUpdate({
        userId: editingUserId.value,
        roleId: form.roleId,
        status: form.status === 1 ? 1 : 0,
      })
      // 实例授权单独一条接口：它与角色是两件事，失败时也要能分别提示
      await apiRbac.memberInstances({ userId: editingUserId.value, instanceIds: form.instanceIds })
      message.success('成员已更新')
    }
    else {
      await apiRbac.memberCreate({
        account: form.account.trim(),
        password: form.password,
        roleId: form.roleId,
        instanceIds: form.instanceIds,
        mustChangePassword: form.mustChangePassword,
      })
      message.success('成员已创建，请把初始密码交给对方')
    }
    editorVisible.value = false
    await loadAll()
  }
  catch (error) {
    message.error(apiErrorMessage(error, '保存失败'))
  }
  finally {
    saving.value = false
  }
}

function openPasswordReset(member: MemberListItem) {
  passwordForm.userId = member.id
  passwordForm.account = member.account
  passwordForm.password = ''
  passwordForm.mustChangePassword = true
  passwordVisible.value = true
}

async function submitPassword() {
  if (!passwordForm.password) {
    message.warning('请填写新密码')
    return
  }
  saving.value = true
  try {
    await apiRbac.memberPassword({
      userId: passwordForm.userId,
      password: passwordForm.password,
      mustChangePassword: passwordForm.mustChangePassword,
    })
    message.success('密码已重置，该账号的现有登录已失效')
    passwordVisible.value = false
  }
  catch (error) {
    message.error(apiErrorMessage(error, '重置密码失败'))
  }
  finally {
    saving.value = false
  }
}

async function toggleStatus(member: MemberListItem) {
  try {
    await apiRbac.memberUpdate({ userId: member.id, status: member.status === 1 ? 0 : 1 })
    message.success(member.status === 1 ? '已停用' : '已启用')
    await loadAll()
  }
  catch (error) {
    message.error(apiErrorMessage(error, '操作失败'))
  }
}

async function removeMember(member: MemberListItem) {
  try {
    await apiRbac.memberDelete(member.id)
    message.success('成员已删除')
    await loadAll()
  }
  catch (error) {
    message.error(apiErrorMessage(error, '删除失败'))
  }
}

const columns = [
  { title: '账号', key: 'account', minWidth: 140 },
  {
    title: '角色',
    key: 'roleName',
    minWidth: 130,
    render: (row: MemberListItem) => row.roleName ?? '（未分配）',
  },
  {
    title: '可见实例',
    key: 'instanceIds',
    minWidth: 150,
    render: (row: MemberListItem) => {
      if (row.roleKind === 'guest' && row.instanceIds.length === 0) {
        return '（未授权）'
      }
      return row.instanceIds.length === 0
        ? h(NTag, { size: 'small', type: 'warning', bordered: false }, { default: () => '未授权任何实例' })
        : `${row.instanceIds.length} 个`
    },
  },
  {
    title: '状态',
    key: 'status',
    width: 100,
    render: (row: MemberListItem) => h(NTag, {
      size: 'small',
      type: row.status === 1 ? 'success' : 'default',
      bordered: false,
    }, { default: () => (row.status === 1 ? '启用' : '已停用') }),
  },
  {
    title: '操作',
    key: 'actions',
    width: 260,
    render: (row: MemberListItem) => h(NSpace, { size: 6 }, {
      default: () => [
        h(NButton, { size: 'small', quaternary: true, onClick: () => openEdit(row) }, { default: () => '编辑' }),
        h(NButton, { size: 'small', quaternary: true, onClick: () => openPasswordReset(row) }, { default: () => '重置密码' }),
        h(NButton, { size: 'small', quaternary: true, onClick: () => toggleStatus(row) }, { default: () => (row.status === 1 ? '停用' : '启用') }),
        h(NPopconfirm, { onPositiveClick: () => removeMember(row) }, {
          trigger: () => h(NButton, { size: 'small', quaternary: true, type: 'error' }, { default: () => '删除' }),
          default: () => `删除「${row.account}」后不可恢复，确定吗？`,
        }),
      ],
    }),
  },
]

onMounted(loadAll)
</script>

<template>
  <NCard title="成员" :bordered="false">
    <template #header-extra>
      <NButton type="primary" size="small" @click="openCreate">
        新建成员
      </NButton>
    </template>

    <NSpin :show="loading">
      <NDataTable
        v-if="members.length > 0"
        :columns="columns"
        :data="members"
        :row-key="(row: MemberListItem) => row.id"
        :bordered="false"
        size="small"
      />
      <NEmpty v-else description="还没有成员。新建一个子账号并分配角色即可。" />
    </NSpin>

    <NModal
      v-model:show="editorVisible"
      preset="card"
      :title="editingUserId ? '编辑成员' : '新建成员'"
      class="max-w-2xl"
    >
      <NForm label-placement="top">
        <NFormItem label="账号" required>
          <NInput v-model:value="form.account" :disabled="Boolean(editingUserId)" placeholder="登录用的账号名" maxlength="128" />
        </NFormItem>
        <NFormItem v-if="!editingUserId" label="初始密码" required>
          <NInput v-model:value="form.password" type="password" show-password-on="click" placeholder="8-64 位，含大小写字母、数字与特殊字符" />
        </NFormItem>
        <NFormItem label="角色" required>
          <NSelect v-model:value="form.roleId" :options="roleOptions" placeholder="选择角色" />
        </NFormItem>
        <NFormItem label="可见实例">
          <NSelect
            v-model:value="form.instanceIds"
            multiple
            filterable
            :options="instanceOptions"
            placeholder="不选则看不到任何实例"
          />
        </NFormItem>
        <NFormItem v-if="!editingUserId" label="首次登录须改密">
          <NSwitch v-model:value="form.mustChangePassword" />
        </NFormItem>
        <NFormItem v-else label="启用">
          <NSwitch
            :value="form.status === 1"
            @update:value="(value: boolean) => { form.status = value ? 1 : 0 }"
          />
        </NFormItem>
      </NForm>

      <template #footer>
        <NSpace justify="end">
          <NButton @click="editorVisible = false">
            取消
          </NButton>
          <NButton type="primary" :loading="saving" @click="submit">
            保存
          </NButton>
        </NSpace>
      </template>
    </NModal>

    <NModal v-model:show="passwordVisible" preset="card" title="重置密码" class="max-w-lg">
      <NForm label-placement="top">
        <NFormItem label="账号">
          <NInput :value="passwordForm.account" disabled />
        </NFormItem>
        <NFormItem label="新密码" required>
          <NInput v-model:value="passwordForm.password" type="password" show-password-on="click" placeholder="8-64 位，含大小写字母、数字与特殊字符" />
        </NFormItem>
        <NFormItem label="要求下次登录改密">
          <NSwitch v-model:value="passwordForm.mustChangePassword" />
        </NFormItem>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="passwordVisible = false">
            取消
          </NButton>
          <NButton type="primary" :loading="saving" @click="submitPassword">
            重置
          </NButton>
        </NSpace>
      </template>
    </NModal>
  </NCard>
</template>
