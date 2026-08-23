#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077
IFS=$' \t\n'
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
unset BASH_ENV CDPATH CURL_HOME ENV GLOBIGNORE GREP_OPTIONS PYTHONHOME PYTHONPATH TAR_OPTIONS

readonly deployer_user=setlivre-deployer
readonly deployer_group=setlivre-deployer
readonly deployer_home=/var/lib/setlivre-deployer
readonly private_base="$deployer_home/.setlivre"
readonly incoming_base="$private_base/incoming"
readonly work_base="$private_base/work"
readonly state_base="$private_base/state"
readonly deploy_lock_path="$private_base/deploy.lock"
readonly configuration_directory=/etc/setlivre-deployer
readonly environment_path="$configuration_directory/production.env"
readonly credentials_directory="$configuration_directory/credentials"
readonly github_token_credential="$credentials_directory/github-deploy-token"
readonly supabase_access_token_credential="$credentials_directory/supabase-access-token"
readonly supabase_db_password_credential="$credentials_directory/supabase-db-password"
readonly database_url_credential="$credentials_directory/database-url-app-dal"
readonly supabase_server_ca_credential="$credentials_directory/supabase-server-ca.pem"
readonly installation_state="$configuration_directory/installation.state"
readonly transaction_base=/var/lib/setlivre-deployer-config
readonly transaction_directory="$transaction_base/active"
readonly transaction_state="$transaction_directory/state"
readonly transaction_discarding="$transaction_base/discarding"
readonly manager_update_directory="$transaction_base/manager-update"
readonly manager_update_state="$manager_update_directory/state"
readonly manager_update_discarding="$transaction_base/manager-update-discarding"
readonly agent_path=/usr/local/libexec/setlivre/production-deploy-agent
readonly smoke_path=/usr/local/libexec/setlivre/production-smoke.mjs
readonly dispatcher_path=/usr/local/sbin/setlivre-deploy-dispatch
readonly release_manager_path=/usr/local/sbin/setlivre-release-manager
readonly sudoers_path=/etc/sudoers.d/setlivre-deployer
readonly service_name=setlivre-production-deployer.service
readonly timer_name=setlivre-production-deployer.timer
readonly service_path="/etc/systemd/system/$service_name"
readonly timer_path="/etc/systemd/system/$timer_name"
readonly runtime_user=setlivre
readonly runtime_group=setlivre
readonly node_path=/usr/local/bin/node
readonly web_service_name=setlivre-web.service
readonly backoffice_service_name=setlivre-backoffice.service
readonly web_service_path="/etc/systemd/system/$web_service_name"
readonly backoffice_service_path="/etc/systemd/system/$backoffice_service_name"
readonly runtime_current=/opt/setlivre/shared/runtime/current
readonly web_runtime_credential="$runtime_current/web.env"
readonly backoffice_runtime_credential="$runtime_current/backoffice.env"
readonly web_entrypoint=/opt/setlivre/current/web/server.js
readonly backoffice_entrypoint=/opt/setlivre/current/backoffice/apps/backoffice/server.js
readonly web_working_directory=/opt/setlivre/current/web
readonly backoffice_working_directory=/opt/setlivre/current/backoffice/apps/backoffice
readonly installation_schema=5
readonly release_manager_protocol=3
readonly supabase_cli_version=2.113.0
readonly supabase_cli_sha256=c8dcd16db0bab7c27a1cc984aa6abbc8f5b2e36b90f58a579eacfbe719dd345d
readonly supabase_go_sha256=08fcb0d4e1eddc9bbc8d74553cb1883aa3ac9985789dc8d39306c278844a29d4
readonly host_tools_root=/usr/local/libexec/setlivre-host-tools
readonly supabase_tools_directory="$host_tools_root/$supabase_cli_version"
readonly supabase_cli_path="$supabase_tools_directory/supabase"
readonly supabase_go_path="$supabase_tools_directory/supabase-go"
readonly e2_micro_minimum_memtotal_mib=912
readonly e2_micro_maximum_memtotal_mib=1100
readonly minimum_host_memory_reserve_mib=320
readonly web_memory_high_mib=176
readonly web_memory_max_mib=240
readonly web_memory_swap_max_mib=128
readonly backoffice_memory_high_mib=112
readonly backoffice_memory_max_mib=160
readonly backoffice_memory_swap_max_mib=96
readonly deployer_memory_high_mib=128
readonly deployer_memory_max_mib=192
readonly deployer_memory_swap_max_mib=128
readonly deployer_node_old_space_mib=96
readonly web_node_old_space_mib=128
readonly backoffice_node_old_space_mib=96
readonly -a managed_installation_paths=(
  "$agent_path"
  "$smoke_path"
  "$dispatcher_path"
  "$sudoers_path"
  "$environment_path"
  "$github_token_credential"
  "$supabase_access_token_credential"
  "$supabase_db_password_credential"
  "$database_url_credential"
  "$supabase_server_ca_credential"
  "$service_path"
  "$timer_path"
  "$installation_state"
)

temporary_root=
transaction_active=0
transaction_preparing=
transaction_phase=
transaction_prior_installation=
transaction_agent_sha=none
transaction_smoke_sha=none
transaction_dispatcher_sha=none
transaction_sudoers_sha=none
transaction_environment_sha=none
transaction_github_token_sha=none
transaction_supabase_access_token_sha=none
transaction_supabase_db_password_sha=none
transaction_database_url_sha=none
transaction_supabase_server_ca_sha=none
transaction_service_sha=none
transaction_timer_sha=none
transaction_installation_state_sha=none
timer_previous_present=0
timer_previous_enabled=disabled
timer_previous_active=inactive
manager_update_active=0
manager_update_preparing=

fail() {
  printf '%s\n' "Set Livre production deployer configuration rejected the operation." >&2
  exit 1
}

usage() {
  printf '%s\n' \
    "Usage:" \
    "  $0 install /absolute/path/production-deploy-agent.sh <sha256> /absolute/path/production-smoke.mjs <sha256>" \
    "  $0 configure-delivery-identity <repository-id> <ci-workflow-id> <production-workflow-id>" \
    "  $0 configure-supabase-identity <project-ref>" \
    "  $0 update-manager /absolute/path/production-release-manager.sh <sha256>" \
    "  $0 verify" >&2
  exit 1
}

cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  set +e
  if [[ "$transaction_active" -eq 1 ]]; then
    if ! (recover_installation_transaction); then
      status=1
    fi
  fi
  if [[ "$manager_update_active" -eq 1 ]]; then
    if ! (recover_manager_update_transaction); then
      status=1
    fi
  fi
  if [[ -n "$manager_update_preparing" ]]; then
    if ! remove_root_private_tree "$manager_update_preparing" "$transaction_base"; then
      status=1
    fi
  fi
  if [[ -n "$transaction_preparing" ]]; then
    if ! cleanup_preparing_transaction "$transaction_preparing"; then
      status=1
    fi
  fi
  if [[ -n "$temporary_root" && "$temporary_root" == /run/setlivre-deployer-install.* ]]; then
    if ! remove_temporary_root "$temporary_root"; then
      status=1
    fi
  fi
  exit "$status"
}

require_root() {
  [[ "$EUID" -eq 0 ]] || fail
}

