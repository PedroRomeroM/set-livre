#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077
IFS=$' \t\n'
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
unset BASH_ENV CDPATH CURL_HOME ENV GLOBIGNORE GREP_OPTIONS PYTHONHOME PYTHONPATH TAR_OPTIONS

readonly repository=PedroRomeroM/set-livre
readonly ci_workflow=ci.yaml
readonly prd_workflow=prd-deploy.yaml
readonly branch=main
readonly expected_repository_id=1328339374
readonly expected_supabase_project_ref=oirvvnojgkzdppkdvhej
readonly expected_supabase_url="https://${expected_supabase_project_ref}.supabase.co"
readonly expected_supabase_version=2.115.0
readonly expected_authorization_catalog_sha256=8b395cb93111f5b626e39bbefd1dfc02d20d9de5e030832cb84168585c1777d6
readonly authorization_contract_relative_path=supabase/authorization-contract.json
readonly baseline_authorization_contract_relative_path=supabase/baseline-authorization-contract.json
readonly authorization_head_relative_path=supabase/authorization-head.json
readonly supabase_cli_sha256=5986d84e4c7e251126f7579c686b302b3527bc4b2ac1517963930eb0780d3867
readonly supabase_go_sha256=c507c71c331ee9b4dd87b6ec6cc8a6e4f312a642ff0f9e44931129053c534eef
readonly host_tools_root=/usr/local/libexec/setlivre-host-tools
readonly supabase_tools_directory="$host_tools_root/$expected_supabase_version"
readonly supabase_cli_path="$supabase_tools_directory/supabase"
readonly supabase_go_path="$supabase_tools_directory/supabase-go"
readonly expected_node_version=v24.18.0
readonly deployer_user=setlivre-deployer
readonly deployer_group=setlivre-deployer
readonly deployer_home=/var/lib/setlivre-deployer
readonly private_base="$deployer_home/.setlivre"
readonly incoming_base="$private_base/incoming"
readonly work_base="$private_base/work"
readonly state_base="$private_base/state"
readonly deployed_state="$state_base/deployed.state"
readonly rejected_artifacts_state="$state_base/rejected-artifacts.state"
readonly applied_schema_state="$state_base/applied-schema.state"
readonly authorization_preflight_state="$state_base/authorization-preflight.state"
readonly cleanup_pending_state="$state_base/cleanup-pending.state"
readonly dispatcher=/usr/local/sbin/setlivre-deploy-dispatch
readonly production_smoke=/usr/local/libexec/setlivre/production-smoke.mjs
readonly api_base="https://api.github.com/repos/$repository"
readonly dispatcher_protocol=3
readonly api_page_size=100
readonly maximum_run_pages=100
readonly maximum_artifact_pages=100
readonly maximum_api_bytes=67108864
readonly maximum_zip_bytes=2147483648
readonly maximum_expanded_bytes=4294967296
readonly maximum_entries=100000
readonly maximum_rejected_artifacts=100000
readonly maximum_rejected_artifacts_bytes=33554432
readonly maximum_applied_schema_bytes=128
readonly maximum_authorization_state_bytes=67108864
readonly maximum_credential_bytes=1048576
readonly maximum_supabase_ca_bytes=1048576
readonly maximum_cleanup_pending_bytes=1024
readonly minimum_free_reserve_bytes=536870912
readonly smoke_attempts=37
readonly smoke_interval_ms=25000
readonly smoke_timeout_seconds=1080
readonly confirmation_margin_seconds=120
readonly compatibility_smoke_attempts=1
readonly compatibility_smoke_interval_ms=0
readonly compatibility_smoke_timeout_seconds=120

github_token=
github_repository_id=
ci_github_workflow_id=
prd_github_workflow_id=
supabase_access_token=
supabase_db_password=
database_url=
public_app_url=
backoffice_app_url=
supabase_project_ref=
supabase_url=
supabase_anon_key=
supabase_server_ca_sha256=
supabase_server_ca_path=
work_directory=
incoming_directory=
root_preflight_sha=
rollback_sha=none
checkpoint_release_sha=none
checkpoint_source_run_number=0
checkpoint_source_run_attempt=0
checkpoint_source_run_id=0
checkpoint_artifact_id=0
checkpoint_artifact_digest=
checkpoint_archive_sha=
checkpoint_lock_sha=
checkpoint_migration_head=none

fail() {
  printf '%s\n' "Set Livre production deploy agent rejected the operation." >&2
  exit 1
}

log() {
  printf '%s\n' "$1"
}

assert_sha() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] || fail
}

assert_optional_sha() {
  [[ "$1" == none ]] || assert_sha "$1"
}

assert_checksum() {
  [[ "$1" =~ ^[0-9a-f]{64}$ ]] || fail
}

file_sha256() {
  local path="$1"
  local output
  output="$(sha256sum -- "$path")" || fail
  local digest="${output%% *}"
  assert_checksum "$digest"
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
  assert_checksum "$expected_sha256"
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
  [[ "$version" == "$expected_supabase_version" ]] || fail
}

assert_positive_integer() {
  local value="$1"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || fail
  [[ "${#value}" -le 19 ]] || fail
  if [[ "${#value}" -eq 19 ]]; then
    case "$value" in
      [1-8]*) ;;
      9*) ((10#${value:1} <= 223372036854775807)) || fail ;;
      *) fail ;;
    esac
  fi
}

assert_nonnegative_integer() {
  local value="$1"
  if [[ "$value" == 0 ]]; then
    return 0
  fi
  assert_positive_integer "$value"
}

assert_publishable_key() {
  [[ "$1" =~ ^sb_publishable_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{8}$ ]] || fail
}

assert_plain_secret() {
  local value="$1"
  [[ -n "$value" && "${#value}" -le 8192 ]] || fail
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail
}

systemd_credential_path() {
  local credential_name="$1"
  [[ "$credential_name" =~ ^[a-z0-9][a-z0-9.-]{0,63}$ ]] || fail
  [[ -n "${CREDENTIALS_DIRECTORY:-}" && "$CREDENTIALS_DIRECTORY" == /* ]] || fail
  [[ -d "$CREDENTIALS_DIRECTORY" && ! -L "$CREDENTIALS_DIRECTORY" ]] || fail
  local credential_path="$CREDENTIALS_DIRECTORY/$credential_name"
  [[ -f "$credential_path" && ! -L "$credential_path" ]] || fail
  [[ "$(readlink --canonicalize-existing -- "$credential_path")" == "$credential_path" ]] || fail
  local size
  size="$(stat -c '%s' -- "$credential_path")" || fail
  [[ "$size" =~ ^[0-9]+$ && "${#size}" -le 19 ]] || fail
  ((size <= maximum_credential_bytes)) || fail
  printf '%s\n' "$credential_path"
}

read_systemd_credential() {
  local credential_path
  credential_path="$(systemd_credential_path "$1")" || fail
  python3 - "$credential_path" <<'SYSTEMD_CREDENTIAL_PY'
import os
import sys

path = sys.argv[1]
value = open(path, "rb").read()
if not value or len(value) > 8192 or any(character in value for character in (b"\0", b"\n", b"\r")):
    raise SystemExit(1)
try:
    value.decode("utf-8", errors="strict")
except UnicodeDecodeError:
    raise SystemExit(1)
os.write(1, value)
SYSTEMD_CREDENTIAL_PY
}

monotonic_seconds() {
  python3 - <<'MONOTONIC_SECONDS_PY'
import time

print(time.monotonic_ns() // 1_000_000_000)
MONOTONIC_SECONDS_PY
}

assert_smoke_window() {
  local deadline="$1"
  local now
  assert_positive_integer "$deadline"
  now="$(monotonic_seconds)" || fail
  assert_positive_integer "$now"
  ((now + smoke_timeout_seconds + confirmation_margin_seconds <= deadline)) || fail
}

assert_confirmation_window() {
  local deadline="$1"
  local now
  assert_positive_integer "$deadline"
  now="$(monotonic_seconds)" || fail
  assert_positive_integer "$now"
  ((now + confirmation_margin_seconds <= deadline)) || fail
}

assert_github_token() {
  assert_plain_secret "$1"
  case "$1" in
    *\"* | *\\*) fail ;;
  esac
  [[ "$1" =~ ^[A-Za-z0-9_.-]+$ ]] || fail
}

assert_https_origin() {
  python3 - "$1" "$2" <<'PY'
import sys
from urllib.parse import urlsplit

value, expected = sys.argv[1:]
parsed = urlsplit(value)
if (
    parsed.scheme != "https"
    or parsed.hostname is None
    or parsed.username is not None
    or parsed.password is not None
    or parsed.port not in (None, 443)
    or parsed.path not in ("", "/")
    or parsed.query
    or parsed.fragment
    or value.rstrip("/") != expected
):
    raise SystemExit(1)
PY
}

capture_environment() {
  [[ "$(id -un)" == "$deployer_user" && "$(id -gn)" == "$deployer_group" ]] || fail
  if [[ "${PRD_DEPLOY_ENABLED:-}" != true ]]; then
    unset GITHUB_DEPLOY_TOKEN GITHUB_REPOSITORY_ID CI_GITHUB_WORKFLOW_ID
    unset PRD_GITHUB_WORKFLOW_ID SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD
    unset PRD_DATABASE_URL_APP_DAL PRD_PUBLIC_APP_URL PRD_BACKOFFICE_APP_URL
    unset PRD_SUPABASE_PROJECT_REF PRD_SUPABASE_URL PRD_SUPABASE_ANON_KEY PRD_DEPLOY_ENABLED
    unset SUPABASE_SERVER_CA_SHA256
    return 2
  fi
  github_token="$(read_systemd_credential github-deploy-token)" || fail
  github_repository_id="${GITHUB_REPOSITORY_ID:-}"
  ci_github_workflow_id="${CI_GITHUB_WORKFLOW_ID:-}"
  prd_github_workflow_id="${PRD_GITHUB_WORKFLOW_ID:-}"
  supabase_access_token="$(read_systemd_credential supabase-access-token)" || fail
  supabase_db_password="$(read_systemd_credential supabase-db-password)" || fail
  database_url="$(read_systemd_credential database-url-app-dal)" || fail
  public_app_url="${PRD_PUBLIC_APP_URL:-}"
  backoffice_app_url="${PRD_BACKOFFICE_APP_URL:-}"
  supabase_project_ref="${PRD_SUPABASE_PROJECT_REF:-}"
  supabase_url="${PRD_SUPABASE_URL:-}"
  supabase_anon_key="${PRD_SUPABASE_ANON_KEY:-}"
  supabase_server_ca_sha256="${SUPABASE_SERVER_CA_SHA256:-}"
  supabase_server_ca_path="$(systemd_credential_path supabase-server-ca.pem)" || fail
  assert_github_token "$github_token"
  assert_positive_integer "$github_repository_id"
  assert_positive_integer "$ci_github_workflow_id"
  assert_positive_integer "$prd_github_workflow_id"
  [[ "$github_repository_id" == "$expected_repository_id" ]] || fail
  [[ "$ci_github_workflow_id" != "$prd_github_workflow_id" ]] || fail
  assert_plain_secret "$supabase_access_token"
  assert_plain_secret "$supabase_db_password"
  assert_plain_secret "$database_url"
  assert_plain_secret "$supabase_anon_key"
  assert_publishable_key "$supabase_anon_key"
  assert_checksum "$supabase_server_ca_sha256"
  assert_supabase_server_ca
  [[ "$supabase_project_ref" == "$expected_supabase_project_ref" ]] || fail
  [[ "$supabase_url" == "$expected_supabase_url" ]] || fail
  assert_https_origin "$public_app_url" https://setlivre.com
  assert_https_origin "$backoffice_app_url" https://ops.setlivre.com
  [[ "$public_app_url" != "$backoffice_app_url" ]] || fail
  unset GITHUB_DEPLOY_TOKEN GITHUB_REPOSITORY_ID CI_GITHUB_WORKFLOW_ID
  unset PRD_GITHUB_WORKFLOW_ID SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD
  unset PRD_DATABASE_URL_APP_DAL PRD_PUBLIC_APP_URL PRD_BACKOFFICE_APP_URL
  unset PRD_SUPABASE_PROJECT_REF PRD_SUPABASE_URL PRD_SUPABASE_ANON_KEY PRD_DEPLOY_ENABLED
  unset SUPABASE_SERVER_CA_SHA256 CREDENTIALS_DIRECTORY
}

assert_supabase_server_ca() {
  [[ -f "$supabase_server_ca_path" && ! -L "$supabase_server_ca_path" ]] || fail
  [[ "$(readlink --canonicalize-existing -- "$supabase_server_ca_path")" \
    == "$supabase_server_ca_path" ]] || fail
  local size
  size="$(stat -c '%s' -- "$supabase_server_ca_path")" || fail
  [[ "$size" =~ ^[1-9][0-9]*$ ]] || fail
  ((size <= maximum_supabase_ca_bytes)) || fail
  [[ "$(file_sha256 "$supabase_server_ca_path")" == "$supabase_server_ca_sha256" ]] || fail
  python3 - "$supabase_server_ca_path" <<'SUPABASE_CA_PY'
import re
import sys

path = sys.argv[1]
payload = open(path, "rb").read()
try:
    text = payload.decode("ascii", errors="strict")
except UnicodeDecodeError:
    raise SystemExit(1)
if "PRIVATE KEY" in text or "\x00" in text or "\r" in text:
    raise SystemExit(1)
labels = re.findall(r"^-----BEGIN ([A-Z0-9 ]+)-----$", text, flags=re.MULTILINE)
end_labels = re.findall(r"^-----END ([A-Z0-9 ]+)-----$", text, flags=re.MULTILINE)
if not labels or labels != end_labels or any(label != "CERTIFICATE" for label in labels):
    raise SystemExit(1)
if not text.endswith("\n"):
    raise SystemExit(1)
SUPABASE_CA_PY
  openssl crl2pkcs7 -nocrl -certfile "$supabase_server_ca_path" \
    | openssl pkcs7 -print_certs -noout >/dev/null || fail
}

assert_private_directory() {
  local path="$1"
  [[ -d "$path" && ! -L "$path" ]] || fail
  [[ "$(readlink --canonicalize-existing -- "$path")" == "$path" ]] || fail
  [[ "$(stat -c '%U:%G:%a' -- "$path")" == "$deployer_user:$deployer_group:700" ]] || fail
}

assert_installed_file() {
  local path="$1"
  local mode="$2"
  [[ -f "$path" && ! -L "$path" ]] || fail
  [[ "$(readlink --canonicalize-existing -- "$path")" == "$path" ]] || fail
  [[ "$(stat -c '%U:%G:%a:%h' -- "$path")" == "root:$deployer_group:$mode:1" ]] || fail
}

assert_private_state_file() {
  local path="$1"
  local maximum_bytes="$2"
  [[ -f "$path" && ! -L "$path" ]] || fail
  [[ "$(readlink --canonicalize-existing -- "$path")" == "$path" ]] || fail
  [[ "$(stat -c '%U:%G:%a:%h' -- "$path")" \
    == "$deployer_user:$deployer_group:600:1" ]] || fail
  local size
  size="$(stat -c '%s' -- "$path")" || fail
  [[ "$size" =~ ^[1-9][0-9]*$ ]] || fail
  ((size <= maximum_bytes)) || fail
}

assert_runtime() {
  [[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || fail
  [[ "$(node --version)" == "$expected_node_version" ]] || fail
  local command_name
  for command_name in chmod curl df env find flock id install mkfifo mktemp mv node psql python3 readlink rm sha256sum sort stat sudo sync tail tar timeout tr uname wait; do
    command -v "$command_name" >/dev/null 2>&1 || fail
  done
  assert_private_directory "$deployer_home"
  assert_private_directory "$private_base"
  assert_private_directory "$incoming_base"
  assert_private_directory "$work_base"
  assert_private_directory "$state_base"
  assert_installed_file "$production_smoke" 640
  [[ -f "$dispatcher" && ! -L "$dispatcher" ]] || fail
  [[ "$(sudo -n "$dispatcher" version)" == "$dispatcher_protocol" ]] || fail
}

assert_available_space() {
  local path="$1"
  local required_bytes="$2"
  local available_bytes
  [[ -d "$path" && ! -L "$path" ]] || fail
  assert_positive_integer "$required_bytes"
  available_bytes="$(df --block-size=1 --output=avail -- "$path" \
    | tail -n 1 | tr -d '[:space:]')" || fail
  [[ "$available_bytes" =~ ^[1-9][0-9]*$ ]] || fail
  ((required_bytes <= 9223372036854775807 - minimum_free_reserve_bytes)) || fail
  ((available_bytes >= required_bytes + minimum_free_reserve_bytes)) || fail
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

cleanup_tree() {
  local candidate="$1"
  local parent="$2"
  local original="$candidate"
  local retired="$parent/.cleanup-retired-${candidate##*/}"
  local candidate_identity
  local unsafe_entry
  [[ -n "$candidate" && "$candidate" == "$parent/"* && "$candidate" != "$parent/" ]] || return 1
  cleanup_target_is_authorized "$candidate" "$parent" || return 1
  assert_private_directory "$parent" || return 1
  [[ "$retired" == "$parent/.cleanup-retired-"* && "$retired" != "$original" ]] || return 1
  if [[ -e "$retired" || -L "$retired" ]]; then
    [[ ! -e "$original" && ! -L "$original" ]] || return 1
    candidate="$retired"
  elif [[ ! -e "$candidate" && ! -L "$candidate" ]]; then
    return 0
  fi
  [[ -d "$candidate" && ! -L "$candidate" ]] || return 1
  [[ "$(readlink --canonicalize-existing -- "$candidate")" == "$candidate" ]] || return 1
  [[ "$(stat -c '%U:%G:%a' -- "$candidate")" \
    == "$deployer_user:$deployer_group:700" ]] || return 1
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
  sync -f "$parent" || return 1
  [[ ! -e "$retired" && ! -L "$retired" ]] || return 1
}

assert_cleanup_targets() {
  local candidate_work="$1"
  local candidate_incoming="$2"
  local work_suffix
  local incoming_suffix
  [[ "$candidate_work" == "$work_base/deploy."* ]] || return 1
  work_suffix="${candidate_work#"$work_base/deploy."}"
  [[ "$work_suffix" =~ ^[A-Za-z0-9]{8}$ ]] || return 1
  if [[ "$candidate_incoming" != none ]]; then
    [[ "$candidate_incoming" == "$incoming_base/"* ]] || return 1
    incoming_suffix="${candidate_incoming#"$incoming_base/"}"
    [[ "$incoming_suffix" =~ ^[0-9a-f]{40}$ ]] || return 1
  fi
}

parse_cleanup_pending_state() {
  local path="$1"
  local expected_work_base="$2"
  local expected_incoming_base="$3"
  local -a lines=()
  mapfile -t lines <"$path"
  [[ "${#lines[@]}" -eq 3 ]] || return 1
  [[ "${lines[0]}" == schema=1 ]] || return 1
  [[ "${lines[1]}" == work_directory=* ]] || return 1
  [[ "${lines[2]}" == incoming_directory=* ]] || return 1
  local candidate_work="${lines[1]#work_directory=}"
  local candidate_incoming="${lines[2]#incoming_directory=}"
  local work_suffix
  local incoming_suffix
  [[ "$candidate_work" == "$expected_work_base/deploy."* ]] || return 1
  work_suffix="${candidate_work#"$expected_work_base/deploy."}"
  [[ "$work_suffix" =~ ^[A-Za-z0-9]{8}$ ]] || return 1
  if [[ "$candidate_incoming" != none ]]; then
    [[ "$candidate_incoming" == "$expected_incoming_base/"* ]] || return 1
    incoming_suffix="${candidate_incoming#"$expected_incoming_base/"}"
    [[ "$incoming_suffix" =~ ^[0-9a-f]{40}$ ]] || return 1
  fi
  printf '%s\n%s\n' "$candidate_work" "$candidate_incoming"
}

cleanup_target_is_authorized() {
  local candidate="$1"
  local parent="$2"
  assert_private_state_file "$cleanup_pending_state" "$maximum_cleanup_pending_bytes" || return 1
  local parsed_targets
  parsed_targets="$(parse_cleanup_pending_state \
    "$cleanup_pending_state" "$work_base" "$incoming_base")" || return 1
  local -a targets=()
  mapfile -t targets <<<"$parsed_targets" || return 1
  [[ "${#targets[@]}" -eq 2 ]] || return 1
  case "$parent" in
    "$work_base") [[ "$candidate" == "${targets[0]}" ]] ;;
    "$incoming_base") [[ "$candidate" == "${targets[1]}" && "${targets[1]}" != none ]] ;;
    *) return 1 ;;
  esac
}

write_cleanup_pending_state() {
  local candidate_work="$1"
  local candidate_incoming="$2"
  assert_cleanup_targets "$candidate_work" "$candidate_incoming" || return 1
  local candidate
  candidate="$(mktemp --tmpdir="$state_base" '.cleanup-pending.XXXXXXXX')" || return 1
  printf '%s\n' \
    schema=1 \
    "work_directory=$candidate_work" \
    "incoming_directory=$candidate_incoming" \
    >"$candidate" || return 1
  chmod 0600 "$candidate" || return 1
  sync -f "$candidate" || return 1
  mv -Tf -- "$candidate" "$cleanup_pending_state" || return 1
  sync -f "$state_base" || return 1
  assert_private_state_file "$cleanup_pending_state" "$maximum_cleanup_pending_bytes" || return 1
  [[ "$(parse_cleanup_pending_state \
    "$cleanup_pending_state" "$work_base" "$incoming_base")" \
    == "$candidate_work"$'\n'"$candidate_incoming" ]] || return 1
}

clear_cleanup_pending_state() {
  if [[ ! -e "$cleanup_pending_state" && ! -L "$cleanup_pending_state" ]]; then
    return 0
  fi
  assert_private_state_file "$cleanup_pending_state" "$maximum_cleanup_pending_bytes" || return 1
  rm -f -- "$cleanup_pending_state" || return 1
  sync -f "$state_base" || return 1
  [[ ! -e "$cleanup_pending_state" && ! -L "$cleanup_pending_state" ]] || return 1
}

recover_pending_cleanup() {
  local orphaned_candidate
  orphaned_candidate="$(find "$state_base" -mindepth 1 -maxdepth 1 \
    \( -name '.cleanup-pending.*' -o -name '.cleanup-pending.*.tmp' \) \
    -print -quit)" || return 1
  [[ -z "$orphaned_candidate" ]] || return 1
  if [[ ! -e "$cleanup_pending_state" && ! -L "$cleanup_pending_state" ]]; then
    return 0
  fi
  assert_private_state_file "$cleanup_pending_state" "$maximum_cleanup_pending_bytes" || return 1
  local -a targets=()
  local parsed_targets
  parsed_targets="$(parse_cleanup_pending_state \
    "$cleanup_pending_state" "$work_base" "$incoming_base")" || return 1
  mapfile -t targets <<<"$parsed_targets" || return 1
  [[ "${#targets[@]}" -eq 2 ]] || return 1
  assert_cleanup_targets "${targets[0]}" "${targets[1]}" || return 1
  if [[ "${targets[1]}" != none ]]; then
    cleanup_tree "${targets[1]}" "$incoming_base" || return 1
  fi
  cleanup_tree "${targets[0]}" "$work_base" || return 1
  clear_cleanup_pending_state
}

