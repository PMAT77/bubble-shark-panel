#!/usr/bin/env bash
# gsh - game-server-hub 面板栈管理 CLI（v0.2.0+ 安装器自动部署到 /usr/local/bin/gsh）。
# 边界：仅管理面板栈（compose 服务或 systemd 服务），不管理 DST 实例容器——实例生命周期归面板管。
set -u
set -o pipefail

SCRIPT_NAME="gsh"
PANEL_ENV_FILE="${GSH_PANEL_ENV_FILE:-/opt/game-server-hub/panel.env}"
PANEL_ENV_FILE="${PANEL_ENV_FILE:-$PANEL_ENV_FILE}" # 兼容安装器的 PANEL_ENV_FILE 变量名
STACK_DIR=""
COMPOSE_FILES="docker-compose.yml:docker-compose.bind.yml"
PANEL_PORT="8888"
RUNTIME_MODE=""
NATIVE_SERVICE="game-server-hub.service"
DIAGNOSTICS_LOG="" # 由 load_config 依 panel.env 的日志目录解析
# swap 的大小与路径不在这里取值：安装器用 GSH_SWAP_SIZE 指定档位，若把它固化成脚本级变量，
# 函数里的 local 声明会遮蔽它，GSH_SWAP_SIZE=4G gsh setup-swap 就变成静默失效（见 cmd_setup_swap）。

# ---------- 基础输出 ----------

log_info() { printf '[gsh] %s\n' "$*"; }
log_warn() { printf '[gsh] WARN: %s\n' "$*" >&2; }
log_error() { printf '[gsh] ERROR: %s\n' "$*" >&2; }

have() { command -v "$1" >/dev/null 2>&1; }

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    log_error "This command requires root. Try: sudo $SCRIPT_NAME $*"
    exit 1
  fi
}

# ---------- 配置加载 ----------

read_env_value() {
  local file="$1" key="$2" line
  [[ -r "$file" ]] || return 0
  line="$(grep -E "^[[:space:]]*${key}=" "$file" | tail -n 1 || true)"
  printf '%s' "${line#*=}"
}

load_config() {
  if [[ -r "${PANEL_ENV_FILE}" ]]; then
    STACK_DIR="$(read_env_value "${PANEL_ENV_FILE}" "GSH_STACK_DIR")"
    COMPOSE_FILES="$(read_env_value "${PANEL_ENV_FILE}" "GSH_COMPOSE_FILES")"
    PANEL_PORT="$(read_env_value "${PANEL_ENV_FILE}" "PANEL_PORT")"
    # Native 安装器写入的是 SERVER_PORT（后端直接监听该端口），Docker 分支才写 PANEL_PORT。
    # 只读 PANEL_PORT 会让 Native 下的探活固定落到默认端口，把正常安装判成故障。
    [[ -n "${PANEL_PORT}" ]] || PANEL_PORT="$(read_env_value "${PANEL_ENV_FILE}" "SERVER_PORT")"
    local panel_log_dir
    panel_log_dir="$(read_env_value "${PANEL_ENV_FILE}" "SERVER_LOG_DIR")"
    [[ -n "${panel_log_dir}" ]] || panel_log_dir="$(read_env_value "${PANEL_ENV_FILE}" "PANEL_LOG_DIR")"
    [[ -n "${panel_log_dir}" ]] && DIAGNOSTICS_LOG="${panel_log_dir}/install.diagnostics.log"
    RUNTIME_MODE="$(read_env_value "${PANEL_ENV_FILE}" "GSH_RUNTIME_MODE")"
    local service
    service="$(read_env_value "${PANEL_ENV_FILE}" "GSH_NATIVE_SERVICE")"
    [[ -n "$service" ]] && NATIVE_SERVICE="$service"
  fi
  STACK_DIR="${STACK_DIR:-/opt/game-server-hub}"
  COMPOSE_FILES="${COMPOSE_FILES:-docker-compose.yml:docker-compose.bind.yml}"
  PANEL_PORT="${PANEL_PORT:-9527}"
  case "${RUNTIME_MODE}" in
    docker|native) ;;
    *)
      if have systemctl && systemctl list-unit-files 2>/dev/null | grep -q "^${NATIVE_SERVICE}"; then
        RUNTIME_MODE="native"
      else
        RUNTIME_MODE="docker"
      fi
      ;;
  esac
}

