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
  /opt/set-livre/current/backoffice/apps/backoffice \
  /opt/set-livre/current/.runtime
sudo ln --symbolic --force "$(command -v node)" /opt/node/bin/node
sudo install -m 0644 /dev/null /opt/set-livre/current/web/server.js
sudo install -m 0644 /dev/null /opt/set-livre/current/backoffice/apps/backoffice/server.js
sudo install -o root -g setlivre-web -m 0640 /dev/null /opt/set-livre/current/.runtime/web.env
sudo install -o root -g setlivre-backoffice -m 0640 /dev/null \
  /opt/set-livre/current/.runtime/backoffice.env
printf 'APP_RELEASE_SHA=%s\n' "$release_sha" > "$temporary_directory/release.env"
sudo install -o root -g setlivre -m 0640 "$temporary_directory/release.env" \
  /opt/set-livre/current/.runtime/release.env
sudo install -m 0755 "$REPOSITORY_ROOT/ops/deploy-release.sh" /usr/local/sbin/set-livre-deploy
sudo systemd-analyze verify \
  "$REPOSITORY_ROOT/ops/systemd/set-livre-web.service" \
  "$REPOSITORY_ROOT/ops/systemd/set-livre-backoffice.service" \
  "$REPOSITORY_ROOT/ops/systemd/set-livre-release-recovery.service"

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

# A ativação usa comandos controlados para exercitar o instalador real sem iniciar systemd no runner.
sudo rm -rf -- /opt/set-livre/current
fake_bin="$temporary_directory/fake-bin"
test_state="$temporary_directory/deploy-state"
mkdir -p "$fake_bin" "$test_state"

cat > "$fake_bin/systemctl" <<'SYSTEMCTL'
#!/usr/bin/env bash
set -Eeuo pipefail
state="${SET_LIVRE_TEST_STATE:?}"
phase="${SET_LIVRE_TEST_PHASE:-success}"
printf '%s\n' "$*" >> "$state/systemctl.log"
if [[ ${1:-} == "restart" && ${phase} == "services" && ! -e "$state/services-once" ]]; then
  touch "$state/services-once"
  exit 1
fi
if [[ ${1:-} == "restart" && ${phase} == "signal" && ! -e "$state/signal-once" ]]; then
  touch "$state/signal-once"
  kill -TERM "$PPID"
  /usr/bin/sleep 0.1
fi
SYSTEMCTL