cleanup_current_resources() {
  local candidate_work="$work_directory"
  local candidate_incoming="${incoming_directory:-none}"
  local cleanup_status=0
  [[ -n "$candidate_work" ]] || return 0
  assert_cleanup_targets "$candidate_work" "$candidate_incoming" || return 1
  write_cleanup_pending_state "$candidate_work" "$candidate_incoming" || return 1
  if [[ "$candidate_incoming" != none ]]; then
    cleanup_tree "$candidate_incoming" "$incoming_base" || cleanup_status=1
  fi
  cleanup_tree "$candidate_work" "$work_base" || cleanup_status=1
  work_directory=
  incoming_directory=
  if [[ "$cleanup_status" -ne 0 ]]; then
    return 1
  fi
  clear_cleanup_pending_state
}

cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  set +e
  if [[ -n "$root_preflight_sha" ]]; then
    if sudo -n "$dispatcher" discard-preflight "$root_preflight_sha" >/dev/null; then
      root_preflight_sha=
    else
      status=1
    fi
  fi
  if ! cleanup_current_resources; then
    status=1
  fi
  exit "$status"
}

github_api() {
  local relative_url="$1"
  local destination="$2"
  [[ "$relative_url" == /* && "$relative_url" != *$'\n'* && "$relative_url" != *'"'* ]] || fail
  {
    printf 'url = "%s%s"\n' "$api_base" "$relative_url"
    printf 'header = "Accept: application/vnd.github+json"\n'
    printf 'header = "Authorization: Bearer %s"\n' "$github_token"
    printf 'header = "X-GitHub-Api-Version: 2022-11-28"\n'
  } | curl --disable --config - --silent --show-error --fail --proto '=https' \
    --max-time 60 --max-filesize "$maximum_api_bytes" --output "$destination"
}

github_api_post() {
  local relative_url="$1"
  local request_body="$2"
  local response_body="$3"
  local response_status="$4"
  [[ "$relative_url" == /* && "$relative_url" != *$'\n'* && "$relative_url" != *'"'* ]] || fail
  [[ -f "$request_body" && ! -L "$request_body" ]] || fail
  [[ "$(stat -c '%U:%G:%a:%h' -- "$request_body")" \
    == "$deployer_user:$deployer_group:600:1" ]] || fail
  {
    printf 'url = "%s%s"\n' "$api_base" "$relative_url"
    printf 'request = "POST"\n'
    printf 'header = "Accept: application/vnd.github+json"\n'
    printf 'header = "Authorization: Bearer %s"\n' "$github_token"
    printf 'header = "Content-Type: application/json"\n'
    printf 'header = "X-GitHub-Api-Version: 2022-11-28"\n'
    printf 'data-binary = "@%s"\n' "$request_body"
  } | curl --disable --config - --silent --show-error --fail-with-body --proto '=https' \
    --max-time 60 --output "$response_body" --write-out '%{http_code}' >"$response_status"
  [[ "$(<"$response_status")" == 204 && ! -s "$response_body" ]] || fail
}

download_artifact() {
  local artifact_id="$1"
  local destination="$2"
  [[ "$artifact_id" =~ ^[1-9][0-9]*$ ]] || fail
  {
    printf 'url = "%s/actions/artifacts/%s/zip"\n' "$api_base" "$artifact_id"
    printf 'header = "Accept: application/vnd.github+json"\n'
    printf 'header = "Authorization: Bearer %s"\n' "$github_token"
    printf 'header = "X-GitHub-Api-Version: 2022-11-28"\n'
  } | curl --disable --config - --silent --show-error --fail --location \
    --proto '=https' --proto-redir '=https' --max-time 600 \
    --max-filesize "$maximum_zip_bytes" --output "$destination"
}

workflow_page_summary() {
  local runs_json="$1"
  python3 - "$runs_json" <<'PY'
import hashlib
import json
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as source:
    payload = json.load(source)
total_count = payload.get("total_count")
runs = payload.get("workflow_runs")
if (
    not isinstance(total_count, int)
    or isinstance(total_count, bool)
    or total_count < 0
    or not isinstance(runs, list)
):
    raise SystemExit(1)
identity = []
for run in runs:
    if not isinstance(run, dict):
        raise SystemExit(1)
    head_repository = run.get("head_repository")
    run_repository = run.get("repository")
    identity.append(
        {
            "conclusion": run.get("conclusion"),
            "display_title": run.get("display_title"),
            "event": run.get("event"),
            "head_branch": run.get("head_branch"),
            "head_repository": (
                head_repository.get("full_name") if isinstance(head_repository, dict) else None
            ),
            "head_sha": run.get("head_sha"),
            "id": run.get("id"),
            "path": run.get("path"),
            "workflow_id": run.get("workflow_id"),
            "repository": (
                run_repository.get("full_name") if isinstance(run_repository, dict) else None
            ),
            "repository_id": (
                run_repository.get("id") if isinstance(run_repository, dict) else None
            ),
            "head_repository_id": (
                head_repository.get("id") if isinstance(head_repository, dict) else None
            ),
            "run_attempt": run.get("run_attempt"),
            "run_number": run.get("run_number"),
            "status": run.get("status"),
            "updated_at": run.get("updated_at"),
        }
    )
fingerprint = hashlib.sha256(
    json.dumps(identity, ensure_ascii=True, separators=(",", ":")).encode()
).hexdigest()
sys.stdout.buffer.write(f"{total_count}\n{len(runs)}\n{fingerprint}\n".encode("ascii"))
PY
}

workflow_page_run_bounds() {
  local runs_json="$1"
  python3 - "$runs_json" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as source:
    payload = json.load(source)
runs = payload.get("workflow_runs")
if not isinstance(runs, list):
    raise SystemExit(1)
if not runs:
    sys.stdout.buffer.write(b"empty\n")
    raise SystemExit(0)
numbers = []
for run in runs:
    if not isinstance(run, dict):
        raise SystemExit(1)
    number = run.get("run_number")
    if not isinstance(number, int) or isinstance(number, bool) or number <= 0:
        raise SystemExit(1)
    numbers.append(number)
if len(numbers) != len(set(numbers)) or any(
    previous <= current for previous, current in zip(numbers, numbers[1:])
):
    raise SystemExit(1)
sys.stdout.buffer.write(f"{numbers[0]}\n{numbers[-1]}\n".encode("ascii"))
PY
}

candidate_runs() {
  local expected_total="$1"
  shift
  [[ "$expected_total" =~ ^(0|[1-9][0-9]*)$ && "$#" -ge 1 ]] || fail
  python3 - \
    "$repository" \
    "$prd_workflow" \
    "$branch" \
    "$expected_repository_id" \
    "$prd_github_workflow_id" \
    "$expected_total" \
    "$checkpoint_source_run_number" \
    "$checkpoint_source_run_attempt" \
    "$checkpoint_source_run_id" \
    "$checkpoint_release_sha" \
    "$@" <<'PY'
import json
import re
import sys

repository, workflow, branch, repository_id, workflow_id, expected_total, checkpoint_source_number, checkpoint_source_attempt, checkpoint_source_id, checkpoint_sha, *paths = sys.argv[1:]
repository_id = int(repository_id)
workflow_id = int(workflow_id)
expected_total = int(expected_total)
checkpoint_source_number = int(checkpoint_source_number)
checkpoint_source_attempt = int(checkpoint_source_attempt)
checkpoint_source_id = int(checkpoint_source_id)
all_runs = []
for path in paths:
    with open(path, "r", encoding="utf-8") as source:
        payload = json.load(source)
    if payload.get("total_count") != expected_total:
        raise SystemExit(1)
    runs = payload.get("workflow_runs")
    if not isinstance(runs, list):
        raise SystemExit(1)
    all_runs.extend(runs)
if len(all_runs) > expected_total or (expected_total == 0) != (len(all_runs) == 0):
    raise SystemExit(1)
normal_runs = {}
recovery_runs = []
seen_identifiers = set()
seen_all_run_numbers = set()
for run in all_runs:
    if not isinstance(run, dict):
        raise SystemExit(1)
    sha = run.get("head_sha")
    identifier = run.get("id")
    run_number = run.get("run_number")
    run_attempt = run.get("run_attempt")
    display_title = run.get("display_title")
    updated_at = run.get("updated_at")
    head_repository = run.get("head_repository")
    run_repository = run.get("repository")
    if (
        not isinstance(identifier, int)
        or isinstance(identifier, bool)
        or identifier <= 0
        or identifier in seen_identifiers
        or not isinstance(run_number, int)
        or isinstance(run_number, bool)
        or run_number <= 0
        or run_number in seen_all_run_numbers
        or not isinstance(run_attempt, int)
        or isinstance(run_attempt, bool)
        or run_attempt <= 0
        or not isinstance(sha, str)
        or re.fullmatch(r"[0-9a-f]{40}", sha) is None
        or not isinstance(display_title, str)
        or re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z", updated_at or "") is None
    ):
        raise SystemExit(1)
    seen_identifiers.add(identifier)
    seen_all_run_numbers.add(run_number)
    if (
        run.get("status") != "completed"
        or run.get("head_branch") != branch
        or run.get("path") != f".github/workflows/{workflow}"
        or run.get("workflow_id") != workflow_id
        or run.get("event") != "workflow_run"
        or not isinstance(head_repository, dict)
        or head_repository.get("full_name") != repository
        or head_repository.get("id") != repository_id
        or not isinstance(run_repository, dict)
        or run_repository.get("full_name") != repository
        or run_repository.get("id") != repository_id
    ):
        raise SystemExit(1)
    normal_match = re.fullmatch(r"Release ([0-9a-f]{40})", display_title)
    recovery_match = re.fullmatch(
        r"Recovered release ([0-9a-f]{40}) approved ([1-9][0-9]*)/([1-9][0-9]*) archive ([0-9a-f]{64}) config ([0-9a-f]{64})",
        display_title,
    )
    if run_number == checkpoint_source_number and (
        run.get("conclusion") != "success"
        or normal_match is None
        or identifier != checkpoint_source_id
        or run_attempt < checkpoint_source_attempt
        or normal_match.group(1) != checkpoint_sha
    ):
        raise SystemExit(1)
    if run.get("conclusion") == "success":
        if normal_match is not None:
            release_sha = normal_match.group(1)
            normal_runs[identifier] = {
                "attempt": run_attempt,
                "head_sha": sha,
                "id": identifier,
                "number": run_number,
                "release_sha": release_sha,
                "updated_at": updated_at,
            }
        elif recovery_match is not None:
            recovery_runs.append(
                {
                    "attempt": run_attempt,
                    "head_sha": sha,
                    "id": identifier,
                    "number": run_number,
                    "release_sha": recovery_match.group(1),
                    "source_id": int(recovery_match.group(2)),
                    "source_attempt": int(recovery_match.group(3)),
                    "archive_sha": recovery_match.group(4),
                    "public_build_config_sha": recovery_match.group(5),
                    "updated_at": updated_at,
                }
            )
        else:
            raise SystemExit(1)

if checkpoint_source_number == 0:
    eligible_sources = (
        [max(normal_runs.values(), key=lambda value: (value["number"], value["attempt"], value["id"]))]
        if normal_runs
        else []
    )
else:
    eligible_sources = [
        source for source in normal_runs.values() if source["number"] > checkpoint_source_number
    ]
providers = {source["id"]: [] for source in eligible_sources}
for recovery in recovery_runs:
    source = normal_runs.get(recovery["source_id"])
    if source is None or source["id"] not in providers:
        continue
    if (
        recovery["source_attempt"] != source["attempt"]
        or recovery["release_sha"] != source["release_sha"]
        or recovery["number"] <= source["number"]
    ):
        raise SystemExit(1)
    providers[source["id"]].append(recovery)

for source in sorted(eligible_sources, key=lambda value: (value["number"], value["attempt"], value["id"])):
    recoveries = providers[source["id"]]
    artifact_provider = max(
        recoveries,
        key=lambda value: (value["number"], value["attempt"], value["id"]),
    ) if recoveries else source
    kind = "recovery" if recoveries else "normal"
    serialized = " ".join(
        str(value)
        for value in (
            source["number"],
            source["attempt"],
            source["id"],
            source["head_sha"],
            source["release_sha"],
            artifact_provider["number"],
            artifact_provider["attempt"],
            artifact_provider["id"],
            artifact_provider["head_sha"],
            artifact_provider["updated_at"],
            kind,
            artifact_provider.get("archive_sha", "none"),
            artifact_provider.get("public_build_config_sha", "none"),
        )
    )
    sys.stdout.buffer.write(serialized.encode("ascii") + b"\n")
PY
}

fetch_workflow_run_pages() {
  local endpoint="$1"
  local file_prefix="$2"
  local boundary_run_number="$3"
  [[ "$endpoint" == /actions/workflows/*/runs\?* ]] || fail
  [[ "$endpoint" != *$'\n'* && "$endpoint" != *$'\r'* ]] || fail
  [[ "$file_prefix" =~ ^[a-z][a-z0-9-]*$ ]] || fail
  assert_nonnegative_integer "$boundary_run_number"
  local first_page="$work_directory/${file_prefix}-page-1.json"
  local stable_page="$work_directory/${file_prefix}-page-1-stable.json"
  local -a page_paths=("$first_page")
  local -a first_summary=()
  local -a page_summary=()
  local -a page_bounds=()
  local summary
  local bounds
  github_api "${endpoint}&per_page=$api_page_size&page=1" "$first_page"
  summary="$(workflow_page_summary "$first_page")" || fail
  mapfile -t first_summary <<<"$summary" || fail
  [[ "${#first_summary[@]}" -eq 3 ]] || fail
  local total_count="${first_summary[0]}"
  local first_count="${first_summary[1]}"
  assert_nonnegative_integer "$total_count"
  assert_nonnegative_integer "$first_count"
  local page_count=$(((total_count + api_page_size - 1) / api_page_size))
  if [[ "$page_count" -eq 0 ]]; then
    page_count=1
  fi
  if [[ "$boundary_run_number" -eq 0 ]]; then
    ((page_count <= maximum_run_pages)) || fail
  fi
  local expected_first_count="$total_count"
  if ((expected_first_count > api_page_size)); then
    expected_first_count="$api_page_size"
  fi
  [[ "$first_count" -eq "$expected_first_count" ]] || fail

  bounds="$(workflow_page_run_bounds "$first_page")" || fail
  mapfile -t page_bounds <<<"$bounds" || fail
  local boundary_reached=0
  local previous_oldest=0
  if [[ "$first_count" -eq 0 ]]; then
    [[ "${#page_bounds[@]}" -eq 1 && "${page_bounds[0]}" == empty ]] || fail
    boundary_reached=1
  else
    [[ "${#page_bounds[@]}" -eq 2 ]] || fail
    assert_positive_integer "${page_bounds[0]}"
    assert_positive_integer "${page_bounds[1]}"
    ((page_bounds[0] >= page_bounds[1])) || fail
    previous_oldest="${page_bounds[1]}"
    if [[ "$boundary_run_number" -gt 0 \
      && "$previous_oldest" -le "$boundary_run_number" ]]; then
      boundary_reached=1
    fi
  fi

  local page
  for ((page = 2; page <= page_count && boundary_reached == 0; page += 1)); do
    ((page <= maximum_run_pages)) || fail
    local page_path="$work_directory/${file_prefix}-page-$page.json"
    github_api "${endpoint}&per_page=$api_page_size&page=$page" "$page_path"
    summary="$(workflow_page_summary "$page_path")" || fail
    mapfile -t page_summary <<<"$summary" || fail
    [[ "${#page_summary[@]}" -eq 3 ]] || fail
    [[ "${page_summary[0]}" == "$total_count" ]] || fail
    local expected_page_count="$api_page_size"
    if [[ "$page" -eq "$page_count" ]]; then
      expected_page_count=$((total_count - (page - 1) * api_page_size))
    fi
    [[ "${page_summary[1]}" -eq "$expected_page_count" ]] || fail
    bounds="$(workflow_page_run_bounds "$page_path")" || fail
    mapfile -t page_bounds <<<"$bounds" || fail
    [[ "${#page_bounds[@]}" -eq 2 ]] || fail
    assert_positive_integer "${page_bounds[0]}"
    assert_positive_integer "${page_bounds[1]}"
    ((page_bounds[0] >= page_bounds[1])) || fail
    ((previous_oldest > page_bounds[0])) || fail
    previous_oldest="${page_bounds[1]}"
    page_paths+=("$page_path")
    if [[ "$boundary_run_number" -gt 0 \
      && "$previous_oldest" -le "$boundary_run_number" ]]; then
      boundary_reached=1
    fi
  done
  if [[ "$boundary_run_number" -gt 0 && "$boundary_reached" -eq 0 \
    && "$page_count" -gt "$maximum_run_pages" ]]; then
    fail
  fi

  github_api "${endpoint}&per_page=$api_page_size&page=1" "$stable_page"
  summary="$(workflow_page_summary "$stable_page")" || fail
  mapfile -t page_summary <<<"$summary" || fail
  [[ "${#page_summary[@]}" -eq 3 ]] || fail
  [[ "${page_summary[*]}" == "${first_summary[*]}" ]] || fail
  printf '%s\n' "$total_count" "${page_paths[@]}"
}

fetch_candidate_runs() {
  local destination="$1"
  local page_manifest
  page_manifest="$(fetch_workflow_run_pages \
    "/actions/workflows/$prd_github_workflow_id/runs?branch=$branch&status=completed" \
    runs \
    "$checkpoint_source_run_number")" || fail
  local -a manifest_lines=()
  mapfile -t manifest_lines <<<"$page_manifest" || fail
  [[ "${#manifest_lines[@]}" -ge 2 ]] || fail
  local total_count="${manifest_lines[0]}"
  assert_nonnegative_integer "$total_count"
  local -a page_paths=("${manifest_lines[@]:1}")
  candidate_runs "$total_count" "${page_paths[@]}" >"$destination" || fail
}

