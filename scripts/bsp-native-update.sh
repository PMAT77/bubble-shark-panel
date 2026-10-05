#!/usr/bin/env bash
# bsp-native-update - Native 面板的更新执行器（由 systemd path unit 触发，以 root 运行）。
#
# 触发链：
#   面板进程（非特权用户 bsp）写入 <UPDATE_DIR>/request（单行内容 = 目标 release tag）
#     -> bubblesharkpanel-update.path（PathExists）触发
#       -> bubblesharkpanel-update.service（oneshot, root）执行本脚本
#         校验请求 -> 取官方安装脚本与官方 .sha256 -> 安装 -> 重启面板 -> 健康检查 -> 失败回滚
#
# 信任根只有 GitHub Release 与官方 .sha256 资产：
#   面板预下载的压缩包只当"省流量的副本"，摘要与官方 .sha256 对不上就由本脚本自己重新下载；
#   本脚本也绝不执行面板目录里的任何内容（只按固定文件名读取字节）。
#
# 权限边界：<UPDATE_DIR> 归面板用户所有（它要写请求），因此 root 自己的中间产物
#   （锁、日志、已验证的包、panel.env 备份）一律放在 <UPDATE_DIR>/.root（root 0700），
#   并且每次运行都重新校验属主，避免面板用预先铺好的符号链接把 root 的写入引到别处。
#
# 边界：只处理 Native/systemd 部署；Docker 模式的面板内更新走 updater 容器，与本脚本无关。
set -Eeuo pipefail

# Accept legacy process settings without overriding an explicitly supplied BSP key.
for legacy_key in ${!GSH_@}; do
  brand_key="BSP_${legacy_key#GSH_}"
  if [[ ! -v "$brand_key" ]]; then
    printf -v "$brand_key" '%s' "${!legacy_key}"
    export "$brand_key"
  fi
done
unset legacy_key brand_key

