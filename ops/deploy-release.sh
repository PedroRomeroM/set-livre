#!/usr/bin/env bash
set -Eeuo pipefail

readonly RELEASES_DIRECTORY="/opt/set-livre/releases"
readonly CURRENT_LINK="/opt/set-livre/current"
readonly ROLLBACK_MARKER="/opt/set-livre/.activation-rollback"
readonly HOST_CONFIGURATION_DIGEST="/etc/set-livre/host-config.sha256"
readonly HOST_BOOTSTRAP_IN_PROGRESS="/etc/set-livre/bootstrap-in-progress.sha256"
readonly HOST_BOOTSTRAP_RECOVERY_IN_PROGRESS="/etc/set-livre/bootstrap-recovery-in-progress.sha256"
readonly INCOMING_DIRECTORY="/home/deploy-setlivre/incoming"
readonly UPLOAD_LOCK="${INCOMING_DIRECTORY}/.incoming.lock"
readonly DEPLOY_LOCK_HELPER="/usr/local/sbin/set-livre-deploy-lock"
readonly PRODUCTION_IP="147.15.97.227"
readonly PRODUCTION_URL="https://${PRODUCTION_IP}"
readonly MAX_ARCHIVE_BYTES=$((256 * 1024 * 1024))
readonly MAX_ENVIRONMENT_BYTES=$((64 * 1024))
readonly RETAINED_RELEASES=4
readonly RECOVERY_LOCK_TIMEOUT_SECONDS=300
readonly UPLOAD_LOCK_TIMEOUT_SECONDS=300
SCRIPT_PATH="$(realpath -e -- "${BASH_SOURCE[0]}")"
readonly SCRIPT_PATH
authenticated_bootstrap_recovery_digest=""
recovered_release=""
recovered_target=""

fail() {
  printf 'deploy: %s\n' "$1" >&2
  exit 1
}

adopt_deploy_lock() {
  local file_descriptor="$1"
  [[ ${file_descriptor} =~ ^[0-9]+$ ]] || fail "descritor do lock de deploy inválido."
  python3 "$DEPLOY_LOCK_HELPER" verify "$file_descriptor" \
    || fail "lock de deploy herdado não pôde ser autenticado."
}

release_tree_digest() {
  local directory="$1"
  [[ -d ${directory} && ! -L ${directory} ]] || return 1
  LC_ALL=C tar \
    --create \
    --file=- \
    --directory="$directory" \
    --sort=name \
    --format=gnu \
    --mtime='@0' \
    --numeric-owner \
    . \
    | sha256sum \
    | cut --delimiter=' ' --fields=1
}

activate_link() {
  local target="$1"
  local candidate="${CURRENT_LINK}.next"
  rm -f -- "$candidate" || return 1
  ln --symbolic "$target" "$candidate" || return 1
  mv --no-target-directory --force "$candidate" "$CURRENT_LINK" || return 1
}

health_is_ready() {
  local port="$1"
  local application="$2"
  local expected_release="$3"
  curl --disable --noproxy '*' --fail --silent --show-error --max-time 2 \
    "http://127.0.0.1:${port}/api/health/ready" \
    | jq --exit-status --arg application "$application" --arg release "$expected_release" \
      '.application == $application and .release == $release and .status == "ready"' >/dev/null
}

public_health_is_ready() {
  local expected_release="$1"
  curl --disable --noproxy '*' --fail --silent --show-error --max-time 5 \
    "${PRODUCTION_URL}/api/health/ready" \
    | jq --exit-status --arg release "$expected_release" \
      '.application == "web" and .release == $release and .status == "ready"' >/dev/null
}

wait_for_health() {
  local expected_release="$1"
  for _ in $(seq 1 30); do
    if health_is_ready 3000 web "$expected_release" \
      && health_is_ready 3001 backoffice "$expected_release"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

wait_for_public_health() {
  local expected_release="$1"
  for _ in $(seq 1 12); do
    if public_health_is_ready "$expected_release"; then
      return 0
    fi
    sleep 5
  done
  return 1
}

managed_release_directories_are_valid() {
  python3 <<'PYTHON'
import grp
import os
import stat

flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW
expected_group = grp.getgrnam("setlivre").gr_gid
directory_fd = -1
try:
    directory_fd = os.open("/opt", flags)
    for component in ("set-livre", "releases"):
        child_fd = os.open(component, flags, dir_fd=directory_fd)
        metadata = os.fstat(child_fd)
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or metadata.st_uid != 0
            or metadata.st_gid != expected_group
            or stat.S_IMODE(metadata.st_mode) != 0o750
        ):
            os.close(child_fd)
            raise SystemExit("managed release directory metadata is invalid")
        os.close(directory_fd)
        directory_fd = child_fd
except (KeyError, OSError) as error:
    raise SystemExit("managed release directory chain is invalid") from error
finally:
    if directory_fd >= 0:
        os.close(directory_fd)
PYTHON
}

