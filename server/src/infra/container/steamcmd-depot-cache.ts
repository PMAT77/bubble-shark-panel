/** 每次 app_update 使用新容器，Depot 清单必须与游戏文件一起保留。参数独立传递，不能拼进 shell。 */
export function buildSteamcmdCachedAppUpdateCommand(installPath: string, args: string[]): string[] {
  return ['/bin/sh', '-ec', `
persistent="$1"
shift
cache="$HOME/Steam/depotcache"
mkdir -p "$persistent" "$HOME/Steam"
if [ -e "$cache" ] || [ -L "$cache" ]; then
  if [ "$(readlink "$cache" || true)" != "$persistent" ]; then
    cp -an "$cache/." "$persistent/"
    mv "$cache" "$cache.bsp-original-$$"
  fi
fi
if [ ! -L "$cache" ]; then
  ln -s "$persistent" "$cache"
fi
exec "$@"
`, 'bsp-steamcmd', `${installPath}/.bsp-steamcmd/depotcache`, '/home/steam/steamcmd/steamcmd.sh', ...args]
}
