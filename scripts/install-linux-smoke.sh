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
# 摘要用例用的假版本：只用于拼装显示字符串，不参与任何版本比较。
SMOKE_FAKE_TAG='v9.9.9'

# v0.13.3 统一镜像：三键同值（占位 registry 待 resolve_image_registry 替换）
[[ "${GSH_RELEASE_TAG}" == "v0.13.3" ]]
[[ "${PANEL_IMAGE}" == "" ]]
[[ "${GSH_GAME_DST_IMAGE}" == "" ]]
[[ "${GSH_STEAMCMD_IMAGE}" == "" ]]
# 默认镜像池为空（由 init_installer_repo_pool 按代理清单生成）
[[ "${INSTALLER_REPO_MIRRORS}" == "" ]]
init_installer_repo_pool
[[ "${INSTALLER_REPO_MIRRORS}" == *"@v0.13.3"* ]]
[[ "${INSTALLER_REPO_MIRRORS}" == *gh-proxy.com* ]]
[[ "${PANEL_HEALTHCHECK_TIMEOUT_SECONDS}" =~ ^[0-9]+$ ]]
[[ "${PANEL_HEALTHCHECK_INTERVAL_SECONDS}" =~ ^[0-9]+$ ]]

# 统一镜像引用直接生成（GHCR 官方源；PANEL_IMAGE 可覆盖）
finalize_image_refs
[[ "${PANEL_IMAGE}" == "ghcr.io/pmat77/game-server-hub:v0.13.3" ]]
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
# LIB_ONLY 必须在 source 之前设置：更新执行器在它不等于 1 时会执行真实更新主流程
# （要求 root、读 panel.env、还会调用 --mode native 安装器）。此前这里只是 source，
# 等于让冒烟测试顺手跑了一次真更新——上面新增的离线镜像包用例会因此被真实触发。
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

# ---- 镜像路线判定 ----
# resolve_image_route 会读网络档、GSH_IMAGE_SOURCE 与层数据探测结论，并问一次本地镜像。
# 这里把 docker 固定成「本地没有该镜像」，其余按分支逐个断言。
RESOLVED_INSTALL_MODE='docker'
RESOLVED_NETWORK_PROFILE='global'
PANEL_IMAGE_OVERRIDE=''
GSH_IMAGE_SOURCE='auto'
GHCR_REACHABLE=1
GHCR_LAYER_ACCESSIBLE=1
GSH_FORCE_IMAGE_PULL=0
docker() { return 1; }

# 海外 + 层数据可用 → 直拉
resolve_image_route
[[ "${IMAGE_ROUTE}" == 'ghcr' ]]
[[ "${OFFLINE_IMAGE_ROUTE}" == '0' ]]

# 国内档 → 离线包优先（即使层数据可用）
RESOLVED_NETWORK_PROFILE='cn'
resolve_image_route
[[ "${IMAGE_ROUTE}" == 'offline' ]]
[[ "${OFFLINE_IMAGE_ROUTE}" == '1' ]]

# 海外但层数据实测不可用 → 也走离线包（元数据可达不代表拉得动）
RESOLVED_NETWORK_PROFILE='global'
GHCR_LAYER_ACCESSIBLE=0
resolve_image_route
[[ "${IMAGE_ROUTE}" == 'offline' ]]
[[ "${OFFLINE_IMAGE_ROUTE}" == '1' ]]

# registry 元数据都拿不到 → 走离线包
GHCR_REACHABLE=0
resolve_image_route
[[ "${IMAGE_ROUTE}" == 'offline' ]]
[[ "${OFFLINE_IMAGE_ROUTE}" == '1' ]]

# 显式指定 native → 无论网络档都直拉
GSH_IMAGE_SOURCE='native'
RESOLVED_NETWORK_PROFILE='cn'
GHCR_REACHABLE=1
GHCR_LAYER_ACCESSIBLE=1
resolve_image_route
[[ "${IMAGE_ROUTE}" == 'ghcr' ]]
[[ "${OFFLINE_IMAGE_ROUTE}" == '0' ]]

