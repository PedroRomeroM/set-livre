#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly REPOSITORY_ROOT
readonly PRODUCTION_SUPABASE_URL="https://oirvvnojgkzdppkdvhej.supabase.co"
readonly PRODUCTION_PUBLIC_APP_URL="https://147.15.97.227"
readonly PRODUCTION_BACKOFFICE_APP_URL="https://ops.setlivre.com"
readonly INSTALLED_DEPLOY_SSH_COMMAND="/usr/local/sbin/set-livre-deploy-ssh"
readonly FORCED_COMMAND_SUDOERS="/etc/sudoers.d/set-livre-host-contracts"
nginx_test_active=false
forced_command_sudoers_installed=false

cleanup() {
  if [[ ${nginx_test_active} == true ]]; then
    sudo nginx -s stop >/dev/null 2>&1 || true
  fi
  if [[ ${forced_command_sudoers_installed} == true ]]; then
    sudo rm -f -- "$FORCED_COMMAND_SUDOERS"
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
  sudo useradd --create-home --gid deploy-setlivre \
    --home-dir /home/deploy-setlivre --shell /bin/bash deploy-setlivre
fi
sudo usermod --lock deploy-setlivre
deploy_account_entry="$(getent passwd deploy-setlivre)"
IFS=: read -r deploy_username _ deploy_uid _ _ deploy_home deploy_shell <<< "$deploy_account_entry"
[[ ${deploy_username} == deploy-setlivre \
  && ${deploy_uid} =~ ^[0-9]+$ \
  && ${deploy_uid} -ne 0 \
  && ${deploy_home} == /home/deploy-setlivre \
  && ${deploy_shell} == /bin/bash \
  && $(id --group --name deploy-setlivre) == deploy-setlivre \
  && $(id --groups --name deploy-setlivre) == deploy-setlivre ]] \
  || fail "identidade deploy-setlivre do laboratório não é canônica."
deploy_shadow_entry="$(sudo getent shadow deploy-setlivre)"
deploy_password_hash="${deploy_shadow_entry#*:}"
deploy_password_hash="${deploy_password_hash%%:*}"
[[ ${deploy_password_hash} == '!'* || ${deploy_password_hash} == '*'* ]] \
  || fail "identidade deploy-setlivre do laboratório aceita senha."

sudo install -d -o deploy-setlivre -g deploy-setlivre -m 0700 /home/deploy-setlivre/incoming
sudo install -o deploy-setlivre -g deploy-setlivre -m 0600 /dev/null \
  /home/deploy-setlivre/incoming/.incoming.lock
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
sudo install -o root -g root -m 0755 \
  "$REPOSITORY_ROOT/ops/deploy-ssh-command.sh" "$INSTALLED_DEPLOY_SSH_COMMAND"
sudo systemd-analyze verify \
  "$REPOSITORY_ROOT/ops/systemd/set-livre-web.service" \
  "$REPOSITORY_ROOT/ops/systemd/set-livre-backoffice.service" \
  "$REPOSITORY_ROOT/ops/systemd/set-livre-release-recovery@.service" \
  "$REPOSITORY_ROOT/ops/systemd/set-livre-release-recovery.path"

archive="$temporary_directory/host-contract-release.tar.gz"
LC_ALL=C tar --hard-dereference --sort=name --mtime='@0' \
  --owner=0 --group=0 --numeric-owner --format=posix \
  --pax-option=delete=atime,delete=ctime \
  --create --file=- --directory "$REPOSITORY_ROOT/.artifacts/release" . \
  | gzip --best --no-name > "$archive"
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
    printf 'NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_ci_contract_key\n'
    printf 'NEXT_PUBLIC_SUPABASE_URL=%s\n' "$PRODUCTION_SUPABASE_URL"
  } > "$destination"
}
write_fixture_environment "$temporary_directory/web.env" "$PRODUCTION_PUBLIC_APP_URL"
write_fixture_environment "$temporary_directory/backoffice.env" "$PRODUCTION_BACKOFFICE_APP_URL"

abandoned_sha="$(printf 'f%.0s' {1..40})"
for abandoned in \
  "/home/deploy-setlivre/incoming/set-livre-${abandoned_sha}.tar.gz" \
  "/home/deploy-setlivre/incoming/web-${abandoned_sha}.env" \
  "/home/deploy-setlivre/incoming/backoffice-${abandoned_sha}.env" \
  "/home/deploy-setlivre/incoming/.upload.Ab12Cd"; do
  sudo install -o deploy-setlivre -g deploy-setlivre -m 0600 /dev/null "$abandoned"
