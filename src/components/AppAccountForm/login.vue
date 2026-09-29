<script setup lang="ts">
import { toTypedSchema } from '@vee-validate/zod'
import { useForm } from 'vee-validate'
import * as z from 'zod'
import apiApp from '@/api/modules/app'
import { resolveGuestLoginPrefill } from '@/composables/app/guestLoginPrefill'
import { APP_TITLE } from '@/utils/app-title'
import { readSavedLoginCredentials, saveLoginCredentials } from '@/utils/login-credentials'
import { FormControl, FormField, FormItem, FormMessage } from '@/ui/shadcn/ui/form'

defineOptions({
  name: 'LoginForm',
})

const props = defineProps<{
  account?: string
}>()

const emits = defineEmits<{
  onLogin: [account?: string]
  onResetPassword: [account?: string]
}>()

const appAccountStore = useAppAccountStore()
const SHOW_DEMO_ACCOUNT_ENTRY = false

/**
 * 游客（只读预览）免密登录入口。
 *
 * `guestLoginEnabled` 由服务端决定（默认关闭，且只在 Native + production 下才可能为真）：
 * **关闭时不渲染按钮**，而不是渲染一个点了报错的按钮。
 * `guestAccountLabel` 只用于文案，不是凭证——游客账号的口令是服务端启动时生成的随机值，
 * 从不返回、从不落盘，前端手里没有任何可拿去登录的凭据。
 */
const guestLoginEnabled = ref(false)
const guestAccountLabel = ref('')
const guestLoggingIn = ref(false)

const title = APP_TITLE
const loading = ref(false)
const captchaRequired = ref(false)
const challengeToken = ref('')
const challengeQuestion = ref('')

function resolveLoginInitialValues() {
  const saved = readSavedLoginCredentials()
  if (import.meta.env.DEV) {
    return {
      account: saved.account || String(import.meta.env.VITE_DEV_LOGIN_ACCOUNT ?? '').trim() || 'superadmin',
      password: String(import.meta.env.VITE_DEV_LOGIN_PASSWORD ?? '') || '123456',
      remember: saved.remember,
      challengeAnswer: '',
    }
  }
  return {
    account: props.account ?? saved.account,
    password: '',
    remember: saved.remember,
    challengeAnswer: '',
  }
}

function restoreSavedCredentials() {
  const saved = readSavedLoginCredentials()
  // 只恢复账号与记住状态，不触碰密码输入框（密码交给浏览器密码管理器）。
  const account = props.account ?? saved.account
  if (account) {
    form.setFieldValue('account', account)
  }
  form.setFieldValue('remember', saved.remember)
}

interface LoginErrorPayload {
  code?: string
  data?: Record<string, unknown>
}

function updateCaptchaState(data?: Record<string, unknown>) {
  captchaRequired.value = true
  challengeToken.value = String(data?.challengeToken ?? '')
  challengeQuestion.value = String(data?.challengeQuestion ?? '')
  form.setFieldValue('challengeAnswer', '')
}

async function refreshCaptchaChallenge() {
  const values = form.values
  if (!values.account?.trim() || !values.password?.trim()) {
    faToast.warning('请先输入账号和密码')
    return
  }
  loading.value = true
  try {
    await appAccountStore.login({
      account: values.account,
      password: values.password,
      remember: values.remember === true,
      challengeToken: challengeToken.value || undefined,
      challengeAnswer: '__refresh__',
    })
  }
  catch (error) {
    const payload = error as LoginErrorPayload
    if (payload.code === 'AUTH_CAPTCHA_REQUIRED') {
      updateCaptchaState(payload.data)
    }
  }
  finally {
    loading.value = false
  }
}

const form = useForm({
  validationSchema: toTypedSchema(z.object({
    account: z.string().min(1, '请输入用户名'),
    password: z.string().min(1, '请输入密码'),
    remember: z.boolean(),
    challengeAnswer: z.string().optional(),
  })),
  initialValues: resolveLoginInitialValues(),
})

onMounted(() => {
  restoreSavedCredentials()
  void loadLoginOptions()
})

onActivated(() => {
  restoreSavedCredentials()
})

