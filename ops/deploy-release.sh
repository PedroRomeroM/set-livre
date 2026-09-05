#!/usr/bin/env bash
set -Eeuo pipefail

readonly RELEASES_DIRECTORY="/opt/set-livre/releases"
readonly CURRENT_LINK="/opt/set-livre/current"
readonly ROLLBACK_MARKER="/opt/set-livre/.activation-rollback"
readonly HOST_CONFIGURATION_DIGEST="/etc/set-livre/host-config.sha256"
readonly NODE_BINARY_DIGEST="/etc/set-livre/node-binary.sha256"
readonly HOST_BOOTSTRAP_IN_PROGRESS="/etc/set-livre/bootstrap-in-progress.sha256"
readonly HOST_BOOTSTRAP_RECOVERY_IN_PROGRESS="/etc/set-livre/bootstrap-recovery-in-progress.sha256"
readonly INCOMING_DIRECTORY="/home/deploy-setlivre/incoming"
readonly UPLOAD_LOCK="${INCOMING_DIRECTORY}/.incoming.lock"
readonly DEPLOY_LOCK_HELPER="/usr/local/sbin/set-livre-deploy-lock"
readonly PRODUCTION_IP="147.15.97.227"
readonly PRODUCTION_URL="https://${PRODUCTION_IP}"
readonly CERTIFICATE_MINIMUM_VALIDITY_SECONDS=86400
readonly MAX_ARCHIVE_BYTES=$((256 * 1024 * 1024))
readonly MAX_ENVIRONMENT_BYTES=$((64 * 1024))
readonly RETAINED_RELEASES=4
readonly RECOVERY_LOCK_TIMEOUT_SECONDS=300
readonly UPLOAD_LOCK_TIMEOUT_SECONDS=300
readonly INSTALLED_DEPLOY_ENTRYPOINT="/usr/local/sbin/set-livre-deploy"
readonly STAGED_TREE_DIGEST_RELATIVE_PATH=".runtime/staged-tree.sha256"
readonly RUNTIME_ENVIRONMENT_DIGEST_RELATIVE_PATH=".runtime/environment-contract.sha256"
readonly NODE_VERSION="24.18.0"
readonly NODE_INSTALLATION_DIRECTORY="/opt/node-v${NODE_VERSION}-linux-x64"
readonly NODE_ALIAS_PATH="/opt/node"
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
    --exclude="./${STAGED_TREE_DIGEST_RELATIVE_PATH}" \
    --sort=name \
    --format=gnu \
    --mtime='@0' \
    --numeric-owner \
    . \
    | sha256sum \
    | cut --delimiter=' ' --fields=1
}

runtime_environment_digest() {
  local web_environment="$1"
  local backoffice_environment="$2"
  [[ -f ${web_environment} && ! -L ${web_environment} \
    && -f ${backoffice_environment} && ! -L ${backoffice_environment} ]] \
    || return 1
  {
    printf 'web.env\0'
    cat -- "$web_environment"
    printf '\0backoffice.env\0'
    cat -- "$backoffice_environment"
    printf '\0'
  } | sha256sum | cut --delimiter=' ' --fields=1
}