require_host() {
  [[ -r /etc/os-release ]] || fail
  # shellcheck disable=SC1091
  source /etc/os-release
  [[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == 24.04 ]] || fail
  [[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || fail
  [[ "$(dpkg --print-architecture)" == amd64 ]] || fail
}

require_commands() {
  local command_name
  for command_name in \
    awk bash cat chmod chown curl cut dpkg env find flock getent groupadd id install mktemp mv \
    node openssl passwd psql python3 readlink rm rmdir sha256sum sort stat sudo sync systemctl \
    systemd-analyze systemd-run tar timeout useradd visudo; do
    command -v "$command_name" >/dev/null 2>&1 || fail
  done
}

assert_e2_micro_memory_budget() {
  local memtotal_kib
  local memtotal_mib
  local managed_memory_high_mib
  local managed_memory_max_mib
  local managed_memory_swap_max_mib
  memtotal_kib="$(awk '$1 == "MemTotal:" && NF == 3 && $3 == "kB" { print $2 }' /proc/meminfo)" || fail
  [[ "$memtotal_kib" =~ ^[1-9][0-9]*$ ]] || fail
  memtotal_mib=$((memtotal_kib / 1024))
  ((memtotal_mib >= e2_micro_minimum_memtotal_mib)) || fail
  ((memtotal_mib <= e2_micro_maximum_memtotal_mib)) || fail
  ((deployer_node_old_space_mib < deployer_memory_high_mib)) || fail
  managed_memory_high_mib=$((
    web_memory_high_mib + backoffice_memory_high_mib + deployer_memory_high_mib
  ))
  managed_memory_max_mib=$((
    web_memory_max_mib + backoffice_memory_max_mib + deployer_memory_max_mib
  ))
  managed_memory_swap_max_mib=$((
    web_memory_swap_max_mib + backoffice_memory_swap_max_mib + deployer_memory_swap_max_mib
  ))
  ((managed_memory_high_mib < managed_memory_max_mib)) || fail
  ((managed_memory_max_mib + minimum_host_memory_reserve_mib <= memtotal_mib)) || fail
  ((managed_memory_swap_max_mib <= 512)) || fail
}

assert_service_memory_contract() {
  local unit_name="$1"
  local memory_high_mib="$2"
  local memory_max_mib="$3"
  local memory_swap_max_mib="$4"
  [[ "$(systemd_property "$unit_name" MemoryAccounting)" == yes ]] || fail
  [[ "$(systemd_property "$unit_name" MemoryHigh)" \
    == "$((memory_high_mib * 1024 * 1024))" ]] || fail
  [[ "$(systemd_property "$unit_name" MemoryMax)" \
    == "$((memory_max_mib * 1024 * 1024))" ]] || fail
  [[ "$(systemd_property "$unit_name" MemorySwapMax)" \
    == "$((memory_swap_max_mib * 1024 * 1024))" ]] || fail
  [[ "$(systemd_property "$unit_name" OOMPolicy)" == kill ]] || fail
}

assert_managed_service_memory_contracts() {
  assert_service_memory_contract \
    setlivre-web.service "$web_memory_high_mib" "$web_memory_max_mib" "$web_memory_swap_max_mib"
  assert_service_memory_contract \
    setlivre-backoffice.service "$backoffice_memory_high_mib" \
    "$backoffice_memory_max_mib" "$backoffice_memory_swap_max_mib"
  assert_service_memory_contract \
    "$service_name" "$deployer_memory_high_mib" \
    "$deployer_memory_max_mib" "$deployer_memory_swap_max_mib"
}

assert_sha256() {
  [[ "$1" =~ ^[0-9a-f]{64}$ ]] || fail
}

file_sha256() {
  local path="$1"
  local output
  local digest
  output="$(sha256sum -- "$path")" || fail
  digest="${output%% *}"
  assert_sha256 "$digest"
  printf '%s\n' "$digest"
}

require_no_pending_reboot() {
  [[ ! -e /var/run/reboot-required && ! -L /var/run/reboot-required ]] || fail
}

assert_root_tool_directory() {
  local path="$1"
  [[ -d "$path" && ! -L "$path" ]] || fail
  [[ "$(readlink --canonicalize-existing -- "$path")" == "$path" ]] || fail
  [[ "$(stat -c '%U:%G:%a' -- "$path")" == root:root:755 ]] || fail
}

assert_root_host_tool() {
  local path="$1"
  local expected_sha256="$2"
  assert_sha256 "$expected_sha256"
  [[ -f "$path" && ! -L "$path" ]] || fail
  [[ "$(readlink --canonicalize-existing -- "$path")" == "$path" ]] || fail
  [[ "$(stat -c '%U:%G:%a:%h' -- "$path")" == root:root:755:1 ]] || fail
  [[ "$(file_sha256 "$path")" == "$expected_sha256" ]] || fail
}

assert_host_supabase_cli() {
  local directory
  for directory in \
    /usr /usr/local /usr/local/libexec "$host_tools_root" "$supabase_tools_directory"; do
    assert_root_tool_directory "$directory"
  done
  assert_root_host_tool "$supabase_cli_path" "$supabase_cli_sha256"
  assert_root_host_tool "$supabase_go_path" "$supabase_go_sha256"
  python3 - "$supabase_cli_path" "$supabase_go_path" <<'HOST_SUPABASE_ELF_PY'
import os
import struct
import sys

for path in sys.argv[1:]:
    information = os.stat(path, follow_symlinks=False)
    if information.st_nlink != 1 or information.st_size <= 0 or information.st_size > 256 * 1024 * 1024:
        raise SystemExit(1)
    with open(path, "rb") as source:
        header = source.read(20)
    if len(header) != 20 or header[:6] != b"\x7fELF\x02\x01":
        raise SystemExit(1)
    if struct.unpack("<H", header[18:20])[0] != 62:
        raise SystemExit(1)
HOST_SUPABASE_ELF_PY
  local version
  version="$(env -i \
    HOME=/nonexistent \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    "$supabase_cli_path" --version)" || fail
  [[ "$version" == "$supabase_cli_version" ]] || fail
}

assert_root_file() {
  local path="$1"
  local mode="$2"
  [[ -f "$path" && ! -L "$path" ]] || fail
  [[ "$(readlink --canonicalize-existing -- "$path")" == "$path" ]] || fail
  [[ "$(stat -c '%U:%G:%a:%h' -- "$path")" == "root:root:$mode:1" ]] || fail
}

assert_deployer_file() {
  local path="$1"
  local mode="$2"
  [[ -f "$path" && ! -L "$path" ]] || fail
  [[ "$(readlink --canonicalize-existing -- "$path")" == "$path" ]] || fail
  [[ "$(stat -c '%U:%G:%a:%h' -- "$path")" == "root:$deployer_group:$mode:1" ]] || fail
}

assert_directory() {
  local path="$1"
  local owner="$2"
  local group="$3"
  local mode="$4"
  [[ -d "$path" && ! -L "$path" ]] || fail
  [[ "$(readlink --canonicalize-existing -- "$path")" == "$path" ]] || fail
  [[ "$(stat -c '%U:%G:%a' -- "$path")" == "$owner:$group:$mode" ]] || fail
}

assert_install_source() {
  local path="$1"
  local expected_sha="$2"
  [[ "$path" == /* ]] || fail
  assert_sha256 "$expected_sha"
  [[ -f "$path" && ! -L "$path" ]] || fail
  [[ "$(readlink --canonicalize-existing -- "$path")" == "$path" ]] || fail
  [[ "$(stat -c '%U:%G:%h' -- "$path")" == root:root:1 ]] || fail
  [[ $((8#$(stat -c '%a' -- "$path") & 8#022)) -eq 0 ]] || fail
  [[ "$(file_sha256 "$path")" == "$expected_sha" ]] || fail
}

assert_owned_file() {
  local path="$1"
  local owner="$2"
  local group="$3"
  local mode="$4"
  [[ -f "$path" && ! -L "$path" ]] || fail
  [[ "$(readlink --canonicalize-existing -- "$path")" == "$path" ]] || fail
  [[ "$(stat -c '%U:%G:%a:%h' -- "$path")" == "$owner:$group:$mode:1" ]] || fail
}

assert_path_sha256() {
  local path="$1"
  local expected_sha="$2"
  assert_sha256 "$expected_sha"
  [[ "$(file_sha256 "$path")" == "$expected_sha" ]] || fail
}

freeze_install_source() {
  local source="$1"
  local expected_sha="$2"
  local frozen="$3"
  assert_install_source "$source" "$expected_sha"
  [[ "$frozen" == "$temporary_root/"* ]] || fail
  [[ ! -e "$frozen" && ! -L "$frozen" ]] || fail
  install -o root -g root -m 0600 -- "$source" "$frozen"
  assert_owned_file "$frozen" root root 600
  assert_path_sha256 "$frozen" "$expected_sha"
  sync -- "$frozen"
}

assert_frozen_source() {
  local frozen="$1"
  local expected_sha="$2"
  [[ "$frozen" == "$temporary_root/"* ]] || fail
  assert_owned_file "$frozen" root root 600
  assert_path_sha256 "$frozen" "$expected_sha"
}

atomic_install() {
  local source="$1"
  local destination="$2"
  local owner="$3"
  local group="$4"
  local mode="$5"
  local destination_directory="${destination%/*}"
  local destination_name="${destination##*/}"
  local candidate="$destination_directory/.${destination_name}.setlivre-installing"
  local directory_owner
  local directory_mode
  local source_sha
  local candidate_sha
  local destination_sha

  [[ -f "$source" && ! -L "$source" ]] || fail
  [[ -d "$destination_directory" && ! -L "$destination_directory" ]] || fail
  [[ "$(readlink --canonicalize-existing -- "$destination_directory")" == \
    "$destination_directory" ]] || fail
  directory_owner="$(stat -c '%U' -- "$destination_directory")"
  directory_mode="$(stat -c '%a' -- "$destination_directory")"
  [[ "$directory_owner" == root && "$directory_mode" =~ ^[0-7]{3,4}$ ]] || fail
  [[ $((8#$directory_mode & 8#022)) -eq 0 ]] || fail
  if [[ -e "$destination" || -L "$destination" ]]; then
    [[ -f "$destination" && ! -L "$destination" ]] || fail
    [[ "$(readlink --canonicalize-existing -- "$destination")" == "$destination" ]] || fail
    [[ "$(stat -c '%h' -- "$destination")" == 1 ]] || fail
  fi
  [[ ! -e "$candidate" && ! -L "$candidate" ]] || fail
  source_sha="$(file_sha256 "$source")" || fail

  install -o "$owner" -g "$group" -m "$mode" -- "$source" "$candidate"
  assert_owned_file "$candidate" "$owner" "$group" "$mode"
  candidate_sha="$(file_sha256 "$candidate")" || fail
  [[ "$candidate_sha" == "$source_sha" ]] || fail
  sync -- "$candidate"
  mv --no-target-directory -- "$candidate" "$destination"
  sync -- "$destination"
  assert_owned_file "$destination" "$owner" "$group" "$mode"
  destination_sha="$(file_sha256 "$destination")" || fail
  [[ "$destination_sha" == "$source_sha" ]] || fail
}

ensure_transaction_base() {
  if [[ ! -e "$transaction_base" && ! -L "$transaction_base" ]]; then
    install -d -o root -g root -m 0700 -- "$transaction_base"
  fi
  assert_directory "$transaction_base" root root 700
}

assert_transaction_directory() {
  local path="$1"
  [[ "$path" == "$transaction_directory" ]] || return 1
  [[ -d "$path" && ! -L "$path" ]] || return 1
  [[ "$(readlink --canonicalize-existing -- "$path")" == "$path" ]] || return 1
  [[ "$(stat -c '%U:%G:%a' -- "$path")" == root:root:700 ]] || return 1
}

assert_preparing_transaction_directory() {
  local path="$1"
  local suffix
  [[ "$path" == "$transaction_base/.preparing."* ]] || return 1
  suffix="${path#"$transaction_base/.preparing."}"
  [[ "$suffix" =~ ^[A-Za-z0-9]{8}$ ]] || return 1
  [[ -d "$path" && ! -L "$path" ]] || return 1
  [[ "$(readlink --canonicalize-existing -- "$path")" == "$path" ]] || return 1
  [[ "$(stat -c '%U:%G:%a' -- "$path")" == root:root:700 ]] || return 1
}

assert_no_mount_at_or_below() {
  local candidate="$1"
  python3 - "$candidate" /proc/self/mountinfo <<'PY'
import os
import re
import sys

candidate, mountinfo_path = sys.argv[1:]
if not os.path.isabs(candidate) or os.path.realpath(candidate) != candidate:
    raise SystemExit(1)
escapes = {"011": "\t", "012": "\n", "040": " ", "134": "\\"}


def decode(value):
    output = []
    index = 0
    while index < len(value):
        if value[index] != "\\":
            output.append(value[index])
            index += 1
            continue
        escape = value[index + 1 : index + 4]
        if len(escape) != 3 or escape not in escapes:
            raise ValueError
        output.append(escapes[escape])
        index += 4
    decoded = "".join(output)
    if "\x00" in decoded:
        raise ValueError
    return decoded


try:
    with open(mountinfo_path, "r", encoding="utf-8") as source:
        lines = source.read().splitlines()
    if not lines or any(not line for line in lines):
        raise ValueError
    for line in lines:
        fields = line.split(" ")
        separator = fields.index("-")
        if (
            any(not field for field in fields)
            or separator < 6
            or separator != len(fields) - 4
            or re.fullmatch(r"[0-9]+", fields[0]) is None
            or re.fullmatch(r"[0-9]+", fields[1]) is None
            or re.fullmatch(r"[0-9]+:[0-9]+", fields[2]) is None
        ):
            raise ValueError
        mount_point = decode(fields[4])
        if not os.path.isabs(mount_point) or os.path.normpath(mount_point) != mount_point:
            raise ValueError
        if os.path.commonpath((candidate, mount_point)) == candidate:
            raise SystemExit(1)
except (OSError, UnicodeError, ValueError):
    raise SystemExit(1)
PY
}

retire_and_remove_root_tree() {
  local candidate="$1"
  local parent="$2"
  local original="$candidate"
  local candidate_identity
  local retired="$parent/.cleanup-retired-${candidate##*/}"
  local unsafe_entry
  [[ "$candidate" == "$parent/"* && "$candidate" != "$parent/" ]] || return 1
  [[ "$retired" == "$parent/.cleanup-retired-"* && "$retired" != "$original" ]] || return 1
  if [[ -e "$retired" || -L "$retired" ]]; then
    [[ ! -e "$original" && ! -L "$original" ]] || return 1
    candidate="$retired"
  elif [[ ! -e "$candidate" && ! -L "$candidate" ]]; then
    return 0
  fi
  [[ -d "$candidate" && ! -L "$candidate" ]] || return 1
  [[ "$(readlink --canonicalize-existing -- "$candidate")" == "$candidate" ]] || return 1
  [[ "$(stat -c '%U:%G:%a' -- "$candidate")" == root:root:700 ]] || return 1
  [[ "$(stat -c '%d' -- "$candidate")" == "$(stat -c '%d' -- "$parent")" ]] || return 1
  assert_no_mount_at_or_below "$candidate" || return 1
  candidate_identity="$(stat -c '%d:%i' -- "$candidate")" || return 1
  if [[ "$candidate" == "$original" ]]; then
    [[ ! -e "$retired" && ! -L "$retired" ]] || return 1
    mv --no-target-directory --no-clobber -- "$original" "$retired" || return 1
    [[ ! -e "$original" && ! -L "$original" ]] || return 1
  fi
  [[ -d "$retired" && ! -L "$retired" ]] || return 1
  [[ "$(readlink --canonicalize-existing -- "$retired")" == "$retired" ]] || return 1
  [[ "$(stat -c '%d:%i' -- "$retired")" == "$candidate_identity" ]] || return 1
  assert_no_mount_at_or_below "$retired" || return 1
  unsafe_entry="$(find "$retired" -xdev ! -type f ! -type d -print -quit)" || return 1
  [[ -z "$unsafe_entry" ]] || return 1
  assert_no_mount_at_or_below "$retired" || return 1
  rm -rf --one-file-system -- "$retired" || return 1
  sync -- "$parent" || return 1
  [[ ! -e "$retired" && ! -L "$retired" ]] || return 1
}

remove_temporary_root() {
  local candidate="$1"
  local parent=/run
  [[ "$candidate" == /run/setlivre-deployer-install.* ]] || return 1
  [[ -d "$parent" && ! -L "$parent" ]] || return 1
  [[ "$(readlink --canonicalize-existing -- "$parent")" == "$parent" ]] || return 1
  [[ "$(stat -c '%U:%G:%a' -- "$parent")" == root:root:755 ]] || return 1
  retire_and_remove_root_tree "$candidate" "$parent"
}

remove_root_private_tree() {
  local candidate="$1"
  local parent="$2"
  [[ "$candidate" == "$parent/"* && "$candidate" != "$parent/" ]] || return 1
  assert_directory "$parent" root root 700 || return 1
  retire_and_remove_root_tree "$candidate" "$parent"
}

cleanup_preparing_transaction() {
  local path="$1"
  assert_preparing_transaction_directory "$path" || return 1
  remove_root_private_tree "$path" "$transaction_base" || return 1
  if [[ "$transaction_preparing" == "$path" ]]; then
    transaction_preparing=
  fi
}

recover_orphaned_transaction_preparations() {
  local -a paths=()
  local inventory
  [[ -n "$temporary_root" && "$temporary_root" == /run/setlivre-deployer-install.* ]] || fail
  inventory="$(mktemp "$temporary_root/transaction-preparations.XXXXXXXX")"
  assert_owned_file "$inventory" root root 600
  find "$transaction_base" -mindepth 1 -maxdepth 1 -name '.preparing.*' -print0 \
    >"$inventory" || fail
  mapfile -d '' -t paths <"$inventory" || fail
  rm -f -- "$inventory" || fail
  [[ ! -e "$inventory" && ! -L "$inventory" ]] || fail
  local path
  for path in "${paths[@]}"; do
    cleanup_preparing_transaction "$path" || fail
  done
}

assert_no_pending_installation_transaction() {
  assert_directory "$transaction_base" root root 700
  local pending
  pending="$(find "$transaction_base" -mindepth 1 -maxdepth 1 -print -quit)" || fail
  [[ -z "$pending" ]] || fail
}

assert_no_managed_installation() {
  local path
  for path in "${managed_installation_paths[@]}"; do
    [[ ! -e "$path" && ! -L "$path" ]] || fail
  done
  [[ ! -e "$credentials_directory" && ! -L "$credentials_directory" ]] || fail
}

backup_managed_installation() {
  local destination="$1"
  install -d -o root -g root -m 0700 -- "$destination"
  install -o root -g root -m 0600 -- "$agent_path" "$destination/agent"
  install -o root -g root -m 0600 -- "$smoke_path" "$destination/smoke"
  install -o root -g root -m 0600 -- "$dispatcher_path" "$destination/dispatcher"
  install -o root -g root -m 0600 -- "$sudoers_path" "$destination/sudoers"
  install -o root -g root -m 0600 -- "$environment_path" "$destination/environment"
  install -o root -g root -m 0600 -- "$github_token_credential" "$destination/github-token"
  install -o root -g root -m 0600 -- \
    "$supabase_access_token_credential" "$destination/supabase-access-token"
  install -o root -g root -m 0600 -- \
    "$supabase_db_password_credential" "$destination/supabase-db-password"
  install -o root -g root -m 0600 -- "$database_url_credential" "$destination/database-url"
  install -o root -g root -m 0600 -- \
    "$supabase_server_ca_credential" "$destination/supabase-server-ca.pem"
  install -o root -g root -m 0600 -- "$service_path" "$destination/service"
  install -o root -g root -m 0600 -- "$timer_path" "$destination/timer"
  install -o root -g root -m 0600 -- "$installation_state" "$destination/installation-state"
  local backup
  for backup in "$destination"/*; do
    assert_owned_file "$backup" root root 600
    sync -- "$backup"
  done
  sync -- "$destination"
  transaction_agent_sha="$(file_sha256 "$destination/agent")" || fail
  transaction_smoke_sha="$(file_sha256 "$destination/smoke")" || fail
  transaction_dispatcher_sha="$(file_sha256 "$destination/dispatcher")" || fail
  transaction_sudoers_sha="$(file_sha256 "$destination/sudoers")" || fail
  transaction_environment_sha="$(file_sha256 "$destination/environment")" || fail
  transaction_github_token_sha="$(file_sha256 "$destination/github-token")" || fail
  transaction_supabase_access_token_sha="$(file_sha256 "$destination/supabase-access-token")" \
    || fail
  transaction_supabase_db_password_sha="$(file_sha256 "$destination/supabase-db-password")" \
    || fail
  transaction_database_url_sha="$(file_sha256 "$destination/database-url")" || fail
  transaction_supabase_server_ca_sha="$(file_sha256 "$destination/supabase-server-ca.pem")" \
    || fail
  transaction_service_sha="$(file_sha256 "$destination/service")" || fail
  transaction_timer_sha="$(file_sha256 "$destination/timer")" || fail
  transaction_installation_state_sha="$(file_sha256 "$destination/installation-state")" \
    || fail
  local -a hashes=(
    "$transaction_agent_sha"
    "$transaction_smoke_sha"
    "$transaction_dispatcher_sha"
    "$transaction_sudoers_sha"
    "$transaction_environment_sha"
    "$transaction_github_token_sha"
    "$transaction_supabase_access_token_sha"
    "$transaction_supabase_db_password_sha"
    "$transaction_database_url_sha"
    "$transaction_supabase_server_ca_sha"
    "$transaction_service_sha"
    "$transaction_timer_sha"
    "$transaction_installation_state_sha"
  )
  local hash
  for hash in "${hashes[@]}"; do
    assert_sha256 "$hash"
  done
}

assert_transaction_backup() {
  local -a hashes=(
    "$transaction_agent_sha"
    "$transaction_smoke_sha"
    "$transaction_dispatcher_sha"
    "$transaction_sudoers_sha"
    "$transaction_environment_sha"
    "$transaction_github_token_sha"
    "$transaction_supabase_access_token_sha"
    "$transaction_supabase_db_password_sha"
    "$transaction_database_url_sha"
    "$transaction_supabase_server_ca_sha"
    "$transaction_service_sha"
    "$transaction_timer_sha"
    "$transaction_installation_state_sha"
  )
  local hash
  if [[ "$transaction_prior_installation" == absent ]]; then
    for hash in "${hashes[@]}"; do
      [[ "$hash" == none ]] || fail
    done
    [[ ! -e "$transaction_directory/backup" \
      && ! -L "$transaction_directory/backup" ]] || fail
    return 0
  fi
  for hash in "${hashes[@]}"; do
    assert_sha256 "$hash"
  done
  local backup="$transaction_directory/backup"
  assert_directory "$backup" root root 700
  local -a names=(
    agent
    smoke
    dispatcher
    sudoers
    environment
    github-token
    supabase-access-token
    supabase-db-password
    database-url
    supabase-server-ca.pem
    service
    timer
    installation-state
  )
  local index
  for index in "${!names[@]}"; do
    assert_owned_file "$backup/${names[$index]}" root root 600
    [[ "$(file_sha256 "$backup/${names[$index]}")" == "${hashes[$index]}" ]] || fail
  done
}

write_transaction_state_file() {
  local destination="$1"
  local phase="$2"
  local prior_installation="$3"
  local previous_present="$4"
  local previous_enabled="$5"
  local previous_active="$6"
  [[ "$phase" == prepared || "$phase" == committed ]] || fail
  [[ "$prior_installation" == present || "$prior_installation" == absent ]] || fail
  [[ "$previous_present" == 0 || "$previous_present" == 1 ]] || fail
  [[ "$previous_enabled" == enabled || "$previous_enabled" == disabled ]] || fail
  [[ "$previous_active" == active || "$previous_active" == inactive ]] || fail
  if [[ "$prior_installation" == present ]]; then
    [[ "$previous_present" == 1 ]] || fail
  else
    [[ "$previous_present" == 0 && "$previous_enabled" == disabled \
      && "$previous_active" == inactive ]] || fail
  fi
  printf '%s\n' \
    schema=3 \
    "phase=$phase" \
    "prior_installation=$prior_installation" \
    "timer_previous_present=$previous_present" \
    "timer_previous_enabled=$previous_enabled" \
    "timer_previous_active=$previous_active" \
    "agent_sha256=$transaction_agent_sha" \
    "smoke_sha256=$transaction_smoke_sha" \
    "dispatcher_sha256=$transaction_dispatcher_sha" \
    "sudoers_sha256=$transaction_sudoers_sha" \
    "environment_sha256=$transaction_environment_sha" \
    "github_token_sha256=$transaction_github_token_sha" \
    "supabase_access_token_sha256=$transaction_supabase_access_token_sha" \
    "supabase_db_password_sha256=$transaction_supabase_db_password_sha" \
    "database_url_sha256=$transaction_database_url_sha" \
    "supabase_server_ca_sha256=$transaction_supabase_server_ca_sha" \
    "service_sha256=$transaction_service_sha" \
    "timer_sha256=$transaction_timer_sha" \
    "installation_state_sha256=$transaction_installation_state_sha" \
    >"$destination"
  chown root:root "$destination"
  chmod 0600 "$destination"
  sync -- "$destination"
  assert_owned_file "$destination" root root 600
}

load_transaction_state() {
  local -a lines=()
  assert_transaction_directory "$transaction_directory" || fail
  assert_root_file "$transaction_state" 600
  mapfile -t lines <"$transaction_state"
  [[ "${#lines[@]}" -eq 19 ]] || fail
  [[ "${lines[0]}" == schema=3 ]] || fail
  [[ "${lines[1]}" =~ ^phase=(prepared|committed)$ ]] || fail
  transaction_phase="${BASH_REMATCH[1]}"
  [[ "${lines[2]}" =~ ^prior_installation=(present|absent)$ ]] || fail
  transaction_prior_installation="${BASH_REMATCH[1]}"
  [[ "${lines[3]}" =~ ^timer_previous_present=([01])$ ]] || fail
  timer_previous_present="${BASH_REMATCH[1]}"
  [[ "${lines[4]}" =~ ^timer_previous_enabled=(enabled|disabled)$ ]] || fail
  timer_previous_enabled="${BASH_REMATCH[1]}"
  [[ "${lines[5]}" =~ ^timer_previous_active=(active|inactive)$ ]] || fail
  timer_previous_active="${BASH_REMATCH[1]}"
  [[ "${lines[6]}" =~ ^agent_sha256=(none|[0-9a-f]{64})$ ]] || fail
  transaction_agent_sha="${BASH_REMATCH[1]}"
  [[ "${lines[7]}" =~ ^smoke_sha256=(none|[0-9a-f]{64})$ ]] || fail
  transaction_smoke_sha="${BASH_REMATCH[1]}"
  [[ "${lines[8]}" =~ ^dispatcher_sha256=(none|[0-9a-f]{64})$ ]] || fail
  transaction_dispatcher_sha="${BASH_REMATCH[1]}"
  [[ "${lines[9]}" =~ ^sudoers_sha256=(none|[0-9a-f]{64})$ ]] || fail
  transaction_sudoers_sha="${BASH_REMATCH[1]}"
  [[ "${lines[10]}" =~ ^environment_sha256=(none|[0-9a-f]{64})$ ]] || fail
  transaction_environment_sha="${BASH_REMATCH[1]}"
  [[ "${lines[11]}" =~ ^github_token_sha256=(none|[0-9a-f]{64})$ ]] || fail
  transaction_github_token_sha="${BASH_REMATCH[1]}"
  [[ "${lines[12]}" =~ ^supabase_access_token_sha256=(none|[0-9a-f]{64})$ ]] || fail
  transaction_supabase_access_token_sha="${BASH_REMATCH[1]}"
  [[ "${lines[13]}" =~ ^supabase_db_password_sha256=(none|[0-9a-f]{64})$ ]] || fail
  transaction_supabase_db_password_sha="${BASH_REMATCH[1]}"
  [[ "${lines[14]}" =~ ^database_url_sha256=(none|[0-9a-f]{64})$ ]] || fail
  transaction_database_url_sha="${BASH_REMATCH[1]}"
  [[ "${lines[15]}" =~ ^supabase_server_ca_sha256=(none|[0-9a-f]{64})$ ]] || fail
  transaction_supabase_server_ca_sha="${BASH_REMATCH[1]}"
  [[ "${lines[16]}" =~ ^service_sha256=(none|[0-9a-f]{64})$ ]] || fail
  transaction_service_sha="${BASH_REMATCH[1]}"
  [[ "${lines[17]}" =~ ^timer_sha256=(none|[0-9a-f]{64})$ ]] || fail
  transaction_timer_sha="${BASH_REMATCH[1]}"
  [[ "${lines[18]}" =~ ^installation_state_sha256=(none|[0-9a-f]{64})$ ]] || fail
  transaction_installation_state_sha="${BASH_REMATCH[1]}"
  if [[ "$transaction_prior_installation" == present ]]; then
    [[ "$timer_previous_present" == 1 ]] || fail
  else
    [[ "$timer_previous_present" == 0 && "$timer_previous_enabled" == disabled \
      && "$timer_previous_active" == inactive ]] || fail
  fi
  assert_transaction_backup
}

prepare_installation_transaction() {
  ensure_transaction_base
  recover_orphaned_transaction_preparations
  [[ ! -e "$transaction_directory" && ! -L "$transaction_directory" ]] || fail
  if [[ -e "$installation_state" || -L "$installation_state" ]]; then
    verify_installation
    transaction_prior_installation=present
    [[ "$timer_previous_present" == 1 ]] || fail
  else
    assert_no_managed_installation
    transaction_prior_installation=absent
    transaction_agent_sha=none
    transaction_smoke_sha=none
    transaction_dispatcher_sha=none
    transaction_sudoers_sha=none
    transaction_environment_sha=none
    transaction_github_token_sha=none
    transaction_supabase_access_token_sha=none
    transaction_supabase_db_password_sha=none
    transaction_database_url_sha=none
    transaction_supabase_server_ca_sha=none
    transaction_service_sha=none
    transaction_timer_sha=none
    transaction_installation_state_sha=none
    [[ "$timer_previous_present" == 0 ]] || fail
  fi
  transaction_preparing="$(mktemp -d "$transaction_base/.preparing.XXXXXXXX")"
  assert_preparing_transaction_directory "$transaction_preparing" || fail
  if [[ "$transaction_prior_installation" == present ]]; then
    backup_managed_installation "$transaction_preparing/backup"
  fi
  write_transaction_state_file \
    "$transaction_preparing/state" \
    prepared \
    "$transaction_prior_installation" \
    "$timer_previous_present" \
    "$timer_previous_enabled" \
    "$timer_previous_active"
  sync -- "$transaction_preparing"
  mv --no-target-directory -- "$transaction_preparing" "$transaction_directory"
  transaction_active=1
  transaction_preparing=
  sync -- "$transaction_base"
  assert_transaction_directory "$transaction_directory" || fail
}

set_installation_transaction_phase() {
  local phase="$1"
  local candidate="$transaction_directory/.state.setlivre-installing"
  assert_transaction_directory "$transaction_directory" || fail
  [[ ! -e "$candidate" && ! -L "$candidate" ]] || fail
  write_transaction_state_file \
    "$candidate" \
    "$phase" \
    "$transaction_prior_installation" \
    "$timer_previous_present" \
    "$timer_previous_enabled" \
    "$timer_previous_active"
  mv --no-target-directory -- "$candidate" "$transaction_state"
  sync -- "$transaction_directory"
  load_transaction_state
  [[ "$transaction_phase" == "$phase" ]] || fail
}

remove_atomic_install_candidates() {
  local destination
  local candidate
  for destination in "${managed_installation_paths[@]}"; do
    candidate="${destination%/*}/.${destination##*/}.setlivre-installing"
    if [[ -e "$candidate" || -L "$candidate" ]]; then
      [[ -f "$candidate" && ! -L "$candidate" ]] || fail
      rm -f -- "$candidate" || fail
    fi
  done
}

restore_managed_installation() {
  local backup="$transaction_directory/backup"
  assert_transaction_backup
  remove_atomic_install_candidates
  atomic_install "$backup/agent" "$agent_path" root "$deployer_group" 750
  atomic_install "$backup/smoke" "$smoke_path" root "$deployer_group" 640
  atomic_install "$backup/dispatcher" "$dispatcher_path" root root 750
  atomic_install "$backup/sudoers" "$sudoers_path" root root 440
  atomic_install "$backup/environment" "$environment_path" root "$deployer_group" 640
  install -d -o root -g root -m 0700 -- "$credentials_directory"
  atomic_install "$backup/github-token" "$github_token_credential" root root 600
  atomic_install \
    "$backup/supabase-access-token" "$supabase_access_token_credential" root root 600
  atomic_install \
    "$backup/supabase-db-password" "$supabase_db_password_credential" root root 600
  atomic_install "$backup/database-url" "$database_url_credential" root root 600
  atomic_install \
    "$backup/supabase-server-ca.pem" "$supabase_server_ca_credential" root root 600
  atomic_install "$backup/service" "$service_path" root root 644
  atomic_install "$backup/timer" "$timer_path" root root 644
  atomic_install "$backup/installation-state" "$installation_state" root root 600
  systemctl daemon-reload
  visudo --check >/dev/null
  verify_installation
  restore_timer_state
}

remove_managed_installation() {
  local destination
  remove_atomic_install_candidates
  for destination in "${managed_installation_paths[@]}"; do
    if [[ -e "$destination" || -L "$destination" ]]; then
      [[ -f "$destination" && ! -L "$destination" ]] || fail
      rm -f -- "$destination" || fail
      sync -- "${destination%/*}"
    fi
  done
  if [[ -e "$credentials_directory" || -L "$credentials_directory" ]]; then
    assert_directory "$credentials_directory" root root 700
    rmdir -- "$credentials_directory" || fail
    sync -- "$configuration_directory"
  fi
  systemctl daemon-reload
  visudo --check >/dev/null
  assert_no_managed_installation
}

cleanup_installation_transaction() {
  assert_transaction_directory "$transaction_directory" || fail
  [[ ! -e "$transaction_discarding" && ! -L "$transaction_discarding" ]] || fail
  mv --no-target-directory -- "$transaction_directory" "$transaction_discarding"
  sync -- "$transaction_base"
  [[ -d "$transaction_discarding" && ! -L "$transaction_discarding" ]] || fail
  [[ "$(readlink --canonicalize-existing -- "$transaction_discarding")" \
    == "$transaction_discarding" ]] || fail
  [[ "$(stat -c '%U:%G:%a' -- "$transaction_discarding")" == root:root:700 ]] || fail
  remove_root_private_tree "$transaction_discarding" "$transaction_base" || fail
  [[ ! -e "$transaction_directory" && ! -L "$transaction_directory" ]] || fail
  transaction_active=0
  transaction_phase=
  transaction_prior_installation=
}

assert_restored_timer_state() {
  [[ "$(systemd_enabled_state "$timer_name")" == "$timer_previous_enabled" ]] || fail
  [[ "$(systemd_active_state "$timer_name")" == "$timer_previous_active" ]] || fail
}

recover_installation_transaction() {
  ensure_transaction_base
  recover_orphaned_transaction_preparations
  if [[ -e "$transaction_discarding" || -L "$transaction_discarding" ]]; then
    [[ -d "$transaction_discarding" && ! -L "$transaction_discarding" ]] || fail
    [[ "$(readlink --canonicalize-existing -- "$transaction_discarding")" \
      == "$transaction_discarding" ]] || fail
    [[ "$(stat -c '%U:%G:%a' -- "$transaction_discarding")" == root:root:700 ]] || fail
    remove_root_private_tree "$transaction_discarding" "$transaction_base" || fail
  fi
  if [[ ! -e "$transaction_directory" && ! -L "$transaction_directory" ]]; then
    transaction_active=0
    return 0
  fi
  transaction_active=1
  load_transaction_state
  case "$transaction_phase" in
    prepared)
      quiesce_deployer
      if [[ "$transaction_prior_installation" == present ]]; then
        restore_managed_installation
        assert_restored_timer_state
      else
        remove_managed_installation
      fi
      ;;
    committed)
      verify_installation
      assert_restored_timer_state
      ;;
    *) fail ;;
  esac
  cleanup_installation_transaction
}

assert_manager_update_directory() {
  [[ -d "$manager_update_directory" && ! -L "$manager_update_directory" ]] || fail
  [[ "$(readlink --canonicalize-existing -- "$manager_update_directory")" \
    == "$manager_update_directory" ]] || fail
  [[ "$(stat -c '%U:%G:%a' -- "$manager_update_directory")" == root:root:700 ]] || fail
}

read_manager_update_state() {
  local -a lines=()
  assert_manager_update_directory
  assert_root_file "$manager_update_state" 600
  mapfile -t lines <"$manager_update_state"
  [[ "${#lines[@]}" -eq 3 ]] || fail
  [[ "${lines[0]}" == schema=1 ]] || fail
  [[ "${lines[1]}" =~ ^previous_sha256=([0-9a-f]{64})$ ]] || fail
  local previous_sha="${BASH_REMATCH[1]}"
  [[ "${lines[2]}" =~ ^replacement_sha256=([0-9a-f]{64})$ ]] || fail
  local replacement_sha="${BASH_REMATCH[1]}"
  printf '%s\n%s\n' "$previous_sha" "$replacement_sha"
}

verify_release_manager_bytes() {
  local path="$1"
  local expected_sha="$2"
  assert_sha256 "$expected_sha"
  [[ -f "$path" && ! -L "$path" ]] || fail
  [[ "$(file_sha256 "$path")" == "$expected_sha" ]] || fail
  bash -n "$path"
  [[ "$(env -i \
    HOME=/root \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    "$path" version)" == "$release_manager_protocol" ]] || fail
}

prepare_manager_update_transaction() {
  local replacement="$1"
  local replacement_sha="$2"
  local previous_sha
  ensure_transaction_base
  [[ ! -e "$manager_update_directory" && ! -L "$manager_update_directory" ]] || fail
  [[ ! -e "$manager_update_discarding" && ! -L "$manager_update_discarding" ]] || fail
  assert_release_manager
  previous_sha="$(file_sha256 "$release_manager_path")" || fail
  verify_release_manager_bytes "$release_manager_path" "$previous_sha"
  verify_release_manager_bytes "$replacement" "$replacement_sha"
  manager_update_preparing="$(mktemp -d "$transaction_base/.manager-update.XXXXXXXX")"
  [[ -d "$manager_update_preparing" && ! -L "$manager_update_preparing" ]] || fail
  [[ "$(stat -c '%U:%G:%a' -- "$manager_update_preparing")" == root:root:700 ]] || fail
  install -o root -g root -m 0600 -- \
    "$release_manager_path" "$manager_update_preparing/previous"
  install -o root -g root -m 0600 -- "$replacement" "$manager_update_preparing/replacement"
  verify_release_manager_bytes "$manager_update_preparing/previous" "$previous_sha"
  verify_release_manager_bytes "$manager_update_preparing/replacement" "$replacement_sha"
  printf '%s\n' \
    schema=1 \
    "previous_sha256=$previous_sha" \
    "replacement_sha256=$replacement_sha" \
    >"$manager_update_preparing/state"
  chmod 0600 "$manager_update_preparing/state"
  sync -- \
    "$manager_update_preparing/previous" \
    "$manager_update_preparing/replacement" \
    "$manager_update_preparing/state" \
    "$manager_update_preparing"
  mv --no-target-directory -- "$manager_update_preparing" "$manager_update_directory"
  manager_update_preparing=
  sync -- "$transaction_base"
  manager_update_active=1
  assert_manager_update_directory
}

cleanup_manager_update_transaction() {
  assert_manager_update_directory
  [[ ! -e "$manager_update_discarding" && ! -L "$manager_update_discarding" ]] || fail
  mv --no-target-directory -- "$manager_update_directory" "$manager_update_discarding"
  sync -- "$transaction_base"
  [[ -d "$manager_update_discarding" && ! -L "$manager_update_discarding" ]] || fail
  [[ "$(readlink --canonicalize-existing -- "$manager_update_discarding")" \
    == "$manager_update_discarding" ]] || fail
  [[ "$(stat -c '%U:%G:%a' -- "$manager_update_discarding")" == root:root:700 ]] || fail
  remove_root_private_tree "$manager_update_discarding" "$transaction_base" || fail
  manager_update_active=0
}

recover_manager_update_transaction() {
  ensure_transaction_base
  local -a orphaned_preparations=()
  local orphaned
  local inventory="$temporary_root/manager-update-preparations"
  [[ ! -e "$inventory" && ! -L "$inventory" ]] || fail
  find "$transaction_base" -mindepth 1 -maxdepth 1 \
    -name '.manager-update.*' -print0 >"$inventory" || fail
  chmod 0600 "$inventory"
  mapfile -d '' -t orphaned_preparations <"$inventory" || fail
  rm -f -- "$inventory" || fail
  for orphaned in "${orphaned_preparations[@]}"; do
    [[ "$orphaned" == "$transaction_base/.manager-update."* ]] || fail
    [[ -d "$orphaned" && ! -L "$orphaned" ]] || fail
    [[ "$(stat -c '%U:%G:%a' -- "$orphaned")" == root:root:700 ]] || fail
    remove_root_private_tree "$orphaned" "$transaction_base" || fail
  done
  if [[ -e "$manager_update_discarding" || -L "$manager_update_discarding" ]]; then
    [[ -d "$manager_update_discarding" && ! -L "$manager_update_discarding" ]] || fail
    [[ "$(readlink --canonicalize-existing -- "$manager_update_discarding")" \
      == "$manager_update_discarding" ]] || fail
    [[ "$(stat -c '%U:%G:%a' -- "$manager_update_discarding")" == root:root:700 ]] || fail
    remove_root_private_tree "$manager_update_discarding" "$transaction_base" || fail
  fi
  if [[ ! -e "$manager_update_directory" && ! -L "$manager_update_directory" ]]; then
    manager_update_active=0
    return 0
  fi
  manager_update_active=1
  local state_payload
  local -a hashes=()
  state_payload="$(read_manager_update_state)" || fail
  mapfile -t hashes <<<"$state_payload" || fail
  [[ "${#hashes[@]}" -eq 2 ]] || fail
  verify_release_manager_bytes "$manager_update_directory/previous" "${hashes[0]}"
  verify_release_manager_bytes "$manager_update_directory/replacement" "${hashes[1]}"
  atomic_install "$manager_update_directory/previous" "$release_manager_path" root root 750
  verify_release_manager_bytes "$release_manager_path" "${hashes[0]}"
  cleanup_manager_update_transaction
}

update_release_manager() {
  local source="$1"
  local expected_sha="$2"
  local frozen="$temporary_root/production-release-manager.sh"
  assert_sha256 "$expected_sha"
  assert_install_source "$source" "$expected_sha"
  acquire_deploy_lock
  exec 7>/run/lock/setlivre-release-manager.lock
  flock -w 30 7 || fail
  recover_manager_update_transaction
  recover_installation_transaction
  freeze_install_source "$source" "$expected_sha" "$frozen"
  verify_release_manager_bytes "$frozen" "$expected_sha"
  prepare_manager_update_transaction "$frozen" "$expected_sha"
  atomic_install "$manager_update_directory/replacement" "$release_manager_path" root root 750
  verify_release_manager_bytes "$release_manager_path" "$expected_sha"
  cleanup_manager_update_transaction
  assert_release_manager
}

assert_no_actions_runner() {
  local listing="$temporary_root/actions-runner-units"
  ! getent passwd setlivre-runner >/dev/null || fail
  [[ ! -e /opt/setlivre-runner && ! -L /opt/setlivre-runner ]] || fail
  [[ ! -e /etc/setlivre-runner && ! -L /etc/setlivre-runner ]] || fail
  [[ ! -e /etc/sudoers.d/setlivre-runner && ! -L /etc/sudoers.d/setlivre-runner ]] || fail
  systemctl list-unit-files 'actions.runner.*' --no-legend --no-pager >"$listing" 2>/dev/null \
    || fail
  chmod 0600 "$listing"
  [[ ! -s "$listing" ]] || fail
}

assert_release_manager() {
  assert_root_file "$release_manager_path" 750
  [[ "$($release_manager_path version)" == "$release_manager_protocol" ]] || fail
}

assert_identity() {
  local passwd_entry
  local group_entry
  local deployer_uid
  local deployer_gid
  local group_snapshot="$temporary_root/identity.group"
  local passwd_snapshot="$temporary_root/identity.passwd"
  passwd_entry="$(getent passwd "$deployer_user")" || fail
  getent group "$deployer_group" >"$group_snapshot" || fail
  getent passwd >"$passwd_snapshot" || fail
  chmod 0600 "$group_snapshot" "$passwd_snapshot"
  group_entry="$(<"$group_snapshot")"
  [[ "$(cut -d: -f1 <<<"$passwd_entry")" == "$deployer_user" ]] || fail
  [[ "$(cut -d: -f6 <<<"$passwd_entry")" == "$deployer_home" ]] || fail
  [[ "$(cut -d: -f7 <<<"$passwd_entry")" == /usr/sbin/nologin ]] || fail
  deployer_uid="$(cut -d: -f3 <<<"$passwd_entry")"
  deployer_gid="$(cut -d: -f3 <<<"$group_entry")"
  [[ "$deployer_uid" =~ ^[1-9][0-9]{0,2}$ ]] || fail
  [[ "$deployer_gid" =~ ^[1-9][0-9]{0,2}$ ]] || fail
  [[ "$(cut -d: -f4 <<<"$passwd_entry")" == "$deployer_gid" ]] || fail
  [[ "$(id -u "$deployer_user")" == "$deployer_uid" ]] || fail
  [[ "$(id -g "$deployer_user")" == "$deployer_gid" ]] || fail
  [[ "$(id -Gn "$deployer_user")" == "$deployer_group" ]] || fail
  [[ "$(passwd --status "$deployer_user" | awk '{print $2}')" == L ]] || fail
  node - "$group_snapshot" "$passwd_snapshot" "$deployer_group" "$deployer_user" <<'EXCLUSIVE_GROUP_NODE'
const fs = require("node:fs");

const [groupPath, passwdPath, expectedGroup, expectedUser] = process.argv.slice(2);
const groupLines = fs.readFileSync(groupPath, "utf8").trimEnd().split("\n");
if (groupLines.length !== 1) {
  process.exit(1);
}
const groupFields = groupLines[0].split(":");
if (
  groupFields.length !== 4 ||
  groupFields[0] !== expectedGroup ||
  !/^[1-9]\d{0,2}$/.test(groupFields[2])
) {
  process.exit(1);
}

const effectiveMembers = new Set();
const supplementaryMembers = groupFields[3] === "" ? [] : groupFields[3].split(",");
if (
  supplementaryMembers.some((member) => member === "") ||
  new Set(supplementaryMembers).size !== supplementaryMembers.length
) {
  process.exit(1);
}
for (const member of supplementaryMembers) {
  effectiveMembers.add(member);
}

const passwdLines = fs.readFileSync(passwdPath, "utf8").trimEnd().split("\n");
let targetEntries = 0;
for (const line of passwdLines) {
  const fields = line.split(":");
  if (fields.length !== 7 || !/^\d+$/.test(fields[2]) || !/^\d+$/.test(fields[3])) {
    process.exit(1);
  }
  if (fields[0] === expectedUser) {
    targetEntries += 1;
    if (
      !/^[1-9]\d{0,2}$/.test(fields[2]) ||
      fields[3] !== groupFields[2]
    ) {
      process.exit(1);
    }
  }
  if (fields[3] === groupFields[2]) {
    effectiveMembers.add(fields[0]);
  }
}
if (targetEntries !== 1 || effectiveMembers.size !== 1 || !effectiveMembers.has(expectedUser)) {
  process.exit(1);
}
EXCLUSIVE_GROUP_NODE
}

systemd_property() {
  local unit_name="$1"
  local property_name="$2"
  local value
  [[ "$property_name" =~ ^[A-Za-z][A-Za-z0-9]*$ ]] || return 1
  value="$(systemctl show --property="$property_name" --value "$unit_name" 2>/dev/null)" \
    || return 1
  [[ -n "$value" && "$value" != *$'\n'* && "$value" != *$'\r'* ]] || return 1
  printf '%s\n' "$value"
}

systemd_property_allow_empty() {
  local unit_name="$1"
  local property_name="$2"
  local value
  [[ "$property_name" =~ ^[A-Za-z][A-Za-z0-9]*$ ]] || return 1
  value="$(systemctl show --property="$property_name" --value "$unit_name" 2>/dev/null)" \
    || return 1
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || return 1
  printf '%s\n' "$value"
}

assert_systemd_word_set() {
  local actual="$1"
  shift
  node - "$actual" "$@" <<'SYSTEMD_WORD_SET_NODE'
const [actual, ...expected] = process.argv.slice(2);
const words = actual
  .split(/\s+/u)
  .filter(Boolean)
  .map((word) => word.replace(/^"|"$/gu, ""));
if (
  new Set(words).size !== words.length ||
  new Set(expected).size !== expected.length ||
  words.length !== expected.length ||
  expected.some((word) => !words.includes(word))
) {
  process.exit(1);
}
SYSTEMD_WORD_SET_NODE
}

assert_effective_systemd_contract() {
  [[ "$(systemd_property "$service_name" FragmentPath)" == "$service_path" ]] || fail
  [[ "$(systemd_property "$timer_name" FragmentPath)" == "$timer_path" ]] || fail
  [[ -z "$(systemd_property_allow_empty "$service_name" DropInPaths)" ]] || fail
  [[ -z "$(systemd_property_allow_empty "$timer_name" DropInPaths)" ]] || fail
  [[ "$(systemd_property "$service_name" User)" == "$deployer_user" ]] || fail
  [[ "$(systemd_property "$service_name" Group)" == "$deployer_group" ]] || fail
  [[ "$(systemd_property "$service_name" ExecStart)" == *"path=$agent_path"* ]] || fail
  [[ "$(systemd_property "$service_name" EnvironmentFiles)" \
    == "$environment_path (ignore_errors=no)" ]] || fail
  [[ "$(systemd_property "$service_name" Environment)" \
    == "NODE_OPTIONS=--max-old-space-size=$deployer_node_old_space_mib" ]] || fail
  assert_systemd_word_set \
    "$(systemd_property "$service_name" LoadCredential)" \
    "database-url-app-dal:$database_url_credential" \
    "github-deploy-token:$github_token_credential" \
    "supabase-server-ca.pem:$supabase_server_ca_credential" \
    "supabase-access-token:$supabase_access_token_credential" \
    "supabase-db-password:$supabase_db_password_credential" || fail
  [[ "$(systemd_property "$service_name" UMask)" == 0077 ]] || fail
  [[ "$(systemd_property "$service_name" NoNewPrivileges)" == no ]] || fail
  [[ "$(systemd_property "$service_name" PrivateDevices)" == yes ]] || fail
  [[ "$(systemd_property "$service_name" PrivateTmp)" == yes ]] || fail
  [[ "$(systemd_property "$service_name" ProtectHome)" == yes ]] || fail
  [[ "$(systemd_property "$service_name" ProtectSystem)" == strict ]] || fail
  [[ "$(systemd_property "$service_name" ProtectProc)" == invisible ]] || fail
  [[ "$(systemd_property "$service_name" RestrictNamespaces)" == yes ]] || fail
  [[ "$(systemd_property "$service_name" RestrictRealtime)" == yes ]] || fail
  [[ "$(systemd_property "$service_name" TimeoutStartUSec)" == 1h ]] || fail
  assert_systemd_word_set \
    "$(systemd_property "$service_name" ReadWritePaths)" \
    "$private_base" /opt/setlivre /run/lock || fail
  assert_systemd_word_set \
    "$(systemd_property "$service_name" RestrictAddressFamilies)" \
    AF_INET AF_UNIX || fail
  [[ "$(systemd_property "$timer_name" Unit)" == "$service_name" ]] || fail
  [[ "$(systemd_property "$timer_name" Persistent)" == yes ]] || fail
  [[ "$(systemd_property "$timer_name" OnBootUSec)" == 2min ]] || fail
  [[ "$(systemd_property "$timer_name" OnUnitInactiveUSec)" == 2min ]] || fail
  [[ "$(systemd_property "$timer_name" RandomizedDelayUSec)" == 30s ]] || fail
  [[ "$(systemd_property "$timer_name" AccuracyUSec)" == 10s ]] || fail
}

assert_effective_application_service_contract() {
  local unit_name="$1"
  local unit_path="$2"
  local runtime_credential="$3"
  local working_directory="$4"
  local entrypoint="$5"
  local node_old_space_mib="$6"
  local exec_start
  local effective_runtime_credential="/run/credentials/$unit_name/runtime.env"

  [[ "$(systemd_property "$unit_name" FragmentPath)" == "$unit_path" ]] || fail
  [[ -z "$(systemd_property_allow_empty "$unit_name" DropInPaths)" ]] || fail
  [[ "$(systemd_property "$unit_name" User)" == "$runtime_user" ]] || fail
  [[ "$(systemd_property "$unit_name" Group)" == "$runtime_group" ]] || fail
  [[ "$(systemd_property "$unit_name" WorkingDirectory)" == "$working_directory" ]] || fail
  [[ -z "$(systemd_property_allow_empty "$unit_name" EnvironmentFiles)" ]] || fail
  [[ "$(systemd_property "$unit_name" Environment)" \
    == "NODE_OPTIONS=--max-old-space-size=$node_old_space_mib" ]] || fail
  assert_systemd_word_set \
    "$(systemd_property "$unit_name" UnsetEnvironment)" \
    APP_ENV APP_RELEASE_SHA DATABASE_TLS_CA_PATH DATABASE_TLS_CA_SHA256 \
    DATABASE_URL_APP_DAL HOSTNAME NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY NEXT_PUBLIC_SUPABASE_URL NEXT_TELEMETRY_DISABLED \
    NODE_ENV PORT || fail
  assert_systemd_word_set \
    "$(systemd_property "$unit_name" LoadCredential)" \
    "runtime.env:$runtime_credential" \
    "supabase-server-ca.pem:$supabase_server_ca_credential" || fail
  exec_start="$(systemd_property "$unit_name" ExecStart)" || fail
  [[ "$exec_start" == *"path=$node_path"* ]] || fail
  [[ "$exec_start" == *"--env-file=$effective_runtime_credential"* ]] || fail
  [[ "$exec_start" == *"$entrypoint"* ]] || fail
  [[ "$exec_start" != *"--env-file-if-exists"* ]] || fail
  [[ "$(systemd_property "$unit_name" UMask)" == 0027 ]] || fail
  [[ "$(systemd_property "$unit_name" NoNewPrivileges)" == yes ]] || fail
  [[ "$(systemd_property "$unit_name" PrivateDevices)" == yes ]] || fail
  [[ "$(systemd_property "$unit_name" PrivateTmp)" == yes ]] || fail
  [[ "$(systemd_property "$unit_name" ProtectHome)" == yes ]] || fail
  [[ "$(systemd_property "$unit_name" ProtectSystem)" == strict ]] || fail
  [[ "$(systemd_property "$unit_name" RestrictNamespaces)" == yes ]] || fail
  [[ "$(systemd_property "$unit_name" RestrictRealtime)" == yes ]] || fail
  [[ "$(systemd_property "$unit_name" RestrictSUIDSGID)" == yes ]] || fail
  [[ "$(systemd_property "$unit_name" LockPersonality)" == yes ]] || fail
  assert_systemd_word_set \
    "$(systemd_property "$unit_name" RestrictAddressFamilies)" \
    AF_INET AF_UNIX || fail
}

assert_effective_application_services_contract() {
  assert_effective_application_service_contract \
    "$web_service_name" "$web_service_path" "$web_runtime_credential" \
    "$web_working_directory" "$web_entrypoint" "$web_node_old_space_mib"
  assert_effective_application_service_contract \
    "$backoffice_service_name" "$backoffice_service_path" \
    "$backoffice_runtime_credential" "$backoffice_working_directory" \
    "$backoffice_entrypoint" "$backoffice_node_old_space_mib"
}

systemd_load_state() {
  local load_state
  load_state="$(systemd_property "$1" LoadState)" || return 1
  [[ "$load_state" == loaded || "$load_state" == not-found ]] || return 1
  printf '%s\n' "$load_state"
}

systemd_enabled_state() {
  local state
  [[ "$(systemd_load_state "$1")" == loaded ]] || return 1
  state="$(systemd_property "$1" UnitFileState)" || return 1
  [[ "$state" == enabled || "$state" == disabled ]] || return 1
  printf '%s\n' "$state"
}

systemd_active_state() {
  local state
  [[ "$(systemd_load_state "$1")" == loaded ]] || return 1
  state="$(systemd_property "$1" ActiveState)" || return 1
  [[ "$state" == active || "$state" == inactive || "$state" == failed ]] || return 1
  printf '%s\n' "$state"
}

capture_timer_state() {
  local load_state
  load_state="$(systemd_load_state "$timer_name")"
  case "$load_state" in
    loaded)
      timer_previous_present=1
      timer_previous_enabled="$(systemd_enabled_state "$timer_name")" || fail
      timer_previous_active="$(systemd_active_state "$timer_name")" || fail
      [[ "$timer_previous_enabled" == enabled || "$timer_previous_enabled" == disabled ]] || fail
      [[ "$timer_previous_active" == active || "$timer_previous_active" == inactive ]] || fail
      ;;
    not-found)
      [[ ! -e "$timer_path" && ! -L "$timer_path" ]] || fail
      timer_previous_present=0
      timer_previous_enabled=disabled
      timer_previous_active=inactive
      ;;
    *)
      fail
      ;;
  esac
}

