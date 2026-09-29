<script setup lang="ts">
import type { PermissionKey } from '../../../../shared/constants/permissions'
import type { PermissionGroupView, PermissionPreset } from '../rolePermissionPresentation'
import { NButton, NCheckbox, NEmpty, NInput, NPopconfirm, NTag, NTooltip, useDialog } from 'naive-ui'
import { computed, onMounted, ref, watch } from 'vue'
import { ALL_PERMISSIONS } from '../../../../shared/constants/permissions'
import {
  buildPermissionGroupViews,
  countSelection,
  isPresetApplied,
  MODULE_MENU_REQUIREMENTS,
  normalizedSelection,
  PERMISSION_PRESETS,
} from '../rolePermissionPresentation'

/**
 * 角色权限选择器（受控组件，不碰接口）。
 *
 * 为什么是这个形态：53 个权限点平铺出来就是一堵表墙——扫不完、也看不懂。
 * 这里按调研到的成熟做法收敛成四层，每层都只暴露当前需要的信息：
 *   1. **起点模板**：先选「只读看板 / 日常运维 / 完全管理」，多数人到此就够了；
 *   2. **分模块折叠**：13 个模块默认折叠，首屏一个复选框都不出现；
 *   3. **单个模块内纵向排列表项**（横向并排的复选框会显著降低扫读，见 NN/g 的复选框规范）；
 *   4. **搜索**：按名称与说明匹配，直接跳到那一组。
 *
 * 另外它负责说清两件容易被忽略的事：
 * - 每个权限点都带一句「它到底允许做什么」（来自 `PermissionSpec.summary`）；
 * - **这个模块对应哪个侧边栏入口**：分组里写一行「对应菜单：房间管理」。一个菜单项只由
 *   它自己的读权限决定，所以这里不需要再解释别的依赖。
 */

defineOptions({
  name: 'RolePermissionPicker',
})

const props = defineProps<{
  modelValue: string[]
  disabled?: boolean
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: string[]): void
}>()

const keyword = ref('')

/**
 * 手动展开的分组。
 *
 * 折叠面板是自己实现的，**不要换回 naive 的 `NCollapse` / `NCollapseItem`**：
 * 它内部的 `CollapseItemContent` 把插槽渲染标记成 `_: 1`（`SlotFlags.STABLE`，
 * 见 `naive-ui/es/collapse/src/CollapseItemContent.mjs`），于是父组件重渲染时
 * Vue 不会把新的插槽内容传下去——展开区里的复选框会一直停在打开那一刻的状态，
 * 表现为「点了只有数字变、勾选框不动，折叠再展开才对」。
 */
const expandedGroups = ref<string[]>([])

const dialog = useDialog()

/**
 * 起点卡片的图标。
 *
 * 写成字面量而不是放进 `PERMISSION_PRESETS`：图标名要在源码里出现，构建时才会被打包，
 * 动态拼接的名字会得到一片空白。
 */
const PRESET_ICONS: Record<PermissionPreset['key'], string> = {
  readonly: 'i-lucide:eye',
  ops: 'i-lucide:wrench',
  full: 'i-lucide:shield-check',
}

/**
 * 组件内部持有的勾选状态（乐观更新）。
 *
 * 为什么不直接拿 `props.modelValue` 渲染：naive 的 `NCheckbox` 是受控组件——点一下只会
 * 触发 `update:checked`，要不要变样全看父级有没有把新的 `modelValue` 传回来。中间只要有
 * 一次延迟或没回写，用户看到的就是「点了没反应 / 勾上又弹回」。
 * 这里改为先本地生效、再向上 emit；父级回写时两边内容一致，不会互相覆盖。
 */
const selected = ref<PermissionKey[]>([...normalizedSelection(props.modelValue)])

watch(() => props.modelValue, (value) => {
  selected.value = [...normalizedSelection(value)]
})

const currentSelection = computed(() => new Set(selected.value))
const groups = computed(() => buildPermissionGroupViews(selected.value, keyword.value))
const summary = computed(() => countSelection(selected.value))
const isSearching = computed(() => keyword.value.trim().length > 0)

/**
 * 分组 → 它在侧边栏里对应的入口。
 *
 * 文案直接来自 `MODULE_MENU_REQUIREMENTS`（与菜单的 `auth` 逐条对齐、有测试钉住），
 * 所以服务端改了权限点，这里不用手改文案。
 */
const GROUP_MENU_HINTS: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string[]>()
  for (const module of MODULE_MENU_REQUIREMENTS) {
    if (module.hidden === true) {
      continue
    }
    for (const group of module.groups) {
      const titles = map.get(group) ?? []
      if (!titles.includes(module.title)) {
        titles.push(module.title)
      }
      map.set(group, titles)
    }
  }
  return new Map([...map].map(([group, titles]) => [group, titles.join('、')]))
})()

function groupMenuHint(group: string) {
  return GROUP_MENU_HINTS.get(group) ?? null
}

/** 当前勾选正好等于哪个起点模板（用于卡片高亮） */
const matchedPreset = computed(() => PERMISSION_PRESETS.find(preset => isPresetApplied(selected.value, preset)) ?? null)

