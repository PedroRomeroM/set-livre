#!/usr/bin/env bash

set -euo pipefail
umask 077
IFS=$' \t\n'
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
unset BASH_ENV CDPATH CURL_HOME ENV GLOBIGNORE GREP_OPTIONS PYTHONHOME PYTHONPATH TAR_OPTIONS
unset DATABASE_URL_APP_DAL PRD_DATABASE_URL_APP_DAL PRD_SUPABASE_ANON_KEY
unset SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD

readonly protocol_version=3
readonly base=/opt/setlivre
readonly releases="$base/releases"
readonly runtime_base="$base/shared/runtime"
readonly private_staging_base="$base/shared/release-staging"
readonly state_base="$base/shared/release-state"
readonly provenance_base="$state_base/provenance"
readonly cleanup_pending_state="$state_base/cleanup-resources.state"
readonly preflight_state="$state_base/release-preflight.state"
readonly deployer_user=setlivre-deployer
readonly deployer_group=setlivre-deployer
readonly deployer_home="/var/lib/$deployer_user"
readonly deployer_incoming_base="$deployer_home/.setlivre/incoming"
readonly service_group=setlivre
readonly web_service=setlivre-web.service
readonly backoffice_service=setlivre-backoffice.service
readonly nginx_service=nginx.service
readonly node_version=v24.18.0
readonly manager_path=/usr/local/sbin/setlivre-release-manager
readonly production_smoke=/usr/local/libexec/setlivre/production-smoke.mjs
readonly manager_update_directory=/var/lib/setlivre-deployer-config/manager-update
readonly public_app_url=https://setlivre.com
readonly backoffice_app_url=https://ops.setlivre.com
readonly activation_lease_seconds=1800
readonly confirmation_margin_seconds=120
readonly smoke_timeout_seconds=1080
readonly smoke_attempts=37
readonly smoke_interval_ms=25000
readonly minimum_free_reserve_bytes=536870912

activation_private_staging=
activation_release_candidate=
activation_runtime_candidate=
activation_pending_state=
activation_preflight_state=
activation_lease_armed=0

current_release_target=
current_runtime_target=
current_release_sha=none
current_release_component_sha=none
current_runtime_component_sha=none
previous_release_target=
previous_runtime_target=
previous_release_sha=none
selected_rollback_sha=none
selected_prior_previous_sha=none
pending_rollback_sha=
pending_prior_previous_sha=
pending_activation_deadline=
recovery_operation=
recovery_source_sha=
recovery_requested_sha=
recovery_active_sha=
recovery_previous_sha=
recovery_phase=
recovery_outcome=
preflight_phase=
preflight_release_sha=
preflight_archive_sha=
preflight_web_runtime_credential_sha=
preflight_backoffice_runtime_credential_sha=
preflight_public_build_config_sha=
preflight_lock_sha=
preflight_migration_head=
preflight_run_number=
preflight_run_attempt=
preflight_run_id=
preflight_artifact_id=
preflight_artifact_digest=

fail() {
  printf '%s\n' "Set Livre release manager rejected the operation." >&2
  exit 1
}

assert_no_pending_manager_update() {
  [[ ! -e "$manager_update_directory" && ! -L "$manager_update_directory" ]] || fail
}

require_commands() {
  local command_name
  for command_name in \
    basename chmod chown cmp curl df env find flock install ln mktemp mv node \
    python3 readlink rm sha256sum sleep sort stat sync systemctl systemd-run tail tar \
    timeout tr; do
    command -v "$command_name" >/dev/null 2>&1 || fail
  done
}