run_compose() {
  local -a args=()
  local file
  local IFS=':'
  for file in ${COMPOSE_FILES}; do
    args+=(-f "${STACK_DIR}/${file}")
  done
  (cd "${STACK_DIR}" && docker compose --env-file "${STACK_DIR}/panel.env" "${args[@]}" "$@")
}

# ---------- 子命令 ----------

cmd_status() {
  load_config
  log_info "Runtime mode: ${RUNTIME_MODE}"
  if [[ "${RUNTIME_MODE}" == "native" ]]; then
    systemctl status "${NATIVE_SERVICE}" --no-pager -l || true
    return 0
  fi
  if ! have docker; then
    log_error "docker not found; is Docker installed?"
    return 1
  fi
  run_compose ps
  local health
  health="$(curl -fsS --max-time 5 "http://127.0.0.1:${PANEL_PORT}/health" 2>/dev/null || true)"
  if [[ -n "$health" ]]; then
    log_info "Panel health: $health"
  else
    log_warn "Panel health: no response on http://127.0.0.1:${PANEL_PORT}/health"
  fi
}

cmd_start() {
  require_root start
  load_config
  if [[ "${RUNTIME_MODE}" == "native" ]]; then
    systemctl start "${NATIVE_SERVICE}" && log_info "Started ${NATIVE_SERVICE}."
    return
  fi
  run_compose up -d && log_info "Panel stack started."
}

cmd_stop() {
  require_root stop
  load_config
  if [[ "${RUNTIME_MODE}" == "native" ]]; then
    systemctl stop "${NATIVE_SERVICE}" && log_info "Stopped ${NATIVE_SERVICE}."
    return
  fi
  # 默认仅停面板栈；DST 实例容器由面板管理，这里不触碰。
  run_compose stop && log_info "Panel stack stopped (DST instance containers untouched)."
}

cmd_restart() {
  require_root restart
  load_config
  if [[ "${RUNTIME_MODE}" == "native" ]]; then
    systemctl restart "${NATIVE_SERVICE}" && log_info "Restarted ${NATIVE_SERVICE}."
    return
  fi
  run_compose restart && log_info "Panel stack restarted."
}

cmd_logs() {
  load_config
  if [[ "${RUNTIME_MODE}" == "native" ]]; then
    journalctl -u "${NATIVE_SERVICE}" -n 200 --no-pager "$@"
    return
  fi
  run_compose logs -n 200 --no-pager "$@"
}

cmd_update() {
  require_root update
  load_config
  if [[ "${RUNTIME_MODE}" == "native" ]]; then
    log_warn "Native mode does not use container images. Update from the panel (System settings -> Panel & game version), or upgrade with the pinned installer command shown by: gsh doctor"
    return 0
  fi
  log_info "Pulling the unified image (panel + DST + SteamCMD in one)..."
  local image
  image="$(read_env_value "${PANEL_ENV_FILE}" "PANEL_IMAGE")"
  [[ -n "$image" ]] || { log_error "PANEL_IMAGE not set in ${PANEL_ENV_FILE}."; return 1; }
  docker pull "$image" || { log_error "Image pull failed."; return 1; }
  run_compose up -d && log_info "Panel stack updated. Old images can be pruned with: docker image prune -f"
}