artifact_page_summary() {
  local artifacts_json="$1"
  python3 - "$artifacts_json" <<'PY'
import hashlib
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as source:
    payload = json.load(source)
total_count = payload.get("total_count")
artifacts = payload.get("artifacts")
if (
    not isinstance(total_count, int)
    or isinstance(total_count, bool)
    or total_count < 0
    or not isinstance(artifacts, list)
):
    raise SystemExit(1)
identity = []
for artifact in artifacts:
    if not isinstance(artifact, dict):
        raise SystemExit(1)
    identity.append(
        {
            "archive_download_url": artifact.get("archive_download_url"),
            "digest": artifact.get("digest"),
            "expired": artifact.get("expired"),
            "expires_at": artifact.get("expires_at"),
            "id": artifact.get("id"),
            "name": artifact.get("name"),
            "size_in_bytes": artifact.get("size_in_bytes"),
            "workflow_run": artifact.get("workflow_run"),
        }
    )
fingerprint = hashlib.sha256(
    json.dumps(identity, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode()
).hexdigest()
print(total_count)
print(len(artifacts))
print(fingerprint)
PY
}

artifact_metadata() {
  local release_sha="$1"
  local run_id="$2"
  local provider_head_sha="$3"
  local expected_total="$4"
  shift 4
  [[ "$expected_total" =~ ^(0|[1-9][0-9]*)$ && "$#" -ge 1 ]] || fail
  python3 - \
    "$release_sha" \
    "$repository" \
    "$branch" \
    "$expected_repository_id" \
    "$run_id" \
    "$provider_head_sha" \
    "$maximum_zip_bytes" \
    "$expected_total" \
    "$@" <<'PY'
import datetime
import json
import re
import sys

sha, repository, branch, repository_id, run_id, provider_head_sha, maximum_zip_bytes, expected_total, *paths = sys.argv[1:]
repository_id = int(repository_id)
run_id = int(run_id)
maximum_zip_bytes = int(maximum_zip_bytes)
expected_total = int(expected_total)
artifacts = []
for path in paths:
    with open(path, "r", encoding="utf-8") as source:
        payload = json.load(source)
    if payload.get("total_count") != expected_total or not isinstance(payload.get("artifacts"), list):
        raise SystemExit(1)
    artifacts.extend(payload["artifacts"])
if len(artifacts) != expected_total:
    raise SystemExit(1)
seen_identifiers = set()
for artifact in artifacts:
    if not isinstance(artifact, dict):
        raise SystemExit(1)
    identifier = artifact.get("id")
    if (
        not isinstance(identifier, int)
        or isinstance(identifier, bool)
        or identifier <= 0
        or identifier in seen_identifiers
        or not isinstance(artifact.get("name"), str)
    ):
        raise SystemExit(1)
    seen_identifiers.add(identifier)
expected_name = re.compile(
    rf"set-livre-{sha}-([0-9a-f]{{64}})-([0-9a-f]{{64}})"
)
matches = [
    (artifact, expected_name.fullmatch(artifact.get("name", "")))
    for artifact in artifacts
    if isinstance(artifact.get("name"), str)
    and expected_name.fullmatch(artifact["name"]) is not None
]
if not matches:
    print("missing-artifact")
    raise SystemExit(0)
if len(matches) != 1:
    raise SystemExit(1)
artifact, identity_match = matches[0]
if identity_match is None:
    raise SystemExit(1)
archive_sha256, public_build_config_sha256 = identity_match.groups()
digest = artifact.get("digest")
identifier = artifact.get("id")
expires_at = artifact.get("expires_at")
archive_url = artifact.get("archive_download_url")
workflow_run = artifact.get("workflow_run")
size_in_bytes = artifact.get("size_in_bytes")
if (
    not isinstance(artifact.get("expired"), bool)
    or not isinstance(identifier, int)
    or identifier <= 0
    or not isinstance(digest, str)
    or re.fullmatch(r"sha256:[0-9a-f]{64}", digest) is None
    or not isinstance(expires_at, str)
    or not isinstance(archive_url, str)
    or archive_url != f"https://api.github.com/repos/{repository}/actions/artifacts/{identifier}/zip"
    or not isinstance(size_in_bytes, int)
    or isinstance(size_in_bytes, bool)
    or size_in_bytes <= 0
    or size_in_bytes > maximum_zip_bytes
    or not isinstance(workflow_run, dict)
    or workflow_run.get("id") != run_id
    or workflow_run.get("head_branch") != branch
    or workflow_run.get("head_sha") != provider_head_sha
    or workflow_run.get("repository_id") != repository_id
    or workflow_run.get("head_repository_id") != repository_id
):
    raise SystemExit(1)
expires = datetime.datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
if artifact.get("expired") is True or expires <= datetime.datetime.now(datetime.timezone.utc):
    print("expired-artifact")
    print(archive_sha256)
    print(public_build_config_sha256)
    raise SystemExit(0)
print(identifier)
print(digest.removeprefix("sha256:"))
print(size_in_bytes)
print(archive_sha256)
print(public_build_config_sha256)
PY
}

fetch_artifact_metadata() {
  local run_id="$1"
  local release_sha="$2"
  local provider_head_sha="$3"
  local destination="$4"
  assert_positive_integer "$run_id"
  assert_sha "$release_sha"
  assert_sha "$provider_head_sha"
  local first_page="$work_directory/artifacts-${run_id}-page-1.json"
  local stable_page="$work_directory/artifacts-${run_id}-page-1-stable.json"
  local -a page_paths=("$first_page")
  local -a first_summary=()
  local -a page_summary=()
  local summary
  github_api "/actions/runs/$run_id/artifacts?per_page=$api_page_size&page=1" "$first_page"
  summary="$(artifact_page_summary "$first_page")" || fail
  mapfile -t first_summary <<<"$summary" || fail
  [[ "${#first_summary[@]}" -eq 3 ]] || fail
  local total_count="${first_summary[0]}"
  local first_count="${first_summary[1]}"
  [[ "$total_count" =~ ^(0|[1-9][0-9]*)$ ]] || fail
  [[ "$first_count" =~ ^(0|[1-9][0-9]*)$ ]] || fail
  local page_count=$(((total_count + api_page_size - 1) / api_page_size))
  if [[ "$page_count" -eq 0 ]]; then
    page_count=1
  fi
  ((page_count <= maximum_artifact_pages)) || fail
  local expected_first_count="$total_count"
  if ((expected_first_count > api_page_size)); then
    expected_first_count="$api_page_size"
  fi
  [[ "$first_count" -eq "$expected_first_count" ]] || fail

  local page
  for ((page = 2; page <= page_count; page += 1)); do
    local page_path="$work_directory/artifacts-${run_id}-page-$page.json"
    github_api "/actions/runs/$run_id/artifacts?per_page=$api_page_size&page=$page" "$page_path"
    summary="$(artifact_page_summary "$page_path")" || fail
    mapfile -t page_summary <<<"$summary" || fail
    [[ "${#page_summary[@]}" -eq 3 ]] || fail
    [[ "${page_summary[0]}" == "$total_count" ]] || fail
    local expected_page_count="$api_page_size"
    if [[ "$page" -eq "$page_count" ]]; then
      expected_page_count=$((total_count - (page - 1) * api_page_size))
    fi
    [[ "${page_summary[1]}" -eq "$expected_page_count" ]] || fail
    page_paths+=("$page_path")
  done

  github_api "/actions/runs/$run_id/artifacts?per_page=$api_page_size&page=1" "$stable_page"
  summary="$(artifact_page_summary "$stable_page")" || fail
  mapfile -t page_summary <<<"$summary" || fail
  [[ "${#page_summary[@]}" -eq 3 ]] || fail
  [[ "${page_summary[*]}" == "${first_summary[*]}" ]] || fail
  artifact_metadata "$release_sha" "$run_id" "$provider_head_sha" "$total_count" "${page_paths[@]}" \
    >"$destination" || fail
}

publish_job_outcome() {
  local jobs_json="$1"
  local run_id="$2"
  local provider_head_sha="$3"
  node - "$jobs_json" "$repository" "$run_id" "$provider_head_sha" <<'PUBLISH_JOB_NODE'
const fs = require("node:fs");

const [path, repository, runIdText, providerHeadSha] = process.argv.slice(2);
const runId = Number(runIdText);

function reject() {
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(fs.readFileSync(path, "utf8"));
} catch {
  reject();
}

if (
  !Number.isSafeInteger(runId) ||
  runId <= 0 ||
  !/^[0-9a-f]{40}$/.test(providerHeadSha ?? "") ||
  payload === null ||
  typeof payload !== "object" ||
  Array.isArray(payload) ||
  payload.total_count !== 1 ||
  !Array.isArray(payload.jobs) ||
  payload.jobs.length !== 1
) {
  reject();
}

const [job] = payload.jobs;
if (
  job === null ||
  typeof job !== "object" ||
  Array.isArray(job) ||
  !Number.isSafeInteger(job.id) ||
  job.id <= 0 ||
  job.run_id !== runId ||
  job.run_url !== `https://api.github.com/repos/${repository}/actions/runs/${runId}` ||
  job.url !== `https://api.github.com/repos/${repository}/actions/jobs/${job.id}` ||
  job.head_sha !== providerHeadSha ||
  job.head_branch !== "main" ||
  job.status !== "completed" ||
  job.name !== "Verify and publish canonical Linux x64 release" ||
  job.workflow_name !== "Build production artifact" ||
  !Array.isArray(job.steps)
) {
  reject();
}

if (job.conclusion === "skipped" && job.steps.length === 0) {
  process.stdout.write("skipped\n");
} else if (
  job.conclusion === "success" &&
  job.steps.filter(
    (step) =>
      step !== null &&
      typeof step === "object" &&
      step.name === "Publish immutable release artifact" &&
      step.conclusion === "success",
  ).length === 1
) {
  process.stdout.write("success\n");
} else {
  reject();
}
PUBLISH_JOB_NODE
}

fetch_publish_job_outcome() {
  local run_id="$1"
  local run_attempt="$2"
  local provider_head_sha="$3"
  assert_positive_integer "$run_id"
  assert_positive_integer "$run_attempt"
  assert_sha "$provider_head_sha"
  local jobs_json="$work_directory/jobs-${run_id}-${run_attempt}.json"
  github_api \
    "/actions/runs/$run_id/attempts/$run_attempt/jobs?per_page=100&page=1" \
    "$jobs_json"
  publish_job_outcome "$jobs_json" "$run_id" "$provider_head_sha"
}

parse_deployed_state() {
  local path="$1"
  local -a lines=()
  mapfile -t lines <"$path"
  [[ "${#lines[@]}" -eq 10 ]] || fail
  [[ "${lines[0]}" == schema=2 ]] || fail
  [[ "${lines[1]}" =~ ^release_sha=([0-9a-f]{40})$ ]] || fail
  local release_sha="${BASH_REMATCH[1]}"
  [[ "${lines[2]}" =~ ^run_number=([1-9][0-9]*)$ ]] || fail
  local run_number="${BASH_REMATCH[1]}"
  [[ "${lines[3]}" =~ ^run_attempt=([1-9][0-9]*)$ ]] || fail
  local run_attempt="${BASH_REMATCH[1]}"
  [[ "${lines[4]}" =~ ^run_id=([1-9][0-9]*)$ ]] || fail
  local run_id="${BASH_REMATCH[1]}"
  [[ "${lines[5]}" =~ ^artifact_id=([1-9][0-9]*)$ ]] || fail
  local artifact_id="${BASH_REMATCH[1]}"
  [[ "${lines[6]}" =~ ^artifact_digest=([0-9a-f]{64})$ ]] || fail
  local artifact_digest="${BASH_REMATCH[1]}"
  [[ "${lines[7]}" =~ ^archive_sha=([0-9a-f]{64})$ ]] || fail
  local archive_sha="${BASH_REMATCH[1]}"
  [[ "${lines[8]}" =~ ^lock_sha=([0-9a-f]{64})$ ]] || fail
  local lock_sha="${BASH_REMATCH[1]}"
  [[ "${lines[9]}" =~ ^migration_head=([0-9]{14})$ ]] || fail
  local migration_head="${BASH_REMATCH[1]}"
  printf '%s %s %s %s %s %s %s %s %s\n' \
    "$release_sha" "$run_number" "$run_attempt" "$run_id" "$artifact_id" \
    "$artifact_digest" "$archive_sha" "$lock_sha" "$migration_head"
}

parse_manager_checkpoint() {
  local path="$1"
  local -a lines=()
  mapfile -t lines <"$path"
  if [[ "${#lines[@]}" -eq 1 && "${lines[0]}" == none ]]; then
    printf '%s\n' none
    return 0
  fi
  [[ "${#lines[@]}" -eq 10 ]] || fail
  [[ "${lines[0]}" == protocol=3 ]] || fail
  [[ "${lines[1]}" =~ ^release_sha=([0-9a-f]{40})$ ]] || fail
  local release_sha="${BASH_REMATCH[1]}"
  [[ "${lines[2]}" =~ ^archive_sha=([0-9a-f]{64})$ ]] || fail
  local archive_sha="${BASH_REMATCH[1]}"
  [[ "${lines[3]}" =~ ^lock_sha=([0-9a-f]{64})$ ]] || fail
  local lock_sha="${BASH_REMATCH[1]}"
  [[ "${lines[4]}" =~ ^migration_head=([0-9]{14})$ ]] || fail
  local migration_head="${BASH_REMATCH[1]}"
  [[ "${lines[5]}" =~ ^run_number=([1-9][0-9]*)$ ]] || fail
  local run_number="${BASH_REMATCH[1]}"
  [[ "${lines[6]}" =~ ^run_attempt=([1-9][0-9]*)$ ]] || fail
  local run_attempt="${BASH_REMATCH[1]}"
  [[ "${lines[7]}" =~ ^run_id=([1-9][0-9]*)$ ]] || fail
  local run_id="${BASH_REMATCH[1]}"
  [[ "${lines[8]}" =~ ^artifact_id=([1-9][0-9]*)$ ]] || fail
  local artifact_id="${BASH_REMATCH[1]}"
  [[ "${lines[9]}" =~ ^artifact_digest=([0-9a-f]{64})$ ]] || fail
  local artifact_digest="${BASH_REMATCH[1]}"
  assert_positive_integer "$run_number"
  assert_positive_integer "$run_attempt"
  assert_positive_integer "$run_id"
  assert_positive_integer "$artifact_id"
  printf '%s %s %s %s %s %s %s %s %s\n' \
    "$release_sha" "$run_number" "$run_attempt" "$run_id" "$artifact_id" \
    "$artifact_digest" "$archive_sha" "$lock_sha" "$migration_head"
}

load_deployed_state() {
  local manager_checkpoint="$1"
  checkpoint_release_sha=none
  checkpoint_source_run_number=0
  checkpoint_source_run_attempt=0
  checkpoint_source_run_id=0
  checkpoint_artifact_id=0
  checkpoint_artifact_digest=
  checkpoint_archive_sha=
  checkpoint_lock_sha=
  checkpoint_migration_head=none
  [[ -f "$manager_checkpoint" && ! -L "$manager_checkpoint" ]] || fail
  [[ "$(stat -c '%U:%G:%a:%h' -- "$manager_checkpoint")" \
    == "$deployer_user:$deployer_group:600:1" ]] || fail
  local authoritative
  authoritative="$(parse_manager_checkpoint "$manager_checkpoint")" || fail
  if [[ "$authoritative" == none ]]; then
    [[ ! -e "$deployed_state" && ! -L "$deployed_state" ]] || fail
    return 0
  fi

  local -a authoritative_fields=()
  read -r -a authoritative_fields <<<"$authoritative"
  [[ "${#authoritative_fields[@]}" -eq 9 ]] || fail
  if [[ -e "$deployed_state" || -L "$deployed_state" ]]; then
    [[ -f "$deployed_state" && ! -L "$deployed_state" ]] || fail
    [[ "$(readlink --canonicalize-existing -- "$deployed_state")" == "$deployed_state" ]] || fail
    [[ "$(stat -c '%U:%G:%a:%h' -- "$deployed_state")" \
      == "$deployer_user:$deployer_group:600:1" ]] || fail
    local local_checkpoint
    local_checkpoint="$(parse_deployed_state "$deployed_state")" || fail
    if [[ "$local_checkpoint" != "$authoritative" ]]; then
      write_deployed_state \
        "${authoritative_fields[0]}" "${authoritative_fields[1]}" \
        "${authoritative_fields[2]}" "${authoritative_fields[3]}" \
        "${authoritative_fields[4]}" "${authoritative_fields[5]}" \
        "${authoritative_fields[6]}" "${authoritative_fields[7]}" \
        "${authoritative_fields[8]}"
    fi
  else
    write_deployed_state \
      "${authoritative_fields[0]}" "${authoritative_fields[1]}" \
      "${authoritative_fields[2]}" "${authoritative_fields[3]}" \
      "${authoritative_fields[4]}" "${authoritative_fields[5]}" \
      "${authoritative_fields[6]}" "${authoritative_fields[7]}" \
      "${authoritative_fields[8]}"
  fi

  local parsed="$authoritative"
  read -r \
    checkpoint_release_sha \
    checkpoint_source_run_number \
    checkpoint_source_run_attempt \
    checkpoint_source_run_id \
    checkpoint_artifact_id \
    checkpoint_artifact_digest \
    checkpoint_archive_sha \
    checkpoint_lock_sha \
    checkpoint_migration_head <<<"$parsed"
  assert_positive_integer "$checkpoint_source_run_number"
  assert_positive_integer "$checkpoint_source_run_attempt"
  assert_positive_integer "$checkpoint_source_run_id"
  assert_positive_integer "$checkpoint_artifact_id"
  assert_checksum "$checkpoint_artifact_digest"
  assert_checksum "$checkpoint_archive_sha"
  assert_checksum "$checkpoint_lock_sha"
  [[ "$checkpoint_migration_head" =~ ^[0-9]{14}$ ]] || fail
}

parse_applied_schema_state() {
  local path="$1"
  node - "$path" <<'APPLIED_SCHEMA_NODE'
const fs = require("node:fs");

const [statePath] = process.argv.slice(2);
let serialized;
try {
  const bytes = fs.readFileSync(statePath);
  serialized = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
} catch {
  process.exit(1);
}
const match = /^schema=1\nmigration_head=(\d{14})\n$/.exec(serialized);
if (match === null) {
  process.exit(1);
}
process.stdout.write(`${match[1]}\n`);
APPLIED_SCHEMA_NODE
}

applied_schema_head() {
  local base_head="$1"
  [[ "$base_head" == none || "$base_head" =~ ^[0-9]{14}$ ]] || fail
  if [[ ! -e "$applied_schema_state" && ! -L "$applied_schema_state" ]]; then
    printf '%s\n' "$base_head"
    return 0
  fi
  assert_private_state_file "$applied_schema_state" "$maximum_applied_schema_bytes"
  local observed_head
  observed_head="$(parse_applied_schema_state "$applied_schema_state")" || fail
  [[ "$observed_head" =~ ^[0-9]{14}$ ]] || fail
  if [[ "$base_head" == none || "$observed_head" > "$base_head" ]]; then
    printf '%s\n' "$observed_head"
  else
    printf '%s\n' "$base_head"
  fi
}

write_applied_schema_state() {
  local migration_head="$1"
  [[ "$migration_head" =~ ^[0-9]{14}$ ]] || fail
  local current_head=none
  if [[ -e "$applied_schema_state" || -L "$applied_schema_state" ]]; then
    assert_private_state_file "$applied_schema_state" "$maximum_applied_schema_bytes"
    current_head="$(parse_applied_schema_state "$applied_schema_state")" || fail
    [[ "$current_head" =~ ^[0-9]{14}$ ]] || fail
    [[ "$migration_head" < "$current_head" ]] && fail
    [[ "$migration_head" == "$current_head" ]] && return 0
  fi

  [[ -n "$work_directory" && -d "$work_directory" && ! -L "$work_directory" ]] || fail
  [[ "$(stat -c '%d' -- "$work_directory")" == "$(stat -c '%d' -- "$state_base")" ]] || fail
  local candidate="$work_directory/applied-schema.state"
  [[ ! -e "$candidate" && ! -L "$candidate" ]] || fail
  printf '%s\n' 'schema=1' "migration_head=$migration_head" >"$candidate"
  chmod 0600 "$candidate"
  [[ "$(stat -c '%U:%G:%a:%h' -- "$candidate")" \
    == "$deployer_user:$deployer_group:600:1" ]] || fail
  [[ "$(stat -c '%s' -- "$candidate")" -le "$maximum_applied_schema_bytes" ]] || fail
  [[ "$(parse_applied_schema_state "$candidate")" == "$migration_head" ]] || fail
  sync -f "$candidate"
  mv -Tf -- "$candidate" "$applied_schema_state"
  sync -f "$state_base"
  assert_private_state_file "$applied_schema_state" "$maximum_applied_schema_bytes"
  [[ "$(parse_applied_schema_state "$applied_schema_state")" == "$migration_head" ]] || fail
}

assert_rejected_run_identity() {
  local release_sha="$1"
  local artifact_provider_run_number="$2"
  local artifact_provider_run_attempt="$3"
  local artifact_provider_run_id="$4"
  assert_sha "$release_sha"
  assert_positive_integer "$artifact_provider_run_number"
  assert_positive_integer "$artifact_provider_run_attempt"
  assert_positive_integer "$artifact_provider_run_id"
}

assert_rejected_artifact_identity() {
  local release_sha="$1"
  local artifact_provider_run_number="$2"
  local artifact_provider_run_attempt="$3"
  local artifact_provider_run_id="$4"
  local artifact_id="$5"
  local artifact_digest="$6"
  assert_rejected_run_identity \
    "$release_sha" \
    "$artifact_provider_run_number" \
    "$artifact_provider_run_attempt" \
    "$artifact_provider_run_id"
  assert_positive_integer "$artifact_id"
  assert_checksum "$artifact_digest"
}

parse_rejected_artifacts_state() {
  local path="$1"
  shift
  node - "$path" "$maximum_rejected_artifacts" "$@" <<'REJECTED_ARTIFACTS_NODE'
const fs = require("node:fs");

const [statePath, maximumRecordsText, operation, ...parameters] = process.argv.slice(2);
const positiveIntegerFragment = "[1-9][0-9]{0,18}";
const shaFragment = "[0-9a-f]{40}";
const digestFragment = "[0-9a-f]{64}";
const positiveInteger = new RegExp(`^${positiveIntegerFragment}$`);
const sha = new RegExp(`^${shaFragment}$`);
const recordPattern = new RegExp(
  `^(${shaFragment}) (${positiveIntegerFragment}) (${positiveIntegerFragment}) (${positiveIntegerFragment}) (${positiveIntegerFragment}) (${digestFragment}) ([0-9]{14})$`,
);
const maximumSignedInteger = 9223372036854775807n;

function reject() {
  process.exit(1);
}

function isPositiveSignedInteger(value) {
  return positiveInteger.test(value) && BigInt(value) <= maximumSignedInteger;
}

const maximumRecords = Number(maximumRecordsText);
if (!Number.isSafeInteger(maximumRecords) || maximumRecords < 1) {
  reject();
}
let durableQuery = null;
let checkpointHead = null;
if (operation === "identity-status") {
  const [releaseSha, runNumber, runAttempt, runId] = parameters;
  if (
    parameters.length !== 4 ||
    !sha.test(releaseSha ?? "") ||
    !isPositiveSignedInteger(runNumber ?? "") ||
    !isPositiveSignedInteger(runAttempt ?? "") ||
    !isPositiveSignedInteger(runId ?? "")
  ) {
    reject();
  }
  durableQuery = parameters.join(" ");
} else if (operation === "head") {
  if (
    parameters.length !== 1 ||
    !(parameters[0] === "none" || /^\d{14}$/.test(parameters[0] ?? ""))
  ) {
    reject();
  }
  checkpointHead = parameters[0];
} else {
  reject();
}

let serialized;
try {
  const bytes = fs.readFileSync(statePath);
  serialized = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
} catch {
  reject();
}
if (!serialized.endsWith("\n") || serialized.includes("\0")) {
  reject();
}
const lines = serialized.slice(0, -1).split("\n");
if (lines.shift() !== "schema=1" || lines.length > maximumRecords) {
  reject();
}

const seenDurableIdentities = new Set();
let matchedDurableRecord = null;
let effectiveMigrationHead = checkpointHead;
for (const line of lines) {
  const match = recordPattern.exec(line);
  const durableIdentity = match?.slice(1, 5).join(" ");
  if (
    match === null ||
    !match.slice(2, 6).every(isPositiveSignedInteger) ||
    seenDurableIdentities.has(durableIdentity)
  ) {
    reject();
  }
  seenDurableIdentities.add(durableIdentity);
  if (durableIdentity === durableQuery) {
    matchedDurableRecord = `${match[5]} ${match[6]} ${match[7]}`;
  }
  if (
    operation === "head" &&
    (effectiveMigrationHead === "none" || match[7] > effectiveMigrationHead)
  ) {
    effectiveMigrationHead = match[7];
  }
}
if (operation === "head") {
  process.stdout.write(`${effectiveMigrationHead}\n`);
} else {
  process.stdout.write(
    matchedDurableRecord === null ? "eligible\n" : `rejected ${matchedDurableRecord}\n`,
  );
}
REJECTED_ARTIFACTS_NODE
}

rejected_run_identity_status() {
  local release_sha="$1"
  local artifact_provider_run_number="$2"
  local artifact_provider_run_attempt="$3"
  local artifact_provider_run_id="$4"
  assert_rejected_run_identity \
    "$release_sha" \
    "$artifact_provider_run_number" \
    "$artifact_provider_run_attempt" \
    "$artifact_provider_run_id"
  if [[ ! -e "$rejected_artifacts_state" && ! -L "$rejected_artifacts_state" ]]; then
    printf '%s\n' eligible
    return 0
  fi
  assert_private_state_file "$rejected_artifacts_state" "$maximum_rejected_artifacts_bytes"
  parse_rejected_artifacts_state \
    "$rejected_artifacts_state" \
    identity-status \
    "$release_sha" \
    "$artifact_provider_run_number" \
    "$artifact_provider_run_attempt" \
    "$artifact_provider_run_id"
}

rejected_schema_head() {
  local checkpoint_head="$1"
  [[ "$checkpoint_head" == none || "$checkpoint_head" =~ ^[0-9]{14}$ ]] || fail
  if [[ ! -e "$rejected_artifacts_state" && ! -L "$rejected_artifacts_state" ]]; then
    printf '%s\n' "$checkpoint_head"
    return 0
  fi
  assert_private_state_file "$rejected_artifacts_state" "$maximum_rejected_artifacts_bytes"
  parse_rejected_artifacts_state "$rejected_artifacts_state" head "$checkpoint_head"
}

manager_activation_result() {
  local release_sha="$1"
  local payload
  local result
  local active_sha
  local extra
  assert_sha "$release_sha"
  payload="$(sudo -n "$dispatcher" activation-result "$release_sha")" || fail
  if [[ "$payload" == none ]]; then
    printf '%s\n' none
    return 0
  fi
  read -r result active_sha extra <<<"$payload"
  [[ -z "$extra" ]] || fail
  [[ "$result" == confirmed || "$result" == rejected ]] || fail
  assert_optional_sha "$active_sha"
  if [[ "$result" == confirmed ]]; then
    [[ "$active_sha" == "$release_sha" ]] || fail
  else
    [[ "$active_sha" != "$release_sha" ]] || fail
  fi
  printf '%s %s\n' "$result" "$active_sha"
}

record_rejected_artifact() {
  local release_sha="$1"
  local artifact_provider_run_number="$2"
  local artifact_provider_run_attempt="$3"
  local artifact_provider_run_id="$4"
  local artifact_id="$5"
  local artifact_digest="$6"
  local migration_head="$7"
  assert_rejected_artifact_identity \
    "$release_sha" \
    "$artifact_provider_run_number" \
    "$artifact_provider_run_attempt" \
    "$artifact_provider_run_id" \
    "$artifact_id" \
    "$artifact_digest"
  [[ "$migration_head" =~ ^[0-9]{14}$ ]] || fail
  local status
  status="$(rejected_run_identity_status \
    "$release_sha" \
    "$artifact_provider_run_number" \
    "$artifact_provider_run_attempt" \
    "$artifact_provider_run_id")" || fail
  case "$status" in
    "rejected $artifact_id $artifact_digest $migration_head") return 0 ;;
    rejected\ *) fail ;;
    eligible) ;;
    *) fail ;;
  esac

  [[ -n "$work_directory" && -d "$work_directory" && ! -L "$work_directory" ]] || fail
  [[ "$(stat -c '%d' -- "$work_directory")" == "$(stat -c '%d' -- "$state_base")" ]] || fail
  local candidate="$work_directory/rejected-artifacts.state"
  [[ ! -e "$candidate" && ! -L "$candidate" ]] || fail
  if [[ -e "$rejected_artifacts_state" || -L "$rejected_artifacts_state" ]]; then
    assert_private_state_file "$rejected_artifacts_state" "$maximum_rejected_artifacts_bytes"
    command cat -- "$rejected_artifacts_state" >"$candidate"
  else
    printf '%s\n' 'schema=1' >"$candidate"
  fi
  printf '%s %s %s %s %s %s %s\n' \
    "$release_sha" \
    "$artifact_provider_run_number" \
    "$artifact_provider_run_attempt" \
    "$artifact_provider_run_id" \
    "$artifact_id" \
    "$artifact_digest" \
    "$migration_head" \
    >>"$candidate"
  chmod 0600 "$candidate"
  [[ "$(stat -c '%U:%G:%a:%h' -- "$candidate")" \
    == "$deployer_user:$deployer_group:600:1" ]] || fail
  [[ "$(stat -c '%s' -- "$candidate")" -le "$maximum_rejected_artifacts_bytes" ]] || fail
  [[ "$(parse_rejected_artifacts_state \
    "$candidate" \
    identity-status \
    "$release_sha" \
    "$artifact_provider_run_number" \
    "$artifact_provider_run_attempt" \
    "$artifact_provider_run_id")" == "rejected $artifact_id $artifact_digest $migration_head" ]] || fail
  sync -f "$candidate"
  mv -Tf -- "$candidate" "$rejected_artifacts_state"
  sync -f "$state_base"
  assert_private_state_file "$rejected_artifacts_state" "$maximum_rejected_artifacts_bytes"
  [[ "$(rejected_run_identity_status \
    "$release_sha" \
    "$artifact_provider_run_number" \
    "$artifact_provider_run_attempt" \
    "$artifact_provider_run_id")" \
    == "rejected $artifact_id $artifact_digest $migration_head" ]] || fail
}

