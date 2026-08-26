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
fail2ban_stopped=false
digest_source=""

fail() {
  printf 'bootstrap: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  [[ -z ${temporary_directory} ]] || rm -rf -- "$temporary_directory"
  [[ -z ${ipv4_rules} ]] || rm -f -- "$ipv4_rules"
  [[ -z ${ipv6_rules} ]] || rm -f -- "$ipv6_rules"
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
  "${SCRIPT_DIRECTORY}/systemd/set-livre-backoffice.service"; do
  [[ -f ${required_source} && ! -L ${required_source} ]] || fail "fonte operacional ausente ou inválida."
done

deploy_key_file="$(realpath -e -- "$1")"
[[ -f ${deploy_key_file} && ! -L ${deploy_key_file} ]] || fail "a chave de deploy não é um arquivo regular."
IFS= read -r deploy_key < "$deploy_key_file"
[[ ${deploy_key} =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ .*)?$ ]] || fail "a chave de deploy não é Ed25519 válida."

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

if dpkg-query --show --showformat='${db:Status-Status}\n' ufw 2>/dev/null \
  | grep --quiet --line-regexp installed; then
  ufw --force disable || true
  apt-get purge --yes ufw
fi

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
install -d -o root -g root -m 0755 /var/www/set-livre-acme/.well-known/acme-challenge
install -o root -g root -m 0644 "${SUPABASE_CA_SOURCE}" /etc/set-livre/supabase-root-2021-ca.crt
install -d -o deploy-setlivre -g deploy-setlivre -m 0700 /home/deploy-setlivre/.ssh
install -d -o deploy-setlivre -g deploy-setlivre -m 0700 /home/deploy-setlivre/incoming
printf 'restrict,command="/usr/local/sbin/set-livre-deploy-ssh" %s\n' "$deploy_key" \
  > /home/deploy-setlivre/.ssh/authorized_keys
chown deploy-setlivre:deploy-setlivre /home/deploy-setlivre/.ssh/authorized_keys
chmod 0600 /home/deploy-setlivre/.ssh/authorized_keys

for environment_contract in web.env:setlivre-web backoffice.env:setlivre-backoffice release.env:setlivre; do
  environment_file="${environment_contract%%:*}"
  environment_group="${environment_contract#*:}"
  if [[ ! -e "/etc/set-livre/${environment_file}" ]]; then
    install -o root -g "$environment_group" -m 0640 /dev/null "/etc/set-livre/${environment_file}"
  fi
  chown root:"$environment_group" "/etc/set-livre/${environment_file}"
  chmod 0640 "/etc/set-livre/${environment_file}"
done

install -o root -g root -m 0755 "$DEPLOY_INSTALLER_SOURCE" /usr/local/sbin/set-livre-deploy
install -o root -g root -m 0755 "$DEPLOY_SSH_COMMAND_SOURCE" /usr/local/sbin/set-livre-deploy-ssh
install -o root -g root -m 0644 "${SCRIPT_DIRECTORY}/systemd/set-livre-web.service" /etc/systemd/system/set-livre-web.service
install -o root -g root -m 0644 "${SCRIPT_DIRECTORY}/systemd/set-livre-backoffice.service" /etc/systemd/system/set-livre-backoffice.service
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
digest_source="$(mktemp)"
printf '%s\n' "$host_configuration_digest" > "$digest_source"
install -o root -g setlivre -m 0640 "$digest_source" /etc/set-livre/host-config.sha256
rm -f -- "$digest_source"
digest_source=""
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
# metadata traffic. Mutate only a dedicated INPUT chain and persist the complete resulting ruleset.
iptables -w -S InstanceServices >/dev/null 2>&1 || fail "chain InstanceServices da Oracle ausente."
iptables-save -t filter | grep --extended-regexp '^-A OUTPUT .* -j InstanceServices$' >/dev/null \
  || fail "salto OUTPUT para InstanceServices ausente."
oracle_rules_before="$({
  iptables-save -t filter \
    | grep --extended-regexp '^:InstanceServices |^-A OUTPUT .* -j InstanceServices$|^-A InstanceServices '
} | sha256sum | cut -d ' ' -f 1)"