quiesce_deployer() {
  local timer_load_state
  local service_load_state
  timer_load_state="$(systemd_load_state "$timer_name")"
  service_load_state="$(systemd_load_state "$service_name")"

  case "$timer_load_state" in
    loaded)
      systemctl disable --now "$timer_name" >/dev/null
      [[ "$(systemd_enabled_state "$timer_name")" == disabled ]] || fail
      [[ "$(systemd_active_state "$timer_name")" == inactive ]] || fail
      ;;
    not-found) ;;
    *) fail ;;
  esac

  case "$service_load_state" in
    loaded)
      systemctl stop "$service_name"
      systemctl reset-failed "$service_name" >/dev/null 2>&1
      [[ "$(systemd_active_state "$service_name")" == inactive ]] || fail
      ;;
    not-found) ;;
    *) fail ;;
  esac
}

assert_deploy_lock() {
  assert_owned_file "$deploy_lock_path" "$deployer_user" "$deployer_group" 600
}

acquire_deploy_lock() {
  if [[ ! -e "$deploy_lock_path" && ! -L "$deploy_lock_path" ]]; then
    install -o "$deployer_user" -g "$deployer_group" -m 0600 -- /dev/null "$deploy_lock_path"
  fi
  assert_deploy_lock
  exec 8>>"$deploy_lock_path"
  flock -w 300 8 || fail
  [[ "$(stat -Lc '%d:%i' -- /proc/self/fd/8)" == \
    "$(stat -Lc '%d:%i' -- "$deploy_lock_path")" ]] || fail
  assert_deploy_lock
}