# 诊断：健康、容器/服务、资源、脱敏配置、安装诊断日志、版本。
cmd_doctor() {
  load_config
  local exit_code=0
  log_info "== gsh doctor =="

  log_info "-- Panel health --"
  local health
  health="$(curl -fsS --max-time 5 "http://127.0.0.1:${PANEL_PORT}/health" 2>/dev/null || true)"
  if [[ -n "$health" ]]; then
    log_info "OK: $health"
  else
    log_warn "FAIL: no response on http://127.0.0.1:${PANEL_PORT}/health"
    exit_code=1
  fi

  log_info "-- Runtime --"
  if [[ "${RUNTIME_MODE}" == "native" ]]; then
    if systemctl is-active --quiet "${NATIVE_SERVICE}"; then
      log_info "systemd service active: ${NATIVE_SERVICE}"
    else
      log_warn "systemd service NOT active: ${NATIVE_SERVICE}"
      exit_code=1
    fi
  else
    if have docker; then
      docker ps --format '{{.Names}}\t{{.Status}}\t{{.Image}}' | grep -Ei 'game-server-hub|steamcmd|dst' || log_info "(no game-server-hub containers running)"
    else
      log_warn "docker not found"
      exit_code=1
    fi
  fi

  log_info "-- Resources --"
  df -h / | sed -n '1,2p'
  free -h | sed -n '1,2p'
  if have ss; then
    ss -ltnp 2>/dev/null | grep -E "(:${PANEL_PORT})\\b" || log_info "(panel port ${PANEL_PORT} not listening)"
  elif have netstat; then
    netstat -ltnp 2>/dev/null | grep -E "(:${PANEL_PORT})\\b" || log_info "(panel port ${PANEL_PORT} not listening)"
  fi

  log_info "-- panel.env summary (secrets redacted) --"
  if [[ -r "${PANEL_ENV_FILE}" ]]; then
    grep -E '^(PANEL_PORT|PANEL_IMAGE|GSH_GAME_DST_IMAGE|GSH_STEAMCMD_IMAGE|GSH_RUNTIME_MODE|GSH_STACK_DIR|GSH_COMPOSE_FILES|GSH_RELEASE_VERSION|PANEL_DATA_DIR)=' "${PANEL_ENV_FILE}" || true
    log_info "(credential keys present and redacted)"
  else
    log_warn "panel.env not readable: ${PANEL_ENV_FILE}"
    exit_code=1
  fi

  log_info "-- Install diagnostics tail --"
  if [[ -r "${DIAGNOSTICS_LOG}" ]]; then
    tail -n 20 "${DIAGNOSTICS_LOG}"
  else
    log_info "(no ${DIAGNOSTICS_LOG})"
  fi

  log_info "-- Version --"
  local release_version
  release_version="$(read_env_value "${PANEL_ENV_FILE}" "GSH_RELEASE_VERSION" 2>/dev/null || true)"
  log_info "Release version: ${release_version:-unknown}"
  log_info "Unified image: $(read_env_value "${PANEL_ENV_FILE}" "PANEL_IMAGE" || echo unknown)"
  if [[ "${RUNTIME_MODE}" == "native" ]]; then
    local repo
    repo="$(read_env_value "${PANEL_ENV_FILE}" "GSH_GITHUB_REPO")"
    repo="${repo:-PMAT77/game-serve-hub}"
    log_info "Native upgrade (pinned, checksum-verified):"
    log_info "  # 也可以在面板「系统设置 → 面板与游戏版本」里一键更新（安装器布置好更新组件后可用）；"
    log_info "  # 面板内更新不可用时，用下面的命令在服务器上升级："
    log_info "  # 目标版本填 Release 页上的版本号（例如 v0.6.16），必须高于当前已安装版本；"
    log_info "  # 填成当前版本只会原地重装，不会升级。"
    log_info "  curl -fsSL https://raw.githubusercontent.com/${repo}/<目标版本>/scripts/install.linux.sh | sudo env GSH_RELEASE_TAG=<目标版本> bash -s -- --mode native"
    log_info "  # 已安装版本：${release_version:-未知}；国内直连 GitHub Raw 不通时，可先下载 install-<目标版本>.sh 再执行："
    log_info "  # sudo env GSH_RELEASE_TAG=<目标版本> bash install-<目标版本>.sh --mode native"
  fi

  if [[ "$exit_code" -eq 0 ]]; then
    log_info "Doctor: all checks passed."
  else
    log_warn "Doctor: some checks failed (exit ${exit_code})."
  fi
  return "$exit_code"
}

