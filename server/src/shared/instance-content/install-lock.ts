import fs from 'node:fs'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { abortable } from '../abort'

const writers = new Map<string, Promise<void>>()
const owners = new Map<string, symbol>()
const context = new AsyncLocalStorage<symbol>()

/** Network downloads do not take this lock; all writes to an installation do. */
export async function withInstallPathLock<T>(installPath: string, action: () => Promise<T>, options: {
  signal?: AbortSignal
  onQueued?: () => void | Promise<void>
} = {}): Promise<T> {
  let parent = path.resolve(installPath)
  const missing: string[] = []
  while (!fs.existsSync(parent) && path.dirname(parent) !== parent) {
    missing.unshift(path.basename(parent))
    parent = path.dirname(parent)
  }
  const key = path.join(fs.realpathSync(parent), ...missing)
  const currentOwner = context.getStore()
  if (currentOwner && owners.get(key) === currentOwner) return action()
  const previous = writers.get(key)
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  writers.set(key, current)
  let started = false
  const finish = () => { release(); if (writers.get(key) === current) writers.delete(key) }
  try {
    if (previous) await options.onQueued?.()
    await abortable(previous ?? Promise.resolve(), options.signal)
    options.signal?.throwIfAborted()
    started = true
    const owner = Symbol('installation writer')
    return await context.run(owner, async () => {
      owners.set(key, owner)
      try { return await action() }
      finally { owners.delete(key) }
    })
  }
  finally {
    if (started) finish()
    else void (previous ?? Promise.resolve()).then(finish)
  }
}
