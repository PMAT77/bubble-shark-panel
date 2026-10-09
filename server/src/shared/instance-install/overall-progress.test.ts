import assert from 'node:assert/strict'
import { it } from 'node:test'
import { OverallInstallProgress } from './overall-progress'

it('uses fixed mode/backup weights and reserves 100 for committed success', () => {
  for (const mode of ['docker', 'native'] as const) {
    for (const backup of [false, true]) {
      const progress = new OverallInstallProgress(mode, backup)
      assert.equal(Object.values(progress.weights).reduce((sum, weight) => sum + weight, 0), 100)
      for (const work of Object.keys(progress.weights)) progress.complete(work as Parameters<typeof progress.complete>[0])
      assert.equal(progress.value(), 99)
    }
  }
})

it('freezes queue/retry/cancelling and does not infer downloads from an early verification', () => {
  let now = 0
  const progress = new OverallInstallProgress('docker', false, () => now)
  progress.complete('prepare')
  progress.complete('steamcmd_image')
  progress.complete('source')
  progress.beginAttempt()
  const verifiedFirst = progress.observe('verify', 100)
  assert.equal(verifiedFirst, 39)
  for (const phase of ['queue', 'retry', 'cancelling'] as const) {
    progress.observe(phase, null)
    now += 1000000
    assert.equal(progress.value(), verifiedFirst)
  }
  progress.beginAttempt()
  assert.ok(progress.observe('download', 10) >= verifiedFirst)
  assert.ok(progress.observe('download', 0) >= verifiedFirst)
})

it('bounds unknown work, gives copies a verification reserve and isolates bootstrap', () => {
  let now = 0
  const progress = new OverallInstallProgress('native', false, () => now)
  now = 100000000
  assert.ok(progress.value() <= 7)
  progress.complete('prepare')
  progress.complete('source')
  progress.beginAttempt()
  assert.ok(progress.observe('prepare', 100) <= 20)
  assert.equal(progress.observe('copy', 100), 83)
  progress.complete('files')
  assert.equal(progress.value(), 90)
  assert.equal(new OverallInstallProgress('native', false).value(), 1)
})