/** 搜索时命中分组一律展开，不回写 expandedGroups，清空搜索后能回到原来的折叠状态 */
function isGroupExpanded(group: string): boolean {
  return isSearching.value || expandedGroups.value.includes(group)
}

function toggleGroup(group: string) {
  if (expandedGroups.value.includes(group)) {
    expandedGroups.value = expandedGroups.value.filter(name => name !== group)
  }
  else {
    expandedGroups.value = [...expandedGroups.value, group]
  }
}

/** 统一出口：本地先生效，再上报；顺序固定按权限点清单，勾选先后不影响结果 */
function commit(next: Iterable<PermissionKey>) {
  const wanted = new Set(next)
  const list = ALL_PERMISSIONS.filter(key => wanted.has(key))
  selected.value = list
  emit('update:modelValue', [...list])
}

/**
 * 勾选 / 取消一项。
 *
 * 故意不看 `NCheckbox` 回传的值，而是按「当前有没有」取反：勾选状态本来就是从这里派生的，
 * 翻转一次最不容易和组件的受控语义打架。
 */
function toggleItem(key: PermissionKey) {
  const next = new Set(currentSelection.value)
  if (next.has(key)) {
    next.delete(key)
  }
  else {
    next.add(key)
  }
  commit(next)
}

/** 组内三态：搜索时只作用于当前显示出来的命中项（所见即所改） */
function toggleGroupAll(view: PermissionGroupView) {
  const next = new Set(currentSelection.value)
  const shouldClear = view.items.every(item => next.has(item.key))
  for (const item of view.items) {
    if (shouldClear) {
      next.delete(item.key)
    }
    else {
      next.add(item.key)
    }
  }
  commit(next)
}

function applyPreset(preset: PermissionPreset) {
  commit(preset.permissions)
  // 套用后展开第一个有内容的模块：全折叠时只有组头计数在变，看不出到底套用了什么
  keyword.value = ''
  const firstSelected = buildPermissionGroupViews(preset.permissions).find(view => view.selectedCount > 0)
  expandedGroups.value = firstSelected ? [firstSelected.group] : []
}

/**
 * 起点卡片要不要先确认。
 *
 * 只有「已经勾了别的权限、且和这个模板不一样」时才问——否则点一下就套用。
 * 确认走 `useDialog` 而不是 `NPopconfirm`：后者禁用后连点击事件都不触发，
 * 新建角色（当前选择为空）时点卡片会毫无反应。
 */
function needsPresetConfirm(preset: PermissionPreset): boolean {
  return summary.value.selected > 0 && matchedPreset.value?.key !== preset.key
}

function selectPreset(preset: PermissionPreset) {
  if (props.disabled) {
    return
  }
  if (!needsPresetConfirm(preset)) {
    applyPreset(preset)
    return
  }
  dialog.warning({
    title: '套用起点模板',
    content: `套用「${preset.label}」会替换当前已勾选的 ${summary.value.selected} 项权限点，确定吗？`,
    positiveText: '套用',
    negativeText: '取消',
    onPositiveClick: () => {
      applyPreset(preset)
    },
  })
}

function clearAll() {
  commit([])
}

/**
 * 编辑已有角色时，默认展开第一个「已经勾了东西」的模块。
 *
 * 抽屉每次打开都会重建内容（`NDrawer` 默认 `display-directive: 'if'`），所以这里只在挂载时做一次：
 * 换成 watch 会在每次勾选后都重新展开那一组，把人手动折叠的组又顶开。
 */
onMounted(() => {
  const firstSelected = buildPermissionGroupViews(selected.value).find(view => view.selectedCount > 0)
  if (firstSelected) {
    expandedGroups.value = [firstSelected.group]
  }
})
</script>