done

if sudo --user deploy-setlivre -- env SSH_ORIGINAL_COMMAND='not-authorized' \
  "$INSTALLED_DEPLOY_SSH_COMMAND" </dev/null; then
  fail "comando SSH não autorizado foi aceito."
fi

entry_limit_sha="$(printf 'e%.0s' {1..40})"
entry_limit_archive="$temporary_directory/entry-limit.tar.gz"
python3 - "$entry_limit_archive" <<'PYTHON'
import sys
import tarfile

with tarfile.open(sys.argv[1], mode="w:gz") as bundle:
    for index in range(20_001):
        entry = tarfile.TarInfo(f"web/entry-{index:05d}")
        entry.mode = 0o644
        bundle.addfile(entry)
PYTHON
entry_limit_checksum="$(sha256sum "$entry_limit_archive" | cut -d ' ' -f 1)"
# O runner confiável abre os fixtures; somente o processo de destino troca de UID.
# shellcheck disable=SC2024
sudo --user deploy-setlivre -- env SSH_ORIGINAL_COMMAND="upload-release ${entry_limit_sha}" \
  "$INSTALLED_DEPLOY_SSH_COMMAND" < "$entry_limit_archive"
# shellcheck disable=SC2024
sudo --user deploy-setlivre -- env SSH_ORIGINAL_COMMAND="upload-web-environment ${entry_limit_sha}" \
  "$INSTALLED_DEPLOY_SSH_COMMAND" < "$temporary_directory/web.env"
# shellcheck disable=SC2024
sudo --user deploy-setlivre -- \
  env SSH_ORIGINAL_COMMAND="upload-backoffice-environment ${entry_limit_sha}" \
  "$INSTALLED_DEPLOY_SSH_COMMAND" < "$temporary_directory/backoffice.env"
if entry_limit_output="$(
  sudo bash "$REPOSITORY_ROOT/ops/deploy-release.sh" \
    "$entry_limit_sha" "$entry_limit_checksum" --verify-only 2>&1
)"; then
  fail "archive com mais de 20.000 entradas foi aceito."
fi
grep --fixed-strings 'quantidade de entradas inválida' <<< "$entry_limit_output" >/dev/null \
  || fail "archive excessivo falhou por motivo inesperado."
[[ ! -e "/home/deploy-setlivre/incoming/set-livre-${entry_limit_sha}.tar.gz" \
  && ! -e "/home/deploy-setlivre/incoming/web-${entry_limit_sha}.env" \
  && ! -e "/home/deploy-setlivre/incoming/backoffice-${entry_limit_sha}.env" ]] \
  || fail "archive excessivo deixou uploads residuais."

metadata_limit_sha="$(printf 'a%.0s' {1..40})"
metadata_limit_archive="$temporary_directory/metadata-limit.tar.gz"
python3 - "$metadata_limit_archive" <<'PYTHON'
import sys
import tarfile

entry = tarfile.TarInfo("web/server.js")
entry.mode = 0o644
entry.pax_headers = {"comment": "x" * (65 * 1024)}
with tarfile.open(sys.argv[1], mode="w:gz", format=tarfile.PAX_FORMAT) as bundle:
    bundle.addfile(entry)
PYTHON
metadata_limit_checksum="$(sha256sum "$metadata_limit_archive" | cut -d ' ' -f 1)"
# shellcheck disable=SC2024
sudo --user deploy-setlivre -- env SSH_ORIGINAL_COMMAND="upload-release ${metadata_limit_sha}" \
  "$INSTALLED_DEPLOY_SSH_COMMAND" < "$metadata_limit_archive"
# shellcheck disable=SC2024
sudo --user deploy-setlivre -- env SSH_ORIGINAL_COMMAND="upload-web-environment ${metadata_limit_sha}" \
  "$INSTALLED_DEPLOY_SSH_COMMAND" < "$temporary_directory/web.env"
# shellcheck disable=SC2024
sudo --user deploy-setlivre -- \
  env SSH_ORIGINAL_COMMAND="upload-backoffice-environment ${metadata_limit_sha}" \
  "$INSTALLED_DEPLOY_SSH_COMMAND" < "$temporary_directory/backoffice.env"
if metadata_limit_output="$(
  sudo bash "$REPOSITORY_ROOT/ops/deploy-release.sh" \
    "$metadata_limit_sha" "$metadata_limit_checksum" --verify-only 2>&1
)"; then
  fail "archive com metadata PAX excessiva foi aceito."