restore_timer_state() {
  [[ "$timer_previous_present" == 0 || "$timer_previous_present" == 1 ]] || fail
  [[ "$timer_previous_enabled" == enabled || "$timer_previous_enabled" == disabled ]] || fail
  [[ "$timer_previous_active" == active || "$timer_previous_active" == inactive ]] || fail

  if [[ "$timer_previous_enabled" == enabled ]]; then
    systemctl enable "$timer_name" >/dev/null
  else
    systemctl disable "$timer_name" >/dev/null
  fi
  if [[ "$timer_previous_active" == active ]]; then
    systemctl start "$timer_name"
  else
    systemctl stop "$timer_name"
  fi

  [[ "$(systemd_enabled_state "$timer_name")" == \
    "$timer_previous_enabled" ]] || fail
  [[ "$(systemd_active_state "$timer_name")" == \
    "$timer_previous_active" ]] || fail
}

assert_sudo_policy_exact() {
  local listing="$temporary_root/sudo-listing"
  local sudo_listing
  sudo_listing="$(sudo -ll -U "$deployer_user" 2>/dev/null)" || fail
  printf '%s\n' "$sudo_listing" >"$listing"
  unset sudo_listing
  chmod 0600 "$listing"
  node - "$listing" "$dispatcher_path" "$sudoers_path" <<'SUDO_LISTING_NODE'
const fs = require("node:fs");

const [listingPath, expectedCommand, expectedPolicy] = process.argv.slice(2);
const listing = fs.readFileSync(listingPath, "utf8").replace(/\r\n/g, "\n");
const entryMarker = /^Sudoers entry:(?: (\S+))?[ \t]*$/gm;
const markers = [...listing.matchAll(entryMarker)];
if (markers.length !== 1 || (markers[0][1] !== undefined && markers[0][1] !== expectedPolicy)) {
  process.exit(1);
}
const entry = listing.slice(markers[0].index + markers[0][0].length);
const runAsUsers = /^[ \t]*RunAsUsers:[ \t]*(.+?)[ \t]*$/m.exec(entry);
const options = /^[ \t]*Options:[ \t]*(.+?)[ \t]*$/m.exec(entry);
const commands = /^[ \t]*Commands:[ \t]*\n((?:[ \t]{4,}.*(?:\n|$))*)/m.exec(entry);
if (
  runAsUsers?.[1] !== "root" ||
  options === null ||
  commands === null ||
  /^[ \t]*RunAsGroups:/m.test(entry)
) {
  process.exit(1);
}
const optionSet = new Set(options[1].split(",").map((option) => option.trim()));
if (optionSet.size !== 1 || !optionSet.has("!authenticate")) {
  process.exit(1);
}
const commandList = commands[1]
  .split("\n")
  .map((command) => command.trim())
  .filter(Boolean);
if (commandList.length !== 1 || commandList[0] !== expectedCommand) {
  process.exit(1);
}
SUDO_LISTING_NODE
}

