#!/usr/bin/env bash

set -Eeuo pipefail

GSH_INSTALLER_LIB_ONLY=1
SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
if [[ "${SCRIPT_DIR}" == "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIR='.'
fi
source "${SCRIPT_DIR}/install.linux.sh"

# 版本闸门用例的两个版本：RELEASE 取安装器默认 tag（即本次发布版本），INSTALLED 模拟
# 机器上已安装的旧版本——发版时它要跟着往上挪一格。INSTALLED 必须严格小于 RELEASE，
# 否则「升级请求应被接受」会退化成同版本重装、被闸门拒绝：v0.5.0、v0.6.0 两次发布都
# 因为这个原因炸在 CI 上，所以下面用断言把它钉死，忘了改会当场报错而不是留下怪现象。
SMOKE_RELEASE_TAG="${GSH_RELEASE_TAG}"
SMOKE_INSTALLED_TAG='v0.6.0'

# v0.10.1 统一镜像：三键同值（占位 registry 待 resolve_image_registry 替换）
[[ "${GSH_RELEASE_TAG}" == "v0.10.1" ]]
[[ "${PANEL_IMAGE}" == "" ]]
[[ "${GSH_GAME_DST_IMAGE}" == "" ]]
[[ "${GSH_STEAMCMD_IMAGE}" == "" ]]
# 默认镜像池为空（由 init_installer_repo_pool 按代理清单生成）
[[ "${INSTALLER_REPO_MIRRORS}" == "" ]]
init_installer_repo_pool
[[ "${INSTALLER_REPO_MIRRORS}" == *"@v0.10.1"* ]]
[[ "${INSTALLER_REPO_MIRRORS}" == *gh-proxy.com* ]]
[[ "${PANEL_HEALTHCHECK_TIMEOUT_SECONDS}" =~ ^[0-9]+$ ]]
[[ "${PANEL_HEALTHCHECK_INTERVAL_SECONDS}" =~ ^[0-9]+$ ]]

# 统一镜像引用直接生成（GHCR 官方源；PANEL_IMAGE 可覆盖）
finalize_image_refs
[[ "${PANEL_IMAGE}" == "ghcr.io/pmat77/game-server-hub:v0.10.1" ]]
[[ "${GSH_GAME_DST_IMAGE}" == "${PANEL_IMAGE}" ]]
[[ "${GSH_STEAMCMD_IMAGE}" == "${PANEL_IMAGE}" ]]

# 安装器校验的是镜像源提供的 git blob 原始字节（LF）；Windows 检出经 core.autocrlf
# 得到的是 CRLF 工作区文件，直接哈希会与 pin 不符。先归一化为 LF 再交给安装器校验。
SMOKE_ASSET_DIR="$(mktemp -d)"
tr -d '\r' < "${SCRIPT_DIR}/../docker-compose.yml" > "${SMOKE_ASSET_DIR}/docker-compose.yml"
tr -d '\r' < "${SCRIPT_DIR}/../docker-compose.bind.yml" > "${SMOKE_ASSET_DIR}/docker-compose.bind.yml"
verify_installer_asset_checksum "docker-compose.yml" "${SMOKE_ASSET_DIR}/docker-compose.yml"
verify_installer_asset_checksum "docker-compose.bind.yml" "${SMOKE_ASSET_DIR}/docker-compose.bind.yml"

INSTALL_MODE=native
resolve_install_mode
[[ "${RESOLVED_INSTALL_MODE}" == "native" ]]
NETWORK_PROFILE=cn
resolve_network_profile
[[ "${RESOLVED_NETWORK_PROFILE}" == "cn" ]]
[[ "${USE_CN_DEBIAN_MIRROR}" == "1" ]]

SMOKE_TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${SMOKE_TMP_DIR}" "${SMOKE_ASSET_DIR}"' EXIT
SMOKE_ENV_FILE="${SMOKE_TMP_DIR}/panel.env"
printf '%s\n' \
  'ADMIN_USERNAME=keep-me' \
  'GSH_RUNTIME_MODE=native' \
  'GSH_RELEASE_VERSION=v0.1.4' \
  > "${SMOKE_ENV_FILE}"
upsert_env_values "${SMOKE_ENV_FILE}" \
  'GSH_RUNTIME_MODE=native' \
  'GSH_RELEASE_VERSION=v0.1.5'
[[ "$(read_env_value "${SMOKE_ENV_FILE}" 'ADMIN_USERNAME')" == 'keep-me' ]]
[[ "$(read_env_value "${SMOKE_ENV_FILE}" 'GSH_RELEASE_VERSION')" == 'v0.1.5' ]]
[[ "$(grep -c '^GSH_RELEASE_VERSION=' "${SMOKE_ENV_FILE}")" == '1' ]]

PANEL_LOG_DIR="${SMOKE_TMP_DIR}"
STATUS_FILE="${PANEL_LOG_DIR}/install.status"
DIAGNOSTICS_FILE="${PANEL_LOG_DIR}/install.diagnostics.log"
CURRENT_STAGE='smoke-test'
LAST_ERROR_MESSAGE='expected smoke failure'
LAST_ERROR_LINE='42'
GSH_DIAGNOSTICS_SKIP_DOCKER=1
GSH_DIAGNOSTICS_UNPRIVILEGED=1
(handle_install_exit 23) 2>/dev/null
grep -Fq '[smoke-test] [error]' "${STATUS_FILE}"
grep -Fq 'stage=smoke-test' "${DIAGNOSTICS_FILE}"
grep -Fq 'exit_code=23' "${DIAGNOSTICS_FILE}"
if grep -Fq 'ADMIN_PASSWORD' "${DIAGNOSTICS_FILE}"; then
  printf 'diagnostics unexpectedly contain ADMIN_PASSWORD\n' >&2
  exit 1
fi

# ---- ensure_compose_plugin 冒烟（stub 网络/引擎/落盘，不触真实 GitHub 与 Docker）----
COMPOSE_PLUGIN_TEST_DIR="$(mktemp -d)"
CURL_LOG="${COMPOSE_PLUGIN_TEST_DIR}/curl.log"
INSTALLED_LOG="${COMPOSE_PLUGIN_TEST_DIR}/installed.log"
PLUGIN_ERR_LOG="${COMPOSE_PLUGIN_TEST_DIR}/plugin.err.log"

# stub 原则：run_as_root 直通（CI 无 root）；install 落盘改记日志；curl 写假二进制并记录 URL；
# sha256sum 返回可控哈希；uname 按用例切换架构；docker 按 stub 模式模拟 'docker compose version'。
run_as_root() { "$@"; }
install() { printf 'install %s\n' "$*" >> "${INSTALLED_LOG}"; }
sleep() { :; }
uname() { printf '%s' "${STUB_UNAME_ARCH}"; }
docker() {
  if [[ "${STUB_COMPOSE_MODE}" == "available" ]]; then
    return 0
  fi
  if [[ "${STUB_COMPOSE_MODE}" == "after-install" && -s "${INSTALLED_LOG}" ]]; then
    return 0
  fi
  return 1
}
curl() {
  local args=("$@") out i
  for ((i = 0; i < ${#args[@]}; i++)); do
    if [[ "${args[$i]}" == "-o" ]]; then
      out="${args[$((i + 1))]}"
    fi
  done
  printf 'curl %s\n' "${args[${#args[@]} - 1]}" >> "${CURL_LOG}"
  printf 'fake-compose-binary' > "${out}"
}
sha256sum() { printf '%s  stub\n' "${STUB_DOWNLOAD_SHA256}"; }

# 用例 1：插件已可用 → 幂等跳过
STUB_UNAME_ARCH='x86_64'
STUB_COMPOSE_MODE='available'
STUB_DOWNLOAD_SHA256="${COMPOSE_PLUGIN_SHA256_X86_64}"
ensure_compose_plugin

# 用例 2：x86_64 下载 + 官方 sha256 匹配 → 落盘且 'docker compose version' 复验通过
STUB_COMPOSE_MODE='after-install'
: > "${INSTALLED_LOG}"
: > "${CURL_LOG}"
ensure_compose_plugin
grep -Fq 'docker-compose-linux-x86_64' "${CURL_LOG}"
grep -Fq 'install -m 0755' "${INSTALLED_LOG}"

# 用例 3：校验不匹配 → 全源重试后失败，错误输出含可复制的手动命令
STUB_DOWNLOAD_SHA256='deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
: > "${INSTALLED_LOG}"
if ensure_compose_plugin 2> "${PLUGIN_ERR_LOG}"; then
  printf 'ensure_compose_plugin unexpectedly succeeded on checksum mismatch\n' >&2
  exit 1
fi
grep -Fq 'Checksum mismatch' "${PLUGIN_ERR_LOG}"
grep -Fq 'sudo curl -fL --retry 3' "${PLUGIN_ERR_LOG}"
grep -Fq "${COMPOSE_PLUGIN_VERSION}" "${PLUGIN_ERR_LOG}"

# 用例 4：aarch64 架构选择
STUB_UNAME_ARCH='aarch64'
STUB_DOWNLOAD_SHA256="${COMPOSE_PLUGIN_SHA256_AARCH64}"
: > "${INSTALLED_LOG}"
: > "${CURL_LOG}"
ensure_compose_plugin
grep -Fq 'docker-compose-linux-aarch64' "${CURL_LOG}"

# ---- open_firewall_dst_ports 冒烟：主世界 + 洞穴共 6 个 UDP 端口都要放行 ----
UFW_LOG="${COMPOSE_PLUGIN_TEST_DIR}/ufw.log"
: > "${UFW_LOG}"
ufw() {
  printf 'ufw %s\n' "$*" >> "${UFW_LOG}"
}
open_firewall_dst_ports
for dst_port in "${DST_GAME_PORT}" "${DST_AUTH_PORT}" "${DST_MASTER_PORT}" \
  "${DST_CAVES_GAME_PORT}" "${DST_CAVES_AUTH_PORT}" "${DST_CAVES_MASTER_PORT}"; do
  grep -Fq "ufw allow ${dst_port}/udp" "${UFW_LOG}"
done

# ---- 面板访问地址解析冒烟：判定、优先级、回退与「零探测」----
# stub curl：记录被请求的 URL；只有回显端点按 STUB_PUBLIC_IP 返回内容，
# 元数据端点一律返回空（非云主机上的真实表现就是取不到）。
ADDRESS_PROBE_LOG="${COMPOSE_PLUGIN_TEST_DIR}/address-probe.log"
: > "${ADDRESS_PROBE_LOG}"
STUB_PUBLIC_IP=""
STUB_METADATA_IP=""
curl() {
  local url="${!#}"
  printf '%s\n' "${url}" >> "${ADDRESS_PROBE_LOG}"
  if [[ -n "${STUB_METADATA_IP}" && "${url}" == *169.254.169.254* ]]; then
    printf '%s' "${STUB_METADATA_IP}"
    return 0
  fi
  if [[ -n "${STUB_PUBLIC_IP}" && "${url}" == *ipify* ]]; then
    printf '%s' "${STUB_PUBLIC_IP}"
  fi
  return 0
}

# 1) 私有/公网 IPv4 判定（172.16/20 是真实存在的内网网段，不能被当成 docker 网桥排除）
is_private_ipv4 '172.16.0.8'
is_private_ipv4 '10.0.0.5'
is_private_ipv4 '192.168.1.1'
is_private_ipv4 '169.254.169.254'
is_private_ipv4 '100.64.1.1'
! is_private_ipv4 '111.170.172.120'
! is_private_ipv4 'gsh.example.com'
! is_private_ipv4 '999.1.1.1'
is_public_ipv4 '111.170.172.120'
! is_public_ipv4 '172.16.0.8'
! is_public_ipv4 '999.1.1.1'
! is_public_ipv4 'gsh.example.com'
[[ "$(url_host 'http://172.16.0.8:9527')" == '172.16.0.8' ]]
[[ "$(url_host 'https://gsh.example.com/panel')" == 'gsh.example.com' ]]
is_private_host '172.16.0.8'
is_private_host 'localhost'
! is_private_host 'gsh.example.com'

PANEL_PROTOCOL='http'
PANEL_PORT='9527'

# 2) 显式 PANEL_PUBLIC_URL：直接采用，且不发起任何探测请求
PANEL_HOST='172.16.0.8'
PANEL_HOST_SOURCE='interface'
PANEL_PUBLIC_URL_OVERRIDE='https://gsh.example.com'
: > "${ADDRESS_PROBE_LOG}"
resolve_panel_access_urls
[[ "${PANEL_ACCESS_URL}" == 'https://gsh.example.com' ]]
[[ "${PANEL_PUBLIC_IP_SOURCE}" == 'user' ]]
[[ ! -s "${ADDRESS_PROBE_LOG}" ]]

# 3) 显式 PANEL_HOST：同样零探测（保持既有行为，域名/反代场景不受影响）
PANEL_PUBLIC_URL_OVERRIDE=''
PANEL_HOST='203.0.113.10'
PANEL_HOST_SOURCE='user'
: > "${ADDRESS_PROBE_LOG}"
resolve_panel_access_urls
[[ "${PANEL_ACCESS_URL}" == 'http://203.0.113.10:9527' ]]
[[ ! -s "${ADDRESS_PROBE_LOG}" ]]

# 4) 网卡上本来就是公网地址：直接用网卡地址，零探测
PANEL_HOST='203.0.113.10'
PANEL_HOST_SOURCE='interface'
: > "${ADDRESS_PROBE_LOG}"
resolve_panel_access_urls
[[ "${PANEL_ACCESS_URL}" == 'http://203.0.113.10:9527' ]]
[[ "${PANEL_PUBLIC_IP_SOURCE}" == 'interface' ]]
[[ ! -s "${ADDRESS_PROBE_LOG}" ]]

# 5) 内网地址 + 探测命中：对外用探测结果，内网地址仍然并列保留
PANEL_HOST='172.16.0.8'
PANEL_HOST_SOURCE='interface'
GSH_PANEL_AUTO_PUBLIC_IP='1'
GSH_PANEL_PUBLIC_IP_BUDGET_SECONDS='3'
STUB_PUBLIC_IP='111.170.172.120'
: > "${ADDRESS_PROBE_LOG}"
resolve_panel_access_urls
[[ "${PANEL_ACCESS_URL}" == 'http://111.170.172.120:9527' ]]
[[ "${PANEL_PUBLIC_IP_SOURCE}" == 'ip_echo' ]]
[[ "${PANEL_LAN_URL}" == 'http://172.16.0.8:9527' ]]
grep -Fq 'ipify' "${ADDRESS_PROBE_LOG}"

# 6) 探测全失败：回退本机地址并标成内网（不再拿它冒充「面板地址」）
STUB_PUBLIC_IP=''
: > "${ADDRESS_PROBE_LOG}"
resolve_panel_access_urls
[[ "${PANEL_ACCESS_URL}" == 'http://172.16.0.8:9527' ]]
[[ "${PANEL_PUBLIC_IP_SOURCE}" == 'lan' ]]
[[ -s "${ADDRESS_PROBE_LOG}" ]]

# 7) 关闭探测：零请求
STUB_PUBLIC_IP='111.170.172.120'
GSH_PANEL_AUTO_PUBLIC_IP='0'
: > "${ADDRESS_PROBE_LOG}"
resolve_panel_access_urls
[[ "${PANEL_ACCESS_URL}" == 'http://172.16.0.8:9527' ]]
[[ "${PANEL_PUBLIC_IP_SOURCE}" == 'lan' ]]
[[ ! -s "${ADDRESS_PROBE_LOG}" ]]
GSH_PANEL_AUTO_PUBLIC_IP='1'

# 8) 云平台元数据命中：采信元数据结果，且不再请求出站回显端点
STUB_PUBLIC_IP=''
STUB_METADATA_IP='198.51.100.7'
: > "${ADDRESS_PROBE_LOG}"
resolve_panel_access_urls
[[ "${PANEL_ACCESS_URL}" == 'http://198.51.100.7:9527' ]]
[[ "${PANEL_PUBLIC_IP_SOURCE}" == 'cloud_metadata' ]]
grep -Fq '169.254.169.254' "${ADDRESS_PROBE_LOG}"
if grep -Fq 'ipify' "${ADDRESS_PROBE_LOG}"; then
  printf 'metadata hit should not fall back to IP echo probing\n' >&2
  exit 1
fi
STUB_METADATA_IP=''

# 9) 升级保留策略：用户设置的对外地址保留；旧值只是内网地址且本次解析到对外地址才纠正
PANEL_PUBLIC_IP_SOURCE='ip_echo'
PANEL_ACCESS_URL='http://111.170.172.120:9527'
reconcile_existing_public_url 'https://gsh.example.com'
[[ "${PANEL_ACCESS_URL}" == 'https://gsh.example.com' ]]
PANEL_ACCESS_URL='http://111.170.172.120:9527'
reconcile_existing_public_url 'http://172.16.0.8:9527'
[[ "${PANEL_ACCESS_URL}" == 'http://111.170.172.120:9527' ]]
PANEL_PUBLIC_IP_SOURCE='lan'
PANEL_ACCESS_URL='http://172.16.0.8:9527'
reconcile_existing_public_url 'http://172.16.0.8:9527'
[[ "${PANEL_ACCESS_URL}" == 'http://172.16.0.8:9527' ]]

# ---- Native 面板内更新的特权执行器与触发单元（只断言产物内容，不触碰 systemd）----
[[ "${NATIVE_UPDATE_HELPER_PATH}" == '/usr/local/lib/game-server-hub/gsh-native-update' ]]
[[ "${NATIVE_UPDATE_PATH_UNIT_FILE}" == '/etc/systemd/system/game-server-hub-update.path' ]]
[[ "${NATIVE_UPDATE_DIR}" == "${PANEL_DATA_DIR}/panel-update" ]]

NATIVE_UPDATE_SERVICE_UNIT_CONTENT="$(native_update_service_unit)"
[[ "${NATIVE_UPDATE_SERVICE_UNIT_CONTENT}" == *'Type=oneshot'* ]]
[[ "${NATIVE_UPDATE_SERVICE_UNIT_CONTENT}" == *"ExecStart=${NATIVE_UPDATE_HELPER_PATH}"* ]]
# 执行器不去猜路径：安装期定下来的真实路径必须由 unit 注入（panel.env 里没有 GSH_STACK_DIR）
[[ "${NATIVE_UPDATE_SERVICE_UNIT_CONTENT}" == *"Environment=\"GSH_PANEL_ENV_FILE=${PANEL_ENV_FILE}\""* ]]
[[ "${NATIVE_UPDATE_SERVICE_UNIT_CONTENT}" == *"Environment=\"GSH_INSTALL_DIR=${PANEL_INSTALL_DIR}\""* ]]
[[ "${NATIVE_UPDATE_SERVICE_UNIT_CONTENT}" == *"Environment=\"GSH_NATIVE_UPDATE_DIR=${NATIVE_UPDATE_DIR}\""* ]]

NATIVE_UPDATE_PATH_UNIT_CONTENT="$(native_update_path_unit)"
[[ "${NATIVE_UPDATE_PATH_UNIT_CONTENT}" == *"PathExists=${NATIVE_UPDATE_DIR}/request"* ]]
[[ "${NATIVE_UPDATE_PATH_UNIT_CONTENT}" == *"Unit=${NATIVE_UPDATE_SERVICE}"* ]]

# 执行器必须自带这几道闸：官方摘要校验、只升不降、并发保护、中断也要落终态
HELPER_SOURCE="${SCRIPT_DIR}/gsh-native-update.sh"
[[ -f "${HELPER_SOURCE}" ]]
grep -Fq 'verify_sha256' "${HELPER_SOURCE}"
grep -Fq 'is_newer_version' "${HELPER_SOURCE}"
grep -Fq 'flock -w' "${HELPER_SOURCE}"
grep -Fq 'GSH_RELEASE_TAG="${TARGET_TAG}"' "${HELPER_SOURCE}"
# root 的中间产物必须待在 root 专属子目录里：面板对交换目录有写权限，
# 定名文件直接落在那里等于给面板一个符号链接攻击面
grep -Fq 'ROOT_DIR="${UPDATE_DIR}/.root"' "${HELPER_SOURCE}"
grep -Fq 'ensure_root_dir' "${HELPER_SOURCE}"
grep -Fq 'on_exit' "${HELPER_SOURCE}"

# 升级换了 current 链接后必须重启面板，否则升级完还在跑旧版本
grep -Fq 'NATIVE_RELEASE_REPLACED' "${SCRIPT_DIR}/install.linux.sh"
grep -Fq 'try-restart game-server-hub.service' "${SCRIPT_DIR}/install.linux.sh"

# 面板侧靠 panel.env 的交换目录键判断更新组件是否就绪
printf '%s\n' 'GSH_RUNTIME_MODE=native' > "${SMOKE_ENV_FILE}"
upsert_env_values "${SMOKE_ENV_FILE}" "GSH_NATIVE_UPDATE_DIR=${NATIVE_UPDATE_DIR}"
[[ "$(read_env_value "${SMOKE_ENV_FILE}" 'GSH_NATIVE_UPDATE_DIR')" == "${NATIVE_UPDATE_DIR}" ]]

# ---- 执行器的行为（只测非特权纯逻辑：请求校验与版本闸门）----
GSH_NATIVE_UPDATE_LIB_ONLY=1
# shellcheck disable=SC1090,SC1091
source "${SCRIPT_DIR}/gsh-native-update.sh"

NATIVE_HELPER_TEST_DIR="$(mktemp -d)"
NATIVE_HELPER_ENV="${NATIVE_HELPER_TEST_DIR}/panel.env"
printf '%s\n' \
  "GSH_NATIVE_UPDATE_DIR=${NATIVE_HELPER_TEST_DIR}/panel-update" \
  "GSH_NATIVE_USER=$(id -un)" \
  "GSH_RELEASE_VERSION=${SMOKE_INSTALLED_TAG}" \
  'SERVER_PORT=9527' \
  > "${NATIVE_HELPER_ENV}"
PANEL_ENV_FILE="${NATIVE_HELPER_ENV}"
load_config
[[ "${UPDATE_DIR}" == "${NATIVE_HELPER_TEST_DIR}/panel-update" ]]
[[ "${ROOT_DIR}" == "${UPDATE_DIR}/.root" ]]
[[ "$(read_env_value "${PANEL_ENV_FILE}" 'GSH_NATIVE_USER')" == "$(id -un)" ]]

is_valid_release_tag 'v0.4.5'
is_valid_release_tag 'v0.4.5-beta.1'
! is_valid_release_tag 'v0.4'
! is_valid_release_tag 'v0.4.5; reboot'
is_newer_version 'v0.4.4' 'v0.4.5'
is_newer_version 'v0.4.5-beta.1' 'v0.4.5'
! is_newer_version 'v0.4.4' 'v0.4.4'
! is_newer_version 'v0.4.5' 'v0.4.4'
! is_newer_version 'v0.4.5' 'v0.4.5-beta.1'

mkdir -p "${ROOT_DIR}"
# 先确认「已安装版本 < 本次发布版本」，下面那条升级请求才有意义
is_newer_version "${SMOKE_INSTALLED_TAG}" "${SMOKE_RELEASE_TAG}"
TARGET_TAG=''
printf '%s\n' "${SMOKE_RELEASE_TAG}" > "${UPDATE_DIR}/request"
consume_request "${UPDATE_DIR}/request"
[[ "${TARGET_TAG}" == "${SMOKE_RELEASE_TAG}" ]]
[[ -f "${ROOT_DIR}/request.processing" ]]
[[ ! -e "${UPDATE_DIR}/request" ]]

# 同版本 / 降级请求必须被拒绝（在子 shell 里跑，fail() 的 exit 1 不会带走整个冒烟测试）
printf '%s\n' "${SMOKE_INSTALLED_TAG}" > "${UPDATE_DIR}/request"
if ( consume_request "${UPDATE_DIR}/request" ) 2>/dev/null; then
  printf 'a same-version request must be rejected\n' >&2
  exit 1
fi
printf '%s\n' 'v0.3.0' > "${UPDATE_DIR}/request"
if ( consume_request "${UPDATE_DIR}/request" ) 2>/dev/null; then
  printf 'a downgrade request must be rejected\n' >&2
  exit 1
fi
printf '%s\n' 'v0.4.5; reboot' > "${UPDATE_DIR}/request"
if ( consume_request "${UPDATE_DIR}/request" ) 2>/dev/null; then
  printf 'a request carrying shell metacharacters must be rejected\n' >&2
  exit 1
fi
rm -rf "${NATIVE_HELPER_TEST_DIR}"

rm -rf "${COMPOSE_PLUGIN_TEST_DIR}"

printf 'install-linux-smoke-ok\n'