require_root() {
  [[ "$EUID" -eq 0 ]] || fail
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
  local digest
  output="$(sha256sum -- "$path")" || fail
  digest="${output%% *}"
  assert_checksum "$digest"
  printf '%s\n' "$digest"
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

monotonic_seconds() {
  python3 - <<'MONOTONIC_SECONDS_PY'
import time

print(time.monotonic_ns() // 1_000_000_000)
MONOTONIC_SECONDS_PY
}

assert_lease_contract() {
  assert_positive_integer "$activation_lease_seconds"
  assert_positive_integer "$confirmation_margin_seconds"
  assert_positive_integer "$smoke_timeout_seconds"
  ((smoke_timeout_seconds + confirmation_margin_seconds < activation_lease_seconds)) || fail
}

assert_confirmation_window() {
  local deadline="$1"
  local now
  assert_positive_integer "$deadline"
  now="$(monotonic_seconds)" || fail
  assert_positive_integer "$now"
  ((now + confirmation_margin_seconds <= deadline)) || fail
}

assert_regular_private_upload() {
  local path="$1"
  [[ -f "$path" && ! -L "$path" ]] || fail
  [[ "$(stat -c '%h' -- "$path")" == 1 ]] || fail
  [[ "$(stat -c '%U:%a' -- "$path")" == "$deployer_user:600" ]] || fail
}

assert_root_private_file() {
  local path="$1"
  [[ -f "$path" && ! -L "$path" ]] || fail
  [[ "$(stat -c '%h' -- "$path")" == 1 ]] || fail
  [[ "$(stat -c '%U:%G:%a' -- "$path")" == "root:root:600" ]] || fail
}

assert_installed_smoke() {
  [[ -f "$production_smoke" && ! -L "$production_smoke" ]] || fail
  [[ "$(readlink --canonicalize-existing -- "$production_smoke")" == "$production_smoke" ]] || fail
  [[ "$(stat -c '%U:%G:%a:%h' -- "$production_smoke")" \
    == "root:$deployer_group:640:1" ]] || fail
}

assert_release_target() {
  local target="$1"
  local release_sha
  [[ "$target" == "$releases/"* && -d "$target" && ! -L "$target" ]] || fail
  release_sha="$(basename -- "$target")"
  assert_sha "$release_sha"
  assert_release_provenance_record "$release_sha"
}

assert_runtime_target() {
  local target="$1"
  local release_sha
  local entries
  [[ "$target" == "$runtime_base/releases/"* && -d "$target" && ! -L "$target" ]] || fail
  release_sha="$(basename -- "$target")"
  assert_sha "$release_sha"
  [[ "$(stat -c '%U:%G:%a' -- "$target")" == root:root:700 ]] || fail
  entries="$(find "$target" -mindepth 1 -maxdepth 1 -printf '%y:%f\n' | sort)" || fail
  [[ "$entries" == $'f:backoffice.env\nf:web.env' ]] || fail
  assert_root_private_file "$target/web.env"
  assert_root_private_file "$target/backoffice.env"
  validate_runtime_credential "$target/web.env" web "$release_sha"
  validate_runtime_credential "$target/backoffice.env" backoffice "$release_sha"
  public_build_config_sha256_from_credentials \
    "$target/web.env" "$target/backoffice.env" >/dev/null || fail
}

ensure_root_private_directory() {
  local path="$1"
  if [[ ! -e "$path" && ! -L "$path" ]]; then
    install -d -o root -g root -m 0700 -- "$path"
  fi
  [[ -d "$path" && ! -L "$path" ]] || fail
  [[ "$(stat -c '%U:%G:%a' -- "$path")" == "root:root:700" ]] || fail
}

durable_sync_directory() {
  local directory="$1"
  [[ -d "$directory" && ! -L "$directory" ]] || fail
  [[ "$(readlink --canonicalize-existing -- "$directory")" == "$directory" ]] || fail
  sync --file-system -- "$directory" || fail
}

assert_available_space() {
  local path="$1"
  local required_bytes="$2"
  local available_bytes
  [[ -d "$path" && ! -L "$path" ]] || fail
  assert_positive_integer "$required_bytes"
  available_bytes="$(df --block-size=1 --output=avail -- "$path" | tail -n 1 | tr -d '[:space:]')"
  [[ "$available_bytes" =~ ^[1-9][0-9]*$ ]] || fail
  ((required_bytes <= 9223372036854775807 - minimum_free_reserve_bytes)) || fail
  ((available_bytes >= required_bytes + minimum_free_reserve_bytes)) || fail
}

atomic_link() {
  local target="$1"
  local destination="$2"
  local temporary="${destination}.new.$$"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || fail
  ln -s -- "$target" "$temporary" || fail
  mv -Tf -- "$temporary" "$destination" || fail
  durable_sync_directory "${destination%/*}"
}

resolve_optional_link() {
  local link="$1"
  local output_variable="$2"
  local resolved=
  if [[ -L "$link" ]]; then
    if ! resolved="$(readlink -f -- "$link")"; then
      fail
    fi
    [[ -n "$resolved" ]] || fail
  elif [[ -e "$link" ]]; then
    fail
  fi
  printf -v "$output_variable" '%s' "$resolved"
}

load_current_components() {
  current_release_target=
  current_runtime_target=
  current_release_component_sha=none
  current_runtime_component_sha=none
  resolve_optional_link "$base/current" current_release_target
  resolve_optional_link "$runtime_base/current" current_runtime_target
  if [[ -n "$current_release_target" ]]; then
    assert_release_target "$current_release_target"
    current_release_component_sha="$(basename -- "$current_release_target")"
    assert_sha "$current_release_component_sha"
  fi
  if [[ -n "$current_runtime_target" ]]; then
    assert_runtime_target "$current_runtime_target"
    current_runtime_component_sha="$(basename -- "$current_runtime_target")"
    assert_sha "$current_runtime_component_sha"
  fi
}

load_current_links() {
  current_release_sha=none
  load_current_components
  [[ "$current_release_component_sha" == "$current_runtime_component_sha" ]] || fail
  current_release_sha="$current_release_component_sha"
  assert_optional_sha "$current_release_sha"
  if [[ "$current_release_sha" == none ]]; then
    return 0
  fi
  assert_sha "$current_release_sha"
}

load_previous_links() {
  previous_release_target=
  previous_runtime_target=
  previous_release_sha=none
  resolve_optional_link "$base/previous" previous_release_target
  resolve_optional_link "$runtime_base/previous" previous_runtime_target
  if [[ -z "$previous_release_target" && -z "$previous_runtime_target" ]]; then
    return 0
  fi
  [[ -n "$previous_release_target" && -n "$previous_runtime_target" ]] || fail
  assert_release_target "$previous_release_target"
  assert_runtime_target "$previous_runtime_target"
  previous_release_sha="$(basename -- "$previous_release_target")"
  [[ "$previous_release_sha" == "$(basename -- "$previous_runtime_target")" ]] || fail
  assert_sha "$previous_release_sha"
}

select_activation_history() {
  local release_sha="$1"
  local current_sha="$2"
  local previous_sha="$3"
  assert_sha "$release_sha"
  assert_optional_sha "$current_sha"
  assert_optional_sha "$previous_sha"

  selected_rollback_sha=none
  selected_prior_previous_sha=none
  if [[ "$current_sha" == "$release_sha" ]]; then
    if [[ "$previous_sha" != "$current_sha" ]]; then
      selected_rollback_sha="$previous_sha"
    fi
  else
    selected_rollback_sha="$current_sha"
    if [[ "$previous_sha" != "$current_sha" ]]; then
      selected_prior_previous_sha="$previous_sha"
    fi
  fi
}

assert_health() {
  local url="$1"
  local application="$2"
  local release_sha="$3"
  assert_sha "$release_sha"
  case "$application" in
    web) [[ "$url" == http://127.0.0.1:3000/api/health/ready ]] || return 1 ;;
    backoffice) [[ "$url" == http://127.0.0.1:3001/api/health/ready ]] || return 1 ;;
    *) return 1 ;;
  esac
  if ! curl --disable --noproxy '*' --proto '=http' --fail --silent --show-error \
    --connect-timeout 2 --max-time 5 --max-filesize 65536 "$url" \
    | python3 -c '
import json
import re
import sys

application, release = sys.argv[1:]
raw = sys.stdin.buffer.read(65_537)
if len(raw) > 65_536:
    raise SystemExit(1)
try:
    payload = json.loads(raw.decode("utf-8"))
except (UnicodeDecodeError, json.JSONDecodeError):
    raise SystemExit(1)
if set(payload) != {"application", "checkedAt", "release", "requestId", "status"}:
    raise SystemExit(1)
if payload.get("application") != application or payload.get("release") != release:
    raise SystemExit(1)
if payload.get("status") != "ready":
    raise SystemExit(1)
if not isinstance(payload.get("checkedAt"), str):
    raise SystemExit(1)
if not re.fullmatch(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
    str(payload.get("requestId", "")),
    re.IGNORECASE,
):
    raise SystemExit(1)
    ' "$application" "$release_sha"; then
    return 1
  fi
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

systemd_load_state() {
  local state
  state="$(systemd_property "$1" LoadState)" || return 1
  [[ "$state" == loaded || "$state" == not-found ]] || return 1
  printf '%s\n' "$state"
}

systemd_active_state() {
  local state
  [[ "$(systemd_load_state "$1")" == loaded ]] || return 1
  state="$(systemd_property "$1" ActiveState)" || return 1
  [[ "$state" == active || "$state" == inactive || "$state" == failed ]] || return 1
  printf '%s\n' "$state"
}

restart_and_assert() {
  local release_sha="$1"
  if ! systemctl restart "$web_service" "$backoffice_service"; then
    return 1
  fi
  local attempt
  for ((attempt = 1; attempt <= 30; attempt += 1)); do
    if [[ "$(systemd_active_state "$web_service")" == active ]] \
      && [[ "$(systemd_active_state "$backoffice_service")" == active ]] \
      && assert_health http://127.0.0.1:3000/api/health/ready web "$release_sha" \
      && assert_health http://127.0.0.1:3001/api/health/ready backoffice "$release_sha"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

assert_service_inactive() {
  local service="$1"
  [[ "$(systemd_active_state "$service")" == inactive ]]
}

stop_failed_first_release() {
  local failed_sha="$1"
  load_current_components
  [[ "$current_release_component_sha" == none \
    || "$current_release_component_sha" == "$failed_sha" ]] || fail
  [[ "$current_runtime_component_sha" == none \
    || "$current_runtime_component_sha" == "$failed_sha" ]] || fail

  if ! systemctl stop "$web_service" "$backoffice_service"; then
    return 1
  fi
  assert_service_inactive "$web_service" || return 1
  assert_service_inactive "$backoffice_service" || return 1

  rm -f -- "$base/current" "$runtime_base/current" "$base/previous" "$runtime_base/previous" \
    || return 1
  durable_sync_directory "$base"
  durable_sync_directory "$runtime_base"
}

validate_runtime_credential() {
  local path="$1"
  local application="$2"
  local release_sha="$3"
  local canonical_sha
  local node_round_trip_sha
  canonical_sha="$(python3 - "$path" "$application" "$release_sha" <<'RUNTIME_CREDENTIAL_PY'
import hashlib
import json
import re
import sys
from urllib.parse import parse_qs, unquote, urlsplit

path, application, release = sys.argv[1:]
if application not in {"web", "backoffice"}:
    raise SystemExit(1)
expected = {
    "NODE_ENV",
    "APP_ENV",
    "APP_RELEASE_SHA",
    "NEXT_TELEMETRY_DISABLED",
    "HOSTNAME",
    "PORT",
    "NEXT_PUBLIC_APP_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "DATABASE_TLS_CA_PATH",
    "DATABASE_TLS_CA_SHA256",
    "DATABASE_URL_APP_DAL",
}
values = {}
with open(path, "rb") as source:
    raw = source.read()
if (
    not raw
    or len(raw) > 32768
    or b"\r" in raw
    or b"\x00" in raw
    or not raw.endswith(b"\n")
):
    raise SystemExit(1)
try:
    lines = raw.decode("ascii").splitlines()
except UnicodeDecodeError:
    raise SystemExit(1)
for raw_line in lines:
    match = re.fullmatch(r"([A-Z_][A-Z0-9_]*)='([^']+)'", raw_line)
    if match is None:
        raise SystemExit(1)
    key, value = match.groups()
    if key in values:
        raise SystemExit(1)
    values[key] = value
if set(values) != expected:
    raise SystemExit(1)
if values["NODE_ENV"] != "production" or values["APP_ENV"] != "production":
    raise SystemExit(1)
if values["APP_RELEASE_SHA"] != release or values["NEXT_TELEMETRY_DISABLED"] != "1":
    raise SystemExit(1)
if values["HOSTNAME"] != "127.0.0.1":
    raise SystemExit(1)
expected_port = "3000" if application == "web" else "3001"
expected_origin = "https://setlivre.com" if application == "web" else "https://ops.setlivre.com"
if values["PORT"] != expected_port or values["NEXT_PUBLIC_APP_URL"] != expected_origin:
    raise SystemExit(1)
expected_ca_path = (
    f"/run/credentials/setlivre-{application}.service/supabase-server-ca.pem"
)
if (
    values["DATABASE_TLS_CA_PATH"] != expected_ca_path
    or re.fullmatch(r"[0-9a-f]{64}", values["DATABASE_TLS_CA_SHA256"]) is None
):
    raise SystemExit(1)
supabase_match = re.fullmatch(
    r"https://([a-z0-9]{20})\.supabase\.co",
    values["NEXT_PUBLIC_SUPABASE_URL"],
)
if supabase_match is None:
    raise SystemExit(1)
project_ref = supabase_match.group(1)
if (
    re.fullmatch(
        r"sb_publishable_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{8}",
        values["NEXT_PUBLIC_SUPABASE_ANON_KEY"],
    )
    is None
):
    raise SystemExit(1)
raw_database_url = values["DATABASE_URL_APP_DAL"]
if any(character.isspace() or character in "'\"\\" for character in raw_database_url):
    raise SystemExit(1)
database = urlsplit(raw_database_url)
if (
    database.scheme not in {"postgres", "postgresql"}
    or database.hostname is None
    or database.username is None
    or database.password is None
    or database.path != "/postgres"
    or database.fragment
    or (database.port or 5432) != 5432
):
    raise SystemExit(1)
query = parse_qs(database.query, keep_blank_values=True, strict_parsing=True)
if set(query) != {"options"} or any(len(item) != 1 for item in query.values()):
    raise SystemExit(1)
if query["options"][0] != "-c role=app_dal":
    raise SystemExit(1)
hostname = database.hostname.lower()
username = unquote(database.username)
direct_host = f"db.{project_ref}.supabase.co"
pooler_host = re.fullmatch(r"[a-z0-9-]+\.pooler\.supabase\.com", hostname) is not None
if not (
    (hostname == direct_host and username == "app_runtime_prod")
    or (pooler_host and username == f"app_runtime_prod.{project_ref}")
):
    raise SystemExit(1)
serialized = json.dumps(
    values,
    ensure_ascii=False,
    separators=(",", ":"),
    sort_keys=True,
).encode("utf-8")
print(hashlib.sha256(serialized).hexdigest())
RUNTIME_CREDENTIAL_PY
  )" || fail
  assert_checksum "$canonical_sha"
  node_round_trip_sha="$(env -i \
    LANG=C.UTF-8 LC_ALL=C.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    node --env-file="$path" - <<'NODE'
const crypto = require("node:crypto");

const expected = [
  "APP_ENV",
  "APP_RELEASE_SHA",
  "DATABASE_TLS_CA_PATH",
  "DATABASE_TLS_CA_SHA256",
  "DATABASE_URL_APP_DAL",
  "HOSTNAME",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_TELEMETRY_DISABLED",
  "NODE_ENV",
  "PORT",
];
const values = {};
for (const key of expected) {
  const value = process.env[key];
  if (typeof value !== "string" || value.length === 0) {
    process.exit(1);
  }
  values[key] = value;
}
process.stdout.write(
  crypto.createHash("sha256").update(JSON.stringify(values), "utf8").digest("hex"),
);
NODE
  )" || fail
  [[ "$node_round_trip_sha" == "$canonical_sha" ]] || fail
}

public_build_config_sha256_from_credentials() {
  local web_credential="$1"
  local backoffice_credential="$2"
  python3 - "$web_credential" "$backoffice_credential" <<'PUBLIC_BUILD_CONFIG_PY'
import hashlib
import json
import re
import sys


def read_credential(path):
    with open(path, "rb") as source:
        raw = source.read()
    if not raw or b"\r" in raw or b"\x00" in raw or not raw.endswith(b"\n"):
        raise SystemExit(1)
    try:
        lines = raw.decode("ascii").splitlines()
    except UnicodeDecodeError:
        raise SystemExit(1)
    values = {}
    for line in lines:
        match = re.fullmatch(r"([A-Z_][A-Z0-9_]*)='([^']+)'", line)
        if match is None:
            raise SystemExit(1)
        key, value = match.groups()
        if key in values:
            raise SystemExit(1)
        values[key] = value
    return values


web = read_credential(sys.argv[1])
backoffice = read_credential(sys.argv[2])
shared_keys = (
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "DATABASE_TLS_CA_SHA256",
)
if any(web.get(key) != backoffice.get(key) for key in shared_keys):
    raise SystemExit(1)
configuration = {
    "backofficeAppUrl": backoffice.get("NEXT_PUBLIC_APP_URL"),
    "publicAppUrl": web.get("NEXT_PUBLIC_APP_URL"),
    "supabaseAnonKey": web.get("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    "supabaseUrl": web.get("NEXT_PUBLIC_SUPABASE_URL"),
}
if any(not isinstance(value, str) or not value for value in configuration.values()):
    raise SystemExit(1)
if re.fullmatch(r"https://[a-z0-9]{20}\.supabase\.co", configuration["supabaseUrl"]) is None:
    raise SystemExit(1)
if (
    configuration["publicAppUrl"] != "https://setlivre.com"
    or configuration["backofficeAppUrl"] != "https://ops.setlivre.com"
    or re.fullmatch(
        r"sb_publishable_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{8}",
        configuration["supabaseAnonKey"],
    )
    is None
):
    raise SystemExit(1)
serialized = json.dumps(
    configuration,
    ensure_ascii=False,
    separators=(",", ":"),
    sort_keys=True,
).encode("utf-8")
print(hashlib.sha256(serialized).hexdigest())
PUBLIC_BUILD_CONFIG_PY
}

validate_release_tree() {
  local release="$1"
  local release_sha="$2"
  local expected_lock_sha="$3"
  local expected_migration_head="$4"
  local expected_public_build_config_sha256="$5"
  assert_checksum "$expected_public_build_config_sha256"
  [[ -f "$release/manifest.json" && ! -L "$release/manifest.json" ]] || fail
  [[ -f "$release/package-lock.json" && ! -L "$release/package-lock.json" ]] || fail
  [[ -f "$release/web/server.js" && ! -L "$release/web/server.js" ]] || fail
  [[ -f "$release/backoffice/apps/backoffice/server.js" \
    && ! -L "$release/backoffice/apps/backoffice/server.js" ]] || fail
  [[ -f "$release/supabase/config.toml" && ! -L "$release/supabase/config.toml" ]] || fail
  [[ "$(tr -d '\r\n' <"$release/web/.next/BUILD_ID")" == "$release_sha" ]] || fail
  [[ "$(tr -d '\r\n' <"$release/backoffice/apps/backoffice/.next/BUILD_ID")" == "$release_sha" ]] || fail
  [[ "$(file_sha256 "$release/package-lock.json")" == "$expected_lock_sha" ]] || fail
  local physical_head
  physical_head="$(python3 - "$release/supabase/migrations" <<'PY'
import os
import re
import sys

directory = sys.argv[1]
try:
    entries = os.listdir(directory)
except OSError:
    raise SystemExit(1)
if not entries:
    raise SystemExit(1)
pattern = re.compile(r"([0-9]{14})_[A-Za-z0-9_]+\.sql")
versions = []
for name in entries:
    path = os.path.join(directory, name)
    match = pattern.fullmatch(name)
    if match is None or os.path.islink(path) or not os.path.isfile(path):
        raise SystemExit(1)
    versions.append(match.group(1))
if len(versions) != len(set(versions)):
    raise SystemExit(1)
print(max(versions))
PY
  )" || fail
  [[ "$physical_head" == "$expected_migration_head" ]] || fail
  local invalid_entry
  invalid_entry="$(find "$release" -xdev ! -type f ! -type d ! -type l -print -quit)" || fail
  [[ -z "$invalid_entry" ]] || fail
  python3 - \
    "$release" \
    "$release_sha" \
    "$expected_lock_sha" \
    "$expected_migration_head" \
    "$node_version" \
    "$expected_public_build_config_sha256" <<'PY'
import json
import os
import sys

(
    root,
    commit,
    lock_hash,
    migration_head,
    node_version,
    public_build_config_sha256,
) = sys.argv[1:]
root = os.path.realpath(root)
for directory, directories, files in os.walk(root, followlinks=False):
    for name in directories + files:
        path = os.path.join(directory, name)
        if os.path.islink(path):
            raise SystemExit(1)
        information = os.lstat(path)
        if name in files and information.st_nlink != 1:
            raise SystemExit(1)
with open(os.path.join(root, "manifest.json"), "r", encoding="utf-8") as source:
    manifest = json.load(source)
expected = {
    "schemaVersion": 4,
    "commit": commit,
    "publicBuildConfigSha256": public_build_config_sha256,
    "runtime": {"arch": "x64", "platform": "linux", "node": node_version},
    "applications": {
        "web": {"entrypoint": "web/server.js", "port": 3000},
        "backoffice": {"entrypoint": "backoffice/apps/backoffice/server.js", "port": 3001},
    },
    "migrations": {
        "directory": "supabase/migrations",
        "head": migration_head,
        "mode": "expand-only",
    },
    "lockfile": {"path": "package-lock.json", "sha256": lock_hash},
}
if manifest != expected:
    raise SystemExit(1)
PY
}

validate_release_archive() {
  local archive="$1"
  python3 - "$archive" <<'PY'
import posixpath
import sys
import tarfile
from pathlib import PurePosixPath

archive_path = sys.argv[1]
seen = set()
entry_count = 0
expanded_bytes = 0

try:
    archive = tarfile.open(archive_path, mode="r:gz")
except (OSError, tarfile.TarError):
    raise SystemExit(1)

with archive:
    for member in archive:
        entry_count += 1
        if entry_count > 100_000:
            raise SystemExit(1)
        raw_name = member.name
        if not raw_name or "\\" in raw_name or "\x00" in raw_name:
            raise SystemExit(1)
        path = PurePosixPath(raw_name)
        if path.is_absolute() or ".." in path.parts:
            raise SystemExit(1)
        normalized = posixpath.normpath(raw_name)
        parts = PurePosixPath(normalized).parts
        if not parts or parts[0] != "release":
            raise SystemExit(1)
        if normalized in seen:
            raise SystemExit(1)
        seen.add(normalized)
        if member.mode & 0o7000:
            raise SystemExit(1)
        if not (member.isfile() or member.isdir()):
            raise SystemExit(1)
        if normalized == "release" and not member.isdir():
            raise SystemExit(1)
        if member.isfile():
            expanded_bytes += member.size
            if expanded_bytes > 4 * 1024 * 1024 * 1024:
                raise SystemExit(1)

if "release" not in seen:
    raise SystemExit(1)
print(expanded_bytes)
PY
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

cleanup_private_tree() {
  local candidate="$1"
  local allowed_parent="$2"
  local candidate_mode
  local candidate_identity
  local original="$candidate"
  local retired="$allowed_parent/.cleanup-retired-${candidate##*/}"
  local unsafe_entry
  [[ "$candidate" == "$allowed_parent/"* && "$candidate" != "$allowed_parent/" ]] || return 1
  cleanup_private_target_is_authorized "$candidate" "$allowed_parent" || return 1
  [[ -d "$allowed_parent" && ! -L "$allowed_parent" ]] || return 1
  [[ "$(readlink --canonicalize-existing -- "$allowed_parent")" == "$allowed_parent" ]] \
    || return 1
  [[ "$retired" == "$allowed_parent/.cleanup-retired-"* && "$retired" != "$original" ]] \
    || return 1
  if [[ -e "$retired" || -L "$retired" ]]; then
    [[ ! -e "$original" && ! -L "$original" ]] || return 1
    candidate="$retired"
  elif [[ ! -e "$candidate" && ! -L "$candidate" ]]; then
    return 0
  fi
  [[ -d "$candidate" && ! -L "$candidate" ]] || return 1
  [[ "$(readlink --canonicalize-existing -- "$candidate")" == "$candidate" ]] || return 1
  [[ "$(stat -c '%U' -- "$candidate")" == root ]] || return 1
  candidate_mode="$(stat -c '%a' -- "$candidate")" || return 1
  [[ "$candidate_mode" =~ ^[0-7]{3,4}$ ]] || return 1
  (((8#$candidate_mode & 8#022) == 0)) || return 1
  [[ "$(stat -c '%d' -- "$candidate")" == "$(stat -c '%d' -- "$allowed_parent")" ]] \
    || return 1
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
  durable_sync_directory "$allowed_parent" || return 1
  [[ ! -e "$retired" && ! -L "$retired" ]] || return 1
}

cleanup_activation_resources() {
  local cleanup_status=0
  if [[ -n "$activation_private_staging" ]]; then
    cleanup_private_tree "$activation_private_staging" "$private_staging_base" || cleanup_status=1
  fi
  if [[ -n "$activation_release_candidate" ]]; then
    cleanup_private_tree "$activation_release_candidate" "$releases" || cleanup_status=1
  fi
  if [[ -n "$activation_runtime_candidate" ]]; then
    cleanup_private_tree "$activation_runtime_candidate" "$runtime_base/releases" || cleanup_status=1
  fi
  if [[ "$activation_lease_armed" -eq 0 && -n "$activation_pending_state" ]]; then
    rm -f -- "$activation_pending_state" || cleanup_status=1
    durable_sync_directory "$state_base" || cleanup_status=1
  fi
  if [[ "$cleanup_status" -eq 0 && -n "$activation_preflight_state" ]]; then
    [[ "$activation_preflight_state" == "$preflight_state" ]] || cleanup_status=1
    rm -f -- "$activation_preflight_state" || cleanup_status=1
    durable_sync_directory "$state_base" || cleanup_status=1
  fi
  if [[ "$cleanup_status" -eq 0 ]]; then
    activation_private_staging=
    activation_release_candidate=
    activation_runtime_candidate=
    activation_pending_state=
    activation_preflight_state=
    activation_lease_armed=0
  fi
  return "$cleanup_status"
}

assert_cleanup_resource_targets() {
  local private_staging="$1"
  local release_candidate="$2"
  local runtime_candidate="$3"
  local pending_state="$4"
  local staged_preflight_state="$5"
  local resource_sha=
  local candidate_sha
  local pending_sha
  if [[ "$private_staging" != none ]]; then
    [[ "$private_staging" == "$private_staging_base/"* ]] || return 1
    candidate_sha="${private_staging#"$private_staging_base/"}"
    [[ "$candidate_sha" =~ ^[0-9a-f]{40}$ ]] || return 1
    resource_sha="$candidate_sha"
  fi
  if [[ "$release_candidate" != none ]]; then
    [[ "$release_candidate" == "$releases/.incoming-"* ]] || return 1
    candidate_sha="${release_candidate#"$releases/.incoming-"}"
    [[ "$candidate_sha" =~ ^[0-9a-f]{40}$ ]] || return 1
    [[ -z "$resource_sha" || "$candidate_sha" == "$resource_sha" ]] || return 1
    resource_sha="$candidate_sha"
  fi
  if [[ "$runtime_candidate" != none ]]; then
    [[ "$runtime_candidate" == "$runtime_base/releases/.incoming-"* ]] || return 1
    candidate_sha="${runtime_candidate#"$runtime_base/releases/.incoming-"}"
    [[ "$candidate_sha" =~ ^[0-9a-f]{40}$ ]] || return 1
    [[ -z "$resource_sha" || "$candidate_sha" == "$resource_sha" ]] || return 1
    resource_sha="$candidate_sha"
  fi
  [[ -n "$resource_sha" ]] || return 1
  if [[ "$pending_state" != none ]]; then
    [[ "$pending_state" == "$state_base/"*.pending ]] || return 1
    pending_sha="${pending_state#"$state_base/"}"
    pending_sha="${pending_sha%.pending}"
    [[ "$pending_sha" == "$resource_sha" ]] || return 1
  fi
  [[ "$staged_preflight_state" == none || "$staged_preflight_state" == "$preflight_state" ]] \
    || return 1
}

write_cleanup_pending_state() {
  local private_staging="${activation_private_staging:-none}"
  local release_candidate="${activation_release_candidate:-none}"
  local runtime_candidate="${activation_runtime_candidate:-none}"
  local pending_state=none
  local staged_preflight_state=none
  if [[ "$activation_lease_armed" -eq 0 && -n "$activation_pending_state" ]]; then
    pending_state="$activation_pending_state"
  fi
  if [[ -n "$activation_preflight_state" ]]; then
    staged_preflight_state="$activation_preflight_state"
  fi
  assert_cleanup_resource_targets \
    "$private_staging" \
    "$release_candidate" \
    "$runtime_candidate" \
    "$pending_state" \
    "$staged_preflight_state" || return 1
  write_root_state_file \
    "$cleanup_pending_state" \
    protocol=5 \
    "private_staging=$private_staging" \
    "release_candidate=$release_candidate" \
    "runtime_candidate=$runtime_candidate" \
    "pending_state=$pending_state" \
    "preflight_state=$staged_preflight_state"
}

clear_cleanup_pending_state() {
  if [[ ! -e "$cleanup_pending_state" && ! -L "$cleanup_pending_state" ]]; then
    return 0
  fi
  assert_root_private_file "$cleanup_pending_state" || return 1
  rm -f -- "$cleanup_pending_state" || return 1
  durable_sync_directory "$state_base" || return 1
  [[ ! -e "$cleanup_pending_state" && ! -L "$cleanup_pending_state" ]] || return 1
}

load_cleanup_pending_state() {
  local -a lines=()
  assert_root_private_file "$cleanup_pending_state"
  mapfile -t lines <"$cleanup_pending_state"
  [[ "${#lines[@]}" -eq 6 ]] || fail
  [[ "${lines[0]}" == protocol=5 ]] || fail
  [[ "${lines[1]}" == private_staging=* ]] || fail
  [[ "${lines[2]}" == release_candidate=* ]] || fail
  [[ "${lines[3]}" == runtime_candidate=* ]] || fail
  [[ "${lines[4]}" == pending_state=* ]] || fail
  [[ "${lines[5]}" == preflight_state=* ]] || fail
  activation_private_staging="${lines[1]#private_staging=}"
  [[ "$activation_private_staging" != none ]] || activation_private_staging=
  activation_release_candidate="${lines[2]#release_candidate=}"
  [[ "$activation_release_candidate" != none ]] || activation_release_candidate=
  activation_runtime_candidate="${lines[3]#runtime_candidate=}"
  [[ "$activation_runtime_candidate" != none ]] || activation_runtime_candidate=
  activation_pending_state="${lines[4]#pending_state=}"
  [[ "$activation_pending_state" != none ]] || activation_pending_state=
  activation_preflight_state="${lines[5]#preflight_state=}"
  [[ "$activation_preflight_state" != none ]] || activation_preflight_state=
  activation_lease_armed=0
  assert_cleanup_resource_targets \
    "${activation_private_staging:-none}" \
    "${activation_release_candidate:-none}" \
    "${activation_runtime_candidate:-none}" \
    "${activation_pending_state:-none}" \
    "${activation_preflight_state:-none}" || fail
}

cleanup_private_target_is_authorized() {
  local candidate="$1"
  local allowed_parent="$2"
  local -a lines=()
  assert_root_private_file "$cleanup_pending_state" || return 1
  mapfile -t lines <"$cleanup_pending_state"
  [[ "${#lines[@]}" -eq 6 && "${lines[0]}" == protocol=5 ]] || return 1
  [[ "${lines[1]}" == private_staging=* ]] || return 1
  [[ "${lines[2]}" == release_candidate=* ]] || return 1
  [[ "${lines[3]}" == runtime_candidate=* ]] || return 1
  [[ "${lines[4]}" == pending_state=* ]] || return 1
  [[ "${lines[5]}" == preflight_state=* ]] || return 1
  local private_staging="${lines[1]#private_staging=}"
  local release_candidate="${lines[2]#release_candidate=}"
  local runtime_candidate="${lines[3]#runtime_candidate=}"
  assert_cleanup_resource_targets \
    "$private_staging" \
    "$release_candidate" \
    "$runtime_candidate" \
    "${lines[4]#pending_state=}" \
    "${lines[5]#preflight_state=}" || return 1
  case "$allowed_parent" in
    "$private_staging_base") [[ "$candidate" == "$private_staging" ]] ;;
    "$releases") [[ "$candidate" == "$release_candidate" ]] ;;
    "$runtime_base/releases") [[ "$candidate" == "$runtime_candidate" ]] ;;
    *) return 1 ;;
  esac
}

recover_pending_cleanup_locked() {
  if [[ ! -e "$cleanup_pending_state" && ! -L "$cleanup_pending_state" ]]; then
    return 0
  fi
  load_cleanup_pending_state
  cleanup_activation_resources || fail
  clear_cleanup_pending_state || fail
}

cleanup_activation() {
  local status=$?
  trap - EXIT HUP INT TERM
  set +e
  local cleanup_state_ready=1
  if [[ ! -e "$cleanup_pending_state" && ! -L "$cleanup_pending_state" ]]; then
    write_cleanup_pending_state || cleanup_state_ready=0
  fi
  if [[ "$cleanup_state_ready" -ne 1 ]]; then
    status=1
  elif ! cleanup_activation_resources; then
    status=1
  elif ! clear_cleanup_pending_state; then
    status=1
  fi
  exit "$status"
}

pending_state_path() {
  printf '%s/%s.pending' "$state_base" "$1"
}

recovery_pending_path() {
  printf '%s/recovery.pending' "$state_base"
}

confirmed_state_path() {
  printf '%s/%s.confirmed' "$state_base" "$1"
}

activation_result_path() {
  local release_sha="$1"
  assert_sha "$release_sha"
  printf '%s/%s.activation-result' "$state_base" "$release_sha"
}

break_glass_result_path() {
  local source_sha="$1"
  assert_sha "$source_sha"
  printf '%s/%s.break-glass-rollback' "$state_base" "$source_sha"
}

write_root_state_file() {
  local destination="$1"
  shift
  local temporary
  temporary="$(mktemp --tmpdir="$state_base" '.state.XXXXXXXX')"
  chown root:root "$temporary"
  chmod 0600 "$temporary"
  printf '%s\n' "$@" >"$temporary"
  sync -f "$temporary"
  mv -Tf -- "$temporary" "$destination"
  durable_sync_directory "$state_base"
  assert_root_private_file "$destination"
}

release_provenance_path() {
  local release_sha="$1"
  assert_sha "$release_sha"
  printf '%s/%s.provenance' "$provenance_base" "$release_sha"
}

assert_release_provenance_record() {
  local release_sha="$1"
  local path
  local -a lines=()
  assert_sha "$release_sha"
  path="$(release_provenance_path "$release_sha")"
  assert_root_private_file "$path"
  mapfile -t lines <"$path"
  [[ "${#lines[@]}" -eq 10 ]] || fail
  [[ "${lines[0]}" == protocol=3 ]] || fail
  [[ "${lines[1]}" == "release_sha=$release_sha" ]] || fail
  [[ "${lines[2]}" =~ ^archive_sha=([0-9a-f]{64})$ ]] || fail
  [[ "${lines[3]}" =~ ^lock_sha=([0-9a-f]{64})$ ]] || fail
  [[ "${lines[4]}" =~ ^migration_head=([0-9]{14})$ ]] || fail
  [[ "${lines[5]}" =~ ^run_number=([1-9][0-9]*)$ ]] || fail
  assert_positive_integer "${BASH_REMATCH[1]}"
  [[ "${lines[6]}" =~ ^run_attempt=([1-9][0-9]*)$ ]] || fail
  assert_positive_integer "${BASH_REMATCH[1]}"
  [[ "${lines[7]}" =~ ^run_id=([1-9][0-9]*)$ ]] || fail
  assert_positive_integer "${BASH_REMATCH[1]}"
  [[ "${lines[8]}" =~ ^artifact_id=([1-9][0-9]*)$ ]] || fail
  assert_positive_integer "${BASH_REMATCH[1]}"
  [[ "${lines[9]}" =~ ^artifact_digest=([0-9a-f]{64})$ ]] || fail
}

write_release_provenance() {
  local release_sha="$1"
  local archive_sha="$2"
  local lock_sha="$3"
  local migration_head="$4"
  local run_number="$5"
  local run_attempt="$6"
  local run_id="$7"
  local artifact_id="$8"
  local artifact_digest="$9"
  assert_sha "$release_sha"
  assert_checksum "$archive_sha"
  assert_checksum "$lock_sha"
  [[ "$migration_head" =~ ^[0-9]{14}$ ]] || fail
  assert_positive_integer "$run_number"
  assert_positive_integer "$run_attempt"
  assert_positive_integer "$run_id"
  assert_positive_integer "$artifact_id"
  assert_checksum "$artifact_digest"
  local destination
  local temporary
  destination="$(release_provenance_path "$release_sha")"
  [[ ! -e "$destination" && ! -L "$destination" ]] || fail
  temporary="$(mktemp --tmpdir="$state_base" '.provenance.XXXXXXXX')"
  chown root:root "$temporary"
  chmod 0600 "$temporary"
  printf '%s\n' \
    'protocol=3' \
    "release_sha=$release_sha" \
    "archive_sha=$archive_sha" \
    "lock_sha=$lock_sha" \
    "migration_head=$migration_head" \
    "run_number=$run_number" \
    "run_attempt=$run_attempt" \
    "run_id=$run_id" \
    "artifact_id=$artifact_id" \
    "artifact_digest=$artifact_digest" \
    >"$temporary"
  sync -f "$temporary"
  mv -Tn -- "$temporary" "$destination"
  if [[ -e "$temporary" || -L "$temporary" ]]; then
    rm -f -- "$temporary"
    fail
  fi
  durable_sync_directory "$state_base"
  assert_root_private_file "$destination"
}

assert_release_provenance() {
  local release_sha="$1"
  local archive_sha="$2"
  local lock_sha="$3"
  local migration_head="$4"
  local run_number="$5"
  local run_attempt="$6"
  local run_id="$7"
  local artifact_id="$8"
  local artifact_digest="$9"
  local path
  local -a lines=()
  path="$(release_provenance_path "$release_sha")"
  assert_release_provenance_record "$release_sha"
  mapfile -t lines <"$path"
  [[ "${lines[2]}" == "archive_sha=$archive_sha" ]] || fail
  [[ "${lines[3]}" == "lock_sha=$lock_sha" ]] || fail
  [[ "${lines[4]}" == "migration_head=$migration_head" ]] || fail
  [[ "${lines[5]}" == "run_number=$run_number" ]] || fail
  [[ "${lines[6]}" == "run_attempt=$run_attempt" ]] || fail
  [[ "${lines[7]}" == "run_id=$run_id" ]] || fail
  [[ "${lines[8]}" == "artifact_id=$artifact_id" ]] || fail
  [[ "${lines[9]}" == "artifact_digest=$artifact_digest" ]] || fail
}

ensure_release_provenance() {
  local release_sha="$1"
  shift
  local path
  path="$(release_provenance_path "$release_sha")"
  if [[ -e "$path" || -L "$path" ]]; then
    assert_release_provenance "$release_sha" "$@"
    return 0
  fi
  write_release_provenance "$release_sha" "$@"
  assert_release_provenance "$release_sha" "$@"
}

write_pending_state() {
  local release_sha="$1"
  local rollback_sha="$2"
  local prior_previous_sha="$3"
  local activation_deadline="$4"
  assert_sha "$release_sha"
  assert_optional_sha "$rollback_sha"
  assert_optional_sha "$prior_previous_sha"
  assert_positive_integer "$activation_deadline"
  write_root_state_file "$(pending_state_path "$release_sha")" \
    "protocol=3" \
    "release_sha=$release_sha" \
    "rollback_sha=$rollback_sha" \
    "prior_previous_sha=$prior_previous_sha" \
    "activation_deadline=$activation_deadline"
}

load_pending_state() {
  local requested_sha="$1"
  local path
  local -a lines=()
  assert_sha "$requested_sha"
  path="$(pending_state_path "$requested_sha")"
  assert_root_private_file "$path"
  mapfile -t lines <"$path"
  [[ "${#lines[@]}" -eq 5 ]] || fail
  [[ "${lines[0]}" == protocol=3 ]] || fail
  [[ "${lines[1]}" == "release_sha=$requested_sha" ]] || fail
  [[ "${lines[2]}" =~ ^rollback_sha=(none|[0-9a-f]{40})$ ]] || fail
  [[ "${lines[3]}" =~ ^prior_previous_sha=(none|[0-9a-f]{40})$ ]] || fail
  [[ "${lines[4]}" =~ ^activation_deadline=([1-9][0-9]*)$ ]] || fail
  pending_rollback_sha="${lines[2]#rollback_sha=}"
  pending_prior_previous_sha="${lines[3]#prior_previous_sha=}"
  pending_activation_deadline="${lines[4]#activation_deadline=}"
  assert_positive_integer "$pending_activation_deadline"
}

assert_activation_result_state() {
  local release_sha="$1"
  local expected_result="$2"
  local expected_active_sha="$3"
  local path
  local -a lines=()
  assert_sha "$release_sha"
  [[ "$expected_result" == confirmed || "$expected_result" == rejected ]] || fail
  assert_optional_sha "$expected_active_sha"
  if [[ "$expected_result" == confirmed ]]; then
    [[ "$expected_active_sha" == "$release_sha" ]] || fail
  else
    [[ "$expected_active_sha" != "$release_sha" ]] || fail
  fi
  path="$(activation_result_path "$release_sha")"
  assert_root_private_file "$path"
  mapfile -t lines <"$path"
  [[ "${#lines[@]}" -eq 5 ]] || fail
  [[ "${lines[0]}" == protocol=3 ]] || fail
  [[ "${lines[1]}" == operation=activation ]] || fail
  [[ "${lines[2]}" == "release_sha=$release_sha" ]] || fail
  [[ "${lines[3]}" == "result=$expected_result" ]] || fail
  [[ "${lines[4]}" == "active_sha=$expected_active_sha" ]] || fail
}

write_activation_result_state() {
  local release_sha="$1"
  local result="$2"
  local active_sha="$3"
  local path
  assert_sha "$release_sha"
  [[ "$result" == confirmed || "$result" == rejected ]] || fail
  assert_optional_sha "$active_sha"
  if [[ "$result" == confirmed ]]; then
    [[ "$active_sha" == "$release_sha" ]] || fail
  else
    [[ "$active_sha" != "$release_sha" ]] || fail
  fi
  path="$(activation_result_path "$release_sha")"
  if [[ -e "$path" || -L "$path" ]]; then
    assert_activation_result_state "$release_sha" "$result" "$active_sha"
    return 0
  fi
  write_root_state_file "$path" \
    protocol=3 \
    operation=activation \
    "release_sha=$release_sha" \
    "result=$result" \
    "active_sha=$active_sha"
  assert_activation_result_state "$release_sha" "$result" "$active_sha"
}

assert_recovery_state_values() {
  local operation="$1"
  local source_sha="$2"
  local requested_sha="$3"
  local active_sha="$4"
  local previous_sha="$5"
  local phase="$6"
  assert_sha "$source_sha"
  assert_optional_sha "$requested_sha"
  assert_optional_sha "$active_sha"
  assert_optional_sha "$previous_sha"

  case "$operation:$phase" in
    activation:recovery)
      [[ "$requested_sha" == "$active_sha" ]] || fail
      if [[ "$active_sha" == none ]]; then
        [[ "$previous_sha" == none ]] || fail
      else
        [[ "$source_sha" != "$active_sha" && "$previous_sha" != "$active_sha" ]] || fail
      fi
      ;;
    break-glass:recovery)
      [[ "$requested_sha" != none && "$source_sha" != "$requested_sha" ]] || fail
      [[ "$active_sha" == "$requested_sha" && "$previous_sha" == "$source_sha" ]] || fail
      ;;
    break-glass:source)
      [[ "$requested_sha" != none && "$source_sha" != "$requested_sha" ]] || fail
      [[ "$active_sha" == "$source_sha" && "$previous_sha" == "$requested_sha" ]] || fail
      ;;
    *) fail ;;
  esac
}