assert_environment_file_shape() {
  local path="$1"
  python3 - "$path" <<'ENVIRONMENT_SHAPE_PY'
import re
import sys

path = sys.argv[1]
expected = {
    "GITHUB_REPOSITORY_ID",
    "CI_GITHUB_WORKFLOW_ID",
    "PRD_GITHUB_WORKFLOW_ID",
    "PRD_PUBLIC_APP_URL",
    "PRD_BACKOFFICE_APP_URL",
    "PRD_SUPABASE_PROJECT_REF",
    "PRD_SUPABASE_URL",
    "PRD_SUPABASE_ANON_KEY",
    "PRD_DEPLOY_ENABLED",
    "SUPABASE_SERVER_CA_SHA256",
}
seen = set()
values = {}
with open(path, "r", encoding="utf-8") as source:
    for raw in source.read().splitlines():
        if not raw or raw.startswith("#"):
            continue
        match = re.fullmatch(r"([A-Z][A-Z0-9_]*)=(.*)", raw)
        if match is None or match.group(1) in seen:
            raise SystemExit(1)
        seen.add(match.group(1))
        values[match.group(1)] = match.group(2)
if seen != expected:
    raise SystemExit(1)
repository_id = values["GITHUB_REPOSITORY_ID"]
ci_workflow_id = values["CI_GITHUB_WORKFLOW_ID"]
prd_workflow_id = values["PRD_GITHUB_WORKFLOW_ID"]
enabled = values["PRD_DEPLOY_ENABLED"]
supabase_project_ref = values["PRD_SUPABASE_PROJECT_REF"]
supabase_url = values["PRD_SUPABASE_URL"]
supabase_server_ca_sha256 = values["SUPABASE_SERVER_CA_SHA256"]
positive_integer = re.compile(r"[1-9][0-9]*")
identifiers = (repository_id, ci_workflow_id, prd_workflow_id)
if enabled not in {"false", "true"}:
    raise SystemExit(1)
if enabled == "true" and not all(positive_integer.fullmatch(value) for value in identifiers):
    raise SystemExit(1)
if enabled == "false" and any(identifiers) and not all(
    positive_integer.fullmatch(value) for value in identifiers
):
    raise SystemExit(1)
if repository_id and repository_id != "1328339374":
    raise SystemExit(1)
if ci_workflow_id and ci_workflow_id == prd_workflow_id:
    raise SystemExit(1)
supabase_configured = bool(supabase_project_ref or supabase_url)
if enabled == "true" and not supabase_configured:
    raise SystemExit(1)
if supabase_configured and (
    re.fullmatch(r"[a-z0-9]{20}", supabase_project_ref) is None
    or supabase_url != f"https://{supabase_project_ref}.supabase.co"
):
    raise SystemExit(1)
if enabled == "true" and re.fullmatch(r"[0-9a-f]{64}", supabase_server_ca_sha256) is None:
    raise SystemExit(1)
if supabase_server_ca_sha256 and re.fullmatch(r"[0-9a-f]{64}", supabase_server_ca_sha256) is None:
    raise SystemExit(1)
ENVIRONMENT_SHAPE_PY
}

