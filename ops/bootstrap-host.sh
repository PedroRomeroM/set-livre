#!/usr/bin/env bash
set -Eeuo pipefail

readonly NODE_VERSION="24.18.0"
readonly NODE_DIRECTORY="node-v${NODE_VERSION}-linux-x64"
readonly PRODUCTION_IP="147.15.97.227"
readonly CERTBOT_MINIMUM_VERSION="5.4.0"
SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIRECTORY
readonly SUPABASE_CA_SOURCE="${SCRIPT_DIRECTORY}/certificates/supabase-root-2021-ca.crt"
readonly DEPLOY_INSTALLER_SOURCE="${SCRIPT_DIRECTORY}/deploy-release.sh"
readonly DEPLOY_SSH_COMMAND_SOURCE="${SCRIPT_DIRECTORY}/deploy-ssh-command.sh"
readonly NGINX_HTTP_SOURCE="${SCRIPT_DIRECTORY}/nginx/set-livre-http.conf"
readonly NGINX_TLS_SOURCE="${SCRIPT_DIRECTORY}/nginx/set-livre-tls.conf"
temporary_directory=""
ipv4_rules=""
ipv6_rules=""
previous_ipv4_rules=""
previous_ipv6_rules=""
previous_persisted_ipv4=""
previous_persisted_ipv6=""
persisted_ipv4_existed=false
persisted_ipv6_existed=false
firewall_transition_active=false
fail2ban_stopped=false
digest_source=""

fail() {
  printf 'bootstrap: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  if [[ ${firewall_transition_active} == true ]]; then
    [[ -z ${previous_ipv4_rules} ]] || iptables-restore < "$previous_ipv4_rules" || true
    [[ -z ${previous_ipv6_rules} ]] || ip6tables-restore < "$previous_ipv6_rules" || true
    if [[ ${persisted_ipv4_existed} == true ]]; then
      install -o root -g root -m 0600 "$previous_persisted_ipv4" /etc/iptables/rules.v4 || true
    else
      rm -f -- /etc/iptables/rules.v4
    fi
    if [[ ${persisted_ipv6_existed} == true ]]; then
      install -o root -g root -m 0600 "$previous_persisted_ipv6" /etc/iptables/rules.v6 || true
    else
      rm -f -- /etc/iptables/rules.v6
    fi
  fi
  [[ -z ${temporary_directory} ]] || rm -rf -- "$temporary_directory"
  [[ -z ${ipv4_rules} ]] || rm -f -- "$ipv4_rules"
  [[ -z ${ipv6_rules} ]] || rm -f -- "$ipv6_rules"
  [[ -z ${previous_ipv4_rules} ]] || rm -f -- "$previous_ipv4_rules"
  [[ -z ${previous_ipv6_rules} ]] || rm -f -- "$previous_ipv6_rules"
  [[ -z ${previous_persisted_ipv4} ]] || rm -f -- "$previous_persisted_ipv4"
  [[ -z ${previous_persisted_ipv6} ]] || rm -f -- "$previous_persisted_ipv6"
  [[ -z ${digest_source} ]] || rm -f -- "$digest_source"
  [[ ${fail2ban_stopped} == false ]] || systemctl start fail2ban || true
}
trap cleanup EXIT