classify_forward_relation() {
  local current_sha="$1"
  local release_sha="$2"
  [[ "$current_sha" == none ]] && {
    printf '%s\n' ahead
    return 0
  }
  assert_sha "$current_sha"
  assert_sha "$release_sha"
  [[ "$current_sha" != "$release_sha" ]] || fail
  local compare_json="$work_directory/compare.json"
  github_api "/compare/${current_sha}...${release_sha}" "$compare_json"
  python3 - "$compare_json" "$current_sha" "$release_sha" <<'PY'
import json
import sys

path, current, target = sys.argv[1:]
with open(path, "r", encoding="utf-8") as source:
    payload = json.load(source)
base = payload.get("base_commit")
merge_base = payload.get("merge_base_commit")
head = payload.get("head_commit")
status = payload.get("status")
if (
    not isinstance(base, dict)
    or base.get("sha") != current
    or not isinstance(merge_base, dict)
    or not isinstance(head, dict)
    or head.get("sha") != target
):
    raise SystemExit(1)
if status == "ahead" and merge_base.get("sha") == current:
    print("ahead")
elif status == "behind" and merge_base.get("sha") == target:
    print("behind")
else:
    raise SystemExit(1)
PY
}

current_main_sha() {
  local reference_json="$work_directory/main-reference.json"
  github_api "/git/ref/heads/$branch" "$reference_json"
  python3 - "$reference_json" "$repository" <<'PY'
import json
import re
import sys

path, repository = sys.argv[1:]
with open(path, "r", encoding="utf-8") as source:
    payload = json.load(source)
target = payload.get("object")
sha = target.get("sha") if isinstance(target, dict) else None
if (
    payload.get("ref") != "refs/heads/main"
    or payload.get("url") != f"https://api.github.com/repos/{repository}/git/refs/heads/main"
    or not isinstance(target, dict)
    or target.get("type") != "commit"
    or re.fullmatch(r"[0-9a-f]{40}", sha or "") is None
):
    raise SystemExit(1)
print(sha)
PY
}

recovery_dispatch_decision() {
  local source_run_id="$1"
  local source_run_attempt="$2"
  local release_sha="$3"
  local archive_sha="$4"
  local public_build_config_sha="$5"
  local artifact_provider_updated_at="$6"
  local main_sha="$7"
  local expected_total="$8"
  shift 8
  [[ "$#" -ge 1 ]] || fail
  assert_nonnegative_integer "$expected_total"
  python3 - \
    "$repository" \
    "$ci_workflow" \
    "$expected_repository_id" \
    "$ci_github_workflow_id" \
    "$source_run_id" \
    "$source_run_attempt" \
    "$release_sha" \
    "$archive_sha" \
    "$public_build_config_sha" \
    "$artifact_provider_updated_at" \
    "$main_sha" \
    "$expected_total" \
    "$@" <<'PY'
import datetime
import json
import re
import sys

(
    repository,
    workflow,
    repository_id,
    workflow_id,
    source_run_id,
    source_run_attempt,
    release_sha,
    archive_sha,
    public_build_config_sha,
    artifact_provider_updated_at,
    main_sha,
    expected_total,
    *paths,
) = sys.argv[1:]
repository_id = int(repository_id)
workflow_id = int(workflow_id)
source_run_id = int(source_run_id)
source_run_attempt = int(source_run_attempt)
expected_total = int(expected_total)
if (
    not paths
    or expected_total < 0
    or re.fullmatch(r"[0-9a-f]{40}", release_sha) is None
    or re.fullmatch(r"[0-9a-f]{64}", archive_sha) is None
    or re.fullmatch(r"[0-9a-f]{64}", public_build_config_sha) is None
    or re.fullmatch(r"[0-9a-f]{40}", main_sha) is None
):
    raise SystemExit(1)

def parse_timestamp(value):
    if not isinstance(value, str):
        raise SystemExit(1)
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise SystemExit(1)
    if parsed.tzinfo is None:
        raise SystemExit(1)
    return parsed

artifact_provider_updated = parse_timestamp(artifact_provider_updated_at)
matches = []
seen = set()
seen_run_numbers = set()
observed_total = 0
title_pattern = re.compile(
    r"([0-9a-f]{40}) approved ([1-9][0-9]*)/([1-9][0-9]*) archive ([0-9a-f]{64}) config ([0-9a-f]{64})"
)
for path in paths:
    with open(path, "r", encoding="utf-8") as source:
        payload = json.load(source)
    runs = payload.get("workflow_runs")
    if payload.get("total_count") != expected_total or not isinstance(runs, list):
        raise SystemExit(1)
    observed_total += len(runs)
    for run in runs:
        if not isinstance(run, dict):
            raise SystemExit(1)
        identifier = run.get("id")
        run_number = run.get("run_number")
        run_attempt = run.get("run_attempt")
        head_repository = run.get("head_repository")
        run_repository = run.get("repository")
        title_match = title_pattern.fullmatch(run.get("display_title") or "")
        if (
            not isinstance(identifier, int)
            or isinstance(identifier, bool)
            or identifier <= 0
            or identifier in seen
            or not isinstance(run_number, int)
            or isinstance(run_number, bool)
            or run_number <= 0
            or run_number in seen_run_numbers
            or not isinstance(run_attempt, int)
            or isinstance(run_attempt, bool)
            or run_attempt <= 0
            or run.get("workflow_id") != workflow_id
            or run.get("path") != f".github/workflows/{workflow}"
            or run.get("event") != "workflow_dispatch"
            or run.get("head_branch") != "main"
            or not isinstance(head_repository, dict)
            or head_repository.get("id") != repository_id
            or head_repository.get("full_name") != repository
            or not isinstance(run_repository, dict)
            or run_repository.get("id") != repository_id
            or run_repository.get("full_name") != repository
            or title_match is None
        ):
            raise SystemExit(1)
        seen.add(identifier)
        seen_run_numbers.add(run_number)
        if (
            title_match.group(1) == release_sha
            and int(title_match.group(2)) == source_run_id
            and int(title_match.group(3)) == source_run_attempt
            and title_match.group(4) == archive_sha
            and title_match.group(5) == public_build_config_sha
        ):
            matches.append(run)

if observed_total != expected_total:
    raise SystemExit(1)

if not matches:
    if datetime.datetime.now(datetime.timezone.utc) - artifact_provider_updated <= datetime.timedelta(minutes=10):
        print("pending")
    else:
        print("dispatch")
    raise SystemExit(0)
latest = max(matches, key=lambda run: (run["run_number"], run["run_attempt"], run["id"]))
status = latest.get("status")
conclusion = latest.get("conclusion")
if status in {"queued", "in_progress", "pending", "requested", "waiting"} and conclusion is None:
    print("pending")
    raise SystemExit(0)
if status != "completed":
    raise SystemExit(1)
updated = parse_timestamp(latest.get("updated_at"))
if conclusion == "success":
    if updated <= artifact_provider_updated:
        print("dispatch")
    elif datetime.datetime.now(datetime.timezone.utc) - updated <= datetime.timedelta(minutes=30):
        print("pending")
    elif latest.get("head_sha") != main_sha:
        print("dispatch")
    else:
        print("blocked")
elif conclusion in {
    "action_required",
    "cancelled",
    "failure",
    "stale",
    "startup_failure",
    "timed_out",
}:
    print("dispatch" if latest.get("head_sha") != main_sha else "blocked")
else:
    raise SystemExit(1)
PY
}

request_artifact_recovery() {
  local source_run_id="$1"
  local source_run_attempt="$2"
  local release_sha="$3"
  local archive_sha="$4"
  local public_build_config_sha="$5"
  local artifact_provider_updated_at="$6"
  assert_positive_integer "$source_run_id"
  assert_positive_integer "$source_run_attempt"
  assert_sha "$release_sha"
  assert_checksum "$archive_sha"
  assert_checksum "$public_build_config_sha"
  [[ "$artifact_provider_updated_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]] || fail
  local main_sha
  main_sha="$(current_main_sha)" || fail
  assert_sha "$main_sha"
  local page_manifest
  page_manifest="$(fetch_workflow_run_pages \
    "/actions/workflows/$ci_github_workflow_id/runs?branch=$branch&event=workflow_dispatch" \
    recovery-runs \
    0)" || fail
  local -a manifest_lines=()
  mapfile -t manifest_lines <<<"$page_manifest" || fail
  [[ "${#manifest_lines[@]}" -ge 2 ]] || fail
  local expected_total="${manifest_lines[0]}"
  assert_nonnegative_integer "$expected_total"
  local -a recovery_page_paths=("${manifest_lines[@]:1}")
  local decision
  decision="$(recovery_dispatch_decision \
    "$source_run_id" \
    "$source_run_attempt" \
    "$release_sha" \
    "$archive_sha" \
    "$public_build_config_sha" \
    "$artifact_provider_updated_at" \
    "$main_sha" \
    "$expected_total" \
    "${recovery_page_paths[@]}")" || fail
  case "$decision" in
    pending)
      return 3
      ;;
    blocked)
      fail
      ;;
    dispatch) ;;
    *) fail ;;
  esac

  local request_body="$work_directory/recovery-request.json"
  local response_body="$work_directory/recovery-response.json"
  local response_status="$work_directory/recovery-response.status"
  python3 - \
    "$request_body" \
    "$release_sha" \
    "$source_run_id" \
    "$source_run_attempt" \
    "$archive_sha" \
    "$public_build_config_sha" <<'PY'
import json
import os
import sys

(
    path,
    release_sha,
    source_run_id,
    source_run_attempt,
    archive_sha,
    public_build_config_sha,
) = sys.argv[1:]
descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(descriptor, "w", encoding="utf-8") as destination:
    json.dump(
        {
            "ref": "main",
            "inputs": {
                "release_sha": release_sha,
                "approved_run_id": source_run_id,
                "approved_run_attempt": source_run_attempt,
                "archive_sha256": archive_sha,
                "public_build_config_sha256": public_build_config_sha,
            },
        },
        destination,
        ensure_ascii=True,
        separators=(",", ":"),
    )
    destination.write("\n")
PY
  github_api_post \
    "/actions/workflows/$ci_github_workflow_id/dispatches" \
    "$request_body" \
    "$response_body" \
    "$response_status"
  return 3
}

select_artifact() {
  local current_sha="$1"
  local effective_migration_head
  effective_migration_head="$(rejected_schema_head "$checkpoint_migration_head")" || fail
  effective_migration_head="$(applied_schema_head "$effective_migration_head")" || fail
  [[ "$effective_migration_head" == none || "$effective_migration_head" =~ ^[0-9]{14}$ ]] || fail
  if [[ "$checkpoint_migration_head" != none \
    && "$effective_migration_head" < "$checkpoint_migration_head" ]]; then
    fail
  fi
  local candidates_file="$work_directory/candidates"
  fetch_candidate_runs "$candidates_file"
  local source_run_number
  local source_run_attempt
  local source_run_id
  local source_head_sha
  local release_sha
  local artifact_provider_run_number
  local artifact_provider_run_attempt
  local artifact_provider_run_id
  local artifact_provider_head_sha
  local artifact_provider_updated_at
  local artifact_provider_kind
  local provider_archive_sha
  local provider_public_build_config_sha
  local extra
  while read -r \
    source_run_number \
    source_run_attempt \
    source_run_id \
    source_head_sha \
    release_sha \
    artifact_provider_run_number \
    artifact_provider_run_attempt \
    artifact_provider_run_id \
    artifact_provider_head_sha \
    artifact_provider_updated_at \
    artifact_provider_kind \
    provider_archive_sha \
    provider_public_build_config_sha \
    extra; do
    [[ -n "$source_run_number" && -n "$source_run_attempt" && -n "$source_run_id" \
      && -n "$source_head_sha" && -n "$release_sha" && -n "$artifact_provider_run_number" \
      && -n "$artifact_provider_run_attempt" && -n "$artifact_provider_run_id" \
      && -n "$artifact_provider_head_sha" && -n "$artifact_provider_updated_at" \
      && -n "$artifact_provider_kind" && -n "$provider_archive_sha" \
      && -n "$provider_public_build_config_sha" && -z "$extra" ]] || fail
    assert_positive_integer "$source_run_number"
    assert_positive_integer "$source_run_attempt"
    assert_positive_integer "$source_run_id"
    assert_sha "$source_head_sha"
    assert_sha "$release_sha"
    assert_positive_integer "$artifact_provider_run_number"
    assert_positive_integer "$artifact_provider_run_attempt"
    assert_positive_integer "$artifact_provider_run_id"
    assert_sha "$artifact_provider_head_sha"
    [[ "$artifact_provider_updated_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]] || fail
    [[ "$artifact_provider_kind" == normal || "$artifact_provider_kind" == recovery ]] || fail
    if [[ "$artifact_provider_kind" == normal ]]; then
      [[ "$provider_archive_sha" == none && "$provider_public_build_config_sha" == none ]] || fail
    else
      assert_checksum "$provider_archive_sha"
      assert_checksum "$provider_public_build_config_sha"
    fi
    if [[ "$current_sha" != none && "$release_sha" == "$current_sha" ]]; then
      continue
    fi
    local relation
    relation="$(classify_forward_relation "$current_sha" "$release_sha")" || fail
    if [[ "$relation" == behind ]]; then
      continue
    fi
    [[ "$relation" == ahead ]] || fail
    local root_activation_result
    root_activation_result="$(manager_activation_result "$release_sha")" || fail
    case "$root_activation_result" in
      none) ;;
      confirmed\ * | rejected\ *) continue ;;
      *) fail ;;
    esac
    local rejection_status
    rejection_status="$(rejected_run_identity_status \
      "$release_sha" \
      "$artifact_provider_run_number" \
      "$artifact_provider_run_attempt" \
      "$artifact_provider_run_id")" || fail
    case "$rejection_status" in
      rejected\ *)
        local rejection_marker
        local rejected_artifact_id
        local rejected_artifact_digest
        local rejected_migration_head
        local rejection_extra
        read -r \
          rejection_marker rejected_artifact_id rejected_artifact_digest \
          rejected_migration_head rejection_extra <<<"$rejection_status"
        [[ "$rejection_marker" == rejected && -z "$rejection_extra" ]] || fail
        assert_positive_integer "$rejected_artifact_id"
        assert_checksum "$rejected_artifact_digest"
        [[ "$rejected_migration_head" =~ ^[0-9]{14}$ ]] || fail
        if [[ "$effective_migration_head" == none \
          || "$rejected_migration_head" > "$effective_migration_head" ]]; then
          fail
        fi
        continue
        ;;
      eligible) ;;
      *) fail ;;
    esac
    local source_archive_sha="$provider_archive_sha"
    local source_public_build_config_sha="$provider_public_build_config_sha"
    if [[ "$artifact_provider_kind" == recovery ]]; then
      local source_artifacts_metadata="$work_directory/artifacts-$source_run_id-source.metadata"
      local source_metadata
      fetch_artifact_metadata \
        "$source_run_id" \
        "$release_sha" \
        "$source_head_sha" \
        "$source_artifacts_metadata"
      source_metadata="$(<"$source_artifacts_metadata")" || fail
      local -a source_metadata_lines=()
      mapfile -t source_metadata_lines <<<"$source_metadata" || fail
      case "${source_metadata_lines[0]:-}" in
        missing-artifact) fail ;;
        expired-artifact)
          [[ "${#source_metadata_lines[@]}" -eq 3 ]] || fail
          source_archive_sha="${source_metadata_lines[1]}"
          source_public_build_config_sha="${source_metadata_lines[2]}"
          ;;
        *)
          [[ "${#source_metadata_lines[@]}" -eq 5 ]] || fail
          source_archive_sha="${source_metadata_lines[3]}"
          source_public_build_config_sha="${source_metadata_lines[4]}"
          ;;
      esac
      assert_checksum "$source_archive_sha"
      assert_checksum "$source_public_build_config_sha"
      [[ "$source_archive_sha" == "$provider_archive_sha" ]] || fail
      [[ "$source_public_build_config_sha" == "$provider_public_build_config_sha" ]] || fail
    fi

    local artifacts_metadata="$work_directory/artifacts-$artifact_provider_run_id.metadata"
    local metadata
    fetch_artifact_metadata \
      "$artifact_provider_run_id" \
      "$release_sha" \
      "$artifact_provider_head_sha" \
      "$artifacts_metadata"
    metadata="$(<"$artifacts_metadata")" || fail
    local -a metadata_lines=()
    mapfile -t metadata_lines <<<"$metadata" || fail
    if [[ "${metadata_lines[0]:-}" == missing-artifact ]]; then
      local publish_outcome
      publish_outcome="$(fetch_publish_job_outcome \
        "$artifact_provider_run_id" \
        "$artifact_provider_run_attempt" \
        "$artifact_provider_head_sha")" || fail
      if [[ "$publish_outcome" == skipped ]]; then
        [[ "$artifact_provider_kind" == normal ]] || fail
        continue
      fi
      fail
    fi
    if [[ "${metadata_lines[0]:-}" == expired-artifact ]]; then
      [[ "${#metadata_lines[@]}" -eq 3 ]] || fail
      local expired_archive_sha="${metadata_lines[1]}"
      local expired_public_build_config_sha="${metadata_lines[2]}"
      assert_checksum "$expired_archive_sha"
      assert_checksum "$expired_public_build_config_sha"
      if [[ "$artifact_provider_kind" == recovery ]]; then
        [[ "$expired_archive_sha" == "$source_archive_sha" ]] || fail
        [[ "$expired_public_build_config_sha" == "$source_public_build_config_sha" ]] || fail
      else
        source_archive_sha="$expired_archive_sha"
        source_public_build_config_sha="$expired_public_build_config_sha"
      fi
      local publish_outcome
      publish_outcome="$(fetch_publish_job_outcome \
        "$artifact_provider_run_id" \
        "$artifact_provider_run_attempt" \
        "$artifact_provider_head_sha")" || fail
      [[ "$publish_outcome" == success ]] || fail
      if request_artifact_recovery \
        "$source_run_id" \
        "$source_run_attempt" \
        "$release_sha" \
        "$source_archive_sha" \
        "$source_public_build_config_sha" \
        "$artifact_provider_updated_at"; then
        fail
      else
        local recovery_status=$?
        [[ "$recovery_status" -eq 3 ]] || fail
        return 3
      fi
    fi
    [[ "${#metadata_lines[@]}" -eq 5 ]] || fail
    local artifact_id
    local artifact_digest
    local artifact_size
    artifact_id="${metadata_lines[0]}"
    artifact_digest="${metadata_lines[1]}"
    artifact_size="${metadata_lines[2]}"
    local expected_archive_sha="${metadata_lines[3]}"
    local expected_public_build_config_sha="${metadata_lines[4]}"
    assert_positive_integer "$artifact_id"
    assert_checksum "$artifact_digest"
    assert_positive_integer "$artifact_size"
    assert_checksum "$expected_archive_sha"
    assert_checksum "$expected_public_build_config_sha"
    if [[ "$artifact_provider_kind" == recovery ]]; then
      [[ "$expected_archive_sha" == "$source_archive_sha" ]] || fail
      [[ "$expected_public_build_config_sha" == "$source_public_build_config_sha" ]] || fail
    fi
    printf '%s %s %s %s %s %s %s %s %s %s %s %s %s\n' \
      "$source_run_number" \
      "$source_run_attempt" \
      "$source_run_id" \
      "$release_sha" \
      "$artifact_provider_run_number" \
      "$artifact_provider_run_attempt" \
      "$artifact_provider_run_id" \
      "$artifact_id" \
      "$artifact_digest" \
      "$artifact_size" \
      "$expected_archive_sha" \
      "$expected_public_build_config_sha" \
      "$effective_migration_head"
    return 0
  done <"$candidates_file"
  return 2
}