fi
grep --fixed-strings 'metadata estendida excede o limite' <<< "$metadata_limit_output" >/dev/null \
  || fail "metadata PAX excessiva falhou por motivo inesperado."
[[ ! -e "/home/deploy-setlivre/incoming/set-livre-${metadata_limit_sha}.tar.gz" \
  && ! -e "/home/deploy-setlivre/incoming/web-${metadata_limit_sha}.env" \
  && ! -e "/home/deploy-setlivre/incoming/backoffice-${metadata_limit_sha}.env" ]] \
  || fail "archive com metadata excessiva deixou uploads residuais."

# O runner confiável abre os fixtures; somente o processo de destino troca de UID.
# shellcheck disable=SC2024
sudo --user deploy-setlivre -- env SSH_ORIGINAL_COMMAND="upload-release ${release_sha}" \
  "$INSTALLED_DEPLOY_SSH_COMMAND" < "$archive"
for abandoned in \
  "/home/deploy-setlivre/incoming/set-livre-${abandoned_sha}.tar.gz" \
  "/home/deploy-setlivre/incoming/web-${abandoned_sha}.env" \
  "/home/deploy-setlivre/incoming/backoffice-${abandoned_sha}.env" \
  "/home/deploy-setlivre/incoming/.upload.Ab12Cd"; do
  [[ ! -e ${abandoned} ]] || fail "upload abandonado não foi removido."
done
# shellcheck disable=SC2024
sudo --user deploy-setlivre -- env SSH_ORIGINAL_COMMAND="upload-web-environment ${release_sha}" \
  "$INSTALLED_DEPLOY_SSH_COMMAND" < "$temporary_directory/web.env"
# shellcheck disable=SC2024
sudo --user deploy-setlivre -- env SSH_ORIGINAL_COMMAND="upload-backoffice-environment ${release_sha}" \
  "$INSTALLED_DEPLOY_SSH_COMMAND" < "$temporary_directory/backoffice.env"
