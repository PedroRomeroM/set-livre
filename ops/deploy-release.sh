#!/usr/bin/env bash
set -Eeuo pipefail

readonly RELEASES_DIRECTORY="/opt/set-livre/releases"
readonly CURRENT_LINK="/opt/set-livre/current"
readonly ROLLBACK_MARKER="/opt/set-livre/.activation-rollback"
readonly HOST_CONFIGURATION_DIGEST="/etc/set-livre/host-config.sha256"
readonly HOST_BOOTSTRAP_IN_PROGRESS="/etc/set-livre/bootstrap-in-progress.sha256"
readonly INCOMING_DIRECTORY="/home/deploy-setlivre/incoming"
readonly PRODUCTION_IP="147.15.97.227"
readonly PRODUCTION_URL="https://${PRODUCTION_IP}"
readonly MAX_ARCHIVE_BYTES=$((256 * 1024 * 1024))
readonly MAX_ENVIRONMENT_BYTES=$((64 * 1024))
readonly RETAINED_RELEASES=4
readonly RECOVERY_LOCK_TIMEOUT_SECONDS=300

fail() {
  printf 'deploy: %s\n' "$1" >&2
  exit 1
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
  curl --fail --silent --show-error --max-time 2 "http://127.0.0.1:${port}/api/health/ready" \
    | jq --exit-status --arg application "$application" --arg release "$expected_release" \
      '.application == $application and .release == $release and .status == "ready"' >/dev/null
}

public_health_is_ready() {
  local expected_release="$1"
  curl --fail --silent --show-error --max-time 5 "${PRODUCTION_URL}/api/health/ready" \
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

recover_link_from_marker() {
  recovered_release=""
  [[ -f ${ROLLBACK_MARKER} && ! -L ${ROLLBACK_MARKER} ]] || return 1
  [[ $(stat --format '%U:%G:%a' -- "$ROLLBACK_MARKER") == "root:root:600" ]] \
    || return 1

  local target
  target="$(< "$ROLLBACK_MARKER")"
  if [[ ${target} == "NONE" ]]; then
    rm -f -- "$CURRENT_LINK" "${CURRENT_LINK}.next" || return 1
  else
    [[ ${target} =~ ^${RELEASES_DIRECTORY}/[0-9a-f]{40}$ ]] || return 1
    [[ -d ${target} && ! -L ${target} ]] || return 1
    activate_link "$target" || return 1
    recovered_release="$(basename -- "$target")"
  fi
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

[[ ${EUID} -eq 0 ]] || fail "execute como root."

if [[ $# -eq 1 && ${1:-} == "--recover-link" ]]; then
  exec 9>/run/lock/set-livre-deploy.lock
  if ! flock --nonblock 9; then
    printf 'Deploy ativo; a recuperação pós-lock permanece armada.\n'
    exit 0
  fi
  if [[ -e ${ROLLBACK_MARKER} ]]; then
    recover_link_from_marker || fail "não foi possível recuperar a ativação interrompida."
    printf 'Link da ativação interrompida recuperado; estabilização dos serviços permanece armada.\n'
  fi
  exit 0
fi

if [[ $# -eq 1 && ${1:-} == "--recover-services" ]]; then
  exec 9>/run/lock/set-livre-deploy.lock
  flock --exclusive --timeout "$RECOVERY_LOCK_TIMEOUT_SECONDS" 9 \
    || fail "o lock de deploy permaneceu ocupado durante a janela de recuperação."
  if [[ -e ${ROLLBACK_MARKER} ]]; then
    recover_link_from_marker || fail "não foi possível recuperar a ativação interrompida."
    if [[ -z ${recovered_release} ]]; then
      systemctl stop set-livre-web.service set-livre-backoffice.service \
        || fail "não foi possível estabilizar o host sem release anterior."
    elif ! systemctl restart set-livre-web.service set-livre-backoffice.service \
      || ! wait_for_health "$recovered_release" \
      || ! wait_for_public_health "$recovered_release"; then
      systemctl stop set-livre-web.service set-livre-backoffice.service || true
      fail "a release recuperada não atingiu readiness; serviços interrompidos."
    fi
    rm -f -- "$ROLLBACK_MARKER"
    printf 'Ativação interrompida recuperada e serviços estabilizados.\n'
  fi
  exit 0
fi

[[ ! -e ${HOST_BOOTSTRAP_IN_PROGRESS} && ! -L ${HOST_BOOTSTRAP_IN_PROGRESS} ]] \
  || fail "o bootstrap do host ainda não atingiu estado terminal."

verify_only=false
if [[ $# -eq 3 && ${3:-} == "--verify-only" ]]; then
  verify_only=true
elif [[ $# -ne 2 ]]; then
  fail "uso: set-livre-deploy <sha> <sha256> [--verify-only], --recover-link ou --recover-services."
fi

release_sha="$1"
expected_checksum="$2"
[[ ${release_sha} =~ ^[0-9a-f]{40}$ ]] || fail "SHA de release inválido."
[[ ${expected_checksum} =~ ^[0-9a-f]{64}$ ]] || fail "checksum inválido."

incoming_archive="${INCOMING_DIRECTORY}/set-livre-${release_sha}.tar.gz"
incoming_web_environment="${INCOMING_DIRECTORY}/web-${release_sha}.env"
incoming_backoffice_environment="${INCOMING_DIRECTORY}/backoffice-${release_sha}.env"

exec 9>/run/lock/set-livre-deploy.lock
flock --nonblock 9 || fail "já existe outro deploy em execução."

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

if [[ -e ${ROLLBACK_MARKER} ]]; then
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

install -d -o root -g setlivre -m 0750 "$RELEASES_DIRECTORY"
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
  rm -rf -- "$staging_directory"
  staging_directory=""
else
  mv -- "$staging_directory" "$release_directory"
  staging_directory=""
fi

if [[ -L ${CURRENT_LINK} ]]; then
  previous_release="$(readlink --canonicalize-existing -- "$CURRENT_LINK")"
  [[ ${previous_release} == "${RELEASES_DIRECTORY}/"* && -d ${previous_release} ]] \
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
