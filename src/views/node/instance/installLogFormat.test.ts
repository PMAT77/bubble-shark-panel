import assert from 'node:assert/strict'
import { it } from 'node:test'
import { formatInstallLogForDisplay } from './installLogFormat'

it('keeps consecutive progress lines and their line breaks in raw previews', () => {
  const raw = '[0m Update state (0x61) downloading, progress: 50\rUpdate state (0x61) downloading, progress: 99\nDone'
  assert.equal(formatInstallLogForDisplay(raw), ' Update state (0x61) downloading, progress: 50\nUpdate state (0x61) downloading, progress: 99\nDone')
})
