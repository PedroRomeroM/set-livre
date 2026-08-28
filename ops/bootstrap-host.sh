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
readonly HOST_STATE_DIRECTORY="/etc/set-livre"
readonly HOST_CONFIGURATION_DIGEST="${HOST_STATE_DIRECTORY}/host-config.sha256"
readonly HOST_CONFIGURATION_PREVIOUS_DIGEST="${HOST_STATE_DIRECTORY}/host-config.previous.sha256"
readonly HOST_BOOTSTRAP_IN_PROGRESS="${HOST_STATE_DIRECTORY}/bootstrap-in-progress.sha256"
readonly HOST_BOOTSTRAP_RECOVERY_IN_PROGRESS="${HOST_STATE_DIRECTORY}/bootstrap-recovery-in-progress.sha256"
readonly MANAGED_FILE_STAGING_DIRECTORY="${HOST_STATE_DIRECTORY}/.managed-file-staging"
SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIRECTORY
readonly SUPABASE_CA_SOURCE="${SCRIPT_DIRECTORY}/certificates/supabase-root-2021-ca.crt"
readonly DEPLOY_INSTALLER_SOURCE="${SCRIPT_DIRECTORY}/deploy-release.sh"
readonly DEPLOY_SSH_COMMAND_SOURCE="${SCRIPT_DIRECTORY}/deploy-ssh-command.sh"
readonly DEPLOY_LOCK_SOURCE="${SCRIPT_DIRECTORY}/deploy-lock.py"
readonly DEPLOY_LOCK_DESTINATION="/usr/local/sbin/set-livre-deploy-lock"
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
digest_source=""
bootstrap_marker_source=""
bootstrap_recovery_marker_source=""
recovery_marker_source=""
host_configuration_published=false
bootstrap_gate_published=false
active_release_sha=""
active_release_compatible=false
node_staging_directory=""
node_previous_directory=""
node_alias_staging_path=""
node_alias_previous_path=""
swap_staging_file=""
authorized_keys_source=""
managed_file_staging=""

fail() {
  printf 'bootstrap: %s\n' "$1" >&2
  exit 1
}

adopt_deploy_lock() {
  local file_descriptor="$1"
  [[ ${file_descriptor} =~ ^[0-9]+$ ]] || fail "descritor do lock de deploy inválido."
  python3 "$DEPLOY_LOCK_SOURCE" verify "$file_descriptor" \
    || fail "lock de deploy herdado não pôde ser autenticado."
}

account_identity_is_canonical() {
  local identity="$1"
  local expected_primary_group="$2"
  local expected_home="$3"
  local expected_shell="$4"
  local entry username uid home shell
  entry="$(getent passwd "$identity")" || return 1
  IFS=: read -r username _ uid _ _ home shell <<< "$entry"
  [[ ${username} == "$identity" \
    && ${uid} =~ ^[0-9]+$ \
    && ${uid} -ne 0 \
    && ${home} == "$expected_home" \
    && ${shell} == "$expected_shell" \
    && $(id --group --name "$identity") == "$expected_primary_group" ]]
}

account_groups_are_exact() {
  local identity="$1"
  shift
  local actual expected
  actual="$(id --groups --name "$identity" | tr ' ' '\n' | LC_ALL=C sort --unique | paste -sd, -)" \
    || return 1
  expected="$(printf '%s\n' "$@" | LC_ALL=C sort --unique | paste -sd, -)" || return 1
  [[ ${actual} == "$expected" ]]
}

group_members_are_exact() {
  local group="$1"
  shift
  local group_entry group_name group_gid listed_members actual expected
  group_entry="$(getent group "$group")" || return 1
  IFS=: read -r group_name _ group_gid listed_members <<< "$group_entry"
  [[ ${group_name} == "$group" && ${group_gid} =~ ^[0-9]+$ ]] || return 1
  actual="$({
    if [[ -n ${listed_members} ]]; then
      tr ',' '\n' <<< "$listed_members"
    fi
    getent passwd | awk -F: -v gid="$group_gid" '$4 == gid { print $1 }'
  } | sed '/^$/d' | LC_ALL=C sort --unique | paste -sd, -)" || return 1
  expected="$(printf '%s\n' "$@" | LC_ALL=C sort --unique | paste -sd, -)" || return 1
  [[ ${actual} == "$expected" ]]
}

account_password_is_locked() {
  local identity="$1"
  local shadow_entry password_hash
  shadow_entry="$(getent shadow "$identity")" || return 1
  password_hash="${shadow_entry#*:}"
  password_hash="${password_hash%%:*}"
  [[ ${password_hash} == '!'* || ${password_hash} == '*'* ]]
}

# BEGIN SET_LIVRE_MANAGED_FILE_PRIMITIVES
ensure_managed_directory() {
  local path="$1"
  local owner="$2"
  local group="$3"
  local mode="$4"
  python3 - "$path" "$owner" "$group" "$mode" <<'PYTHON'
import contextlib
import grp
import os
import pathlib
import pwd
import stat
import sys

path = pathlib.Path(sys.argv[1])
if not path.is_absolute() or path.name in {"", ".", ".."}:
    raise SystemExit("managed directory path is invalid")

owner_id = pwd.getpwnam(sys.argv[2]).pw_uid
group_id = grp.getgrnam(sys.argv[3]).gr_gid
mode = int(sys.argv[4], 8)
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW
components = path.parts[1:]
with contextlib.ExitStack() as descriptors:
    directory_fd = os.open("/", flags)
    descriptors.callback(os.close, directory_fd)
    for index, component in enumerate(components):
        is_final = index == len(components) - 1
        if is_final:
            try:
                os.mkdir(component, mode, dir_fd=directory_fd)
            except FileExistsError:
                pass
        child_fd = os.open(component, flags, dir_fd=directory_fd)
        descriptors.callback(os.close, child_fd)
        directory_fd = child_fd
        if is_final:
            metadata = os.fstat(directory_fd)
            if not stat.S_ISDIR(metadata.st_mode):
                raise SystemExit("managed path is not a directory")
            os.fchown(directory_fd, owner_id, group_id)
            os.fchmod(directory_fd, mode)
PYTHON
}