SCRIPT_NAME="bsp-native-update"
default_env=/opt/bubblesharkpanel/panel.env
if [[ ! -f "$default_env" && -f /opt/game-server-hub/panel.env ]]; then default_env=/opt/game-server-hub/panel.env; fi
PANEL_ENV_FILE="${BSP_PANEL_ENV_FILE:-$default_env}"
DEFAULT_UPDATE_DIR="/var/lib/bubblesharkpanel/panel-update"
DEFAULT_INSTALL_DIR="$(dirname "$PANEL_ENV_FILE")"
DEFAULT_PANEL_USER="bsp"
if [[ "$PANEL_ENV_FILE" == /opt/game-server-hub/* ]]; then DEFAULT_PANEL_USER=gsh; DEFAULT_UPDATE_DIR=/var/lib/game-server-hub/panel-update; fi
DEFAULT_REPO="PMAT77/bubble-shark-panel"
NATIVE_SERVICE="${BSP_NATIVE_SERVICE:-bubblesharkpanel.service}"
if [[ "$PANEL_ENV_FILE" == /opt/game-server-hub/* ]]; then NATIVE_SERVICE="${BSP_NATIVE_SERVICE:-game-server-hub.service}"; fi
HEALTH_TIMEOUT_SECONDS="${BSP_NATIVE_UPDATE_HEALTH_TIMEOUT_SECONDS:-180}"
HEALTH_INTERVAL_SECONDS=3
DOWNLOAD_CONNECT_TIMEOUT_SECONDS=15
# 单个文件的下载上限：多资产 × 多候选源的最坏情况必须留在 oneshot 的 TimeoutStartSec 之内，
# 否则 systemd 会在安装中途杀掉执行器（现在的 EXIT trap 会把状态写成失败，但仍应尽量避免）。
DOWNLOAD_MAX_TIME_SECONDS="${BSP_NATIVE_UPDATE_DOWNLOAD_TIMEOUT_SECONDS:-300}"
# 同一 unit 由 systemd 保证不会并发启动；这里的锁只用于「手工执行 + unit 触发」撞车，
# 因此等一会儿就够，不必无限等待（等太久会顶到 TimeoutStartSec）。
LOCK_WAIT_SECONDS=300
GH_PROXY_SITES=('https://gh-proxy.com/' 'https://ghfast.top/' 'https://ghproxy.com/')

UPDATE_DIR=""
ROOT_DIR=""
STATE_FILE=""
LOG_FILE=""
PANEL_USER=""
REPO=""
GITHUB_PROXY=""
INSTALL_DIR=""
PANEL_PORT=""
CURRENT_TAG=""
TARGET_TAG=""
STARTED_AT=""
ROLLED_BACK="false"
STATE_FINALIZED="false"
WORK_DIR=""
HEARTBEAT_PID=""

log_info() { printf '[%s] %s\n' "${SCRIPT_NAME}" "$*"; }
log_warn() { printf '[%s] WARN: %s\n' "${SCRIPT_NAME}" "$*" >&2; }
log_error() { printf '[%s] ERROR: %s\n' "${SCRIPT_NAME}" "$*" >&2; }

usage() {
  cat <<EOF
Usage: ${SCRIPT_NAME} [--help]

Native 面板的特权更新执行器。正常由 bubblesharkpanel-update.path 触发，不需要手工调用；
排障时可以 root 直接执行，它会读取 ${DEFAULT_UPDATE_DIR}/request 并完成一次更新。

Environment overrides:
  BSP_PANEL_ENV_FILE                        panel.env 路径（默认 /opt/bubblesharkpanel/panel.env）
  BSP_INSTALL_DIR                           安装目录（默认 /opt/bubblesharkpanel）
  BSP_NATIVE_UPDATE_HEALTH_TIMEOUT_SECONDS  健康检查超时秒数（默认 180）
EOF
}

# ---------- 配置与状态 ----------

read_env_value() {
  local file="$1" key="$2" line
  [[ -r "${file}" ]] || return 0
  line="$(grep -E "^[[:space:]]*${key}=" "$file" | tail -n 1 || true)"
  if [[ -z "$line" && "$key" == BSP_* ]]; then
    local legacy_key="GSH_${key#BSP_}"
    line="$(grep -E "^[[:space:]]*${legacy_key}=" "$file" | tail -n 1 || true)"
  fi
  printf '%s' "${line#*=}"
}

load_config() {
  UPDATE_DIR="$(read_env_value "${PANEL_ENV_FILE}" "BSP_NATIVE_UPDATE_DIR")"
  UPDATE_DIR="${BSP_NATIVE_UPDATE_DIR:-${UPDATE_DIR:-${DEFAULT_UPDATE_DIR}}}"
  PANEL_USER="$(read_env_value "${PANEL_ENV_FILE}" "BSP_NATIVE_USER")"
  PANEL_USER="${BSP_NATIVE_USER:-${PANEL_USER:-${DEFAULT_PANEL_USER}}}"
  REPO="$(read_env_value "${PANEL_ENV_FILE}" "BSP_GITHUB_REPO")"
  REPO="${BSP_GITHUB_REPO:-${REPO:-${DEFAULT_REPO}}}"
  GITHUB_PROXY="$(read_env_value "${PANEL_ENV_FILE}" "BSP_GITHUB_PROXY")"
  # Native 分支不写 BSP_STACK_DIR（那是 Docker 的键）：优先用 unit 注入的 BSP_INSTALL_DIR，
  # 再退回 panel.env，最后才是默认目录——自定义安装目录下回滚才不会静默失效。
  INSTALL_DIR="$(read_env_value "${PANEL_ENV_FILE}" "BSP_INSTALL_DIR")"
  [[ -n "${INSTALL_DIR}" ]] || INSTALL_DIR="$(read_env_value "${PANEL_ENV_FILE}" "BSP_STACK_DIR")"
  INSTALL_DIR="${BSP_INSTALL_DIR:-${INSTALL_DIR:-${DEFAULT_INSTALL_DIR}}}"
  # Native 安装器写的是 SERVER_PORT（后端直接监听该端口）；PANEL_PORT 只是 Docker 分支的键。
  PANEL_PORT="$(read_env_value "${PANEL_ENV_FILE}" "SERVER_PORT")"
  [[ -n "${PANEL_PORT}" ]] || PANEL_PORT="$(read_env_value "${PANEL_ENV_FILE}" "PANEL_PORT")"
  PANEL_PORT="${PANEL_PORT:-9527}"
  CURRENT_TAG="$(read_env_value "${PANEL_ENV_FILE}" "BSP_RELEASE_VERSION")"
  NATIVE_SERVICE="${BSP_NATIVE_SERVICE:-$(read_env_value "${PANEL_ENV_FILE}" "BSP_NATIVE_SERVICE")}"
  NATIVE_SERVICE="${NATIVE_SERVICE:-bubblesharkpanel.service}"
  ROOT_DIR="${UPDATE_DIR}/.root"
  STATE_FILE="${UPDATE_DIR}/state.json"
  LOG_FILE="${ROOT_DIR}/update.log"
}

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n\r\t' '   '
}

# 状态文件放在面板可读的位置（面板要显示进度），但由 root 写、属主 root、0640：
# 面板删改它只会影响自己的显示，不会影响 root 的后续动作。
write_state() {
  local phase="$1" message="$2" rolled_back="${3:-false}" tmp now
  [[ -n "${STATE_FILE}" ]] || return 0
  mkdir -p "${UPDATE_DIR}" 2>/dev/null || return 0
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  tmp="${ROOT_DIR}/state.json.tmp.$$"
  {
    printf '{\n'
    printf '  "version": 1,\n'
    printf '  "phase": "%s",\n' "$(json_escape "${phase}")"
    printf '  "tag": "%s",\n' "$(json_escape "${TARGET_TAG}")"
    printf '  "message": "%s",\n' "$(json_escape "${message}")"
    printf '  "startedAt": "%s",\n' "$(json_escape "${STARTED_AT:-${now}}")"
    printf '  "updatedAt": "%s",\n' "${now}"
    printf '  "rolledBack": %s\n' "${rolled_back}"
    printf '}\n'
  } > "${tmp}"
  chown "root:${PANEL_USER}" "${tmp}" 2>/dev/null || true
  chmod 0640 "${tmp}" 2>/dev/null || true
  mv -f "${tmp}" "${STATE_FILE}"
  case "${phase}" in
    done|failed) STATE_FINALIZED="true" ;;
  esac
}

# 失败一律落一份 state.json：面板重启后会据此显示失败原因，而不是永远停在"更新中"。
fail() {
  local message="$1"
  log_error "${message}"
  write_state "failed" "${message}" "${ROLLED_BACK}" || true
  exit 1
}

# root 专属中间目录：拒绝符号链接与非目录，创建后强制属主 root、0700。
# 面板对 <UPDATE_DIR> 有写权限，所以每次都要重新校验，不能只在首次创建时信任。
ensure_root_dir() {
  local dir="$1"
  if [[ -L "${dir}" ]]; then
    fail "Refusing to use a symlinked directory: ${dir}"
  fi
  if [[ -e "${dir}" && ! -d "${dir}" ]]; then
    fail "Refusing to use a non-directory path: ${dir}"
  fi
  mkdir -p "${dir}"
  chown root:root "${dir}" 2>/dev/null || true
  chmod 0700 "${dir}" 2>/dev/null || true
  if [[ "$(stat -c %U "${dir}" 2>/dev/null || true)" != "root" ]]; then
    fail "Refusing to write into ${dir}: it is not owned by root"
  fi
}

# 进程提前退出（SIGTERM、机器重启、OOM）时也要留下终态，否则面板会永久停在「更新中」。
on_exit() {
  local status="$1"
  stop_state_heartbeat
  rm -rf "${WORK_DIR:-}"
  if [[ "${STATE_FINALIZED}" != "true" && -n "${STATE_FILE}" && -n "${TARGET_TAG}" ]]; then
    write_state "failed" \
      "更新被中断（退出码 ${status}）。请查看 journalctl -u ${NATIVE_SERVICE} 与 ${LOG_FILE}，然后重新发起更新。" \
      "${ROLLED_BACK}" || true
  fi
}

# 安装阶段可能跑十几分钟，期间没有别的状态写入。没有心跳的话，面板会把「running 很久没更新」
# 误判成卡死；有心跳才能让「卡住」的判定真正对应到执行器已经不在的情况。
start_state_heartbeat() {
  local message="$1"
  (
    while true; do
      sleep 60
      write_state "running" "${message}"
    done
  ) &
  HEARTBEAT_PID=$!
}

stop_state_heartbeat() {
  [[ -n "${HEARTBEAT_PID}" ]] || return 0
  kill "${HEARTBEAT_PID}" 2>/dev/null || true
  wait "${HEARTBEAT_PID}" 2>/dev/null || true
  HEARTBEAT_PID=""
}

# ---------- 版本与请求校验 ----------

is_valid_release_tag() {
  [[ "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]
}

# 只允许升级：同版本重装与降级都拒绝，避免面板被攻陷后被用来重放/降级到有漏洞的版本。
is_newer_version() {
  local current="$1" target="$2" current_base target_base
  [[ -n "${current}" ]] || return 0
  [[ "${current}" != "${target}" ]] || return 1
  # 正式版不接受换到预发布版本：与面板侧 isReleaseNewer 的口径保持一致
  if [[ "${target}" == *-* && "${current}" != *-* ]]; then
    return 1
  fi
  # 同版本号下「预发布 -> 正式版」算升级。sort -V 在这里靠不住：它把 `v0.4.5-beta.1`
  # 排在 `v0.4.5` 之后（同前缀时更长的更大），直接用 tail 判断会得出相反结论。
  current_base="${current%%-*}"
  target_base="${target%%-*}"
  if [[ "${current_base}" == "${target_base}" && "${current}" == *-* && "${target}" != *-* ]]; then
    return 0
  fi
  [[ "$(printf '%s\n%s\n' "${current}" "${target}" | sort -V | tail -n 1)" == "${target}" ]]
}

consume_request() {
  local request_file="$1" owner size
  [[ -f "${request_file}" && ! -L "${request_file}" ]] \
    || fail "Update request is not a regular file: ${request_file}"
  owner="$(stat -c %U "${request_file}" 2>/dev/null || true)"
  [[ "${owner}" == "${PANEL_USER}" ]] \
    || fail "Update request owner is ${owner:-unknown}, expected ${PANEL_USER}"
  size="$(stat -c %s "${request_file}" 2>/dev/null || printf '0')"
  [[ "${size}" =~ ^[0-9]+$ ]] || fail "Update request size is not a number"
  if (( size == 0 || size > 64 )); then
    fail "Update request size ${size} is out of the accepted range (1-64 bytes)"
  fi
  TARGET_TAG="$(head -n 1 "${request_file}" | tr -d '[:space:]')"
  is_valid_release_tag "${TARGET_TAG}" || fail "Update request tag is invalid: ${TARGET_TAG}"
  is_newer_version "${CURRENT_TAG}" "${TARGET_TAG}" \
    || fail "Refusing to install ${TARGET_TAG}: the installed version is ${CURRENT_TAG:-unknown} (only upgrades are allowed)"
  # 先移走请求文件再干活：path unit 按"文件存在"触发，留着会在下一次 daemon-reload 时重复触发。
  mv -f "${request_file}" "${ROOT_DIR}/request.processing"
}

# ---------- 下载与校验 ----------

release_asset_url() {
  printf 'https://github.com/%s/releases/download/%s/%s' "${REPO}" "${TARGET_TAG}" "$1"
}

release_asset_candidates() {
  local url="$1" prefix
  if [[ -n "${GITHUB_PROXY}" ]]; then
    printf '%s\n' "${GITHUB_PROXY%/}/${url}"
  fi
  for prefix in "${GH_PROXY_SITES[@]}"; do
    printf '%s\n' "${prefix%/}/${url}"
  done
  printf '%s\n' "${url}"
}

download_one() {
  local source="$1" dest="$2"
  log_info "Downloading ${source}"
  curl -fsSL \
    --connect-timeout "${DOWNLOAD_CONNECT_TIMEOUT_SECONDS}" \
    --max-time "${DOWNLOAD_MAX_TIME_SECONDS}" \
    -o "${dest}" "${source}"
}

# 单文件多源回退：用于官方 .sha256 本身（它是信任根，没有更上一层的摘要可校验）。
download_asset() {
  local relative_url="$1" dest="$2"
  local source
  while IFS= read -r source; do
    [[ -n "${source}" ]] || continue
    if download_one "${source}" "${dest}"; then
      return 0
    fi
    rm -f "${dest}"
  done < <(release_asset_candidates "${relative_url}")
  return 1
}

# 校验文件与它要校验的资产必须来自同一个源：否则一个被污染的代理只要提供
# 一份自洽的 (.sha256, 资产) 组合就能通过校验，而两个文件分开取时会掩盖这一点。
download_verified_pair() {
  local relative_url="$1" dest="$2"
  local source
  while IFS= read -r source; do
    [[ -n "${source}" ]] || continue
    if download_one "${source}.sha256" "${dest}.sha256" \
      && download_one "${source}" "${dest}" \
      && verify_sha256 "${dest}" "${dest}.sha256"; then
      return 0
    fi
    log_warn "Source failed or checksum mismatch: ${source}"
    rm -f "${dest}" "${dest}.sha256"
  done < <(release_asset_candidates "${relative_url}")
  return 1
}

verify_sha256() {
  local file="$1" checksum_file="$2" expected actual
  expected="$(awk 'NR == 1 { print $1 }' "${checksum_file}")"
  [[ -n "${expected}" ]] || return 1
  actual="$(sha256sum "${file}" | awk '{print $1}')"
  [[ "${expected}" == "${actual}" ]]
}

# 面板预下载的包只在"与官方 .sha256 完全一致"时才被采用，并复制到 root 私有目录，
# 避免校验通过后被面板替换（TOCTOU）。
obtain_verified_archive() {
  local official_sum_file="$1" verified_dir="$2" verified_pkg="$3"
  local pkg_name prefetched
  pkg_name="$(basename "${verified_pkg}")"
  prefetched="${UPDATE_DIR}/${TARGET_TAG}/${pkg_name}"
  ensure_root_dir "${verified_dir}"

  if [[ -f "${prefetched}" && ! -L "${prefetched}" ]]; then
    if verify_sha256 "${prefetched}" "${official_sum_file}"; then
      cp -f "${prefetched}" "${verified_pkg}"
      log_info "Reusing the panel-prefetched archive (checksum matches the official one)"
      cp -f "${official_sum_file}" "${verified_pkg}.sha256"
      return 0
    fi
    log_warn "Panel-prefetched archive does not match the official checksum; downloading it again"
  fi

  rm -f "${verified_pkg}" "${verified_pkg}.sha256"
  download_verified_pair "$(release_asset_url "${pkg_name}")" "${verified_pkg}" || return 1
  return 0
}

# 只保留本次用到的包：每次升级都会留下几百 MB，攒着会把小机器磁盘吃满。
cleanup_verified_archives() {
  local keep_pkg="$1" entry
  [[ -d "${ROOT_DIR}/verified" ]] || return 0
  for entry in "${ROOT_DIR}/verified"/*; do
    [[ -e "${entry}" ]] || continue
    case "${entry}" in
      "${keep_pkg}"|"${keep_pkg}.sha256") continue ;;
    esac
    rm -rf "${entry}"
  done
}

# ---------- 健康检查与回滚 ----------

panel_health_body() {
  curl -fsS --max-time 5 "http://127.0.0.1:${PANEL_PORT}/health" 2>/dev/null || true
}

panel_health_matches() {
  local expected="$1" body
  body="$(panel_health_body)"
  [[ -n "${body}" ]] || return 1
  [[ "${body}" == *'"mode":"native"'* ]] || return 1
  [[ "${body}" == *'"status":"running"'* ]] || return 1
  [[ "${body}" == *"\"version\":\"${expected}\""* ]]
}

wait_for_panel_health() {
  local expected="$1" deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
  while (( SECONDS < deadline )); do
    if panel_health_matches "${expected}"; then
      return 0
    fi
    sleep "${HEALTH_INTERVAL_SECONDS}"
  done
  return 1
}

last_log_line() {
  [[ -r "${LOG_FILE}" ]] || return 0
  grep -v '^[[:space:]]*$' "${LOG_FILE}" 2>/dev/null | tail -n 1 | cut -c1-200 || true
}

rollback_release() {
  local previous="$1" reason="$2" message detail
  log_error "${reason}"
  detail="$(last_log_line)"
  if [[ -n "${previous}" && -d "${previous}" ]]; then
    if ln -sfn "${previous}" "${INSTALL_DIR}/current.rollback" \
      && mv -Tf "${INSTALL_DIR}/current.rollback" "${INSTALL_DIR}/current"; then
      log_warn "Switched the release link back to ${previous}"
      ROLLED_BACK="true"
    else
      log_error "Failed to switch the release link back to ${previous}"
    fi
  else
    log_warn "No previous release was recorded; the release link was left untouched"
  fi
  # 只有真的切回旧 release 才还原 panel.env：否则会留下「配置写旧版本、代码是新版本」
  # 的组合，健康检查永远对不上，界面只会一直失败。
  if [[ "${ROLLED_BACK}" == "true" && -f "${ROOT_DIR}/panel.env.before" ]]; then
    cp -p "${ROOT_DIR}/panel.env.before" "${PANEL_ENV_FILE}" || log_warn "Failed to restore panel.env"
  fi
  systemctl restart "${NATIVE_SERVICE}" >/dev/null 2>&1 || log_warn "Failed to restart ${NATIVE_SERVICE}"
  if [[ "${ROLLED_BACK}" == "true" ]]; then
    message="${reason}. Rolled back to ${previous}. ${detail}"
  else
    message="${reason}. The previous release could not be restored automatically; rerun the installer manually. ${detail}"
  fi
  write_state "failed" "${message}" "${ROLLED_BACK}"
  log_info "Details: ${LOG_FILE} and journalctl -u ${NATIVE_SERVICE}"
}

# ---------- 主流程 ----------

main() {
  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
  fi
  if [[ "$(id -u)" -ne 0 ]]; then
    log_error "This command requires root. Try: sudo ${SCRIPT_NAME}"
    exit 1
  fi

  if [[ ! -r "${PANEL_ENV_FILE}" ]]; then
    log_error "Cannot read ${PANEL_ENV_FILE}; refusing to run without the panel configuration"
    exit 1
  fi
  load_config
  # 相对路径会让下面的 mkdir/写入落到 systemd 的工作目录（/）上，宁可直接拒绝
  if [[ "${UPDATE_DIR}" != /* ]]; then
    log_error "BSP_NATIVE_UPDATE_DIR must be an absolute path: ${UPDATE_DIR}"
    exit 1
  fi

  WORK_DIR="$(mktemp -d)"
  # EXIT 覆盖正常返回与 exit；TERM/INT 转成 exit 才能让 EXIT trap 兜住中断。
  trap 'on_exit $?' EXIT
  trap 'exit 143' TERM INT

  mkdir -p "${UPDATE_DIR}"
  chmod 0750 "${UPDATE_DIR}" 2>/dev/null || true
  ensure_root_dir "${ROOT_DIR}"

  # 同一时刻只允许一次更新：面板连点两次不该装两遍。
  exec 9>"${ROOT_DIR}/.lock"
  if ! flock -w "${LOCK_WAIT_SECONDS}" 9; then
    log_warn "Another update is still running after ${LOCK_WAIT_SECONDS}s; leaving the request in place"
    exit 0
  fi

  local request_file="${UPDATE_DIR}/request"
  if [[ ! -e "${request_file}" ]]; then
    log_info "No update request found; nothing to do"
    exit 0
  fi

  consume_request "${request_file}"
  STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  write_state "running" "Verifying and installing ${TARGET_TAG}..."

  local current_release installer_path pkg_name
  local official_sum_file verified_dir verified_pkg installer_status
  current_release="$(readlink -f "${INSTALL_DIR}/current" 2>/dev/null || true)"
  cp -p "${PANEL_ENV_FILE}" "${ROOT_DIR}/panel.env.before" 2>/dev/null || true

  # 1) 官方安装脚本：与 SECURITY.md 推荐的「下载 -> 校验 -> 执行」一致，绝不 curl | bash。
  installer_path="${WORK_DIR}/install-${TARGET_TAG}.sh"
  download_verified_pair "$(release_asset_url "install-${TARGET_TAG}.sh")" "${installer_path}" \
    || fail "Unable to download and verify install-${TARGET_TAG}.sh"

  # 2) Native Release 包：先取官方摘要，再决定复用面板预下载的还是自己下。
  release_brand=bubblesharkpanel
  if [[ "$TARGET_TAG" =~ ^v0\.([0-9]+)\. && "${BASH_REMATCH[1]}" -lt 15 ]]; then release_brand=game-server-hub; fi
  pkg_name="${release_brand}-native-${TARGET_TAG}-linux-x64.tar.gz"
  official_sum_file="${WORK_DIR}/native-${TARGET_TAG}.sha256"
  download_asset "$(release_asset_url "${pkg_name}.sha256")" "${official_sum_file}" \
    || fail "Unable to download the official checksum of ${pkg_name}"
  verified_dir="${ROOT_DIR}/verified"
  verified_pkg="${verified_dir}/${pkg_name}"
  obtain_verified_archive "${official_sum_file}" "${verified_dir}" "${verified_pkg}" \
    || fail "Unable to obtain a verified Native release archive for ${TARGET_TAG}"
  cleanup_verified_archives "${verified_pkg}"

  # 3) 交给官方安装器：它会保留 panel.env 与数据目录、原子切换 current、失败自动回滚。
  write_state "running" "Installing ${TARGET_TAG}; this takes a few minutes..."
  start_state_heartbeat "Installing ${TARGET_TAG}..."
  set +e
  env BSP_RELEASE_TAG="${TARGET_TAG}" \
      BSP_NATIVE_RELEASE_ARCHIVE="${verified_pkg}" \
      BSP_GITHUB_PROXY="${GITHUB_PROXY}" \
      bash "${installer_path}" --mode native > "${LOG_FILE}" 2>&1
  installer_status=$?
  set -e
  stop_state_heartbeat
  if (( installer_status != 0 )); then
    rollback_release "${current_release}" "The installer exited with status ${installer_status}"
    exit 1
  fi

  # 4) 让新版本真正跑起来：安装器换的是 current 符号链接，对已运行的服务不生效。
  if ! panel_health_matches "${TARGET_TAG}"; then
    log_info "Restarting ${NATIVE_SERVICE} to load ${TARGET_TAG}..."
    systemctl restart "${NATIVE_SERVICE}"
  fi
  if ! wait_for_panel_health "${TARGET_TAG}"; then
    rollback_release "${current_release}" "The panel did not become healthy on ${TARGET_TAG} within ${HEALTH_TIMEOUT_SECONDS}s"
    exit 1
  fi

  rm -f "${ROOT_DIR}/request.processing"
  write_state "done" "Updated to ${TARGET_TAG}." "false"
  log_info "Native panel updated to ${TARGET_TAG}"
}

if [[ "${BSP_NATIVE_UPDATE_LIB_ONLY:-0}" != "1" ]]; then
  main "$@"
fi
