#!/usr/bin/env bash
set -Eeuo pipefail

readonly NODE_VERSION="24.18.0"
readonly NODE_DIRECTORY="node-v${NODE_VERSION}-linux-x64"
readonly NODE_INSTALLATION_DIRECTORY="/opt/${NODE_DIRECTORY}"
readonly NODE_ALIAS_PATH="/opt/node"
readonly PRODUCTION_IP="147.15.97.227"
readonly CERTBOT_MINIMUM_VERSION="5.4.0"
readonly CERTIFICATE_MINIMUM_VALIDITY_SECONDS=$((24 * 60 * 60))
readonly ROLLBACK_MARKER="/opt/set-livre/.activation-rollback"
readonly MINIMUM_SWAPFILE_BYTES=$((1024 * 1024 * 1024))
readonly SWAPFILE_PATH="/swapfile"
SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIRECTORY
readonly SUPABASE_CA_SOURCE="${SCRIPT_DIRECTORY}/certificates/supabase-root-2021-ca.crt"
readonly DEPLOY_INSTALLER_SOURCE="${SCRIPT_DIRECTORY}/deploy-release.sh"
readonly DEPLOY_SSH_COMMAND_SOURCE="${SCRIPT_DIRECTORY}/deploy-ssh-command.sh"
readonly NGINX_HTTP_SOURCE="${SCRIPT_DIRECTORY}/nginx/set-livre-http.conf"
readonly NGINX_TLS_SOURCE="${SCRIPT_DIRECTORY}/nginx/set-livre-tls.conf"
temporary_directory=""
ipv4_rules=""
ipv6_rules=""
previous_ipv4_rules=""
previous_ipv6_rules=""
previous_persisted_ipv4=""
previous_persisted_ipv6=""
persisted_ipv4_existed=false
persisted_ipv6_existed=false
firewall_transition_active=false
fail2ban_stopped=false
digest_source=""
active_release_sha=""
active_release_compatible=false
node_staging_directory=""
node_previous_directory=""
node_alias_staging_path=""
node_alias_previous_path=""
swap_staging_file=""

fail() {
  printf 'bootstrap: %s\n' "$1" >&2
  exit 1
}

assert_legacy_surface_absent() {
  local managed_host_contract="$1"
  local path unit setting
  for path in \
    /etc/apt/apt.conf.d/52setlivre-unattended-upgrades \
    /etc/fail2ban/jail.d/setlivre-sshd.local \
    /etc/letsencrypt/renewal-hooks/deploy/setlivre-enable-tls \
    /etc/nginx/conf.d/setlivre-proxy.conf \
    /etc/nginx/sites-available/setlivre-bootstrap \
    /etc/nginx/sites-available/setlivre-tls \
    /etc/nginx/sites-enabled/setlivre \
    /etc/setlivre-deployer \
    /etc/ssh/sshd_config.d/60-setlivre-hardening.conf \
    /etc/sudoers.d/setlivre-deployer \
    /etc/sysctl.d/60-setlivre-ipv6-disabled.conf \
    /etc/systemd/system/nginx.service.d/setlivre-release-recovery.conf \
    /etc/systemd/system/multi-user.target.wants/setlivre-backoffice.service \
    /etc/systemd/system/multi-user.target.wants/setlivre-production-deployer.service \
    /etc/systemd/system/multi-user.target.wants/setlivre-release-recovery.service \
    /etc/systemd/system/multi-user.target.wants/setlivre-web.service \
    /etc/systemd/system/setlivre-backoffice.service \
    /etc/systemd/system/setlivre-production-deployer.service \
    /etc/systemd/system/setlivre-production-deployer.timer \
    /etc/systemd/system/setlivre-release-recovery.service \
    /etc/systemd/system/setlivre-web.service \
    /etc/systemd/system/timers.target.wants/setlivre-production-deployer.timer \
    /etc/tmpfiles.d/setlivre-production-deployer.conf \
    /run/lock/setlivre-production-deployer-config.lock \
    /run/lock/setlivre-production-deployer.lock \
    /run/lock/setlivre-release-manager.lock \
    /usr/local/bin/node \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /usr/local/libexec/setlivre \
    /usr/local/libexec/setlivre-host-tools \
    /usr/local/sbin/setlivre-deploy-dispatch \
    /usr/local/sbin/setlivre-enable-tls \
    /usr/local/sbin/setlivre-issue-tls-certificate \
    /usr/local/sbin/setlivre-release-manager \
    /var/lib/setlivre-bootstrap \
    /var/lib/setlivre-deployer \
    /var/lib/setlivre-deployer-config \
    /var/lib/systemd/timers/stamp-setlivre-timer-contract-probe.timer; do
    [[ ! -e ${path} && ! -L ${path} ]] \
      || fail "superfície legada ainda instalada: ${path}."
  done
  if [[ ${managed_host_contract} == false ]]; then
    for path in /opt/node-v24.18.0 /opt/setlivre; do
      [[ ! -e ${path} && ! -L ${path} ]] \
        || fail "superfície legada ainda instalada: ${path}."
    done
  fi
  for unit in \
    setlivre-backoffice.service \
    setlivre-production-deployer.service \
    setlivre-production-deployer.timer \
    setlivre-release-recovery.service \
    setlivre-web.service; do
    ! systemctl cat "$unit" >/dev/null 2>&1 \
      || fail "unit legada ainda carregada: ${unit}."
  done
  ! getent passwd setlivre >/dev/null || fail "usuário runtime legado ainda instalado."
  ! getent passwd setlivre-deployer >/dev/null || fail "usuário deployer legado ainda instalado."
  ! getent group setlivre-deployer >/dev/null || fail "grupo deployer legado ainda instalado."
  for setting in all default lo; do
    [[ $(sysctl --values "net.ipv6.conf.${setting}.disable_ipv6") == 0 ]] \
      || fail "IPv6 permanece desabilitado pelo contrato legado (${setting})."
  done
}