# 小内存主机一键 swap（2G 默认，可用 GSH_SWAP_SIZE 覆盖）。
# 安装器会以库方式加载本脚本并直接调用这个函数（GSH_GSH_LIB_ONLY=1），
# 所以路径与大小都在函数内取值：既让 GSH_SWAP_SIZE / GSH_SWAP_FILE 覆盖真正生效，
# 也让安装器能把 fstab / sysctl.d 重定向到自己的目录。
cmd_setup_swap() {
  require_root setup-swap
  local swap_size="${GSH_SWAP_SIZE:-2G}"
  local swap_file="${GSH_SWAP_FILE:-/swapfile-gsh}"
  local fstab_file="${GSH_SWAP_FSTAB_FILE:-/etc/fstab}"
  local sysctl_dir="${GSH_SWAP_SYSCTL_DIR:-/etc/sysctl.d}"
  if ! have swapon; then
    log_error "swapon not found; install util-linux first."
    return 1
  fi
  if swapon --show=NAME --noheadings 2>/dev/null | grep -q .; then
    log_info "Swap already active:"
    swapon --show
    return 0
  fi
  log_info "Creating ${swap_size} swapfile at ${swap_file}..."
  fallocate -l "${swap_size}" "${swap_file}" || dd if=/dev/zero of="${swap_file}" bs=1M count=2048 status=progress
  chmod 600 "${swap_file}"
  mkswap "${swap_file}"
  swapon "${swap_file}"
  if ! grep -qE "^${swap_file}[[:space:]]" "${fstab_file}"; then
    # 追加前补齐文件行尾：若 /etc/fstab 最后一行没有换行，新条目会与它拼成一行，
    # 第 6 个字段随之变成非法值，mount -a 与开机挂载都会解析失败。
    if [[ -s "${fstab_file}" && -n "$(tail -c 1 "${fstab_file}")" ]]; then
      printf '\n' >> "${fstab_file}"
    fi
    printf '%s none swap sw 0 0\n' "${swap_file}" >> "${fstab_file}"
    log_info "Added ${swap_file} to ${fstab_file}."
  fi
  if [[ -d "$sysctl_dir" ]]; then
    cat > "${sysctl_dir}/99-game-server-hub.conf" <<EOF
# game-server-hub memory pressure guards (written by gsh setup-swap)
vm.swappiness = 20
vm.min_free_kbytes = 100000
EOF
    sysctl --system >/dev/null 2>&1 || true
    log_info "Applied vm.swappiness=20 and vm.min_free_kbytes=100000."
  fi
  log_info "Swap ready:"
  swapon --show
}

# ---------- 交互菜单 ----------

print_menu() {
  cat <<'MENU'
==== game-server-hub 面板栈管理 ====
 1) 状态 status
 2) 启动 start
 3) 停止 stop
 4) 重启 restart
 5) 日志 logs
 6) 更新面板镜像 update
 7) 体检 doctor
 8) 配置 swap setup-swap
 0) 退出
MENU
}

interactive_menu() {
  load_config
  while true; do
    print_menu
    local choice
    read -r -p "选择 [0-8]: " choice
    case "$choice" in
      1) cmd_status ;;
      2) cmd_start ;;
      3) cmd_stop ;;
      4) cmd_restart ;;
      5) cmd_logs ;;
      6) cmd_update ;;
      7) cmd_doctor ;;
      8) cmd_setup_swap ;;
      0) exit 0 ;;
      *) log_warn "无效选择" ;;
    esac
    echo
  done
}

print_usage() {
  cat <<EOF
Usage: ${SCRIPT_NAME} [command]

Commands:
  status      Show panel stack status and health
  start       Start the panel stack
  stop        Stop the panel stack (DST instance containers untouched)
  restart     Restart the panel stack
  logs        Tail panel logs (200 lines)
  update      Pull the unified image and recreate the panel stack
  doctor      Diagnostics: health, runtime, resources, redacted config, logs, version
  setup-swap  Create a 2G swapfile with OOM-friendly sysctls (small-RAM hosts)

Run without arguments for the interactive menu.
Scope: this CLI manages the panel stack only; DST instance lifecycle belongs to the web panel.

Environment overrides:
  GSH_PANEL_ENV_FILE   panel.env path (default: /opt/game-server-hub/panel.env)
  GSH_SWAP_SIZE        swapfile size (default: 2G; the installer also honors it)
  GSH_SWAP_FILE        swapfile path (default: /swapfile-gsh)
  GSH_SWAP_ON_INSTALL  installer-only: 0 disables the automatic swapfile (default: 1)
EOF
}

main() {
  if [[ $# -eq 0 ]]; then
    interactive_menu
    return
  fi
  case "$1" in
    status) cmd_status ;;
    start) cmd_start ;;
    stop) cmd_stop ;;
    restart) cmd_restart ;;
    logs) shift; cmd_logs "$@" ;;
    update) cmd_update ;;
    doctor) cmd_doctor ;;
    setup-swap) cmd_setup_swap ;;
    -h|--help|help) print_usage ;;
    *) print_usage >&2; exit 1 ;;
  esac
}

# 以库方式加载（GSH_GSH_LIB_ONLY=1）时只定义函数：安装器要复用 cmd_setup_swap 在安装阶段
# 创建 swap，不能顺手把交互菜单/命令分发也跑起来。
if [[ "${GSH_GSH_LIB_ONLY:-0}" != "1" ]]; then
  main "$@"
fi