systemctl stop fail2ban || true
fail2ban_stopped=true
while iptables -w -C INPUT -j SETLIVRE_INPUT 2>/dev/null; do
  iptables -w -D INPUT -j SETLIVRE_INPUT
done
if iptables -w -S SETLIVRE_INPUT >/dev/null 2>&1; then
  iptables -w -F SETLIVRE_INPUT
else
  iptables -w -N SETLIVRE_INPUT
fi
iptables -w -I INPUT 1 -j SETLIVRE_INPUT
iptables -w -A SETLIVRE_INPUT -i lo -j ACCEPT
iptables -w -A SETLIVRE_INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
iptables -w -A SETLIVRE_INPUT -p udp --sport 67 --dport 68 -j ACCEPT
iptables -w -A SETLIVRE_INPUT -p icmp --icmp-type fragmentation-needed -j ACCEPT
iptables -w -A SETLIVRE_INPUT -p tcp --dport 22 -m conntrack --ctstate NEW -j ACCEPT
iptables -w -A SETLIVRE_INPUT -p tcp --dport 80 -m conntrack --ctstate NEW -j ACCEPT
iptables -w -A SETLIVRE_INPUT -p tcp --dport 443 -m conntrack --ctstate NEW -j ACCEPT
iptables -w -A SETLIVRE_INPUT -j DROP

while ip6tables -w -C INPUT -j SETLIVRE6_INPUT 2>/dev/null; do
  ip6tables -w -D INPUT -j SETLIVRE6_INPUT
done
if ip6tables -w -S SETLIVRE6_INPUT >/dev/null 2>&1; then
  ip6tables -w -F SETLIVRE6_INPUT
else
  ip6tables -w -N SETLIVRE6_INPUT
fi
ip6tables -w -I INPUT 1 -j SETLIVRE6_INPUT
ip6tables -w -A SETLIVRE6_INPUT -i lo -j ACCEPT
ip6tables -w -A SETLIVRE6_INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
ip6tables -w -A SETLIVRE6_INPUT -p ipv6-icmp -j ACCEPT
ip6tables -w -A SETLIVRE6_INPUT -p tcp --dport 22 -m conntrack --ctstate NEW -j ACCEPT
ip6tables -w -A SETLIVRE6_INPUT -p tcp --dport 80 -m conntrack --ctstate NEW -j ACCEPT
ip6tables -w -A SETLIVRE6_INPUT -p tcp --dport 443 -m conntrack --ctstate NEW -j ACCEPT
ip6tables -w -A SETLIVRE6_INPUT -j DROP

oracle_rules_after="$({
  iptables-save -t filter \
    | grep --extended-regexp '^:InstanceServices |^-A OUTPUT .* -j InstanceServices$|^-A InstanceServices '
} | sha256sum | cut -d ' ' -f 1)"
[[ ${oracle_rules_after} == "${oracle_rules_before}" ]] \
  || fail "as regras InstanceServices da Oracle foram alteradas."

ipv4_rules="$(mktemp)"
ipv6_rules="$(mktemp)"
iptables-save \
  | sed --regexp-extended \
    --expression='/^# (Generated|Completed) /d' \
    --expression='s/ \[[0-9]+:[0-9]+\]$/ [0:0]/' \
  > "$ipv4_rules"
ip6tables-save \
  | sed --regexp-extended \
    --expression='/^# (Generated|Completed) /d' \
    --expression='s/ \[[0-9]+:[0-9]+\]$/ [0:0]/' \
  > "$ipv6_rules"
iptables-restore --test < "$ipv4_rules"
ip6tables-restore --test < "$ipv6_rules"
install -o root -g root -m 0600 "$ipv4_rules" /etc/iptables/rules.v4
install -o root -g root -m 0600 "$ipv6_rules" /etc/iptables/rules.v6
iptables-restore < "$ipv4_rules"
ip6tables-restore < "$ipv6_rules"
iptables -w -C INPUT -j SETLIVRE_INPUT
ip6tables -w -C INPUT -j SETLIVRE6_INPUT
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
fail2ban_stopped=false
fail2ban-client status sshd >/dev/null

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
systemctl enable --now snap.certbot.renew.timer

printf 'Host preparado. Configure /etc/set-livre/*.env antes do primeiro deploy.\n'