stale_trusted=/var/tmp/set-livre-trusted.Ab12Cd.env
sudo install -o root -g root -m 0600 /dev/null "$stale_trusted"
sudo bash "$REPOSITORY_ROOT/ops/deploy-release.sh" "$release_sha" "$checksum" --verify-only
[[ ! -e ${stale_trusted} ]] || fail "arquivo confiável residual não foi removido."

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
state="${SET_LIVRE_TEST_STATE:?}"
release="$(sed -n 's/^APP_RELEASE_SHA=//p' /opt/set-livre/current/.runtime/release.env)"
if [[ ${release} == "${candidate}" \
  && (( ${phase} == "internal-health" && ${url} == http://127.0.0.1:* ) \
    || ( ${phase} == "public-health" && ${url} == https://* )) ]]; then
  exit 22
fi
if [[ ${phase} == "rollback-public-health" ]]; then
  if [[ ${release} == "${candidate}" && ${url} == http://127.0.0.1:* ]]; then
    exit 22
  fi
  if [[ ${release} != "${candidate}" && ${url} == https://* ]]; then
    touch "$state/rollback-public-health-observed"
    exit 22
  fi
fi
if [[ ${phase} == "recovery-public-health" \
  && ${release} != "${candidate}" && ${url} == https://* ]]; then
  touch "$state/recovery-public-health-observed"
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

[[ ! -e ${FORCED_COMMAND_SUDOERS} ]] \
  || fail "sudoers temporário do contrato já existe."
[[ ${fake_bin} =~ ^/[A-Za-z0-9_./-]+$ ]] \
  || fail "diretório de comandos controlados inválido."
sudoers_source="$temporary_directory/set-livre-host-contracts.sudoers"
{
  printf 'Defaults:deploy-setlivre secure_path="%s:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"\n' \
    "$fake_bin"
  printf 'Defaults:deploy-setlivre env_keep += "SET_LIVRE_TEST_CANDIDATE SET_LIVRE_TEST_PHASE SET_LIVRE_TEST_STATE"\n'
  printf 'deploy-setlivre ALL=(root) NOPASSWD: /usr/local/sbin/set-livre-deploy\n'
} > "$sudoers_source"
sudo visudo --check --file "$sudoers_source"
sudo install -o root -g root -m 0440 "$sudoers_source" "$FORCED_COMMAND_SUDOERS"
forced_command_sudoers_installed=true

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
  # Prova que o produtor materializa inodes compartilhados sem relaxar o extrator.
  ln -- "$candidate_directory/web/server.js" \
    "$candidate_directory/web/hardlink-source-fixture.js"
  jq --arg sha "$candidate_sha" '.commit = $sha' \
    "$REPOSITORY_ROOT/.artifacts/release/release-manifest.json" \
    > "$candidate_directory/release-manifest.next.json"
  mv -- "$candidate_directory/release-manifest.next.json" \
    "$candidate_directory/release-manifest.json"
  LC_ALL=C tar --hard-dereference --sort=name --mtime='@0' \
    --owner=0 --group=0 --numeric-owner --format=posix \
    --pax-option=delete=atime,delete=ctime \
    --create --file=- --directory "$candidate_directory" . \
    | gzip --best --no-name > "$candidate_archive"
  candidate_checksum="$(sha256sum "$candidate_archive" | cut -d ' ' -f 1)"
  write_fixture_environment "$candidate_web_environment" "$PRODUCTION_PUBLIC_APP_URL"
  write_fixture_environment "$candidate_backoffice_environment" "$PRODUCTION_BACKOFFICE_APP_URL"
}

upload_candidate() {
  local candidate_sha="$1"
  # shellcheck disable=SC2024
  sudo --user deploy-setlivre -- env SSH_ORIGINAL_COMMAND="upload-release ${candidate_sha}" \
    "$INSTALLED_DEPLOY_SSH_COMMAND" < "$candidate_archive"
  # shellcheck disable=SC2024
  sudo --user deploy-setlivre -- env SSH_ORIGINAL_COMMAND="upload-web-environment ${candidate_sha}" \
    "$INSTALLED_DEPLOY_SSH_COMMAND" < "$candidate_web_environment"
  # shellcheck disable=SC2024
  sudo --user deploy-setlivre -- \
    env SSH_ORIGINAL_COMMAND="upload-backoffice-environment ${candidate_sha}" \
    "$INSTALLED_DEPLOY_SSH_COMMAND" < "$candidate_backoffice_environment"
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

invoke_candidate_through_forced_command() {
  local candidate_sha="$1"
  local candidate_checksum="$2"
  sudo --user deploy-setlivre -- \
    env \
    SET_LIVRE_TEST_CANDIDATE="$candidate_sha" \
    SET_LIVRE_TEST_PHASE=success \
    SET_LIVRE_TEST_STATE="$test_state" \
    SSH_ORIGINAL_COMMAND="deploy ${candidate_sha} ${candidate_checksum}" \
    "$INSTALLED_DEPLOY_SSH_COMMAND" </dev/null
}

assert_current_link() {
  local expected="$1"
  local current
  current="$(sudo readlink --canonicalize-existing /opt/set-livre/current)"
  [[ ${current} == "/opt/set-livre/releases/${expected}" ]] \
    || fail "release ativa divergiu depois do teste de rollback."
}

assert_current_release() {
  local expected="$1"
  assert_current_link "$expected"
  [[ ! -e /opt/set-livre/.activation-rollback ]] \
    || fail "marcador de rollback permaneceu depois de estado terminal."
}

recover_services_successfully() {
  local expected="$1"
  sudo env \
    PATH="$fake_bin:$PATH" \
    SET_LIVRE_TEST_PHASE=success \
    SET_LIVRE_TEST_STATE="$test_state" \
    bash "$REPOSITORY_ROOT/ops/deploy-release.sh" --recover-services
  assert_current_release "$expected"
}

run_expected_failure() {
  local candidate_sha="$1"
  local phase="$2"
  local expected_current="$3"
  local expected_marker="${4:-absent}"
  rm -f -- "$test_state"/*
  package_candidate "$candidate_sha"
  upload_candidate "$candidate_sha"
  if invoke_candidate "$candidate_sha" "$phase"; then
    fail "falha injetada em ${phase} foi aceita como sucesso."
  fi
  if [[ -z ${expected_current} ]]; then
    [[ ! -e /opt/set-livre/current ]] || fail "primeira ativação falha deixou release ativa."
    [[ ! -e /opt/set-livre/.activation-rollback ]] || fail "rollback inicial deixou marcador."
  elif [[ ${expected_marker} == retained ]]; then
    assert_current_link "$expected_current"
    [[ -e /opt/set-livre/.activation-rollback ]] \
      || fail "falha de estabilização consumiu o marcador necessário ao retry."
  else
    assert_current_release "$expected_current"
  fi
}

initial_failure_sha="$(printf '0%.0s' {1..40})"
run_expected_failure "$initial_failure_sha" services ""

stale_staging_sha="$(printf 'd%.0s' {1..40})"
stale_staging_directory="/opt/set-livre/releases/.staging-${stale_staging_sha}.Ab12Cd"
sudo install -d -o root -g setlivre -m 0750 "$stale_staging_directory"
sudo install -o root -g setlivre -m 0640 /dev/null "$stale_staging_directory/interrupted"

rm -f -- "$test_state"/*
package_candidate "$release_sha"
upload_candidate "$release_sha"
invoke_candidate_through_forced_command "$release_sha" "$candidate_checksum"
assert_current_release "$release_sha"
[[ ! -e ${stale_staging_directory} ]] \
  || fail "staging residual validado não foi removido antes da ativação."
[[ $(sudo stat --format '%i' /opt/set-livre/current/web/server.js) \
  != "$(sudo stat --format '%i' /opt/set-livre/current/web/hardlink-source-fixture.js)" ]] \
  || fail "hard link do produtor não foi materializado como arquivo regular independente."
[[ $(sudo stat --format '%U:%G:%a' /opt/set-livre/current/.runtime/web.env) \
  == "root:setlivre-web:640" ]] || fail "ambiente web versionado tem permissões inválidas."
[[ $(sudo stat --format '%U:%G:%a' /opt/set-livre/current/.runtime/backoffice.env) \
  == "root:setlivre-backoffice:640" ]] || fail "ambiente backoffice versionado tem permissões inválidas."

nested_current_sha="$(printf 'facefeed%.0s' {1..5})"
rm -f -- "$test_state"/*
package_candidate "$nested_current_sha"
upload_candidate "$nested_current_sha"
sudo ln --symbolic --force "/opt/set-livre/releases/${release_sha}/web" \
  /opt/set-livre/current.next
sudo mv --no-target-directory --force /opt/set-livre/current.next /opt/set-livre/current
if invoke_candidate "$nested_current_sha" success; then
  fail "current aninhado foi aceito como raiz de release anterior."
fi
[[ $(sudo readlink --canonicalize-existing /opt/set-livre/current) \
  == "/opt/set-livre/releases/${release_sha}/web" ]] \
  || fail "a recusa do current aninhado alterou seu destino antes da ativação."
[[ ! -e /opt/set-livre/.activation-rollback ]] \
  || fail "current aninhado publicou marcador de rollback inválido."
sudo rm -rf -- "/opt/set-livre/releases/${nested_current_sha}"
sudo ln --symbolic --force "/opt/set-livre/releases/${release_sha}" \
  /opt/set-livre/current.next
sudo mv --no-target-directory --force /opt/set-livre/current.next /opt/set-livre/current
assert_current_release "$release_sha"

integrity_guard_sha="$(printf 'deadc0de%.0s' {1..5})"
rm -f -- "$test_state"/*
package_candidate "$integrity_guard_sha"
upload_candidate "$integrity_guard_sha"
invoke_candidate "$integrity_guard_sha" success
assert_current_release "$integrity_guard_sha"
package_candidate "$release_sha"
upload_candidate "$release_sha"
invoke_candidate "$release_sha" success
assert_current_release "$release_sha"
printf 'release adulterada\n' \
  | sudo tee "/opt/set-livre/releases/${integrity_guard_sha}/web/server.js" >/dev/null
package_candidate "$integrity_guard_sha"
upload_candidate "$integrity_guard_sha"
if invoke_candidate "$integrity_guard_sha" success; then
  fail "release existente adulterada foi reutilizada pelo mesmo SHA."
fi
assert_current_release "$release_sha"
sudo rm -rf -- "/opt/set-livre/releases/${integrity_guard_sha}"

run_expected_failure "$(printf '1%.0s' {1..40})" environment "$release_sha"
run_expected_failure "$(printf '2%.0s' {1..40})" symlink "$release_sha"
run_expected_failure "$(printf '3%.0s' {1..40})" services "$release_sha"
run_expected_failure "$(printf '4%.0s' {1..40})" internal-health "$release_sha"
run_expected_failure "$(printf '5%.0s' {1..40})" public-health "$release_sha"
rollback_public_sha="$(printf 'e%.0s' {1..40})"
run_expected_failure "$rollback_public_sha" rollback-public-health "$release_sha" retained
[[ -e "$test_state/rollback-public-health-observed" ]] \
  || fail "rollback não consultou o readiness HTTPS público da release anterior."
grep --fixed-strings --line-regexp \
  'stop set-livre-web.service set-livre-backoffice.service' \
  "$test_state/systemctl.log" >/dev/null \
  || fail "rollback sem readiness público não interrompeu os serviços."
recover_services_successfully "$release_sha"
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
recovery_public_sha="$(printf 'f%.0s' {1..40})"
printf '/opt/set-livre/releases/%s\n' "$release_sha" > "$rollback_source"
sudo install -o root -g root -m 0600 "$rollback_source" /opt/set-livre/.activation-rollback
sudo ln --symbolic --force "/opt/set-livre/releases/${retention_sha}" /opt/set-livre/current.next
sudo mv --no-target-directory --force /opt/set-livre/current.next /opt/set-livre/current
run_expected_failure "$recovery_public_sha" recovery-public-health "$release_sha" retained
[[ -e "$test_state/recovery-public-health-observed" ]] \
  || fail "recuperação anterior ao deploy não consultou o readiness HTTPS público."
grep --fixed-strings --line-regexp \
  'stop set-livre-web.service set-livre-backoffice.service' \
  "$test_state/systemctl.log" >/dev/null \
  || fail "recuperação anterior ao deploy sem readiness público não interrompeu os serviços."
recover_services_successfully "$release_sha"

printf '/opt/set-livre/releases/%s\n' "$release_sha" > "$rollback_source"
sudo install -o root -g root -m 0600 "$rollback_source" /opt/set-livre/.activation-rollback
sudo ln --symbolic --force "/opt/set-livre/releases/${retention_sha}" /opt/set-livre/current.next
sudo mv --no-target-directory --force /opt/set-livre/current.next /opt/set-livre/current
sudo bash "$REPOSITORY_ROOT/ops/deploy-release.sh" --recover-link
assert_current_link "$release_sha"
[[ -e /opt/set-livre/.activation-rollback ]] \
  || fail "recuperação do link consumiu o marcador antes de estabilizar os serviços."
if sudo env \
  PATH="$fake_bin:$PATH" \
  SET_LIVRE_TEST_PHASE=recovery-public-health \
  SET_LIVRE_TEST_STATE="$test_state" \
  bash "$REPOSITORY_ROOT/ops/deploy-release.sh" --recover-services; then
  fail "recuperação de serviços aceitou readiness HTTPS público com falha."
fi
assert_current_link "$release_sha"
[[ -e /opt/set-livre/.activation-rollback ]] \
  || fail "recuperação falha consumiu o marcador necessário ao retry."
recover_services_successfully "$release_sha"

sudo install -o root -g root -m 0600 "$rollback_source" /opt/set-livre/.activation-rollback
sudo ln --symbolic --force "/opt/set-livre/releases/${retention_sha}" /opt/set-livre/current.next
sudo mv --no-target-directory --force /opt/set-livre/current.next /opt/set-livre/current
recovery_lock_ready="$temporary_directory/recovery-lock-ready"
recovery_lock_release="$temporary_directory/recovery-lock-release"
# A expansão de $1/$2 pertence ao bash filho, não ao runner do teste.
# shellcheck disable=SC2016
flock --exclusive /run/lock/set-livre-deploy.lock bash -c '
  touch "$1"
  while [[ ! -e $2 ]]; do /usr/bin/sleep 0.05; done
' _ "$recovery_lock_ready" "$recovery_lock_release" &
lock_holder=$!
for _ in {1..20}; do
  [[ ! -e ${recovery_lock_ready} ]] || break
  /usr/bin/sleep 0.05
done
[[ -e ${recovery_lock_ready} ]] || fail "lock de deploy do teste não foi adquirido."
sudo env \
  PATH="$fake_bin:$PATH" \
  SET_LIVRE_TEST_PHASE=success \
  SET_LIVRE_TEST_STATE="$test_state" \
  bash "$REPOSITORY_ROOT/ops/deploy-release.sh" --recover-services &
recovery_process=$!
/usr/bin/sleep 0.1
kill -0 "$recovery_process" 2>/dev/null \
  || fail "watcher de recuperação não aguardou o lock do deploy."
[[ -e /opt/set-livre/.activation-rollback ]] \
  || fail "watcher alterou o marcador enquanto o deploy mantinha o lock."
touch "$recovery_lock_release"
wait "$lock_holder"
wait "$recovery_process"
assert_current_release "$release_sha"

printf 'Uploads, ativação, rollback, interrupção, retenção e recuperação pós-lock verificados.\n'