ensure_bootstrap_state_directory() {
  local path="$1"
  python3 - "$path" <<'PYTHON'
import contextlib
import grp
import os
import pathlib
import stat
import sys

flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW
path = pathlib.Path(sys.argv[1])
if not path.is_absolute() or path.name in {"", ".", ".."}:
    raise SystemExit("bootstrap state directory path is invalid")
with contextlib.ExitStack() as descriptors:
    directory_fd = os.open("/", flags)
    descriptors.callback(os.close, directory_fd)
    for index, component in enumerate(path.parts[1:]):
        is_final = index == len(path.parts[1:]) - 1
        created = False
        if is_final:
            try:
                os.mkdir(component, 0o700, dir_fd=directory_fd)
                created = True
            except FileExistsError:
                pass
        child_fd = os.open(component, flags, dir_fd=directory_fd)
        descriptors.callback(os.close, child_fd)
        directory_fd = child_fd
        if is_final:
            if created:
                os.fchown(directory_fd, 0, 0)
                os.fchmod(directory_fd, 0o700)
            metadata = os.fstat(directory_fd)
            healthy_group = None
            try:
                healthy_group = grp.getgrnam("setlivre").gr_gid
            except KeyError:
                pass
            allowed = (
                stat.S_ISDIR(metadata.st_mode)
                and metadata.st_uid == 0
                and (
                    (metadata.st_gid == 0 and stat.S_IMODE(metadata.st_mode) == 0o700)
                    or (
                        healthy_group is not None
                        and metadata.st_gid == healthy_group
                        and stat.S_IMODE(metadata.st_mode) == 0o750
                    )
                )
            )
            if not allowed:
                raise SystemExit("bootstrap state directory metadata is invalid")
PYTHON
}

