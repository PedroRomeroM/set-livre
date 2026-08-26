#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly REPOSITORY_ROOT
readonly PRODUCTION_SUPABASE_URL="https://oirvvnojgkzdppkdvhej.supabase.co"
readonly PRODUCTION_PUBLIC_APP_URL="https://147.15.97.227"
readonly PRODUCTION_BACKOFFICE_APP_URL="https://ops.setlivre.com"
nginx_test_active=false

cleanup() {
  if [[ ${nginx_test_active} == true ]]; then
    sudo nginx -s stop >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

fail() {
  printf 'host-contracts: %s\n' "$1" >&2
  exit 1
}

[[ $# -eq 2 ]] || fail "uso: verify-host-contracts.sh <sha> <temporary-directory>."
release_sha="$1"
temporary_directory="$(realpath -e -- "$2")"
[[ ${release_sha} =~ ^[0-9a-f]{40}$ ]] || fail "SHA inválido."
[[ -d ${temporary_directory} && ! -L ${temporary_directory} ]] || fail "diretório temporário inválido."

create_system_identity() {
  local name="$1"
  getent group "$name" >/dev/null || sudo groupadd --system "$name"
  if ! getent passwd "$name" >/dev/null; then
    sudo useradd --system --gid "$name" --home-dir /nonexistent --shell /usr/sbin/nologin "$name"
  fi
}

getent group setlivre >/dev/null || sudo groupadd --system setlivre
create_system_identity setlivre-web
create_system_identity setlivre-backoffice
getent group deploy-setlivre >/dev/null || sudo groupadd deploy-setlivre
if ! getent passwd deploy-setlivre >/dev/null; then
  sudo useradd --create-home --gid deploy-setlivre --shell /bin/bash deploy-setlivre
fi

sudo install -d -o deploy-setlivre -g deploy-setlivre -m 0700 /home/deploy-setlivre/incoming
sudo install -d -o root -g setlivre -m 0750 /etc/set-livre /opt/set-livre/releases

sudo rm --force /etc/nginx/sites-enabled/default
sudo install -m 0644 "$REPOSITORY_ROOT/ops/nginx/set-livre-http.conf" /etc/nginx/sites-available/set-livre
sudo ln --symbolic --force /etc/nginx/sites-available/set-livre /etc/nginx/sites-enabled/set-livre
sudo nginx -t
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj '/CN=147.15.97.227' -addext 'subjectAltName=IP:147.15.97.227' \
  -keyout "$temporary_directory/ip.key" -out "$temporary_directory/ip.crt" >/dev/null 2>&1
sudo install -d -m 0755 /etc/letsencrypt/live/147.15.97.227
sudo install -m 0644 "$temporary_directory/ip.crt" /etc/letsencrypt/live/147.15.97.227/fullchain.pem
sudo install -m 0600 "$temporary_directory/ip.key" /etc/letsencrypt/live/147.15.97.227/privkey.pem
sudo install -m 0644 "$REPOSITORY_ROOT/ops/nginx/set-livre-tls.conf" /etc/nginx/sites-available/set-livre
sudo nginx -t
if [[ -s /run/nginx.pid ]] && sudo kill -0 "$(< /run/nginx.pid)" 2>/dev/null; then
  sudo nginx -s reload
else
  sudo nginx
fi
nginx_test_active=true
curl --fail --silent --show-error --max-time 5 --retry 5 --retry-all-errors --retry-delay 1 \
  --noproxy '*' \
  --cacert "$temporary_directory/ip.crt" \
  --resolve "147.15.97.227:443:127.0.0.1" \
  --dump-header "$temporary_directory/ip.headers" \
  --output "$temporary_directory/ip.robots" \
  https://147.15.97.227/robots.txt
tr --delete '\r' < "$temporary_directory/ip.headers" | grep --ignore-case --fixed-strings --line-regexp \
  'X-Robots-Tag: noindex, nofollow, noarchive, nosnippet' >/dev/null
grep --fixed-strings --line-regexp 'Disallow: /' "$temporary_directory/ip.robots" >/dev/null
sudo nginx -s stop
nginx_test_active=false

sudo install -d -m 0755 \
  /opt/node/bin \
  /opt/set-livre/current/web \
  /opt/set-livre/current/backoffice/apps/backoffice
sudo ln --symbolic --force "$(command -v node)" /opt/node/bin/node
sudo install -m 0644 /dev/null /opt/set-livre/current/web/server.js
sudo install -m 0644 /dev/null /opt/set-livre/current/backoffice/apps/backoffice/server.js
sudo install -o root -g setlivre-web -m 0640 /dev/null /etc/set-livre/web.env
sudo install -o root -g setlivre-backoffice -m 0640 /dev/null /etc/set-livre/backoffice.env
printf 'APP_RELEASE_SHA=%s\n' "$release_sha" > "$temporary_directory/release.env"
sudo install -o root -g setlivre -m 0640 "$temporary_directory/release.env" /etc/set-livre/release.env
sudo systemd-analyze verify \
  "$REPOSITORY_ROOT/ops/systemd/set-livre-web.service" \
  "$REPOSITORY_ROOT/ops/systemd/set-livre-backoffice.service"

archive="$temporary_directory/host-contract-release.tar.gz"
tar --create --gzip --file "$archive" --directory "$REPOSITORY_ROOT/.artifacts/release" .
checksum="$(sha256sum "$archive" | cut -d ' ' -f 1)"
host_digest="$(
  jq --raw-output '.hostConfiguration.sha256' \
    "$REPOSITORY_ROOT/.artifacts/release/release-manifest.json"
)"
[[ ${host_digest} =~ ^[0-9a-f]{64}$ ]] || fail "digest do host inválido."
printf '%s\n' "$host_digest" > "$temporary_directory/host-config.sha256"
sudo install -o root -g setlivre -m 0640 "$temporary_directory/host-config.sha256" \
  /etc/set-livre/host-config.sha256

write_fixture_environment() {
  local destination="$1"
  local app_url="$2"
  {
    printf 'APP_ENV=production\n'
    printf 'DATABASE_URL_APP_DAL=postgresql://app_runtime_production.oirvvnojgkzdppkdvhej:ci-password@aws-0-sa-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full&options=-c%%20role%%3Dapp_dal\n'
    printf 'NEXT_PUBLIC_APP_URL=%s\n' "$app_url"
    printf 'NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_ci_contract\n'
    printf 'NEXT_PUBLIC_SUPABASE_URL=%s\n' "$PRODUCTION_SUPABASE_URL"
  } > "$destination"
}
write_fixture_environment "$temporary_directory/web.env" "$PRODUCTION_PUBLIC_APP_URL"
write_fixture_environment "$temporary_directory/backoffice.env" "$PRODUCTION_BACKOFFICE_APP_URL"

if sudo --user deploy-setlivre -- env SSH_ORIGINAL_COMMAND='not-authorized' \
  bash "$REPOSITORY_ROOT/ops/deploy-ssh-command.sh" </dev/null; then
  fail "comando SSH não autorizado foi aceito."
fi
# O runner confiável abre os fixtures; somente o processo de destino troca de UID.
# shellcheck disable=SC2024
sudo --user deploy-setlivre -- env SSH_ORIGINAL_COMMAND="upload-release ${release_sha}" \
  bash "$REPOSITORY_ROOT/ops/deploy-ssh-command.sh" < "$archive"
# shellcheck disable=SC2024
sudo --user deploy-setlivre -- env SSH_ORIGINAL_COMMAND="upload-web-environment ${release_sha}" \
  bash "$REPOSITORY_ROOT/ops/deploy-ssh-command.sh" < "$temporary_directory/web.env"
# shellcheck disable=SC2024
sudo --user deploy-setlivre -- env SSH_ORIGINAL_COMMAND="upload-backoffice-environment ${release_sha}" \
  bash "$REPOSITORY_ROOT/ops/deploy-ssh-command.sh" < "$temporary_directory/backoffice.env"
sudo bash "$REPOSITORY_ROOT/ops/deploy-release.sh" "$release_sha" "$checksum" --verify-only
