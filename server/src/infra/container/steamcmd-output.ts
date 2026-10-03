/** app-info 是待解析的数据，不能按安装日志的尾部截断。 */
export const STEAMCMD_APP_INFO_MAX_BYTES = 1024 * 1024

export class SteamcmdOutput {
  private lines: string[] = []
  private bytes = 0
  private readonly full: boolean
  overflowed = false

  constructor(full: boolean) {
    this.full = full
  }

  /** 按原始文本分块计数，空白和尚未换行的输出也计入查询上限。 */
  acceptChunk(text: string): boolean {
    if (this.overflowed) {
      return false
    }
    if (this.full) {
      this.bytes += Buffer.byteLength(text, 'utf8')
      if (this.bytes > STEAMCMD_APP_INFO_MAX_BYTES) {
        this.overflowed = true
        this.lines = []
        return false
      }
    }
    return true
  }

  push(line: string): void {
    if (this.overflowed) {
      return
    }
    this.lines.push(line)
    if (!this.full && this.lines.length > 80) {
      this.lines.shift()
    }
  }

  get output(): string {
    if (this.overflowed) {
      return 'SteamCMD 版本查询输出超过 1 MiB，无法判断版本'
    }
    return (this.full ? this.lines : this.lines.slice(-20)).join('\n')
  }
}