extract_verified_zip() {
  local zip_path="$1"
  local release_sha="$2"
  local destination="$3"
  python3 - "$zip_path" "$release_sha" "$destination" "$maximum_expanded_bytes" <<'PY'
import os
import stat
import sys
import zipfile

path, sha, destination, maximum = sys.argv[1:]
maximum = int(maximum)
archive_name = f"set-livre-{sha}.tar.gz"
expected = {archive_name, f"{archive_name}.sha256"}
seen = set()
expanded = 0
with zipfile.ZipFile(path) as archive:
    members = archive.infolist()
    if len(members) != 2:
        raise SystemExit(1)
    for member in members:
        name = member.filename
        if name not in expected or name in seen or "/" in name or "\\" in name or "\x00" in name:
            raise SystemExit(1)
        seen.add(name)
        mode = (member.external_attr >> 16) & 0xFFFF
        kind = stat.S_IFMT(mode)
        if member.is_dir() or (kind not in (0, stat.S_IFREG)) or member.flag_bits & 1:
            raise SystemExit(1)
        expanded += member.file_size
        if expanded > maximum or member.compress_size == 0 and member.file_size != 0:
            raise SystemExit(1)
        if member.compress_size and member.file_size / member.compress_size > 200:
            raise SystemExit(1)
        target = os.path.join(destination, name)
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as output, archive.open(member, "r") as source:
            while chunk := source.read(1024 * 1024):
                output.write(chunk)
if seen != expected:
    raise SystemExit(1)
PY
}

validate_tar_archive() {
  local archive_path="$1"
  python3 - "$archive_path" "$maximum_entries" "$maximum_expanded_bytes" <<'PY'
import posixpath
import sys
import tarfile
from pathlib import PurePosixPath

path, maximum_entries, maximum_bytes = sys.argv[1:]
maximum_entries = int(maximum_entries)
maximum_bytes = int(maximum_bytes)
seen = set()
expanded = 0
with tarfile.open(path, mode="r:gz") as archive:
    for index, member in enumerate(archive, start=1):
        if index > maximum_entries:
            raise SystemExit(1)
        raw = member.name
        if not raw or "\\" in raw or "\x00" in raw:
            raise SystemExit(1)
        candidate = PurePosixPath(raw)
        normalized = posixpath.normpath(raw)
        parts = PurePosixPath(normalized).parts
        if candidate.is_absolute() or ".." in candidate.parts or not parts or parts[0] != "release":
            raise SystemExit(1)
        if normalized in seen or member.mode & 0o7000:
            raise SystemExit(1)
        seen.add(normalized)
        if not (member.isfile() or member.isdir()):
            raise SystemExit(1)
        if normalized == "release" and not member.isdir():
            raise SystemExit(1)
        if member.isfile():
            expanded += member.size
            if expanded > maximum_bytes:
                raise SystemExit(1)
if "release" not in seen:
    raise SystemExit(1)
print(expanded)
PY
}

verify_sidecar() {
  local archive_path="$1"
  local sidecar_path="$2"
  local expected_archive_sha="$3"
  local expected_name="$4"
  assert_checksum "$expected_archive_sha"
  [[ "$(file_sha256 "$archive_path")" == "$expected_archive_sha" ]] || fail
  python3 - "$sidecar_path" "$expected_archive_sha" "$expected_name" <<'PY'
import re
import sys

path, digest, basename = sys.argv[1:]
with open(path, "rb") as source:
    value = source.read()
expected = f"{digest}  {basename}\n".encode()
if value != expected or re.fullmatch(rb"[0-9a-f]{64}  [A-Za-z0-9.-]+\n", value) is None:
    raise SystemExit(1)
PY
}

authorization_contract_node() {
  node - "$@" <<'AUTHORIZATION_CONTRACT_NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");

const [command, ...args] = process.argv.slice(2);
const maximumFacts = 100000;
const maximumIdentityParts = 4;
const maximumStringLength = 65536;
const objectTypes = new Set([
  "column",
  "database",
  "defaultPrivilege",
  "foreignDataWrapper",
  "foreignServer",
  "foreignTable",
  "language",
  "largeObject",
  "materializedView",
  "parameter",
  "partitionedTable",
  "routine",
  "schema",
  "sequence",
  "table",
  "tablespace",
  "type",
  "view",
]);
const privileges = new Set([
  "ALTER SYSTEM",
  "CONNECT",
  "CREATE",
  "DELETE",
  "EXECUTE",
  "INSERT",
  "MAINTAIN",
  "REFERENCES",
  "SELECT",
  "SET",
  "TEMPORARY",
  "TRIGGER",
  "TRUNCATE",
  "UPDATE",
  "USAGE",
]);
const policyCommands = new Set(["ALL", "DELETE", "INSERT", "SELECT", "UPDATE"]);
const runtimeGrantees = new Set([
  "PUBLIC",
  "anon",
  "authenticated",
  "service_role",
  "app_dal",
  "app_runtime",
  "app_runtime_local",
  "app_runtime_prod",
]);

function reject() {
  process.exit(1);
}

function exactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonicalString(value) {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.includes("\0") ||
    value.length > maximumStringLength
  ) reject();
  return value;
}

function canonicalObject(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumIdentityParts) reject();
  return value.map(canonicalString);
}

function canonicalFact(fact) {
  if (fact?.kind === "relation") {
    if (!exactKeys(fact, ["kind", "objectType", "object"]) || !objectTypes.has(fact.objectType)) {
      reject();
    }
    return { kind: "relation", objectType: fact.objectType, object: canonicalObject(fact.object) };
  }
  if (fact?.kind === "relationSecurity") {
    if (
      !exactKeys(fact, ["kind", "objectType", "object", "rowSecurity", "forceRowSecurity"]) ||
      !objectTypes.has(fact.objectType) ||
      typeof fact.rowSecurity !== "boolean" ||
      typeof fact.forceRowSecurity !== "boolean"
    ) reject();
    return {
      kind: "relationSecurity",
      objectType: fact.objectType,
      object: canonicalObject(fact.object),
      rowSecurity: fact.rowSecurity,
      forceRowSecurity: fact.forceRowSecurity,
    };
  }
  if (fact?.kind === "policy") {
    if (
      !exactKeys(fact, [
        "kind",
        "objectType",
        "object",
        "name",
        "command",
        "permissive",
        "roles",
        "using",
        "withCheck",
      ]) ||
      fact.objectType !== "table" ||
      !policyCommands.has(fact.command) ||
      typeof fact.permissive !== "boolean" ||
      !Array.isArray(fact.roles) ||
      fact.roles.length === 0 ||
      fact.roles.length > 1000 ||
      !(fact.using === null || typeof fact.using === "string") ||
      !(fact.withCheck === null || typeof fact.withCheck === "string")
    ) reject();
    const roles = fact.roles.map(canonicalString);
    if (new Set(roles).size !== roles.length || JSON.stringify(roles) !== JSON.stringify([...roles].sort())) {
      reject();
    }
    return {
      kind: "policy",
      objectType: "table",
      object: canonicalObject(fact.object),
      name: canonicalString(fact.name),
      command: fact.command,
      permissive: fact.permissive,
      roles,
      using: fact.using === null ? null : canonicalString(fact.using),
      withCheck: fact.withCheck === null ? null : canonicalString(fact.withCheck),
    };
  }
  if (fact?.kind === "privilege") {
    if (
      !exactKeys(fact, [
        "kind",
        "objectType",
        "object",
        "grantor",
        "grantee",
        "privilege",
        "grantable",
      ]) ||
      !objectTypes.has(fact.objectType) ||
      !privileges.has(fact.privilege) ||
      typeof fact.grantable !== "boolean"
    ) reject();
    return {
      kind: "privilege",
      objectType: fact.objectType,
      object: canonicalObject(fact.object),
      grantor: canonicalString(fact.grantor),
      grantee: canonicalString(fact.grantee),
      privilege: fact.privilege,
      grantable: fact.grantable,
    };
  }
  reject();
}

function canonicalFacts(facts) {
  if (!Array.isArray(facts) || facts.length > maximumFacts) reject();
  const canonical = facts.map(canonicalFact);
  canonical.sort((left, right) => {
    const a = JSON.stringify(left);
    const b = JSON.stringify(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const serialized = canonical.map((fact) => JSON.stringify(fact));
  if (new Set(serialized).size !== serialized.length) reject();
  return canonical;
}

function forbiddenAddition(fact) {
  if (fact.kind === "policy") {
    const publicRole = fact.roles.includes("PUBLIC") || fact.roles.includes("anon");
    return publicRole && ["ALL", "DELETE", "INSERT", "UPDATE"].includes(fact.command);
  }
  if (fact.kind !== "privilege") return false;
  const runtime = runtimeGrantees.has(fact.grantee);
  if (runtime && fact.grantable) return true;
  if (
    runtime &&
    ["table", "partitionedTable", "foreignTable", "view", "materializedView", "column"].includes(
      fact.objectType,
    ) &&
    ["DELETE", "INSERT", "MAINTAIN", "REFERENCES", "TRIGGER", "TRUNCATE", "UPDATE"].includes(
      fact.privilege,
    ) &&
    (fact.grantee === "PUBLIC" || fact.grantee === "anon")
  ) return true;
  if (
    runtime &&
    fact.objectType === "largeObject" &&
    fact.privilege === "UPDATE" &&
    (fact.grantee === "PUBLIC" || fact.grantee === "anon")
  ) return true;
  if (
    runtime &&
    ["schema", "tablespace"].includes(fact.objectType) &&
    fact.privilege === "CREATE"
  ) return true;
  return (
    runtime &&
    fact.objectType === "database" &&
    ["CREATE", "TEMPORARY"].includes(fact.privilege)
  );
}

function incrementalPayload(contract) {
  return {
    contractVersion: 1,
    catalogVersion: 1,
    catalogPath: "supabase/authorization-catalog.sql",
    catalogSha256: contract.catalogSha256,
    releaseCommit: contract.releaseCommit,
    previousHead: contract.previousHead,
    head: contract.head,
    additions: contract.additions,
    removals: contract.removals,
    approvedAdditions: contract.approvedAdditions,
  };
}

function baselinePayload(contract) {
  return {
    contractVersion: 1,
    catalogVersion: 1,
    catalogPath: "supabase/authorization-catalog.sql",
    catalogSha256: contract.catalogSha256,
    releaseCommit: contract.releaseCommit,
    previousHead: "none",
    head: contract.head,
    additions: contract.additions,
    removals: contract.removals,
    approvedAdditions: contract.approvedAdditions,
  };
}

function canonicalizeContractFacts(contract, payloadFactory) {
  const additions = canonicalFacts(contract.additions);
  const removals = canonicalFacts(contract.removals);
  const approvedAdditions = canonicalFacts(contract.approvedAdditions);
  if (
    JSON.stringify(additions) !== JSON.stringify(contract.additions) ||
    JSON.stringify(removals) !== JSON.stringify(contract.removals) ||
    JSON.stringify(approvedAdditions) !== JSON.stringify(contract.approvedAdditions) ||
    additions.some(forbiddenAddition) ||
    JSON.stringify(approvedAdditions) !==
      JSON.stringify(additions.filter((fact) => fact.kind === "policy" || fact.kind === "privilege"))
  ) reject();
  const canonical = { ...contract, additions, removals, approvedAdditions };
  const digest = crypto.createHash("sha256").update(JSON.stringify(payloadFactory(canonical))).digest("hex");
  if (digest !== contract.sha256) reject();
  return canonical;
}

function readContract(manifestPath, contractPath, expectedCatalogSha256) {
  let manifest;
  let contract;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  } catch {
    reject();
  }
  if (
    !exactKeys(contract, [
      "contractVersion",
      "catalogVersion",
      "catalogPath",
      "catalogSha256",
      "releaseCommit",
      "previousHead",
      "head",
      "additions",
      "removals",
      "approvedAdditions",
      "sha256",
    ]) ||
    contract.contractVersion !== 1 ||
    contract.catalogVersion !== 1 ||
    contract.catalogPath !== "supabase/authorization-catalog.sql" ||
    contract.catalogSha256 !== expectedCatalogSha256 ||
    !/^[a-f0-9]{40}$/.test(contract.releaseCommit ?? "") ||
    contract.releaseCommit !== manifest?.commit ||
    !/^\d{14}$/.test(contract.previousHead ?? "") ||
    !/^\d{14}$/.test(contract.head ?? "") ||
    contract.head !== manifest?.migrations?.head ||
    contract.previousHead >= contract.head ||
    !/^[a-f0-9]{64}$/.test(contract.sha256 ?? "")
  ) reject();
  return canonicalizeContractFacts(contract, incrementalPayload);
}

function readBaselineContract(
  manifestPath,
  contractPath,
  expectedCatalogSha256,
) {
  let manifest;
  let contract;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  } catch {
    reject();
  }
  if (
    !exactKeys(contract, [
      "contractVersion",
      "catalogVersion",
      "catalogPath",
      "catalogSha256",
      "releaseCommit",
      "previousHead",
      "head",
      "additions",
      "removals",
      "approvedAdditions",
      "sha256",
    ]) ||
    contract.contractVersion !== 1 ||
    contract.catalogVersion !== 1 ||
    contract.catalogPath !== "supabase/authorization-catalog.sql" ||
    contract.catalogSha256 !== expectedCatalogSha256 ||
    !/^[a-f0-9]{40}$/.test(contract.releaseCommit ?? "") ||
    contract.releaseCommit !== manifest?.commit ||
    contract.previousHead !== "none" ||
    !/^\d{14}$/.test(contract.head ?? "") ||
    contract.head !== manifest?.migrations?.head ||
    !/^[a-f0-9]{64}$/.test(contract.sha256 ?? "")
  ) reject();
  return canonicalizeContractFacts(contract, baselinePayload);
}

function authorizationHeadPayload(contract) {
  return {
    releaseCommit: contract.releaseCommit,
    head: contract.head,
    catalogPath: "supabase/authorization-catalog.sql",
    catalogSha256: contract.catalogSha256,
    facts: contract.facts,
  };
}

function readAuthorizationHead(manifestPath, contractPath, expectedCatalogSha256) {
  let manifest;
  let contract;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  } catch {
    reject();
  }
  if (
    !exactKeys(contract, [
      "releaseCommit",
      "head",
      "catalogPath",
      "catalogSha256",
      "facts",
      "sha256",
    ]) ||
    !/^[a-f0-9]{40}$/.test(contract.releaseCommit ?? "") ||
    contract.releaseCommit !== manifest?.commit ||
    !/^\d{14}$/.test(contract.head ?? "") ||
    contract.head !== manifest?.migrations?.head ||
    contract.catalogPath !== "supabase/authorization-catalog.sql" ||
    contract.catalogSha256 !== expectedCatalogSha256 ||
    !/^[a-f0-9]{64}$/.test(contract.sha256 ?? "")
  ) reject();
  const facts = canonicalFacts(contract.facts);
  if (
    JSON.stringify(facts) !== JSON.stringify(contract.facts) ||
    facts.some(forbiddenAddition)
  ) reject();
  const canonical = { ...contract, facts };
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify(authorizationHeadPayload(canonical)))
    .digest("hex");
  if (digest !== contract.sha256) reject();
  return canonical;
}

function readSnapshot(path) {
  let serialized;
  try {
    serialized = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(path));
  } catch {
    reject();
  }
  if (serialized.includes("\0") || (serialized !== "" && !serialized.endsWith("\n"))) reject();
  const lines = serialized === "" ? [] : serialized.slice(0, -1).split("\n");
  let facts;
  try {
    facts = lines.map((line) => JSON.parse(line));
  } catch {
    reject();
  }
  return canonicalFacts(facts);
}