<template>
  <div class="flex flex-col gap-4">
    <div>
      <div class="mb-2 text-sm text-muted-foreground">
        选择预设
      </div>
      <div class="flex flex-col gap-2">
        <button
          v-for="preset in PERMISSION_PRESETS"
          :key="preset.key"
          type="button"
          :disabled="props.disabled"
          class="flex w-full items-start gap-3 border rounded-lg p-3 text-left transition-colors"
          :class="[
            matchedPreset?.key === preset.key
              ? 'border-primary bg-primary/5'
              : 'border-transparent bg-secondary/40',
            props.disabled ? 'cursor-not-allowed op-60' : 'cursor-pointer hover-bg-accent/60',
          ]"
          @click="selectPreset(preset)"
        >
          <span
            class="flex size-10 shrink-0 items-center justify-center rounded-lg"
            :class="matchedPreset?.key === preset.key ? 'bg-primary/15' : 'bg-background'"
          >
            <FaIcon
              :name="PRESET_ICONS[preset.key]"
              class="size-5"
              :class="matchedPreset?.key === preset.key ? 'text-primary' : 'text-muted-foreground'"
            />
          </span>
          <span class="flex min-w-0 flex-col gap-0.5">
            <span
              class="font-medium"
              :class="matchedPreset?.key === preset.key ? 'text-primary' : ''"
            >
              {{ preset.label }}
            </span>
            <span class="text-xs text-muted-foreground">{{ preset.description }}</span>
          </span>
        </button>
      </div>
    </div>

    <NInput
      v-model:value="keyword"
      clearable
      :disabled="props.disabled"
      placeholder="搜权限：试试「踢」「备份」「面板设置」"
    >
      <template #prefix>
        <FaIcon name="i-ri:search-line" class="text-foreground/40 size-4" />
      </template>
    </NInput>

    <NEmpty v-if="groups.length === 0" size="large" description="没有匹配的权限点，换个词试试" />

    <!--
      折叠区是自己实现的（`v-if` + 原生 button），不是 naive 的 `NCollapse`：
      后者的 `CollapseItemContent` 把插槽标成 `SlotFlags.STABLE`，展开区里的复选框
      不会随数据更新（详见上方 expandedGroups 的注释）。
    -->
    <div v-else>
      <div
        v-for="view in groups"
        :key="view.group"
        class="border-t"
      >
        <!--
          组头一行：三态全选框在最前面（无文案，位置本身就说明它是「这一组全选」），
          它和折叠按钮是**兄弟节点**而不是嵌在里面——复选框不响应折叠点击，
          也不会有「按钮里套 checkbox」这种不合法的结构。
        -->
        <div class="flex items-center gap-2 py-3">
          <NCheckbox
            :checked="view.allSelected"
            :indeterminate="view.partiallySelected"
            :disabled="props.disabled"
            :aria-label="`全选「${view.group}」`"
            @update:checked="() => toggleGroupAll(view)"
          />

          <button
            type="button"
            class="flex flex-1 cursor-pointer items-center gap-2 text-left"
            :aria-expanded="isGroupExpanded(view.group)"
            @click="toggleGroup(view.group)"
          >
            <FaIcon
              name="i-lucide:chevron-right"
              class="size-4 shrink-0 text-muted-foreground transition-transform"
              :class="isGroupExpanded(view.group) ? 'rotate-90' : ''"
            />
            <span class="font-medium">{{ view.group }}</span>
            <!-- 有勾选的分组用主色标出来：全折叠时一眼能看出哪几组动过 -->
            <span
              class="text-xs"
              :class="view.selectedCount > 0 ? 'text-primary' : 'text-muted-foreground'"
            >
              {{ view.selectedCount }}/{{ view.total }}
            </span>
            <NTooltip v-if="view.needsReadHint" trigger="hover">
              <!-- 点提示图标只弹说明，不该顺带把这一组折叠起来 -->
              <template #trigger>
                <span class="inline-flex" @click.stop>
                  <FaIcon name="i-lucide:triangle-alert" class="text-warning size-4" />
                </span>
              </template>
              这一组只勾了操作权限，没勾「查看」权限：成员进不去这个页面，下面的权限也用不上。
            </NTooltip>
          </button>
        </div>

        <div v-if="isGroupExpanded(view.group)" class="flex flex-col gap-3 pb-4">
          <p class="m-0 text-xs text-muted-foreground">
            {{ view.hint }}
          </p>

          <!--
            把「这一组对应哪个侧边栏入口」写在组头里：勾权限的人是在按用途选，
            而侧边栏是按模块分的，两边的对应关系说清楚可以少一次试错。
          -->
          <p v-if="groupMenuHint(view.group)" class="m-0 text-xs text-muted-foreground">
            对应菜单：{{ groupMenuHint(view.group) }}
          </p>

          <!--
            每一项必须独占一行：naive 的复选框根元素是 `inline-flex`，不给宽度就会像
            「一行两三个」那样横向铺开——那正是扫读最差的排法（NN/g 的复选框规范）。
          -->
          <div class="-mx-2 flex flex-col gap-0.5">
            <NCheckbox
              v-for="item in view.items"
              :key="item.key"
              class="w-full items-start rounded-md px-2 py-1.5 hover-bg-accent/50"
              :checked="item.checked"
              :disabled="props.disabled"
              @update:checked="() => toggleItem(item.key)"
            >
              <span class="flex flex-col gap-0.5">
                <span class="flex flex-wrap items-center gap-1.5">
                  <span>{{ item.label }}</span>
                  <NTag v-if="item.dangerous" size="tiny" type="warning" :bordered="false">
                    高风险
                  </NTag>
                </span>
                <span class="text-xs text-muted-foreground">{{ item.summary }}</span>
              </span>
            </NCheckbox>
          </div>
        </div>
      </div>
    </div>

    <div class="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-sm">
      <span class="text-muted-foreground">
        已选 {{ summary.selected }} / {{ summary.total }} 项
        <span v-if="summary.selected === 0">：这个角色还没有任何权限</span>
      </span>
      <NPopconfirm
        :disabled="props.disabled || summary.selected === 0"
        @positive-click="clearAll"
      >
        <template #trigger>
          <NButton text size="small" :disabled="props.disabled || summary.selected === 0">
            清空
          </NButton>
        </template>
        清空后这个角色没有任何权限，确定吗？
      </NPopconfirm>
    </div>
  </div>
</template>
