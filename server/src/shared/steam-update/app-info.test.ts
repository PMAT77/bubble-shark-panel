import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parsePublicBuildIdFromAppInfo } from './app-info'

const appInfoFixture = `"343050" {
  "depots" {
    "343052" { "manifests" { "public" { "gid" "5351080740317260085" } } }
    "branches" {
      "public" { "buildid" "25643504" }
      "beforemacoschanges" { "buildid" "12576213" }
      "updatebeta" { "buildid" "25540104" }
    }
  }
}`

describe('Steam public branch parser', () => {
  it('reads the requested app and ignores depot public manifests and beta branches', () => {
    assert.equal(parsePublicBuildIdFromAppInfo(appInfoFixture, '343050'), '25643504')
    assert.equal(parsePublicBuildIdFromAppInfo(appInfoFixture, '322330'), null)
    const reordered = appInfoFixture.replace('"public" { "buildid" "25643504" }', '')
      .replace('"branches" {', '"branches" { "updatebeta2" { "buildid" "999" } "public" { "buildid" "25643504" }')
    assert.equal(parsePublicBuildIdFromAppInfo(reordered, '343050'), '25643504')
  })

  it('does not interpret truncated, malformed or beta-only data as public', () => {
    for (const input of [appInfoFixture.slice(0, -2), appInfoFixture.split('\n').slice(-4).join('\n'),
      appInfoFixture.replace('"public" { "buildid" "25643504" }', ''),
      appInfoFixture.replace('"25643504"', '"unknown"'),
      appInfoFixture.replace('"public" { "buildid" "25643504" }', '"public" { "buildid" "25643504" "buildid" "123" }'),
      'SteamCMD 任务超时']) {
      assert.equal(parsePublicBuildIdFromAppInfo(input, '343050'), null)
    }
  })
})