installed_host_contract_is_valid() {
  local marker=/etc/set-livre/host-config.sha256
  local -a marker_lines=()
  [[ -e ${marker} || -L ${marker} ]] || return 1
  [[ -f ${marker} && ! -L ${marker} ]] \
    || fail "marcador operacional instalado é inválido."
  [[ $(stat --format '%U:%G:%a' -- "$marker") == "root:setlivre:640" ]] \
    || fail "marcador operacional instalado tem owner ou modo inesperado."
  mapfile -t marker_lines < "$marker"
  [[ ${#marker_lines[@]} -eq 1 && ${marker_lines[0]} =~ ^[0-9a-f]{64}$ ]] \
    || fail "marcador operacional instalado tem conteúdo inválido."
}

node_transient_path_is_managed() {
  local path="$1"
  local prefix="/opt/.${NODE_DIRECTORY}."
  local remainder
  if [[ ${path} =~ ^/opt/[.]node-alias[.](staging|previous)[.][A-Za-z0-9]{6}$ ]]; then
    return 0
  fi
  [[ ${path} == "$prefix"* ]] || return 1
  remainder="${path:${#prefix}}"
  [[ ${remainder} =~ ^(staging|previous)\.[A-Za-z0-9]{6}$ ]]
}

remove_node_transient_path() {
  local path="$1"
  node_transient_path_is_managed "$path" || return 1
  [[ -e ${path} || -L ${path} ]] || return 0
  if [[ -L ${path} || -f ${path} ]]; then
    rm -f -- "$path"
  elif [[ -d ${path} ]] && ! mountpoint --quiet -- "$path"; then
    rm -rf --one-file-system -- "${path:?}"
  else
    return 1
  fi
}

cleanup_stale_node_transients() {
  local path
  while IFS= read -r -d '' path; do
    remove_node_transient_path "$path" || return 1
  done < <(
    find /opt -mindepth 1 -maxdepth 1 \
      \( -name ".${NODE_DIRECTORY}.staging.*" \
      -o -name ".${NODE_DIRECTORY}.previous.*" \
      -o -name '.node-alias.staging.*' \
      -o -name '.node-alias.previous.*' \) \
      -print0
  )
}

node_installation_is_valid() {
  local directory="$1"
  if [[ ${directory} != "$NODE_INSTALLATION_DIRECTORY" ]]; then
    node_transient_path_is_managed "$directory" || return 1
  fi
  python3 - "$directory" <<'PYTHON'
import os
import pathlib
import stat
import sys

root = pathlib.Path(sys.argv[1])
try:
    root_stat = root.lstat()
    resolved_root = root.resolve(strict=True)
except OSError:
    raise SystemExit(1)
if not stat.S_ISDIR(root_stat.st_mode) or root.is_symlink():
    raise SystemExit(1)
if root_stat.st_uid != 0 or root_stat.st_gid != 0 or stat.S_IMODE(root_stat.st_mode) != 0o755:
    raise SystemExit(1)

required_regular_files = (
    root / "bin/node",
    root / "lib/node_modules/npm/bin/npm-cli.js",
)
required_commands = (root / "bin/npm", root / "bin/npx")

for current_root, directory_names, file_names in os.walk(root, followlinks=False):
    for name in (*directory_names, *file_names):
        path = pathlib.Path(current_root) / name
        try:
            metadata = path.lstat()
        except OSError:
            raise SystemExit(1)
        if metadata.st_uid != 0 or metadata.st_gid != 0:
            raise SystemExit(1)
        if stat.S_ISLNK(metadata.st_mode):
            try:
                target = path.resolve(strict=True)
                target.relative_to(resolved_root)
            except (OSError, ValueError):
                raise SystemExit(1)
            if not target.is_file():
                raise SystemExit(1)
        elif stat.S_ISDIR(metadata.st_mode) or stat.S_ISREG(metadata.st_mode):
            if stat.S_IMODE(metadata.st_mode) & 0o022:
                raise SystemExit(1)
        else:
            raise SystemExit(1)

for path in required_regular_files:
    try:
        metadata = path.lstat()
    except OSError:
        raise SystemExit(1)
    if not stat.S_ISREG(metadata.st_mode):
        raise SystemExit(1)
for path in required_commands:
    try:
        target = path.resolve(strict=True)
        target.relative_to(resolved_root)
    except (OSError, ValueError):
        raise SystemExit(1)
    if not target.is_file():
        raise SystemExit(1)
if not os.access(root / "bin/node", os.X_OK):
    raise SystemExit(1)
PYTHON
  [[ "$("${directory}/bin/node" --version)" == "v${NODE_VERSION}" ]] || return 1
  local npm_version
  npm_version="$(
    "${directory}/bin/node" "${directory}/lib/node_modules/npm/bin/npm-cli.js" --version
  )" || return 1
  [[ ${npm_version} =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$ ]]
}

node_alias_is_valid() {
  [[ -L ${NODE_ALIAS_PATH} ]] || return 1
  [[ $(readlink -- "$NODE_ALIAS_PATH") == "$NODE_INSTALLATION_DIRECTORY" ]] || return 1
  [[ $(readlink --canonicalize-existing -- "$NODE_ALIAS_PATH") \
    == "$NODE_INSTALLATION_DIRECTORY" ]]
}

publish_node_alias() {
  if node_alias_is_valid; then
    cleanup_stale_node_transients \
      || fail "estado transitório do Node não pôde ser removido com segurança."
    return
  fi

  node_alias_staging_path="$(mktemp '/opt/.node-alias.staging.XXXXXX')"
  rm -f -- "$node_alias_staging_path"
  ln --symbolic -- "$NODE_INSTALLATION_DIRECTORY" "$node_alias_staging_path"
  [[ -L ${node_alias_staging_path} \
    && $(readlink -- "$node_alias_staging_path") == "$NODE_INSTALLATION_DIRECTORY" ]] \
    || fail "alias Node preparado não atende ao contrato."

  if [[ -e ${NODE_ALIAS_PATH} || -L ${NODE_ALIAS_PATH} ]]; then
    if [[ -d ${NODE_ALIAS_PATH} && ! -L ${NODE_ALIAS_PATH} ]] \
      && mountpoint --quiet -- "$NODE_ALIAS_PATH"; then
      fail "alias Node legado é um ponto de montagem; substituição automática recusada."
    fi
    if [[ ! -L ${NODE_ALIAS_PATH} && ! -f ${NODE_ALIAS_PATH} \
      && ! -d ${NODE_ALIAS_PATH} ]]; then
      fail "alias Node legado possui tipo especial; substituição automática recusada."
    fi
    node_alias_previous_path="$(mktemp --directory '/opt/.node-alias.previous.XXXXXX')"
    rmdir -- "$node_alias_previous_path"
    mv --no-target-directory -- "$NODE_ALIAS_PATH" "$node_alias_previous_path" \
      || fail "alias Node legado não pôde ser isolado."
  fi

  mv --no-target-directory -- "$node_alias_staging_path" "$NODE_ALIAS_PATH" \
    || fail "alias Node validado não pôde ser publicado."
  node_alias_staging_path=""
  node_alias_is_valid || fail "alias Node publicado diverge do runtime validado."
  if [[ -n ${node_alias_previous_path} ]]; then
    remove_node_transient_path "$node_alias_previous_path" \
      || fail "alias Node legado não pôde ser removido com segurança."
    node_alias_previous_path=""
  fi
  cleanup_stale_node_transients \
    || fail "alias Node transitório não pôde ser removido com segurança."
}

swapfile_is_active() {
  local path="$1"
  swapon --show=NAME --noheadings --raw 2>/dev/null \
    | grep --fixed-strings --line-regexp -- "$path" >/dev/null
}

swapfile_is_valid() {
  local path="$1"
  local owner group mode links bytes filesystem_type
  [[ -f ${path} && ! -L ${path} ]] || return 1
  IFS=' ' read -r owner group mode links bytes < <(
    stat --format '%u %g %a %h %s' -- "$path"
  )
  [[ ${owner} == 0 && ${group} == 0 && ${mode} == 600 && ${links} == 1 ]] || return 1
  (( bytes >= MINIMUM_SWAPFILE_BYTES )) || return 1
  filesystem_type="$(
    blkid --probe --match-tag TYPE --output value -- "$path" 2>/dev/null || true
  )"
  [[ ${filesystem_type} == swap ]]
}

remove_invalid_swapfile() {
  local path="$1"
  local resolved=""
  [[ ${path} == "$SWAPFILE_PATH" ]] || fail "caminho de swap fora do contrato."
  if swapfile_is_active "$path"; then
    swapoff -- "$path"
  elif [[ -L ${path} ]]; then
    resolved="$(readlink --canonicalize-existing -- "$path" 2>/dev/null || true)"
    if [[ -n ${resolved} ]] && swapfile_is_active "$resolved"; then
      swapoff -- "$resolved"
    fi
  fi

  if [[ -L ${path} || -f ${path} ]]; then
    rm -f -- "$path"
  elif [[ -d ${path} ]]; then
    rmdir -- "$path" || fail "diretório /swapfile não vazio; remoção automática recusada."
  elif [[ -e ${path} ]]; then
    fail "/swapfile possui tipo especial; remoção automática recusada."
  fi
}

wait_for_active_health() {
  local expected_release="$1"
  for _ in $(seq 1 30); do
    if curl --fail --silent --show-error --max-time 2 \
      http://127.0.0.1:3000/api/health/ready \
      | jq --exit-status --arg release "$expected_release" \
        '.application == "web" and .release == $release and .status == "ready"' >/dev/null \
      && curl --fail --silent --show-error --max-time 2 \
        http://127.0.0.1:3001/api/health/ready \
        | jq --exit-status --arg release "$expected_release" \
          '.application == "backoffice" and .release == $release and .status == "ready"' >/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

cleanup() {
  if [[ ${firewall_transition_active} == true ]]; then
    [[ -z ${previous_ipv4_rules} ]] || iptables-restore < "$previous_ipv4_rules" || true
    [[ -z ${previous_ipv6_rules} ]] || ip6tables-restore < "$previous_ipv6_rules" || true
    if [[ ${persisted_ipv4_existed} == true ]]; then
      install -o root -g root -m 0600 "$previous_persisted_ipv4" /etc/iptables/rules.v4 || true
    else
      rm -f -- /etc/iptables/rules.v4
    fi
    if [[ ${persisted_ipv6_existed} == true ]]; then
      install -o root -g root -m 0600 "$previous_persisted_ipv6" /etc/iptables/rules.v6 || true
    else
      rm -f -- /etc/iptables/rules.v6
    fi
  fi
  if [[ -n ${node_previous_directory} \
    && ( -e ${node_previous_directory} || -L ${node_previous_directory} ) ]]; then
    if [[ ! -e ${NODE_INSTALLATION_DIRECTORY} && ! -L ${NODE_INSTALLATION_DIRECTORY} ]]; then
      mv --no-target-directory -- "$node_previous_directory" "$NODE_INSTALLATION_DIRECTORY" \
        || true
    else
      remove_node_transient_path "$node_previous_directory" || true
    fi
  fi
  if [[ -n ${node_staging_directory} ]]; then
    remove_node_transient_path "$node_staging_directory" || true
  fi
  if [[ -n ${node_alias_previous_path} \
    && ( -e ${node_alias_previous_path} || -L ${node_alias_previous_path} ) ]]; then
    if node_alias_is_valid; then
      remove_node_transient_path "$node_alias_previous_path" || true
    else
      if [[ -L ${NODE_ALIAS_PATH} || -f ${NODE_ALIAS_PATH} ]]; then
        rm -f -- "$NODE_ALIAS_PATH" || true
      fi
      if [[ ! -e ${NODE_ALIAS_PATH} && ! -L ${NODE_ALIAS_PATH} ]]; then
        mv --no-target-directory -- "$node_alias_previous_path" "$NODE_ALIAS_PATH" || true
      fi
    fi
  fi
  if [[ -n ${node_alias_staging_path} ]]; then
    remove_node_transient_path "$node_alias_staging_path" || true
  fi
  if [[ -n ${swap_staging_file} \
    && ${swap_staging_file} =~ ^/swapfile[.]staging[.][A-Za-z0-9]{6}$ \
    && -f ${swap_staging_file} && ! -L ${swap_staging_file} ]]; then
    rm -f -- "$swap_staging_file"
  fi
  [[ -z ${temporary_directory} ]] || rm -rf -- "$temporary_directory"
  [[ -z ${ipv4_rules} ]] || rm -f -- "$ipv4_rules"
  [[ -z ${ipv6_rules} ]] || rm -f -- "$ipv6_rules"
  [[ -z ${previous_ipv4_rules} ]] || rm -f -- "$previous_ipv4_rules"
  [[ -z ${previous_ipv6_rules} ]] || rm -f -- "$previous_ipv6_rules"
  [[ -z ${previous_persisted_ipv4} ]] || rm -f -- "$previous_persisted_ipv4"
  [[ -z ${previous_persisted_ipv6} ]] || rm -f -- "$previous_persisted_ipv6"
  [[ -z ${digest_source} ]] || rm -f -- "$digest_source"
  [[ ${fail2ban_stopped} == false ]] || systemctl start fail2ban || true
}
trap cleanup EXIT

[[ ${EUID} -eq 0 ]] || fail "execute como root."
[[ $# -eq 1 ]] || fail "informe o arquivo que contém a chave pública de deploy."
for required_source in \
  "$SUPABASE_CA_SOURCE" \
  "$DEPLOY_INSTALLER_SOURCE" \
  "$DEPLOY_SSH_COMMAND_SOURCE" \
  "$NGINX_HTTP_SOURCE" \
  "$NGINX_TLS_SOURCE" \
  "${SCRIPT_DIRECTORY}/systemd/set-livre-web.service" \
  "${SCRIPT_DIRECTORY}/systemd/set-livre-backoffice.service" \
  "${SCRIPT_DIRECTORY}/systemd/set-livre-release-recovery@.service" \
  "${SCRIPT_DIRECTORY}/systemd/set-livre-release-recovery.path"; do
  [[ -f ${required_source} && ! -L ${required_source} ]] || fail "fonte operacional ausente ou inválida."
done

deploy_key_file="$(realpath -e -- "$1")"
[[ -f ${deploy_key_file} && ! -L ${deploy_key_file} ]] || fail "a chave de deploy não é um arquivo regular."
IFS= read -r deploy_key < "$deploy_key_file"
[[ ${deploy_key} =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ .*)?$ ]] || fail "a chave de deploy não é Ed25519 válida."

exec 9>/run/lock/set-livre-deploy.lock
flock --exclusive 9
managed_host_contract=false
if installed_host_contract_is_valid; then
  managed_host_contract=true
fi
assert_legacy_surface_absent "$managed_host_contract"

host_configuration_digest="$(python3 - "$SCRIPT_DIRECTORY" <<'PYTHON'
import hashlib
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
files = [
    "bootstrap-host.sh",
    "certificates/supabase-root-2021-ca.crt",
    "deploy-release.sh",
    "deploy-ssh-command.sh",
    "nginx/set-livre-http.conf",
    "nginx/set-livre-tls.conf",
    "systemd/set-livre-backoffice.service",
    "systemd/set-livre-release-recovery.path",
    "systemd/set-livre-release-recovery@.service",
    "systemd/set-livre-web.service",
]
digest = hashlib.sha256()
for relative in files:
    path = root / relative
    if not path.is_file() or path.is_symlink():
        raise SystemExit(f"fonte operacional inválida: {relative}")
    digest.update(relative.encode("utf-8"))
    digest.update(b"\0")
    digest.update(path.read_bytes())
    digest.update(b"\0")
print(digest.hexdigest())
PYTHON
)"
[[ ${host_configuration_digest} =~ ^[0-9a-f]{64}$ ]] \
  || fail "digest operacional inválido."

[[ ! -e ${ROLLBACK_MARKER} ]] \
  || fail "há uma ativação interrompida; recupere-a antes de alterar o host."
if [[ -e /opt/set-livre/current ]]; then
  [[ -L /opt/set-livre/current ]] || fail "release ativa não é link simbólico."
  active_release="$(readlink --canonicalize-existing /opt/set-livre/current)"
  [[ ${active_release} =~ ^/opt/set-livre/releases/([0-9a-f]{40})$ \
    && -d ${active_release} && ! -L ${active_release} ]] \
    || fail "release ativa aponta para destino inválido."
  active_release_sha="${BASH_REMATCH[1]}"
  [[ $(stat --format '%U' -- "$active_release") == "root" ]] \
    || fail "release ativa tem owner inesperado."
  active_manifest="${active_release}/release-manifest.json"
  [[ -f ${active_manifest} && ! -L ${active_manifest} ]] \
    || fail "release ativa não possui manifesto regular."
  if ! active_host_digest="$(python3 - "$active_manifest" "$active_release_sha" <<'PYTHON'
import json
import pathlib
import re
import sys

path, expected_sha = pathlib.Path(sys.argv[1]), sys.argv[2]
try:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    digest = manifest["hostConfiguration"]["sha256"]
except (KeyError, OSError, UnicodeError, json.JSONDecodeError, TypeError) as error:
    raise SystemExit("manifesto ilegível") from error
if manifest.get("version") != 2 or manifest.get("commit") != expected_sha:
    raise SystemExit("identidade do manifesto inválida")
if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
    raise SystemExit("digest do manifesto inválido")
print(digest)
PYTHON
  )"; then
    fail "manifesto da release ativa é inválido."
  fi
  if [[ ${active_host_digest} == "$host_configuration_digest" ]]; then
    active_release_compatible=true
  else
    systemctl stop set-livre-web.service set-livre-backoffice.service \
      || fail "não foi possível interromper a release incompatível antes do bootstrap."
  fi
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get upgrade --yes
apt-get install --yes --no-install-recommends \
  ca-certificates \
  curl \
  fail2ban \
  iptables-persistent \
  jq \
  nginx \
  openssh-server \
  python3 \
  snapd \
  unattended-upgrades \
  xz-utils

mapfile -t legacy_certbot_packages < <(
  dpkg-query --show --showformat='${binary:Package}\t${db:Status-Status}\n' 2>/dev/null \
    | awk '$2 == "installed" && ($1 ~ /^certbot(:.*)?$/ || $1 ~ /^python3-(acme|certbot[^:]*)(:.*)?$/) { print $1 }'
)
if (( ${#legacy_certbot_packages[@]} > 0 )); then
  apt-get purge --yes "${legacy_certbot_packages[@]}"
fi
if snap list certbot >/dev/null 2>&1; then
  snap refresh certbot
else
  snap install certbot --classic
fi
certbot_version="$(/snap/bin/certbot --version | awk '{ print $2 }')"
dpkg --compare-versions "$certbot_version" ge "$CERTBOT_MINIMUM_VERSION" \
  || fail "Certbot ${CERTBOT_MINIMUM_VERSION} ou superior é obrigatório para certificado de IP via webroot."

if ! node_installation_is_valid "$NODE_INSTALLATION_DIRECTORY"; then
  temporary_directory="$(mktemp -d)"
  archive="${NODE_DIRECTORY}.tar.xz"
  curl --fail --location --proto '=https' --tlsv1.2 \
    --output "${temporary_directory}/${archive}" \
    "https://nodejs.org/dist/v${NODE_VERSION}/${archive}"
  curl --fail --location --proto '=https' --tlsv1.2 \
    --output "${temporary_directory}/SHASUMS256.txt" \
    "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
  (
    cd -- "$temporary_directory"
    grep --fixed-strings " ${archive}" SHASUMS256.txt | sha256sum --check --strict
  )
  node_staging_directory="$(mktemp --directory "/opt/.${NODE_DIRECTORY}.staging.XXXXXX")"
  chmod 0755 "$node_staging_directory"
  tar --extract --xz --file "${temporary_directory}/${archive}" \
    --directory "$node_staging_directory" \
    --strip-components=1 \
    --no-same-owner \
    --no-same-permissions
  node_installation_is_valid "$node_staging_directory" \
    || fail "runtime Node preparado não atende ao contrato integral."

  if [[ -e ${NODE_INSTALLATION_DIRECTORY} || -L ${NODE_INSTALLATION_DIRECTORY} ]]; then
    node_previous_directory="$(
      mktemp --directory "/opt/.${NODE_DIRECTORY}.previous.XXXXXX"
    )"
    rmdir -- "$node_previous_directory"
    mv --no-target-directory -- "$NODE_INSTALLATION_DIRECTORY" "$node_previous_directory" \
      || fail "runtime Node inválido não pôde ser isolado."
  fi
  mv --no-target-directory -- "$node_staging_directory" "$NODE_INSTALLATION_DIRECTORY" \
    || fail "runtime Node validado não pôde ser publicado atomicamente."
  node_staging_directory=""
  cleanup_stale_node_transients \
    || fail "runtime Node transitório não pôde ser removido com segurança."
  node_previous_directory=""
  rm -rf -- "$temporary_directory"
  temporary_directory=""
else
  cleanup_stale_node_transients \
    || fail "runtime Node transitório não pôde ser removido com segurança."
fi
node_installation_is_valid "$NODE_INSTALLATION_DIRECTORY" \
  || fail "runtime Node instalado não atende ao contrato integral."
publish_node_alias

for service_group in setlivre setlivre-web setlivre-backoffice; do
  if ! getent group "$service_group" >/dev/null; then
    groupadd --system "$service_group"
  fi
done
for service_identity in setlivre-web setlivre-backoffice; do
  if ! getent passwd "$service_identity" >/dev/null; then
    useradd --system --gid "$service_identity" --groups setlivre \
      --home-dir /nonexistent --shell /usr/sbin/nologin "$service_identity"
  else
    usermod --append --groups setlivre "$service_identity"
  fi
done
if ! getent passwd deploy-setlivre >/dev/null; then
  useradd --create-home --shell /bin/bash deploy-setlivre
fi

install -d -o root -g setlivre -m 0750 /etc/set-livre /opt/set-livre /opt/set-livre/releases
if [[ ${managed_host_contract} == true ]]; then
  install -o root -g setlivre -m 0640 /etc/set-livre/host-config.sha256 \
    /etc/set-livre/host-config.previous.sha256
  rm -f -- /etc/set-livre/host-config.sha256
fi
install -d -o root -g root -m 0755 /var/www/set-livre-acme/.well-known/acme-challenge
install -o root -g root -m 0644 "${SUPABASE_CA_SOURCE}" /etc/set-livre/supabase-root-2021-ca.crt
install -d -o deploy-setlivre -g deploy-setlivre -m 0700 /home/deploy-setlivre/.ssh
install -d -o deploy-setlivre -g deploy-setlivre -m 0700 /home/deploy-setlivre/incoming
incoming_lock=/home/deploy-setlivre/incoming/.incoming.lock
if [[ ! -e ${incoming_lock} ]]; then
  install -o deploy-setlivre -g deploy-setlivre -m 0600 /dev/null "$incoming_lock"
fi
[[ -f ${incoming_lock} && ! -L ${incoming_lock} \
  && $(stat --format '%U:%G' -- "$incoming_lock") == "deploy-setlivre:deploy-setlivre" ]] \
  || fail "lock de upload instalado é inválido."
chmod 0600 "$incoming_lock"
printf 'restrict,command="/usr/local/sbin/set-livre-deploy-ssh" %s\n' "$deploy_key" \
  > /home/deploy-setlivre/.ssh/authorized_keys
chown deploy-setlivre:deploy-setlivre /home/deploy-setlivre/.ssh/authorized_keys
chmod 0600 /home/deploy-setlivre/.ssh/authorized_keys

install -o root -g root -m 0755 "$DEPLOY_INSTALLER_SOURCE" /usr/local/sbin/set-livre-deploy
install -o root -g root -m 0755 "$DEPLOY_SSH_COMMAND_SOURCE" /usr/local/sbin/set-livre-deploy-ssh
install -o root -g root -m 0644 "${SCRIPT_DIRECTORY}/systemd/set-livre-web.service" /etc/systemd/system/set-livre-web.service
install -o root -g root -m 0644 "${SCRIPT_DIRECTORY}/systemd/set-livre-backoffice.service" /etc/systemd/system/set-livre-backoffice.service
install -o root -g root -m 0644 "${SCRIPT_DIRECTORY}/systemd/set-livre-release-recovery@.service" \
  /etc/systemd/system/set-livre-release-recovery@.service
install -o root -g root -m 0644 "${SCRIPT_DIRECTORY}/systemd/set-livre-release-recovery.path" \
  /etc/systemd/system/set-livre-release-recovery.path
systemctl stop set-livre-release-recovery.service 2>/dev/null || true
rm -f -- /etc/systemd/system/set-livre-release-recovery.service
install -d -o root -g root -m 0755 /usr/local/share/set-livre
install -o root -g root -m 0644 "$NGINX_HTTP_SOURCE" /usr/local/share/set-livre/nginx-http.conf
install -o root -g root -m 0644 "$NGINX_TLS_SOURCE" /usr/local/share/set-livre/nginx-tls.conf

active_nginx_source=/usr/local/share/set-livre/nginx-http.conf
certificate_path="/etc/letsencrypt/live/${PRODUCTION_IP}/fullchain.pem"
private_key_path="/etc/letsencrypt/live/${PRODUCTION_IP}/privkey.pem"
if [[ -f ${certificate_path} || -f ${private_key_path} ]]; then
  [[ -f ${certificate_path} && -f ${private_key_path} ]] \
    || fail "certificado TLS de IP está incompleto."
  openssl x509 -checkend "$CERTIFICATE_MINIMUM_VALIDITY_SECONDS" -noout \
    -in "$certificate_path" \
    || fail "certificado TLS de IP expira em menos de 24 horas."
  openssl x509 -checkip "$PRODUCTION_IP" -noout -in "$certificate_path" \
    || fail "certificado TLS não cobre o IP de produção."
  active_nginx_source=/usr/local/share/set-livre/nginx-tls.conf
fi
install -o root -g root -m 0644 "$active_nginx_source" /etc/nginx/sites-available/set-livre
ln --symbolic --force /etc/nginx/sites-available/set-livre /etc/nginx/sites-enabled/set-livre
rm -f -- /etc/nginx/sites-enabled/default

install -d -o root -g root -m 0755 /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/set-livre-reload-nginx <<'RENEWAL_HOOK'
#!/bin/sh
set -eu
nginx -t
systemctl reload nginx
RENEWAL_HOOK
chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/set-livre-reload-nginx

cat > /etc/sudoers.d/set-livre-deploy <<'SUDOERS'
deploy-setlivre ALL=(root) NOPASSWD: /usr/local/sbin/set-livre-deploy
SUDOERS
chmod 0440 /etc/sudoers.d/set-livre-deploy
visudo --check --file /etc/sudoers.d/set-livre-deploy

cat > /etc/ssh/sshd_config.d/60-set-livre.conf <<'SSHD'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
AuthenticationMethods publickey
PermitEmptyPasswords no
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding no
GatewayPorts no
PermitTunnel no
AllowUsers ubuntu deploy-setlivre
SSHD
sshd -t
systemctl reload ssh

cat > /etc/fail2ban/jail.d/set-livre-sshd.local <<'FAIL2BAN'
[sshd]
enabled = true
backend = systemd
bantime = 1h
findtime = 10m
maxretry = 5
FAIL2BAN
chown root:root /etc/fail2ban/jail.d/set-livre-sshd.local
chmod 0644 /etc/fail2ban/jail.d/set-livre-sshd.local

# Ubuntu images supplied by Oracle depend on the InstanceServices OUTPUT chain for boot-volume and
# metadata traffic. Build and validate a complete replacement ruleset before one restore transaction.
if dpkg-query --show --showformat='${db:Status-Status}\n' ufw 2>/dev/null \
  | grep --quiet --line-regexp installed; then
  fail "UFW instalado; a imagem Oracle dedicada deve usar somente o contrato iptables versionado."
fi
iptables -w -S InstanceServices >/dev/null 2>&1 || fail "chain InstanceServices da Oracle ausente."
iptables-save -t filter | grep --extended-regexp '^-A OUTPUT .* -j InstanceServices$' >/dev/null \
  || fail "salto OUTPUT para InstanceServices ausente."
oracle_rules_before="$({
  iptables-save -t filter \
    | grep --extended-regexp '^:InstanceServices |^-A OUTPUT .* -j InstanceServices$|^-A InstanceServices '
} | sha256sum | cut -d ' ' -f 1)"

systemctl stop fail2ban || true
fail2ban_stopped=true
previous_ipv4_rules="$(mktemp)"
previous_ipv6_rules="$(mktemp)"
iptables-save > "$previous_ipv4_rules"
ip6tables-save > "$previous_ipv6_rules"
iptables-restore --test < "$previous_ipv4_rules"
ip6tables-restore --test < "$previous_ipv6_rules"

if [[ -e /etc/iptables/rules.v4 ]]; then
  [[ -f /etc/iptables/rules.v4 && ! -L /etc/iptables/rules.v4 ]] \
    || fail "rules.v4 persistido é inválido."
  previous_persisted_ipv4="$(mktemp)"
  install -o root -g root -m 0600 /etc/iptables/rules.v4 "$previous_persisted_ipv4"
  persisted_ipv4_existed=true
fi
if [[ -e /etc/iptables/rules.v6 ]]; then
  [[ -f /etc/iptables/rules.v6 && ! -L /etc/iptables/rules.v6 ]] \
    || fail "rules.v6 persistido é inválido."
  previous_persisted_ipv6="$(mktemp)"
  install -o root -g root -m 0600 /etc/iptables/rules.v6 "$previous_persisted_ipv6"
  persisted_ipv6_existed=true
fi

ipv4_rules="$(mktemp)"
ipv6_rules="$(mktemp)"
python3 - \
  "$previous_ipv4_rules" "$ipv4_rules" SETLIVRE_INPUT ipv4 \
  "$previous_ipv6_rules" "$ipv6_rules" SETLIVRE6_INPUT ipv6 <<'PYTHON'
import pathlib
import re
import sys

def rewrite(source, destination, chain, family):
    policy = [
        f"-A {chain} -i lo -j ACCEPT",
        f"-A {chain} -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT",
    ]
    if family == "ipv4":
        policy.extend(
            (
                f"-A {chain} -p udp --sport 67 --dport 68 -j ACCEPT",
                f"-A {chain} -p icmp --icmp-type fragmentation-needed -j ACCEPT",
            )
        )
    else:
        policy.append(f"-A {chain} -p ipv6-icmp -j ACCEPT")
    policy.extend(
        f"-A {chain} -p tcp --dport {port} -m conntrack --ctstate NEW -j ACCEPT"
        for port in (22, 80, 443)
    )
    policy.append(f"-A {chain} -j DROP")

    lines = pathlib.Path(source).read_text(encoding="utf-8").splitlines()
    result = []
    in_filter = False
    found_filter = False
    inserted = False
    for line in lines:
        if line == "*filter":
            in_filter = True
            found_filter = True
            inserted = False
            result.append(line)
            continue
        if in_filter and (
            line.startswith(f":{chain} ")
            or line == f"-A INPUT -j {chain}"
            or line.startswith(f"-A {chain} ")
        ):
            continue
        if in_filter and not inserted and (line.startswith("-A ") or line == "COMMIT"):
            result.extend((f":{chain} - [0:0]", f"-A INPUT -j {chain}", *policy))
            inserted = True
        result.append(line)
        if in_filter and line == "COMMIT":
            in_filter = False

    if not found_filter or in_filter:
        raise SystemExit("tabela filter ausente ou incompleta")
    normalized = [
        re.sub(r" \[[0-9]+:[0-9]+\]$", " [0:0]", line)
        for line in result
        if not re.fullmatch(r"# (Generated|Completed) .*", line)
    ]
    pathlib.Path(destination).write_text("\n".join(normalized) + "\n", encoding="utf-8")


arguments = sys.argv[1:]
if len(arguments) != 8:
    raise SystemExit("contrato interno inválido")
rewrite(*arguments[:4])
rewrite(*arguments[4:])
PYTHON
iptables-restore --test < "$ipv4_rules"
ip6tables-restore --test < "$ipv6_rules"

firewall_transition_active=true
iptables-restore < "$ipv4_rules"
ip6tables-restore < "$ipv6_rules"
iptables -w -C INPUT -j SETLIVRE_INPUT
ip6tables -w -C INPUT -j SETLIVRE6_INPUT

oracle_rules_after="$({
  iptables-save -t filter \
    | grep --extended-regexp '^:InstanceServices |^-A OUTPUT .* -j InstanceServices$|^-A InstanceServices '
} | sha256sum | cut -d ' ' -f 1)"
[[ ${oracle_rules_after} == "${oracle_rules_before}" ]] \
  || fail "as regras InstanceServices da Oracle foram alteradas."

