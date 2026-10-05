export function releaseBrandName(tag: string): 'bubblesharkpanel' | 'game-server-hub' {
  const match = /^v(\d+)\.(\d+)\.(\d+)/.exec(tag)
  return match && (Number(match[1]) > 0 || Number(match[2]) >= 15) ? 'bubblesharkpanel' : 'game-server-hub'
}