installed_host_configuration_digest() {
  python3 <<'PYTHON'
import hashlib
import os
import pathlib
import stat

files = (
    ("bootstrap-host.sh", "/usr/local/share/set-livre/bootstrap-host.sh", 0o755),
    ("certificates/supabase-root-2021-ca.crt", "/etc/set-livre/supabase-root-2021-ca.crt", 0o644),
    ("deploy-release.sh", "/usr/local/sbin/set-livre-deploy", 0o755),
    ("deploy-ssh-command.sh", "/usr/local/sbin/set-livre-deploy-ssh", 0o755),
    ("deploy-lock.py", "/usr/local/sbin/set-livre-deploy-lock", 0o755),
    ("nginx/set-livre-http.conf", "/usr/local/share/set-livre/nginx-http.conf", 0o644),
    ("nginx/set-livre-tls.conf", "/usr/local/share/set-livre/nginx-tls.conf", 0o644),
    ("systemd/set-livre-application-start.service", "/etc/systemd/system/set-livre-application-start.service", 0o644),
    ("systemd/set-livre-backoffice.service", "/etc/systemd/system/set-livre-backoffice.service", 0o644),
    ("systemd/set-livre-media-cleanup.service", "/etc/systemd/system/set-livre-media-cleanup.service", 0o644),
    ("systemd/set-livre-media-cleanup.timer", "/etc/systemd/system/set-livre-media-cleanup.timer", 0o644),
    ("systemd/set-livre-release-recovery.path", "/etc/systemd/system/set-livre-release-recovery.path", 0o644),
    ("systemd/set-livre-release-recovery.service", "/etc/systemd/system/set-livre-release-recovery.service", 0o644),
    ("systemd/set-livre-web.service", "/etc/systemd/system/set-livre-web.service", 0o644),
)
digest = hashlib.sha256()
for label, absolute, expected_mode in files:
    path = pathlib.Path(absolute)
    metadata = path.lstat()
    if (
        not stat.S_ISREG(metadata.st_mode)
        or path.is_symlink()
        or metadata.st_uid != 0
        or metadata.st_gid != 0
        or stat.S_IMODE(metadata.st_mode) != expected_mode
        or metadata.st_nlink != 1
    ):
        raise SystemExit(f"arquivo operacional instalado inválido: {absolute}")
    digest.update(label.encode("utf-8"))
    digest.update(b"\0")
    digest.update(path.read_bytes())
    digest.update(b"\0")
print(digest.hexdigest())
PYTHON
}

node_runtime_is_valid() {
  local actual_digest expected_digest
  [[ -d ${NODE_INSTALLATION_DIRECTORY} && ! -L ${NODE_INSTALLATION_DIRECTORY} \
    && $(stat --format '%U:%G:%a' -- "$NODE_INSTALLATION_DIRECTORY") == "root:root:755" \
    && -L ${NODE_ALIAS_PATH} \
    && $(readlink -- "$NODE_ALIAS_PATH") == "$NODE_INSTALLATION_DIRECTORY" \
    && $(readlink --canonicalize-existing -- "$NODE_ALIAS_PATH") \
      == "$NODE_INSTALLATION_DIRECTORY" \
    && -f "${NODE_INSTALLATION_DIRECTORY}/bin/node" \
    && ! -L "${NODE_INSTALLATION_DIRECTORY}/bin/node" \
    && $(stat --format '%U:%G:%a:%h' -- "${NODE_INSTALLATION_DIRECTORY}/bin/node") \
      == "root:root:755:1" ]] || return 1
  expected_digest="$(
    read_host_state_digest "$NODE_BINARY_DIGEST" "root:setlivre:640"
  )" || return 1
  actual_digest="$(sha256sum "${NODE_INSTALLATION_DIRECTORY}/bin/node" | cut -d ' ' -f 1)" \
    || return 1
  [[ ${actual_digest} == "$expected_digest" \
    && "$("${NODE_INSTALLATION_DIRECTORY}/bin/node" --version)" == "v${NODE_VERSION}" ]]
}

effective_nginx_site_is_current() {
  local enabled_site="/etc/nginx/sites-enabled/set-livre"
  local expected_site="/etc/nginx/sites-available/set-livre"
  local expected_template="/usr/local/share/set-livre/nginx-tls.conf"
  [[ -f ${expected_site} && ! -L ${expected_site} \
    && $(stat --format '%U:%G:%a:%h' -- "$expected_site") == "root:root:644:1" \
    && -L ${enabled_site} \
    && $(readlink -- "$enabled_site") == "$expected_site" \
    && $(readlink --canonicalize-existing -- "$enabled_site") == "$expected_site" \
    && ! -e /etc/nginx/sites-enabled/default \
    && ! -L /etc/nginx/sites-enabled/default ]] \
    || return 1
  cmp --silent -- "$expected_template" "$expected_site"
}