write_recovery_state() {
  local operation="$1"
  local source_sha="$2"
  local requested_sha="$3"
  local active_sha="$4"
  local previous_sha="$5"
  local phase="$6"
  assert_recovery_state_values \
    "$operation" "$source_sha" "$requested_sha" "$active_sha" "$previous_sha" "$phase"
  write_root_state_file "$(recovery_pending_path)" \
    "protocol=3" \
    "operation=$operation" \
    "source_sha=$source_sha" \
    "requested_sha=$requested_sha" \
    "active_sha=$active_sha" \
    "previous_sha=$previous_sha" \
    "phase=$phase"
}

load_recovery_state() {
  local path
  local -a lines=()
  path="$(recovery_pending_path)"
  assert_root_private_file "$path"
  mapfile -t lines <"$path"
  [[ "${#lines[@]}" -eq 7 ]] || fail
  [[ "${lines[0]}" == protocol=3 ]] || fail
  [[ "${lines[1]}" =~ ^operation=(activation|break-glass)$ ]] || fail
  [[ "${lines[2]}" =~ ^source_sha=([0-9a-f]{40})$ ]] || fail
  [[ "${lines[3]}" =~ ^requested_sha=(none|[0-9a-f]{40})$ ]] || fail
  [[ "${lines[4]}" =~ ^active_sha=(none|[0-9a-f]{40})$ ]] || fail
  [[ "${lines[5]}" =~ ^previous_sha=(none|[0-9a-f]{40})$ ]] || fail
  [[ "${lines[6]}" =~ ^phase=(recovery|source)$ ]] || fail
  recovery_operation="${lines[1]#operation=}"
  recovery_source_sha="${lines[2]#source_sha=}"
  recovery_requested_sha="${lines[3]#requested_sha=}"
  recovery_active_sha="${lines[4]#active_sha=}"
  recovery_previous_sha="${lines[5]#previous_sha=}"
  recovery_phase="${lines[6]#phase=}"
  assert_recovery_state_values \
    "$recovery_operation" \
    "$recovery_source_sha" \
    "$recovery_requested_sha" \
    "$recovery_active_sha" \
    "$recovery_previous_sha" \
    "$recovery_phase"
}