function writeSnapshot(path, facts) {
  const serialized = facts.map((fact) => JSON.stringify(fact)).join("\n");
  fs.writeFileSync(path, serialized === "" ? "" : `${serialized}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function semanticDelta(before, after) {
  const beforeSet = new Set(before.map((fact) => JSON.stringify(fact)));
  const afterSet = new Set(after.map((fact) => JSON.stringify(fact)));
  const additions = after.filter((fact) => !beforeSet.has(JSON.stringify(fact)));
  const removals = before.filter((fact) => !afterSet.has(JSON.stringify(fact)));
  const afterRelations = new Set(
    after
      .filter((fact) => fact.kind === "relation")
      .map((fact) => JSON.stringify([fact.objectType, fact.object])),
  );
  if (
    removals.some(
      (fact) =>
        fact.kind === "relationSecurity" &&
        (fact.rowSecurity || fact.forceRowSecurity) &&
        afterRelations.has(JSON.stringify([fact.objectType, fact.object])),
    ) ||
    additions.some(forbiddenAddition)
  ) reject();
  return { additions, removals };
}

function writeAuthorizationState(
  contractKind,
  contract,
  snapshotPath,
  outputPath,
) {
  const state = {
    schemaVersion: 3,
    contractKind,
    contractSha256: contract.sha256,
    previousHead: contract.previousHead,
    head: contract.head,
    facts: readSnapshot(snapshotPath),
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(state)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function readAuthorizationState(
  contractKind,
  contract,
  statePath,
  outputPath,
) {
  let state;
  try {
    const serialized = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(statePath));
    if (!serialized.endsWith("\n") || serialized.includes("\0")) reject();
    state = JSON.parse(serialized);
  } catch {
    reject();
  }
  if (
    !exactKeys(state, [
      "schemaVersion",
      "contractKind",
      "contractSha256",
      "previousHead",
      "head",
      "facts",
    ]) ||
    state.schemaVersion !== 3 ||
    state.contractKind !== contractKind ||
    state.contractSha256 !== contract.sha256 ||
    state.previousHead !== contract.previousHead ||
    state.head !== contract.head
  ) reject();
  const facts = canonicalFacts(state.facts);
  if (JSON.stringify(facts) !== JSON.stringify(state.facts)) reject();
  writeSnapshot(outputPath, facts);
}

if (command === "release-contracts" && args.length === 5) {
  const [manifestPath, incrementalPath, baselinePath, headPath, expectedCatalogSha256] = args;
  const incremental = readContract(manifestPath, incrementalPath, expectedCatalogSha256);
  const baseline = readBaselineContract(manifestPath, baselinePath, expectedCatalogSha256);
  const head = readAuthorizationHead(manifestPath, headPath, expectedCatalogSha256);
  if (
    incremental.head !== baseline.head ||
    incremental.head !== head.head ||
    JSON.stringify(baseline.additions) !== JSON.stringify(head.facts)
  ) reject();
  process.stdout.write(
    `${incremental.previousHead} ${incremental.head} ${incremental.sha256}\n`,
  );
} else if (command === "manifest" && args.length === 3) {
  const contract = readContract(args[0], args[1], args[2]);
  process.stdout.write(`${contract.previousHead} ${contract.head} ${contract.sha256}\n`);
} else if (command === "compare" && args.length === 7) {
  const [
    manifestPath,
    contractPath,
    expectedCatalogSha256,
    beforePath,
    afterPath,
    previousHead,
    head,
  ] = args;
  const contract = readContract(manifestPath, contractPath, expectedCatalogSha256);
  if (contract.previousHead !== previousHead || contract.head !== head) reject();
  const actual = semanticDelta(readSnapshot(beforePath), readSnapshot(afterPath));
  if (
    JSON.stringify(actual.additions) !== JSON.stringify(contract.additions) ||
    JSON.stringify(actual.removals) !== JSON.stringify(contract.removals)
  ) reject();
} else if (command === "write-state" && args.length === 5) {
  const [
    manifestPath,
    contractPath,
    expectedCatalogSha256,
    snapshotPath,
    outputPath,
  ] = args;
  const contract = readContract(manifestPath, contractPath, expectedCatalogSha256);
  writeAuthorizationState(
    "incremental",
    contract,
    snapshotPath,
    outputPath,
  );
} else if (command === "read-state" && args.length === 5) {
  const [
    manifestPath,
    contractPath,
    expectedCatalogSha256,
    statePath,
    outputPath,
  ] = args;
  const contract = readContract(manifestPath, contractPath, expectedCatalogSha256);
  readAuthorizationState(
    "incremental",
    contract,
    statePath,
    outputPath,
  );
} else if (command === "baseline-manifest" && args.length === 3) {
  const contract = readBaselineContract(...args);
  process.stdout.write(`${contract.previousHead} ${contract.head} ${contract.sha256}\n`);
} else if (command === "baseline-compare" && args.length === 6) {
  const [
    manifestPath,
    contractPath,
    expectedCatalogSha256,
    beforePath,
    afterPath,
    head,
  ] = args;
  const contract = readBaselineContract(
    manifestPath,
    contractPath,
    expectedCatalogSha256,
  );
  if (contract.head !== head) reject();
  const before = readSnapshot(beforePath);
  if (before.length !== 0) reject();
  const actual = semanticDelta(before, readSnapshot(afterPath));
  if (
    JSON.stringify(actual.additions) !== JSON.stringify(contract.additions) ||
    JSON.stringify(actual.removals) !== JSON.stringify(contract.removals)
  ) reject();
} else if (command === "baseline-write-state" && args.length === 5) {
  const [
    manifestPath,
    contractPath,
    expectedCatalogSha256,
    snapshotPath,
    outputPath,
  ] = args;
  const contract = readBaselineContract(
    manifestPath,
    contractPath,
    expectedCatalogSha256,
  );
  writeAuthorizationState(
    "baseline",
    contract,
    snapshotPath,
    outputPath,
  );
} else if (command === "baseline-read-state" && args.length === 5) {
  const [
    manifestPath,
    contractPath,
    expectedCatalogSha256,
    statePath,
    outputPath,
  ] = args;
  const contract = readBaselineContract(
    manifestPath,
    contractPath,
    expectedCatalogSha256,
  );
  readAuthorizationState(
    "baseline",
    contract,
    statePath,
    outputPath,
  );
} else if (command === "head-manifest" && args.length === 3) {
  const contract = readAuthorizationHead(...args);
  process.stdout.write(`${contract.head} ${contract.sha256}\n`);
} else if (command === "head-compare" && args.length === 4) {
  const [manifestPath, contractPath, expectedCatalogSha256, snapshotPath] = args;
  const contract = readAuthorizationHead(
    manifestPath,
    contractPath,
    expectedCatalogSha256,
  );
  if (JSON.stringify(readSnapshot(snapshotPath)) !== JSON.stringify(contract.facts)) reject();
} else if (command === "state-metadata" && args.length === 1) {
  let state;
  try {
    const serialized = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(args[0]));
    if (!serialized.endsWith("\n") || serialized.includes("\0")) reject();
    state = JSON.parse(serialized);
  } catch {
    reject();
  }
  if (
    !exactKeys(state, [
      "schemaVersion",
      "contractKind",
      "contractSha256",
      "previousHead",
      "head",
      "facts",
    ]) ||
    state.schemaVersion !== 3 ||
    !["baseline", "incremental"].includes(state.contractKind) ||
    !/^[a-f0-9]{64}$/.test(state.contractSha256 ?? "") ||
    !/^(none|\d{14})$/.test(state.previousHead ?? "") ||
    !/^\d{14}$/.test(state.head ?? "") ||
    (state.contractKind === "baseline" && state.previousHead !== "none") ||
    (state.contractKind === "incremental" && !/^\d{14}$/.test(state.previousHead))
  ) reject();
  const facts = canonicalFacts(state.facts);
  if (JSON.stringify(facts) !== JSON.stringify(state.facts)) reject();
  process.stdout.write(
    `${state.contractKind} ${state.previousHead} ${state.head}\n`,
  );
} else if (command === "snapshot-equal" && args.length === 2) {
  if (JSON.stringify(readSnapshot(args[0])) !== JSON.stringify(readSnapshot(args[1]))) reject();
} else {
  reject();
}
AUTHORIZATION_CONTRACT_NODE
}

validate_release_tree() {
  local release_root="$1"
  local release_sha="$2"
  local expected_public_build_config_sha256="$3"
  [[ "$#" -eq 3 || "$#" -eq 7 ]] || fail
  assert_checksum "$expected_public_build_config_sha256"
  assert_checksum "$expected_authorization_catalog_sha256"
  local -a public_build_configuration=()
  if [[ "$#" -eq 7 ]]; then
    public_build_configuration=("$4" "$5" "$6" "$7")
  fi
  python3 - \
    "$release_root" \
    "$release_sha" \
    "$expected_node_version" \
    "$expected_public_build_config_sha256" \
    "${public_build_configuration[@]}" <<'PY'
import hashlib
import json
import os
import re
import stat
import sys

arguments = sys.argv[1:]
if len(arguments) not in (4, 8):
    raise SystemExit(1)
(
    root,
    commit,
    node_version,
    expected_public_build_config_sha256,
    *public_build_configuration,
) = arguments
if public_build_configuration:
    configuration = dict(
        zip(
            (
                "backofficeAppUrl",
                "publicAppUrl",
                "supabaseAnonKey",
                "supabaseUrl",
            ),
            public_build_configuration,
            strict=True,
        )
    )
    if any(not value for value in configuration.values()):
        raise SystemExit(1)
    serialized_configuration = json.dumps(
        configuration,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    if (
        hashlib.sha256(serialized_configuration).hexdigest()
        != expected_public_build_config_sha256
    ):
        raise SystemExit(1)
root = os.path.realpath(root)
for directory, directories, files in os.walk(root, followlinks=False):
    for name in directories + files:
        path = os.path.join(directory, name)
        information = os.lstat(path)
        if stat.S_ISLNK(information.st_mode) or (
            not stat.S_ISDIR(information.st_mode) and not stat.S_ISREG(information.st_mode)
        ):
            raise SystemExit(1)
        if stat.S_ISREG(information.st_mode) and information.st_nlink != 1:
            raise SystemExit(1)
manifest_path = os.path.join(root, "manifest.json")
lock_path = os.path.join(root, "package-lock.json")
config_path = os.path.join(root, "supabase", "config.toml")
roles_path = os.path.join(root, "supabase", "roles.sql")
authorization_catalog_path = os.path.join(root, "supabase", "authorization-catalog.sql")
authorization_contract_path = os.path.join(root, "supabase", "authorization-contract.json")
baseline_authorization_contract_path = os.path.join(
    root,
    "supabase",
    "baseline-authorization-contract.json",
)
authorization_head_path = os.path.join(root, "supabase", "authorization-head.json")
for path in (
    manifest_path,
    lock_path,
    config_path,
    roles_path,
    authorization_catalog_path,
    authorization_contract_path,
    baseline_authorization_contract_path,
    authorization_head_path,
):
    if not os.path.isfile(path) or os.path.islink(path):
        raise SystemExit(1)
with open(manifest_path, "r", encoding="utf-8") as source:
    manifest = json.load(source)
if (
    manifest.get("schemaVersion") != 4
    or manifest.get("commit") != commit
    or manifest.get("runtime") != {"arch": "x64", "platform": "linux", "node": node_version}
    or re.fullmatch(r"[0-9a-f]{64}", str(manifest.get("publicBuildConfigSha256", ""))) is None
    or manifest.get("publicBuildConfigSha256") != expected_public_build_config_sha256
):
    raise SystemExit(1)
applications = manifest.get("applications")
if applications != {
    "web": {"entrypoint": "web/server.js", "port": 3000},
    "backoffice": {"entrypoint": "backoffice/apps/backoffice/server.js", "port": 3001},
}:
    raise SystemExit(1)
migrations = manifest.get("migrations")
lockfile = manifest.get("lockfile")
if (
    not isinstance(migrations, dict)
    or set(migrations) != {"directory", "head", "mode"}
    or migrations.get("directory") != "supabase/migrations"
    or re.fullmatch(r"[0-9]{14}", str(migrations.get("head", ""))) is None
    or migrations.get("mode") != "expand-only"
    or not isinstance(lockfile, dict)
    or lockfile.get("path") != "package-lock.json"
    or re.fullmatch(r"[0-9a-f]{64}", str(lockfile.get("sha256", ""))) is None
):
    raise SystemExit(1)
if set(manifest) != {
    "schemaVersion",
    "commit",
    "runtime",
    "applications",
    "migrations",
    "lockfile",
    "publicBuildConfigSha256",
}:
    raise SystemExit(1)
try:
    with open(lock_path, "rb") as source:
        lock_bytes = source.read()
except OSError:
    raise SystemExit(1)
if hashlib.sha256(lock_bytes).hexdigest() != lockfile["sha256"]:
    raise SystemExit(1)
migrations_path = os.path.join(root, "supabase", "migrations")
if not os.path.isdir(migrations_path) or os.path.islink(migrations_path):
    raise SystemExit(1)
versions = []
for entry in os.scandir(migrations_path):
    information = os.stat(entry.path, follow_symlinks=False)
    match = re.fullmatch(r"([0-9]{14})_[A-Za-z0-9_]+\.sql", entry.name)
    if not entry.is_file(follow_symlinks=False) or information.st_nlink != 1 or match is None:
        raise SystemExit(1)
    versions.append(match.group(1))
if not versions or len(versions) != len(set(versions)) or max(versions) != migrations["head"]:
    raise SystemExit(1)
sys.stdout.buffer.write(f'{migrations["head"]}\n{lockfile["sha256"]}\n'.encode("ascii"))
PY
}

assert_release_contract() {
  local release_root="$1"
  local release_sha="$2"
  local published_public_build_config_sha256="$3"
  assert_checksum "$published_public_build_config_sha256"
  local authorization_catalog="$release_root/supabase/authorization-catalog.sql"
  local authorization_contract="$release_root/$authorization_contract_relative_path"
  local baseline_authorization_contract="$release_root/$baseline_authorization_contract_relative_path"
  local authorization_head="$release_root/$authorization_head_relative_path"
  [[ -f "$authorization_catalog" && ! -L "$authorization_catalog" ]] || fail
  [[ -f "$authorization_contract" && ! -L "$authorization_contract" ]] || fail
  [[ -f "$baseline_authorization_contract" && ! -L "$baseline_authorization_contract" ]] || fail
  [[ -f "$authorization_head" && ! -L "$authorization_head" ]] || fail
  local metadata
  metadata="$(validate_release_tree \
    "$release_root" \
    "$release_sha" \
    "$published_public_build_config_sha256" \
    "$backoffice_app_url" \
    "$public_app_url" \
    "$supabase_anon_key" \
    "$supabase_url")" || fail
  local -a metadata_lines=()
  mapfile -t metadata_lines <<<"$metadata" || fail
  [[ "${#metadata_lines[@]}" -eq 2 ]] || fail
  local migration_head
  local lock_sha
  migration_head="${metadata_lines[0]}"
  lock_sha="${metadata_lines[1]}"
  [[ "$migration_head" =~ ^[0-9]{14}$ ]] || fail
  assert_checksum "$lock_sha"
  [[ "$(stat -c '%h' -- "$authorization_catalog")" == 1 ]] || fail
  [[ "$(stat -c '%h' -- "$authorization_contract")" == 1 ]] || fail
  [[ "$(stat -c '%h' -- "$baseline_authorization_contract")" == 1 ]] || fail
  [[ "$(stat -c '%h' -- "$authorization_head")" == 1 ]] || fail
  [[ "$(file_sha256 "$authorization_catalog")" \
    == "$expected_authorization_catalog_sha256" ]] || fail
  local authorization_metadata
  authorization_metadata="$(authorization_contract_node \
    release-contracts \
    "$release_root/manifest.json" \
    "$authorization_contract" \
    "$baseline_authorization_contract" \
    "$authorization_head" \
    "$expected_authorization_catalog_sha256")" || fail
  [[ "$authorization_metadata" =~ ^[0-9]{14}\ [0-9]{14}\ [0-9a-f]{64}$ ]] || fail
  local authorization_previous_head
  local authorization_head
  local authorization_sha
  read -r authorization_previous_head authorization_head authorization_sha \
    <<<"$authorization_metadata"
  [[ "$authorization_previous_head" < "$authorization_head" ]] || fail
  [[ "$authorization_head" == "$migration_head" ]] || fail
  assert_checksum "$authorization_sha"
  printf '%s %s\n' "$migration_head" "$lock_sha"
}

assert_expand_only_delta() {
  local release_root="$1"
  local migration_head="$2"
  local previous_head="$3"
  [[ "$migration_head" =~ ^[0-9]{14}$ ]] || fail
  [[ "$previous_head" =~ ^[0-9]{14}$ ]] || fail
  node - "$release_root/supabase/migrations" "$migration_head" "$previous_head" <<'EXPAND_ONLY_NODE'
const fs = require("node:fs");
const path = require("node:path");

const [directory, expectedHead, previousHead] = process.argv.slice(2);
const migrationName = /^(\d{14})_[A-Za-z0-9_]+\.sql$/;
const marker = "-- set-livre:migration-mode=expand-only";

function reject() {
  process.exit(1);
}

if (
  !directory ||
  !/^\d{14}$/.test(expectedHead ?? "") ||
  !/^\d{14}$/.test(previousHead ?? "")
) {
  reject();
}

let entries;
try {
  entries = fs.readdirSync(directory, { withFileTypes: true });
} catch {
  reject();
}

const migrations = [];
const versions = new Set();
for (const entry of entries) {
  const match = migrationName.exec(entry.name);
  if (!entry.isFile() || match === null || versions.has(match[1])) {
    reject();
  }
  versions.add(match[1]);
  migrations.push({ name: entry.name, version: match[1] });
}
migrations.sort((left, right) => left.version.localeCompare(right.version));
if (migrations.length === 0 || migrations.at(-1).version !== expectedHead) {
  reject();
}

const previousIndex = migrations.findIndex(({ version }) => version === previousHead);
const expectedIndex = migrations.findIndex(({ version }) => version === expectedHead);
if (previousIndex < 0 || expectedIndex < previousIndex) {
  reject();
}

function stripQuotedAndCommentedSql(sql) {
  let output = "";
  let index = 0;
  while (index < sql.length) {
    if (sql.startsWith("--", index)) {
      const newline = sql.indexOf("\n", index + 2);
      if (newline < 0) {
        return output;
      }
      output += "\n";
      index = newline + 1;
      continue;
    }
    if (sql.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql.startsWith("/*", index)) {
          depth += 1;
          index += 2;
        } else if (sql.startsWith("*/", index)) {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      if (depth !== 0) {
        reject();
      }
      output += " ";
      continue;
    }
    if (sql[index] === "'" || sql[index] === '"') {
      const quote = sql[index];
      const quoteStart = index;
      const backslashEscapes =
        quote === "'" &&
        quoteStart > 0 &&
        /[Ee]/.test(sql[quoteStart - 1]) &&
        (quoteStart < 2 || !/[A-Za-z0-9_$]/.test(sql[quoteStart - 2]));
      let closed = false;
      index += 1;
      while (index < sql.length) {
        if (backslashEscapes && sql[index] === "\\") {
          index += 2;
        } else if (sql[index] === quote && sql[index + 1] === quote) {
          index += 2;
        } else if (sql[index] === quote) {
          index += 1;
          closed = true;
          break;
        } else {
          index += 1;
        }
      }
      if (!closed) {
        reject();
      }
      output += " ";
      continue;
    }
    if (sql[index] === "$") {
      const delimiterMatch = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index));
      if (delimiterMatch !== null) {
        const delimiter = delimiterMatch[0];
        const end = sql.indexOf(delimiter, index + delimiter.length);
        if (end < 0) {
          reject();
        }
        index = end + delimiter.length;
        output += " ";
        continue;
      }
    }
    output += sql[index];
    index += 1;
  }
  return output;
}

const managedRlsAclBlock = [
  "do $managed_rls_acl$",
  "begin",
  "  if pg_catalog.to_regprocedure('public.rls_auto_enable()') is not null then",
  "    revoke all on function public.rls_auto_enable()",
  "      from public, anon, authenticated, service_role, app_dal;",
  "  end if;",
  "end",
  "$managed_rls_acl$;",
].join("\n");
const managedRlsAclSentinel = "SELECT SET_LIVRE_OPTIONAL_MANAGED_RLS_ACL";
let managedRlsAclBlockCount = 0;
const deltaStatements = [];
for (const migration of migrations.slice(previousIndex + 1, expectedIndex + 1)) {
  let sql;
  try {
    sql = fs.readFileSync(path.join(directory, migration.name), "utf8");
  } catch {
    reject();
  }
  if (!(sql.startsWith(`${marker}\n`) || sql.startsWith(`${marker}\r\n`))) {
    reject();
  }
  sql = sql.replaceAll("\r\n", "\n");
  if (sql.includes("\r") || sql.includes(managedRlsAclSentinel)) {
    reject();
  }
  const managedRlsAclParts = sql.split(managedRlsAclBlock);
  managedRlsAclBlockCount += managedRlsAclParts.length - 1;
  if (managedRlsAclBlockCount > 1) {
    reject();
  }
  sql = managedRlsAclParts.join(`${managedRlsAclSentinel};`);
  const statements = stripQuotedAndCommentedSql(sql)
    .split(";")
    .map((statement) => statement.replace(/\s+/g, " ").trim().toUpperCase())
    .filter(Boolean);
  deltaStatements.push(...statements);
}

const identifier = "[A-Z_][A-Z0-9_$]*";
const qualifiedIdentifier = `${identifier}(?:\\.${identifier})?`;
const typeModifier = "(?:\\s*\\(\\s*[0-9]+(?:\\s*,\\s*[0-9]+)?\\s*\\))?";
const arraySuffix = "(?:\\s*\\[\\s*\\])*";
const dataType = [
  `(?:${qualifiedIdentifier})${typeModifier}`,
  "DOUBLE\\s+PRECISION",
  `CHARACTER\\s+VARYING${typeModifier}`,
  `BIT\\s+VARYING${typeModifier}`,
  `TIMESTAMP${typeModifier}\\s+(?:WITH|WITHOUT)\\s+TIME\\s+ZONE`,
  `TIME${typeModifier}\\s+(?:WITH|WITHOUT)\\s+TIME\\s+ZONE`,
].join("|");
const createTablePattern = new RegExp(
  `^CREATE\\s+(?:UNLOGGED\\s+)?TABLE\\s+(${qualifiedIdentifier})\\s*\\([\\s\\S]*\\)$`,
);
const alterTablePattern = new RegExp(
  `^ALTER\\s+TABLE\\s+(?:ONLY\\s+)?(${qualifiedIdentifier})\\b`,
);
const nullableColumnPattern = new RegExp(
  `^ADD\\s+(?:COLUMN\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?${identifier}\\s+(?:${dataType})${arraySuffix}$`,
);
const notValidConstraintPattern = new RegExp(
  `^ADD\\s+CONSTRAINT\\s+${identifier}\\s+(?:CHECK\\b|FOREIGN\\s+KEY\\b)[\\s\\S]+\\bNOT\\s+VALID$`,
);
const newTableConstraintPattern = new RegExp(
  `^ADD\\s+CONSTRAINT\\s+${identifier}\\s+(?:CHECK\\b|FOREIGN\\s+KEY\\b|PRIMARY\\s+KEY\\b|UNIQUE\\b|EXCLUDE\\b)[\\s\\S]+$`,
);
const validateConstraintPattern = new RegExp(
  `^VALIDATE\\s+CONSTRAINT\\s+${identifier}$`,
);
const grantPrivilege =
  "(?:CONNECT|CREATE|DELETE|EXECUTE|INSERT|REFERENCES|SELECT|TEMPORARY|TRIGGER|UPDATE|USAGE)" +
  "(?:\\s*\\([^)]*\\))?";
const grantPattern = new RegExp(
  `^GRANT\\s+${grantPrivilege}(?:\\s*,\\s*${grantPrivilege})*\\s+ON\\s+[\\s\\S]+\\s+TO\\s+${identifier}(?:\\s*,\\s*${identifier})*$`,
);
const readinessReplacementPattern =
  /^CREATE\s+OR\s+REPLACE\s+FUNCTION\s+PRIVATE\.CHECK_READINESS\s*\(\s*EXPECTED_VERSION\s+TEXT\s*\)\s+RETURNS\s+BOOLEAN\s+LANGUAGE\s+SQL\s+STABLE\s+SECURITY\s+DEFINER\s+SET\s+SEARCH_PATH\s*=\s+AS$/;
const exactSecurityAclRevocations = new Set([
  "REVOKE ALL ON FUNCTION PRIVATE.CHECK_READINESS(TEXT) FROM PUBLIC, ANON, AUTHENTICATED, SERVICE_ROLE, APP_DAL",
]);

function hasBalancedParentheses(value) {
  let depth = 0;
  for (const character of value) {
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function hasTopLevelComma(value) {
  let depth = 0;
  for (const character of value) {
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth < 0) reject();
    } else if (character === "," && depth === 0) {
      return true;
    }
  }
  if (depth !== 0) reject();
  return false;
}

const createdTables = new Set();
for (const statement of deltaStatements) {
  const createdTable = createTablePattern.exec(statement);
  if (createdTable !== null) {
    if (!hasBalancedParentheses(statement) || createdTables.has(createdTable[1])) {
      reject();
    }
    createdTables.add(createdTable[1]);
  }
}

for (const statement of deltaStatements) {
  if (!hasBalancedParentheses(statement)) {
    reject();
  }
  if (createTablePattern.test(statement)) {
    continue;
  }
  if (new RegExp(`^CREATE\\s+SCHEMA\\s+${qualifiedIdentifier}$`).test(statement)) {
    continue;
  }
  if (new RegExp(`^CREATE\\s+SEQUENCE\\s+${qualifiedIdentifier}(?:\\s+[\\s\\S]+)?$`).test(statement)) {
    continue;
  }
  if (
    new RegExp(
      `^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?${qualifiedIdentifier}\\s+ON\\s+(?:ONLY\\s+)?${qualifiedIdentifier}\\b[\\s\\S]+$`,
    ).test(statement)
  ) {
    continue;
  }
  if (
    new RegExp(`^CREATE\\s+(?:FUNCTION|PROCEDURE)\\s+${qualifiedIdentifier}\\s*\\(`).test(
      statement,
    )
  ) {
    continue;
  }
  if (
    new RegExp(`^CREATE\\s+VIEW\\s+${qualifiedIdentifier}\\s+AS\\s+[\\s\\S]+$`).test(
      statement,
    ) &&
    !/\b(?:DELETE|INSERT|MERGE|UPDATE)\b/.test(statement)
  ) {
    continue;
  }
  if (
    new RegExp(`^CREATE\\s+POLICY\\s+${identifier}\\s+ON\\s+${qualifiedIdentifier}\\b[\\s\\S]+$`).test(
      statement,
    )
  ) {
    continue;
  }
  if (
    /^COMMENT\s+ON\s+(?:COLUMN|CONSTRAINT|FUNCTION|INDEX|POLICY|PROCEDURE|SCHEMA|SEQUENCE|TABLE|TRIGGER|VIEW)\b[\s\S]+\s+IS(?:\s+NULL)?$/.test(
      statement,
    )
  ) {
    continue;
  }
  if (grantPattern.test(statement)) {
    continue;
  }
  if (readinessReplacementPattern.test(statement)) {
    continue;
  }
  if (statement === managedRlsAclSentinel) {
    continue;
  }
  if (exactSecurityAclRevocations.has(statement)) {
    continue;
  }
  const createdTrigger = new RegExp(
    `^CREATE\\s+(?:CONSTRAINT\\s+)?TRIGGER\\s+${identifier}\\b[\\s\\S]+\\sON\\s+(?:ONLY\\s+)?(${qualifiedIdentifier})\\b[\\s\\S]+$`,
  ).exec(statement);
  if (createdTrigger !== null) {
    if (!createdTables.has(createdTrigger[1])) {
      reject();
    }
    continue;
  }
  if (/^ALTER\s+TABLE\b/.test(statement)) {
    const alteredTable = alterTablePattern.exec(statement);
    if (alteredTable === null) {
      reject();
    }
    const operation = statement.slice(alteredTable[0].length).trimStart();
    if (operation.length === 0 || hasTopLevelComma(operation)) {
      reject();
    }
    const altersTableCreatedByDelta =
      createdTables.has(alteredTable[1]);
    if (altersTableCreatedByDelta) {
      if (
        /^(?:ENABLE|FORCE)\s+ROW\s+LEVEL\s+SECURITY$/.test(operation) ||
        nullableColumnPattern.test(operation) ||
        newTableConstraintPattern.test(operation) ||
        validateConstraintPattern.test(operation)
      ) {
        continue;
      }
    } else if (
      nullableColumnPattern.test(operation) ||
      notValidConstraintPattern.test(operation) ||
      validateConstraintPattern.test(operation)
    ) {
      continue;
    }
    reject();
  }
  reject();
}
EXPAND_ONLY_NODE
}

assert_remote_migration_preflight() {
  local migration_output="$1"
  local migrations_directory="$2"
  local migration_head="$3"
  local previous_head="$4"
  node - \
    "$migration_output" \
    "$migrations_directory" \
    "$migration_head" \
    "$previous_head" <<'REMOTE_MIGRATIONS_PREFLIGHT_NODE'
const fs = require("node:fs");

const [outputPath, migrationsDirectory, expectedHead, previousHead] = process.argv.slice(2);
const migrationName = /^(\d{14})_[A-Za-z0-9_]+\.sql$/;

function reject() {
  process.exit(1);
}

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function formattedTime(version) {
  return [
    `${version.slice(0, 4)}-${version.slice(4, 6)}-${version.slice(6, 8)}`,
    `${version.slice(8, 10)}:${version.slice(10, 12)}:${version.slice(12, 14)}`,
  ].join(" ");
}

if (
  !/^\d{14}$/.test(expectedHead ?? "") ||
  !(previousHead === "none" || /^\d{14}$/.test(previousHead ?? ""))
) {
  reject();
}

let entries;
let payload;
try {
  entries = fs.readdirSync(migrationsDirectory, { withFileTypes: true });
  const bytes = fs.readFileSync(outputPath);
  const serialized = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  payload = JSON.parse(serialized);
} catch {
  reject();
}

const versions = [];
const seen = new Set();
for (const entry of entries) {
  const match = migrationName.exec(entry.name);
  if (!entry.isFile() || match === null || seen.has(match[1])) {
    reject();
  }
  seen.add(match[1]);
  versions.push(match[1]);
}
versions.sort();
if (versions.length === 0 || versions.at(-1) !== expectedHead) {
  reject();
}
const previousIndex = previousHead === "none" ? -1 : versions.indexOf(previousHead);
if (previousHead !== "none" && (previousIndex < 0 || previousIndex >= versions.length)) {
  reject();
}

if (
  !hasExactKeys(payload, ["message", "migrations"]) ||
  payload.message !== "Migrations listed" ||
  !Array.isArray(payload.migrations) ||
  payload.migrations.length !== versions.length
) {
  reject();
}

let encounteredLocalOnly = false;
const remoteVersions = [];
for (const [index, version] of versions.entries()) {
  const row = payload.migrations[index];
  if (
    !hasExactKeys(row, ["local", "remote", "time"]) ||
    row.local !== version ||
    row.time !== formattedTime(version) ||
    !(row.remote === "" || row.remote === version)
  ) {
    reject();
  }
  if (row.remote === "") {
    encounteredLocalOnly = true;
  } else {
    if (encounteredLocalOnly) {
      reject();
    }
    remoteVersions.push(row.remote);
  }
}

const remoteIsExactComplete =
  remoteVersions.length === versions.length &&
  remoteVersions.every((version, index) => version === versions[index]);
if (remoteIsExactComplete) {
  process.stdout.write(previousHead === expectedHead ? "already-current\n" : "post-push-resume\n");
} else if (previousHead === expectedHead) {
  reject();
} else {
  const minimumPrefixLength = previousHead === "none" ? 0 : previousIndex + 1;
  if (remoteVersions.length < minimumPrefixLength) {
    reject();
  }
  if (previousHead === "none") {
    process.stdout.write(remoteVersions.length === 0 ? "baseline\n" : "baseline-resume\n");
  } else {
    process.stdout.write(
      remoteVersions.length === minimumPrefixLength ? "incremental\n" : "incremental-resume\n",
    );
  }
}
REMOTE_MIGRATIONS_PREFLIGHT_NODE
}

assert_remote_migration_history() {
  local migration_output="$1"
  local migrations_directory="$2"
  local migration_head="$3"
  node - "$migration_output" "$migrations_directory" "$migration_head" <<'REMOTE_MIGRATIONS_NODE'
const fs = require("node:fs");

const [outputPath, migrationsDirectory, expectedHead] = process.argv.slice(2);
const migrationName = /^(\d{14})_[A-Za-z0-9_]+\.sql$/;

function reject() {
  process.exit(1);
}

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function formattedTime(version) {
  return [
    `${version.slice(0, 4)}-${version.slice(4, 6)}-${version.slice(6, 8)}`,
    `${version.slice(8, 10)}:${version.slice(10, 12)}:${version.slice(12, 14)}`,
  ].join(" ");
}

if (!/^\d{14}$/.test(expectedHead ?? "")) {
  reject();
}

let entries;
let payload;
try {
  entries = fs.readdirSync(migrationsDirectory, { withFileTypes: true });
  const bytes = fs.readFileSync(outputPath);
  const serialized = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  payload = JSON.parse(serialized);
} catch {
  reject();
}

const versions = [];
const seen = new Set();
for (const entry of entries) {
  const match = migrationName.exec(entry.name);
  if (!entry.isFile() || match === null || seen.has(match[1])) {
    reject();
  }
  seen.add(match[1]);
  versions.push(match[1]);
}
versions.sort();
if (versions.length === 0 || versions.at(-1) !== expectedHead) {
  reject();
}

if (
  !hasExactKeys(payload, ["message", "migrations"]) ||
  payload.message !== "Migrations listed" ||
  !Array.isArray(payload.migrations) ||
  payload.migrations.length !== versions.length
) {
  reject();
}

for (const [index, version] of versions.entries()) {
  const row = payload.migrations[index];
  if (
    !hasExactKeys(row, ["local", "remote", "time"]) ||
    row.local !== version ||
    row.remote !== version ||
    row.time !== formattedTime(version)
  ) {
    reject();
  }
}
REMOTE_MIGRATIONS_NODE
}

read_database_connection() {
  local connection_pipe="$work_directory/database-connection.pipe"
  [[ ! -e "$connection_pipe" && ! -L "$connection_pipe" ]] || fail
  mkfifo -m 0600 -- "$connection_pipe" || fail
  (
    DATABASE_URL="$database_url" python3 - "$supabase_project_ref" >"$connection_pipe" <<'PY'
import os
import re
import sys
from urllib.parse import parse_qs, unquote, urlsplit

expected_project_ref = sys.argv[1]
raw_database_url = os.environ["DATABASE_URL"]
if any(character.isspace() or character in "'\"\\" for character in raw_database_url):
    raise SystemExit(1)
parsed = urlsplit(raw_database_url)
if (
    parsed.scheme not in {"postgres", "postgresql"}
    or parsed.hostname is None
    or parsed.username is None
    or parsed.password is None
    or parsed.path != "/postgres"
    or parsed.fragment
    or (parsed.port or 5432) != 5432
):
    raise SystemExit(1)
query = parse_qs(parsed.query, keep_blank_values=True, strict_parsing=True)
if set(query) != {"options"} or any(len(values) != 1 for values in query.values()):
    raise SystemExit(1)
options = query["options"][0]
if options != "-c role=app_dal":
    raise SystemExit(1)
hostname = parsed.hostname.lower()
username = unquote(parsed.username)
direct_host = f"db.{expected_project_ref}.supabase.co"
pooler_host = re.fullmatch(r"[a-z0-9-]+\.pooler\.supabase\.com", hostname) is not None
if not (
    (hostname == direct_host and username == "app_runtime_prod")
    or (pooler_host and username == f"app_runtime_prod.{expected_project_ref}")
):
    raise SystemExit(1)
admin_username = "postgres" if hostname == direct_host else f"postgres.{expected_project_ref}"
values = [
    hostname,
    "5432",
    username,
    unquote(parsed.password),
    unquote(parsed.path[1:]),
    unquote(options),
    admin_username,
]
for value in values:
    if not value or "\x00" in value or "\n" in value or "\r" in value:
        raise SystemExit(1)
    sys.stdout.buffer.write(value.encode() + b"\x00")
PY
  ) &
  local parser_pid=$!
  local read_status=0
  mapfile -d '' -t database_connection <"$connection_pipe" || read_status=$?
  local parser_status=0
  wait "$parser_pid" || parser_status=$?
  rm -f -- "$connection_pipe" || fail
  sync -f "$work_directory" || fail
  [[ "$read_status" -eq 0 && "$parser_status" -eq 0 ]] || fail
  [[ "${#database_connection[@]}" -eq 7 ]] || fail
}

run_database_psql() {
  local -a database_connection=()
  read_database_connection
  export PGHOST="${database_connection[0]}" PGPORT="${database_connection[1]}"
  export PGUSER="${database_connection[2]}" PGPASSWORD="${database_connection[3]}"
  export PGDATABASE="${database_connection[4]}" PGOPTIONS="${database_connection[5]}"
  export PGSSLMODE=verify-full PGSSLROOTCERT="$supabase_server_ca_path" PGCONNECT_TIMEOUT=15
  local status=0
  psql -X --no-psqlrc --set=ON_ERROR_STOP=1 "$@" || status=$?
  unset PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGOPTIONS
  unset PGSSLMODE PGSSLROOTCERT PGCONNECT_TIMEOUT
  return "$status"
}

run_admin_psql() {
  local -a database_connection=()
  read_database_connection
  export PGHOST="${database_connection[0]}" PGPORT="${database_connection[1]}"
  export PGUSER="${database_connection[6]}" PGPASSWORD="$supabase_db_password"
  export PGDATABASE="${database_connection[4]}"
  export PGSSLMODE=verify-full PGSSLROOTCERT="$supabase_server_ca_path" PGCONNECT_TIMEOUT=15
  local status=0
  psql -X --no-psqlrc --set=ON_ERROR_STOP=1 "$@" || status=$?
  unset PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
  unset PGSSLMODE PGSSLROOTCERT PGCONNECT_TIMEOUT
  return "$status"
}

configure_production_runtime_role() {
  local -a database_connection=()
  read_database_connection
  local runtime_password="${database_connection[3]}"
  local runtime_password_hex
  runtime_password_hex="$(printf '%s' "$runtime_password" | python3 -c \
    'import sys; sys.stdout.write(sys.stdin.buffer.read().hex())')" || fail
  unset runtime_password database_connection
  [[ "$runtime_password_hex" =~ ^[0-9a-f]{64,2048}$ ]] || fail

  {
    cat <<'RUNTIME_ROLE_SQL'
begin;

create or replace function pg_temp.configure_app_runtime_prod(p_password text)
returns void
language plpgsql
set search_path = ''
as $function$
declare
  granted_role text;
  member_role text;
  runtime_role_oid oid;
  schema_name text;
  type_name text;
begin
  if pg_catalog.octet_length(pg_catalog.convert_to(p_password, 'UTF8')) not between 32 and 1024 then
    raise exception 'A credencial do runtime produtivo não atende ao contrato.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_roles as role where role.rolname = 'app_dal'
  ) then
    raise exception 'A role app_dal precisa existir antes do runtime produtivo.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_roles as role where role.rolname = 'app_runtime_prod'
  ) then
    create role app_runtime_prod
      nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls
      connection limit 10;
  end if;

  runtime_role_oid := (
    select role.oid from pg_catalog.pg_roles as role where role.rolname = 'app_runtime_prod'
  );

  if exists (
    select 1
    from pg_catalog.pg_roles as role
    where role.oid = runtime_role_oid
      and (role.rolsuper or role.rolcreatedb or role.rolcreaterole or role.rolreplication or role.rolbypassrls)
  ) then
    raise exception 'A role produtiva possui autoridade incompatível.';
  end if;

  if exists (
    select 1 from pg_catalog.pg_database where datdba = runtime_role_oid
    union all
    select 1 from pg_catalog.pg_namespace where nspowner = runtime_role_oid
    union all
    select 1 from pg_catalog.pg_class where relowner = runtime_role_oid
    union all
    select 1 from pg_catalog.pg_proc where proowner = runtime_role_oid
    union all
    select 1 from pg_catalog.pg_type where typowner = runtime_role_oid
  ) then
    raise exception 'A role produtiva possui ownership e não pode ser normalizada automaticamente.';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_default_acl as defaults
    cross join lateral pg_catalog.aclexplode(defaults.defaclacl) as privilege
    where privilege.grantee = runtime_role_oid
  ) then
    raise exception 'A role produtiva possui default privileges residuais.';
  end if;

  for granted_role in
    select granted.rolname
    from pg_catalog.pg_auth_members as membership
    join pg_catalog.pg_roles as member on member.oid = membership.member
    join pg_catalog.pg_roles as granted on granted.oid = membership.roleid
    where member.oid = runtime_role_oid
    order by granted.rolname
  loop
    execute pg_catalog.format('revoke %I from app_runtime_prod cascade', granted_role);
  end loop;

  for member_role in
    select member.rolname
    from pg_catalog.pg_auth_members as membership
    join pg_catalog.pg_roles as member on member.oid = membership.member
    where membership.roleid = runtime_role_oid
    order by member.rolname
  loop
    execute pg_catalog.format('revoke app_runtime_prod from %I cascade', member_role);
  end loop;

  alter role app_runtime_prod reset all;
  execute pg_catalog.format(
    'alter role app_runtime_prod in database %I reset all',
    pg_catalog.current_database()
  );
  execute pg_catalog.format(
    'alter role app_runtime_prod login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 10 valid until %L password %L',
    'infinity',
    p_password
  );

  execute pg_catalog.format(
    'revoke all privileges on database %I from app_runtime_prod',
    pg_catalog.current_database()
  );

  for schema_name in
    select namespace.nspname
    from pg_catalog.pg_namespace as namespace
    where namespace.nspname = any (array['public', 'private', 'audit'])
    order by namespace.nspname
  loop
    execute pg_catalog.format(
      'revoke all privileges on all tables in schema %I from app_runtime_prod', schema_name
    );
    execute pg_catalog.format(
      'revoke all privileges on all sequences in schema %I from app_runtime_prod', schema_name
    );
    execute pg_catalog.format(
      'revoke all privileges on all routines in schema %I from app_runtime_prod', schema_name
    );
    execute pg_catalog.format(
      'revoke all privileges on schema %I from app_runtime_prod', schema_name
    );
  end loop;

  for type_name in
    select pg_catalog.format('%I.%I', namespace.nspname, type_object.typname)
    from pg_catalog.pg_type as type_object
    join pg_catalog.pg_namespace as namespace on namespace.oid = type_object.typnamespace
    cross join lateral pg_catalog.aclexplode(type_object.typacl) as privilege
    where namespace.nspname = any (array['public', 'private', 'audit'])
      and privilege.grantee = runtime_role_oid
    order by 1
  loop
    execute pg_catalog.format(
      'revoke all privileges on type %s from app_runtime_prod', type_name
    );
  end loop;

  if exists (
    select 1
    from pg_catalog.pg_namespace as namespace
    cross join lateral pg_catalog.aclexplode(namespace.nspacl) as privilege
    where privilege.grantee = runtime_role_oid
    union all
    select 1
    from pg_catalog.pg_class as relation
    cross join lateral pg_catalog.aclexplode(relation.relacl) as privilege
    where privilege.grantee = runtime_role_oid
    union all
    select 1
    from pg_catalog.pg_proc as routine
    cross join lateral pg_catalog.aclexplode(routine.proacl) as privilege
    where privilege.grantee = runtime_role_oid
    union all
    select 1
    from pg_catalog.pg_type as type_object
    cross join lateral pg_catalog.aclexplode(type_object.typacl) as privilege
    where privilege.grantee = runtime_role_oid
  ) then
    raise exception 'A role produtiva preservou grants diretos fora do contrato.';
  end if;

  execute pg_catalog.format(
    'grant connect on database %I to app_runtime_prod',
    pg_catalog.current_database()
  );
  grant app_dal to app_runtime_prod with admin false, inherit false, set true;
  grant app_runtime_prod to postgres with admin true, inherit false, set false;
  execute pg_catalog.format(
    'alter role app_runtime_prod in database %I set "app.settings.jwt_secret" = %L',
    pg_catalog.current_database(),
    ''
  );
end
$function$;

select pg_temp.configure_app_runtime_prod(
  pg_catalog.convert_from(pg_catalog.decode($1, 'hex'), 'UTF8')
)
RUNTIME_ROLE_SQL
    printf "\\bind '%s'\n" "$runtime_password_hex"
    printf '%s\n' '\g'
    printf '%s\n' 'commit;'
  } | run_admin_psql --quiet --no-align --tuples-only >/dev/null || fail

  unset runtime_password_hex
}

capture_authorization_catalog() {
  local release_root="$1"
  local destination="$2"
  local catalog="$release_root/supabase/authorization-catalog.sql"
  [[ ! -e "$destination" && ! -L "$destination" ]] || fail
  [[ -f "$catalog" && ! -L "$catalog" ]] || fail
  [[ "$(file_sha256 "$catalog")" == "$expected_authorization_catalog_sha256" ]] || fail
  run_admin_psql --tuples-only --no-align --file="$catalog" >"$destination" || fail
  chmod 0600 "$destination"
  [[ -f "$destination" && ! -L "$destination" ]] || fail
  [[ "$(stat -c '%U:%G:%a:%h' -- "$destination")" \
    == "$deployer_user:$deployer_group:600:1" ]] || fail
  [[ "$(stat -c '%s' -- "$destination")" -le "$maximum_authorization_state_bytes" ]] || fail
}

authorization_preflight_state_exists() {
  [[ -e "$authorization_preflight_state" || -L "$authorization_preflight_state" ]]
}

write_authorization_preflight_state() {
  local release_root="$1"
  local snapshot="$2"
  local contract_kind="$3"
  [[ ! -e "$authorization_preflight_state" && ! -L "$authorization_preflight_state" ]] || fail
  local candidate="$work_directory/authorization-preflight.state"
  [[ ! -e "$candidate" && ! -L "$candidate" ]] || fail
  case "$contract_kind" in
    incremental)
      authorization_contract_node \
        write-state \
        "$release_root/manifest.json" \
        "$release_root/$authorization_contract_relative_path" \
        "$expected_authorization_catalog_sha256" \
        "$snapshot" \
        "$candidate" || fail
      ;;
    baseline)
      authorization_contract_node \
        baseline-write-state \
        "$release_root/manifest.json" \
        "$release_root/$baseline_authorization_contract_relative_path" \
        "$expected_authorization_catalog_sha256" \
        "$snapshot" \
        "$candidate" || fail
      ;;
    *) fail ;;
  esac
  chmod 0600 "$candidate"
  [[ "$(stat -c '%U:%G:%a:%h' -- "$candidate")" \
    == "$deployer_user:$deployer_group:600:1" ]] || fail
  [[ "$(stat -c '%s' -- "$candidate")" -le "$maximum_authorization_state_bytes" ]] || fail
  sync -f "$candidate"
  mv -Tf -- "$candidate" "$authorization_preflight_state"
  sync -f "$state_base"
  assert_private_state_file \
    "$authorization_preflight_state" "$maximum_authorization_state_bytes"
}

restore_authorization_preflight_snapshot() {
  local release_root="$1"
  local destination="$2"
  local contract_kind="$3"
  assert_private_state_file \
    "$authorization_preflight_state" "$maximum_authorization_state_bytes"
  [[ ! -e "$destination" && ! -L "$destination" ]] || fail
  case "$contract_kind" in
    incremental)
      authorization_contract_node \
        read-state \
        "$release_root/manifest.json" \
        "$release_root/$authorization_contract_relative_path" \
        "$expected_authorization_catalog_sha256" \
        "$authorization_preflight_state" \
        "$destination" || fail
      ;;
    baseline)
      authorization_contract_node \
        baseline-read-state \
        "$release_root/manifest.json" \
        "$release_root/$baseline_authorization_contract_relative_path" \
        "$expected_authorization_catalog_sha256" \
        "$authorization_preflight_state" \
        "$destination" || fail
      ;;
    *) fail ;;
  esac
  chmod 0600 "$destination"
  [[ "$(stat -c '%U:%G:%a:%h' -- "$destination")" \
    == "$deployer_user:$deployer_group:600:1" ]] || fail
  [[ "$(stat -c '%s' -- "$destination")" -le "$maximum_authorization_state_bytes" ]] || fail
}

assert_authorization_delta() {
  local release_root="$1"
  local before_snapshot="$2"
  local after_snapshot="$3"
  local previous_head="$4"
  local migration_head="$5"
  local contract_kind="$6"
  case "$contract_kind" in
    incremental)
      authorization_contract_node \
        compare \
        "$release_root/manifest.json" \
        "$release_root/$authorization_contract_relative_path" \
        "$expected_authorization_catalog_sha256" \
        "$before_snapshot" \
        "$after_snapshot" \
        "$previous_head" \
        "$migration_head" || fail
      ;;
    baseline)
      [[ "$previous_head" == none ]] || fail
      authorization_contract_node \
        baseline-compare \
        "$release_root/manifest.json" \
        "$release_root/$baseline_authorization_contract_relative_path" \
        "$expected_authorization_catalog_sha256" \
        "$before_snapshot" \
        "$after_snapshot" \
        "$migration_head" || fail
      ;;
    *) fail ;;
  esac
}

authorization_preflight_metadata() {
  assert_private_state_file \
    "$authorization_preflight_state" "$maximum_authorization_state_bytes"
  authorization_contract_node state-metadata "$authorization_preflight_state" || fail
}

assert_authorization_snapshots_equal() {
  authorization_contract_node snapshot-equal "$1" "$2" || fail
}

assert_authorization_head() {
  local release_root="$1"
  local snapshot="$2"
  authorization_contract_node \
    head-compare \
    "$release_root/manifest.json" \
    "$release_root/$authorization_head_relative_path" \
    "$expected_authorization_catalog_sha256" \
    "$snapshot" || fail
}

clear_authorization_preflight_state() {
  if [[ ! -e "$authorization_preflight_state" && ! -L "$authorization_preflight_state" ]]; then
    return 0
  fi
  assert_private_state_file \
    "$authorization_preflight_state" "$maximum_authorization_state_bytes"
  rm -f -- "$authorization_preflight_state"
  sync -f "$state_base"
  [[ ! -e "$authorization_preflight_state" && ! -L "$authorization_preflight_state" ]] || fail
}

run_supabase_migrations() {
  local release_root="$1"
  local migration_head="$2"
  local previous_head="$3"
  local cli="$supabase_cli_path"
  assert_host_supabase_cli
  (
    cd "$release_root"
    env -i \
      HOME="$deployer_home" LANG=C.UTF-8 LC_ALL=C.UTF-8 \
      PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
      SUPABASE_ACCESS_TOKEN="$supabase_access_token" \
      SUPABASE_DB_PASSWORD="$supabase_db_password" \
      "$cli" link --project-ref "$supabase_project_ref" </dev/null
    local migration_preflight="$work_directory/remote-migrations-before-$migration_head.json"
    env -i \
      HOME="$deployer_home" LANG=C.UTF-8 LC_ALL=C.UTF-8 \
      PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
      SUPABASE_ACCESS_TOKEN="$supabase_access_token" \
      SUPABASE_DB_PASSWORD="$supabase_db_password" \
      "$cli" migration list --linked --output-format json --yes \
      </dev/null >"$migration_preflight"
    local migration_mode
    migration_mode="$(assert_remote_migration_preflight \
      "$migration_preflight" \
      "$release_root/supabase/migrations" \
      "$migration_head" \
      "$previous_head")" || fail
    local state_contract_kind=
    local state_previous_head=
    local state_head=
    if authorization_preflight_state_exists; then
      local state_metadata
      local state_extra
      state_metadata="$(authorization_preflight_metadata)" || fail
      read -r \
        state_contract_kind state_previous_head state_head state_extra \
        <<<"$state_metadata"
      [[ -z "$state_extra" ]] || fail
      [[ "$state_contract_kind" == baseline || "$state_contract_kind" == incremental ]] || fail
      [[ "$state_previous_head" == none || "$state_previous_head" =~ ^[0-9]{14}$ ]] || fail
      [[ "$state_head" == "$migration_head" ]] || fail
    fi

    local authorization_contract_kind
    case "$migration_mode:$previous_head:$state_contract_kind" in
      baseline:none:* | baseline-resume:none:* | post-push-resume:none:* | already-current:*:baseline)
        authorization_contract_kind=baseline
        ;;
      *) authorization_contract_kind=incremental ;;
    esac

    local authorization_metadata
    case "$authorization_contract_kind" in
      baseline)
        authorization_metadata="$(authorization_contract_node \
          baseline-manifest \
          "$release_root/manifest.json" \
          "$release_root/$baseline_authorization_contract_relative_path" \
          "$expected_authorization_catalog_sha256")" || fail
        ;;
      incremental)
        authorization_metadata="$(authorization_contract_node \
          manifest \
          "$release_root/manifest.json" \
          "$release_root/$authorization_contract_relative_path" \
          "$expected_authorization_catalog_sha256")" || fail
        ;;
      *) fail ;;
    esac
    local authorization_previous_head
    local authorization_head
    local authorization_sha
    read -r authorization_previous_head authorization_head authorization_sha \
      <<<"$authorization_metadata"
    if [[ "$authorization_contract_kind" == baseline ]]; then
      [[ "$authorization_previous_head" == none ]] || fail
    else
      [[ "$authorization_previous_head" =~ ^[0-9]{14}$ ]] || fail
    fi
    [[ "$authorization_head" == "$migration_head" ]] || fail
    assert_checksum "$authorization_sha"
    if [[ -n "$state_contract_kind" ]]; then
      [[ "$state_contract_kind" == "$authorization_contract_kind" ]] || fail
      [[ "$state_previous_head" == "$authorization_previous_head" ]] || fail
    fi

    local authorization_before="$work_directory/authorization-before-$migration_head.jsonl"
    local authorization_current="$work_directory/authorization-current-$migration_head.jsonl"
    local authorization_after="$work_directory/authorization-after-$migration_head.jsonl"
    local authorization_required=false
    local authorization_comparison_previous="$authorization_previous_head"
    case "$migration_mode" in
      baseline)
        [[ "$previous_head" == none ]] || fail
        authorization_required=true
        if authorization_preflight_state_exists; then
          restore_authorization_preflight_snapshot \
            "$release_root" "$authorization_before" \
            "$authorization_contract_kind"
          capture_authorization_catalog "$release_root" "$authorization_current"
          assert_authorization_snapshots_equal \
            "$authorization_before" "$authorization_current"
        else
          capture_authorization_catalog "$release_root" "$authorization_before"
          write_authorization_preflight_state \
            "$release_root" "$authorization_before" \
            "$authorization_contract_kind"
        fi
        ;;
      baseline-resume)
        [[ "$previous_head" == none ]] || fail
        authorization_preflight_state_exists || fail
        restore_authorization_preflight_snapshot \
          "$release_root" "$authorization_before" \
          "$authorization_contract_kind"
        authorization_required=true
        ;;
      incremental)
        [[ "$previous_head" == "$authorization_previous_head" ]] || fail
        assert_expand_only_delta "$release_root" "$migration_head" "$previous_head" || fail
        authorization_required=true
        if authorization_preflight_state_exists; then
          restore_authorization_preflight_snapshot \
            "$release_root" "$authorization_before" \
            "$authorization_contract_kind"
          capture_authorization_catalog "$release_root" "$authorization_current"
          assert_authorization_snapshots_equal \
            "$authorization_before" "$authorization_current"
        else
          capture_authorization_catalog "$release_root" "$authorization_before"
          write_authorization_preflight_state \
            "$release_root" "$authorization_before" \
            "$authorization_contract_kind"
        fi
        ;;
      incremental-resume)
        [[ "$previous_head" == "$authorization_previous_head" ]] || fail
        assert_expand_only_delta "$release_root" "$migration_head" "$previous_head" || fail
        authorization_preflight_state_exists || fail
        restore_authorization_preflight_snapshot \
          "$release_root" "$authorization_before" \
          "$authorization_contract_kind"
        authorization_required=true
        ;;
      already-current)
        [[ "$previous_head" == "$migration_head" ]] || fail
        if authorization_preflight_state_exists; then
          restore_authorization_preflight_snapshot \
            "$release_root" "$authorization_before" \
            "$authorization_contract_kind"
          authorization_required=true
        fi
        ;;
      post-push-resume)
        authorization_preflight_state_exists || fail
        if [[ "$authorization_contract_kind" == incremental ]]; then
          [[ "$previous_head" == "$authorization_previous_head" ]] || fail
          assert_expand_only_delta "$release_root" "$migration_head" "$previous_head" || fail
        else
          [[ "$previous_head" == none ]] || fail
        fi
        restore_authorization_preflight_snapshot \
          "$release_root" "$authorization_before" \
          "$authorization_contract_kind"
        authorization_required=true
        ;;
      *) fail ;;
    esac
    if [[ "$migration_mode" == baseline \
      || "$migration_mode" == baseline-resume \
      || "$migration_mode" == incremental \
      || "$migration_mode" == incremental-resume ]]; then
      env -i \
        HOME="$deployer_home" LANG=C.UTF-8 LC_ALL=C.UTF-8 \
        PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
        SUPABASE_ACCESS_TOKEN="$supabase_access_token" \
        SUPABASE_DB_PASSWORD="$supabase_db_password" \
        "$cli" db push --linked --include-all --include-roles --dry-run --yes </dev/null
      env -i \
        HOME="$deployer_home" LANG=C.UTF-8 LC_ALL=C.UTF-8 \
        PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
        SUPABASE_ACCESS_TOKEN="$supabase_access_token" \
        SUPABASE_DB_PASSWORD="$supabase_db_password" \
        "$cli" db push --linked --include-all --include-roles --yes </dev/null
    fi
    local migration_output="$work_directory/remote-migrations-after-$migration_head.json"
    env -i \
      HOME="$deployer_home" LANG=C.UTF-8 LC_ALL=C.UTF-8 \
      PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
      SUPABASE_ACCESS_TOKEN="$supabase_access_token" \
      SUPABASE_DB_PASSWORD="$supabase_db_password" \
      "$cli" migration list --linked --output-format json --yes \
      </dev/null >"$migration_output"
    assert_remote_migration_history \
      "$migration_output" \
      "$release_root/supabase/migrations" \
      "$migration_head"
    configure_production_runtime_role
    capture_authorization_catalog "$release_root" "$authorization_after"
    if [[ "$authorization_required" == true ]]; then
      assert_authorization_delta \
        "$release_root" \
        "$authorization_before" \
        "$authorization_after" \
        "$authorization_comparison_previous" \
        "$migration_head" \
        "$authorization_contract_kind"
    fi
    assert_authorization_head "$release_root" "$authorization_after"
  )
  assert_database_readiness "$migration_head"
  write_applied_schema_state "$migration_head"
  clear_authorization_preflight_state
}

assert_database_readiness() {
  local migration_head="$1"
  local result
  result="$(run_database_psql --tuples-only --no-align \
    --command "select session_user || ':' || current_user || ':' || private.check_runtime_readiness('app_runtime_prod'::text) || ':' || private.check_readiness('${migration_head}'::text);")" || fail
  [[ "$(tr -d '[:space:]' <<<"$result")" == app_runtime_prod:app_dal:t:t ]] || fail
}

write_runtime_assignment() {
  local key="$1"
  local value="$2"
  [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || fail
  [[ -n "$value" ]] || fail
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* && "$value" != *"'"* ]] || fail
  printf "%s='%s'\n" "$key" "$value"
}

write_runtime_credential() {
  local destination="$1"
  local release_sha="$2"
  local application="$3"
  local origin="$4"
  local port="$5"
  [[ "$application" == web || "$application" == backoffice ]] || fail
  local application_unit="setlivre-${application}.service"
  {
    write_runtime_assignment NODE_ENV production
    write_runtime_assignment APP_ENV production
    write_runtime_assignment APP_RELEASE_SHA "$release_sha"
    write_runtime_assignment NEXT_TELEMETRY_DISABLED 1
    write_runtime_assignment HOSTNAME 127.0.0.1
    write_runtime_assignment PORT "$port"
    write_runtime_assignment NEXT_PUBLIC_APP_URL "$origin"
    write_runtime_assignment NEXT_PUBLIC_SUPABASE_URL "$supabase_url"
    write_runtime_assignment NEXT_PUBLIC_SUPABASE_ANON_KEY "$supabase_anon_key"
    write_runtime_assignment \
      DATABASE_TLS_CA_PATH "/run/credentials/$application_unit/supabase-server-ca.pem"
    write_runtime_assignment DATABASE_TLS_CA_SHA256 "$supabase_server_ca_sha256"
    write_runtime_assignment DATABASE_URL_APP_DAL "$database_url"
  } >"$destination"
  chmod 0600 "$destination"
  local credential_size
  credential_size="$(stat -c '%s' -- "$destination")" || fail
  assert_positive_integer "$credential_size"
  ((credential_size <= 32768)) || fail
}

stage_activation() {
  local archive="$1"
  local release_sha="$2"
  local archive_size
  archive_size="$(stat -c '%s' -- "$archive")" || fail
  assert_positive_integer "$archive_size"
  assert_available_space "$incoming_base" "$archive_size"
  incoming_directory="$incoming_base/$release_sha"
  write_cleanup_pending_state "$work_directory" "$incoming_directory" || fail
  cleanup_tree "$incoming_directory" "$incoming_base" || fail
  clear_cleanup_pending_state || fail
  install -d -m 0700 -- "$incoming_directory"
  install -m 0600 -- "$archive" "$incoming_directory/release.tar.gz"
  write_runtime_credential "$incoming_directory/web.env" "$release_sha" web "$public_app_url" 3000
  write_runtime_credential \
    "$incoming_directory/backoffice.env" "$release_sha" backoffice "$backoffice_app_url" 3001
  [[ "$(readlink --canonicalize-existing -- "$incoming_directory")" \
    == "$incoming_directory" ]] || fail
  [[ "$(stat -c '%U:%G:%a' -- "$incoming_directory")" \
    == "$deployer_user:$deployer_group:700" ]] || fail
  local incoming_inventory
  incoming_inventory="$(find "$incoming_directory" -mindepth 1 -maxdepth 1 \
    -printf '%y:%f\n' | sort)" || fail
  [[ "$incoming_inventory" \
    == $'f:backoffice.env\nf:release.tar.gz\nf:web.env' ]] || fail
  local staged_file
  for staged_file in backoffice.env release.tar.gz web.env; do
    [[ "$(stat -c '%U:%G:%a:%h' -- "$incoming_directory/$staged_file")" \
      == "$deployer_user:$deployer_group:600:1" ]] || fail
  done
}

run_smoke() {
  local release_sha="$1"
  local attempts="$2"
  local interval_ms="$3"
  local timeout_seconds="$4"
  assert_sha "$release_sha"
  assert_positive_integer "$attempts"
  [[ "$interval_ms" =~ ^(0|[1-9][0-9]*)$ && "${#interval_ms}" -le 19 ]] || fail
  if [[ "$interval_ms" != 0 ]]; then
    assert_positive_integer "$interval_ms"
  fi
  assert_positive_integer "$timeout_seconds"
  export RELEASE_SHA="$release_sha"
  export PRD_PUBLIC_APP_URL="$public_app_url"
  export PRD_BACKOFFICE_APP_URL="$backoffice_app_url"
  export SMOKE_ATTEMPTS="$attempts"
  export SMOKE_INTERVAL_MS="$interval_ms"
  local status=0
  timeout --signal=TERM --kill-after=30s "${timeout_seconds}s" \
    node "$production_smoke" || status=$?
  unset RELEASE_SHA PRD_PUBLIC_APP_URL PRD_BACKOFFICE_APP_URL
  unset SMOKE_ATTEMPTS SMOKE_INTERVAL_MS
  return "$status"
}

prepare_release_schema() {
  local release_root="$1"
  local migration_head="$2"
  local previous_head="$3"
  local current_sha="$4"
  local release_sha="$5"
  local artifact_provider_run_number="$6"
  local artifact_provider_run_attempt="$7"
  local artifact_provider_run_id="$8"
  local artifact_id="$9"
  local artifact_digest="${10}"
  run_supabase_migrations "$release_root" "$migration_head" "$previous_head"
  if [[ "$current_sha" != none ]] && ! run_smoke \
    "$current_sha" \
    "$compatibility_smoke_attempts" \
    "$compatibility_smoke_interval_ms" \
    "$compatibility_smoke_timeout_seconds"; then
    record_rejected_artifact \
      "$release_sha" \
      "$artifact_provider_run_number" \
      "$artifact_provider_run_attempt" \
      "$artifact_provider_run_id" \
      "$artifact_id" \
      "$artifact_digest" \
      "$migration_head"
    fail
  fi
}

assert_manager_checkpoint_unchanged() {
  local candidate="$work_directory/manager-after-activation-failure.checkpoint"
  [[ ! -e "$candidate" && ! -L "$candidate" ]] || fail
  local payload
  payload="$(sudo -n "$dispatcher" checkpoint)" || fail
  printf '%s\n' "$payload" >"$candidate"
  chmod 0600 "$candidate"
  local observed
  observed="$(parse_manager_checkpoint "$candidate")" || fail
  local expected
  if [[ "$checkpoint_release_sha" == none ]]; then
    expected=none
  else
    expected="$(printf '%s %s %s %s %s %s %s %s %s' \
      "$checkpoint_release_sha" \
      "$checkpoint_source_run_number" \
      "$checkpoint_source_run_attempt" \
      "$checkpoint_source_run_id" \
      "$checkpoint_artifact_id" \
      "$checkpoint_artifact_digest" \
      "$checkpoint_archive_sha" \
      "$checkpoint_lock_sha" \
      "$checkpoint_migration_head")"
  fi
  [[ "$observed" == "$expected" ]] || fail
}

preflight_release() {
  local release_sha="$1"
  local archive_sha="$2"
  local lock_sha="$3"
  local migration_head="$4"
  local source_run_number="$5"
  local source_run_attempt="$6"
  local source_run_id="$7"
  local artifact_id="$8"
  local artifact_digest="$9"
  sudo -n "$dispatcher" preflight \
    "$release_sha" "$archive_sha" "$lock_sha" "$migration_head" \
    "$source_run_number" "$source_run_attempt" "$source_run_id" \
    "$artifact_id" "$artifact_digest" || fail
  root_preflight_sha="$release_sha"
}

activate_release() {
  local release_sha="$1"
  local archive_sha="$2"
  local lock_sha="$3"
  local migration_head="$4"
  local source_run_number="$5"
  local source_run_attempt="$6"
  local source_run_id="$7"
  local artifact_provider_run_number="$8"
  local artifact_provider_run_attempt="$9"
  local artifact_provider_run_id="${10}"
  local artifact_id="${11}"
  local artifact_digest="${12}"
  assert_positive_integer "$source_run_number"
  assert_positive_integer "$source_run_attempt"
  assert_positive_integer "$source_run_id"
  assert_positive_integer "$artifact_provider_run_number"
  assert_positive_integer "$artifact_provider_run_attempt"
  assert_positive_integer "$artifact_provider_run_id"
  local activation_output
  local activation_deadline
  local activation_extra
  if activation_output="$(sudo -n "$dispatcher" activate \
    "$release_sha" "$archive_sha" "$lock_sha" "$migration_head" \
    "$source_run_number" "$source_run_attempt" "$source_run_id" \
    "$artifact_id" "$artifact_digest")"; then
    :
  else
    assert_manager_checkpoint_unchanged
    record_rejected_artifact \
      "$release_sha" \
      "$artifact_provider_run_number" \
      "$artifact_provider_run_attempt" \
      "$artifact_provider_run_id" \
      "$artifact_id" \
      "$artifact_digest" \
      "$migration_head"
    fail
  fi
  root_preflight_sha=
  read -r rollback_sha activation_deadline activation_extra <<<"$activation_output"
  [[ -z "$activation_extra" ]] || fail
  assert_optional_sha "$rollback_sha"
  assert_positive_integer "$activation_deadline"
  assert_smoke_window "$activation_deadline"
  if ! run_smoke \
    "$release_sha" "$smoke_attempts" "$smoke_interval_ms" "$smoke_timeout_seconds"; then
    sudo -n "$dispatcher" rollback "$release_sha" || fail
    local terminal_result
    terminal_result="$(manager_activation_result "$release_sha")" || fail
    [[ "$terminal_result" == "rejected $rollback_sha" ]] || fail
    record_rejected_artifact \
      "$release_sha" \
      "$artifact_provider_run_number" \
      "$artifact_provider_run_attempt" \
      "$artifact_provider_run_id" \
      "$artifact_id" \
      "$artifact_digest" \
      "$migration_head"
    fail
  fi
  assert_confirmation_window "$activation_deadline"
  sudo -n "$dispatcher" confirm "$release_sha" || fail
  [[ "$(manager_activation_result "$release_sha")" == "confirmed $release_sha" ]] || fail
}

write_deployed_state() {
  local release_sha="$1"
  local source_run_number="$2"
  local source_run_attempt="$3"
  local source_run_id="$4"
  local artifact_id="$5"
  local artifact_digest="$6"
  local archive_sha="$7"
  local lock_sha="$8"
  local migration_head="$9"
  assert_sha "$release_sha"
  assert_positive_integer "$source_run_number"
  assert_positive_integer "$source_run_attempt"
  assert_positive_integer "$source_run_id"
  assert_positive_integer "$artifact_id"
  assert_checksum "$artifact_digest"
  assert_checksum "$archive_sha"
  assert_checksum "$lock_sha"
  [[ "$migration_head" =~ ^[0-9]{14}$ ]] || fail
  local candidate="$work_directory/deployed.state"
  printf '%s\n' \
    'schema=2' \
    "release_sha=$release_sha" \
    "run_number=$source_run_number" \
    "run_attempt=$source_run_attempt" \
    "run_id=$source_run_id" \
    "artifact_id=$artifact_id" \
    "artifact_digest=$artifact_digest" \
    "archive_sha=$archive_sha" \
    "lock_sha=$lock_sha" \
    "migration_head=$migration_head" \
    >"$candidate"
  chmod 0600 "$candidate"
  mv -Tf -- "$candidate" "$deployed_state"
  [[ "$(stat -c '%U:%G:%a:%h' -- "$deployed_state")" \
    == "$deployer_user:$deployer_group:600:1" ]] || fail
}

main() {
  [[ "$#" -eq 0 ]] || fail
  require_no_pending_reboot
  assert_host_supabase_cli
  if capture_environment; then
    :
  else
    local environment_status=$?
    if [[ "$environment_status" -eq 2 ]]; then
      log "Deploy de produção desabilitado."
      return 0
    fi
    fail
  fi
  assert_runtime
  exec 9>"$private_base/deploy.lock"
  flock -n 9 || {
    log "Outro ciclo de deploy está em andamento."
    exit 0
  }
  [[ -f "$private_base/deploy.lock" && ! -L "$private_base/deploy.lock" ]] || fail
  chmod 0600 "$private_base/deploy.lock"
  recover_pending_cleanup || fail

  work_directory="$(mktemp -d "$work_base/deploy.XXXXXXXX")" || fail
  [[ "$work_directory" == "$work_base/"* ]] || fail
  incoming_directory=
  trap cleanup EXIT
  trap 'exit 1' HUP INT TERM

  local manager_checkpoint="$work_directory/manager.checkpoint"
  local manager_checkpoint_payload
  manager_checkpoint_payload="$(sudo -n "$dispatcher" checkpoint)" || fail
  printf '%s\n' "$manager_checkpoint_payload" >"$manager_checkpoint"
  chmod 0600 "$manager_checkpoint"
  load_deployed_state "$manager_checkpoint"
  local current_sha="$checkpoint_release_sha"
  assert_optional_sha "$current_sha"

  local selection
  if selection="$(select_artifact "$current_sha")"; then
    :
  else
    local status=$?
    if [[ "$status" -eq 2 ]]; then
      log "Nenhum artefato de produção novo e elegível."
      return 0
    fi
    if [[ "$status" -eq 3 ]]; then
      log "Regeneração canônica do artefato aprovado solicitada ou em andamento."
      return 0
    fi
    fail
  fi
  local source_run_number
  local source_run_attempt
  local source_run_id
  local release_sha
  local artifact_provider_run_number
  local artifact_provider_run_attempt
  local artifact_provider_run_id
  local artifact_id
  local artifact_digest
  local artifact_size
  local expected_archive_sha
  local expected_public_build_config_sha
  local schema_previous_head
  read -r \
    source_run_number source_run_attempt source_run_id release_sha \
    artifact_provider_run_number artifact_provider_run_attempt artifact_provider_run_id \
    artifact_id artifact_digest artifact_size expected_archive_sha \
    expected_public_build_config_sha schema_previous_head <<<"$selection"
  assert_positive_integer "$source_run_number"
  assert_positive_integer "$source_run_attempt"
  assert_positive_integer "$source_run_id"
  assert_sha "$release_sha"
  assert_positive_integer "$artifact_provider_run_number"
  assert_positive_integer "$artifact_provider_run_attempt"
  assert_positive_integer "$artifact_provider_run_id"
  assert_positive_integer "$artifact_id"
  assert_checksum "$artifact_digest"
  assert_positive_integer "$artifact_size"
  assert_checksum "$expected_archive_sha"
  assert_checksum "$expected_public_build_config_sha"
  [[ "$schema_previous_head" == none || "$schema_previous_head" =~ ^[0-9]{14}$ ]] || fail

  local zip_path="$work_directory/artifact.zip"
  assert_available_space "$work_directory" "$artifact_size"
  download_artifact "$artifact_id" "$zip_path"
  [[ "$(stat -c '%s' -- "$zip_path")" == "$artifact_size" ]] || fail
  [[ "$(file_sha256 "$zip_path")" == "$artifact_digest" ]] || fail
  local archive_name="set-livre-${release_sha}.tar.gz"
  assert_available_space "$work_directory" "$maximum_expanded_bytes"
  extract_verified_zip "$zip_path" "$release_sha" "$work_directory"
  local archive="$work_directory/$archive_name"
  local sidecar="${archive}.sha256"
  local archive_sha
  archive_sha="$(file_sha256 "$archive")" || fail
  [[ "$archive_sha" == "$expected_archive_sha" ]] || fail
  verify_sidecar "$archive" "$sidecar" "$archive_sha" "$archive_name"
  local tar_expanded_bytes
  tar_expanded_bytes="$(validate_tar_archive "$archive")" || fail
  assert_positive_integer "$tar_expanded_bytes"

  local extraction_root="$work_directory/extracted"
  install -d -m 0700 -- "$extraction_root"
  assert_available_space "$extraction_root" "$tar_expanded_bytes"
  tar --extract --gzip --file "$archive" --directory "$extraction_root" \
    --no-same-owner --no-same-permissions
  local release_root="$extraction_root/release"
  [[ -d "$release_root" && ! -L "$release_root" ]] || fail
  local release_contract
  release_contract="$(assert_release_contract \
    "$release_root" "$release_sha" "$expected_public_build_config_sha")" || fail
  local migration_head
  local lock_sha
  read -r migration_head lock_sha <<<"$release_contract"
  [[ "$migration_head" =~ ^[0-9]{14}$ ]] || fail
  assert_checksum "$lock_sha"

  stage_activation "$archive" "$release_sha"
  preflight_release \
    "$release_sha" "$archive_sha" "$lock_sha" "$migration_head" \
    "$source_run_number" "$source_run_attempt" "$source_run_id" \
    "$artifact_id" "$artifact_digest"
  prepare_release_schema \
    "$release_root" \
    "$migration_head" \
    "$schema_previous_head" \
    "$current_sha" \
    "$release_sha" \
    "$artifact_provider_run_number" \
    "$artifact_provider_run_attempt" \
    "$artifact_provider_run_id" \
    "$artifact_id" \
    "$artifact_digest"
  activate_release \
    "$release_sha" "$archive_sha" "$lock_sha" "$migration_head" \
    "$source_run_number" "$source_run_attempt" "$source_run_id" \
    "$artifact_provider_run_number" "$artifact_provider_run_attempt" \
    "$artifact_provider_run_id" "$artifact_id" "$artifact_digest"
  write_deployed_state \
    "$release_sha" "$source_run_number" "$source_run_attempt" "$source_run_id" "$artifact_id" \
    "$artifact_digest" "$archive_sha" "$lock_sha" "$migration_head"
  cleanup_current_resources || fail
  trap - EXIT HUP INT TERM
  log "Release de produção confirmada: $release_sha"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