loaded_systemd_units_are_current() {
  local unit expected_fragment expected_state actual_state
  for unit in \
    set-livre-web.service \
    set-livre-backoffice.service \
    set-livre-media-cleanup.service \
    set-livre-media-cleanup.timer \
    set-livre-application-start.service \
    set-livre-release-recovery.service \
    set-livre-release-recovery.path; do
    expected_fragment="/etc/systemd/system/${unit}"
    case "$unit" in
      set-livre-application-start.service | set-livre-media-cleanup.timer | set-livre-release-recovery.path)
        expected_state="enabled"
        ;;
      *)
        expected_state="static"
        ;;
    esac
    actual_state="$(systemctl is-enabled "$unit" 2>/dev/null || true)"
    [[ $(systemctl show --property=LoadState --value "$unit") == "loaded" \
      && $(systemctl show --property=FragmentPath --value "$unit") == "$expected_fragment" \
      && -z $(systemctl show --property=DropInPaths --value "$unit") \
      && $(systemctl show --property=NeedDaemonReload --value "$unit") == "no" \
      && ${actual_state} == "$expected_state" ]] \
      || return 1
  done
}

stop_media_cleanup_schedule() {
  systemctl stop set-livre-media-cleanup.timer || return 1
  systemctl stop set-livre-application-start.service || return 1
  systemctl stop set-livre-media-cleanup.service
}

start_media_cleanup_schedule() {
  systemctl start set-livre-media-cleanup.timer
}