write_confirmed_state() {
  local release_sha="$1"
  assert_sha "$release_sha"
  write_root_state_file "$(confirmed_state_path "$release_sha")" \
    "protocol=3" \
    "release_sha=$release_sha"
}

is_confirmed() {
  local release_sha="$1"
  local path
  local -a lines=()
  assert_sha "$release_sha"
  path="$(confirmed_state_path "$release_sha")"
  if [[ ! -e "$path" && ! -L "$path" ]]; then
    return 1
  fi
  assert_root_private_file "$path"
  mapfile -t lines <"$path"
  [[ "${#lines[@]}" -eq 2 ]] || fail
  [[ "${lines[0]}" == protocol=3 ]] || fail
  [[ "${lines[1]}" == "release_sha=$release_sha" ]] || fail
}

write_break_glass_result_state() {
  local source_sha="$1"
  local requested_sha="$2"
  local -a activation_pending_paths=()
  local result="$3"
  local current_sha="$4"
  local previous_sha="$5"
  assert_sha "$source_sha"
  assert_sha "$requested_sha"
  assert_sha "$current_sha"
  assert_sha "$previous_sha"
  [[ "$source_sha" != "$requested_sha" ]] || fail
  case "$result" in
    confirmed)
      [[ "$current_sha" == "$requested_sha" && "$previous_sha" == "$source_sha" ]] || fail
      ;;
    rejected)
      [[ "$current_sha" == "$source_sha" && "$previous_sha" == "$requested_sha" ]] || fail
      ;;
    *) fail ;;
  esac
  write_root_state_file "$(break_glass_result_path "$source_sha")" \
    "protocol=3" \
    "operation=break-glass" \
    "source_sha=$source_sha" \
    "requested_sha=$requested_sha" \
    "result=$result" \
    "current_sha=$current_sha" \
    "previous_sha=$previous_sha"
}