/**
 * 拉一次"本面板有没有游客入口"。
 *
 * 失败时保持"不渲染按钮"——探测失败不该凭空给用户一个可能点不通的入口。
 */
async function loadLoginOptions() {
  try {
    const res = await apiApp.loginOptions()
    guestLoginEnabled.value = res.data.guestLoginEnabled === true
    guestAccountLabel.value = res.data.guestAccountLabel ?? ''
  }
  catch {
    guestLoginEnabled.value = false
  }
}

/**
 * 「游客登录」按钮。
 *
 * 自动化的是**登录动作**，不是把口令填进表单：会话由服务端直接签发，
 * 前端只在成功后把账号名回填到账号输入框（肉眼可见的"自动填充"效果），
 * **密码框始终为空**——见 `@/composables/app/guestLoginPrefill`。
 *
 * 这里**刻意不调用 `onSubmit`**：那条路径会拿表单值去调 `/app/account/login`，
 * 而游客的口令是随机值、前端不可能知道，调用它只会立刻失败。会话在
 * `loginAsGuest()` 里已经落好了，所以这里只做收尾（清验证码态）并通知父组件。
 */
async function handleGuestLogin() {
  if (guestLoggingIn.value || loading.value) {
    return
  }
  guestLoggingIn.value = true
  try {
    const result = await appAccountStore.loginAsGuest()
    const prefill = resolveGuestLoginPrefill(result, guestAccountLabel.value)
    // 肉眼可见的"自动填充"：账号填上、密码保持为空（见 guestLoginPrefill 的注释）
    form.setFieldValue('account', prefill.account)
    form.setFieldValue('password', prefill.password)
    // 账号记进本地，刷新页面后输入框还是它；游客会话不落地"记住登录"
    saveLoginCredentials({ account: prefill.account, remember: false })
    captchaRequired.value = false
    challengeToken.value = ''
    challengeQuestion.value = ''
    emits('onLogin', prefill.account)
  }
  catch {
    // 未开放 / 未就绪 / 触发限流：错误提示由 axios 拦截器统一给出，这里不重复弹
  }
  finally {
    guestLoggingIn.value = false
  }
}

const onSubmit = form.handleSubmit(async (values) => {
  if (captchaRequired.value && !values.challengeAnswer?.trim()) {
    form.setFieldError('challengeAnswer', '请输入验证码结果')
    return
  }
  loading.value = true
  try {
    await appAccountStore.login({
      ...values,
      remember: values.remember === true,
      challengeToken: challengeToken.value || undefined,
      challengeAnswer: values.challengeAnswer?.trim() || undefined,
    })
    saveLoginCredentials({
      account: values.account,
      remember: values.remember === true,
    })
    captchaRequired.value = false
    challengeToken.value = ''
    challengeQuestion.value = ''
    form.setFieldValue('challengeAnswer', '')
    emits('onLogin', values.account)
  }
  catch (error) {
    const payload = error as LoginErrorPayload
    if (payload.code === 'AUTH_CAPTCHA_REQUIRED') {
      updateCaptchaState(payload.data)
    }
  }
  finally {
    loading.value = false
  }
})

function testAccount(account: string) {
  form.setFieldValue('account', account)
  form.setFieldValue('password', '123456')
  onSubmit()
}
</script>