cat > "$fake_bin/curl" <<'CURL'
#!/usr/bin/env bash
set -Eeuo pipefail
url="${!#}"
phase="${SET_LIVRE_TEST_PHASE:-success}"
candidate="${SET_LIVRE_TEST_CANDIDATE:-}"
release="$(sed -n 's/^APP_RELEASE_SHA=//p' /opt/set-livre/current/.runtime/release.env)"
if [[ ${release} == "${candidate}" \
  && (( ${phase} == "internal-health" && ${url} == http://127.0.0.1:* ) \
    || ( ${phase} == "public-health" && ${url} == https://* )) ]]; then
  exit 22
fi
application=web
[[ ${url} != *":3001/"* ]] || application=backoffice
printf '{"application":"%s","release":"%s","status":"ready"}\n' "$application" "$release"
CURL

cat > "$fake_bin/install" <<'INSTALL'
#!/usr/bin/env bash
set -Eeuo pipefail
state="${SET_LIVRE_TEST_STATE:?}"
destination="${!#}"
if [[ ${SET_LIVRE_TEST_PHASE:-} == "environment" \
  && ${destination} == */.runtime/web.env \
  && ! -e "$state/environment-once" ]]; then
  touch "$state/environment-once"
  exit 1
fi
exec /usr/bin/install "$@"
INSTALL

cat > "$fake_bin/mv" <<'MOVE'
#!/usr/bin/env bash
set -Eeuo pipefail
state="${SET_LIVRE_TEST_STATE:?}"
destination="${!#}"
if [[ ${SET_LIVRE_TEST_PHASE:-} == "symlink" \
  && ${destination} == "/opt/set-livre/current" \
  && ! -e "$state/symlink-once" ]]; then
  touch "$state/symlink-once"
  exit 1
fi
exec /usr/bin/mv "$@"
MOVE

cat > "$fake_bin/rm" <<'REMOVE'
#!/usr/bin/env bash
set -Eeuo pipefail
state="${SET_LIVRE_TEST_STATE:?}"
if [[ ${SET_LIVRE_TEST_PHASE:-} == "retention" \
  && " $* " == *" --one-file-system "* \
  && ! -e "$state/retention-once" ]]; then
  touch "$state/retention-once"
  exit 1
fi
exec /usr/bin/rm "$@"
REMOVE

cat > "$fake_bin/sleep" <<'SLEEP'
#!/usr/bin/env bash
exit 0
SLEEP
cat > "$fake_bin/journalctl" <<'JOURNAL'
#!/usr/bin/env bash
exit 0
JOURNAL
chmod 0755 "$fake_bin"/*

package_candidate() {
  local candidate_sha="$1"
  candidate_directory="$temporary_directory/release-${candidate_sha}"
  candidate_archive="$temporary_directory/release-${candidate_sha}.tar.gz"
  candidate_web_environment="$temporary_directory/web-${candidate_sha}.env"
  candidate_backoffice_environment="$temporary_directory/backoffice-${candidate_sha}.env"
  rm -rf -- "$candidate_directory"
  mkdir -p \
    "$candidate_directory/web" \
    "$candidate_directory/backoffice/apps/backoffice"
  install -m 0644 /dev/null "$candidate_directory/web/server.js"
  install -m 0644 /dev/null "$candidate_directory/backoffice/apps/backoffice/server.js"
  jq --arg sha "$candidate_sha" '.commit = $sha' \
    "$REPOSITORY_ROOT/.artifacts/release/release-manifest.json" \
    > "$candidate_directory/release-manifest.next.json"
  mv -- "$candidate_directory/release-manifest.next.json" \
    "$candidate_directory/release-manifest.json"
  tar --create --gzip --file "$candidate_archive" --directory "$candidate_directory" .
  candidate_checksum="$(sha256sum "$candidate_archive" | cut -d ' ' -f 1)"
  write_fixture_environment "$candidate_web_environment" "$PRODUCTION_PUBLIC_APP_URL"
  write_fixture_environment "$candidate_backoffice_environment" "$PRODUCTION_BACKOFFICE_APP_URL"
}

upload_candidate() {
  local candidate_sha="$1"
  # shellcheck disable=SC2024
  sudo --user deploy-setlivre -- env SSH_ORIGINAL_COMMAND="upload-release ${candidate_sha}" \
    bash "$REPOSITORY_ROOT/ops/deploy-ssh-command.sh" < "$candidate_archive"
  # shellcheck disable=SC2024
  sudo --user deploy-setlivre -- env SSH_ORIGINAL_COMMAND="upload-web-environment ${candidate_sha}" \
    bash "$REPOSITORY_ROOT/ops/deploy-ssh-command.sh" < "$candidate_web_environment"
  # shellcheck disable=SC2024
  sudo --user deploy-setlivre -- \
    env SSH_ORIGINAL_COMMAND="upload-backoffice-environment ${candidate_sha}" \
    bash "$REPOSITORY_ROOT/ops/deploy-ssh-command.sh" < "$candidate_backoffice_environment"
}

invoke_candidate() {
  local candidate_sha="$1"
  local phase="$2"
  sudo env \
    PATH="$fake_bin:$PATH" \
    SET_LIVRE_TEST_CANDIDATE="$candidate_sha" \
    SET_LIVRE_TEST_PHASE="$phase" \
    SET_LIVRE_TEST_STATE="$test_state" \
    bash "$REPOSITORY_ROOT/ops/deploy-release.sh" "$candidate_sha" "$candidate_checksum"
}

assert_current_release() {
  local expected="$1"
  local current
  current="$(sudo readlink --canonicalize-existing /opt/set-livre/current)"
  [[ ${current} == "/opt/set-livre/releases/${expected}" ]] \
    || fail "release ativa divergiu depois do teste de rollback."
  [[ ! -e /opt/set-livre/.activation-rollback ]] \
    || fail "marcador de rollback permaneceu depois de estado terminal."
}

run_expected_failure() {
  local candidate_sha="$1"
  local phase="$2"
  local expected_current="$3"
  rm -f -- "$test_state"/*
  package_candidate "$candidate_sha"
  upload_candidate "$candidate_sha"
  if invoke_candidate "$candidate_sha" "$phase"; then
    fail "falha injetada em ${phase} foi aceita como sucesso."
  fi
  if [[ -z ${expected_current} ]]; then
    [[ ! -e /opt/set-livre/current ]] || fail "primeira ativação falha deixou release ativa."
    [[ ! -e /opt/set-livre/.activation-rollback ]] || fail "rollback inicial deixou marcador."
  else
    assert_current_release "$expected_current"
  fi
}

initial_failure_sha="$(printf '0%.0s' {1..40})"
run_expected_failure "$initial_failure_sha" services ""

rm -f -- "$test_state"/*
package_candidate "$release_sha"
upload_candidate "$release_sha"
invoke_candidate "$release_sha" success
assert_current_release "$release_sha"
[[ $(sudo stat --format '%U:%G:%a' /opt/set-livre/current/.runtime/web.env) \
  == "root:setlivre-web:640" ]] || fail "ambiente web versionado tem permissões inválidas."
[[ $(sudo stat --format '%U:%G:%a' /opt/set-livre/current/.runtime/backoffice.env) \
  == "root:setlivre-backoffice:640" ]] || fail "ambiente backoffice versionado tem permissões inválidas."

run_expected_failure "$(printf '1%.0s' {1..40})" environment "$release_sha"
run_expected_failure "$(printf '2%.0s' {1..40})" symlink "$release_sha"
run_expected_failure "$(printf '3%.0s' {1..40})" services "$release_sha"
run_expected_failure "$(printf '4%.0s' {1..40})" internal-health "$release_sha"
run_expected_failure "$(printf '5%.0s' {1..40})" public-health "$release_sha"
interrupted_sha="$(printf '6%.0s' {1..40})"
run_expected_failure "$interrupted_sha" signal "$release_sha"

for prefix in 7 8 9 a b; do
  dummy_sha="$(printf '%s%.0s' "$prefix" {1..40})"
  sudo install -d -o root -g setlivre -m 0750 "/opt/set-livre/releases/${dummy_sha}"
done
retention_sha="$(printf 'c%.0s' {1..40})"
run_expected_failure "$retention_sha" retention "$release_sha"
for prefix in 7 8 9 a b; do
  dummy_sha="$(printf '%s%.0s' "$prefix" {1..40})"
  sudo rm -rf -- "/opt/set-livre/releases/${dummy_sha}"
done

rollback_source="$temporary_directory/activation-rollback"
printf '/opt/set-livre/releases/%s\n' "$release_sha" > "$rollback_source"
sudo install -o root -g root -m 0600 "$rollback_source" /opt/set-livre/.activation-rollback
sudo ln --symbolic --force "/opt/set-livre/releases/${retention_sha}" /opt/set-livre/current.next
sudo mv --no-target-directory --force /opt/set-livre/current.next /opt/set-livre/current
sudo bash "$REPOSITORY_ROOT/ops/deploy-release.sh" --recover
assert_current_release "$release_sha"

printf 'Ativação, rollback, interrupção, retenção e recuperação de boot verificados.\n'
