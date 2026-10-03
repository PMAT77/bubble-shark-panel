import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

export function backupFile(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${filePath}.bak.${timestamp}`
  fs.copyFileSync(filePath, backupPath)
  return backupPath
}

export function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
  try {
    fs.writeFileSync(tempPath, content, 'utf8')
    fs.renameSync(tempPath, filePath)
  }
  finally { fs.rmSync(tempPath, { force: true }) }
}
