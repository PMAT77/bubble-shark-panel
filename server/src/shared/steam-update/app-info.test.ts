import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseKeyValuesRoot, parsePublicAppInfo, parsePublicBuildIdFromAppInfo } from './app-info'

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
  it('reads public content manifest IDs without numeric precision loss and filters Linux depots', () => {
    const fixture = appInfoFixture.replace('"branches" {', `"343051" { "config" { "oslist" "windows" } "manifests" { "public" { "gid" "7604377918839582995" } } }
      "1006" { "config" { "oslist" "linux" } "manifests" { "public" { "gid" "4559160656493359681" } } }
      "branches" {`)
    const result = parsePublicAppInfo(fixture, '343050')!
    assert.equal(result.buildId, '25643504')
    assert.deepEqual(result.linuxDepots, ['1006', '343052'])
    assert.equal(result.depotManifests['343052'], '5351080740317260085')
    assert.equal(result.depotManifests['343051'], '7604377918839582995')
    assert.equal(parseKeyValuesRoot('"AppState" { "buildid" "1" "buildid" "2" }', 'AppState'), null)
  })
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