assert_break_glass_result_state() {
  local source_sha="$1"
  local requested_sha="$2"
  local result="$3"
  local current_sha="$4"
  local previous_sha="$5"
  local path
  local -a lines=()
  assert_sha "$source_sha"
  assert_sha "$requested_sha"
  assert_sha "$current_sha"
  assert_sha "$previous_sha"
  [[ "$result" == confirmed || "$result" == rejected ]] || fail
  path="$(break_glass_result_path "$source_sha")"
  assert_root_private_file "$path"
  mapfile -t lines <"$path"
  [[ "${#lines[@]}" -eq 7 ]] || fail
  [[ "${lines[0]}" == protocol=3 ]] || fail
  [[ "${lines[1]}" == operation=break-glass ]] || fail
  [[ "${lines[2]}" == "source_sha=$source_sha" ]] || fail
  [[ "${lines[3]}" == "requested_sha=$requested_sha" ]] || fail
  [[ "${lines[4]}" == "result=$result" ]] || fail
  [[ "${lines[5]}" == "current_sha=$current_sha" ]] || fail
  [[ "${lines[6]}" == "previous_sha=$previous_sha" ]] || fail
}

watchdog_unit() {
  printf 'setlivre-release-rollback-%s' "$1"
}

assert_watchdog_service_inactive() {
  local unit
  local load_state
  local active_state
  unit="$(watchdog_unit "$1")"
  load_state="$(systemd_load_state "$unit.service")" || fail
  if [[ "$load_state" == not-found ]]; then
    return 0
  fi
  active_state="$(systemd_active_state "$unit.service")" || fail
  [[ "$active_state" == inactive || "$active_state" == failed ]] || fail
}

stop_watchdog_timer() {
  local unit
  local load_state
  unit="$(watchdog_unit "$1")"
  load_state="$(systemd_load_state "$unit.timer")" || fail
  if [[ "$load_state" == not-found ]]; then
    return 0
  fi
  systemctl stop "$unit.timer" >/dev/null 2>&1 || fail
  [[ "$(systemd_active_state "$unit.timer")" == inactive ]] || fail
}

reset_inactive_watchdog_units() {
  local unit
  local candidate
  local load_state
  local -a loaded_units=()
  unit="$(watchdog_unit "$1")"
  for candidate in "$unit.timer" "$unit.service"; do
    load_state="$(systemd_load_state "$candidate")" || fail
    [[ "$load_state" == not-found ]] || loaded_units+=("$candidate")
  done
  if [[ "${#loaded_units[@]}" -gt 0 ]]; then
    systemctl reset-failed "${loaded_units[@]}" >/dev/null 2>&1 || fail
  fi
}

schedule_watchdog() {
  local release_sha="$1"
  local activation_deadline="$2"
  local unit
  local now
  local remaining_seconds
  assert_sha "$release_sha"
  assert_positive_integer "$activation_deadline"
  now="$(monotonic_seconds)" || fail
  assert_positive_integer "$now"
  ((activation_deadline > now)) || fail
  remaining_seconds=$((activation_deadline - now))
  assert_positive_integer "$remaining_seconds"
  unit="$(watchdog_unit "$release_sha")"
  env -i PATH="$PATH" LANG="$LANG" LC_ALL="$LC_ALL" systemd-run \
    --quiet \
    --collect \
    --unit="$unit" \
    --on-active="${remaining_seconds}s" \
    --timer-property=AccuracySec=1s \
    --property=Type=oneshot \
    --property=User=root \
    --property=Group=root \
    --property=UMask=0077 \
    --property=NoNewPrivileges=yes \
    --property=PrivateTmp=yes \
    --property=ProtectHome=yes \
    --property=ProtectSystem=strict \
    --property=ReadWritePaths="$base" \
    --property=ReadWritePaths=/run/lock \
    "$manager_path" watchdog "$release_sha"
  [[ "$(systemd_active_state "$unit.timer")" == active ]] || fail
}

run_recovery_smoke() {
  local release_sha="$1"
  assert_sha "$release_sha"
  assert_installed_smoke
  [[ "$(node --version)" == "$node_version" ]] || fail
  env -i \
    HOME=/root \
    LANG="$LANG" \
    LC_ALL="$LC_ALL" \
    PATH="$PATH" \
    PRD_BACKOFFICE_APP_URL="$backoffice_app_url" \
    PRD_PUBLIC_APP_URL="$public_app_url" \
    RELEASE_SHA="$release_sha" \
    SMOKE_ATTEMPTS="$smoke_attempts" \
    SMOKE_INTERVAL_MS="$smoke_interval_ms" \
    timeout --signal=TERM --kill-after=30s "${smoke_timeout_seconds}s" \
      node "$production_smoke" >/dev/null
}

restore_previous_pointer() {
  local current_sha="$1"
  local prior_previous_sha="$2"
  assert_sha "$current_sha"
  assert_optional_sha "$prior_previous_sha"
  if [[ "$prior_previous_sha" == none || "$prior_previous_sha" == "$current_sha" ]]; then
    rm -f -- "$base/previous" "$runtime_base/previous"
    durable_sync_directory "$base"
    durable_sync_directory "$runtime_base"
    return 0
  fi
  local release="$releases/$prior_previous_sha"
  local runtime="$runtime_base/releases/$prior_previous_sha"
  assert_release_target "$release"
  assert_runtime_target "$runtime"
  atomic_link "$release" "$base/previous"
  atomic_link "$runtime" "$runtime_base/previous"
}

assert_recovery_pointer_state() {
  local active_sha="$1"
  local previous_sha="$2"
  assert_optional_sha "$active_sha"
  assert_optional_sha "$previous_sha"
  load_current_links
  load_previous_links
  [[ "$current_release_sha" == "$active_sha" ]] || fail
  [[ "$previous_release_sha" == "$previous_sha" ]] || fail
}

apply_recovery_active_release() {
  local operation="$1"
  local source_sha="$2"
  local requested_sha="$3"
  local active_sha="$4"
  assert_recovery_state_values \
    "$operation" "$source_sha" "$requested_sha" "$active_sha" "$recovery_previous_sha" "$recovery_phase"
  load_current_components

  if [[ "$active_sha" == none ]]; then
    [[ "$operation" == activation && "$requested_sha" == none ]] || fail
    [[ "$current_release_component_sha" == none \
      || "$current_release_component_sha" == "$source_sha" ]] || fail
    [[ "$current_runtime_component_sha" == none \
      || "$current_runtime_component_sha" == "$source_sha" ]] || fail
    stop_failed_first_release "$source_sha"
    return
  fi

  [[ "$current_release_component_sha" == "$source_sha" \
    || "$current_release_component_sha" == "$requested_sha" ]] || fail
  [[ "$current_runtime_component_sha" == "$source_sha" \
    || "$current_runtime_component_sha" == "$requested_sha" ]] || fail
  local active_release="$releases/$active_sha"
  local active_runtime="$runtime_base/releases/$active_sha"
  assert_release_target "$active_release"
  assert_runtime_target "$active_runtime"
  atomic_link "$active_release" "$base/current" || fail
  atomic_link "$active_runtime" "$runtime_base/current" || fail
  restart_and_assert "$active_sha"
}

finalize_recovery_state() {
  local operation="$1"
  local source_sha="$2"
  assert_sha "$source_sha"
  [[ "$operation" == activation || "$operation" == break-glass ]] || fail
  load_recovery_state
  [[ "$recovery_operation" == "$operation" && "$recovery_source_sha" == "$source_sha" ]] || fail

  if [[ "$operation" == activation ]]; then
    stop_watchdog_timer "$source_sha"
    rm -f -- "$(pending_state_path "$source_sha")" "$(confirmed_state_path "$source_sha")"
    durable_sync_directory "$state_base"
  else
    is_confirmed "$recovery_source_sha" || fail
    is_confirmed "$recovery_requested_sha" || fail
    if [[ "$recovery_phase" == recovery ]]; then
      assert_break_glass_result_state \
        "$recovery_source_sha" \
        "$recovery_requested_sha" \
        confirmed \
        "$recovery_active_sha" \
        "$recovery_previous_sha"
    else
      assert_break_glass_result_state \
        "$recovery_source_sha" \
        "$recovery_requested_sha" \
        rejected \
        "$recovery_active_sha" \
        "$recovery_previous_sha"
    fi
  fi

  rm -f -- "$(recovery_pending_path)"
  durable_sync_directory "$state_base"
  if [[ "$operation" == activation ]]; then
    reset_inactive_watchdog_units "$source_sha"
  fi
}

