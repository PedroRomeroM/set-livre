#!/usr/bin/env bash
set -Eeuo pipefail

readonly INCOMING_DIRECTORY="/home/deploy-setlivre/incoming"
readonly MAX_RELEASE_BYTES=$((256 * 1024 * 1024))
readonly MAX_ENVIRONMENT_BYTES=$((64 * 1024))
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
umask 077

fail() {
  printf 'deploy-ssh: %s\n' "$1" >&2
  exit 1
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

original_command="${SSH_ORIGINAL_COMMAND:-}"
if [[ ${original_command} =~ ^upload-release\ ([0-9a-f]{40})$ ]]; then
  release_sha="${BASH_REMATCH[1]}"
  upload "${INCOMING_DIRECTORY}/set-livre-${release_sha}.tar.gz" "$MAX_RELEASE_BYTES"
elif [[ ${original_command} =~ ^upload-web-environment\ ([0-9a-f]{40})$ ]]; then
  release_sha="${BASH_REMATCH[1]}"
  upload "${INCOMING_DIRECTORY}/web-${release_sha}.env" "$MAX_ENVIRONMENT_BYTES"
elif [[ ${original_command} =~ ^upload-backoffice-environment\ ([0-9a-f]{40})$ ]]; then
  release_sha="${BASH_REMATCH[1]}"
  upload "${INCOMING_DIRECTORY}/backoffice-${release_sha}.env" "$MAX_ENVIRONMENT_BYTES"
elif [[ ${original_command} =~ ^deploy\ ([0-9a-f]{40})\ ([0-9a-f]{64})$ ]]; then
  exec sudo /usr/local/sbin/set-livre-deploy "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
else
  fail "comando remoto não autorizado."
fi