install -o root -g root -m 0600 "$ipv4_rules" /etc/iptables/rules.v4
install -o root -g root -m 0600 "$ipv6_rules" /etc/iptables/rules.v6
systemctl enable netfilter-persistent fail2ban
systemctl restart fail2ban
fail2ban_ready=false
for _ in {1..15}; do
  if fail2ban-client ping >/dev/null 2>&1; then
    fail2ban_ready=true
    break
  fi
  sleep 1
done
[[ ${fail2ban_ready} == true ]] || fail "Fail2ban não ficou pronto."
fail2ban-client status sshd >/dev/null
fail2ban_stopped=false
firewall_transition_active=false

if ! swapfile_is_valid "$SWAPFILE_PATH"; then
  remove_invalid_swapfile "$SWAPFILE_PATH"
  swap_staging_file="$(mktemp "${SWAPFILE_PATH}.staging.XXXXXX")"
  fallocate --length "$MINIMUM_SWAPFILE_BYTES" "$swap_staging_file"
  chown root:root "$swap_staging_file"
  chmod 0600 "$swap_staging_file"
  mkswap "$swap_staging_file"
  swapfile_is_valid "$swap_staging_file" \
    || fail "swapfile preparado não atende ao contrato de segurança."
  mv --no-target-directory -- "$swap_staging_file" "$SWAPFILE_PATH"
  swap_staging_file=""