read_rollback_marker() {
  recovered_release=""
  recovered_target=""
  [[ -f ${ROLLBACK_MARKER} && ! -L ${ROLLBACK_MARKER} ]] || return 1
  [[ $(stat --format '%U:%G:%a' -- "$ROLLBACK_MARKER") == "root:root:600" ]] \
    || return 1

  local target
  target="$(< "$ROLLBACK_MARKER")"
  if [[ ${target} != "NONE" ]]; then
    [[ ${target} =~ ^${RELEASES_DIRECTORY}/[0-9a-f]{40}$ ]] || return 1
    [[ -d ${target} && ! -L ${target} ]] || return 1
    recovered_target="$target"
    recovered_release="$(basename -- "$target")"
  fi
}

activate_recovered_link() {
  if [[ -z ${recovered_target} ]]; then
    rm -f -- "$CURRENT_LINK" "${CURRENT_LINK}.next" || return 1
  else
    activate_link "$recovered_target" || return 1
  fi
}

recover_link_from_marker() {
  read_rollback_marker || return 1
  activate_recovered_link
}

write_rollback_marker() {
  local previous="$1"
  local temporary
  temporary="$(mktemp /opt/set-livre/.activation-rollback.XXXXXX)" || return 1
  if ! printf '%s\n' "${previous:-NONE}" > "$temporary" \
    || ! chown root:root "$temporary" \
    || ! chmod 0600 "$temporary" \
    || ! mv --force -- "$temporary" "$ROLLBACK_MARKER"; then
    rm -f -- "$temporary"
    return 1
  fi
}

read_host_state_digest() {
  local marker="$1"
  local expected_identity="$2"
  local -a lines=()
  [[ -f ${marker} && ! -L ${marker} ]] || return 1
  [[ $(stat --format '%U:%G:%a' -- "$marker") == "$expected_identity" ]] || return 1
  mapfile -t lines < "$marker"
  [[ ${#lines[@]} -eq 1 && ${lines[0]} =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s\n' "${lines[0]}"
}

publish_host_state_digest() {
  local destination="$1"
  local temporary_prefix="$2"
  local digest="$3"
  local temporary
  [[ ${digest} =~ ^[0-9a-f]{64}$ ]] || return 1
  temporary="$(mktemp "/etc/set-livre/.${temporary_prefix}.XXXXXX")" || return 1
  if ! printf '%s\n' "$digest" > "$temporary" \
    || ! chown root:root "$temporary" \
    || ! chmod 0600 "$temporary" \
    || ! mv --force -- "$temporary" "$destination"; then
    rm -f -- "$temporary"
    return 1
  fi
}

publish_bootstrap_recovery_blocker() {
  publish_host_state_digest \
    "$HOST_BOOTSTRAP_IN_PROGRESS" "bootstrap-in-progress" "$1"
}

publish_bootstrap_recovery_phase() {
  publish_host_state_digest \
    "$HOST_BOOTSTRAP_RECOVERY_IN_PROGRESS" "bootstrap-recovery-in-progress" "$1"
}

bootstrap_recovery_state_is_present() {
  [[ -e ${HOST_BOOTSTRAP_IN_PROGRESS} || -L ${HOST_BOOTSTRAP_IN_PROGRESS} \
    || -e ${HOST_BOOTSTRAP_RECOVERY_IN_PROGRESS} \
    || -L ${HOST_BOOTSTRAP_RECOVERY_IN_PROGRESS} ]]
}

read_bootstrap_recovery_digest() {
  local blocker_digest=""
  local recovery_digest=""
  if [[ -e ${HOST_BOOTSTRAP_IN_PROGRESS} || -L ${HOST_BOOTSTRAP_IN_PROGRESS} ]]; then
    blocker_digest="$(
      read_host_state_digest "$HOST_BOOTSTRAP_IN_PROGRESS" "root:root:600"
    )" || return 1
  fi
  if [[ -e ${HOST_BOOTSTRAP_RECOVERY_IN_PROGRESS} \
    || -L ${HOST_BOOTSTRAP_RECOVERY_IN_PROGRESS} ]]; then
    recovery_digest="$(
      read_host_state_digest "$HOST_BOOTSTRAP_RECOVERY_IN_PROGRESS" "root:root:600"
    )" || return 1
  fi
  [[ -n ${blocker_digest} || -n ${recovery_digest} ]] || return 1
  [[ -z ${blocker_digest} || -z ${recovery_digest} \
    || ${blocker_digest} == "$recovery_digest" ]] || return 1
  printf '%s\n' "${recovery_digest:-$blocker_digest}"
}

authorize_interrupted_bootstrap_recovery() {
  local recovered_sha="$1"
  local bootstrap_digest installed_digest manifest
  authenticated_bootstrap_recovery_digest=""
  [[ ${recovered_sha} =~ ^[0-9a-f]{40}$ ]] || return 1
  bootstrap_digest="$(
    read_bootstrap_recovery_digest
  )" || return 1
  installed_digest="$(
    read_host_state_digest "$HOST_CONFIGURATION_DIGEST" "root:setlivre:640"
  )" || return 1
  [[ ${bootstrap_digest} == "$installed_digest" ]] || return 1

  manifest="${RELEASES_DIRECTORY}/${recovered_sha}/release-manifest.json"
  [[ -f ${manifest} && ! -L ${manifest} ]] || return 1
  python3 - "$manifest" "$recovered_sha" "$bootstrap_digest" <<'PYTHON' || return 1
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
expected_release = sys.argv[2]
expected_digest = sys.argv[3]
try:
    manifest = json.loads(path.read_text(encoding="utf-8"))
