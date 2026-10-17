import { downloadWorkshopContent } from './workshop-cdn.mjs'

if (process.argv.includes('--check-runtime')) process.exit(0)

// Only the parent process supplies paths and IDs; no game-provided code executes.
process.once('message', async input => {
  try {
    const results = await downloadWorkshopContent({ ...input, onEvent: event => process.send?.({ type: 'progress', event }) })
    process.send?.({ type: 'result', results }, () => process.exit(0))
  }
  catch (error) {
    process.send?.({ type: 'error', error: String(error.message).replace(/https?:\/\/\S+/g, '[URL]') }, () => process.exit(1))
  }
})
process.once('disconnect', () => process.exit(1))