complete_recovery_locked() {
  recovery_outcome=
  load_recovery_state
  local operation="$recovery_operation"
  local source_sha="$recovery_source_sha"
  local requested_sha="$recovery_requested_sha"

  if [[ "$operation" == activation ]]; then
    local terminal_path
    terminal_path="$(activation_result_path "$source_sha")" || fail
    if [[ -e "$terminal_path" || -L "$terminal_path" ]]; then
      assert_activation_result_state "$source_sha" rejected "$recovery_active_sha"
      assert_recovery_pointer_state "$recovery_active_sha" "$recovery_previous_sha"
      finalize_recovery_state "$operation" "$source_sha"
      recovery_outcome=confirmed
      return 0
    fi
    apply_recovery_active_release \
      "$operation" "$source_sha" "$requested_sha" "$recovery_active_sha" || fail
    if [[ "$recovery_active_sha" == none ]]; then
      load_current_links
      [[ "$current_release_sha" == none ]] || fail
      assert_service_inactive "$web_service" || fail
      assert_service_inactive "$backoffice_service" || fail
    else
      restore_previous_pointer "$recovery_active_sha" "$recovery_previous_sha"
      run_recovery_smoke "$recovery_active_sha" || fail
    fi
    assert_recovery_pointer_state "$recovery_active_sha" "$recovery_previous_sha"
    write_activation_result_state "$source_sha" rejected "$recovery_active_sha"
    finalize_recovery_state "$operation" "$source_sha"
    recovery_outcome=confirmed
    return 0
  fi

  if [[ "$recovery_phase" == recovery ]]; then
    if apply_recovery_active_release \
      "$operation" "$source_sha" "$requested_sha" "$recovery_active_sha"; then
      restore_previous_pointer "$recovery_active_sha" "$recovery_previous_sha"
      if run_recovery_smoke "$recovery_active_sha"; then
        assert_recovery_pointer_state "$recovery_active_sha" "$recovery_previous_sha"
        write_break_glass_result_state \
          "$source_sha" "$requested_sha" confirmed "$requested_sha" "$source_sha"
        finalize_recovery_state "$operation" "$source_sha"
        recovery_outcome=confirmed
        return 0
      fi
    fi

    write_recovery_state \
      break-glass "$source_sha" "$requested_sha" "$source_sha" "$requested_sha" source
    load_recovery_state
  fi

  [[ "$recovery_operation" == break-glass && "$recovery_phase" == source ]] || fail
  apply_recovery_active_release \
    "$recovery_operation" \
    "$recovery_source_sha" \
    "$recovery_requested_sha" \
    "$recovery_active_sha" || fail
  restore_previous_pointer "$recovery_active_sha" "$recovery_previous_sha"
  run_recovery_smoke "$recovery_active_sha" || fail
  assert_recovery_pointer_state "$recovery_active_sha" "$recovery_previous_sha"
  write_break_glass_result_state \
    "$recovery_source_sha" \
    "$recovery_requested_sha" \
    rejected \
    "$recovery_active_sha" \
    "$recovery_previous_sha"
  finalize_recovery_state "$recovery_operation" "$recovery_source_sha"
  recovery_outcome=rejected
}

rollback_pending_locked() {
  local failed_sha="$1"
  local pending_path
  local recovery_path
  assert_sha "$failed_sha"
  pending_path="$(pending_state_path "$failed_sha")"
  recovery_path="$(recovery_pending_path)"

  if [[ -e "$recovery_path" || -L "$recovery_path" ]]; then
    load_recovery_state
    [[ "$recovery_operation" == activation && "$recovery_source_sha" == "$failed_sha" ]] || fail
    complete_recovery_locked
    return
  fi

  if is_confirmed "$failed_sha"; then
    write_activation_result_state "$failed_sha" confirmed "$failed_sha"
    stop_watchdog_timer "$failed_sha"
    rm -f -- "$pending_path"
    durable_sync_directory "$state_base"
    reset_inactive_watchdog_units "$failed_sha"
    return 0
  fi

  if [[ ! -e "$pending_path" && ! -L "$pending_path" ]]; then
    load_current_links
    if [[ "$current_release_sha" != "$failed_sha" ]]; then
      stop_watchdog_timer "$failed_sha"
      reset_inactive_watchdog_units "$failed_sha"
      return 0
    fi
    fail
  fi

  load_pending_state "$failed_sha"
  write_recovery_state \
    activation \
    "$failed_sha" \
    "$pending_rollback_sha" \
    "$pending_rollback_sha" \
    "$pending_prior_previous_sha" \
    recovery
  complete_recovery_locked
}

copy_upload_to_private_staging() {
  local upload="$1"
  local private_staging="$2"
  local entries
  entries="$(find "$upload" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)" || fail
  [[ "$entries" == $'backoffice.env\nrelease.tar.gz\nweb.env' ]] || fail
  assert_regular_private_upload "$upload/release.tar.gz"
  assert_regular_private_upload "$upload/web.env"
  assert_regular_private_upload "$upload/backoffice.env"

  install -o root -g root -m 0600 -- "$upload/release.tar.gz" "$private_staging/release.tar.gz"
  install -o root -g root -m 0600 -- "$upload/web.env" "$private_staging/web.env"
  install -o root -g root -m 0600 -- \
    "$upload/backoffice.env" "$private_staging/backoffice.env"
  assert_root_private_file "$private_staging/release.tar.gz"
  assert_root_private_file "$private_staging/web.env"
  assert_root_private_file "$private_staging/backoffice.env"

}

configure_preflight_resources() {
  local release_sha="$1"
  assert_sha "$release_sha"
  activation_private_staging="$private_staging_base/$release_sha"
  activation_release_candidate="$releases/.incoming-$release_sha"
  activation_runtime_candidate="$runtime_base/releases/.incoming-$release_sha"
  activation_pending_state=
  activation_preflight_state="$preflight_state"
  activation_lease_armed=0
}

write_preflight_state() {
  local phase="$1"
  local release_sha="$2"
  local archive_sha="$3"
  local web_runtime_credential_sha="$4"
  local backoffice_runtime_credential_sha="$5"
  local public_build_config_sha="$6"
  local lock_sha="$7"
  local migration_head="$8"
  local run_number="$9"
  local run_attempt="${10}"
  local run_id="${11}"
  local artifact_id="${12}"
  local artifact_digest="${13}"
  [[ "$phase" == preparing || "$phase" == ready ]] || fail
  assert_sha "$release_sha"
  assert_checksum "$archive_sha"
  assert_checksum "$web_runtime_credential_sha"
  assert_checksum "$backoffice_runtime_credential_sha"
  assert_checksum "$public_build_config_sha"
  assert_checksum "$lock_sha"
  [[ "$migration_head" =~ ^[0-9]{14}$ ]] || fail
  assert_positive_integer "$run_number"
  assert_positive_integer "$run_attempt"
  assert_positive_integer "$run_id"
  assert_positive_integer "$artifact_id"
  assert_checksum "$artifact_digest"
  write_root_state_file "$preflight_state" \
    protocol=5 \
    "phase=$phase" \
    "release_sha=$release_sha" \
    "archive_sha=$archive_sha" \
    "web_runtime_credential_sha=$web_runtime_credential_sha" \
    "backoffice_runtime_credential_sha=$backoffice_runtime_credential_sha" \
    "public_build_config_sha=$public_build_config_sha" \
    "lock_sha=$lock_sha" \
    "migration_head=$migration_head" \
    "run_number=$run_number" \
    "run_attempt=$run_attempt" \
    "run_id=$run_id" \
    "artifact_id=$artifact_id" \
    "artifact_digest=$artifact_digest"
}

load_preflight_state() {
  local -a lines=()
  assert_root_private_file "$preflight_state"
  mapfile -t lines <"$preflight_state"
  [[ "${#lines[@]}" -eq 14 ]] || fail
  [[ "${lines[0]}" == protocol=5 ]] || fail
  [[ "${lines[1]}" =~ ^phase=(preparing|ready)$ ]] || fail
  preflight_phase="${BASH_REMATCH[1]}"
  [[ "${lines[2]}" =~ ^release_sha=([0-9a-f]{40})$ ]] || fail
  preflight_release_sha="${BASH_REMATCH[1]}"
  [[ "${lines[3]}" =~ ^archive_sha=([0-9a-f]{64})$ ]] || fail
  preflight_archive_sha="${BASH_REMATCH[1]}"
  [[ "${lines[4]}" =~ ^web_runtime_credential_sha=([0-9a-f]{64})$ ]] || fail
  preflight_web_runtime_credential_sha="${BASH_REMATCH[1]}"
  [[ "${lines[5]}" =~ ^backoffice_runtime_credential_sha=([0-9a-f]{64})$ ]] || fail
  preflight_backoffice_runtime_credential_sha="${BASH_REMATCH[1]}"
  [[ "${lines[6]}" =~ ^public_build_config_sha=([0-9a-f]{64})$ ]] || fail
  preflight_public_build_config_sha="${BASH_REMATCH[1]}"
  [[ "${lines[7]}" =~ ^lock_sha=([0-9a-f]{64})$ ]] || fail
  preflight_lock_sha="${BASH_REMATCH[1]}"
  [[ "${lines[8]}" =~ ^migration_head=([0-9]{14})$ ]] || fail
  preflight_migration_head="${BASH_REMATCH[1]}"
  [[ "${lines[9]}" =~ ^run_number=([1-9][0-9]*)$ ]] || fail
  preflight_run_number="${BASH_REMATCH[1]}"
  [[ "${lines[10]}" =~ ^run_attempt=([1-9][0-9]*)$ ]] || fail
  preflight_run_attempt="${BASH_REMATCH[1]}"
  [[ "${lines[11]}" =~ ^run_id=([1-9][0-9]*)$ ]] || fail
  preflight_run_id="${BASH_REMATCH[1]}"
  [[ "${lines[12]}" =~ ^artifact_id=([1-9][0-9]*)$ ]] || fail
  preflight_artifact_id="${BASH_REMATCH[1]}"
  [[ "${lines[13]}" =~ ^artifact_digest=([0-9a-f]{64})$ ]] || fail
  preflight_artifact_digest="${BASH_REMATCH[1]}"
  assert_positive_integer "$preflight_run_number"
  assert_positive_integer "$preflight_run_attempt"
  assert_positive_integer "$preflight_run_id"
  assert_positive_integer "$preflight_artifact_id"
}

assert_preflight_identity() {
  local release_sha="$1"
  local archive_sha="$2"
  local lock_sha="$3"
  local migration_head="$4"
  local run_number="$5"
  local run_attempt="$6"
  local run_id="$7"
  local artifact_id="$8"
  local artifact_digest="$9"
  [[ "$preflight_phase" == ready ]] || fail
  [[ "$preflight_release_sha" == "$release_sha" ]] || fail
  [[ "$preflight_archive_sha" == "$archive_sha" ]] || fail
  [[ "$preflight_lock_sha" == "$lock_sha" ]] || fail
  [[ "$preflight_migration_head" == "$migration_head" ]] || fail
  [[ "$preflight_run_number" == "$run_number" ]] || fail
  [[ "$preflight_run_attempt" == "$run_attempt" ]] || fail
  [[ "$preflight_run_id" == "$run_id" ]] || fail
  [[ "$preflight_artifact_id" == "$artifact_id" ]] || fail
  [[ "$preflight_artifact_digest" == "$artifact_digest" ]] || fail
}

discard_preflight_locked() {
  if [[ ! -e "$preflight_state" && ! -L "$preflight_state" ]]; then
    return 0
  fi
  load_preflight_state
  configure_preflight_resources "$preflight_release_sha"
  write_cleanup_pending_state || fail
  cleanup_activation_resources || fail
  clear_cleanup_pending_state || fail
  [[ ! -e "$preflight_state" && ! -L "$preflight_state" ]] || fail
}