except (OSError, UnicodeError, json.JSONDecodeError) as error:
    raise SystemExit("release manifest is unreadable") from error
host_configuration = manifest.get("hostConfiguration")
if (
    manifest.get("version") != 2
    or manifest.get("commit") != expected_release
    or not isinstance(host_configuration, dict)
    or host_configuration.get("sha256") != expected_digest
):
    raise SystemExit("release manifest does not authorize bootstrap recovery")
PYTHON

  authenticated_bootstrap_recovery_digest="$bootstrap_digest"
}

ensure_bootstrap_recovery_blocker() {
  local recovery_digest
  if read_host_state_digest "$HOST_BOOTSTRAP_IN_PROGRESS" "root:root:600" >/dev/null 2>&1; then
    return 0
  fi
  recovery_digest="$(
    read_host_state_digest "$HOST_BOOTSTRAP_RECOVERY_IN_PROGRESS" "root:root:600"
  )" || recovery_digest="$(printf '0%.0s' {1..64})"
  publish_bootstrap_recovery_blocker "$recovery_digest"
}

begin_interrupted_bootstrap_recovery() {
  local recovered_sha="$1"
  authorize_interrupted_bootstrap_recovery "$recovered_sha" || return 1
  publish_bootstrap_recovery_phase "$authenticated_bootstrap_recovery_digest" || return 1
  rm -f -- "$HOST_BOOTSTRAP_IN_PROGRESS"
}

seal_interrupted_bootstrap_recovery() {
  bootstrap_recovery_state_is_present || return 0
  [[ -e ${HOST_BOOTSTRAP_RECOVERY_IN_PROGRESS} \
    || -L ${HOST_BOOTSTRAP_RECOVERY_IN_PROGRESS} ]] || return 0
  ensure_bootstrap_recovery_blocker || return 1
  systemctl stop set-livre-web.service set-livre-backoffice.service || return 1
  read_rollback_marker || return 1
  authorize_interrupted_bootstrap_recovery "$recovered_release"
}

seal_interrupted_release_recovery() {
  if bootstrap_recovery_state_is_present; then
    seal_interrupted_bootstrap_recovery
    return
  fi
  [[ -e ${ROLLBACK_MARKER} || -L ${ROLLBACK_MARKER} ]] || return 0
  systemctl stop set-livre-web.service set-livre-backoffice.service || return 1
  read_rollback_marker
}

# Invocada exclusivamente pelo trap do recovery de serviços.
# shellcheck disable=SC2317,SC2329
seal_interrupted_release_recovery_on_failure() {
  local status=$?
  trap - EXIT
  if [[ ${status} -ne 0 ]]; then
    seal_interrupted_release_recovery || status=1
  fi
  exit "$status"
}

[[ ${EUID} -eq 0 ]] || fail "execute como root."

