import fs from 'node:fs'

const candidateTag = process.argv[2]
if (!candidateTag?.startsWith('candidate-')) {
  throw new Error('Expected the current candidate tag')
}

// gh api --paginate --slurp returns an array of pages.
const pages = JSON.parse(fs.readFileSync(0, 'utf8'))
for (const version of pages.flat()) {
  const tags = version.metadata?.container?.tags ?? []
  if (tags.includes(candidateTag) && tags.every(tag => tag.startsWith('candidate-'))) {
    console.log(version.id)
  }
}