[[ ${EUID} -eq 0 ]] || fail "execute como root."
[[ $# -eq 1 ]] || fail "informe o arquivo que contém a chave pública de deploy."
for required_source in \
  "$SUPABASE_CA_SOURCE" \
  "$DEPLOY_INSTALLER_SOURCE" \
  "$DEPLOY_SSH_COMMAND_SOURCE" \
  "$NGINX_HTTP_SOURCE" \
  "$NGINX_TLS_SOURCE" \
  "${SCRIPT_DIRECTORY}/systemd/set-livre-web.service" \
  "${SCRIPT_DIRECTORY}/systemd/set-livre-backoffice.service" \
  "${SCRIPT_DIRECTORY}/systemd/set-livre-release-recovery.service"; do
  [[ -f ${required_source} && ! -L ${required_source} ]] || fail "fonte operacional ausente ou inválida."
done

deploy_key_file="$(realpath -e -- "$1")"
[[ -f ${deploy_key_file} && ! -L ${deploy_key_file} ]] || fail "a chave de deploy não é um arquivo regular."
IFS= read -r deploy_key < "$deploy_key_file"
[[ ${deploy_key} =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ .*)?$ ]] || fail "a chave de deploy não é Ed25519 válida."

exec 9>/run/lock/set-livre-deploy.lock
flock --exclusive 9

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get upgrade --yes
apt-get install --yes --no-install-recommends \
  ca-certificates \
  curl \
  fail2ban \
  iptables-persistent \
  jq \
  nginx \
  openssh-server \
  python3 \
  snapd \
  unattended-upgrades \
  xz-utils

mapfile -t legacy_certbot_packages < <(
  dpkg-query --show --showformat='${binary:Package}\t${db:Status-Status}\n' 2>/dev/null \
    | awk '$2 == "installed" && ($1 ~ /^certbot(:.*)?$/ || $1 ~ /^python3-(acme|certbot[^:]*)(:.*)?$/) { print $1 }'
)
if (( ${#legacy_certbot_packages[@]} > 0 )); then
  apt-get purge --yes "${legacy_certbot_packages[@]}"
fi
if snap list certbot >/dev/null 2>&1; then
  snap refresh certbot
else
  snap install certbot --classic
fi
certbot_version="$(/snap/bin/certbot --version | awk '{ print $2 }')"
dpkg --compare-versions "$certbot_version" ge "$CERTBOT_MINIMUM_VERSION" \
  || fail "Certbot ${CERTBOT_MINIMUM_VERSION} ou superior é obrigatório para certificado de IP via webroot."

if [[ ! -x "/opt/${NODE_DIRECTORY}/bin/node" ]]; then
  temporary_directory="$(mktemp -d)"
  archive="${NODE_DIRECTORY}.tar.xz"
  curl --fail --location --proto '=https' --tlsv1.2 \
    --output "${temporary_directory}/${archive}" \
    "https://nodejs.org/dist/v${NODE_VERSION}/${archive}"
  curl --fail --location --proto '=https' --tlsv1.2 \
    --output "${temporary_directory}/SHASUMS256.txt" \
    "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
  (
    cd -- "$temporary_directory"
    grep --fixed-strings " ${archive}" SHASUMS256.txt | sha256sum --check --strict
  )
  tar --extract --xz --file "${temporary_directory}/${archive}" --directory /opt
  rm -rf -- "$temporary_directory"
  temporary_directory=""
fi
ln --symbolic --force --no-dereference "/opt/${NODE_DIRECTORY}" /opt/node

for service_group in setlivre setlivre-web setlivre-backoffice; do
  if ! getent group "$service_group" >/dev/null; then
    groupadd --system "$service_group"
  fi
done
for service_identity in setlivre-web setlivre-backoffice; do
  if ! getent passwd "$service_identity" >/dev/null; then
    useradd --system --gid "$service_identity" --groups setlivre \
      --home-dir /nonexistent --shell /usr/sbin/nologin "$service_identity"
  else
    usermod --append --groups setlivre "$service_identity"
  fi
done
if ! getent passwd deploy-setlivre >/dev/null; then
  useradd --create-home --shell /bin/bash deploy-setlivre
fi

install -d -o root -g setlivre -m 0750 /etc/set-livre /opt/set-livre /opt/set-livre/releases
if [[ -e /etc/set-livre/host-config.sha256 ]]; then
  [[ -f /etc/set-livre/host-config.sha256 && ! -L /etc/set-livre/host-config.sha256 ]] \
    || fail "marcador operacional instalado é inválido."
  install -o root -g setlivre -m 0640 /etc/set-livre/host-config.sha256 \
    /etc/set-livre/host-config.previous.sha256
  rm -f -- /etc/set-livre/host-config.sha256
fi
install -d -o root -g root -m 0755 /var/www/set-livre-acme/.well-known/acme-challenge
install -o root -g root -m 0644 "${SUPABASE_CA_SOURCE}" /etc/set-livre/supabase-root-2021-ca.crt
install -d -o deploy-setlivre -g deploy-setlivre -m 0700 /home/deploy-setlivre/.ssh
install -d -o deploy-setlivre -g deploy-setlivre -m 0700 /home/deploy-setlivre/incoming
printf 'restrict,command="/usr/local/sbin/set-livre-deploy-ssh" %s\n' "$deploy_key" \
  > /home/deploy-setlivre/.ssh/authorized_keys
chown deploy-setlivre:deploy-setlivre /home/deploy-setlivre/.ssh/authorized_keys
chmod 0600 /home/deploy-setlivre/.ssh/authorized_keys

install -o root -g root -m 0755 "$DEPLOY_INSTALLER_SOURCE" /usr/local/sbin/set-livre-deploy
install -o root -g root -m 0755 "$DEPLOY_SSH_COMMAND_SOURCE" /usr/local/sbin/set-livre-deploy-ssh
install -o root -g root -m 0644 "${SCRIPT_DIRECTORY}/systemd/set-livre-web.service" /etc/systemd/system/set-livre-web.service
install -o root -g root -m 0644 "${SCRIPT_DIRECTORY}/systemd/set-livre-backoffice.service" /etc/systemd/system/set-livre-backoffice.service
install -o root -g root -m 0644 "${SCRIPT_DIRECTORY}/systemd/set-livre-release-recovery.service" \
  /etc/systemd/system/set-livre-release-recovery.service
install -d -o root -g root -m 0755 /usr/local/share/set-livre
install -o root -g root -m 0644 "$NGINX_HTTP_SOURCE" /usr/local/share/set-livre/nginx-http.conf
install -o root -g root -m 0644 "$NGINX_TLS_SOURCE" /usr/local/share/set-livre/nginx-tls.conf

host_configuration_digest="$(python3 - "$SCRIPT_DIRECTORY" <<'PYTHON'
import hashlib
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
files = [
    "bootstrap-host.sh",
    "certificates/supabase-root-2021-ca.crt",
    "deploy-release.sh",
    "deploy-ssh-command.sh",
    "nginx/set-livre-http.conf",
    "nginx/set-livre-tls.conf",
    "systemd/set-livre-backoffice.service",
    "systemd/set-livre-release-recovery.service",
    "systemd/set-livre-web.service",
]
digest = hashlib.sha256()
for relative in files:
    path = root / relative
    if not path.is_file() or path.is_symlink():
        raise SystemExit(f"fonte operacional inválida: {relative}")
    digest.update(relative.encode("utf-8"))
    digest.update(b"\0")
    digest.update(path.read_bytes())
    digest.update(b"\0")
print(digest.hexdigest())
PYTHON
)"
[[ ${host_configuration_digest} =~ ^[0-9a-f]{64}$ ]] || fail "digest operacional inválido."
active_nginx_source=/usr/local/share/set-livre/nginx-http.conf
certificate_path="/etc/letsencrypt/live/${PRODUCTION_IP}/fullchain.pem"
private_key_path="/etc/letsencrypt/live/${PRODUCTION_IP}/privkey.pem"
if [[ -f ${certificate_path} || -f ${private_key_path} ]]; then
  [[ -f ${certificate_path} && -f ${private_key_path} ]] \
    || fail "certificado TLS de IP está incompleto."
  openssl x509 -checkend 0 -noout -in "$certificate_path" \
    || fail "certificado TLS de IP expirou."
  openssl x509 -checkip "$PRODUCTION_IP" -noout -in "$certificate_path" \
    || fail "certificado TLS não cobre o IP de produção."
  active_nginx_source=/usr/local/share/set-livre/nginx-tls.conf
fi
install -o root -g root -m 0644 "$active_nginx_source" /etc/nginx/sites-available/set-livre
ln --symbolic --force /etc/nginx/sites-available/set-livre /etc/nginx/sites-enabled/set-livre
rm -f -- \
  /etc/nginx/sites-enabled/default \
  /etc/nginx/sites-enabled/setlivre \
  /etc/nginx/sites-available/setlivre-bootstrap \
  /etc/nginx/sites-available/setlivre-tls

install -d -o root -g root -m 0755 /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/set-livre-reload-nginx <<'RENEWAL_HOOK'
#!/bin/sh
set -eu
nginx -t
systemctl reload nginx
RENEWAL_HOOK
chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/set-livre-reload-nginx

cat > /etc/sudoers.d/set-livre-deploy <<'SUDOERS'
deploy-setlivre ALL=(root) NOPASSWD: /usr/local/sbin/set-livre-deploy
SUDOERS
chmod 0440 /etc/sudoers.d/set-livre-deploy
visudo --check --file /etc/sudoers.d/set-livre-deploy

cat > /etc/ssh/sshd_config.d/60-set-livre.conf <<'SSHD'
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
SSHD
rm -f -- /etc/ssh/sshd_config.d/60-setlivre-hardening.conf
sshd -t
systemctl reload ssh

cat > /etc/fail2ban/jail.d/set-livre-sshd.local <<'FAIL2BAN'
[sshd]
enabled = true
backend = systemd
bantime = 1h
findtime = 10m
maxretry = 5
FAIL2BAN
chown root:root /etc/fail2ban/jail.d/set-livre-sshd.local
chmod 0644 /etc/fail2ban/jail.d/set-livre-sshd.local

# Ubuntu images supplied by Oracle depend on the InstanceServices OUTPUT chain for boot-volume and
# metadata traffic. Build and validate a complete replacement ruleset before one restore transaction.
if dpkg-query --show --showformat='${db:Status-Status}\n' ufw 2>/dev/null \
  | grep --quiet --line-regexp installed; then
  fail "UFW instalado; a imagem Oracle dedicada deve usar somente o contrato iptables versionado."
fi
iptables -w -S InstanceServices >/dev/null 2>&1 || fail "chain InstanceServices da Oracle ausente."
iptables-save -t filter | grep --extended-regexp '^-A OUTPUT .* -j InstanceServices$' >/dev/null \
  || fail "salto OUTPUT para InstanceServices ausente."
oracle_rules_before="$({
  iptables-save -t filter \
    | grep --extended-regexp '^:InstanceServices |^-A OUTPUT .* -j InstanceServices$|^-A InstanceServices '
} | sha256sum | cut -d ' ' -f 1)"

systemctl stop fail2ban || true
fail2ban_stopped=true
previous_ipv4_rules="$(mktemp)"
previous_ipv6_rules="$(mktemp)"
iptables-save > "$previous_ipv4_rules"
ip6tables-save > "$previous_ipv6_rules"
iptables-restore --test < "$previous_ipv4_rules"
ip6tables-restore --test < "$previous_ipv6_rules"

if [[ -e /etc/iptables/rules.v4 ]]; then
  [[ -f /etc/iptables/rules.v4 && ! -L /etc/iptables/rules.v4 ]] \
    || fail "rules.v4 persistido é inválido."
  previous_persisted_ipv4="$(mktemp)"
  install -o root -g root -m 0600 /etc/iptables/rules.v4 "$previous_persisted_ipv4"
  persisted_ipv4_existed=true
fi
if [[ -e /etc/iptables/rules.v6 ]]; then
  [[ -f /etc/iptables/rules.v6 && ! -L /etc/iptables/rules.v6 ]] \
    || fail "rules.v6 persistido é inválido."
  previous_persisted_ipv6="$(mktemp)"
  install -o root -g root -m 0600 /etc/iptables/rules.v6 "$previous_persisted_ipv6"
  persisted_ipv6_existed=true
fi

ipv4_rules="$(mktemp)"
ipv6_rules="$(mktemp)"
python3 - \
  "$previous_ipv4_rules" "$ipv4_rules" SETLIVRE_INPUT ipv4 \
  "$previous_ipv6_rules" "$ipv6_rules" SETLIVRE6_INPUT ipv6 <<'PYTHON'
import pathlib
import re
import sys

def rewrite(source, destination, chain, family):
    policy = [
        f"-A {chain} -i lo -j ACCEPT",
        f"-A {chain} -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT",
    ]
    if family == "ipv4":
        policy.extend(
            (
                f"-A {chain} -p udp --sport 67 --dport 68 -j ACCEPT",
                f"-A {chain} -p icmp --icmp-type fragmentation-needed -j ACCEPT",
            )
        )
    else:
        policy.append(f"-A {chain} -p ipv6-icmp -j ACCEPT")
    policy.extend(
        f"-A {chain} -p tcp --dport {port} -m conntrack --ctstate NEW -j ACCEPT"
        for port in (22, 80, 443)
    )
    policy.append(f"-A {chain} -j DROP")

    lines = pathlib.Path(source).read_text(encoding="utf-8").splitlines()
    result = []
    in_filter = False
    found_filter = False
    inserted = False
    for line in lines:
        if line == "*filter":
            in_filter = True
            found_filter = True
            inserted = False
            result.append(line)
            continue
        if in_filter and (
            line.startswith(f":{chain} ")
            or line == f"-A INPUT -j {chain}"
            or line.startswith(f"-A {chain} ")
        ):
            continue
        if in_filter and not inserted and (line.startswith("-A ") or line == "COMMIT"):
            result.extend((f":{chain} - [0:0]", f"-A INPUT -j {chain}", *policy))
            inserted = True
        result.append(line)
        if in_filter and line == "COMMIT":
            in_filter = False

    if not found_filter or in_filter:
        raise SystemExit("tabela filter ausente ou incompleta")
    normalized = [
        re.sub(r" \[[0-9]+:[0-9]+\]$", " [0:0]", line)
        for line in result
        if not re.fullmatch(r"# (Generated|Completed) .*", line)
    ]
    pathlib.Path(destination).write_text("\n".join(normalized) + "\n", encoding="utf-8")


arguments = sys.argv[1:]
if len(arguments) != 8:
    raise SystemExit("contrato interno inválido")
rewrite(*arguments[:4])
rewrite(*arguments[4:])
PYTHON
iptables-restore --test < "$ipv4_rules"
ip6tables-restore --test < "$ipv6_rules"

firewall_transition_active=true
iptables-restore < "$ipv4_rules"
ip6tables-restore < "$ipv6_rules"
iptables -w -C INPUT -j SETLIVRE_INPUT
ip6tables -w -C INPUT -j SETLIVRE6_INPUT

oracle_rules_after="$({
  iptables-save -t filter \
    | grep --extended-regexp '^:InstanceServices |^-A OUTPUT .* -j InstanceServices$|^-A InstanceServices '
} | sha256sum | cut -d ' ' -f 1)"
[[ ${oracle_rules_after} == "${oracle_rules_before}" ]] \
  || fail "as regras InstanceServices da Oracle foram alteradas."

