<script setup lang="ts">
import { NButton, NDataTable, NDrawer, NDrawerContent, NEmpty, NForm, NFormItem, NInput, NPopconfirm, NSpace, NTag, useDialog, useMessage } from 'naive-ui'
import { computed, h, onMounted, reactive, ref } from 'vue'
import apiRbac from '@/api/modules/rbac'
import type { RoleListItem } from '@/api/modules/rbac'
import { apiErrorMessage } from '@/utils/apiErrorMessage'
import { isKnownPermission } from '../../../shared/constants/permissions'
import RolePermissionPicker from './components/RolePermissionPicker.vue'

/**
 * 角色管理：一个角色 = 一组权限点。
 *
 * 权限点清单直接来自 `shared/constants/permissions.ts`（前后端同一份常量），
 * 所以这里**不发请求**去取清单，也不会出现「界面能勾、后端不认」的漂移。
 *
 * 「能力」与「范围」是两件事：这里配的是能力（能做哪些动作），
 * 成员能作用在哪些实例上由「成员管理」里的实例授权决定。页面上要把这句说清楚，
 * 否则很容易以为勾了权限就等于给了全部实例。
 *
 * 权限点怎么勾由 `RolePermissionPicker` 负责（起点模板 + 分模块折叠 + 逐项说明），
 * 这个文件只管列表、表单与保存。
 */

defineOptions({
  name: 'RolesSection',
})

const message = useMessage()
const dialog = useDialog()
const appSettingsStore = useAppSettingsStore()
const isMobileMode = computed(() => appSettingsStore.mode === 'mobile')

const loading = ref(false)
const saving = ref(false)
const roles = ref<RoleListItem[]>([])

const editorVisible = ref(false)
const editingRoleId = ref<string | null>(null)
/** 正在编辑的角色整行：抽屉里要显示「多少成员在用」 */
const editingRole = ref<RoleListItem | null>(null)
const form = reactive({
  name: '',
  description: '',
  permissions: [] as string[],
})

const memberUsageLine = computed(() => {
  if (!editingRole.value) {
    return ''
  }
  return editingRole.value.memberCount > 0
    ? `${editingRole.value.memberCount} 位成员在用这个角色，保存后立即对他们生效。`
    : '还没有成员在用这个角色。'
})

/**
 * 提交前过滤掉清单外的值。
 *
 * `modelValue` 的值类型是 `string`，而接口只收已知权限点（`PermissionKey`）。
 * 用类型守卫过滤既满足类型，也顺手挡住"界面上出现了清单里没有的项"这种情况。
 */
const permissionsForSubmit = computed(() => form.permissions.filter(isKnownPermission))

async function loadRoles() {
  loading.value = true
  try {
    const res = await apiRbac.roleList()
    roles.value = res.data ?? []
  }
  catch {
    message.error('读取角色列表失败')
  }
  finally {
    loading.value = false
  }
}

function openCreate() {
  editingRoleId.value = null
  editingRole.value = null
  form.name = ''
  form.description = ''
  form.permissions = []
  editorVisible.value = true
}

function openEdit(role: RoleListItem) {
  if (role.isBuiltin) {
    return
  }
  editingRoleId.value = role.id
  editingRole.value = role
  form.name = role.name
  form.description = role.description
  form.permissions = [...role.permissions]
  editorVisible.value = true
}

/**
 * 没有任何权限的角色照旧允许保存（服务端也允许），但先说清后果：
 * 成员登录后一个页面都看不到，很容易被当成"面板坏了"。
 */
function submit() {
  if (!form.name.trim()) {
    message.warning('请填写角色名称')
    return
  }
  if (permissionsForSubmit.value.length === 0) {
    dialog.warning({
      title: '这个角色没有任何权限',
      content: editingRoleId.value
        ? '保存后，用这个角色的成员会看不到任何页面。确定这样保存吗？'
        : '创建后，用这个角色的成员会看不到任何页面。确定这样创建吗？',
      positiveText: '仍然保存',
      negativeText: '回去勾选',
      onPositiveClick: () => {
        void doSubmit()
      },
    })
    return
  }
  void doSubmit()
}

