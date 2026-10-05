import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './server/src/shared/db/schema/*.ts',
  out: './server/drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: 'file:./server/data/bubblesharkpanel.sqlite',
  },
  strict: true,
  verbose: true,
})
