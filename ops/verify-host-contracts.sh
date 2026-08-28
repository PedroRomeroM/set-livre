#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly REPOSITORY_ROOT
readonly PRODUCTION_SUPABASE_URL="https://oirvvnojgkzdppkdvhej.supabase.co"
readonly PRODUCTION_PUBLIC_APP_URL="https://147.15.97.227"
readonly PRODUCTION_BACKOFFICE_APP_URL="https://ops.setlivre.com"
readonly INSTALLED_DEPLOY_SSH_COMMAND="/usr/local/sbin/set-livre-deploy-ssh"
readonly INSTALLED_DEPLOY_LOCK="/usr/local/sbin/set-livre-deploy-lock"
readonly FORCED_COMMAND_SUDOERS="/etc/sudoers.d/set-livre-host-contracts"
readonly FAIL2BAN_TEST_CONFIG="/etc/fail2ban/jail.d/set-livre-sshd.local"
readonly FAIL2BAN_TEST_OVERRIDE="/etc/fail2ban/action.d/nftables-host-contracts.local"
nginx_test_active=false
nginx_backend_process=""
forced_command_sudoers_installed=false
fail2ban_test_active=false
sshd_runtime_directory_created=false

cleanup() {
  if [[ ${nginx_test_active} == true ]]; then
    sudo nginx -s stop >/dev/null 2>&1 || true
  fi
  if [[ -n ${nginx_backend_process} ]]; then
    kill "$nginx_backend_process" >/dev/null 2>&1 || true
    wait "$nginx_backend_process" >/dev/null 2>&1 || true
  fi
  if [[ ${forced_command_sudoers_installed} == true ]]; then
    sudo rm -f -- "$FORCED_COMMAND_SUDOERS"
  fi
  if [[ ${fail2ban_test_active} == true ]]; then
    sudo rm -f -- "$FAIL2BAN_TEST_OVERRIDE" "$FAIL2BAN_TEST_CONFIG"
    sudo systemctl stop fail2ban >/dev/null 2>&1 || true
  fi
  if [[ ${sshd_runtime_directory_created} == true ]]; then
    sudo rmdir -- /run/sshd >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

fail() {
  printf 'host-contracts: %s\n' "$1" >&2
  exit 1
}

privileged_path_exists() {
  local path="$1"
  sudo test -e "$path" || sudo test -L "$path"
}

privileged_regular_file_exists() {
  local path="$1"
  sudo test -f "$path" && ! sudo test -L "$path"
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

bootstrap_primitive_markers=(
  "BEGIN SET_LIVRE_MANAGED_FILE_PRIMITIVES"
  "END SET_LIVRE_MANAGED_FILE_PRIMITIVES"
  "BEGIN SET_LIVRE_BOOTSTRAP_MARKER_PRIMITIVES"
  "END SET_LIVRE_BOOTSTRAP_MARKER_PRIMITIVES"
  "BEGIN SET_LIVRE_FAIL2BAN_PRIMITIVE"
  "END SET_LIVRE_FAIL2BAN_PRIMITIVE"
  "BEGIN SET_LIVRE_FAIL2BAN_CONFIGURATION"
  "END SET_LIVRE_FAIL2BAN_CONFIGURATION"
  "BEGIN SET_LIVRE_SSH_POLICY_PRIMITIVES"
  "END SET_LIVRE_SSH_POLICY_PRIMITIVES"
)
for marker in "${bootstrap_primitive_markers[@]}"; do
  [[ $(grep --fixed-strings --count "$marker" "$REPOSITORY_ROOT/ops/bootstrap-host.sh") -eq 1 ]] \
    || fail "marcador de primitive do bootstrap ausente ou duplicado: ${marker}."
done
bootstrap_primitive_runtime="$temporary_directory/bootstrap-primitive-runtime.sh"
{
  printf '%s\n' '#!/usr/bin/env bash' 'set -Eeuo pipefail'
  sed -n \
    '/^# BEGIN SET_LIVRE_MANAGED_FILE_PRIMITIVES$/,/^# END SET_LIVRE_MANAGED_FILE_PRIMITIVES$/p' \
    "$REPOSITORY_ROOT/ops/bootstrap-host.sh"
  sed -n \
    '/^# BEGIN SET_LIVRE_BOOTSTRAP_MARKER_PRIMITIVES$/,/^# END SET_LIVRE_BOOTSTRAP_MARKER_PRIMITIVES$/p' \
    "$REPOSITORY_ROOT/ops/bootstrap-host.sh"
  cat <<'BOOTSTRAP_PRIMITIVE_RUNTIME'
fail() {
  printf 'bootstrap-primitives: %s\n' "$1" >&2
  exit 1
}

[[ $# -eq 1 ]] || fail "diretório de teste ausente."
test_root="$1"
[[ ${test_root} == /* && -d ${test_root} && ! -L ${test_root} ]] \
  || fail "diretório de teste inválido."
HOST_STATE_DIRECTORY="${test_root}/state"
HOST_CONFIGURATION_DIGEST="${HOST_STATE_DIRECTORY}/host-config.sha256"
HOST_CONFIGURATION_PREVIOUS_DIGEST="${HOST_STATE_DIRECTORY}/host-config.previous.sha256"
HOST_BOOTSTRAP_IN_PROGRESS="${HOST_STATE_DIRECTORY}/bootstrap-in-progress.sha256"
HOST_BOOTSTRAP_RECOVERY_IN_PROGRESS="${HOST_STATE_DIRECTORY}/bootstrap-recovery-in-progress.sha256"
MANAGED_FILE_STAGING_DIRECTORY="${HOST_STATE_DIRECTORY}/.managed-file-staging"
ROLLBACK_MARKER="${test_root}/activation-rollback"
bootstrap_marker_source=""
bootstrap_recovery_marker_source=""
recovery_marker_source=""
managed_file_staging=""

install -d -o root -g setlivre -m 0750 "$HOST_STATE_DIRECTORY"
install -d -o root -g root -m 0755 "$test_root/targets" "$test_root/hooks"
printf 'source\n' > "$test_root/source"
printf 'victim\n' > "$test_root/victim"
chown root:root "$test_root/source" "$test_root/victim"
chmod 0644 "$test_root/source" "$test_root/victim"

target="$test_root/targets/managed.conf"
publish_managed_file "$test_root/source" "$target" root root 0644 \
  || fail "folha regular válida não foi publicada."
[[ $(< "$target") == source ]] || fail "folha publicada divergiu da fonte."

rm -f -- "$target"
ln -s -- "$test_root/victim" "$target"
if publish_managed_file "$test_root/source" "$target" root root 0644; then
  fail "symlink existente foi aceito como folha gerenciada."
fi
[[ $(< "$test_root/victim") == victim ]] || fail "destino do symlink foi alterado."
rm -f -- "$target"
ln -s -- "$test_root/missing" "$target"
if publish_managed_file "$test_root/source" "$target" root root 0644; then
  fail "dangling symlink foi aceito como folha gerenciada."
fi
rm -f -- "$target"
ln -- "$test_root/victim" "$target"
if publish_managed_file "$test_root/source" "$target" root root 0644; then
  fail "hardlink foi aceito como folha gerenciada."
fi
[[ $(< "$test_root/victim") == victim ]] || fail "inode do hardlink foi alterado."
rm -f -- "$target"
mkfifo -- "$target"
if publish_managed_file "$test_root/source" "$target" root root 0644; then
  fail "arquivo especial foi aceito como folha gerenciada."
fi
rm -f -- "$target"

hook_target="$test_root/hooks/reload-hook"
publish_managed_file "$test_root/source" "$hook_target" root root 0755 \
  || fail "hook inicial não foi publicado."
hook_id="$(printf '%s' "$hook_target" | sha256sum | cut -d ' ' -f 1)"
stale_hook="${MANAGED_FILE_STAGING_DIRECTORY}/${hook_id}.ABC123"
install -o root -g root -m 0755 "$test_root/source" "$stale_hook"
publish_managed_file "$test_root/source" "$hook_target" root root 0755 \
  || fail "staging executável válido não foi recuperado."
[[ ! -e ${stale_hook} && ! -L ${stale_hook} ]] \
  || fail "staging executável permaneceu após retry."
[[ $(stat --format '%U:%G:%a' -- "$MANAGED_FILE_STAGING_DIRECTORY") == root:root:700 ]] \
  || fail "staging compartilhado não ficou isolado de scanners e identidades."
[[ -z $(find "$test_root/hooks" -mindepth 1 -maxdepth 1 ! -name reload-hook -print -quit) ]] \
  || fail "staging ficou endereçável no diretório de hooks."
group_target="$test_root/targets/group-owned.conf"
group_target_id="$(printf '%s' "$group_target" | sha256sum | cut -d ' ' -f 1)"
stale_group_target="${MANAGED_FILE_STAGING_DIRECTORY}/${group_target_id}.DEF456"
install -o root -g root -m 0640 "$test_root/source" "$stale_group_target"
publish_managed_file "$test_root/source" "$group_target" root setlivre 0640 \
  || fail "staging intermediário root:root com modo final não foi recuperado."
[[ ! -e ${stale_group_target} && ! -L ${stale_group_target} \
  && $(stat --format '%U:%G:%a:%h' -- "$group_target") == root:setlivre:640:1 ]] \
  || fail "retry não publicou owner, grupo e modo finais após estado intermediário."
ln -s -- "$test_root/victim" "$stale_hook"
if publish_managed_file "$test_root/source" "$hook_target" root root 0755; then
  fail "staging residual ligado foi removido silenciosamente."
fi
rm -f -- "$stale_hook"

digest="$(printf 'a%.0s' {1..64})"
set +e
(
  publish_bootstrap_in_progress "$digest" || exit 120
  kill -KILL "$BASHPID"
  ensure_managed_directory "$HOST_STATE_DIRECTORY" root root 0700
)
kill_status=$?
set -e
[[ ${kill_status} -eq 137 ]] || fail "SIGKILL anterior à restrição não foi exercitado."
[[ $(stat --format '%U:%G:%a' -- "$HOST_STATE_DIRECTORY") == root:setlivre:750 ]] \
  || fail "estado saudável foi restringido antes da publicação do blocker."
[[ -f ${HOST_BOOTSTRAP_IN_PROGRESS} && ! -L ${HOST_BOOTSTRAP_IN_PROGRESS} \
  && $(stat --format '%U:%G:%a' -- "$HOST_BOOTSTRAP_IN_PROGRESS") == root:root:600 \
  && $(< "$HOST_BOOTSTRAP_IN_PROGRESS") == "$digest" ]] \
  || fail "SIGKILL anterior à restrição não preservou blocker autenticado."
rm -f -- "$HOST_BOOTSTRAP_IN_PROGRESS"

set +e
(
  publish_bootstrap_in_progress "$digest" || exit 121
  ensure_managed_directory "$HOST_STATE_DIRECTORY" root root 0700 || exit 122
  kill -KILL "$BASHPID"
)
kill_status=$?
set -e
[[ ${kill_status} -eq 137 ]] || fail "SIGKILL posterior à restrição não foi exercitado."
[[ $(stat --format '%U:%G:%a' -- "$HOST_STATE_DIRECTORY") == root:root:700 \
  && -f ${HOST_BOOTSTRAP_IN_PROGRESS} && ! -L ${HOST_BOOTSTRAP_IN_PROGRESS} \
  && $(stat --format '%U:%G:%a' -- "$HOST_BOOTSTRAP_IN_PROGRESS") == root:root:600 \
  && $(< "$HOST_BOOTSTRAP_IN_PROGRESS") == "$digest" ]] \
  || fail "restrição interrompida não preservou blocker autenticado."

printf 'bootstrap primitive runtime contracts OK\n'
BOOTSTRAP_PRIMITIVE_RUNTIME
} > "$bootstrap_primitive_runtime"
chmod 0700 "$bootstrap_primitive_runtime"
bootstrap_primitive_root="$temporary_directory/bootstrap-primitives"
mkdir -- "$bootstrap_primitive_root"
sudo bash "$bootstrap_primitive_runtime" "$bootstrap_primitive_root"
sudo chown -R "$(id --user):$(id --group)" "$bootstrap_primitive_root"

ssh_policy_runtime="$temporary_directory/ssh-policy-runtime.sh"
{
  printf '%s\n' '#!/usr/bin/env bash' 'set -Eeuo pipefail' \
    'PRODUCTION_IP="147.15.97.227"'
  sed -n \
    '/^# BEGIN SET_LIVRE_SSH_POLICY_PRIMITIVES$/,/^# END SET_LIVRE_SSH_POLICY_PRIMITIVES$/p' \
    "$REPOSITORY_ROOT/ops/bootstrap-host.sh"
  cat <<'SSH_POLICY_RUNTIME'
fail() {
  printf 'ssh-policy: %s\n' "$1" >&2
  exit 1
}

[[ $# -eq 1 ]] || fail "diretório de teste ausente."
test_root="$1"
drop_in_directory="${test_root}/sshd_config.d"
configuration="${test_root}/sshd_config"
mkdir -- "$test_root" "$drop_in_directory"
printf 'Include %s/*.conf\n' "$drop_in_directory" > "$configuration"
cat > "${drop_in_directory}/60-set-livre.conf" <<'SSHD_CONFIGURATION'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
AuthenticationMethods publickey
PermitEmptyPasswords no
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding no
GatewayPorts no
PermitTunnel no
AllowUsers ubuntu deploy-setlivre
SSHD_CONFIGURATION

assert_unconditional_sshd_policy_surface "$configuration" "$drop_in_directory" \
  || fail "configuração global canônica foi recusada."
effective_allow_users_are_exact $'allowusers ubuntu\nallowusers deploy-setlivre' \
  || fail "representação por linhas do OpenSSH foi recusada."
effective_allow_users_are_exact 'allowusers ubuntu deploy-setlivre' \
  || fail "representação agrupada do OpenSSH foi recusada."
if effective_allow_users_are_exact $'allowusers ubuntu deploy-setlivre\nallowusers ubuntu'; then
  fail "AllowUsers duplicado foi aceito."
fi
assert_effective_sshd_policy "$configuration" \
  || fail "configuração efetiva canônica foi recusada."

cat > "${drop_in_directory}/10-conditional.conf" <<'CONDITIONAL_CONFIGURATION'
Match Address 198.51.100.0/24
PasswordAuthentication yes
Match all
CONDITIONAL_CONFIGURATION
if assert_unconditional_sshd_policy_surface "$configuration" "$drop_in_directory"; then
  fail "política Match condicional foi aceita."
fi
rm -- "${drop_in_directory}/10-conditional.conf"

printf 'Include %s/foreign/*.conf\n' "$test_root" \
  > "${drop_in_directory}/10-extra-include.conf"
if assert_unconditional_sshd_policy_surface "$configuration" "$drop_in_directory"; then
  fail "Include não canônico foi aceito."
fi
rm -- "${drop_in_directory}/10-extra-include.conf"

ln --symbolic /dev/null "${drop_in_directory}/10-linked.conf"
if assert_unconditional_sshd_policy_surface "$configuration" "$drop_in_directory"; then
  fail "drop-in SSH simbólico foi aceito."
fi
rm -- "${drop_in_directory}/10-linked.conf"

printf 'SSH policy runtime contracts OK\n'
SSH_POLICY_RUNTIME
} > "$ssh_policy_runtime"
chmod 0700 "$ssh_policy_runtime"
if ! privileged_path_exists /run/sshd; then
  sudo install -d -o root -g root -m 0755 /run/sshd
  sshd_runtime_directory_created=true
fi
if ! sudo test -d /run/sshd \
  || sudo test -L /run/sshd \
  || [[ $(sudo stat --format '%U:%G:%a' -- /run/sshd) != root:root:755 ]]; then
  fail "runtime de privilege separation do OpenSSH não é canônico."
fi
sudo bash "$ssh_policy_runtime" "$temporary_directory/ssh-policy"
sudo chown -R "$(id --user):$(id --group)" "$temporary_directory/ssh-policy"

! privileged_path_exists "$FAIL2BAN_TEST_CONFIG" \
  || fail "configuração Fail2ban do contrato já existe no runner."
! privileged_path_exists "$FAIL2BAN_TEST_OVERRIDE" \
  || fail "override Fail2ban do contrato já existe no runner."
fail2ban_config_source="$temporary_directory/set-livre-sshd.local"
sed -n \
  '/^# BEGIN SET_LIVRE_FAIL2BAN_CONFIGURATION$/,/^# END SET_LIVRE_FAIL2BAN_CONFIGURATION$/p' \
  "$REPOSITORY_ROOT/ops/bootstrap-host.sh" > "$fail2ban_config_source"
grep --fixed-strings --line-regexp \
  'banaction = nftables[actionstart_on_demand=false]' \
  "$fail2ban_config_source" >/dev/null \
  || fail "configuração extraída não fixa o cold start da ação nftables."
fail2ban_runtime="$temporary_directory/fail2ban-contract-runtime.sh"
{
  printf '%s\n' '#!/usr/bin/env bash' 'set -Eeuo pipefail'
  sed -n \
    '/^# BEGIN SET_LIVRE_FAIL2BAN_PRIMITIVE$/,/^# END SET_LIVRE_FAIL2BAN_PRIMITIVE$/p' \
    "$REPOSITORY_ROOT/ops/bootstrap-host.sh"
  printf '%s\n' 'fail2ban_contract_is_ready'
} > "$fail2ban_runtime"
chmod 0700 "$fail2ban_runtime"
sudo install -o root -g root -m 0644 "$fail2ban_config_source" "$FAIL2BAN_TEST_CONFIG"
fail2ban_test_active=true
sudo systemctl restart fail2ban
fail2ban_contract_ready=false
for _ in {1..15}; do
  if sudo fail2ban-client ping >/dev/null 2>&1 \
    && sudo fail2ban-client status sshd >/dev/null 2>&1 \
    && sudo bash "$fail2ban_runtime"; then
    fail2ban_contract_ready=true
    break
  fi
  sleep 1
done
[[ ${fail2ban_contract_ready} == true ]] \
  || fail "ação nftables efetiva do Fail2ban não ficou pronta no laboratório."
sudo install -o root -g root -m 0644 /dev/null "$FAIL2BAN_TEST_OVERRIDE"
if sudo bash "$fail2ban_runtime"; then
  fail "override local da ação nftables foi aceito no laboratório."
fi
sudo rm -f -- "$FAIL2BAN_TEST_OVERRIDE"
sudo bash "$fail2ban_runtime" \
  || fail "remoção do override não restaurou o contrato Fail2ban."

sudo install -d -o deploy-setlivre -g deploy-setlivre -m 0700 /home/deploy-setlivre/incoming
sudo install -o deploy-setlivre -g deploy-setlivre -m 0600 /dev/null \
  /home/deploy-setlivre/incoming/.incoming.lock
sudo install -d -o root -g setlivre -m 0750 \
  /etc/set-livre /opt/set-livre /opt/set-livre/releases

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
sudo install -d -o root -g root -m 0755 \
  /var/www/set-livre-acme/.well-known/acme-challenge
printf 'set-livre-acme-regular\n' > "$temporary_directory/acme-regular"
sudo install -o root -g root -m 0644 "$temporary_directory/acme-regular" \
  /var/www/set-livre-acme/.well-known/acme-challenge/regular-probe
sudo ln --symbolic --force --no-dereference /etc/passwd \
  /var/www/set-livre-acme/.well-known/acme-challenge/symlink-probe
sudo install -m 0644 "$REPOSITORY_ROOT/ops/nginx/set-livre-tls.conf" /etc/nginx/sites-available/set-livre
sudo nginx -t
python3 -m http.server 3000 --bind 127.0.0.1 --directory "$temporary_directory" \
  > "$temporary_directory/nginx-backend.log" 2>&1 &
nginx_backend_process=$!
for _ in {1..20}; do
  if curl --disable --noproxy '*' --silent --output /dev/null --max-time 1 \
    http://127.0.0.1:3000/; then
    break
  fi
  /usr/bin/sleep 0.05
done
kill -0 "$nginx_backend_process" 2>/dev/null || fail "backend controlado do teste Nginx não iniciou."
if [[ -s /run/nginx.pid ]] && sudo kill -0 "$(< /run/nginx.pid)" 2>/dev/null; then
  sudo nginx -s reload
else
  sudo nginx
fi
nginx_test_active=true
sudo truncate --size 0 \
  /var/log/nginx/set-livre-access.log \
  /var/log/nginx/set-livre-error.log
curl --disable --noproxy '*' --fail --silent --show-error --max-time 5 \
  --retry 5 --retry-all-errors --retry-delay 1 \
  --cacert "$temporary_directory/ip.crt" \
  --resolve "147.15.97.227:443:127.0.0.1" \
  --dump-header "$temporary_directory/ip.headers" \
  --output "$temporary_directory/ip.robots" \
  https://147.15.97.227/robots.txt
tr --delete '\r' < "$temporary_directory/ip.headers" | grep --ignore-case --fixed-strings --line-regexp \
  'X-Robots-Tag: noindex, nofollow, noarchive, nosnippet' >/dev/null
edge_request_id="$(
  tr --delete '\r' < "$temporary_directory/ip.headers" \
    | sed --silent 's/^X-Request-Id: //Ip' \
    | tail --lines 1
)"
[[ ${edge_request_id} =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$ ]] \
  || fail "edge não publicou request ID UUIDv4 autoritativo."
grep --fixed-strings --line-regexp 'Disallow: /' "$temporary_directory/ip.robots" >/dev/null
curl --disable --noproxy '*' --fail --silent --show-error --max-time 2 \
  --resolve "147.15.97.227:80:127.0.0.1" \
  http://147.15.97.227/.well-known/acme-challenge/regular-probe \
  | grep --fixed-strings --line-regexp 'set-livre-acme-regular' >/dev/null
symlink_status="$(
  curl --disable --noproxy '*' --silent --show-error --max-time 2 \
    --resolve "147.15.97.227:80:127.0.0.1" \
    --output "$temporary_directory/acme-symlink-response" \
    --write-out '%{http_code}' \
    http://147.15.97.227/.well-known/acme-challenge/symlink-probe
)"
[[ ${symlink_status} == 404 ]] \
  || fail "Nginx não recusou o arquivo symlink dentro do webroot ACME."
curl --disable --noproxy '*' --silent --show-error --max-time 2 \
  --header 'Host: invalid.example' \
  --output /dev/null \
  http://127.0.0.1/ 2>/dev/null || true
rate_limited=false
for _ in {1..80}; do
  edge_status="$(
    curl --disable --noproxy '*' --silent --show-error --max-time 2 \
      --cacert "$temporary_directory/ip.crt" \
      --resolve "147.15.97.227:443:127.0.0.1" \
      --output /dev/null \
      --write-out '%{http_code}' \
      https://147.15.97.227/api/auth/contract-probe
  )"
  [[ ${edge_status} != 429 ]] || rate_limited=true
done
[[ ${rate_limited} == true ]] || fail "rate limiter não retornou 429 no laboratório."
if sudo grep --extended-regexp --quiet \
  '/api/auth/contract-probe|client: 127[.]0[.]0[.]1' \
  /var/log/nginx/set-livre-error.log; then
  fail "error log expôs diagnóstico do request limitado."
fi
kill "$nginx_backend_process"
wait "$nginx_backend_process" 2>/dev/null || true
nginx_backend_process=""
sudo truncate --size 0 /var/log/nginx/set-livre-error.log
upstream_status="$(
  curl --disable --noproxy '*' --silent --show-error --max-time 5 \
    --cacert "$temporary_directory/ip.crt" \
    --resolve "147.15.97.227:443:127.0.0.1" \
    --dump-header "$temporary_directory/upstream.headers" \
    --output /dev/null \
    --write-out '%{http_code}' \
    https://147.15.97.227/upstream-contract-probe
)"
[[ ${upstream_status} == 502 ]] || fail "falha do upstream não retornou 502 no laboratório."
if sudo test -s /var/log/nginx/set-livre-error.log; then
  fail "error log persistiu diagnóstico bruto da falha de upstream."
fi
sudo cp /var/log/nginx/set-livre-access.log "$temporary_directory/set-livre-access.log"
sudo chown "$(id --user):$(id --group)" "$temporary_directory/set-livre-access.log"
jq --exit-status --slurp '
  length > 0 and
  all(.[]; .requestId | test("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$"))
' "$temporary_directory/set-livre-access.log" >/dev/null \
  || fail "access log contém request ID vazio ou não autoritativo."
if grep --extended-regexp --quiet \
  '147[.]15[.]97[.]227|127[.]0[.]0[.]1|/api/auth|contract-probe' \
  "$temporary_directory/set-livre-access.log"; then
  fail "access log redigido expôs endereço ou target do request."
fi
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
  "$REPOSITORY_ROOT/ops/deploy-lock.py" "$INSTALLED_DEPLOY_LOCK"
sudo install -o root -g root -m 0755 \
  "$REPOSITORY_ROOT/ops/deploy-ssh-command.sh" "$INSTALLED_DEPLOY_SSH_COMMAND"

printf 'deploy-lock-target\n' > "$temporary_directory/deploy-lock-target"
sudo rm -f -- /run/lock/set-livre-deploy.lock
sudo ln --symbolic -- "$temporary_directory/deploy-lock-target" /run/lock/set-livre-deploy.lock
for protected_entrypoint in \
  "$REPOSITORY_ROOT/ops/bootstrap-host.sh" \
  "$REPOSITORY_ROOT/ops/deploy-release.sh --seal-services" \
  "$REPOSITORY_ROOT/ops/deploy-release.sh --recover-services" \
  "$REPOSITORY_ROOT/ops/deploy-release.sh $(printf '0%.0s' {1..40}) $(printf '0%.0s' {1..64}) --verify-only"; do
  read -r -a protected_command <<< "$protected_entrypoint"
  if deploy_lock_probe_output=$(sudo bash "${protected_command[@]}" 2>&1); then
    fail "entrypoint protegido seguiu o symlink do lock de deploy."
  fi
  grep --fixed-strings 'o lock não pôde ser aberto sem seguir links' \
    <<< "$deploy_lock_probe_output" >/dev/null \
    || fail "entrypoint protegido recusou o symlink por motivo inesperado."
  [[ $(< "$temporary_directory/deploy-lock-target") == deploy-lock-target ]] \
    || fail "alvo externo do symlink de lock foi alterado."
done
sudo rm -f -- /run/lock/set-livre-deploy.lock
sudo systemd-analyze verify \
  "$REPOSITORY_ROOT/ops/systemd/set-livre-web.service" \
  "$REPOSITORY_ROOT/ops/systemd/set-livre-backoffice.service" \
  "$REPOSITORY_ROOT/ops/systemd/set-livre-application-start.service" \
  "$REPOSITORY_ROOT/ops/systemd/set-livre-release-recovery.service" \
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
for residual in \
  "/home/deploy-setlivre/incoming/set-livre-${entry_limit_sha}.tar.gz" \
  "/home/deploy-setlivre/incoming/web-${entry_limit_sha}.env" \
  "/home/deploy-setlivre/incoming/backoffice-${entry_limit_sha}.env"; do
  ! privileged_path_exists "$residual" || fail "archive excessivo deixou uploads residuais."
done

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
for residual in \
  "/home/deploy-setlivre/incoming/set-livre-${metadata_limit_sha}.tar.gz" \
  "/home/deploy-setlivre/incoming/web-${metadata_limit_sha}.env" \
  "/home/deploy-setlivre/incoming/backoffice-${metadata_limit_sha}.env"; do
  ! privileged_path_exists "$residual" \
    || fail "archive com metadata excessiva deixou uploads residuais."
done

# O runner confiável abre os fixtures; somente o processo de destino troca de UID.
# shellcheck disable=SC2024
sudo --user deploy-setlivre -- env SSH_ORIGINAL_COMMAND="upload-release ${release_sha}" \
  "$INSTALLED_DEPLOY_SSH_COMMAND" < "$archive"
for abandoned in \
  "/home/deploy-setlivre/incoming/set-livre-${abandoned_sha}.tar.gz" \
  "/home/deploy-setlivre/incoming/web-${abandoned_sha}.env" \
  "/home/deploy-setlivre/incoming/backoffice-${abandoned_sha}.env" \
  "/home/deploy-setlivre/incoming/.upload.Ab12Cd"; do
  ! privileged_path_exists "$abandoned" || fail "upload abandonado não foi removido."
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
! privileged_path_exists "$stale_trusted" || fail "arquivo confiável residual não foi removido."

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
sigkill_marker="$state/${phase}-once"
if [[ ${1:-} == "restart" \
  && ${phase} =~ ^(bootstrap|recovery)-sigkill$ \
  && ! -e ${sigkill_marker} ]]; then
  touch "$sigkill_marker"
  kill -KILL "$PPID"
  /usr/bin/sleep 0.1
fi
SYSTEMCTL

cat > "$fake_bin/curl" <<'CURL'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ ${1:-} == "--disable" ]] || exit 64
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
source="${@: -2:1}"
destination="${!#}"
if [[ ${SET_LIVRE_TEST_PHASE:-} == "incoming-lock" \
  && ${source} == /home/deploy-setlivre/incoming/* \
  && ${destination} == /var/tmp/set-livre-trusted.* \
  && ! -e "$state/incoming-lock-once" ]]; then
  touch "$state/incoming-lock-once" "$state/incoming-lock-ready"
  while [[ ! -e "$state/incoming-lock-release" ]]; do /usr/bin/sleep 0.05; done
fi
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

! privileged_path_exists "$FORCED_COMMAND_SUDOERS" \
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
  local phase="${3:-success}"
  sudo --user deploy-setlivre -- \
    env \
    SET_LIVRE_TEST_CANDIDATE="$candidate_sha" \
    SET_LIVRE_TEST_PHASE="$phase" \
    SET_LIVRE_TEST_STATE="$test_state" \
    SSH_ORIGINAL_COMMAND="deploy ${candidate_sha} ${candidate_checksum}" \
    "$INSTALLED_DEPLOY_SSH_COMMAND" </dev/null
}

verify_privileged_installer_upload_lock() (
  local candidate_sha="$1"
  local deploy_process=""
  local upload_status
  # Invocada indiretamente pelo trap local do probe.
  # shellcheck disable=SC2317,SC2329
  cleanup_lock_probe() {
    touch "$test_state/incoming-lock-release"
    if [[ -n ${deploy_process} ]] && kill -0 "$deploy_process" 2>/dev/null; then
      kill -TERM "$deploy_process" 2>/dev/null || true
      wait "$deploy_process" 2>/dev/null || true
    fi
  }
  trap cleanup_lock_probe EXIT

  rm -f -- "$test_state"/*
  package_candidate "$candidate_sha"
  upload_candidate "$candidate_sha"
  invoke_candidate_through_forced_command \
    "$candidate_sha" "$candidate_checksum" incoming-lock &
  deploy_process=$!
  for _ in {1..100}; do
    [[ ! -e "$test_state/incoming-lock-ready" ]] || break
    /usr/bin/sleep 0.05
  done
  [[ -e "$test_state/incoming-lock-ready" ]] \
    || fail "instalador privilegiado não alcançou a cópia protegida."

  if timeout --signal=TERM 0.5s \
    sudo --user deploy-setlivre -- \
      env SSH_ORIGINAL_COMMAND="upload-web-environment ${candidate_sha}" \
      "$INSTALLED_DEPLOY_SSH_COMMAND" < "$candidate_web_environment"; then
    fail "upload concorrente alterou inputs durante a instalação privilegiada."
  else
    upload_status=$?
  fi
  [[ ${upload_status} -eq 124 ]] \
    || fail "upload concorrente falhou sem aguardar o lock privilegiado."

  touch "$test_state/incoming-lock-release"
  wait "$deploy_process"
  deploy_process=""
  assert_current_release "$candidate_sha"
)

assert_symlinked_release_component_rejected() (
  local component="$1"
  local backup external link_path metadata_before metadata_after output
  external="$temporary_directory/release-root-probe-${component}"
  output="$temporary_directory/release-root-probe-${component}.log"
  mkdir -m 0711 "$external"
  metadata_before="$(stat --format '%u:%g:%a' -- "$external")"
  if [[ ${component} == root ]]; then
    link_path=/opt/set-livre
    backup=/opt/set-livre.host-contracts-backup
  else
    link_path=/opt/set-livre/releases
    backup=/opt/set-livre/releases.host-contracts-backup
  fi
  ! privileged_path_exists "$backup" || fail "backup do probe de symlink já existe."
  # Invocada indiretamente pelo trap local do probe.
  # shellcheck disable=SC2317,SC2329
  restore_release_component() {
    if sudo test -L "$link_path"; then
      sudo rm -f -- "$link_path"
    fi
    if sudo test -d "$backup" && ! sudo test -L "$backup"; then
      sudo mv --no-target-directory -- "$backup" "$link_path"
    fi
  }
  trap restore_release_component EXIT

  sudo mv --no-target-directory -- "$link_path" "$backup"
  sudo ln --symbolic -- "$external" "$link_path"
  # O redirect pertence deliberadamente ao runner confiável, não ao sudo.
  # shellcheck disable=SC2024
  if sudo bash "$REPOSITORY_ROOT/ops/deploy-release.sh" \
    "$(printf '0%.0s' {1..40})" "$(printf '0%.0s' {1..64})" --verify-only \
    > "$output" 2>&1; then
    fail "componente ${component} em symlink foi aceito como raiz de release."
  fi
  grep --fixed-strings 'raiz de releases não atende ao contrato físico e de permissões' \
    "$output" >/dev/null \
    || fail "componente ${component} em symlink falhou por motivo inesperado."
  recovery_mode=--recover-services
  # O redirect pertence deliberadamente ao runner confiável, não ao sudo.
  # shellcheck disable=SC2024
  if sudo bash "$REPOSITORY_ROOT/ops/deploy-release.sh" "$recovery_mode" \
    > "$output" 2>&1; then
    fail "recovery ${recovery_mode} aceitou ${component} em symlink."
  fi
  grep --fixed-strings 'raiz de releases não atende ao contrato físico e de permissões' \
    "$output" >/dev/null \
    || fail "recovery ${recovery_mode} falhou por motivo inesperado no probe ${component}."
  metadata_after="$(stat --format '%u:%g:%a' -- "$external")"
  [[ ${metadata_after} == "$metadata_before" ]] \
    || fail "probe ${component} alterou owner ou modo do alvo externo."
  [[ -z $(find "$external" -mindepth 1 -print -quit) ]] \
    || fail "probe ${component} escreveu no alvo externo."
)

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
  ! privileged_path_exists /opt/set-livre/.activation-rollback \
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
  ! privileged_path_exists /etc/set-livre/bootstrap-in-progress.sha256 \
    || fail "recuperação terminal preservou o bloqueio de bootstrap."
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
    ! privileged_path_exists /opt/set-livre/current \
      || fail "primeira ativação falha deixou release ativa."
    ! privileged_path_exists /opt/set-livre/.activation-rollback \
      || fail "rollback inicial deixou marcador."
  elif [[ ${expected_marker} == retained ]]; then
    assert_current_link "$expected_current"
    privileged_regular_file_exists /opt/set-livre/.activation-rollback \
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
! privileged_path_exists "$stale_staging_directory" \
  || fail "staging residual validado não foi removido antes da ativação."
[[ $(sudo stat --format '%i' /opt/set-livre/current/web/server.js) \
  != "$(sudo stat --format '%i' /opt/set-livre/current/web/hardlink-source-fixture.js)" ]] \
  || fail "hard link do produtor não foi materializado como arquivo regular independente."
[[ $(sudo stat --format '%U:%G:%a' /opt/set-livre/current/.runtime/web.env) \
  == "root:setlivre-web:640" ]] || fail "ambiente web versionado tem permissões inválidas."
[[ $(sudo stat --format '%U:%G:%a' /opt/set-livre/current/.runtime/backoffice.env) \
  == "root:setlivre-backoffice:640" ]] || fail "ambiente backoffice versionado tem permissões inválidas."
verify_privileged_installer_upload_lock "$release_sha"

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
! privileged_path_exists /opt/set-livre/.activation-rollback \
  || fail "current aninhado publicou marcador de rollback inválido."
sudo rm -rf -- "/opt/set-livre/releases/${nested_current_sha}"
sudo ln --symbolic --force "/opt/set-livre/releases/${release_sha}" \
  /opt/set-livre/current.next
sudo mv --no-target-directory --force /opt/set-livre/current.next /opt/set-livre/current
assert_current_release "$release_sha"

unsafe_environment_sha="$(printf '0badcafe%.0s' {1..5})"
rm -f -- "$test_state"/*
package_candidate "$unsafe_environment_sha"
python3 - "$candidate_web_environment" <<'PYTHON'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
path.write_text(path.read_text().replace("ci-password", "ci'password", 1))
PYTHON
upload_candidate "$unsafe_environment_sha"
if invoke_candidate "$unsafe_environment_sha" success; then
  fail "EnvironmentFile com aspas não escapadas foi aceito."
fi
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
if sudo env \
  PATH="$fake_bin:$PATH" \
  SET_LIVRE_TEST_PHASE=recovery-public-health \
  SET_LIVRE_TEST_STATE="$test_state" \
  bash "$REPOSITORY_ROOT/ops/deploy-release.sh" --recover-services; then
  fail "recuperação de serviços aceitou readiness HTTPS público com falha."
fi
assert_current_link "$release_sha"
privileged_regular_file_exists /opt/set-livre/.activation-rollback \
  || fail "recuperação falha consumiu o marcador necessário ao retry."
recover_services_successfully "$release_sha"

sudo ln --symbolic --force "/opt/set-livre/releases/${retention_sha}" /opt/set-livre/current.next
sudo mv --no-target-directory --force /opt/set-livre/current.next /opt/set-livre/current
sudo install -o root -g root -m 0600 "$rollback_source" /opt/set-livre/.activation-rollback
rm -f -- "$test_state"/*
if sudo env \
  PATH="$fake_bin:$PATH" \
  SET_LIVRE_TEST_PHASE=recovery-sigkill \
  SET_LIVRE_TEST_STATE="$test_state" \
  bash "$REPOSITORY_ROOT/ops/deploy-release.sh" --recover-services; then
  fail "recovery comum sobreviveu ao SIGKILL injetado."
fi
privileged_regular_file_exists /opt/set-livre/.activation-rollback \
  || fail "SIGKILL comum consumiu o rollback necessário ao recovery."
sudo env \
  PATH="$fake_bin:$PATH" \
  SET_LIVRE_TEST_PHASE=success \
  SET_LIVRE_TEST_STATE="$test_state" \
  bash "$REPOSITORY_ROOT/ops/deploy-release.sh" --seal-services
grep --fixed-strings --line-regexp \
  'stop set-livre-web.service set-livre-backoffice.service' \
  "$test_state/systemctl.log" >/dev/null \
  || fail "selamento pós-SIGKILL comum não interrompeu os serviços."
recover_services_successfully "$release_sha"

bootstrap_marker_source="$temporary_directory/bootstrap-in-progress.sha256"
sudo ln --symbolic --force "/opt/set-livre/releases/${retention_sha}" /opt/set-livre/current.next
sudo mv --no-target-directory --force /opt/set-livre/current.next /opt/set-livre/current
printf '%s\n' "$(printf '0%.0s' {1..64})" > "$bootstrap_marker_source"
recovery_mode=--recover-services
sudo install -o root -g root -m 0600 \
  "$bootstrap_marker_source" /etc/set-livre/bootstrap-in-progress.sha256
sudo install -o root -g root -m 0600 \
  "$rollback_source" /opt/set-livre/.activation-rollback
sudo ln --symbolic --force "/opt/set-livre/releases/${retention_sha}" /opt/set-livre/current.next
sudo mv --no-target-directory --force /opt/set-livre/current.next /opt/set-livre/current
if sudo env \
  PATH="$fake_bin:$PATH" \
  SET_LIVRE_TEST_PHASE=success \
  SET_LIVRE_TEST_STATE="$test_state" \
  bash "$REPOSITORY_ROOT/ops/deploy-release.sh" "$recovery_mode"; then
  fail "recovery ${recovery_mode} aceitou digests divergentes no bootstrap."
fi
if ! privileged_regular_file_exists /opt/set-livre/.activation-rollback \
  || ! privileged_regular_file_exists /etc/set-livre/bootstrap-in-progress.sha256; then
  fail "recovery ${recovery_mode} inválido consumiu o estado intermediário."
fi
assert_current_link "$retention_sha"

printf '%s\n' "$host_digest" > "$bootstrap_marker_source"
sudo install -o root -g root -m 0600 \
  "$bootstrap_marker_source" /etc/set-livre/bootstrap-in-progress.sha256
rm -f -- "$test_state"/*
if sudo env \
  PATH="$fake_bin:$PATH" \
  SET_LIVRE_TEST_PHASE=recovery-public-health \
  SET_LIVRE_TEST_STATE="$test_state" \
  bash "$REPOSITORY_ROOT/ops/deploy-release.sh" --recover-services; then
  fail "recovery de bootstrap aceitou readiness HTTPS público com falha."
fi
sudo grep --fixed-strings --line-regexp "$host_digest" \
  /etc/set-livre/bootstrap-in-progress.sha256 >/dev/null \
  || fail "recovery selado não restaurou o bloqueio autenticado de bootstrap."
privileged_regular_file_exists /etc/set-livre/bootstrap-recovery-in-progress.sha256 \
  || fail "recovery falho consumiu prematuramente a fase durável do bootstrap."
privileged_regular_file_exists /opt/set-livre/.activation-rollback \
  || fail "recovery falho consumiu o rollback do bootstrap."
recover_services_successfully "$release_sha"

sudo ln --symbolic --force "/opt/set-livre/releases/${retention_sha}" /opt/set-livre/current.next
sudo mv --no-target-directory --force /opt/set-livre/current.next /opt/set-livre/current
sudo install -o root -g root -m 0600 \
  "$bootstrap_marker_source" /etc/set-livre/bootstrap-in-progress.sha256
sudo install -o root -g root -m 0600 \
  "$rollback_source" /opt/set-livre/.activation-rollback
rm -f -- "$test_state"/*
if sudo env \
  PATH="$fake_bin:$PATH" \
  SET_LIVRE_TEST_PHASE=bootstrap-sigkill \
  SET_LIVRE_TEST_STATE="$test_state" \
  bash "$REPOSITORY_ROOT/ops/deploy-release.sh" --recover-services; then
  fail "recovery de bootstrap sobreviveu ao SIGKILL injetado."
fi
privileged_regular_file_exists /etc/set-livre/bootstrap-recovery-in-progress.sha256 \
  || fail "SIGKILL consumiu a fase durável do recovery."
! privileged_path_exists /etc/set-livre/bootstrap-in-progress.sha256 \
  || fail "SIGKILL executou trap que deveria ter sido inatingível."
privileged_regular_file_exists /opt/set-livre/.activation-rollback \
  || fail "SIGKILL consumiu o rollback necessário ao recovery."
sudo env \
  PATH="$fake_bin:$PATH" \
  SET_LIVRE_TEST_PHASE=success \
  SET_LIVRE_TEST_STATE="$test_state" \
  bash "$REPOSITORY_ROOT/ops/deploy-release.sh" --seal-services
sudo grep --fixed-strings --line-regexp "$host_digest" \
  /etc/set-livre/bootstrap-in-progress.sha256 >/dev/null \
  || fail "recovery selado não restaurou o bloqueio autenticado de bootstrap."
grep --fixed-strings --line-regexp \
  'stop set-livre-web.service set-livre-backoffice.service' \
  "$test_state/systemctl.log" >/dev/null \
  || fail "selamento pós-SIGKILL não interrompeu os serviços."
recover_services_successfully "$release_sha"
! privileged_path_exists /etc/set-livre/bootstrap-recovery-in-progress.sha256 \
  || fail "recovery terminal deixou fase durável residual."

sudo install -o root -g root -m 0600 "$rollback_source" /opt/set-livre/.activation-rollback
sudo ln --symbolic --force "/opt/set-livre/releases/${retention_sha}" /opt/set-livre/current.next
sudo mv --no-target-directory --force /opt/set-livre/current.next /opt/set-livre/current
recovery_lock_ready="$temporary_directory/recovery-lock-ready"
recovery_lock_release="$temporary_directory/recovery-lock-release"
# A expansão de $1/$2 pertence ao bash filho, não ao runner do teste.
# shellcheck disable=SC2016
sudo flock --exclusive /run/lock/set-livre-deploy.lock bash -c '
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
privileged_regular_file_exists /opt/set-livre/.activation-rollback \
  || fail "watcher alterou o marcador enquanto o deploy mantinha o lock."
touch "$recovery_lock_release"
wait "$lock_holder"
wait "$recovery_process"
assert_current_release "$release_sha"

assert_symlinked_release_component_rejected root
assert_symlinked_release_component_rejected releases

printf 'Uploads, lock no-follow, raízes físicas, ativação, rollback, interrupção, retenção e recuperação pós-lock verificados.\n'
