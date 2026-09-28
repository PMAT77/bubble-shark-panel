<script setup lang="ts">
import { NAlert, NButton, NCard, NCheckbox, NCheckboxGroup, NDataTable, NEmpty, NForm, NFormItem, NInput, NModal, NPopconfirm, NSpace, NSpin, NTag, useMessage } from 'naive-ui'
import { computed, h, onMounted, reactive, ref } from 'vue'
import apiRbac from '@/api/modules/rbac'
import type { RoleListItem } from '@/api/modules/rbac'
import { apiErrorMessage } from '@/utils/apiErrorMessage'
import { isKnownPermission, PERMISSION_GROUPS, PERMISSION_SPECS } from '../../../shared/constants/permissions'
import type { PermissionGroup } from '../../../shared/constants/permissions'

/**
 * 角色管理：一个角色 = 一组权限点。
 *
 * 权限点清单直接来自 `shared/constants/permissions.ts`（前后端同一份常量），
 * 所以这里**不发请求**去取清单，也不会出现「界面能勾、后端不认」的漂移。
 *
 * 「能力」与「范围」是两件事：这里配的是能力（能做哪些动作），
 * 成员能作用在哪些实例上由「成员管理」里的实例授权决定。页面上要把这句说清楚，
 * 否则很容易以为勾了权限就等于给了全部实例。
 */

defineOptions({
  name: 'RolesSection',
})

const message = useMessage()

const loading = ref(false)
const saving = ref(false)
const roles = ref<RoleListItem[]>([])

const editorVisible = ref(false)
const editingRoleId = ref<string | null>(null)
const form = reactive({
  name: '',
  description: '',
  permissions: [] as string[],
})

const specsByGroup = computed(() => {
  const map = new Map<PermissionGroup, typeof PERMISSION_SPECS[number][]>()
  for (const spec of PERMISSION_SPECS) {
    const list = map.get(spec.group) ?? []
    list.push(spec)
    map.set(spec.group, list)
  }
  return map
})

/**
 * 提交前过滤掉清单外的值。
 *
 * `NCheckboxGroup` 的值类型是 `string`，而接口只收已知权限点（`PermissionKey`）。
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
  form.name = ''
  form.description = ''
  form.permissions = []
  editorVisible.value = true
}

function openEdit(role: RoleListItem) {
  editingRoleId.value = role.id
  form.name = role.name
  form.description = role.description
  form.permissions = [...role.permissions]
  editorVisible.value = true
}

function isGroupAllSelected(group: PermissionGroup): boolean {
  const specs = specsByGroup.value.get(group) ?? []
  return specs.length > 0 && specs.every(spec => form.permissions.includes(spec.key))
}

function toggleGroup(group: PermissionGroup) {
  const specs = specsByGroup.value.get(group) ?? []
  // 声明成 string[]：勾选面板的值是 string，而 spec.key 是字面量联合，直接 includes 会类型不匹配
  const keys: string[] = specs.map(spec => spec.key)
  if (isGroupAllSelected(group)) {
    form.permissions = form.permissions.filter(key => !keys.includes(key))
  }
  else {
    form.permissions = [...new Set([...form.permissions, ...keys])]
  }
}

async function submit() {
  if (!form.name.trim()) {
    message.warning('请填写角色名称')
    return
  }
  saving.value = true
  try {
    const payload = {
      name: form.name.trim(),
      description: form.description.trim(),
      permissions: permissionsForSubmit.value,
    }
    if (editingRoleId.value) {
      await apiRbac.roleUpdate({ roleId: editingRoleId.value, ...payload })
      message.success('角色已更新，使用它的成员立即生效')
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
  { title: '说明', key: 'description', minWidth: 160 },
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
    render: (row: RoleListItem) => h(NSpace, { size: 8 }, {
      default: () => [
        h(NButton, {
          size: 'small',
          quaternary: true,
          // 内置游客角色不可改：它是公开只读预览的唯一安全阀，改动它等于拆掉那道闸
          disabled: row.isBuiltin,
          onClick: () => openEdit(row),
        }, { default: () => '编辑' }),
        h(NPopconfirm, {
          onPositiveClick: () => removeRole(row),
        }, {
          trigger: () => h(NButton, {
            size: 'small',
            quaternary: true,
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
  <NCard title="角色" :bordered="false">
    <template #header-extra>
      <NButton type="primary" size="small" @click="openCreate">
        新建角色
      </NButton>
    </template>

    <NAlert type="info" :bordered="false" class="mb-3">
      角色决定「能做什么」，成员能作用在哪些实例上由「成员管理」里的实例授权决定 —— 两者同时满足才生效。
    </NAlert>

    <NSpin :show="loading">
      <NDataTable
        v-if="roles.length > 0"
        :columns="columns"
        :data="roles"
        :row-key="(row: RoleListItem) => row.id"
        :bordered="false"
        size="small"
      />
      <NEmpty v-else description="还没有角色。新建一个，勾上需要的权限点即可。" />
    </NSpin>

    <NModal
      v-model:show="editorVisible"
      preset="card"
      :title="editingRoleId ? '编辑角色' : '新建角色'"
      class="max-w-3xl"
    >
      <NForm label-placement="top">
        <NFormItem label="角色名称" required>
          <NInput v-model:value="form.name" placeholder="例如：运维、只读看板" maxlength="64" />
        </NFormItem>
        <NFormItem label="说明">
          <NInput v-model:value="form.description" placeholder="这个角色是给谁用的" maxlength="200" />
        </NFormItem>
      </NForm>

      <div class="mb-2 text-sm text-muted-foreground">
        权限点（已选 {{ form.permissions.length }} 项）
      </div>
      <div class="max-h-[50vh] overflow-y-auto pr-1">
        <div v-for="group in PERMISSION_GROUPS" :key="group" class="mb-3">
          <div class="mb-1 flex items-center justify-between">
            <span class="text-sm font-medium">{{ group }}</span>
            <NButton text size="tiny" @click="toggleGroup(group)">
              {{ isGroupAllSelected(group) ? '全不选' : '全选' }}
            </NButton>
          </div>
          <NCheckboxGroup v-model:value="form.permissions">
            <NSpace :size="[16, 6]">
              <NCheckbox
                v-for="spec in specsByGroup.get(group) ?? []"
                :key="spec.key"
                :value="spec.key"
                :label="spec.label"
              />
            </NSpace>
          </NCheckboxGroup>
        </div>
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
    </NModal>
  </NCard>
</template>