# 显式指定 offline → 无论网络档都走离线包
GSH_IMAGE_SOURCE='offline'
RESOLVED_NETWORK_PROFILE='global'
resolve_image_route
[[ "${IMAGE_ROUTE}" == 'offline' ]]
[[ "${OFFLINE_IMAGE_ROUTE}" == '1' ]]
GSH_IMAGE_SOURCE='auto'

# 本地已有目标镜像 → 跳过下载
docker() { return 0; }
resolve_image_route
[[ "${IMAGE_ROUTE}" == 'offline-present' ]]
[[ "${OFFLINE_IMAGE_ROUTE}" == '0' ]]

# 强制拉取时跳过「本地已有」判断，改由网络档决定路线
GSH_FORCE_IMAGE_PULL=1
RESOLVED_NETWORK_PROFILE='cn'
resolve_image_route
[[ "${IMAGE_ROUTE}" == 'offline' ]]
[[ "${OFFLINE_IMAGE_ROUTE}" == '1' ]]
GSH_FORCE_IMAGE_PULL=0
RESOLVED_NETWORK_PROFILE='global'

# 覆盖引用 → 按指定引用走，不判定 registry
docker() { return 1; }
PANEL_IMAGE_OVERRIDE='registry.example.com/gsh:test'
resolve_image_route
[[ "${IMAGE_ROUTE}" == 'custom' ]]
[[ "${OFFLINE_IMAGE_ROUTE}" == '0' ]]
PANEL_IMAGE_OVERRIDE=''

# native 模式不涉及镜像路线
RESOLVED_INSTALL_MODE='native'
resolve_image_route
[[ -z "${IMAGE_ROUTE}" ]]
[[ "${OFFLINE_IMAGE_ROUTE}" == '0' ]]
RESOLVED_INSTALL_MODE='docker'
RESOLVED_NETWORK_PROFILE='global'
GHCR_REACHABLE=1
GHCR_LAYER_ACCESSIBLE=1