install -o root -g root -m 0600 "$ipv4_rules" /etc/iptables/rules.v4
install -o root -g root -m 0600 "$ipv6_rules" /etc/iptables/rules.v6
systemctl enable netfilter-persistent fail2ban
systemctl restart fail2ban
fail2ban_ready=false
for _ in {1..15}; do
  if fail2ban-client ping >/dev/null 2>&1; then
    fail2ban_ready=true
    break
  fi
  sleep 1
done
[[ ${fail2ban_ready} == true ]] || fail "Fail2ban não ficou pronto."
fail2ban-client status sshd >/dev/null
fail2ban_stopped=false
firewall_transition_active=false

if [[ ! -f /swapfile ]]; then
  fallocate --length 1G /swapfile
  chmod 0600 /swapfile
  mkswap /swapfile
fi
if ! swapon --show=NAME --noheadings | grep --fixed-strings --line-regexp /swapfile >/dev/null; then
  swapon /swapfile
fi
if ! grep --fixed-strings --line-regexp '/swapfile none swap sw 0 0' /etc/fstab >/dev/null; then
  printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
fi

nginx -t
systemctl daemon-reload
systemctl enable nginx unattended-upgrades
systemctl restart nginx
systemctl enable set-livre-web.service set-livre-backoffice.service
if [[ -e /opt/set-livre/current ]]; then
  [[ -L /opt/set-livre/current \
    && -f /opt/set-livre/current/web/server.js \
    && -f /opt/set-livre/current/backoffice/apps/backoffice/server.js \
    && -f /opt/set-livre/current/.runtime/web.env \
    && -f /opt/set-livre/current/.runtime/backoffice.env \
    && -f /opt/set-livre/current/.runtime/release.env ]] \
    || fail "release ativa não atende ao contrato atômico vigente."
  systemctl restart set-livre-web.service set-livre-backoffice.service
else
  systemctl stop set-livre-web.service
  systemctl reset-failed set-livre-web.service || true
  systemctl stop set-livre-backoffice.service
  systemctl reset-failed set-livre-backoffice.service || true
fi
rm -f -- /etc/set-livre/web.env /etc/set-livre/backoffice.env /etc/set-livre/release.env
systemctl enable --now snap.certbot.renew.timer

digest_source="$(mktemp /etc/set-livre/.host-config.XXXXXX)"
printf '%s\n' "$host_configuration_digest" > "$digest_source"
chown root:setlivre "$digest_source"
chmod 0640 "$digest_source"
mv --force -- "$digest_source" /etc/set-livre/host-config.sha256
digest_source=""
rm -f -- /etc/set-livre/host-config.previous.sha256

printf 'Host preparado e contrato operacional publicado atomicamente.\n'