run_media_cleanup_once() {
  systemctl start set-livre-media-cleanup.service
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

bootstrap_is_terminal() {
  ! bootstrap_recovery_state_is_present
}

activation_is_terminal() {
  [[ ! -e ${ROLLBACK_MARKER} && ! -L ${ROLLBACK_MARKER} ]]
}

production_https_contract_is_ready() {
  local certificate="/etc/letsencrypt/live/${PRODUCTION_IP}/fullchain.pem"
  local private_key="/etc/letsencrypt/live/${PRODUCTION_IP}/privkey.pem"
  [[ -f ${certificate} && -f ${private_key} ]] || {
    printf 'deploy: certificado TLS de IP está ausente ou incompleto.\n' >&2
    return 1
  }
  openssl x509 -checkend "$CERTIFICATE_MINIMUM_VALIDITY_SECONDS" -noout \
    -in "$certificate" >/dev/null 2>&1 || {
    printf 'deploy: certificado TLS de IP expira em menos de 24 horas.\n' >&2
    return 1
  }
  openssl x509 -checkip "$PRODUCTION_IP" -noout -in "$certificate" >/dev/null 2>&1 || {
    printf 'deploy: certificado TLS não cobre o IP de produção.\n' >&2
    return 1
  }
  nginx -t >/dev/null 2>&1 || {
    printf 'deploy: configuração efetiva do Nginx é inválida.\n' >&2
    return 1
  }
  systemctl is-active --quiet nginx.service || {
    printf 'deploy: serviço Nginx não está ativo.\n' >&2
    return 1
  }
}

validate_deployment_host_prerequisites() {
  local installed_host_digest recorded_host_digest
  bootstrap_is_terminal \
    || fail "o bootstrap do host ainda não atingiu estado terminal."
  activation_is_terminal \
    || fail "a ativação anterior ainda não atingiu estado terminal."
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
  recorded_host_digest="$(
    read_host_state_digest "$HOST_CONFIGURATION_DIGEST" "root:setlivre:640"
  )" || fail "digest registrado da configuração do host é inválido."
  installed_host_digest="$(installed_host_configuration_digest)" \
    || fail "arquivos operacionais efetivos do host são inválidos."
  [[ ${installed_host_digest} == "$recorded_host_digest" ]] \
    || fail "arquivos operacionais efetivos divergiram do bootstrap registrado."
  node_runtime_is_valid \
    || fail "runtime Node efetivo divergiu do binário verificado no bootstrap."
  effective_nginx_site_is_current \
    || fail "site Nginx efetivo divergiu do contrato TLS instalado."
  loaded_systemd_units_are_current \
    || fail "units efetivas do systemd divergiram dos arquivos operacionais instalados."
  production_https_contract_is_ready \
    || fail "entrada HTTPS do host não atende ao contrato pré-migration."
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
  stop_media_cleanup_schedule || return 1
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
  stop_media_cleanup_schedule || return 1
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

if [[ $# -eq 1 && ${1:-} == "--preflight" ]]; then
  [[ ${SCRIPT_PATH} == "$INSTALLED_DEPLOY_ENTRYPOINT" \
    && -f ${INSTALLED_DEPLOY_ENTRYPOINT} && ! -L ${INSTALLED_DEPLOY_ENTRYPOINT} \
    && $(stat --format '%U:%G:%a:%h' -- "$INSTALLED_DEPLOY_ENTRYPOINT") \
      == "root:root:755:1" ]] \
    || fail "entrypoint privilegiado instalado diverge do contrato."
  [[ -f ${DEPLOY_LOCK_HELPER} && ! -L ${DEPLOY_LOCK_HELPER} \
    && $(stat --format '%U:%G:%a:%h' -- "$DEPLOY_LOCK_HELPER") == "root:root:755:1" ]] \
    || fail "primitive instalada do lock de deploy diverge do contrato."
  validate_deployment_host_prerequisites
  printf 'set-livre-deploy-ready-v11\n'
  exit 0
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
    stop_media_cleanup_schedule \
      || fail "não foi possível bloquear o cleanup durante a recuperação."
    systemctl stop set-livre-web.service set-livre-backoffice.service \
      || fail "não foi possível interromper os aplicativos antes da recuperação."
    read_rollback_marker || fail "não foi possível ler a ativação interrompida."
    if bootstrap_recovery_state_is_present; then
      begin_interrupted_bootstrap_recovery "$recovered_release" \
        || fail "o estado intermediário do bootstrap não autorizou a recuperação."
    fi
    activate_recovered_link || fail "não foi possível recuperar a ativação interrompida."
    if [[ -z ${recovered_release} ]]; then
      systemctl stop set-livre-web.service set-livre-backoffice.service \
        || fail "não foi possível estabilizar o host sem release anterior."
    elif ! run_media_cleanup_once \
      || ! systemctl restart set-livre-web.service set-livre-backoffice.service \
      || ! wait_for_health "$recovered_release" \
      || ! wait_for_public_health "$recovered_release"; then
      systemctl stop set-livre-web.service set-livre-backoffice.service || true
      fail "a release recuperada não atingiu readiness; serviços interrompidos."
    fi
    rm -f -- "$HOST_BOOTSTRAP_RECOVERY_IN_PROGRESS"
    if [[ -n ${recovered_release} ]] && ! start_media_cleanup_schedule; then
      systemctl stop set-livre-web.service set-livre-backoffice.service || true
      fail "o timer de cleanup não foi ativado após terminalizar o bootstrap; serviços interrompidos."
    fi
    rm -f -- "$ROLLBACK_MARKER"
    authenticated_bootstrap_recovery_digest=""
    printf 'Ativação interrompida recuperada e serviços estabilizados.\n'
  fi
  exit 0
fi

validate_deployment_host_prerequisites

stage_only=false
activation_only=false
inspection_only=false
if [[ $# -eq 3 && ${1:-} == "--inspect-staged" ]]; then
  inspection_only=true
  release_sha="$2"
  expected_runtime_environment_digest="$3"
  expected_checksum=""
elif [[ $# -eq 4 && ${4:-} == "--stage-only" ]]; then
  stage_only=true
  release_sha="$1"
  expected_checksum="$2"
  expected_runtime_environment_digest="$3"
elif [[ $# -eq 4 && ${4:-} == "--activate-staged" ]]; then
  activation_only=true
  release_sha="$1"
  expected_checksum="$2"
  expected_runtime_environment_digest="$3"
elif [[ $# -ne 3 ]]; then
  fail "uso: set-livre-deploy <sha> <sha256> <runtime-sha256> [--stage-only|--activate-staged], --inspect-staged <sha> <runtime-sha256>, --preflight, --recover-services ou --seal-services."
else
  release_sha="$1"
  expected_checksum="$2"
  expected_runtime_environment_digest="$3"
fi

[[ ${release_sha} =~ ^[0-9a-f]{40}$ ]] || fail "SHA de release inválido."
[[ ${expected_runtime_environment_digest} =~ ^[0-9a-f]{64}$ ]] \
  || fail "digest esperado dos ambientes de runtime é inválido."
if [[ ${inspection_only} == false ]]; then
  [[ ${expected_checksum} =~ ^[0-9a-f]{64}$ ]] || fail "checksum inválido."
fi
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
  if [[ ${inspection_only} == true ]]; then
    return
  fi
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
    --unit set-livre-media-cleanup.service \
    --lines 40 --no-pager >&2 || true

  if ! stop_media_cleanup_schedule \
    || ! systemctl stop set-livre-web.service set-livre-backoffice.service \
    || ! recover_link_from_marker; then
    systemctl stop set-livre-web.service set-livre-backoffice.service || true
    printf 'deploy: rollback falhou; serviços interrompidos para evitar estado divergente.\n' >&2
    return 1
  fi
  if [[ -z ${recovered_release} ]]; then
    systemctl stop set-livre-web.service set-livre-backoffice.service || return 1
    rm -f -- "$ROLLBACK_MARKER"
    return 0
  fi
  if run_media_cleanup_once \
    && systemctl restart set-livre-web.service set-livre-backoffice.service \
    && wait_for_health "$recovered_release" \
    && wait_for_public_health "$recovered_release" \
    && start_media_cleanup_schedule; then
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

validate_staged_release() {
  local directory="$1"
  local expected_release="$2"
  local expected_archive_checksum="$3"
  local expected_runtime_digest="$4"
  local actual_runtime_digest installed_host_digest manifest_host_digest actual_tree_digest
  local -a artifact_checksum=()
  local -a persisted_runtime_digest=()
  local -a release_identity=()
  local -a persisted_tree_digest=()
  local -a top_level=()

  [[ ${directory} == "${RELEASES_DIRECTORY}/${expected_release}" \
    && -d ${directory} && ! -L ${directory} \
    && $(stat --format '%U:%G:%a' -- "$directory") == "root:setlivre:750" ]] \
    || fail "release staged não atende ao contrato físico."
  if find "$directory" -xdev \( ! -user root -o -perm /022 \) -print -quit | grep --quiet .; then
    fail "release staged possui owner ou permissão gravável inesperada."
  fi
  if find "$directory" -xdev -type l -print -quit | grep --quiet .; then
    fail "release staged contém link simbólico."
  fi

  mapfile -t top_level < <(find "$directory" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)
  [[ ${#top_level[@]} -eq 5 \
    && ${top_level[0]} == ".artifact.sha256" \
    && ${top_level[1]} == ".runtime" \
    && ${top_level[2]} == "backoffice" \
    && ${top_level[3]} == "release-manifest.json" \
    && ${top_level[4]} == "web" ]] \
    || fail "release staged possui conteúdo de topo inesperado."
  [[ -f "${directory}/web/server.js" \
    && -f "${directory}/web/runtime/invoke-media-cleanup.mjs" \
    && -f "${directory}/backoffice/apps/backoffice/server.js" ]] \
    || fail "release staged não contém os entrypoints esperados."
  [[ -f "${directory}/.artifact.sha256" \
    && ! -L "${directory}/.artifact.sha256" \
    && $(stat --format '%U:%G:%a' -- "${directory}/.artifact.sha256") \
      == "root:setlivre:640" ]] \
    || fail "checksum da release staged possui metadados inválidos."
  mapfile -t artifact_checksum < "${directory}/.artifact.sha256"
  [[ ${#artifact_checksum[@]} -eq 1 \
    && ${artifact_checksum[0]} == "$expected_archive_checksum" ]] \
    || fail "checksum da release staged diverge do candidato."
  [[ $(stat --format '%U:%G:%a' -- "${directory}/.runtime/web.env") \
      == "root:setlivre-web:640" \
    && $(stat --format '%U:%G:%a' -- "${directory}/.runtime/backoffice.env") \
      == "root:setlivre-backoffice:640" \
    && $(stat --format '%U:%G:%a' -- "${directory}/.runtime/release.env") \
      == "root:setlivre:640" \
    && $(stat --format '%U:%G:%a' -- \
      "${directory}/${RUNTIME_ENVIRONMENT_DIGEST_RELATIVE_PATH}") \
      == "root:setlivre:640" \
    && $(stat --format '%U:%G:%a' -- "${directory}/${STAGED_TREE_DIGEST_RELATIVE_PATH}") \
      == "root:setlivre:640" ]] \
    || fail "ambientes da release staged possuem metadados inválidos."
  mapfile -t release_identity < "${directory}/.runtime/release.env"
  [[ ${#release_identity[@]} -eq 1 \
    && ${release_identity[0]} == "APP_RELEASE_SHA=${expected_release}" ]] \
    || fail "identidade da release staged diverge do candidato."
  mapfile -t persisted_runtime_digest \
    < "${directory}/${RUNTIME_ENVIRONMENT_DIGEST_RELATIVE_PATH}"
  [[ ${#persisted_runtime_digest[@]} -eq 1 \
    && ${persisted_runtime_digest[0]} =~ ^[0-9a-f]{64}$ ]] \
    || fail "digest persistido dos ambientes de runtime é inválido."
  actual_runtime_digest="$(
    runtime_environment_digest \
      "${directory}/.runtime/web.env" "${directory}/.runtime/backoffice.env"
  )" || fail "ambientes de runtime staged não puderam ser autenticados."
  [[ ${actual_runtime_digest} == "${persisted_runtime_digest[0]}" \
    && ${actual_runtime_digest} == "$expected_runtime_digest" ]] \
    || fail "contrato atual dos ambientes divergiu da release staged."
  mapfile -t persisted_tree_digest < "${directory}/${STAGED_TREE_DIGEST_RELATIVE_PATH}"
  [[ ${#persisted_tree_digest[@]} -eq 1 \
    && ${persisted_tree_digest[0]} =~ ^[0-9a-f]{64}$ ]] \
    || fail "digest persistido da árvore staged é inválido."
  actual_tree_digest="$(release_tree_digest "$directory")" \
    || fail "árvore staged não pôde ser relida."
  [[ ${actual_tree_digest} == "${persisted_tree_digest[0]}" ]] \
    || fail "bytes da árvore staged divergiram depois da verificação inicial."
  jq --exit-status --arg sha "$expected_release" '
    .version == 2 and
    .commit == $sha and
    (.hostConfiguration.sha256 | test("^[0-9a-f]{64}$")) and
    .applications.web.entrypoint == "server.js" and
    .applications.web.health == "/api/health/ready" and
    .applications.web.mediaCleanupEntrypoint == "runtime/invoke-media-cleanup.mjs" and
    .applications.backoffice.entrypoint == "apps/backoffice/server.js" and
    .applications.backoffice.health == "/api/health/ready"
  ' "${directory}/release-manifest.json" >/dev/null \
    || fail "manifesto da release staged é inválido."
  installed_host_digest="$(
    read_host_state_digest "$HOST_CONFIGURATION_DIGEST" "root:setlivre:640"
  )" || fail "digest instalado da configuração do host é inválido."
  manifest_host_digest="$(
    jq --raw-output '.hostConfiguration.sha256' "${directory}/release-manifest.json"
  )"
  [[ ${manifest_host_digest} == "$installed_host_digest" ]] \
    || fail "configuração do host divergiu da release staged."
}

if [[ ${inspection_only} == true ]]; then
  release_directory="${RELEASES_DIRECTORY}/${release_sha}"
  if [[ ! -e ${release_directory} && ! -L ${release_directory} ]]; then
    printf 'Release %s absent.\n' "$release_sha"
    exit 0
  fi
  [[ -f "${release_directory}/.artifact.sha256" \
    && ! -L "${release_directory}/.artifact.sha256" \
    && $(stat --format '%U:%G:%a' -- "${release_directory}/.artifact.sha256") \
      == "root:setlivre:640" ]] \
    || fail "checksum da release existente possui metadados inválidos."
  mapfile -t existing_checksum < "${release_directory}/.artifact.sha256"
  [[ ${#existing_checksum[@]} -eq 1 && ${existing_checksum[0]} =~ ^[0-9a-f]{64}$ ]] \
    || fail "checksum da release existente é inválido."
  validate_staged_release \
    "$release_directory" "$release_sha" "${existing_checksum[0]}" \
    "$expected_runtime_environment_digest"
  printf 'Release %s staged checksum %s.\n' "$release_sha" "${existing_checksum[0]}"
  exit 0
fi

if [[ ${activation_only} == false ]]; then
  remove_stale_trusted_files \
    || fail "arquivo confiável residual possui identidade ou permissões inválidas."

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
common_expected_keys = {
    "APP_ENV",
    "DATABASE_URL_APP_DAL",
    "NEXT_PUBLIC_APP_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "NEXT_PUBLIC_SUPABASE_URL",
}
runtime_unlock_key_name = "BACKOFFICE_RUNTIME_UNLOCK_KEY"
supabase_secret_key_name = "SUPABASE_SECRET_KEY"
project_ref = "oirvvnojgkzdppkdvhej"
supabase_url = f"https://{project_ref}.supabase.co"


def fail(label, reason):
    raise SystemExit(f"ambiente {label} inválido: {reason}")


def read_environment(path, label, expected_app_url, extra_expected_keys=frozenset()):
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
    expected_keys = common_expected_keys | set(extra_expected_keys)
    if set(values) != expected_keys or any(value == "" for value in values.values()):
        fail(label, "conjunto de chaves")
    if any(
        character.isspace() or character in {"'", '"', "\\"}
        for value in values.values()
        for character in value
    ):
        fail(label, "sintaxe de EnvironmentFile")
    if values["APP_ENV"] != "production":
        fail(label, "APP_ENV")
    if values["NEXT_PUBLIC_APP_URL"] != expected_app_url:
        fail(label, "origem pública")
    if values["NEXT_PUBLIC_SUPABASE_URL"] != supabase_url:
        fail(label, "projeto Supabase")
    if runtime_unlock_key_name in values and re.fullmatch(
        r"[A-Za-z0-9_-]{43}", values[runtime_unlock_key_name]
    ) is None:
        fail(label, "chave de desbloqueio do runtime")
    if supabase_secret_key_name in values and re.fullmatch(
        r"sb_secret_[A-Za-z0-9_-]{12,}", values[supabase_secret_key_name]
    ) is None:
        fail(label, "secret key do Supabase")
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


web = read_environment(
    web_path,
    "web",
    "https://147.15.97.227",
    {supabase_secret_key_name},
)
backoffice = read_environment(
    backoffice_path,
    "backoffice",
    "http://127.0.0.1:3001",
    {runtime_unlock_key_name},
)
if web["DATABASE_URL_APP_DAL"] != backoffice["DATABASE_URL_APP_DAL"]:
    fail("runtime", "URLs DAL divergentes")
if web["NEXT_PUBLIC_SUPABASE_ANON_KEY"] != backoffice["NEXT_PUBLIC_SUPABASE_ANON_KEY"]:
    fail("runtime", "publishable keys divergentes")
PYTHON

actual_runtime_environment_digest="$(
  runtime_environment_digest "$trusted_web_environment" "$trusted_backoffice_environment"
)" || fail "ambientes recebidos não puderam ser autenticados."
[[ ${actual_runtime_environment_digest} == "$expected_runtime_environment_digest" ]] \
  || fail "ambientes recebidos divergem do contrato aprovado pelo workflow."

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
[[ -f "${staging_directory}/web/runtime/invoke-media-cleanup.mjs" ]] \
  || fail "invocador de cleanup de mídia ausente."
[[ -f "${staging_directory}/backoffice/apps/backoffice/server.js" ]] \
  || fail "entrypoint backoffice ausente."
jq --exit-status --arg sha "$release_sha" '
  .version == 2 and
  .commit == $sha and
  (.hostConfiguration.sha256 | test("^[0-9a-f]{64}$")) and
  .applications.web.entrypoint == "server.js" and
  .applications.web.health == "/api/health/ready" and
  .applications.web.mediaCleanupEntrypoint == "runtime/invoke-media-cleanup.mjs" and
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

printf '%s\n' "$actual_checksum" > "${staging_directory}/.artifact.sha256"
install -d -o root -g setlivre -m 0750 "${staging_directory}/.runtime"
install -o root -g setlivre-web -m 0640 \
  "$trusted_web_environment" "${staging_directory}/.runtime/web.env"
install -o root -g setlivre-backoffice -m 0640 \
  "$trusted_backoffice_environment" "${staging_directory}/.runtime/backoffice.env"
printf 'APP_RELEASE_SHA=%s\n' "$release_sha" > "${staging_directory}/.runtime/release.env"
printf '%s\n' "$actual_runtime_environment_digest" \
  > "${staging_directory}/${RUNTIME_ENVIRONMENT_DIGEST_RELATIVE_PATH}"
chown -R root:setlivre "$staging_directory"
find "$staging_directory" -type d -exec chmod 0750 {} +
find "$staging_directory" -type f -exec chmod 0640 {} +
chown root:setlivre-web "${staging_directory}/.runtime/web.env"
chown root:setlivre-backoffice "${staging_directory}/.runtime/backoffice.env"
candidate_tree_digest="$(release_tree_digest "$staging_directory")" \
  || fail "árvore preparada da release não pôde ser autenticada."
[[ ${candidate_tree_digest} =~ ^[0-9a-f]{64}$ ]] \
  || fail "digest da árvore preparada é inválido."
printf '%s\n' "$candidate_tree_digest" \
  > "${staging_directory}/${STAGED_TREE_DIGEST_RELATIVE_PATH}"
chown root:setlivre "${staging_directory}/${STAGED_TREE_DIGEST_RELATIVE_PATH}"
chmod 0640 "${staging_directory}/${STAGED_TREE_DIGEST_RELATIVE_PATH}"

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
else
  release_directory="${RELEASES_DIRECTORY}/${release_sha}"
  validate_staged_release \
    "$release_directory" "$release_sha" "$expected_checksum" \
    "$expected_runtime_environment_digest"
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
if [[ ${stage_only} == true ]]; then
  validate_staged_release \
    "$release_directory" "$release_sha" "$expected_checksum" \
    "$expected_runtime_environment_digest"
  printf 'Release %s preparada e verificada sem ativação.\n' "$release_sha"
  exit 0
fi
validate_staged_release \
  "$release_directory" "$release_sha" "$expected_checksum" \
  "$expected_runtime_environment_digest"
write_rollback_marker "$previous_release" || fail "não foi possível preparar a recuperação atômica."
activation_started=true
activation_failure="bloqueio do cleanup durante a ativação"
stop_media_cleanup_schedule || fail "$activation_failure"
activation_failure="interrupção dos aplicativos antes da ativação"
systemctl stop set-livre-web.service set-livre-backoffice.service || fail "$activation_failure"
activation_failure="troca do symlink"
activate_link "$release_directory" || fail "$activation_failure"
activation_failure="cleanup inicial de mídia"
run_media_cleanup_once || fail "$activation_failure"
activation_failure="reinício dos serviços"
systemctl restart set-livre-web.service set-livre-backoffice.service || fail "$activation_failure"
activation_failure="readiness interno"
wait_for_health "$release_sha" || fail "$activation_failure"
activation_failure="readiness HTTPS público"
wait_for_public_health "$release_sha" || fail "$activation_failure"
activation_failure="reativação do timer de cleanup"
start_media_cleanup_schedule || fail "$activation_failure"

trap '' HUP INT TERM
rm -f -- "$ROLLBACK_MARKER"
activation_complete=true
trap 'on_signal HUP 129' HUP
trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM

printf 'Release %s ativa, pública e pronta.\n' "$release_sha"
