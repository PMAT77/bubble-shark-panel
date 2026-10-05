import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  readWorkshopInstalledItem,
  readWorkshopInstalledItems,
  resolveWorkshopManifestPath,
  unixSecondsToIsoOrNull,
} from './workshop-manifest'

const tempDirs: string[] = []

function createInstallPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-workshop-manifest-'))
  tempDirs.push(dir)
  return dir
}

function writeManifest(installPath: string, content: string) {
  const manifestPath = resolveWorkshopManifestPath(installPath)
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
  fs.writeFileSync(manifestPath, content, 'utf8')
  return manifestPath
}

/** 真实 SteamCMD 清单的裁剪版：字段顺序、tab 缩进与多余段都照抄 */
const REALISTIC_MANIFEST = `"AppWorkshop"
{
	"appid"		"322330"
	"SizeOnDisk"		"275188340"
	"NeedsUpdate"		"0"
	"NeedsDownload"		"0"
	"TimeLastUpdated"		"1789572994"
	"WorkshopItemsInstalled"
	{
		"2991592240"
		{
			"size"		"6126447"
			"timeupdated"		"1789200000"
			"manifest"		"7312948703126131777"
		}
		"3050607025"
		{
			"size"		"214332"
			"timeupdated"		"1789500000"
			"manifest"		"180143985094819840"
		}
	}
	"WorkshopItemDetails"
	{
		"2991592240"
		{
			"manifest"		"7312948703126131777"
			"timeupdated"		"1789200000"
		}
	}
}
`

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('readWorkshopInstalledItems', () => {
  it('parses timeupdated per installed item and ignores the details section', () => {
    const installPath = createInstallPath()
    writeManifest(installPath, REALISTIC_MANIFEST)

    const items = readWorkshopInstalledItems(installPath)
    assert.equal(items.size, 2)
    assert.equal(items.get('2991592240')?.timeupdated, 1789200000)
    assert.equal(items.get('2991592240')?.manifest, '7312948703126131777')
    assert.equal(items.get('2991592240')?.size, 6126447)
    assert.equal(items.get('3050607025')?.timeupdated, 1789500000)
  })

  it('returns an empty map when the manifest is missing', () => {
    const installPath = createInstallPath()
    assert.equal(readWorkshopInstalledItems(installPath).size, 0)
    assert.equal(readWorkshopInstalledItem(installPath, '2991592240'), null)
  })

  it('returns an empty map for a truncated (half-written) manifest', () => {
    const installPath = createInstallPath()
    writeManifest(installPath, REALISTIC_MANIFEST.slice(0, 260))
    assert.equal(readWorkshopInstalledItems(installPath).size, 0)
  })

  it('tolerates missing or non-numeric version fields', () => {
    const installPath = createInstallPath()
    writeManifest(installPath, [
      '"AppWorkshop"',
      '{',
      '\t"WorkshopItemsInstalled"',
      '\t{',
      '\t\t"111"',
      '\t\t{',
      '\t\t\t"timeupdated"\t\t"not-a-number"',
      '\t\t}',
      '\t\t"222"',
      '\t\t{',
      '\t\t\t"size"\t\t"1024"',
      '\t\t}',
      '\t}',
      '}',
    ].join('\n'))

    const items = readWorkshopInstalledItems(installPath)
    assert.equal(items.size, 2)
    assert.equal(items.get('111')?.timeupdated, null)
    assert.equal(items.get('111')?.manifest, null)
    assert.equal(items.get('222')?.timeupdated, null)
    assert.equal(items.get('222')?.size, 1024)
  })

  it('returns an empty map when WorkshopItemsInstalled is absent', () => {
    const installPath = createInstallPath()
    writeManifest(installPath, '"AppWorkshop"\n{\n\t"appid"\t\t"322330"\n}\n')
    assert.equal(readWorkshopInstalledItems(installPath).size, 0)
  })
})

describe('readWorkshopInstalledItem', () => {
  it('returns null for an unknown workshop id and trims the lookup key', () => {
    const installPath = createInstallPath()
    writeManifest(installPath, REALISTIC_MANIFEST)
    assert.equal(readWorkshopInstalledItem(installPath, ' 3050607025 ')?.timeupdated, 1789500000)
    assert.equal(readWorkshopInstalledItem(installPath, '999999'), null)
    assert.equal(readWorkshopInstalledItem(installPath, '   '), null)
  })
})

describe('unixSecondsToIsoOrNull', () => {
  it('converts positive seconds and rejects invalid values', () => {
    assert.equal(unixSecondsToIsoOrNull(1789200000), new Date(1789200000 * 1000).toISOString())
    assert.equal(unixSecondsToIsoOrNull(0), null)
    assert.equal(unixSecondsToIsoOrNull(-1), null)
    assert.equal(unixSecondsToIsoOrNull(null), null)
    assert.equal(unixSecondsToIsoOrNull(Number.NaN), null)
  })
})