<template>
  <div class="p-12 flex-col-stretch-center min-h-500px w-full">
    <div class="mb-6 space-y-2">
      <h3 class="text-4xl font-bold">
        欢迎使用 👋🏻
      </h3>
      <p class="text-sm text-muted-foreground lg:text-base">
        {{ title }}
      </p>
    </div>
    <div>
      <form @submit="onSubmit">
        <FormField v-slot="{ componentField, errors }" name="account">
          <FormItem class="pb-6 relative space-y-0">
            <FormControl>
              <FaInput type="text" placeholder="用户名" autocomplete="username" class="w-full" :class="{ 'border-destructive': errors.length }" v-bind="componentField">
                <template #start>
                  <FaIcon name="i-lucide:user" />
                </template>
              </FaInput>
            </FormControl>
            <Transition enter-active-class="transition-opacity" enter-from-class="opacity-0" leave-active-class="transition-opacity" leave-to-class="opacity-0">
              <FormMessage class="text-xs bottom-1 absolute" />
            </Transition>
          </FormItem>
        </FormField>
        <FormField v-slot="{ componentField, errors }" name="password">
          <FormItem class="pb-6 relative space-y-0">
            <FormControl>
              <FaInput type="password" placeholder="密码" autocomplete="current-password" class="w-full" :class="{ 'border-destructive': errors.length }" v-bind="componentField">
                <template #start>
                  <FaIcon name="i-lucide:lock" />
                </template>
              </FaInput>
            </FormControl>
            <Transition enter-active-class="transition-opacity" enter-from-class="opacity-0" leave-active-class="transition-opacity" leave-to-class="opacity-0">
              <FormMessage class="text-xs bottom-1 absolute" />
            </Transition>
          </FormItem>
        </FormField>
        <FormField v-if="captchaRequired" v-slot="{ componentField, errors }" name="challengeAnswer">
          <FormItem class="pb-6 relative space-y-0">
            <p class="mb-2 flex items-center gap-2 text-sm text-foreground">
              <FaIcon name="i-lucide:shield-check" class="size-4 text-primary" />
              <span class="font-medium">验证问题：</span>
              <span>{{ challengeQuestion || '请输入验证码' }}</span>
            </p>
            <FormControl>
              <FaInput
                type="text"
                placeholder="请输入计算结果"
                class="w-full"
                :class="{ 'border-destructive': errors.length }"
                v-bind="componentField"
              >
                <template #end>
                  <FaButton variant="link" class="h-auto p-0 text-xs" type="button" @click="refreshCaptchaChallenge">
                    换一题
                  </FaButton>
                </template>
              </FaInput>
            </FormControl>
            <Transition enter-active-class="transition-opacity" enter-from-class="opacity-0" leave-active-class="transition-opacity" leave-to-class="opacity-0">
              <FormMessage class="text-xs bottom-1 absolute" />
            </Transition>
          </FormItem>
        </FormField>
        <div class="mb-4 flex-center-between">
          <div class="flex-center-start">
            <FormField
              v-slot="{ value, handleChange }"
              name="remember"
              type="checkbox"
              :value="true"
              :unchecked-value="false"
            >
              <FormItem>
                <FormControl>
                  <FaCheckbox
                    :model-value="value === true"
                    title="密码由浏览器密码管理器保存，不会写入本地存储"
                    @update:model-value="handleChange"
                  >
                    记住账号
                  </FaCheckbox>
                </FormControl>
              </FormItem>
            </FormField>
          </div>
          <FaButton variant="link" class="p-0 h-auto" type="button" @click="emits('onResetPassword', form.values.account)">
            忘记密码?
          </FaButton>
        </div>
        <FaButton :loading="loading" size="lg" class="w-full" type="submit">
          登录
        </FaButton>
      </form>
      <div v-if="guestLoginEnabled" class="mt-4 text-center">
        <FaDivider>或</FaDivider>
        <FaButton
          variant="outline"
          size="lg"
          class="w-full"
          type="button"
          :loading="guestLoggingIn"
          @click="handleGuestLogin"
        >
          <!-- `FaButton` 只转发默认插槽，没有 `#start`：图标与文字一起放在默认插槽里 -->
          <FaIcon name="i-lucide:eye" />
          <span>{{ guestAccountLabel ? `以 ${guestAccountLabel} 身份预览` : '游客预览' }}</span>
        </FaButton>
        <p class="mt-2 text-xs text-muted-foreground">
          游客为只读账号：能查看面板内容，所有操作入口都已隐藏。
        </p>
      </div>
      <div v-if="SHOW_DEMO_ACCOUNT_ENTRY" class="mt-4 text-center -mb-4">
        <FaDivider>演示账号一键登录</FaDivider>
        <div class="space-x-2">
          <FaButton variant="default" size="sm" plain @click="testAccount('superadmin')">
            superadmin
          </FaButton>
          <FaButton variant="outline" size="sm" plain @click="testAccount('test')">
            test
          </FaButton>
        </div>
      </div>
    </div>
  </div>
</template>
