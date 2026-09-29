import { faker } from '@faker-js/faker'
import { defineFakeRoute } from 'vite-plugin-fake-server/client'
import { menuRouteList } from '../../../server/src/shared/menu-routes'

export default defineFakeRoute([
  {
    url: '/fake/app/route/list',
    method: 'get',
    response: () => {
      return {
        error: '',
        status: 1,
        data: menuRouteList,
      }
    },
  },
  {
    url: '/fake/app/account/login',
    method: 'post',
    response: ({ body }) => {
      return {
        error: '',
        status: 1,
        data: {
          account: body.account,
          token: `${body.account}:${faker.internet.jwt()}`,
          avatar: `https://api.dicebear.com/9.x/bottts-neutral/svg?seed=${body.account}`,
          email: `${body.account}@game.com`,
          remember: body.remember === true,
          mustChangePassword: body.account === 'superadmin',
        },
      }
    },
  },
  {
    url: '/fake/app/account/logout',
    method: 'post',
    response: () => {
      return {
        error: '',
        status: 1,
        data: {
          isSuccess: true,
        },
      }
    },
  },
  {
    url: '/fake/app/account/permission',
    method: 'get',
    response: ({ headers }) => {
      let permissions: string[] = []
      if (headers.token?.indexOf('superadmin') === 0) {
        permissions = [
          'pages.general:browse',
          'pages.form:browse',
          'pages.list:browse',
          'pages.shop:browse',
          'pages.node.instance:manage',
        ]
      }
      else if (headers.token?.indexOf('test') === 0) {
        permissions = [
          'pages.general:browse',
        ]
      }
      return {
        error: '',
        status: 1,
        data: {
          permissions,
          mustChangePassword: false,
          roleKind: 'user',
        },
      }
    },
  },
  {
    url: '/fake/app/account/password/edit',
    method: 'post',
    response: () => {
      return {
        error: '',
        status: 1,
        data: {
          isSuccess: true,
          mustChangePassword: false,
        },
      }
    },
  },
  {
    url: '/fake/app/account/password/recovery-status',
    method: 'get',
    response: () => {
      return {
        error: '',
        status: 1,
        data: {
          enabled: false,
          hint: null,
        },
      }
    },
  },
  {
    url: '/fake/app/account/password/recover',
    method: 'post',
    response: () => {
      return {
        error: '',
        status: 1,
        data: {
          isSuccess: true,
        },
      }
    },
  },
])