fi
swapfile_is_valid "$SWAPFILE_PATH" \
  || fail "swapfile instalado não atende ao contrato de segurança."
if ! swapfile_is_active "$SWAPFILE_PATH"; then
  swapon -- "$SWAPFILE_PATH"
fi
swapfile_is_active "$SWAPFILE_PATH" || fail "swapfile não foi ativado."
if ! grep --fixed-strings --line-regexp '/swapfile none swap sw 0 0' /etc/fstab >/dev/null; then
  printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
fi

nginx -t
systemctl daemon-reload
systemctl enable nginx unattended-upgrades
systemctl restart nginx
systemctl enable \
  set-livre-web.service \
  set-livre-backoffice.service \
  set-livre-release-recovery.path
systemctl start set-livre-release-recovery.path
if [[ -e /opt/set-livre/current ]]; then
  [[ -L /opt/set-livre/current \
    && -f /opt/set-livre/current/web/server.js \
    && -f /opt/set-livre/current/backoffice/apps/backoffice/server.js \
    && -f /opt/set-livre/current/.runtime/web.env \
    && -f /opt/set-livre/current/.runtime/backoffice.env \
    && -f /opt/set-livre/current/.runtime/release.env ]] \
    || fail "release ativa não atende ao contrato atômico vigente."
  [[ $(readlink --canonicalize-existing /opt/set-livre/current) \
    == "/opt/set-livre/releases/${active_release_sha}" ]] \
    || fail "release ativa mudou durante o bootstrap."
  if [[ ${active_release_compatible} == true ]]; then
    systemctl restart set-livre-web.service set-livre-backoffice.service
    wait_for_active_health "$active_release_sha" || {
      systemctl stop set-livre-web.service set-livre-backoffice.service || true
      fail "release compatível não recuperou readiness após o bootstrap."
    }
  else
    if systemctl is-active --quiet set-livre-web.service \
      || systemctl is-active --quiet set-livre-backoffice.service; then
      fail "release incompatível voltou a executar durante o bootstrap."
    fi
  fi
else
  systemctl stop set-livre-web.service
  systemctl reset-failed set-livre-web.service || true
  systemctl stop set-livre-backoffice.service
  systemctl reset-failed set-livre-backoffice.service || true
fi
rm -f -- /etc/set-livre/web.env /etc/set-livre/backoffice.env /etc/set-livre/release.env
systemctl enable --now snap.certbot.renew.timer

digest_source="$(mktemp /etc/set-livre/.host-config.XXXXXX)"
printf '%s\n' "$host_configuration_digest" > "$digest_source"
chown root:setlivre "$digest_source"
chmod 0640 "$digest_source"
mv --force -- "$digest_source" /etc/set-livre/host-config.sha256
digest_source=""
rm -f -- /etc/set-livre/host-config.previous.sha256

if [[ -n ${active_release_sha} && ${active_release_compatible} == false ]]; then
  printf 'Host preparado; release incompatível permanece parada até o deploy do mesmo contrato.\n'
fi
printf 'Host preparado e contrato operacional publicado atomicamente.\n'