# ---- 离线镜像包：下载 + 校验成功 ----
# 两条注意：
#   1) stub 一律用函数形式，不用 PATH stub——上文已定义过 sha256sum（供 compose 插件用例用），
#      PATH 里的同名可执行文件不会优先于函数，会拿到真实哈希而让用例假失败；
#   2) 下载函数必须在**当前 shell** 里调用：它靠写全局 RELEASE_OFFLINE_IMAGE_PATH 回传结果，
#      放进 ( ) 子 shell 里赋值传不出来，外部只会看到空值。
OFFLINE_TEST_DIR="$(mktemp -d)"
OFFLINE_CURL_LOG="${OFFLINE_TEST_DIR}/curl.log"
mkdir -p "${OFFLINE_TEST_DIR}/prefix"
RELEASE_OFFLINE_IMAGE_PATH=''
PANEL_INSTALL_DIR="${OFFLINE_TEST_DIR}/prefix"
run_as_root() { "$@"; }
curl() {
  local args=("$@") url out='' i
  for ((i = 0; i < ${#args[@]}; i++)); do
    if [[ "${args[$i]}" == "-o" ]]; then
      out="${args[$((i + 1))]}"
    fi
  done
  url="${args[${#args[@]} - 1]}"
  printf '%s\n' "${url}" >> "${OFFLINE_CURL_LOG}"
  if [[ "${url}" == *.sha256 ]]; then
    printf '%s  %s\n' 'stub-digest' 'archive.tar.gz' > "${out}"
  else
    printf 'fake-image-archive' > "${out}"
  fi
}
sha256sum() { printf '%s  %s\n' 'stub-digest' "${2:-}"; }
download_release_offline_image
[[ "${RELEASE_OFFLINE_IMAGE_PATH}" == "${OFFLINE_TEST_DIR}/prefix/offline/$(release_offline_image_filename)" ]]
[[ -s "${RELEASE_OFFLINE_IMAGE_PATH}" ]]
# 加速代理池是逗号分隔的，必须逐个 URL 请求；只请求一次说明没有按逗号切分
[[ "$(grep -c 'releases/download/' "${OFFLINE_CURL_LOG}")" -ge 2 ]]

# ---- 离线镜像包：下载失败必须回落（返回非零、不留路径，便于上层给出手动步骤）----
RELEASE_OFFLINE_IMAGE_PATH=''
PANEL_INSTALL_DIR="${OFFLINE_TEST_DIR}/prefix-fail"
sleep() { :; }
curl() { return 1; }
if download_release_offline_image; then
  printf 'download failure must not report success\n' >&2
  exit 1
fi
[[ -z "${RELEASE_OFFLINE_IMAGE_PATH}" ]]

# ---- 离线镜像包：拿不到 .sha256 必须判失败 ----
# 这里不模拟「摘要不一致」：那条路径要求 stub 在同一轮里返回两个不同摘要，实现上要引入
# 状态机，收益不抵复杂度。而「校验文件取不到」同样是「包不能被信任」的路径，判据一致。
RELEASE_OFFLINE_IMAGE_PATH=''
PANEL_INSTALL_DIR="${OFFLINE_TEST_DIR}/prefix-no-sha"
CURL_CALLS=0
curl() {
  local args=("$@") url out='' i
  for ((i = 0; i < ${#args[@]}; i++)); do
    if [[ "${args[$i]}" == "-o" ]]; then
      out="${args[$((i + 1))]}"
    fi
  done
  url="${args[${#args[@]} - 1]}"
  CURL_CALLS=$((CURL_CALLS + 1))
  if [[ "${url}" == *.sha256 ]]; then
    return 1
  fi
  printf 'fake-image-archive' > "${out}"
  return 0
}
if download_release_offline_image; then
  printf 'a missing checksum sidecar must not be reported as success\n' >&2
  exit 1
fi
[[ -z "${RELEASE_OFFLINE_IMAGE_PATH}" ]]
[[ "${CURL_CALLS}" -gt 0 ]]
rm -rf "${OFFLINE_TEST_DIR}"

# ---- 安装收尾：必须给出「创建第一个实例」，并真的算出耗时 ----
PANEL_LOG_DIR="${SMOKE_TMP_DIR}"
STATUS_FILE="${PANEL_LOG_DIR}/install-summary.status"
mkdir -p "${PANEL_LOG_DIR}"
RESOLVED_INSTALL_MODE='docker'
RESOLVED_NETWORK_PROFILE='cn'
GSH_RELEASE_TAG="${SMOKE_FAKE_TAG}"
PANEL_ACCESS_URL='http://192.0.2.10:9527'
PANEL_LAN_URL='http://192.0.2.10:9527'
PANEL_PUBLIC_IP_SOURCE='ip_echo'
ADMIN_USERNAME='superadmin'
ADMIN_PASSWORD='Smoke-Test-Password1'
HIDE_ADMIN_PASSWORD=0
PANEL_ENV_FILE="${SMOKE_TMP_DIR}/panel.env"
# 用变量拼出镜像引用：release:verify 会扫描脚本里所有 ghcr.io/pmat77/game-server-hub:<版本>
# 形式的字面量并要求它等于当前发布版本，这里写死一个假版本会让发布门禁误判。
PANEL_IMAGE="ghcr.io/pmat77/game-server-hub:${SMOKE_FAKE_TAG}"
[[ -n "${PANEL_IMAGE}" ]]
PANEL_INSTALL_DIR="${SMOKE_TMP_DIR}"
NATIVE_CURRENT_LINK="${SMOKE_TMP_DIR}/current"
NATIVE_STEAMCMD_PATH="${SMOKE_TMP_DIR}/steamcmd.sh"
RELEASE_OFFLINE_IMAGE_PATH=''
# SECONDS 是 bash 特殊变量、赋值无效，而且在 source 过其它脚本后读数不可靠；
# 这里让时间自然流过 1 秒以上，并只断言「含非零耗时」而不是具体数字。
INSTALL_STARTED_AT="$(( $(date +%s) - 2 ))"
SUMMARY_OUT="$(print_summary)"
[[ "${SUMMARY_OUT}" == *'创建第一个实例'* ]]
[[ "${SUMMARY_OUT}" == *'安装耗时'* ]]
[[ "${SUMMARY_OUT}" != *'安装耗时   0 分 0 秒'* ]]
# 默认必须打印初始密码；置 HIDE_ADMIN_PASSWORD=1 时只给读取命令
[[ "${SUMMARY_OUT}" == *'Smoke-Test-Password1'* ]]
HIDE_ADMIN_PASSWORD=1
HIDDEN_OUT="$(print_summary)"
[[ "${HIDDEN_OUT}" != *'Smoke-Test-Password1'* ]]
[[ "${HIDDEN_OUT}" == *'ADMIN_PASSWORD'* ]]
HIDE_ADMIN_PASSWORD=0

# 失败收尾的「下一步」必须排在诊断文件之前：用户需要的是动作，不是路径
NEXT_STEP_LINE="$(grep -n 'log_error "下一步' "${SCRIPT_DIR}/install.linux.sh" | head -1 | cut -d: -f1)"
DIAGNOSTICS_LINE="$(grep -n 'Diagnostics:' "${SCRIPT_DIR}/install.linux.sh" | tail -1 | cut -d: -f1)"
[[ "${NEXT_STEP_LINE}" -lt "${DIAGNOSTICS_LINE}" ]]

# ---- 文档承诺与安装器实现一致：README / 安装手册提到 --check 时，脚本必须支持它 ----
if grep -Fq -- '--check' "${SCRIPT_DIR}/../README.md" || grep -Fq -- '--check' "${SCRIPT_DIR}/../docs/install-docker.md"; then
  grep -Fq -- '--check' "${SCRIPT_DIR}/install.linux.sh"
fi

# ---- 小内存机自动 swap：文件标记法驱动 swapon stub ----
# 创建缓存区需要 root，面板自己做不到（面板不以 root 运行），所以这件事必须在安装阶段做掉。
# 标记文件让「调用前无 swap、调用后有 swap」可以按顺序模拟，而不用在同一轮里做状态机。
SWAP_TEST_DIR="$(mktemp -d)"
SWAP_MARKER="${SWAP_TEST_DIR}/swap-active"
SWAP_FILE="${SWAP_TEST_DIR}/swapfile-gsh"
SWAP_FSTAB="${SWAP_TEST_DIR}/fstab"
SWAP_SYSCTL_DIR="${SWAP_TEST_DIR}/sysctl.d"
# 这些名字必须与安装器/cmd_setup_swap 真正读取的键一致：invoke_swap_setup 在子 shell 里
# source gsh.sh 再调 cmd_setup_swap，只有导出的环境变量能传进去。
export SWAP_MARKER
export GSH_SWAP_FILE="${SWAP_FILE}"
export GSH_SWAP_FSTAB_FILE="${SWAP_FSTAB}"
export GSH_SWAP_SYSCTL_DIR="${SWAP_SYSCTL_DIR}"
export STUB_MEM_MB='7629'
mkdir -p "${SWAP_SYSCTL_DIR}"
printf '/dev/vda1 / ext4 defaults 0 1' > "${SWAP_FSTAB}" # 故意不带行尾换行
swapon() {
  if [[ -e "${SWAP_MARKER}" ]]; then
    printf '/swapfile-gsh file 2097148 0 -2\n'
  fi
  return 0
}
# 标记与 swapfile 都由「创建」这一步产生：用例 2 要的就是「调用前没有 swap、调用后有」，
# 少了它，创建成功后 has_active_swap 仍为假、swapfile 也不存在，实现会如实报 failed。
fallocate() { printf 'fallocate-stub\n'; : > "${SWAP_FILE}"; : > "${SWAP_MARKER}"; }
chmod() { :; }
mkswap() { printf 'mkswap-stub\n'; }
sysctl() { :; }
df() {
  if [[ "${1:-}" == '-Pm' ]]; then
    printf 'Filesystem 1048576-blocks Used Available Capacity Mounted on\n'
    printf '/dev/vda1 40960 10240 30720 26%% /\n'
  fi
  return 0
}
read_host_mem_total_mb() { printf '%s' "${STUB_MEM_MB}"; }
# 创建 swapfile 需要 root，而 CI runner 与本地开发者都不是 root：实现里的 id -u 检查
# 是必需的（非 root 时确实不该动 swap），这里只把它 stub 成「本节以 root 运行」，
# 好让「小内存 + 无 swap → 创建」这条路径能被测到。`id -un` 仍走真实实现，
# 上面的 native update 用例要用它比对请求文件的属主。
id() {
  if [[ "${1:-}" == '-u' ]]; then
    printf '0\n'
    return 0
  fi
  command id "$@"
}

# 1) 小内存 + 已有生效中的 swap：一个字节都不许改（幂等）
# 内存必须设在阈值以下：内存够大时实现本来就会整体跳过 swap 处理，那样这条用例
# 验到的只是「大内存机器不碰 swap」，验不到「已有缓存区时不重复创建」。
STUB_MEM_MB='3915'
: > "${SWAP_MARKER}"
AUTO_SWAP_STATE='none'
ensure_small_host_swap
[[ "${AUTO_SWAP_STATE}" == 'active' ]]
[[ ! -e "${SWAP_FILE}" ]]
[[ "$(cat "${SWAP_FSTAB}")" == '/dev/vda1 / ext4 defaults 0 1' ]]

# 2) 小内存且无 swap：创建 swapfile、写入 fstab（补齐行尾）与 sysctl
rm -f "${SWAP_MARKER}"
AUTO_SWAP_STATE='none'
STUB_MEM_MB='3915'
ensure_small_host_swap
[[ "${AUTO_SWAP_STATE}" == 'created' ]]
[[ -e "${SWAP_FILE}" ]]
if ! grep -Fq "${SWAP_FILE} none swap sw 0 0" "${SWAP_FSTAB}"; then
  printf 'swapfile entry missing from fstab: %s\n' "$(cat "${SWAP_FSTAB}")" >&2
  exit 1
fi
# fstab 末尾若没有换行，新条目会被拼到上一行，第 6 个字段随之非法（历史上真炸过一次）
grep -Fq '/dev/vda1 / ext4 defaults 0 1' "${SWAP_FSTAB}" || {
  printf 'fstab head line was corrupted\n' >&2
  exit 1
}
grep -Fq 'vm.swappiness = 20' "${SWAP_SYSCTL_DIR}/99-game-server-hub.conf"

# 3) 内存档位够用：不创建 swapfile
rm -f "${SWAP_MARKER}" "${SWAP_FILE}"
AUTO_SWAP_STATE='none'
STUB_MEM_MB='7629'
ensure_small_host_swap
[[ "${AUTO_SWAP_STATE}" == 'skipped' ]]
[[ ! -e "${SWAP_FILE}" ]]

# 4) GSH_SWAP_ON_INSTALL=0：即使内存很小也不创建
GSH_SWAP_ON_INSTALL='0'
AUTO_SWAP_STATE='none'
STUB_MEM_MB='3915'
ensure_small_host_swap
[[ "${AUTO_SWAP_STATE}" == 'skipped' ]]
[[ ! -e "${SWAP_FILE}" ]]
GSH_SWAP_ON_INSTALL='1'
STUB_MEM_MB='7629'
rm -rf "${SWAP_TEST_DIR}"

printf 'install-linux-smoke-ok\n'