assert_environment_shape() {
  assert_environment_file_shape "$environment_path"
}

assert_credential_sources() {
  assert_directory "$credentials_directory" root root 700
  local inventory
  inventory="$(find "$credentials_directory" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)" || fail
  [[ "$inventory" == $'database-url-app-dal\ngithub-deploy-token\nsupabase-access-token\nsupabase-db-password\nsupabase-server-ca.pem' ]] \
    || fail
  local credential
  for credential in \
    "$github_token_credential" \
    "$supabase_access_token_credential" \
    "$supabase_db_password_credential" \
    "$database_url_credential" \
    "$supabase_server_ca_credential"; do
    assert_root_file "$credential" 600
  done
  python3 - \
    "$environment_path" \
    "$github_token_credential" \
    "$supabase_access_token_credential" \
    "$supabase_db_password_credential" \
    "$database_url_credential" \
    "$supabase_server_ca_credential" <<'CREDENTIAL_SOURCES_PY'
import hashlib
import re
import sys

environment_path, *paths = sys.argv[1:]
values = {}
with open(environment_path, "r", encoding="utf-8") as source:
    for raw in source.read().splitlines():
        if raw and not raw.startswith("#"):
            key, value = raw.split("=", 1)
            values[key] = value

enabled = values.get("PRD_DEPLOY_ENABLED") == "true"
ca_digest = values.get("SUPABASE_SERVER_CA_SHA256", "")
payloads = [open(path, "rb").read() for path in paths]
for payload in payloads:
    if len(payload) > 1024 * 1024 or any(marker in payload for marker in (b"\0", b"\r")):
        raise SystemExit(1)
for payload in payloads[:4]:
    if b"\n" in payload or len(payload) > 8192 or (enabled and not payload):
        raise SystemExit(1)
    try:
        payload.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        raise SystemExit(1)
ca = payloads[4]
if enabled and not ca:
    raise SystemExit(1)
if ca_digest:
    if re.fullmatch(r"[0-9a-f]{64}", ca_digest) is None:
        raise SystemExit(1)
    if hashlib.sha256(ca).hexdigest() != ca_digest:
        raise SystemExit(1)
elif ca:
    raise SystemExit(1)
if ca:
    try:
        text = ca.decode("ascii", errors="strict")
    except UnicodeDecodeError:
        raise SystemExit(1)
    if "PRIVATE KEY" in text or not text.endswith("\n"):
        raise SystemExit(1)
    labels = re.findall(r"^-----BEGIN ([A-Z0-9 ]+)-----$", text, flags=re.MULTILINE)
    end_labels = re.findall(r"^-----END ([A-Z0-9 ]+)-----$", text, flags=re.MULTILINE)
    if not labels or labels != end_labels or any(label != "CERTIFICATE" for label in labels):
        raise SystemExit(1)
CREDENTIAL_SOURCES_PY
  if [[ -s "$supabase_server_ca_credential" ]]; then
    openssl crl2pkcs7 -nocrl -certfile "$supabase_server_ca_credential" \
      | openssl pkcs7 -print_certs -noout >/dev/null || fail
  fi
}