if [[ ${1:-} == "--set-livre-deploy-lock-fd" ]]; then
  [[ $# -ge 2 ]] || fail "invocação interna do lock de deploy inválida."
  adopt_deploy_lock "$2"
  shift 2
else
  [[ -f ${DEPLOY_LOCK_HELPER} && ! -L ${DEPLOY_LOCK_HELPER} ]] \
    || fail "primitive instalada do lock de deploy é inválida."
  lock_policy=nonblocking
  if [[ $# -eq 1 && (${1:-} == "--seal-services" || ${1:-} == "--recover-services") ]]; then
    lock_policy="timeout=${RECOVERY_LOCK_TIMEOUT_SECONDS}"
  fi
  exec python3 "$DEPLOY_LOCK_HELPER" run "$lock_policy" "$SCRIPT_PATH" "$@"
fi

if [[ $# -eq 1 && ${1:-} == "--seal-services" ]]; then
  managed_release_directories_are_valid \
    || fail "raiz de releases não atende ao contrato físico e de permissões."
  seal_interrupted_release_recovery \
    || fail "não foi possível selar a recuperação interrompida."
  exit 0
fi

if [[ $# -eq 1 && ${1:-} == "--recover-services" ]]; then
  managed_release_directories_are_valid \
    || fail "raiz de releases não atende ao contrato físico e de permissões."
  trap seal_interrupted_release_recovery_on_failure EXIT
  if [[ -e ${ROLLBACK_MARKER} || -L ${ROLLBACK_MARKER} ]]; then
    read_rollback_marker || fail "não foi possível ler a ativação interrompida."
    if bootstrap_recovery_state_is_present; then
      begin_interrupted_bootstrap_recovery "$recovered_release" \
        || fail "o estado intermediário do bootstrap não autorizou a recuperação."
    fi
    activate_recovered_link || fail "não foi possível recuperar a ativação interrompida."
    if [[ -z ${recovered_release} ]]; then
      systemctl stop set-livre-web.service set-livre-backoffice.service \
        || fail "não foi possível estabilizar o host sem release anterior."
    elif ! systemctl restart set-livre-web.service set-livre-backoffice.service \
      || ! wait_for_health "$recovered_release" \
      || ! wait_for_public_health "$recovered_release"; then
      systemctl stop set-livre-web.service set-livre-backoffice.service || true
      fail "a release recuperada não atingiu readiness; serviços interrompidos."
    fi
    rm -f -- "$HOST_BOOTSTRAP_RECOVERY_IN_PROGRESS"
    rm -f -- "$ROLLBACK_MARKER"
    authenticated_bootstrap_recovery_digest=""
    printf 'Ativação interrompida recuperada e serviços estabilizados.\n'
  fi
  exit 0
fi

[[ ! -e ${HOST_BOOTSTRAP_IN_PROGRESS} && ! -L ${HOST_BOOTSTRAP_IN_PROGRESS} \
  && ! -e ${HOST_BOOTSTRAP_RECOVERY_IN_PROGRESS} \
  && ! -L ${HOST_BOOTSTRAP_RECOVERY_IN_PROGRESS} ]] \
  || fail "o bootstrap do host ainda não atingiu estado terminal."

verify_only=false
if [[ $# -eq 3 && ${3:-} == "--verify-only" ]]; then
  verify_only=true
elif [[ $# -ne 2 ]]; then
  fail "uso: set-livre-deploy <sha> <sha256> [--verify-only], --recover-services ou --seal-services."
fi

release_sha="$1"
expected_checksum="$2"
[[ ${release_sha} =~ ^[0-9a-f]{40}$ ]] || fail "SHA de release inválido."
[[ ${expected_checksum} =~ ^[0-9a-f]{64}$ ]] || fail "checksum inválido."
managed_release_directories_are_valid \
  || fail "raiz de releases não atende ao contrato físico e de permissões."
[[ -d ${INCOMING_DIRECTORY} && ! -L ${INCOMING_DIRECTORY} \
  && $(stat --format '%U:%G:%a' -- "$INCOMING_DIRECTORY") \
    == "deploy-setlivre:deploy-setlivre:700" ]] \
  || fail "diretório de entrada não atende ao contrato."
[[ -f ${UPLOAD_LOCK} && ! -L ${UPLOAD_LOCK} \
  && $(stat --format '%U:%G:%a' -- "$UPLOAD_LOCK") \
    == "deploy-setlivre:deploy-setlivre:600" ]] \
  || fail "lock de upload não atende ao contrato."

incoming_archive="${INCOMING_DIRECTORY}/set-livre-${release_sha}.tar.gz"
incoming_web_environment="${INCOMING_DIRECTORY}/web-${release_sha}.env"
incoming_backoffice_environment="${INCOMING_DIRECTORY}/backoffice-${release_sha}.env"

exec 8<>"$UPLOAD_LOCK"
flock --exclusive --timeout "$UPLOAD_LOCK_TIMEOUT_SECONDS" 8 \
  || fail "o lock de upload permaneceu ocupado durante a instalação."

trusted_archive=""
trusted_web_environment=""
trusted_backoffice_environment=""
staging_directory=""
activation_started=false
activation_complete=false
activation_failure=""
previous_release=""

remove_stale_staging_directories() {
  local name path
  while IFS= read -r -d '' path; do
    name="${path##*/}"
    [[ ${name} =~ ^\.staging-[0-9a-f]{40}\.[A-Za-z0-9]{6}$ ]] || return 1
    [[ ${path} == "${RELEASES_DIRECTORY}/"* && -d ${path} && ! -L ${path} ]] || return 1
    [[ $(stat --format '%U' -- "$path") == "root" ]] || return 1
    rm -rf --one-file-system -- "$path" || return 1
  done < <(
    find "$RELEASES_DIRECTORY" -mindepth 1 -maxdepth 1 -name '.staging-*' -print0
  )
}

remove_stale_trusted_files() {
  local name path
  while IFS= read -r -d '' path; do
    name="${path##*/}"
    [[ ${name} =~ ^set-livre-trusted\.[A-Za-z0-9]{6}\.(tar\.gz|env)$ ]] || return 1
    [[ ${path} == /var/tmp/set-livre-trusted.* && -f ${path} && ! -L ${path} ]] || return 1
    [[ $(stat --format '%U:%a' -- "$path") == "root:600" ]] || return 1
    rm -f -- "$path" || return 1
  done < <(
    find /var/tmp -mindepth 1 -maxdepth 1 -name 'set-livre-trusted.*' -print0
  )
}

cleanup_files() {
  rm -f -- \
    "$incoming_archive" \
    "$incoming_web_environment" \
    "$incoming_backoffice_environment" \
    "${trusted_archive:-}" \
    "${trusted_web_environment:-}" \
    "${trusted_backoffice_environment:-}" \
    "${CURRENT_LINK}.next"
  if [[ -n ${staging_directory:-} ]]; then
    rm -rf -- "$staging_directory"
  fi
}

rollback_activation() {
  printf 'A nova release falhou em %s; iniciando rollback.\n' \
    "${activation_failure:-interrupção inesperada}" >&2
  journalctl --unit set-livre-web.service --unit set-livre-backoffice.service \
    --lines 40 --no-pager >&2 || true

  if ! recover_link_from_marker; then
    systemctl stop set-livre-web.service set-livre-backoffice.service || true
    printf 'deploy: rollback falhou; serviços interrompidos para evitar estado divergente.\n' >&2
    return 1
  fi
  if [[ -z ${recovered_release} ]]; then
    systemctl stop set-livre-web.service set-livre-backoffice.service || return 1
    rm -f -- "$ROLLBACK_MARKER"
    return 0
  fi
  if systemctl restart set-livre-web.service set-livre-backoffice.service \
    && wait_for_health "$recovered_release" \
    && wait_for_public_health "$recovered_release"; then
    rm -f -- "$ROLLBACK_MARKER"
    return 0
  fi
  systemctl stop set-livre-web.service set-livre-backoffice.service || true
  printf 'deploy: release anterior não recuperou readiness interno e público; serviços interrompidos.\n' >&2
  return 1
}

on_exit() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [[ ${activation_started} == true && ${activation_complete} == false ]]; then
    rollback_activation || status=1
  fi
  cleanup_files
  exit "$status"
}

on_signal() {
  activation_failure="sinal $1"
  exit "$2"
}

trap on_exit EXIT
trap 'on_signal HUP 129' HUP
trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM

remove_stale_trusted_files \
  || fail "arquivo confiável residual possui identidade ou permissões inválidas."

if [[ -e ${ROLLBACK_MARKER} || -L ${ROLLBACK_MARKER} ]]; then
  recover_link_from_marker || fail "não foi possível recuperar o deploy anterior."
  if [[ -z ${recovered_release} ]]; then
    systemctl stop set-livre-web.service set-livre-backoffice.service \
      || fail "não foi possível estabilizar o host sem release anterior."
  elif ! systemctl restart set-livre-web.service set-livre-backoffice.service \
    || ! wait_for_health "$recovered_release" \
    || ! wait_for_public_health "$recovered_release"; then
    systemctl stop set-livre-web.service set-livre-backoffice.service || true
    fail "a release recuperada não atingiu readiness interno e público."
  fi
  rm -f -- "$ROLLBACK_MARKER"
fi

trust_incoming_file() {
  local source="$1"
  local maximum_bytes="$2"
  local suffix="$3"
  local destination
  [[ -f ${source} && ! -L ${source} ]] || fail "arquivo de entrada ausente ou inválido."
  [[ $(stat --format '%U' -- "$source") == "deploy-setlivre" ]] \
    || fail "arquivo de entrada tem owner inesperado."
  [[ $(stat --format '%a' -- "$source") == "600" ]] \
    || fail "arquivo de entrada tem modo inesperado."
  local bytes
  bytes="$(stat --format '%s' -- "$source")"
  [[ ${bytes} -gt 0 && ${bytes} -le ${maximum_bytes} ]] \
    || fail "arquivo de entrada excede o contrato de tamanho."
  destination="$(mktemp "/var/tmp/set-livre-trusted.XXXXXX${suffix}")"
  install -o root -g root -m 0600 -- "$source" "$destination"
  rm -f -- "$source"
  [[ $(stat --format '%s' -- "$destination") -eq ${bytes} ]] \
    || fail "cópia confiável diverge da entrada."
  printf '%s\n' "$destination"
}

trusted_archive="$(trust_incoming_file "$incoming_archive" "$MAX_ARCHIVE_BYTES" ".tar.gz")"
trusted_web_environment="$(
  trust_incoming_file "$incoming_web_environment" "$MAX_ENVIRONMENT_BYTES" ".env"
)"
trusted_backoffice_environment="$(
  trust_incoming_file "$incoming_backoffice_environment" "$MAX_ENVIRONMENT_BYTES" ".env"
)"

actual_checksum="$(sha256sum -- "$trusted_archive" | cut -d ' ' -f 1)"
[[ ${actual_checksum} == "${expected_checksum}" ]] || fail "checksum do archive diverge."

python3 - "$trusted_web_environment" "$trusted_backoffice_environment" <<'PYTHON'
import pathlib
import re
import sys
import urllib.parse

web_path, backoffice_path = map(pathlib.Path, sys.argv[1:])
expected_keys = {
    "APP_ENV",
    "DATABASE_URL_APP_DAL",
    "NEXT_PUBLIC_APP_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "NEXT_PUBLIC_SUPABASE_URL",
}
project_ref = "oirvvnojgkzdppkdvhej"
supabase_url = f"https://{project_ref}.supabase.co"


def fail(label, reason):
    raise SystemExit(f"ambiente {label} inválido: {reason}")


def read_environment(path, label, expected_app_url):
    try:
        raw = path.read_bytes()
        text = raw.decode("utf-8")
    except (OSError, UnicodeDecodeError):
        fail(label, "conteúdo ilegível")
    if not raw or len(raw) > 64 * 1024 or b"\x00" in raw or "\r" in text or not text.endswith("\n"):
        fail(label, "encoding ou tamanho")

    values = {}
    for line in text.splitlines():
        match = re.fullmatch(r"([A-Z][A-Z0-9_]*)=(.*)", line)
        if match is None or match.group(1) in values:
            fail(label, "linha ou chave duplicada")
        values[match.group(1)] = match.group(2)
    if set(values) != expected_keys or any(value == "" for value in values.values()):
        fail(label, "conjunto de chaves")
    if values["APP_ENV"] != "production":
        fail(label, "APP_ENV")
    if values["NEXT_PUBLIC_APP_URL"] != expected_app_url:
        fail(label, "origem pública")
    if values["NEXT_PUBLIC_SUPABASE_URL"] != supabase_url:
        fail(label, "projeto Supabase")
    publishable_key = values["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
    if re.fullmatch(r"sb_publishable_[A-Za-z0-9_-]{12,}", publishable_key) is None:
        fail(label, "publishable key")

    try:
        database_url = urllib.parse.urlsplit(values["DATABASE_URL_APP_DAL"])
        username = urllib.parse.unquote(database_url.username or "")
        password = urllib.parse.unquote(database_url.password or "")
        parameters = urllib.parse.parse_qs(database_url.query, keep_blank_values=True)
        port = database_url.port
    except (ValueError, UnicodeError):
        fail(label, "URL DAL")
    if (
        database_url.scheme not in {"postgres", "postgresql"}
        or username != f"app_runtime_production.{project_ref}"
        or not password
        or database_url.hostname != "aws-0-sa-east-1.pooler.supabase.com"
        or port != 5432
        or database_url.path != "/postgres"
        or database_url.fragment
        or parameters != {"options": ["-c role=app_dal"], "sslmode": ["verify-full"]}
    ):
        fail(label, "contrato DAL")
    return values


web = read_environment(web_path, "web", "https://147.15.97.227")
backoffice = read_environment(backoffice_path, "backoffice", "https://ops.setlivre.com")
if web["DATABASE_URL_APP_DAL"] != backoffice["DATABASE_URL_APP_DAL"]:
    fail("runtime", "URLs DAL divergentes")
if web["NEXT_PUBLIC_SUPABASE_ANON_KEY"] != backoffice["NEXT_PUBLIC_SUPABASE_ANON_KEY"]:
    fail("runtime", "publishable keys divergentes")
PYTHON

remove_stale_staging_directories \
  || fail "diretório de staging residual possui identidade ou permissões inválidas."
staging_directory="$(mktemp --directory "${RELEASES_DIRECTORY}/.staging-${release_sha}.XXXXXX")"

python3 - "$trusted_archive" "$staging_directory" <<'PYTHON'
import gzip
import sys
import tarfile
from pathlib import PurePosixPath

archive, destination = sys.argv[1:]
allowed_roots = {"backoffice", "release-manifest.json", "web"}
maximum_entries = 20_000
maximum_extracted_bytes = 512 * 1024 * 1024
maximum_extended_header_bytes = 64 * 1024
maximum_metadata_bytes = 8 * 1024 * 1024
maximum_raw_headers = maximum_entries * 2 + 32
maximum_tar_stream_bytes = (
    maximum_extracted_bytes
    + maximum_metadata_bytes
    + (maximum_raw_headers + 2) * tarfile.BLOCKSIZE
)
extended_header_types = {
    tarfile.GNUTYPE_LONGLINK,
    tarfile.GNUTYPE_LONGNAME,
    tarfile.XGLTYPE,
    tarfile.XHDTYPE,
}
solaris_extended_header = getattr(tarfile, "SOLARIS_XHDTYPE", None)
if solaris_extended_header is not None:
    extended_header_types.add(solaris_extended_header)


def read_exact(stream, size):
    chunks = []
    remaining = size
    while remaining > 0:
        chunk = stream.read(min(remaining, 64 * 1024))
        if not chunk:
            raise ValueError("archive truncado")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def discard_exact(stream, size):
    remaining = size
    while remaining > 0:
        chunk = stream.read(min(remaining, 64 * 1024))
        if not chunk:
            raise ValueError("archive truncado")
        remaining -= len(chunk)


def validate_tar_headers(path):
    metadata_bytes = 0
    raw_headers = 0
    stream_bytes = 0
    zero_blocks = 0
    with gzip.open(path, mode="rb") as stream:
        while True:
            header = read_exact(stream, tarfile.BLOCKSIZE)
            stream_bytes += tarfile.BLOCKSIZE
            if header == b"\0" * tarfile.BLOCKSIZE:
                zero_blocks += 1
                if zero_blocks == 2:
                    return
                continue
            if zero_blocks != 0:
                raise ValueError("terminador tar inválido")

            raw_headers += 1
            if raw_headers > maximum_raw_headers:
                raise ValueError("quantidade de headers tar inválida")
            try:
                raw_member = tarfile.TarInfo.frombuf(
                    header,
                    encoding="utf-8",
                    errors="surrogateescape",
                )
            except (tarfile.TarError, UnicodeError, ValueError) as error:
                raise ValueError("header tar inválido") from error

            if raw_member.size < 0:
                raise ValueError("tamanho de entrada tar inválido")
            if raw_member.type == tarfile.GNUTYPE_SPARSE:
                raise ValueError("formato sparse não autorizado")
            if raw_member.type in extended_header_types:
                if raw_member.size > maximum_extended_header_bytes:
                    raise ValueError("metadata estendida excede o limite")
                metadata_bytes += raw_member.size
                if metadata_bytes > maximum_metadata_bytes:
                    raise ValueError("metadata tar acumulada excede o limite")

            padded_size = (
                (raw_member.size + tarfile.BLOCKSIZE - 1) // tarfile.BLOCKSIZE
            ) * tarfile.BLOCKSIZE
            stream_bytes += padded_size
            if stream_bytes > maximum_tar_stream_bytes:
                raise ValueError("stream tar descompactado excede o limite")
            discard_exact(stream, padded_size)

try:
    validate_tar_headers(archive)
    with tarfile.open(archive, mode="r:gz") as bundle:
        members = []
        extracted_bytes = 0
        seen = set()
        for entry_count, member in enumerate(bundle, start=1):
            if entry_count > maximum_entries:
                raise ValueError("quantidade de entradas inválida")
            members.append(member)
            if "\\" in member.name or any(ord(character) < 32 for character in member.name):
                raise ValueError("nome de entrada inválido")

            path = PurePosixPath(member.name)
            parts = tuple(part for part in path.parts if part not in ("", "."))
            if path.is_absolute() or ".." in parts:
                raise ValueError("caminho de entrada inseguro")
            if not parts:
                if not member.isdir():
                    raise ValueError("entrada raiz inválida")
                continue
            if parts[0] not in allowed_roots:
                raise ValueError("raiz de entrada não autorizada")

            normalized = "/".join(parts)
            if normalized in seen:
                raise ValueError("entrada duplicada")
            seen.add(normalized)

            if not (member.isdir() or member.isfile()):
                raise ValueError("tipo de entrada não autorizado")
            if parts[0] == "release-manifest.json" and (
                len(parts) != 1 or not member.isfile()
            ):
                raise ValueError("manifesto não é arquivo regular de topo")

            extracted_bytes += member.size
            if extracted_bytes > maximum_extracted_bytes:
                raise ValueError("conteúdo extraído excede o limite")

        if not members:
            raise ValueError("quantidade de entradas inválida")
        bundle.extractall(path=destination, members=members, filter="data")
except (EOFError, OSError, tarfile.TarError, ValueError) as error:
    raise SystemExit(f"archive inválido: {error}") from error
PYTHON

if find "$staging_directory" -type l -print -quit | grep --quiet .; then
  fail "release contém link simbólico."
fi

mapfile -t top_level < <(find "$staging_directory" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)
[[ ${#top_level[@]} -eq 3 ]] || fail "release possui conteúdo de topo inesperado."
[[ ${top_level[0]} == "backoffice" && ${top_level[1]} == "release-manifest.json" \
  && ${top_level[2]} == "web" ]] || fail "estrutura da release inválida."
[[ -f "${staging_directory}/web/server.js" ]] || fail "entrypoint web ausente."
[[ -f "${staging_directory}/backoffice/apps/backoffice/server.js" ]] \
  || fail "entrypoint backoffice ausente."
jq --exit-status --arg sha "$release_sha" '
  .version == 2 and
  .commit == $sha and
  (.hostConfiguration.sha256 | test("^[0-9a-f]{64}$")) and
  .applications.web.entrypoint == "server.js" and
  .applications.web.health == "/api/health/ready" and
  .applications.backoffice.entrypoint == "apps/backoffice/server.js" and
  .applications.backoffice.health == "/api/health/ready"
' "${staging_directory}/release-manifest.json" >/dev/null || fail "manifesto da release inválido."

[[ -f ${HOST_CONFIGURATION_DIGEST} && ! -L ${HOST_CONFIGURATION_DIGEST} ]] \
  || fail "digest da configuração do host ausente."
[[ $(stat --format '%U:%G:%a' -- "$HOST_CONFIGURATION_DIGEST") == "root:setlivre:640" ]] \
  || fail "digest da configuração do host tem permissões inválidas."
installed_host_digest="$(< "$HOST_CONFIGURATION_DIGEST")"
manifest_host_digest="$(jq --raw-output '.hostConfiguration.sha256' "${staging_directory}/release-manifest.json")"
[[ ${installed_host_digest} =~ ^[0-9a-f]{64}$ ]] || fail "digest instalado é inválido."
[[ ${manifest_host_digest} == "${installed_host_digest}" ]] \
  || fail "configuração do host divergiu; reaplique o bootstrap versionado."

if [[ ${verify_only} == true ]]; then
  printf 'Release %s, ambientes e configuração do host verificados sem ativação.\n' "$release_sha"
  exit 0
fi

printf '%s\n' "$actual_checksum" > "${staging_directory}/.artifact.sha256"
install -d -o root -g setlivre -m 0750 "${staging_directory}/.runtime"
install -o root -g setlivre-web -m 0640 \
  "$trusted_web_environment" "${staging_directory}/.runtime/web.env"
install -o root -g setlivre-backoffice -m 0640 \
  "$trusted_backoffice_environment" "${staging_directory}/.runtime/backoffice.env"
printf 'APP_RELEASE_SHA=%s\n' "$release_sha" > "${staging_directory}/.runtime/release.env"
chown -R root:setlivre "$staging_directory"
find "$staging_directory" -type d -exec chmod 0750 {} +
find "$staging_directory" -type f -exec chmod 0640 {} +
chown root:setlivre-web "${staging_directory}/.runtime/web.env"
chown root:setlivre-backoffice "${staging_directory}/.runtime/backoffice.env"

release_directory="${RELEASES_DIRECTORY}/${release_sha}"
if [[ -e ${release_directory} ]]; then
  [[ -d ${release_directory} && ! -L ${release_directory} ]] \
    || fail "destino da release não é diretório regular."
  [[ -f "${release_directory}/.artifact.sha256" ]] \
    || fail "release existente não tem checksum."
  [[ $(< "${release_directory}/.artifact.sha256") == "${actual_checksum}" ]] \
    || fail "SHA já existe com bytes diferentes."
  cmp --silent "$trusted_web_environment" "${release_directory}/.runtime/web.env" \
    || fail "SHA já existe com ambiente web diferente."
  cmp --silent "$trusted_backoffice_environment" "${release_directory}/.runtime/backoffice.env" \
    || fail "SHA já existe com ambiente backoffice diferente."
  [[ $(< "${release_directory}/.runtime/release.env") == "APP_RELEASE_SHA=${release_sha}" ]] \
    || fail "SHA já existe com identidade de release diferente."
  staging_tree_digest="$(release_tree_digest "$staging_directory")" \
    || fail "árvore preparada da release não pôde ser verificada."
  installed_tree_digest="$(release_tree_digest "$release_directory")" \
    || fail "árvore instalada da release não pôde ser verificada."
  [[ ${installed_tree_digest} == "${staging_tree_digest}" ]] \
    || fail "SHA já existe com árvore instalada divergente."
  rm -rf -- "$staging_directory"
  staging_directory=""
else
  mv -- "$staging_directory" "$release_directory"
  staging_directory=""
fi

if [[ -L ${CURRENT_LINK} ]]; then
  previous_release="$(readlink --canonicalize-existing -- "$CURRENT_LINK")"
  [[ ${previous_release} =~ ^${RELEASES_DIRECTORY}/[0-9a-f]{40}$ \
    && -d ${previous_release} && ! -L ${previous_release} ]] \
    || fail "symlink current aponta para destino inválido."
elif [[ -e ${CURRENT_LINK} ]]; then
  fail "current existe e não é link simbólico."
fi

prune_releases() {
  local candidate="$1"
  local previous="$2"
  local name path
  mapfile -t release_names < <(
    find "$RELEASES_DIRECTORY" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort
  )
  for name in "${release_names[@]}"; do
    [[ ${name} =~ ^[0-9a-f]{40}$ ]] || return 1
    path="${RELEASES_DIRECTORY}/${name}"
    [[ -d ${path} && ! -L ${path} ]] || return 1
  done

  mapfile -t newest_names < <(
    find "$RELEASES_DIRECTORY" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' \
      | sort --numeric-sort --reverse \
      | cut -d ' ' -f 2
  )
  declare -A keep=()
  keep["$(basename -- "$candidate")"]=1
  if [[ -n ${previous} ]]; then
    keep["$(basename -- "$previous")"]=1
  fi
  for name in "${newest_names[@]}"; do
    if [[ ${#keep[@]} -ge ${RETAINED_RELEASES} ]]; then
      break
    fi
    keep["$name"]=1
  done
  for name in "${release_names[@]}"; do
    if [[ -z ${keep[$name]+present} ]]; then
      path="${RELEASES_DIRECTORY}/${name}"
      [[ ${path} == "${RELEASES_DIRECTORY}/"* && ${path} != "$RELEASES_DIRECTORY" ]] || return 1
      rm -rf --one-file-system -- "$path" || return 1
    fi
  done
}

prune_releases "$release_directory" "$previous_release" \
  || fail "não foi possível aplicar a retenção antes da ativação."
write_rollback_marker "$previous_release" || fail "não foi possível preparar a recuperação atômica."

activation_started=true
activation_failure="troca do symlink"
activate_link "$release_directory" || fail "$activation_failure"
activation_failure="reinício dos serviços"
systemctl restart set-livre-web.service set-livre-backoffice.service || fail "$activation_failure"
activation_failure="readiness interno"
wait_for_health "$release_sha" || fail "$activation_failure"
activation_failure="readiness HTTPS público"
wait_for_public_health "$release_sha" || fail "$activation_failure"

trap '' HUP INT TERM
rm -f -- "$ROLLBACK_MARKER"
activation_complete=true
trap 'on_signal HUP 129' HUP
trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM

printf 'Release %s ativa, pública e pronta.\n' "$release_sha"