preflight() {
  require_root
  local release_sha="$1"
  local expected_archive_sha="$2"
  local expected_lock_sha="$3"
  local expected_migration_head="$4"
  local run_number="$5"
  local run_attempt="$6"
  local run_id="$7"
  local artifact_id="$8"
  local artifact_digest="$9"
  assert_sha "$release_sha"
  assert_checksum "$expected_archive_sha"
  assert_checksum "$expected_lock_sha"
  [[ "$expected_migration_head" =~ ^[0-9]{14}$ ]] || fail
  assert_positive_integer "$run_number"
  assert_positive_integer "$run_attempt"
  assert_positive_integer "$run_id"
  assert_positive_integer "$artifact_id"
  assert_checksum "$artifact_digest"

  exec 9>"/run/lock/setlivre-release-manager.lock"
  flock -w 30 9 || fail
  ensure_root_private_directory "$private_staging_base"
  ensure_root_private_directory "$state_base"
  ensure_root_private_directory "$provenance_base"
  recover_pending_cleanup_locked
  recover_pending_activation_locked
  discard_preflight_locked

  configure_preflight_resources "$release_sha"
  trap cleanup_activation EXIT
  trap 'exit 1' HUP INT TERM
  write_cleanup_pending_state || fail
  local activation_upload="$deployer_incoming_base/$release_sha"
  [[ -d "$activation_upload" && ! -L "$activation_upload" ]] || fail
  [[ "$(stat -c '%U:%a' -- "$activation_upload")" == "$deployer_user:700" ]] || fail
  assert_regular_private_upload "$activation_upload/release.tar.gz"
  local upload_size
  upload_size="$(stat -c '%s' -- "$activation_upload/release.tar.gz")"
  assert_positive_integer "$upload_size"
  assert_available_space "$private_staging_base" "$upload_size"
  cleanup_private_tree "$activation_private_staging" "$private_staging_base" || fail
  cleanup_private_tree "$activation_release_candidate" "$releases" || fail
  cleanup_private_tree "$activation_runtime_candidate" "$runtime_base/releases" || fail
  clear_cleanup_pending_state || fail
  write_cleanup_pending_state || fail
  install -d -o root -g root -m 0700 -- "$activation_private_staging"
  copy_upload_to_private_staging "$activation_upload" "$activation_private_staging"

  local archive="$activation_private_staging/release.tar.gz"
  local web_runtime_credential="$activation_private_staging/web.env"
  local backoffice_runtime_credential="$activation_private_staging/backoffice.env"
  [[ "$(file_sha256 "$archive")" == "$expected_archive_sha" ]] || fail
  validate_runtime_credential "$web_runtime_credential" web "$release_sha"
  validate_runtime_credential "$backoffice_runtime_credential" backoffice "$release_sha"
  local web_runtime_credential_sha
  local backoffice_runtime_credential_sha
  local public_build_config_sha
  web_runtime_credential_sha="$(file_sha256 "$web_runtime_credential")" || fail
  backoffice_runtime_credential_sha="$(file_sha256 "$backoffice_runtime_credential")" || fail
  public_build_config_sha="$(public_build_config_sha256_from_credentials \
    "$web_runtime_credential" "$backoffice_runtime_credential")" || fail
  assert_checksum "$public_build_config_sha"
  write_preflight_state preparing \
    "$release_sha" "$expected_archive_sha" "$web_runtime_credential_sha" \
    "$backoffice_runtime_credential_sha" "$public_build_config_sha" "$expected_lock_sha" \
    "$expected_migration_head" "$run_number" "$run_attempt" "$run_id" \
    "$artifact_id" "$artifact_digest"

  local expanded_bytes
  expanded_bytes="$(validate_release_archive "$archive")" || fail
  assert_positive_integer "$expanded_bytes"
  assert_available_space "$releases" "$expanded_bytes"
  install -d -o root -g "$service_group" -m 0750 "$activation_release_candidate"
  tar --extract --gzip --file "$archive" --directory "$activation_release_candidate" \
    --strip-components=1 --no-same-owner --no-same-permissions
  validate_release_tree \
    "$activation_release_candidate" "$release_sha" "$expected_lock_sha" \
    "$expected_migration_head" "$public_build_config_sha"
  chown -R root:"$service_group" "$activation_release_candidate"
  find "$activation_release_candidate" -xdev -type d -exec chmod 0750 {} +
  find "$activation_release_candidate" -xdev -type f -exec chmod 0640 {} +

  install -d -o root -g root -m 0700 "$activation_runtime_candidate"
  install -o root -g root -m 0600 \
    "$web_runtime_credential" "$activation_runtime_candidate/web.env"
  install -o root -g root -m 0600 \
    "$backoffice_runtime_credential" "$activation_runtime_candidate/backoffice.env"
  write_preflight_state ready \
    "$release_sha" "$expected_archive_sha" "$web_runtime_credential_sha" \
    "$backoffice_runtime_credential_sha" "$public_build_config_sha" "$expected_lock_sha" \
    "$expected_migration_head" "$run_number" "$run_attempt" "$run_id" \
    "$artifact_id" "$artifact_digest"
  clear_cleanup_pending_state || fail
  trap - EXIT HUP INT TERM
}

discard_preflight() {
  require_root
  local release_sha="$1"
  assert_sha "$release_sha"
  exec 9>"/run/lock/setlivre-release-manager.lock"
  flock -w 30 9 || fail
  ensure_root_private_directory "$private_staging_base"
  ensure_root_private_directory "$state_base"
  recover_pending_cleanup_locked
  if [[ -e "$preflight_state" || -L "$preflight_state" ]]; then
    load_preflight_state
    [[ "$preflight_release_sha" == "$release_sha" ]] || fail
    discard_preflight_locked
  fi
}

activate() {
  require_root
  local release_sha="$1"
  local expected_archive_sha="$2"
  local expected_lock_sha="$3"
  local expected_migration_head="$4"
  local run_number="$5"
  local run_attempt="$6"
  local run_id="$7"
  local artifact_id="$8"
  local artifact_digest="$9"
  assert_sha "$release_sha"
  assert_checksum "$expected_archive_sha"
  assert_checksum "$expected_lock_sha"
  [[ "$expected_migration_head" =~ ^[0-9]{14}$ ]] || fail
  assert_positive_integer "$run_number"
  assert_positive_integer "$run_attempt"
  assert_positive_integer "$run_id"
  assert_positive_integer "$artifact_id"
  assert_checksum "$artifact_digest"
  assert_lease_contract

  exec 9>"/run/lock/setlivre-release-manager.lock"
  flock -w 30 9 || fail
  ensure_root_private_directory "$private_staging_base"
  ensure_root_private_directory "$state_base"
  ensure_root_private_directory "$provenance_base"
  recover_pending_cleanup_locked
  recover_pending_activation_locked
  load_preflight_state
  assert_preflight_identity \
    "$release_sha" "$expected_archive_sha" "$expected_lock_sha" "$expected_migration_head" \
    "$run_number" "$run_attempt" "$run_id" "$artifact_id" "$artifact_digest"
  configure_preflight_resources "$release_sha"
  activation_pending_state="$(pending_state_path "$release_sha")"
  trap cleanup_activation EXIT
  trap 'exit 1' HUP INT TERM
  write_cleanup_pending_state || fail

  local archive="$activation_private_staging/release.tar.gz"
  local web_runtime_credential="$activation_private_staging/web.env"
  local backoffice_runtime_credential="$activation_private_staging/backoffice.env"
  assert_root_private_file "$archive"
  assert_root_private_file "$web_runtime_credential"
  assert_root_private_file "$backoffice_runtime_credential"
  [[ "$(file_sha256 "$archive")" == "$expected_archive_sha" ]] || fail
  [[ "$(file_sha256 "$web_runtime_credential")" \
    == "$preflight_web_runtime_credential_sha" ]] || fail
  [[ "$(file_sha256 "$backoffice_runtime_credential")" \
    == "$preflight_backoffice_runtime_credential_sha" ]] || fail
  validate_runtime_credential "$web_runtime_credential" web "$release_sha"
  validate_runtime_credential "$backoffice_runtime_credential" backoffice "$release_sha"
  [[ "$(public_build_config_sha256_from_credentials \
    "$web_runtime_credential" "$backoffice_runtime_credential")" \
    == "$preflight_public_build_config_sha" ]] || fail

  load_current_links
  load_previous_links
  if [[ "$current_release_sha" == none && "$previous_release_sha" != none ]]; then
    fail
  fi
  select_activation_history "$release_sha" "$current_release_sha" "$previous_release_sha"

  local release="$releases/$release_sha"
  if [[ -e "$release" || -L "$release" ]]; then
    [[ -d "$release" && ! -L "$release" ]] || fail
    assert_release_provenance \
      "$release_sha" "$expected_archive_sha" "$expected_lock_sha" \
      "$expected_migration_head" "$run_number" "$run_attempt" "$run_id" \
      "$artifact_id" "$artifact_digest"
    validate_release_tree \
      "$release" "$release_sha" "$expected_lock_sha" "$expected_migration_head" \
      "$preflight_public_build_config_sha"
    cleanup_private_tree "$activation_release_candidate" "$releases" || fail
    activation_release_candidate=
  else
    [[ -d "$activation_release_candidate" && ! -L "$activation_release_candidate" ]] || fail
    validate_release_tree \
      "$activation_release_candidate" "$release_sha" "$expected_lock_sha" \
      "$expected_migration_head" "$preflight_public_build_config_sha"
    ensure_release_provenance \
      "$release_sha" "$expected_archive_sha" "$expected_lock_sha" \
      "$expected_migration_head" "$run_number" "$run_attempt" "$run_id" \
      "$artifact_id" "$artifact_digest"
    mv -- "$activation_release_candidate" "$release"
    durable_sync_directory "$releases"
    activation_release_candidate=
  fi
  assert_release_provenance \
    "$release_sha" "$expected_archive_sha" "$expected_lock_sha" \
    "$expected_migration_head" "$run_number" "$run_attempt" "$run_id" \
    "$artifact_id" "$artifact_digest"
  validate_release_tree \
    "$release" "$release_sha" "$expected_lock_sha" "$expected_migration_head" \
    "$preflight_public_build_config_sha"

  local runtime_release="$runtime_base/releases/$release_sha"
  if [[ ! -e "$runtime_release" && ! -L "$runtime_release" ]]; then
    [[ -d "$activation_runtime_candidate" && ! -L "$activation_runtime_candidate" ]] || fail
    mv -- "$activation_runtime_candidate" "$runtime_release"
    durable_sync_directory "$runtime_base/releases"
    activation_runtime_candidate=
  else
    [[ -d "$runtime_release" && ! -L "$runtime_release" ]] || fail
    [[ "$(stat -c '%U:%G:%a' -- "$runtime_release")" == "root:root:700" ]] || fail
    [[ "$(stat -c '%U:%G:%a' -- "$runtime_release/web.env")" \
      == "root:root:600" ]] || fail
    [[ "$(stat -c '%U:%G:%a' -- "$runtime_release/backoffice.env")" \
      == "root:root:600" ]] || fail
    cmp --silent -- "$web_runtime_credential" "$runtime_release/web.env" || fail
    cmp --silent -- "$backoffice_runtime_credential" "$runtime_release/backoffice.env" || fail
    cleanup_private_tree "$activation_runtime_candidate" "$runtime_base/releases" || fail
    activation_runtime_candidate=
  fi
  assert_runtime_target "$runtime_release"

  assert_watchdog_service_inactive "$release_sha"
  stop_watchdog_timer "$release_sha"
  reset_inactive_watchdog_units "$release_sha"
  [[ ! -e "$(confirmed_state_path "$release_sha")" \
    && ! -L "$(confirmed_state_path "$release_sha")" ]] || fail
  [[ ! -e "$(activation_result_path "$release_sha")" \
    && ! -L "$(activation_result_path "$release_sha")" ]] || fail
  local activation_deadline
  activation_deadline="$(monotonic_seconds)" || fail
  assert_positive_integer "$activation_deadline"
  activation_deadline=$((activation_deadline + activation_lease_seconds))
  activation_lease_armed=1
  write_cleanup_pending_state || fail
  write_pending_state \
    "$release_sha" "$selected_rollback_sha" "$selected_prior_previous_sha" "$activation_deadline"
  schedule_watchdog "$release_sha" "$activation_deadline"

  atomic_link "$release" "$base/current"
  atomic_link "$runtime_release" "$runtime_base/current"
  if ! restart_and_assert "$release_sha"; then
    rollback_pending_locked "$release_sha"
    activation_lease_armed=0
    fail
  fi

  if [[ "$selected_rollback_sha" == none ]]; then
    rm -f -- "$base/previous" "$runtime_base/previous"
    durable_sync_directory "$base"
    durable_sync_directory "$runtime_base"
  else
    local rollback_release="$releases/$selected_rollback_sha"
    local rollback_runtime="$runtime_base/releases/$selected_rollback_sha"
    assert_release_target "$rollback_release"
    assert_runtime_target "$rollback_runtime"
    atomic_link "$rollback_release" "$base/previous"
    atomic_link "$rollback_runtime" "$runtime_base/previous"
  fi

  if ! cleanup_activation_resources; then
    fail
  fi
  clear_cleanup_pending_state || fail
  trap - EXIT HUP INT TERM
  printf '%s %s\n' "$selected_rollback_sha" "$activation_deadline"
}

confirm() {
  require_root
  local release_sha="$1"
  local pending_path
  assert_sha "$release_sha"
  exec 9>"/run/lock/setlivre-release-manager.lock"
  flock -w 30 9 || fail
  ensure_root_private_directory "$private_staging_base"
  ensure_root_private_directory "$state_base"
  recover_pending_cleanup_locked
  [[ ! -e "$(recovery_pending_path)" && ! -L "$(recovery_pending_path)" ]] || fail
  load_current_links
  [[ "$current_release_sha" == "$release_sha" ]] || fail

  if is_confirmed "$release_sha"; then
    write_activation_result_state "$release_sha" confirmed "$release_sha"
    stop_watchdog_timer "$release_sha"
    rm -f -- "$(pending_state_path "$release_sha")"
    durable_sync_directory "$state_base"
    reset_inactive_watchdog_units "$release_sha"
    return 0
  fi

  pending_path="$(pending_state_path "$release_sha")"
  load_pending_state "$release_sha"
  assert_confirmation_window "$pending_activation_deadline"
  write_confirmed_state "$release_sha"
  write_activation_result_state "$release_sha" confirmed "$release_sha"
  stop_watchdog_timer "$release_sha"
  rm -f -- "$pending_path"
  durable_sync_directory "$state_base"
  reset_inactive_watchdog_units "$release_sha"
}