assert_systemd_credential_round_trip() {
  local expected="$temporary_root/credential-round-trip.expected"
  local actual="$temporary_root/credential-round-trip.actual"
  local unit="setlivre-credential-round-trip-${BASHPID}"
  local credential
  local credential_name
  : >"$expected"
  for credential in \
    "$database_url_credential" \
    "$github_token_credential" \
    "$supabase_access_token_credential" \
    "$supabase_db_password_credential" \
    "$supabase_server_ca_credential"; do
    credential_name="${credential##*/}"
    printf '%s %s %s\n' \
      "$credential_name" "$(file_sha256 "$credential")" "$(stat -c '%s' -- "$credential")" \
      >>"$expected"
  done
  env -i PATH="$PATH" LANG="$LANG" LC_ALL="$LC_ALL" systemd-run \
    --quiet \
    --pipe \
    --wait \
    --collect \
    --unit="$unit" \
    --service-type=oneshot \
    --property="User=$deployer_user" \
    --property="Group=$deployer_group" \
    --property=NoNewPrivileges=yes \
    --property=PrivateDevices=yes \
    --property=PrivateTmp=yes \
    --property=ProtectHome=yes \
    --property=ProtectSystem=strict \
    --property=RestrictAddressFamilies=AF_UNIX \
    --property="LoadCredential=database-url-app-dal:$database_url_credential" \
    --property="LoadCredential=github-deploy-token:$github_token_credential" \
    --property="LoadCredential=supabase-access-token:$supabase_access_token_credential" \
    --property="LoadCredential=supabase-db-password:$supabase_db_password_credential" \
    --property="LoadCredential=supabase-server-ca.pem:$supabase_server_ca_credential" \
    /usr/bin/python3 -c \
      'import hashlib, os; root=os.environ["CREDENTIALS_DIRECTORY"]; rows=[]; [(rows.append((name, hashlib.sha256(open(os.path.join(root, name), "rb").read()).hexdigest(), os.path.getsize(os.path.join(root, name))))) for name in sorted(os.listdir(root))]; print("\n".join(f"{name} {digest} {size}" for name, digest, size in rows))' \
    >"$actual" || fail
  chmod 0600 "$expected" "$actual"
  cmp --silent -- "$expected" "$actual" || fail
}

install_dispatcher() {
  local candidate="$temporary_root/setlivre-deploy-dispatch"
  cat >"$candidate" <<'DISPATCHER'
#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

readonly release_manager=/usr/local/sbin/setlivre-release-manager
cd /

reject() {
  printf '%s\n' "Set Livre deployment dispatcher rejected the operation." >&2
  exit 1
}

assert_sha() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] || reject
}

assert_checksum() {
  [[ "$1" =~ ^[0-9a-f]{64}$ ]] || reject
}

assert_positive_integer() {
  local value="$1"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || reject
  [[ "${#value}" -le 19 ]] || reject
  if [[ "${#value}" -eq 19 ]]; then
    case "$value" in
      [1-8]*) ;;
      9*) ((10#${value:1} <= 223372036854775807)) || reject ;;
      *) reject ;;
    esac
  fi
}

[[ "$EUID" -eq 0 ]] || reject
[[ -f "$release_manager" && ! -L "$release_manager" ]] || reject
[[ "$(readlink --canonicalize-existing -- "$release_manager")" == "$release_manager" ]] || reject
[[ "$(stat -c '%U:%G:%a:%h' -- "$release_manager")" == root:root:750:1 ]] || reject

case "${1:-}" in
  version | current | checkpoint)
    [[ "$#" -eq 1 ]] || reject
    ;;
  preflight | activate)
    [[ "$#" -eq 10 ]] || reject
    assert_sha "$2"
    assert_checksum "$3"
    assert_checksum "$4"
    [[ "$5" =~ ^[0-9]{14}$ ]] || reject
    assert_positive_integer "$6"
    assert_positive_integer "$7"
    assert_positive_integer "$8"
    assert_positive_integer "$9"
    assert_checksum "${10}"
    ;;
  confirm | rollback | discard-preflight | activation-result)
    [[ "$#" -eq 2 ]] || reject
    assert_sha "$2"
    ;;
  *)
    reject
    ;;
esac

exec /usr/bin/env -i \
  HOME=/root \
  LANG=C.UTF-8 \
  LC_ALL=C.UTF-8 \
  LOGNAME=root \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  USER=root \
  "$release_manager" "$@"
DISPATCHER
  bash -n "$candidate"
  atomic_install "$candidate" "$dispatcher_path" root root 750
}

install_sudo_policy() {
  local candidate="$temporary_root/setlivre-deployer.sudoers"
  cat >"$candidate" <<SUDOERS
Defaults:${deployer_user} env_reset
Defaults:${deployer_user} !setenv
Defaults:${deployer_user} secure_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
${deployer_user} ALL=(root) NOPASSWD: ${dispatcher_path}
SUDOERS
  chmod 0440 "$candidate"
  visudo --check --file="$candidate" >/dev/null
  atomic_install "$candidate" "$sudoers_path" root root 440
  visudo --check >/dev/null
}

install_environment_template() {
  if [[ ! -e "$environment_path" && ! -L "$environment_path" ]]; then
    local candidate="$temporary_root/production.env"
    cat >"$candidate" <<'ENVIRONMENT'
# Configure the three delivery IDs atomically before enabling deployment.
GITHUB_REPOSITORY_ID=
CI_GITHUB_WORKFLOW_ID=
PRD_GITHUB_WORKFLOW_ID=
PRD_PUBLIC_APP_URL=https://setlivre.com
PRD_BACKOFFICE_APP_URL=https://ops.setlivre.com
PRD_SUPABASE_PROJECT_REF=
PRD_SUPABASE_URL=
PRD_SUPABASE_ANON_KEY=
SUPABASE_SERVER_CA_SHA256=
PRD_DEPLOY_ENABLED=false
ENVIRONMENT
    atomic_install "$candidate" "$environment_path" root "$deployer_group" 640
  fi
}

write_environment_identity_candidate() {
  local source="$1"
  local destination="$2"
  shift 2
  node - "$source" "$destination" "$@" <<'ENVIRONMENT_IDENTITY_NODE'
const fs = require("node:fs");

const [sourcePath, destinationPath, mode, ...parameters] = process.argv.slice(2);
const expectedRepositoryId = "1328339374";
const positiveInteger = /^[1-9][0-9]*$/;
const projectRefPattern = /^[a-z0-9]{20}$/;
const orderedKeys = [
  "GITHUB_REPOSITORY_ID",
  "CI_GITHUB_WORKFLOW_ID",
  "PRD_GITHUB_WORKFLOW_ID",
  "PRD_PUBLIC_APP_URL",
  "PRD_BACKOFFICE_APP_URL",
  "PRD_SUPABASE_PROJECT_REF",
  "PRD_SUPABASE_URL",
  "PRD_SUPABASE_ANON_KEY",
  "SUPABASE_SERVER_CA_SHA256",
  "PRD_DEPLOY_ENABLED",
];

const source = fs.readFileSync(sourcePath, "utf8");
if (!source.endsWith("\n") || source.includes("\0") || source.includes("\r")) {
  process.exit(1);
}
const values = new Map();
for (const line of source.slice(0, -1).split("\n")) {
  if (line === "" || line.startsWith("#")) continue;
  const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
  if (match === null || values.has(match[1])) process.exit(1);
  values.set(match[1], match[2]);
}
if (
  values.size !== orderedKeys.length ||
  orderedKeys.some((key) => !values.has(key)) ||
  values.get("PRD_DEPLOY_ENABLED") !== "false"
) {
  process.exit(1);
}
const currentProjectRef = values.get("PRD_SUPABASE_PROJECT_REF");
const currentSupabaseUrl = values.get("PRD_SUPABASE_URL");
if (
  (currentProjectRef !== "" || currentSupabaseUrl !== "") &&
  (!projectRefPattern.test(currentProjectRef) ||
    currentSupabaseUrl !== `https://${currentProjectRef}.supabase.co`)
) {
  process.exit(1);
}
const currentIdentifiers = [
  values.get("GITHUB_REPOSITORY_ID"),
  values.get("CI_GITHUB_WORKFLOW_ID"),
  values.get("PRD_GITHUB_WORKFLOW_ID"),
];
if (
  currentIdentifiers.some(Boolean) &&
  !(
    currentIdentifiers[0] === expectedRepositoryId &&
    positiveInteger.test(currentIdentifiers[1]) &&
    positiveInteger.test(currentIdentifiers[2]) &&
    currentIdentifiers[1] !== currentIdentifiers[2]
  )
) {
  process.exit(1);
}

if (mode === "delivery") {
  const [repositoryId, ciWorkflowId, productionWorkflowId] = parameters;
  if (
    parameters.length !== 3 ||
    repositoryId !== expectedRepositoryId ||
    !positiveInteger.test(ciWorkflowId) ||
    !positiveInteger.test(productionWorkflowId) ||
    ciWorkflowId === productionWorkflowId
  ) {
    process.exit(1);
  }
  values.set("GITHUB_REPOSITORY_ID", repositoryId);
  values.set("CI_GITHUB_WORKFLOW_ID", ciWorkflowId);
  values.set("PRD_GITHUB_WORKFLOW_ID", productionWorkflowId);
} else if (mode === "supabase") {
  const [projectRef] = parameters;
  if (parameters.length !== 1 || !projectRefPattern.test(projectRef)) process.exit(1);
  values.set("PRD_SUPABASE_PROJECT_REF", projectRef);
  values.set("PRD_SUPABASE_URL", `https://${projectRef}.supabase.co`);
} else {
  process.exit(1);
}
const output = `${orderedKeys.map((key) => `${key}=${values.get(key)}`).join("\n")}\n`;
fs.writeFileSync(destinationPath, output, { encoding: "utf8", flag: "wx", mode: 0o600 });
ENVIRONMENT_IDENTITY_NODE
}

configure_environment_identity() {
  local mode="$1"
  shift
  local candidate="$temporary_root/production.env"
  acquire_deploy_lock
  exec 7>/run/lock/setlivre-release-manager.lock
  flock -w 30 7 || fail
  recover_manager_update_transaction
  assert_no_pending_installation_transaction
  verify_installation
  write_environment_identity_candidate "$environment_path" "$candidate" "$mode" "$@"
  assert_owned_file "$candidate" root root 600
  assert_environment_file_shape "$candidate"
  atomic_install "$candidate" "$environment_path" root "$deployer_group" 640
  assert_environment_shape
}

configure_delivery_identity() {
  local repository_id="$1"
  local ci_workflow_id="$2"
  local production_workflow_id="$3"
  [[ "$repository_id" == 1328339374 ]] || fail
  [[ "$ci_workflow_id" =~ ^[1-9][0-9]*$ ]] || fail
  [[ "$production_workflow_id" =~ ^[1-9][0-9]*$ ]] || fail
  [[ "$ci_workflow_id" != "$production_workflow_id" ]] || fail
  configure_environment_identity \
    delivery "$repository_id" "$ci_workflow_id" "$production_workflow_id"
}

configure_supabase_identity() {
  local project_ref="$1"
  [[ "$project_ref" =~ ^[a-z0-9]{20}$ ]] || fail
  configure_environment_identity supabase "$project_ref"
}

install_credential_templates() {
  install -d -o root -g root -m 0700 -- "$credentials_directory"
  local credential
  for credential in \
    "$github_token_credential" \
    "$supabase_access_token_credential" \
    "$supabase_db_password_credential" \
    "$database_url_credential" \
    "$supabase_server_ca_credential"; do
    if [[ ! -e "$credential" && ! -L "$credential" ]]; then
      local candidate="$temporary_root/${credential##*/}"
      [[ ! -e "$candidate" && ! -L "$candidate" ]] || fail
      : >"$candidate"
      atomic_install "$candidate" "$credential" root root 600
    fi
  done
}