async function doSubmit() {
  saving.value = true
  try {
    const payload = {
      name: form.name.trim(),
      description: form.description.trim(),
      permissions: permissionsForSubmit.value,
    }
    if (editingRoleId.value) {
      await apiRbac.roleUpdate({ roleId: editingRoleId.value, ...payload })
      message.success('角色已更新，刷新页面后立即生效')
    }
    else {
      await apiRbac.roleCreate(payload)
      message.success('角色已创建')
    }
    editorVisible.value = false
    await loadRoles()
  }
  catch (error) {
    message.error(apiErrorMessage(error, '保存失败'))
  }
  finally {
    saving.value = false
  }
}

async function removeRole(role: RoleListItem) {
  try {
    await apiRbac.roleDelete(role.id)
    message.success('角色已删除')
    await loadRoles()
  }
  catch (error) {
    message.error(apiErrorMessage(error, '删除失败'))
  }
}

const columns = [
  { title: '角色', key: 'name', minWidth: 140 },
  { title: '备注', key: 'description', minWidth: 160 },
  {
    title: '权限点',
    key: 'permissions',
    width: 110,
    render: (row: RoleListItem) => `${row.permissions.length} 项`,
  },
  {
    title: '成员',
    key: 'memberCount',
    width: 90,
    render: (row: RoleListItem) => `${row.memberCount} 人`,
  },
  {
    title: '类型',
    key: 'kind',
    width: 110,
    render: (row: RoleListItem) => (row.isBuiltin
      ? h(NTag, { size: 'small', type: 'warning', bordered: false }, { default: () => '内置·只读' })
      : h(NTag, { size: 'small', bordered: false }, { default: () => '自建' })),
  },
  {
    title: '操作',
    key: 'actions',
    width: 150,
    render: (row: RoleListItem) => h(NSpace, { size: 8, wrap: false }, {
      default: () => [
        h(NButton, {
          size: 'small',
          secondary: true,
          // 内置角色的名称、备注与权限点由代码固化
          disabled: row.isBuiltin,
          onClick: () => openEdit(row),
        }, { default: () => '编辑' }),
        h(NPopconfirm, {
          onPositiveClick: () => removeRole(row),
        }, {
          trigger: () => h(NButton, {
            size: 'small',
            secondary: true,
            type: 'error',
            disabled: row.isBuiltin || row.memberCount > 0,
            onClick: () => {},
          }, { default: () => '删除' }),
          default: () => row.memberCount > 0
            ? `还有 ${row.memberCount} 个成员在用这个角色，请先换角色`
            : '删除后不可恢复，确定吗？',
        }),
      ],
    }),
  },
]

onMounted(loadRoles)
</script>

<template>
  <div class="flex flex-wrap items-center justify-start gap-3">
    <NButton type="primary" @click="openCreate">
      新建角色
    </NButton>
  </div>

  <NDataTable
    :columns="columns"
    :data="roles"
    :loading="loading"
    :scroll-x="isMobileMode ? 900 : undefined"
    :pagination="false"
    :row-key="(row: RoleListItem) => row.id"
    size="small"
  >
    <template #empty>
      <NEmpty size="large" description="还没有角色。新建一个，勾上需要的权限点即可。" />
    </template>
  </NDataTable>

  <NDrawer
    v-model:show="editorVisible"
    :width="isMobileMode ? '100%' : 720"
    placement="right"
    :mask-closable="false"
  >
    <NDrawerContent
      :title="editingRoleId ? '编辑角色' : '新建角色'"
      closable
      :native-scrollbar="false"
    >
      <div class="flex flex-col gap-4">
        <p v-if="memberUsageLine" class="m-0 text-xs text-muted-foreground">
          {{ memberUsageLine }}
        </p>

        <!--
          `:show-feedback="false"` 去掉表单项底部预留的校验反馈位（就是那个
          `n-form-item-feedback-wrapper`）：这里靠提交前手动校验，用不到它。
          那个占位同时也是两个输入框之间的间距来源，所以拿掉之后要自己用 `mb-4` 补回来。
        -->
        <NForm label-placement="top">
          <NFormItem label="角色名称" required :show-feedback="false" class="mb-4">
            <NInput v-model:value="form.name" placeholder="例如：运维、只读看板" maxlength="64" />
          </NFormItem>
          <NFormItem label="备注" :show-feedback="false">
            <NInput v-model:value="form.description" placeholder="这个角色是给谁用的" maxlength="200" />
          </NFormItem>
        </NForm>

        <RolePermissionPicker v-model="form.permissions" :disabled="saving" />
      </div>

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
    </NDrawerContent>
  </NDrawer>
</template>