rollback() {
  require_root
  local failed_sha="$1"
  assert_sha "$failed_sha"
  exec 9>"/run/lock/setlivre-release-manager.lock"
  flock -w 30 9 || fail
  ensure_root_private_directory "$private_staging_base"
  ensure_root_private_directory "$state_base"
  recover_pending_cleanup_locked
  rollback_pending_locked "$failed_sha"
}

rollback_confirmed() {
  require_root
  local source_sha="$1"
  local requested_sha="$2"
  assert_sha "$source_sha"
  assert_sha "$requested_sha"
  [[ "$source_sha" != "$requested_sha" ]] || fail
  exec 9>"/run/lock/setlivre-release-manager.lock"
  flock -w 30 9 || fail
  ensure_root_private_directory "$private_staging_base"
  ensure_root_private_directory "$state_base"
  ensure_root_private_directory "$provenance_base"
  recover_pending_cleanup_locked
  [[ ! -e "$(recovery_pending_path)" && ! -L "$(recovery_pending_path)" ]] || fail
  shopt -s nullglob
  activation_pending_paths=("$state_base"/*.pending)
  shopt -u nullglob
  [[ "${#activation_pending_paths[@]}" -eq 0 ]] || fail
  load_current_links
  load_previous_links
  [[ "$current_release_sha" == "$source_sha" ]] || fail
  [[ "$previous_release_sha" == "$requested_sha" ]] || fail
  is_confirmed "$source_sha" || fail
  is_confirmed "$requested_sha" || fail
  assert_release_provenance_record "$source_sha"
  assert_release_provenance_record "$requested_sha"

  write_recovery_state \
    break-glass "$source_sha" "$requested_sha" "$requested_sha" "$source_sha" recovery
  complete_recovery_locked
  [[ "$recovery_outcome" == confirmed ]] || fail
}

watchdog() {
  require_root
  local failed_sha="$1"
  assert_sha "$failed_sha"
  exec 9>"/run/lock/setlivre-release-manager.lock"
  flock -w 30 9 || fail
  ensure_root_private_directory "$private_staging_base"
  ensure_root_private_directory "$state_base"
  recover_pending_cleanup_locked
  rollback_pending_locked "$failed_sha"
}

activation_result() {
  require_root
  local release_sha="$1"
  local path
  local -a lines=()
  assert_sha "$release_sha"
  exec 9>"/run/lock/setlivre-release-manager.lock"
  flock -w 30 9 || fail
  ensure_root_private_directory "$private_staging_base"
  ensure_root_private_directory "$state_base"
  recover_pending_cleanup_locked
  recover_pending_activation_locked
  path="$(activation_result_path "$release_sha")"
  if [[ ! -e "$path" && ! -L "$path" ]]; then
    printf '%s\n' none
    return 0
  fi
  assert_root_private_file "$path"
  mapfile -t lines <"$path"
  [[ "${#lines[@]}" -eq 5 ]] || fail
  [[ "${lines[0]}" == protocol=3 ]] || fail
  [[ "${lines[1]}" == operation=activation ]] || fail
  [[ "${lines[2]}" == "release_sha=$release_sha" ]] || fail
  [[ "${lines[3]}" =~ ^result=(confirmed|rejected)$ ]] || fail
  [[ "${lines[4]}" =~ ^active_sha=(none|[0-9a-f]{40})$ ]] || fail
  assert_activation_result_state \
    "$release_sha" "${lines[3]#result=}" "${lines[4]#active_sha=}"
  printf '%s %s\n' "${lines[3]#result=}" "${lines[4]#active_sha=}"
}

current() {
  require_root
  exec 9>"/run/lock/setlivre-release-manager.lock"
  flock -w 30 9 || fail
  ensure_root_private_directory "$private_staging_base"
  ensure_root_private_directory "$state_base"
  recover_pending_cleanup_locked
  recover_pending_activation_locked
  load_current_links
  printf '%s\n' "$current_release_sha"
}

recover_pending_activation_locked() {
  local -a pending_paths=()
  local pending_path
  local pending_name
  local failed_sha
  local recovery_path

  recovery_path="$(recovery_pending_path)"
  if [[ -e "$recovery_path" || -L "$recovery_path" ]]; then
    load_recovery_state
    if [[ "$recovery_operation" == activation ]]; then
      rollback_pending_locked "$recovery_source_sha"
    else
      complete_recovery_locked
    fi
    return
  fi

  shopt -s nullglob
  pending_paths=("$state_base"/*.pending)
  shopt -u nullglob
  ((${#pending_paths[@]} <= 1)) || fail
  if [[ "${#pending_paths[@]}" -eq 0 ]]; then
    return 0
  fi

  pending_path="${pending_paths[0]}"
  pending_name="$(basename -- "$pending_path")"
  [[ "$pending_name" =~ ^([0-9a-f]{40})\.pending$ ]] || fail
  failed_sha="${BASH_REMATCH[1]}"
  assert_root_private_file "$pending_path"

  rollback_pending_locked "$failed_sha"
}

apply_boot_safe_links() {
  local active_sha="$1"
  local previous_sha="$2"
  assert_optional_sha "$active_sha"
  assert_optional_sha "$previous_sha"
  if [[ "$active_sha" == none ]]; then
    [[ "$previous_sha" == none ]] || fail
    rm -f -- "$base/current" "$runtime_base/current" "$base/previous" "$runtime_base/previous"
    durable_sync_directory "$base"
    durable_sync_directory "$runtime_base"
  else
    local active_release="$releases/$active_sha"
    local active_runtime="$runtime_base/releases/$active_sha"
    is_confirmed "$active_sha" || fail
    assert_release_target "$active_release"
    assert_runtime_target "$active_runtime"
    atomic_link "$active_release" "$base/current"
    atomic_link "$active_runtime" "$runtime_base/current"
    if [[ "$previous_sha" == none || "$previous_sha" == "$active_sha" ]]; then
      rm -f -- "$base/previous" "$runtime_base/previous"
      durable_sync_directory "$base"
      durable_sync_directory "$runtime_base"
      previous_sha=none
    else
      local previous_release="$releases/$previous_sha"
      local previous_runtime="$runtime_base/releases/$previous_sha"
      is_confirmed "$previous_sha" || fail
      assert_release_target "$previous_release"
      assert_runtime_target "$previous_runtime"
      atomic_link "$previous_release" "$base/previous"
      atomic_link "$previous_runtime" "$runtime_base/previous"
    fi
  fi
  assert_recovery_pointer_state "$active_sha" "$previous_sha"
}

recover_pending_activation_at_boot_locked() {
  local recovery_path
  local pending_path
  local pending_name
  local failed_sha
  local safe_active_sha
  local safe_previous_sha
  local -a pending_paths=()
  recovery_path="$(recovery_pending_path)"

  if [[ ! -e "$recovery_path" && ! -L "$recovery_path" ]]; then
    shopt -s nullglob
    pending_paths=("$state_base"/*.pending)
    shopt -u nullglob
    ((${#pending_paths[@]} <= 1)) || fail
    if [[ "${#pending_paths[@]}" -eq 1 ]]; then
      pending_path="${pending_paths[0]}"
      pending_name="$(basename -- "$pending_path")"
      [[ "$pending_name" =~ ^([0-9a-f]{40})\.pending$ ]] || fail
      failed_sha="${BASH_REMATCH[1]}"
      load_pending_state "$failed_sha"
      write_recovery_state \
        activation "$failed_sha" "$pending_rollback_sha" "$pending_rollback_sha" \
        "$pending_prior_previous_sha" recovery
    fi
  fi

  if [[ -e "$recovery_path" || -L "$recovery_path" ]]; then
    load_recovery_state
    case "$recovery_operation" in
      activation)
        safe_active_sha="$recovery_requested_sha"
        safe_previous_sha="$recovery_previous_sha"
        ;;
      break-glass)
        safe_active_sha="$recovery_source_sha"
        safe_previous_sha="$recovery_requested_sha"
        ;;
      *) fail ;;
    esac
    apply_boot_safe_links "$safe_active_sha" "$safe_previous_sha"
    if [[ "$recovery_operation" == activation ]]; then
      write_activation_result_state "$recovery_source_sha" rejected "$safe_active_sha"
    fi
    stop_watchdog_timer "$recovery_source_sha"
    rm -f -- \
      "$(pending_state_path "$recovery_source_sha")" \
      "$recovery_path" \
      "$(break_glass_result_path "$recovery_source_sha")"
    durable_sync_directory "$state_base"
    reset_inactive_watchdog_units "$recovery_source_sha"
  fi

  shopt -s nullglob
  pending_paths=("$state_base"/*.pending)
  shopt -u nullglob
  [[ "${#pending_paths[@]}" -eq 0 ]] || fail
  [[ ! -e "$recovery_path" && ! -L "$recovery_path" ]] || fail
  load_current_links
  load_previous_links
  if [[ "$current_release_sha" == none ]]; then
    [[ "$previous_release_sha" == none ]] || fail
  else
    is_confirmed "$current_release_sha" || fail
    assert_release_provenance_record "$current_release_sha"
  fi
}

recover_boot() {
  require_root
  exec 9>"/run/lock/setlivre-release-manager.lock"
  flock -w 30 9 || fail
  ensure_root_private_directory "$private_staging_base"
  ensure_root_private_directory "$state_base"
  ensure_root_private_directory "$provenance_base"
  assert_service_inactive "$web_service"
  assert_service_inactive "$backoffice_service"
  assert_service_inactive "$nginx_service"
  recover_pending_cleanup_locked
  recover_pending_activation_at_boot_locked
  discard_preflight_locked
}

checkpoint() {
  require_root
  exec 9>"/run/lock/setlivre-release-manager.lock"
  flock -w 30 9 || fail
  ensure_root_private_directory "$private_staging_base"
  ensure_root_private_directory "$state_base"
  ensure_root_private_directory "$provenance_base"
  recover_pending_cleanup_locked
  recover_pending_activation_locked
  load_current_links
  if [[ "$current_release_sha" == none ]]; then
    printf '%s\n' none
    return 0
  fi
  is_confirmed "$current_release_sha" || fail
  assert_release_provenance_record "$current_release_sha"
  local path
  local -a lines=()
  path="$(release_provenance_path "$current_release_sha")"
  mapfile -t lines <"$path"
  [[ "${#lines[@]}" -eq 10 ]] || fail
  printf '%s\n' "${lines[@]}"
}

main() {
  require_commands
  if [[ "${1:-}" != version ]]; then
    assert_no_pending_manager_update
  fi
  case "${1:-}" in
    version)
      [[ "$#" -eq 1 ]] || fail
      printf '%s\n' "$protocol_version"
      ;;
    preflight)
      [[ "$#" -eq 10 ]] || fail
      preflight "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9" "${10}"
      ;;
    activate)
      [[ "$#" -eq 10 ]] || fail
      activate "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9" "${10}"
      ;;
    discard-preflight)
      [[ "$#" -eq 2 ]] || fail
      discard_preflight "$2"
      ;;
    confirm)
      [[ "$#" -eq 2 ]] || fail
      confirm "$2"
      ;;
    rollback)
      [[ "$#" -eq 2 ]] || fail
      rollback "$2"
      ;;
    rollback-confirmed)
      [[ "$#" -eq 3 ]] || fail
      rollback_confirmed "$2" "$3"
      ;;
    activation-result)
      [[ "$#" -eq 2 ]] || fail
      activation_result "$2"
      ;;
    watchdog)
      [[ "$#" -eq 2 ]] || fail
      watchdog "$2"
      ;;
    recover-boot)
      [[ "$#" -eq 1 ]] || fail
      recover_boot
      ;;
    current)
      [[ "$#" -eq 1 ]] || fail
      current
      ;;
    checkpoint)
      [[ "$#" -eq 1 ]] || fail
      checkpoint
      ;;
    *)
      fail
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