install_systemd_units() {
  local service_candidate="$temporary_root/$service_name"
  local timer_candidate="$temporary_root/$timer_name"
  cat >"$service_candidate" <<UNIT
[Unit]
Description=Set Livre outbound production deploy poller
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=${deployer_user}
Group=${deployer_group}
EnvironmentFile=${environment_path}
LoadCredential=github-deploy-token:${github_token_credential}
LoadCredential=supabase-access-token:${supabase_access_token_credential}
LoadCredential=supabase-db-password:${supabase_db_password_credential}
LoadCredential=database-url-app-dal:${database_url_credential}
LoadCredential=supabase-server-ca.pem:${supabase_server_ca_credential}
Environment=NODE_OPTIONS=--max-old-space-size=${deployer_node_old_space_mib}
ExecStart=${agent_path}
WorkingDirectory=${deployer_home}
UMask=0077
NoNewPrivileges=false
MemoryAccounting=true
MemoryHigh=${deployer_memory_high_mib}M
MemoryMax=${deployer_memory_max_mib}M
MemorySwapMax=${deployer_memory_swap_max_mib}M
OOMPolicy=kill
PrivateDevices=true
PrivateTmp=true
ProtectClock=true
ProtectControlGroups=true
ProtectHome=true
ProtectHostname=true
ProtectKernelLogs=true
ProtectKernelModules=true
ProtectKernelTunables=true
ProtectProc=invisible
ProtectSystem=strict
ReadWritePaths=${private_base} /opt/setlivre /run/lock
RestrictAddressFamilies=AF_INET AF_UNIX
RestrictNamespaces=true
RestrictRealtime=true
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@clock @debug @module @mount @obsolete @raw-io @reboot @swap
TimeoutStartSec=60min

[Install]
WantedBy=multi-user.target
UNIT
  cat >"$timer_candidate" <<UNIT
[Unit]
Description=Poll verified Set Livre production artifacts

[Timer]
OnBootSec=2min
OnUnitInactiveSec=2min
RandomizedDelaySec=30s
AccuracySec=10s
Persistent=true
Unit=${service_name}

[Install]
WantedBy=timers.target
UNIT
  systemd-analyze verify "$service_candidate" "$timer_candidate" >/dev/null
  atomic_install "$service_candidate" "$service_path" root root 644
  atomic_install "$timer_candidate" "$timer_path" root root 644
  systemctl daemon-reload
  systemd-analyze verify "$service_path" "$timer_path" >/dev/null
}

write_installation_state() {
  local agent_sha="$1"
  local smoke_sha="$2"
  local candidate="$temporary_root/installation.state"
  local dispatcher_sha
  local sudoers_sha
  local service_sha
  local timer_sha
  assert_sha256 "$agent_sha"
  assert_sha256 "$smoke_sha"
  dispatcher_sha="$(file_sha256 "$dispatcher_path")" || fail
  sudoers_sha="$(file_sha256 "$sudoers_path")" || fail
  service_sha="$(file_sha256 "$service_path")" || fail
  timer_sha="$(file_sha256 "$timer_path")" || fail
  assert_sha256 "$dispatcher_sha"
  assert_sha256 "$sudoers_sha"
  assert_sha256 "$service_sha"
  assert_sha256 "$timer_sha"
  printf '%s\n' \
    "schema=$installation_schema" \
    "agent_sha256=$agent_sha" \
    "smoke_sha256=$smoke_sha" \
    "dispatcher_sha256=$dispatcher_sha" \
    "sudoers_sha256=$sudoers_sha" \
    "service_sha256=$service_sha" \
    "timer_sha256=$timer_sha" \
    "supabase_cli_path=$supabase_cli_path" \
    "supabase_cli_version=$supabase_cli_version" \
    "supabase_cli_sha256=$supabase_cli_sha256" \
    "supabase_go_path=$supabase_go_path" \
    "supabase_go_sha256=$supabase_go_sha256" \
    >"$candidate"
  atomic_install "$candidate" "$installation_state" root root 600
}

read_installation_state() {
  python3 - \
    "$installation_state" \
    "$installation_schema" \
    "$supabase_cli_path" \
    "$supabase_cli_version" \
    "$supabase_cli_sha256" \
    "$supabase_go_path" \
    "$supabase_go_sha256" <<'PY'
import re
import sys

(
    state_path,
    expected_schema,
    expected_cli_path,
    expected_cli_version,
    expected_cli_sha256,
    expected_go_path,
    expected_go_sha256,
) = sys.argv[1:]
values = {}
with open(state_path, "r", encoding="utf-8") as source:
    for line in source.read().splitlines():
        if "=" not in line:
            raise SystemExit(1)
        key, value = line.split("=", 1)
        if key in values:
            raise SystemExit(1)
        values[key] = value
ordered_hashes = (
    "agent_sha256",
    "smoke_sha256",
    "dispatcher_sha256",
    "sudoers_sha256",
    "service_sha256",
    "timer_sha256",
)
expected_values = {
    "schema": expected_schema,
    "supabase_cli_path": expected_cli_path,
    "supabase_cli_version": expected_cli_version,
    "supabase_cli_sha256": expected_cli_sha256,
    "supabase_go_path": expected_go_path,
    "supabase_go_sha256": expected_go_sha256,
}
if set(values) != {*expected_values, *ordered_hashes}:
    raise SystemExit(1)
if any(values[key] != expected for key, expected in expected_values.items()):
    raise SystemExit(1)
for key in ordered_hashes:
    if re.fullmatch(r"[0-9a-f]{64}", values[key]) is None:
        raise SystemExit(1)
for key in ordered_hashes:
    print(values[key])
PY
}

verify_installation() {
  require_no_pending_reboot
  assert_host_supabase_cli
  assert_no_actions_runner
  assert_release_manager
  assert_identity
  assert_directory "$deployer_home" "$deployer_user" "$deployer_group" 700
  assert_directory "$private_base" "$deployer_user" "$deployer_group" 700
  assert_directory "$incoming_base" "$deployer_user" "$deployer_group" 700
  assert_directory "$work_base" "$deployer_user" "$deployer_group" 700
  assert_directory "$state_base" "$deployer_user" "$deployer_group" 700
  assert_deploy_lock
  assert_directory "$configuration_directory" root "$deployer_group" 750
  assert_deployer_file "$agent_path" 750
  assert_deployer_file "$smoke_path" 640
  assert_deployer_file "$environment_path" 640
  assert_root_file "$dispatcher_path" 750
  assert_root_file "$sudoers_path" 440
  assert_root_file "$service_path" 644
  assert_root_file "$timer_path" 644
  assert_root_file "$web_service_path" 644
  assert_root_file "$backoffice_service_path" 644
  assert_root_file "$installation_state" 600
  local -a hashes=()
  local installation_state_payload
  installation_state_payload="$(read_installation_state)" || fail
  mapfile -t hashes <<<"$installation_state_payload" || fail
  [[ "${#hashes[@]}" -eq 6 ]] || fail
  [[ "$(file_sha256 "$agent_path")" == "${hashes[0]}" ]] || fail
  [[ "$(file_sha256 "$smoke_path")" == "${hashes[1]}" ]] || fail
  [[ "$(file_sha256 "$dispatcher_path")" == "${hashes[2]}" ]] || fail
  [[ "$(file_sha256 "$sudoers_path")" == "${hashes[3]}" ]] || fail
  [[ "$(file_sha256 "$service_path")" == "${hashes[4]}" ]] || fail
  [[ "$(file_sha256 "$timer_path")" == "${hashes[5]}" ]] || fail
  assert_environment_shape
  assert_credential_sources
  assert_systemd_credential_round_trip
  visudo --check >/dev/null
  assert_sudo_policy_exact
  [[ "$(systemd_load_state "$service_name")" == loaded ]] || fail
  [[ "$(systemd_load_state "$timer_name")" == loaded ]] || fail
  assert_managed_service_memory_contracts
  case "$(systemd_enabled_state "$timer_name")" in
    enabled | disabled) ;;
    *) fail ;;
  esac
  assert_effective_systemd_contract
  assert_effective_application_services_contract
  systemd-analyze verify \
    "$service_path" "$timer_path" "$web_service_path" "$backoffice_service_path" >/dev/null
  [[ "$($dispatcher_path version)" == "$release_manager_protocol" ]] || fail

  bash -n "$agent_path"
  node --check "$smoke_path" >/dev/null
}

install_deployer() {
  local agent_source="$1"
  local agent_sha="$2"
  local smoke_source="$3"
  local smoke_sha="$4"
  local frozen_agent="$temporary_root/production-deploy-agent.sh"
  local frozen_smoke="$temporary_root/production-smoke.mjs"
  [[ -z "${GITHUB_DEPLOY_TOKEN+x}" && -z "${GITHUB_REPOSITORY_ID+x}" \
    && -z "${CI_GITHUB_WORKFLOW_ID+x}" && -z "${PRD_GITHUB_WORKFLOW_ID+x}" \
    && -z "${SUPABASE_ACCESS_TOKEN+x}" \
    && -z "${SUPABASE_DB_PASSWORD+x}" && -z "${PRD_DATABASE_URL_APP_DAL+x}" \
    && -z "${SUPABASE_SERVER_CA_SHA256+x}" ]] || fail
  assert_sha256 "$agent_sha"
  assert_sha256 "$smoke_sha"
  assert_no_actions_runner
  ensure_transaction_base
  acquire_deploy_lock
  exec 7>/run/lock/setlivre-release-manager.lock
  flock -w 30 7 || fail
  recover_manager_update_transaction
  assert_release_manager

  if ! getent group "$deployer_group" >/dev/null; then
    groupadd --system "$deployer_group"
  fi
  if ! getent passwd "$deployer_user" >/dev/null; then
    useradd --system --gid "$deployer_group" --no-create-home --home-dir "$deployer_home" \
      --shell /usr/sbin/nologin --comment "Set Livre pull-based production deployer" \
      "$deployer_user"
  fi
  passwd --lock "$deployer_user" >/dev/null
  assert_identity

  install -d -o "$deployer_user" -g "$deployer_group" -m 0700 -- \
    "$deployer_home" "$private_base" "$incoming_base" "$work_base" "$state_base"
  install -d -o root -g "$deployer_group" -m 0750 -- \
    "$configuration_directory" /usr/local/libexec/setlivre

  recover_installation_transaction
  freeze_install_source "$agent_source" "$agent_sha" "$frozen_agent"
  freeze_install_source "$smoke_source" "$smoke_sha" "$frozen_smoke"
  bash -n "$frozen_agent"
  node --check "$frozen_smoke" >/dev/null
  capture_timer_state
  prepare_installation_transaction
  quiesce_deployer
  assert_frozen_source "$frozen_agent" "$agent_sha"
  assert_frozen_source "$frozen_smoke" "$smoke_sha"
  bash -n "$frozen_agent"
  node --check "$frozen_smoke" >/dev/null

  atomic_install "$frozen_agent" "$agent_path" root "$deployer_group" 750
  atomic_install "$frozen_smoke" "$smoke_path" root "$deployer_group" 640
  install_dispatcher
  install_sudo_policy
  install_environment_template
  install_credential_templates
  install_systemd_units
  write_installation_state "$agent_sha" "$smoke_sha"
  verify_installation
  restore_timer_state
  assert_restored_timer_state
  set_installation_transaction_phase committed
  cleanup_installation_transaction
}

main() {
  require_root
  require_host
  require_commands
  require_no_pending_reboot
  assert_host_supabase_cli
  assert_e2_micro_memory_budget
  exec 9>/run/lock/setlivre-production-deployer-config.lock
  flock -w 30 9 || fail
  temporary_root="$(mktemp -d /run/setlivre-deployer-install.XXXXXXXX)"
  [[ -d "$temporary_root" && ! -L "$temporary_root" ]] || fail
  [[ "$(stat -c '%U:%G:%a' -- "$temporary_root")" == root:root:700 ]] || fail
  trap cleanup EXIT
  trap 'exit 1' HUP INT TERM

  case "${1:-}" in
    install)
      [[ "$#" -eq 5 ]] || usage
      install_deployer "$2" "$3" "$4" "$5"
      ;;
    configure-delivery-identity)
      [[ "$#" -eq 4 ]] || usage
      configure_delivery_identity "$2" "$3" "$4"
      ;;
    configure-supabase-identity)
      [[ "$#" -eq 2 ]] || usage
      configure_supabase_identity "$2"
      ;;
    update-manager)
      [[ "$#" -eq 3 ]] || usage
      update_release_manager "$2" "$3"
      ;;
    verify)
      [[ "$#" -eq 1 ]] || usage
      acquire_deploy_lock
      exec 7>/run/lock/setlivre-release-manager.lock
      flock -w 30 7 || fail
      recover_manager_update_transaction
      assert_no_pending_installation_transaction
      verify_installation
      ;;
    *)
      usage
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
