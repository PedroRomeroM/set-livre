#!/usr/bin/env bash
set -Eeuo pipefail

readonly INCOMING_DIRECTORY="/home/deploy-setlivre/incoming"
readonly UPLOAD_LOCK="${INCOMING_DIRECTORY}/.incoming.lock"
readonly MAX_RELEASE_BYTES=$((256 * 1024 * 1024))
readonly MAX_ENVIRONMENT_BYTES=$((64 * 1024))
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
umask 077

fail() {
  printf 'deploy-ssh: %s\n' "$1" >&2
  exit 1
}

cleanup_abandoned_uploads() {
  local current_sha="$1"
  local artifact_sha name path
  while IFS= read -r -d '' path; do
    name="${path##*/}"
    artifact_sha=""
    if [[ ${name} =~ ^\.upload\.[A-Za-z0-9]{6}$ ]]; then
      :
    elif [[ ${name} =~ ^set-livre-([0-9a-f]{40})\.tar\.gz$ ]]; then
      artifact_sha="${BASH_REMATCH[1]}"
    elif [[ ${name} =~ ^(web|backoffice)-([0-9a-f]{40})\.env$ ]]; then
      artifact_sha="${BASH_REMATCH[2]}"
    else
      return 1
    fi
    [[ ${path} == "${INCOMING_DIRECTORY}/"* && -f ${path} && ! -L ${path} ]] || return 1
    [[ $(stat --format '%U:%a' -- "$path") == "deploy-setlivre:600" ]] || return 1
    if [[ -z ${artifact_sha} || ${artifact_sha} != "$current_sha" ]]; then
      rm -f -- "$path" || return 1
    fi
  done < <(
    find "$INCOMING_DIRECTORY" -mindepth 1 -maxdepth 1 \
      \( -name '.upload.*' -o -name 'set-livre-*' -o -name 'web-*' -o -name 'backoffice-*' \) \
      -print0
  )
}

upload() {
  local target="$1"
  local maximum_bytes="$2"
  local temporary
  temporary="$(mktemp "${INCOMING_DIRECTORY}/.upload.XXXXXX")"
  trap 'rm -f -- "${temporary:-}"' EXIT
  head --bytes "$((maximum_bytes + 1))" > "$temporary"
  local bytes
  bytes="$(stat --format '%s' -- "$temporary")"
  [[ ${bytes} -gt 0 ]] || fail "upload vazio."
  [[ ${bytes} -le ${maximum_bytes} ]] || fail "upload excede o limite."
  chmod 0600 "$temporary"
  mv --force -- "$temporary" "$target"
  temporary=""
  trap - EXIT
}

[[ $(id --user --name) == "deploy-setlivre" ]] || fail "identidade inesperada."
[[ $# -eq 0 ]] || fail "argumentos locais não são aceitos."
[[ -d ${INCOMING_DIRECTORY} && ! -L ${INCOMING_DIRECTORY} ]] || fail "diretório de entrada inválido."
[[ -f ${UPLOAD_LOCK} && ! -L ${UPLOAD_LOCK} ]] || fail "lock de upload inválido."
[[ $(stat --format '%U:%a' -- "$UPLOAD_LOCK") == "deploy-setlivre:600" ]] \
  || fail "lock de upload tem identidade ou modo inválido."
exec 9<>"$UPLOAD_LOCK"
flock --exclusive 9

original_command="${SSH_ORIGINAL_COMMAND:-}"
if [[ ${original_command} =~ ^upload-release\ ([0-9a-f]{40})$ ]]; then
  release_sha="${BASH_REMATCH[1]}"
  cleanup_abandoned_uploads "$release_sha" || fail "entrada abandonada possui contrato inválido."
  upload "${INCOMING_DIRECTORY}/set-livre-${release_sha}.tar.gz" "$MAX_RELEASE_BYTES"
elif [[ ${original_command} =~ ^upload-web-environment\ ([0-9a-f]{40})$ ]]; then
  release_sha="${BASH_REMATCH[1]}"
  cleanup_abandoned_uploads "$release_sha" || fail "entrada abandonada possui contrato inválido."
  upload "${INCOMING_DIRECTORY}/web-${release_sha}.env" "$MAX_ENVIRONMENT_BYTES"
elif [[ ${original_command} =~ ^upload-backoffice-environment\ ([0-9a-f]{40})$ ]]; then
  release_sha="${BASH_REMATCH[1]}"
  cleanup_abandoned_uploads "$release_sha" || fail "entrada abandonada possui contrato inválido."
  upload "${INCOMING_DIRECTORY}/backoffice-${release_sha}.env" "$MAX_ENVIRONMENT_BYTES"
elif [[ ${original_command} =~ ^deploy\ ([0-9a-f]{40})\ ([0-9a-f]{64})$ ]]; then
  release_sha="${BASH_REMATCH[1]}"
  expected_checksum="${BASH_REMATCH[2]}"
  cleanup_abandoned_uploads "$release_sha" \
    || fail "entrada abandonada possui contrato inválido."
  flock --unlock 9
  exec 9>&-
  exec sudo /usr/local/sbin/set-livre-deploy "$release_sha" "$expected_checksum"
else
  fail "comando remoto não autorizado."
fi