publish_managed_file() {
  local source="$1"
  local target="$2"
  local owner="$3"
  local group="$4"
  local mode="$5"
  local parent basename target_id staging_prefix expected_mode stale stale_suffix identity
  local nullglob_was_enabled=false
  local -a stale_files=()
  [[ -f ${source} && ! -L ${source} && ${target} == /* ]] || return 1
  parent="$(dirname -- "$target")" || return 1
  basename="$(basename -- "$target")" || return 1
  [[ ${basename} != "." && ${basename} != ".." \
    && $(realpath -e -- "$parent") == "$parent" ]] || return 1
  if [[ -e ${target} || -L ${target} ]]; then
    [[ -f ${target} && ! -L ${target} && $(stat --format '%h' -- "$target") == 1 ]] \
      || return 1
  fi
  ensure_managed_directory "$MANAGED_FILE_STAGING_DIRECTORY" root root 0700 || return 1
  [[ $(stat --format '%d' -- "$MANAGED_FILE_STAGING_DIRECTORY") \
    == "$(stat --format '%d' -- "$parent")" ]] || return 1
  target_id="$(printf '%s' "$target" | sha256sum | cut -d ' ' -f 1)" || return 1
  [[ ${target_id} =~ ^[0-9a-f]{64}$ ]] || return 1
  staging_prefix="${MANAGED_FILE_STAGING_DIRECTORY}/${target_id}"
  expected_mode="${mode#0}"
  if shopt -q nullglob; then
    nullglob_was_enabled=true
  fi
  shopt -s nullglob
  stale_files=("${staging_prefix}."*)
  [[ ${nullglob_was_enabled} == true ]] || shopt -u nullglob
  for stale in "${stale_files[@]}"; do
    [[ ${stale} == "${staging_prefix}."* && -f ${stale} && ! -L ${stale} ]] || return 1
    stale_suffix="${stale#"${staging_prefix}."}"
    [[ ${stale_suffix} =~ ^[A-Za-z0-9]{6}$ ]] || return 1
    identity="$(stat --format '%U:%G:%a:%h' -- "$stale")" || return 1
    [[ ${identity} == "root:root:600:1" \
      || ${identity} == "root:root:${expected_mode}:1" \
      || ${identity} == "${owner}:${group}:${expected_mode}:1" ]] || return 1
    rm -f -- "$stale" || return 1
  done
  managed_file_staging="$(mktemp "${staging_prefix}.XXXXXX")" || return 1
  if ! install -o root -g root -m 0600 "$source" "$managed_file_staging" \
    || ! chmod "$mode" "$managed_file_staging" \
    || ! chown "${owner}:${group}" "$managed_file_staging"; then
    rm -f -- "$managed_file_staging"
    managed_file_staging=""
    return 1
  fi
  if ! mv --no-target-directory --force -- "$managed_file_staging" "$target"; then
    rm -f -- "$managed_file_staging"
    managed_file_staging=""
    return 1
  fi
  managed_file_staging=""
  [[ -f ${target} && ! -L ${target} \
    && $(stat --format '%U:%G:%a:%h' -- "$target") == "${owner}:${group}:${expected_mode}:1" ]]
}

publish_managed_content() {
  local target="$1"
  local owner="$2"
  local group="$3"
  local mode="$4"
  local source status
  source="$(mktemp /run/set-livre-managed-content.XXXXXX)" || return 1
  if ! cat > "$source"; then
    rm -f -- "$source"
    return 1
  fi
  if publish_managed_file "$source" "$target" "$owner" "$group" "$mode"; then
    status=0
  else
    status=$?
  fi
  rm -f -- "$source"
  return "$status"
}
# END SET_LIVRE_MANAGED_FILE_PRIMITIVES

ensure_fstab_swap_entry() {
  local source status
  [[ -f /etc/fstab && ! -L /etc/fstab \
    && $(stat --format '%U:%G:%h' -- /etc/fstab) == "root:root:1" ]] || return 1
  source="$(mktemp /run/set-livre-fstab.XXXXXX)" || return 1
  if ! awk '
    BEGIN { canonical = "/swapfile none swap sw 0 0" }
    $1 == "/swapfile" {
      count += 1
      if ($0 != canonical || count > 1) invalid = 1
    }
    { print }
    END {
      if (invalid) exit 42
      if (count == 0) print canonical
    }
  ' /etc/fstab > "$source"; then
    rm -f -- "$source"
    return 1
  fi
  if publish_managed_file "$source" /etc/fstab root root 0644; then
    status=0
  else
    status=$?
  fi
  rm -f -- "$source"
  return "$status"
}

existing_release_directories_are_valid() {
  python3 <<'PYTHON'
import contextlib
import grp
import os
import stat

flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW
try:
    with contextlib.ExitStack() as descriptors:
        directory_fd = os.open("/opt", flags)
        descriptors.callback(os.close, directory_fd)
        expected_group = None
        for component in ("set-livre", "releases"):
            try:
                child_fd = os.open(component, flags, dir_fd=directory_fd)
            except FileNotFoundError:
                break
            descriptors.callback(os.close, child_fd)
            if expected_group is None:
                expected_group = grp.getgrnam("setlivre").gr_gid
            metadata = os.fstat(child_fd)
            if (
                not stat.S_ISDIR(metadata.st_mode)
                or metadata.st_uid != 0
                or metadata.st_gid != expected_group
                or stat.S_IMODE(metadata.st_mode) != 0o750
            ):
                raise SystemExit("existing release directory metadata is invalid")
            directory_fd = child_fd
except (KeyError, OSError) as error:
    raise SystemExit("existing release directory chain is invalid") from error
PYTHON
}

# BEGIN SET_LIVRE_BOOTSTRAP_MARKER_PRIMITIVES
publish_bootstrap_in_progress() {
  local digest="$1"
  [[ ${digest} =~ ^[0-9a-f]{64}$ ]] || return 1
  bootstrap_marker_source="$(mktemp "${HOST_STATE_DIRECTORY}/.bootstrap-in-progress.XXXXXX")" \
    || return 1
  if ! printf '%s\n' "$digest" > "$bootstrap_marker_source" \
    || ! chown root:root "$bootstrap_marker_source" \
    || ! chmod 0600 "$bootstrap_marker_source" \
    || ! mv --no-target-directory --force -- \
      "$bootstrap_marker_source" "$HOST_BOOTSTRAP_IN_PROGRESS"; then
    rm -f -- "$bootstrap_marker_source"
    bootstrap_marker_source=""
    return 1
  fi
  bootstrap_marker_source=""
}

publish_bootstrap_recovery_in_progress() {
  local digest="$1"
  [[ ${digest} =~ ^[0-9a-f]{64}$ ]] || return 1
  bootstrap_recovery_marker_source="$(
    mktemp "${HOST_STATE_DIRECTORY}/.bootstrap-recovery-in-progress.XXXXXX"
  )" || return 1
  if ! printf '%s\n' "$digest" > "$bootstrap_recovery_marker_source" \
    || ! chown root:root "$bootstrap_recovery_marker_source" \
    || ! chmod 0600 "$bootstrap_recovery_marker_source" \
    || ! mv --no-target-directory --force -- \
      "$bootstrap_recovery_marker_source" "$HOST_BOOTSTRAP_RECOVERY_IN_PROGRESS"; then
    rm -f -- "$bootstrap_recovery_marker_source"
    bootstrap_recovery_marker_source=""
    return 1
  fi
  bootstrap_recovery_marker_source=""
}

write_bootstrap_recovery_marker() {
  local target="$1"
  [[ ${target} =~ ^/opt/set-livre/releases/[0-9a-f]{40}$ \
    && -d ${target} && ! -L ${target} ]] || return 1
  recovery_marker_source="$(mktemp /opt/set-livre/.activation-rollback.XXXXXX)" || return 1
  if ! printf '%s\n' "$target" > "$recovery_marker_source" \
    || ! chown root:root "$recovery_marker_source" \
    || ! chmod 0600 "$recovery_marker_source" \
    || ! mv --no-target-directory --force -- "$recovery_marker_source" "$ROLLBACK_MARKER"; then
    rm -f -- "$recovery_marker_source"
    recovery_marker_source=""
    return 1
  fi
  recovery_marker_source=""
}
# END SET_LIVRE_BOOTSTRAP_MARKER_PRIMITIVES

clear_dangling_current_link() {
  local current_link="/opt/set-livre/current"
  if [[ -L ${current_link} && ! -e ${current_link} ]]; then
    rm -f -- "$current_link"
  fi
}

stop_application_services() {
  local load_state service
  for service in set-livre-web.service set-livre-backoffice.service; do
    load_state="$(systemctl show --property=LoadState --value "$service")" || return 1
    if [[ ${load_state} != "not-found" ]]; then
      systemctl stop "$service" || return 1
    fi
    ! systemctl is-active --quiet "$service" || return 1
  done
}

# BEGIN SET_LIVRE_SSH_POLICY_PRIMITIVES
assert_unconditional_sshd_policy_surface() {
  local configuration="$1"
  local drop_in_directory="$2"
  local candidate
  local -a configuration_files=("$configuration")
  local -a drop_in_candidates=()
  [[ ${configuration} == /* && -f ${configuration} && ! -L ${configuration} ]] || return 1
  [[ ${drop_in_directory} == /* && -d ${drop_in_directory} && ! -L ${drop_in_directory} ]] \
    || return 1
  mapfile -d '' -t drop_in_candidates < <(
    find -P "$drop_in_directory" -mindepth 1 -maxdepth 1 -name '*.conf' -print0 \
      | LC_ALL=C sort -z
  )
  for candidate in "${drop_in_candidates[@]}"; do
    [[ -f ${candidate} && ! -L ${candidate} ]] || return 1
    configuration_files+=("$candidate")
  done
  awk \
    -v main_configuration="$configuration" \
    -v expected_include="${drop_in_directory}/*.conf" '
      BEGIN {
        include_count = 0
        invalid = 0
      }
      {
        line = $0
        sub(/^[[:space:]]+/, "", line)
        if (line == "" || substr(line, 1, 1) == "#") next
        field_count = split(line, fields, /[[:space:]]+/)
        keyword = tolower(fields[1])
        if (keyword == "match") invalid = 1
        if (keyword == "include") {
          if (FILENAME != main_configuration \
              || field_count != 2 \
              || fields[2] != expected_include) {
            invalid = 1
          } else {
            include_count++
          }
        }
      }
      END {
        if (invalid || include_count != 1) exit 1
      }
    ' "${configuration_files[@]}"
}

effective_allow_users_are_exact() {
  local effective="$1"
  local line
  local -a fields=()
  local -a users=()
  while IFS= read -r line; do
    [[ ${line} == "allowusers "* ]] || continue
    fields=()
    read -r -a fields <<< "$line"
    [[ ${#fields[@]} -gt 1 && ${fields[0]} == "allowusers" ]] || return 1
    users+=("${fields[@]:1}")
  done <<< "$effective"
  [[ ${#users[@]} -eq 2 && ${users[0]} == "ubuntu" && ${users[1]} == "deploy-setlivre" ]]
}

assert_effective_sshd_policy() {
  local configuration="$1"
  local context_user effective expected
  local -a expected_values=(
    "authenticationmethods publickey"
    "allowagentforwarding no"
    "allowtcpforwarding no"
    "gatewayports no"
    "kbdinteractiveauthentication no"
    "logingracetime 30"
    "maxauthtries 3"
    "passwordauthentication no"
    "permitemptypasswords no"
    "permitrootlogin no"
    "permittunnel no"
    "pubkeyauthentication yes"
    "x11forwarding no"
  )
  [[ ${configuration} == /* && -f ${configuration} && ! -L ${configuration} ]] || return 1
  for context_user in ubuntu deploy-setlivre root; do
    effective="$(
      sshd -T -f "$configuration" \
        -C "user=${context_user},host=set-livre,addr=203.0.113.1,laddr=${PRODUCTION_IP},lport=22"
    )" || return 1
    for expected in "${expected_values[@]}"; do
      [[ $(grep --fixed-strings --line-regexp --count -- "$expected" <<< "$effective" || true) -eq 1 ]] \
        || return 1
    done
    effective_allow_users_are_exact "$effective" || return 1
  done
}
# END SET_LIVRE_SSH_POLICY_PRIMITIVES

assert_legacy_surface_absent() {
  local managed_host_contract="$1"
  local managed_nginx_link="/etc/nginx/sites-enabled/setlivre"
  local managed_nginx_target="/etc/nginx/sites-available/set-livre"
  local path unit setting
  for path in \
    /etc/apt/apt.conf.d/52setlivre-unattended-upgrades \
    /etc/fail2ban/jail.d/setlivre-sshd.local \
    /etc/letsencrypt/renewal-hooks/deploy/setlivre-enable-tls \
    /etc/nginx/conf.d/setlivre-proxy.conf \
    /etc/nginx/sites-available/setlivre-bootstrap \
    /etc/nginx/sites-available/setlivre-tls \
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
  if [[ -e ${managed_nginx_link} || -L ${managed_nginx_link} ]]; then
    [[ ${managed_host_contract} == true \
      && -L ${managed_nginx_link} \
      && $(readlink -- "$managed_nginx_link") == "$managed_nginx_target" ]] \
      || fail "link Nginx gerenciado é inválido: ${managed_nginx_link}."
  fi
  if [[ ${managed_host_contract} == false ]]; then
    for path in /opt/node-v24.18.0 /opt/set-livre /opt/setlivre; do
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

host_state_marker_is_valid() {
  local marker="$1"
  local expected_identity="$2"
  local label="$3"
  local -a marker_lines=()
  [[ -e ${marker} || -L ${marker} ]] || return 1
  [[ -f ${marker} && ! -L ${marker} ]] \
    || fail "${label} é inválido."
  [[ $(stat --format '%U:%G:%a' -- "$marker") == "$expected_identity" ]] \
    || fail "${label} tem owner ou modo inesperado."
  mapfile -t marker_lines < "$marker"
  [[ ${#marker_lines[@]} -eq 1 && ${marker_lines[0]} =~ ^[0-9a-f]{64}$ ]] \
    || fail "${label} tem conteúdo inválido."
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
    if curl --disable --noproxy '*' --fail --silent --show-error --max-time 2 \
      http://127.0.0.1:3000/api/health/ready \
      | jq --exit-status --arg release "$expected_release" \
        '.application == "web" and .release == $release and .status == "ready"' >/dev/null \
      && curl --disable --noproxy '*' --fail --silent --show-error --max-time 2 \
        http://127.0.0.1:3001/api/health/ready \
        | jq --exit-status --arg release "$expected_release" \
          '.application == "backoffice" and .release == $release and .status == "ready"' >/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

wait_for_active_public_health() {
  local expected_release="$1"
  for _ in $(seq 1 12); do
    if curl --disable --noproxy '*' --fail --silent --show-error --max-time 5 \
      "https://${PRODUCTION_IP}/api/health/ready" \
      | jq --exit-status --arg release "$expected_release" \
        '.application == "web" and .release == $release and .status == "ready"' >/dev/null; then
      return 0
    fi
    sleep 5
  done
  return 1
}

# BEGIN SET_LIVRE_FAIL2BAN_PRIMITIVE
fail2ban_contract_is_ready() {
  local action_start action_ban action_check override_scan
  local -a actions=()
  mapfile -t actions < <(
    fail2ban-client get sshd actions \
      | tail --lines +2 \
      | sed '/^[[:space:]]*$/d'
  )
  [[ ${#actions[@]} -eq 1 && ${actions[0]} == "nftables" ]] || return 1
  override_scan="$(
    find /etc/fail2ban/action.d -mindepth 1 -maxdepth 1 -name 'nftables*.local' -print
  )" || return 1
  [[ -z ${override_scan} ]] || return 1
  action_start="$(fail2ban-client get sshd action nftables actionstart)" || return 1
  action_ban="$(fail2ban-client get sshd action nftables actionban)" || return 1
  action_check="$(fail2ban-client get sshd action nftables actioncheck)" || return 1
  [[ ${action_start} == *"nft add table inet f2b-table"* \
    && ${action_start} == *"type filter hook input priority -1"* \
    && ${action_start} == *"nft add set inet f2b-table <addr_set>"* \
    && ${action_start} \
      == *"dport \{ \$(echo 'ssh' | sed s/:/-/g) \} <addr_family>"* \
    && ${action_start} == *"saddr @<addr_set> reject"* \
    && ${action_ban} == "nft add element inet f2b-table <addr_set> \{ <ip> \}" \
    && ${action_check} \
      == "nft list chain inet f2b-table f2b-chain | grep -q '@<addr_set>[ \t]'" ]] \
    || return 1
  nft list table inet f2b-table >/dev/null 2>&1
  nft list chain inet f2b-table f2b-chain >/dev/null 2>&1
}
# END SET_LIVRE_FAIL2BAN_PRIMITIVE

cleanup() {
  if [[ ${firewall_transition_active} == true ]]; then
    [[ -z ${previous_ipv4_rules} ]] || iptables-restore < "$previous_ipv4_rules" || true
    [[ -z ${previous_ipv6_rules} ]] || ip6tables-restore < "$previous_ipv6_rules" || true
    if [[ ${persisted_ipv4_existed} == true ]]; then
      publish_managed_file \
        "$previous_persisted_ipv4" /etc/iptables/rules.v4 root root 0600 || true
    else
      rm -f -- /etc/iptables/rules.v4
    fi
    if [[ ${persisted_ipv6_existed} == true ]]; then
      publish_managed_file \
        "$previous_persisted_ipv6" /etc/iptables/rules.v6 root root 0600 || true
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
  [[ -z ${bootstrap_marker_source} ]] || rm -f -- "$bootstrap_marker_source"
  [[ -z ${bootstrap_recovery_marker_source} ]] \
    || rm -f -- "$bootstrap_recovery_marker_source"
  [[ -z ${recovery_marker_source} ]] || rm -f -- "$recovery_marker_source"
  [[ -z ${authorized_keys_source} ]] || rm -f -- "$authorized_keys_source"
  if [[ -n ${managed_file_staging} \
    && $(dirname -- "$managed_file_staging") == "$MANAGED_FILE_STAGING_DIRECTORY" \
    && $(basename -- "$managed_file_staging") \
      =~ ^[0-9a-f]{64}[.][A-Za-z0-9]{6}$ \
    && -f ${managed_file_staging} && ! -L ${managed_file_staging} ]]; then
    rm -f -- "$managed_file_staging"
  fi
  if [[ ${bootstrap_gate_published} == true ]]; then
    stop_application_services || true
  fi
  if [[ ${host_configuration_published} == true ]]; then
    if [[ -e ${HOST_BOOTSTRAP_RECOVERY_IN_PROGRESS} \
      || -L ${HOST_BOOTSTRAP_RECOVERY_IN_PROGRESS} ]]; then
      publish_bootstrap_in_progress "$host_configuration_digest" || true
    elif rm -f -- "$ROLLBACK_MARKER" \
      && rm -f -- "$HOST_CONFIGURATION_DIGEST"; then
      :
    else
      publish_bootstrap_in_progress "$host_configuration_digest" || true
    fi
  fi
}
trap cleanup EXIT

[[ ${EUID} -eq 0 ]] || fail "execute como root."
if [[ ${1:-} == "--set-livre-deploy-lock-fd" ]]; then
  [[ $# -ge 3 ]] || fail "invocação interna do lock de deploy inválida."
  adopt_deploy_lock "$2"
  shift 2
else
  [[ -f ${DEPLOY_LOCK_SOURCE} && ! -L ${DEPLOY_LOCK_SOURCE} ]] \
    || fail "primitive do lock de deploy ausente ou inválida."
  exec python3 "$DEPLOY_LOCK_SOURCE" run blocking "${SCRIPT_DIRECTORY}/bootstrap-host.sh" "$@"
fi
[[ $# -eq 1 ]] || fail "informe o arquivo que contém a chave pública de deploy."
for required_source in \
  "$SUPABASE_CA_SOURCE" \
  "$DEPLOY_INSTALLER_SOURCE" \
  "$DEPLOY_SSH_COMMAND_SOURCE" \
  "$DEPLOY_LOCK_SOURCE" \
  "$NGINX_HTTP_SOURCE" \
  "$NGINX_TLS_SOURCE" \
  "${SCRIPT_DIRECTORY}/systemd/set-livre-web.service" \
  "${SCRIPT_DIRECTORY}/systemd/set-livre-backoffice.service" \
  "${SCRIPT_DIRECTORY}/systemd/set-livre-application-start.service" \
  "${SCRIPT_DIRECTORY}/systemd/set-livre-release-recovery.service" \
  "${SCRIPT_DIRECTORY}/systemd/set-livre-release-recovery.path"; do
  [[ -f ${required_source} && ! -L ${required_source} ]] || fail "fonte operacional ausente ou inválida."
done

deploy_key_file="$(realpath -e -- "$1")"
[[ -f ${deploy_key_file} && ! -L ${deploy_key_file} ]] || fail "a chave de deploy não é um arquivo regular."
if ! deploy_key="$(python3 - "$deploy_key_file" <<'PYTHON'
import base64
import binascii
import pathlib
import re
import struct
import sys

path = pathlib.Path(sys.argv[1])
try:
    text = path.read_text(encoding="ascii")
except (OSError, UnicodeError) as error:
    raise SystemExit("arquivo ilegível") from error

lines = text.splitlines()
if len(lines) != 1:
    raise SystemExit("o arquivo deve conter exatamente uma chave")
match = re.fullmatch(r"ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: ([ -~]+))?", lines[0])
if match is None:
    raise SystemExit("linha Ed25519 inválida")

try:
    blob = base64.b64decode(match.group(1), validate=True)
except (binascii.Error, ValueError) as error:
    raise SystemExit("blob Base64 inválido") from error

def read_ssh_string(value: bytes, offset: int) -> tuple[bytes, int]:
    if offset + 4 > len(value):
        raise ValueError("comprimento ausente")
    length = struct.unpack(">I", value[offset : offset + 4])[0]
    start = offset + 4
    end = start + length
    if end > len(value):
        raise ValueError("comprimento excede o blob")
    return value[start:end], end

try:
    algorithm, offset = read_ssh_string(blob, 0)
    public_key, offset = read_ssh_string(blob, offset)
except ValueError as error:
    raise SystemExit("estrutura SSH inválida") from error
if algorithm != b"ssh-ed25519" or len(public_key) != 32 or offset != len(blob):
    raise SystemExit("material Ed25519 inválido")

print(lines[0])
PYTHON
)"; then
  fail "a chave de deploy não contém exatamente uma chave pública Ed25519 válida."
fi

ensure_bootstrap_state_directory "$HOST_STATE_DIRECTORY" \
  || fail "diretório de estado operacional não é um estado inicial ou gerenciado válido."
managed_host_contract=false
installed_host_contract=false
if host_state_marker_is_valid \
  "$HOST_CONFIGURATION_DIGEST" "root:setlivre:640" "marcador operacional instalado"; then
  managed_host_contract=true
  installed_host_contract=true
fi
if host_state_marker_is_valid \
  "$HOST_CONFIGURATION_PREVIOUS_DIGEST" "root:setlivre:640" "marcador operacional anterior"; then
  managed_host_contract=true
fi
if host_state_marker_is_valid \
  "$HOST_BOOTSTRAP_IN_PROGRESS" "root:root:600" "marcador de bootstrap em andamento"; then
  managed_host_contract=true
fi
if host_state_marker_is_valid \
  "$HOST_BOOTSTRAP_RECOVERY_IN_PROGRESS" "root:root:600" \
  "marcador de recovery do bootstrap"; then
  managed_host_contract=true
fi
if [[ ${managed_host_contract} == true ]]; then
  existing_release_directories_are_valid \
    || fail "raízes de release existentes não atendem ao contrato físico e de permissões."
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
    "deploy-lock.py",
    "nginx/set-livre-http.conf",
    "nginx/set-livre-tls.conf",
    "systemd/set-livre-application-start.service",
    "systemd/set-livre-backoffice.service",
    "systemd/set-livre-release-recovery.path",
    "systemd/set-livre-release-recovery.service",
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

[[ ! -e ${ROLLBACK_MARKER} && ! -L ${ROLLBACK_MARKER} ]] \
  || fail "há uma ativação interrompida; recupere-a antes de alterar o host."
[[ ! -e ${HOST_BOOTSTRAP_RECOVERY_IN_PROGRESS} \
  && ! -L ${HOST_BOOTSTRAP_RECOVERY_IN_PROGRESS} ]] \
  || fail "há um recovery de bootstrap interrompido; estabilize-o antes de alterar o host."
publish_bootstrap_in_progress "$host_configuration_digest" \
  || fail "não foi possível publicar o marcador de bootstrap."
bootstrap_gate_published=true
ensure_managed_directory "$HOST_STATE_DIRECTORY" root root 0700 \
  || fail "diretório de estado operacional não pôde ser restringido após o bloqueio."
stop_application_services \
  || fail "não foi possível interromper os apps antes de inspecionar a release ativa."
clear_dangling_current_link
if [[ -e /opt/set-livre/current || -L /opt/set-livre/current ]]; then
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
  fi
fi
if [[ ${installed_host_contract} == true ]]; then
  publish_managed_file \
    "$HOST_CONFIGURATION_DIGEST" "$HOST_CONFIGURATION_PREVIOUS_DIGEST" \
    root setlivre 0640 \
    || fail "digest operacional anterior não pôde ser preservado atomicamente."
  rm -f -- "$HOST_CONFIGURATION_DIGEST"
fi
if [[ -n ${active_release_sha} && ${active_release_compatible} == false ]]; then
  rm -f -- /opt/set-livre/current
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
  nftables \
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
  curl --disable --noproxy '*' --fail --location --proto '=https' --tlsv1.2 \
    --output "${temporary_directory}/${archive}" \
    "https://nodejs.org/dist/v${NODE_VERSION}/${archive}"
  curl --disable --noproxy '*' --fail --location --proto '=https' --tlsv1.2 \
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
if ! getent group deploy-setlivre >/dev/null; then
  groupadd deploy-setlivre
fi
for service_identity in setlivre-web setlivre-backoffice; do
  if ! getent passwd "$service_identity" >/dev/null; then
    useradd --system --gid "$service_identity" --groups setlivre \
      --home-dir /nonexistent --shell /usr/sbin/nologin "$service_identity"
  else
    account_identity_is_canonical \
      "$service_identity" "$service_identity" /nonexistent /usr/sbin/nologin \
      || fail "identidade ${service_identity} divergiu do contrato canônico."
  fi
  usermod --append --groups setlivre --lock "$service_identity"
  if ! account_identity_is_canonical \
    "$service_identity" "$service_identity" /nonexistent /usr/sbin/nologin \
    || ! account_groups_are_exact "$service_identity" "$service_identity" setlivre \
    || ! group_members_are_exact "$service_identity" "$service_identity" \
    || ! account_password_is_locked "$service_identity"; then
    fail "identidade ${service_identity} não pôde ser restringida."
  fi
done
group_members_are_exact setlivre setlivre-web setlivre-backoffice \
  || fail "grupo compartilhado setlivre possui membros inesperados."
if ! getent passwd deploy-setlivre >/dev/null; then
  useradd --create-home --gid deploy-setlivre \
    --home-dir /home/deploy-setlivre --shell /bin/bash deploy-setlivre
else
  account_identity_is_canonical \
    deploy-setlivre deploy-setlivre /home/deploy-setlivre /bin/bash \
    || fail "identidade deploy-setlivre divergiu do contrato canônico."
fi
usermod --lock deploy-setlivre
if ! account_identity_is_canonical \
  deploy-setlivre deploy-setlivre /home/deploy-setlivre /bin/bash \
  || ! account_groups_are_exact deploy-setlivre deploy-setlivre \
  || ! group_members_are_exact deploy-setlivre deploy-setlivre \
  || ! account_password_is_locked deploy-setlivre; then
  fail "identidade deploy-setlivre não pôde ser restringida."
fi

ensure_managed_directory "$HOST_STATE_DIRECTORY" root setlivre 0750 \
  || fail "diretório de estado operacional é inválido."
ensure_managed_directory /opt/set-livre root setlivre 0750 \
  || fail "raiz operacional /opt/set-livre é inválida."
ensure_managed_directory /opt/set-livre/releases root setlivre 0750 \
  || fail "diretório de releases é inválido."
for acme_directory in \
  /var/www \
  /var/www/set-livre-acme \
  /var/www/set-livre-acme/.well-known \
  /var/www/set-livre-acme/.well-known/acme-challenge; do
  ensure_managed_directory "$acme_directory" root root 0755 \
    || fail "webroot ACME contém componente inválido: ${acme_directory}."
done
publish_managed_file \
  "$SUPABASE_CA_SOURCE" /etc/set-livre/supabase-root-2021-ca.crt root root 0644 \
  || fail "CA raiz do Supabase não pôde ser publicada atomicamente."
ensure_managed_directory /home/deploy-setlivre root deploy-setlivre 0750 \
  || fail "home canônico de deploy-setlivre é inválido."
ensure_managed_directory /home/deploy-setlivre/.ssh root deploy-setlivre 0750 \
  || fail "diretório SSH de deploy-setlivre é inválido."
ensure_managed_directory /home/deploy-setlivre/incoming deploy-setlivre deploy-setlivre 0700 \
  || fail "diretório de entrada de deploy-setlivre é inválido."
incoming_lock=/home/deploy-setlivre/incoming/.incoming.lock
if [[ ! -e ${incoming_lock} && ! -L ${incoming_lock} ]]; then
  publish_managed_content "$incoming_lock" deploy-setlivre deploy-setlivre 0600 </dev/null \
    || fail "lock de upload não pôde ser publicado atomicamente."
fi
[[ -f ${incoming_lock} && ! -L ${incoming_lock} \
  && $(stat --format '%U:%G:%a:%h' -- "$incoming_lock") \
    == "deploy-setlivre:deploy-setlivre:600:1" ]] \
  || fail "lock de upload instalado é inválido."
authorized_keys_source="$(mktemp /run/set-livre-authorized-keys.XXXXXX)"
printf 'restrict,command="/usr/local/sbin/set-livre-deploy-ssh" %s\n' "$deploy_key" \
  > "$authorized_keys_source"
publish_managed_file \
  "$authorized_keys_source" /home/deploy-setlivre/.ssh/authorized_keys \
  root deploy-setlivre 0640 \
  || fail "authorized_keys de deploy não pôde ser publicado atomicamente."
rm -f -- "$authorized_keys_source"
authorized_keys_source=""

publish_managed_file \
  "$DEPLOY_LOCK_SOURCE" "$DEPLOY_LOCK_DESTINATION" root root 0755 \
  || fail "primitive do lock de deploy não pôde ser publicada atomicamente."
publish_managed_file \
  "$DEPLOY_INSTALLER_SOURCE" /usr/local/sbin/set-livre-deploy root root 0755 \
  || fail "instalador de release não pôde ser publicado atomicamente."
publish_managed_file \
  "$DEPLOY_SSH_COMMAND_SOURCE" /usr/local/sbin/set-livre-deploy-ssh root root 0755 \
  || fail "comando SSH de deploy não pôde ser publicado atomicamente."
for systemd_unit in \
  set-livre-web.service \
  set-livre-backoffice.service \
  set-livre-application-start.service \
  set-livre-release-recovery.service \
  set-livre-release-recovery.path; do
  publish_managed_file \
    "${SCRIPT_DIRECTORY}/systemd/${systemd_unit}" "/etc/systemd/system/${systemd_unit}" \
    root root 0644 \
    || fail "unit ${systemd_unit} não pôde ser publicada atomicamente."
done
rm -f -- /etc/systemd/system/set-livre-release-recovery@.service
ensure_managed_directory /usr/local/share/set-livre root root 0755 \
  || fail "diretório de templates Nginx é inválido."
publish_managed_file \
  "$NGINX_HTTP_SOURCE" /usr/local/share/set-livre/nginx-http.conf root root 0644 \
  || fail "template HTTP do Nginx não pôde ser publicado atomicamente."
publish_managed_file \
  "$NGINX_TLS_SOURCE" /usr/local/share/set-livre/nginx-tls.conf root root 0644 \
  || fail "template TLS do Nginx não pôde ser publicado atomicamente."

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
publish_managed_file \
  "$active_nginx_source" /etc/nginx/sites-available/set-livre root root 0644 \
  || fail "site Nginx não pôde ser publicado atomicamente."
ln --symbolic --force --no-dereference --no-target-directory \
  /etc/nginx/sites-available/set-livre /etc/nginx/sites-enabled/set-livre
rm -f -- /etc/nginx/sites-enabled/default

ensure_managed_directory /etc/letsencrypt/renewal-hooks/deploy root root 0755 \
  || fail "diretório de hooks do Certbot é inválido."
publish_managed_content \
  /etc/letsencrypt/renewal-hooks/deploy/set-livre-reload-nginx root root 0755 \
  <<'RENEWAL_HOOK' \
  || fail "hook de renovação TLS não pôde ser publicado atomicamente."
#!/bin/sh
set -eu
nginx -t
systemctl reload nginx
RENEWAL_HOOK

publish_managed_content /etc/sudoers.d/set-livre-deploy root root 0440 <<'SUDOERS' \
  || fail "sudoers de deploy não pôde ser publicado atomicamente."
deploy-setlivre ALL=(root) NOPASSWD: /usr/local/sbin/set-livre-deploy
SUDOERS
visudo --check --file /etc/sudoers.d/set-livre-deploy

publish_managed_content /etc/ssh/sshd_config.d/60-set-livre.conf root root 0644 <<'SSHD' \
  || fail "configuração SSH não pôde ser publicada atomicamente."
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
assert_unconditional_sshd_policy_surface /etc/ssh/sshd_config /etc/ssh/sshd_config.d \
  || fail "superfície SSH contém Include ou Match fora do contrato global."
assert_effective_sshd_policy /etc/ssh/sshd_config \
  || fail "política SSH efetiva diverge do contrato public-key-only."
systemctl reload ssh

publish_managed_content /etc/fail2ban/jail.d/set-livre-sshd.local root root 0644 <<'FAIL2BAN' \
  || fail "configuração Fail2ban não pôde ser publicada atomicamente."
# BEGIN SET_LIVRE_FAIL2BAN_CONFIGURATION
[sshd]
enabled = true
backend = systemd
banaction = nftables[actionstart_on_demand=false]
banaction_allports = nftables[type=allports, actionstart_on_demand=false]
bantime = 1h
findtime = 10m
maxretry = 5
# END SET_LIVRE_FAIL2BAN_CONFIGURATION
FAIL2BAN
systemctl enable fail2ban
systemctl restart fail2ban
fail2ban_ready=false
for _ in {1..15}; do
  if fail2ban-client ping >/dev/null 2>&1 \
    && fail2ban-client status sshd >/dev/null 2>&1 \
    && fail2ban_contract_is_ready; then
    fail2ban_ready=true
    break
  fi
  sleep 1
done
[[ ${fail2ban_ready} == true ]] || fail "Fail2ban não ficou pronto antes da transição."

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

publish_managed_file "$ipv4_rules" /etc/iptables/rules.v4 root root 0600 \
  || fail "regras IPv4 persistidas não puderam ser publicadas atomicamente."
publish_managed_file "$ipv6_rules" /etc/iptables/rules.v6 root root 0600 \
  || fail "regras IPv6 persistidas não puderam ser publicadas atomicamente."
systemctl enable netfilter-persistent
fail2ban_ready=false
for _ in {1..15}; do
  if fail2ban-client ping >/dev/null 2>&1 \
    && fail2ban-client status sshd >/dev/null 2>&1 \
    && fail2ban_contract_is_ready; then
    fail2ban_ready=true
    break
  fi
  sleep 1
done
[[ ${fail2ban_ready} == true ]] || fail "Fail2ban não ficou pronto."
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
ensure_fstab_swap_entry || fail "/etc/fstab é inválido ou não pôde ser publicado atomicamente."

nginx -t
systemctl daemon-reload
systemctl enable nginx unattended-upgrades
systemctl restart nginx
systemctl disable set-livre-web.service set-livre-backoffice.service
systemctl enable \
  set-livre-application-start.service \
  set-livre-release-recovery.path
systemctl start set-livre-release-recovery.path
systemctl enable --now snap.certbot.renew.timer

digest_source="$(mktemp "${HOST_STATE_DIRECTORY}/.host-config.XXXXXX")"
printf '%s\n' "$host_configuration_digest" > "$digest_source"
chown root:setlivre "$digest_source"
chmod 0640 "$digest_source"
mv --no-target-directory --force -- "$digest_source" "$HOST_CONFIGURATION_DIGEST"
digest_source=""
host_configuration_published=true
if [[ -n ${active_release_sha} && ${active_release_compatible} == true ]]; then
  write_bootstrap_recovery_marker "/opt/set-livre/releases/${active_release_sha}" \
    || fail "não foi possível armar a recuperação da release durante o bootstrap."
  publish_bootstrap_recovery_in_progress "$host_configuration_digest" \
    || fail "não foi possível persistir a fase de recovery do bootstrap."
fi
rm -f -- "$HOST_CONFIGURATION_PREVIOUS_DIGEST"
if [[ -n ${active_release_sha} && ${active_release_compatible} == true ]]; then
  rm -f -- "$HOST_BOOTSTRAP_IN_PROGRESS"
fi

if [[ -e /opt/set-livre/current || -L /opt/set-livre/current ]]; then
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
    if ! systemctl restart set-livre-web.service set-livre-backoffice.service \
      || ! wait_for_active_health "$active_release_sha" \
      || ! wait_for_active_public_health "$active_release_sha"; then
      systemctl stop set-livre-web.service set-livre-backoffice.service || true
      systemctl reset-failed set-livre-web.service set-livre-backoffice.service || true
      [[ -L /opt/set-livre/current \
        && $(readlink --canonicalize-existing /opt/set-livre/current) \
          == "/opt/set-livre/releases/${active_release_sha}" ]] \
        || fail "release ativa mudou durante a validação pós-bootstrap."
      publish_bootstrap_in_progress "$host_configuration_digest" \
        || fail "não foi possível bloquear a release após falha de readiness."
      rm -f -- \
        /opt/set-livre/current \
        "$HOST_BOOTSTRAP_RECOVERY_IN_PROGRESS" \
        "$ROLLBACK_MARKER"
      fail "release compatível não recuperou readiness; reenvie uma release aprovada."
    fi
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
bootstrap_gate_published=false
host_configuration_published=false
if [[ -n ${active_release_sha} && ${active_release_compatible} == true ]]; then
  rm -f -- "$HOST_BOOTSTRAP_RECOVERY_IN_PROGRESS"
  rm -f -- "$ROLLBACK_MARKER"
else
  rm -f -- "$HOST_BOOTSTRAP_IN_PROGRESS"
fi

if [[ -n ${active_release_sha} && ${active_release_compatible} == false ]]; then
  printf 'Host preparado; release incompatível permanece parada até o deploy do mesmo contrato.\n'
fi
printf 'Host preparado e contrato operacional publicado atomicamente.\n'
