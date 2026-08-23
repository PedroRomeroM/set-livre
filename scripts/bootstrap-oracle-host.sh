#!/usr/bin/env bash

set -euo pipefail
umask 077
IFS=$' \t\n'
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
unset BASH_ENV CDPATH CURL_HOME ENV GLOBIGNORE GREP_OPTIONS PYTHONHOME PYTHONPATH TAR_OPTIONS

readonly node_version=24.18.0
readonly node_archive_root="node-v${node_version}-linux-x64"
readonly node_archive="node-v${node_version}-linux-x64.tar.xz"
readonly node_archive_sha256=55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742
readonly node_binary_sha256=41a74efb34cbde5c7632cdac0cf8bd1a14d0b8d73dc1e82755014d9a9ce70f5c
readonly node_parent=/opt
readonly node_root="$node_parent/node-v${node_version}"
readonly supabase_cli_version=2.115.0
readonly supabase_cli_archive="supabase_${supabase_cli_version}_linux_amd64.tar.gz"
readonly supabase_cli_archive_url=https://github.com/supabase/cli/releases/download/v2.115.0/supabase_2.115.0_linux_amd64.tar.gz
readonly supabase_cli_archive_sha256=ff099608ce758b625532ef03a61f4c9520b995e94ff6cd5480dc0428cad64cb3
readonly supabase_cli_sha256=5986d84e4c7e251126f7579c686b302b3527bc4b2ac1517963930eb0780d3867
readonly supabase_go_sha256=c507c71c331ee9b4dd87b6ec6cc8a6e4f312a642ff0f9e44931129053c534eef
readonly host_tools_root=/usr/local/libexec/setlivre-host-tools
readonly supabase_tools_directory="$host_tools_root/$supabase_cli_version"
readonly supabase_cli_path="$supabase_tools_directory/supabase"
readonly supabase_go_path="$supabase_tools_directory/supabase-go"
readonly tls_enable_path=/usr/local/sbin/setlivre-enable-tls
readonly tls_issue_path=/usr/local/sbin/setlivre-issue-tls-certificate
readonly tls_renewal_hook=/etc/letsencrypt/renewal-hooks/deploy/setlivre-enable-tls
readonly runtime_user=setlivre
readonly runtime_group=setlivre
readonly runtime_home=/nonexistent
readonly bootstrap_state_directory=/var/lib/setlivre-bootstrap
readonly bootstrap_sentinel="$bootstrap_state_directory/state"
readonly ipv6_sysctl_path=/etc/sysctl.d/60-setlivre-ipv6-disabled.conf
readonly e2_micro_nominal_memory_mib=1024
readonly e2_micro_minimum_memtotal_mib=912
readonly e2_micro_maximum_memtotal_mib=1100
readonly minimum_host_memory_reserve_mib=320
readonly web_memory_high_mib=176
readonly web_memory_max_mib=240
readonly web_memory_swap_max_mib=128
readonly web_node_old_space_mib=128
readonly backoffice_memory_high_mib=112
readonly backoffice_memory_max_mib=160
readonly backoffice_memory_swap_max_mib=96
readonly backoffice_node_old_space_mib=96
readonly deployer_memory_high_mib=128
readonly deployer_memory_max_mib=192
readonly deployer_memory_swap_max_mib=128
readonly recovery_service=setlivre-release-recovery.service
readonly supabase_server_ca=/etc/setlivre-deployer/credentials/supabase-server-ca.pem

fail() {
  printf '%s\n' "Set Livre Oracle host bootstrap rejected the operation." >&2
  exit 1
}

assert_sha256() {
  [[ "$1" =~ ^[0-9a-f]{64}$ ]] || fail
}

file_sha256() {
  local path="$1"
  local output
  local digest
  output="$(sha256sum -- "$path")" || fail
  digest="${output%% *}"
  assert_sha256 "$digest"
  printf '%s\n' "$digest"
}

assert_root_tool_directory() {
  local path="$1"
  [[ -d "$path" && ! -L "$path" ]] || fail
  [[ "$(readlink --canonicalize-existing -- "$path")" == "$path" ]] || fail
  [[ "$(stat -c '%U:%G:%a' -- "$path")" == root:root:755 ]] || fail
}

assert_linux_x64_elf() {
  python3 - "$@" <<'HOST_TOOL_ELF_PY'
import os
import struct
import sys

if not sys.argv[1:]:
    raise SystemExit(1)
for path in sys.argv[1:]:
    information = os.stat(path, follow_symlinks=False)
    if information.st_nlink != 1 or information.st_size <= 0 or information.st_size > 256 * 1024 * 1024:
        raise SystemExit(1)
    with open(path, "rb") as source:
        header = source.read(20)
    if len(header) != 20 or header[:6] != b"\x7fELF\x02\x01":
        raise SystemExit(1)
    if struct.unpack("<H", header[18:20])[0] != 62:
        raise SystemExit(1)
HOST_TOOL_ELF_PY
}

assert_installed_supabase_cli() {
  local directory
  for directory in \
    /usr /usr/local /usr/local/libexec "$host_tools_root" "$supabase_tools_directory"; do
    assert_root_tool_directory "$directory"
  done
  local path
  for path in "$supabase_cli_path" "$supabase_go_path"; do
    [[ -f "$path" && ! -L "$path" ]] || fail
    [[ "$(readlink --canonicalize-existing -- "$path")" == "$path" ]] || fail
    [[ "$(stat -c '%U:%G:%a:%h' -- "$path")" == root:root:755:1 ]] || fail
  done
  [[ "$(file_sha256 "$supabase_cli_path")" == "$supabase_cli_sha256" ]] || fail
  [[ "$(file_sha256 "$supabase_go_path")" == "$supabase_go_sha256" ]] || fail
  assert_linux_x64_elf "$supabase_cli_path" "$supabase_go_path"
  local version
  version="$(env -i \
    HOME=/nonexistent \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    "$supabase_cli_path" --version)" || fail
  [[ "$version" == "$supabase_cli_version" ]] || fail
}

install_supabase_cli() {
  local archive="$temporary_root/$supabase_cli_archive"
  local extracted="$temporary_root/supabase-cli-extracted"
  curl \
    --disable \
    --fail \
    --silent \
    --show-error \
    --location \
    --proto '=https' \
    --proto-redir '=https' \
    --tlsv1.2 \
    --connect-timeout 10 \
    --max-time 300 \
    --retry 0 \
    --output "$archive" \
    "$supabase_cli_archive_url"
  [[ "$(file_sha256 "$archive")" == "$supabase_cli_archive_sha256" ]] || fail
  python3 - "$archive" <<'SUPABASE_ARCHIVE_PY'
import sys
import tarfile

expected = {"supabase", "supabase-go"}
try:
    with tarfile.open(sys.argv[1], mode="r:gz") as archive:
        members = archive.getmembers()
except (OSError, tarfile.TarError):
    raise SystemExit(1)
if len(members) != len(expected) or {member.name for member in members} != expected:
    raise SystemExit(1)
for member in members:
    if not member.isfile() or member.size <= 0 or member.size > 256 * 1024 * 1024:
        raise SystemExit(1)
SUPABASE_ARCHIVE_PY
  install -d -o root -g root -m 0700 -- "$extracted"
  tar \
    --extract \
    --gzip \
    --file "$archive" \
    --directory "$extracted" \
    --no-same-owner \
    --no-same-permissions \
    -- supabase supabase-go
  local extracted_cli="$extracted/supabase"
  local extracted_go="$extracted/supabase-go"
  [[ -f "$extracted_cli" && ! -L "$extracted_cli" ]] || fail
  [[ -f "$extracted_go" && ! -L "$extracted_go" ]] || fail
  chmod 0700 -- "$extracted_cli" "$extracted_go"
  [[ "$(file_sha256 "$extracted_cli")" == "$supabase_cli_sha256" ]] || fail
  [[ "$(file_sha256 "$extracted_go")" == "$supabase_go_sha256" ]] || fail
  assert_linux_x64_elf "$extracted_cli" "$extracted_go"
  [[ "$(env -i \
    HOME=/nonexistent \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    "$extracted_cli" --version)" == "$supabase_cli_version" ]] || fail

  assert_root_tool_directory /usr
  assert_root_tool_directory /usr/local
  if [[ ! -e /usr/local/libexec && ! -L /usr/local/libexec ]]; then
    install -d -o root -g root -m 0755 -- /usr/local/libexec
  fi
  assert_root_tool_directory /usr/local/libexec
  if [[ ! -e "$host_tools_root" && ! -L "$host_tools_root" ]]; then
    install -d -o root -g root -m 0755 -- "$host_tools_root"
  fi
  assert_root_tool_directory "$host_tools_root"
  [[ ! -e "$supabase_tools_directory" && ! -L "$supabase_tools_directory" ]] || fail
  local candidate="$host_tools_root/.${supabase_cli_version}.setlivre-installing"
  [[ ! -e "$candidate" && ! -L "$candidate" ]] || fail
  install -d -o root -g root -m 0700 -- "$candidate"
  install -o root -g root -m 0755 -- "$extracted_cli" "$candidate/supabase"
  install -o root -g root -m 0755 -- "$extracted_go" "$candidate/supabase-go"
  [[ "$(file_sha256 "$candidate/supabase")" == "$supabase_cli_sha256" ]] || fail
  [[ "$(file_sha256 "$candidate/supabase-go")" == "$supabase_go_sha256" ]] || fail
  assert_linux_x64_elf "$candidate/supabase" "$candidate/supabase-go"
  sync -- "$candidate/supabase" "$candidate/supabase-go"
  chmod 0755 -- "$candidate"
  [[ "$(stat -c '%U:%G:%a' -- "$candidate")" == root:root:755 ]] || fail
  mv --no-target-directory -- "$candidate" "$supabase_tools_directory"
  sync -- "$host_tools_root"
  assert_installed_supabase_cli
}

verify_node_distribution() {
  local operation="$1"
  local archive="$2"
  local tree="$3"
  python3 - "$operation" "$archive" "$tree" "$node_version" "$node_binary_sha256" <<'NODE_TREE_PY'
import hashlib
import os
import posixpath
import stat
import sys
import tarfile
from pathlib import PurePosixPath

operation, archive_path, tree_path, version, expected_node_sha256 = sys.argv[1:]
if operation not in {"archive", "normalize", "verify"}:
    raise SystemExit(1)

root_name = f"node-v{version}-linux-x64"
node_name = f"{root_name}/bin/node"
expected_links = {
    f"{root_name}/bin/corepack": "../lib/node_modules/corepack/dist/corepack.js",
    f"{root_name}/bin/npm": "../lib/node_modules/npm/bin/npm-cli.js",
    f"{root_name}/bin/npx": "../lib/node_modules/npm/bin/npx-cli.js",
}


def reject() -> None:
    raise SystemExit(1)


def member_name(member: tarfile.TarInfo) -> str:
    name = member.name[:-1] if member.isdir() and member.name.endswith("/") else member.name
    path = PurePosixPath(name)
    if (
        not name
        or name.startswith("/")
        or str(path) != name
        or any(part in {"", ".", ".."} for part in path.parts)
        or path.parts[0] != root_name
    ):
        reject()
    return name


try:
    archive = tarfile.open(archive_path, mode="r:xz")
except (OSError, tarfile.TarError):
    reject()

with archive:
    members: dict[str, tarfile.TarInfo] = {}
    total_size = 0
    try:
        archive_members = archive.getmembers()
    except (OSError, tarfile.TarError):
        reject()
    if not 1 <= len(archive_members) <= 10_000:
        reject()

    for member in archive_members:
        name = member_name(member)
        if (
            name in members
            or member.islnk()
            or not (member.isdir() or member.isfile() or member.issym())
        ):
            reject()
        if member.mode & 0o7000:
            reject()
        if member.isfile():
            if member.size < 0 or member.size > 256 * 1024 * 1024:
                reject()
            total_size += member.size
        elif member.issym():
            target = member.linkname
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), target))
            if (
                not target
                or target.startswith("/")
                or (
                    resolved != root_name
                    and not resolved.startswith(f"{root_name}/")
                )
            ):
                reject()
        members[name] = member

    if total_size > 512 * 1024 * 1024:
        reject()
    if root_name not in members or not members[root_name].isdir():
        reject()
    if node_name not in members or not members[node_name].isfile():
        reject()
    if not members[node_name].mode & 0o111:
        reject()
    actual_links = {name: member.linkname for name, member in members.items() if member.issym()}
    if actual_links != expected_links:
        reject()
    for name, target in expected_links.items():
        resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), target))
        if resolved not in members or not members[resolved].isfile():
            reject()

    expected_hashes: dict[str, str] = {}
    for name, member in members.items():
        if not member.isfile():
            continue
        try:
            source = archive.extractfile(member)
        except (OSError, tarfile.TarError):
            reject()
        if source is None:
            reject()
        digest = hashlib.sha256()
        with source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
        expected_hashes[name] = digest.hexdigest()
    if expected_hashes.get(node_name) != expected_node_sha256:
        reject()

    if operation == "archive":
        raise SystemExit(0)

    try:
        tree = os.path.abspath(tree_path)
        tree_information = os.lstat(tree)
    except OSError:
        reject()
    if os.path.basename(tree) != root_name or not stat.S_ISDIR(tree_information.st_mode):
        reject()

    actual: dict[str, tuple[str, os.stat_result]] = {}
    pending = [(root_name, tree)]
    while pending:
        relative_name, path = pending.pop()
        try:
            information = os.lstat(path)
        except OSError:
            reject()
        actual[relative_name] = (path, information)
        if stat.S_ISDIR(information.st_mode):
            try:
                with os.scandir(path) as entries:
                    children = list(entries)
            except OSError:
                reject()
            for entry in children:
                pending.append((f"{relative_name}/{entry.name}", entry.path))

    if actual.keys() != members.keys():
        reject()

    def read_digest(path: str) -> str:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(path, flags)
        except OSError:
            reject()
        try:
            information = os.fstat(descriptor)
            if not stat.S_ISREG(information.st_mode) or information.st_nlink != 1:
                reject()
            digest = hashlib.sha256()
            while chunk := os.read(descriptor, 1024 * 1024):
                digest.update(chunk)
            return digest.hexdigest()
        finally:
            os.close(descriptor)

    for name, member in members.items():
        path, information = actual[name]
        if member.isdir():
            if not stat.S_ISDIR(information.st_mode):
                reject()
        elif member.isfile():
            if (
                not stat.S_ISREG(information.st_mode)
                or information.st_nlink != 1
                or information.st_size != member.size
                or read_digest(path) != expected_hashes[name]
            ):
                reject()
        else:
            if not stat.S_ISLNK(information.st_mode):
                reject()
            try:
                target = os.readlink(path)
            except OSError:
                reject()
            if target != member.linkname:
                reject()

    if operation == "normalize":
        if os.geteuid() != 0:
            reject()
        for name, member in members.items():
            path, _ = actual[name]
            try:
                os.chown(path, 0, 0, follow_symlinks=False)
                if member.isdir():
                    os.chmod(path, 0o755, follow_symlinks=False)
                elif member.isfile():
                    mode = 0o755 if member.mode & 0o111 else 0o644
                    os.chmod(path, mode, follow_symlinks=False)
            except OSError:
                reject()

    for name, member in members.items():
        path, _ = actual[name]
        try:
            information = os.lstat(path)
        except OSError:
            reject()
        if information.st_uid != 0 or information.st_gid != 0:
            reject()
        if member.isdir() and stat.S_IMODE(information.st_mode) != 0o755:
            reject()
        if member.isfile():
            expected_mode = 0o755 if member.mode & 0o111 else 0o644
            if stat.S_IMODE(information.st_mode) != expected_mode:
                reject()

    if operation == "normalize":
        for name, member in members.items():
            if not member.isfile():
                continue
            path, _ = actual[name]
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            try:
                descriptor = os.open(path, flags)
            except OSError:
                reject()
            try:
                os.fsync(descriptor)
            except OSError:
                reject()
            finally:
                os.close(descriptor)
        directories = [name for name, member in members.items() if member.isdir()]
        for name in sorted(directories, key=lambda value: value.count("/"), reverse=True):
            path, _ = actual[name]
            flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
            try:
                descriptor = os.open(path, flags)
            except OSError:
                reject()
            try:
                os.fsync(descriptor)
            except OSError:
                reject()
            finally:
                os.close(descriptor)
NODE_TREE_PY
}

assert_node_tree_matches_archive() {
  verify_node_distribution verify "$1" "$2"
}

publish_or_reuse_node_tree() {
  local archive="$1"
  local candidate="$2"
  if [[ -e "$node_root" || -L "$node_root" ]]; then
    [[ -d "$node_root" && ! -L "$node_root" ]] || fail
    assert_node_tree_matches_archive "$archive" "$node_root" || fail
    return
  fi

  assert_node_tree_matches_archive "$archive" "$candidate" || fail
  sync -- "$candidate"
  mv --no-target-directory -- "$candidate" "$node_root"
  rmdir -- "$node_install_staging"
  node_install_staging=""
  sync -- "$node_parent"
  assert_node_tree_matches_archive "$archive" "$node_root" || fail
}

assert_installed_node_runtime() {
  local archive="$1"
  assert_node_tree_matches_archive "$archive" "$node_root" || fail
  [[ "$(file_sha256 "$node_root/bin/node")" == "$node_binary_sha256" ]] || fail
  assert_linux_x64_elf "$node_root/bin/node"
  local version
  version="$(env -i \
    HOME=/nonexistent \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    "$node_root/bin/node" --version)" || fail
  [[ "$version" == "v${node_version}" ]] || fail
}

install_node_runtime() {
  local archive="$temporary_root/$node_archive"
  if [[ -e "$node_root" || -L "$node_root" ]]; then
    [[ -d "$node_root" && ! -L "$node_root" ]] || fail
  fi
  curl \
    --disable \
    --fail \
    --silent \
    --show-error \
    --location \
    --proto '=https' \
    --proto-redir '=https' \
    --tlsv1.2 \
    --connect-timeout 10 \
    --max-time 300 \
    --retry 0 \
    --output "$archive" \
    "https://nodejs.org/dist/v${node_version}/${node_archive}"
  [[ "$(file_sha256 "$archive")" == "$node_archive_sha256" ]] || fail
  verify_node_distribution archive "$archive" -

  assert_root_tool_directory "$node_parent"
  node_install_staging="$(mktemp \
    --directory \
    --tmpdir="$node_parent" \
    ".node-v${node_version}.setlivre.XXXXXXXX")"
  [[ -d "$node_install_staging" && ! -L "$node_install_staging" ]] || fail
  [[ "$(stat -c '%U:%G:%a:%h' -- "$node_install_staging")" == root:root:700:1 ]] || fail
  tar \
    --extract \
    --xz \
    --file "$archive" \
    --directory "$node_install_staging" \
    --no-same-owner \
    --no-same-permissions \
    -- "$node_archive_root"
  local candidate="$node_install_staging/$node_archive_root"
  [[ -d "$candidate" && ! -L "$candidate" ]] || fail
  verify_node_distribution normalize "$archive" "$candidate"
  publish_or_reuse_node_tree "$archive" "$candidate"
  assert_installed_node_runtime "$archive"

  local executable
  for executable in node npm npx corepack; do
    local link="/usr/local/bin/$executable"
    local target="$node_root/bin/$executable"
    if [[ -e "$link" || -L "$link" ]]; then
      [[ -L "$link" && "$(readlink -- "$link")" == "$target" ]] || fail
      continue
    fi
    local link_candidate="/usr/local/bin/.${executable}.setlivre-installing"
    [[ ! -e "$link_candidate" && ! -L "$link_candidate" ]] || fail
    ln --symbolic -- "$target" "$link_candidate"
    mv --no-target-directory -- "$link_candidate" "$link"
    sync -- /usr/local/bin
    [[ -L "$link" && "$(readlink -- "$link")" == "$target" ]] || fail
  done
}

assert_e2_micro_memory_budget() {
  local memtotal_kib
  local memtotal_mib
  local managed_memory_high_mib
  local managed_memory_max_mib
  local managed_memory_swap_max_mib
  memtotal_kib="$(awk '$1 == "MemTotal:" && NF == 3 && $3 == "kB" { print $2 }' /proc/meminfo)" || fail
  [[ "$memtotal_kib" =~ ^[1-9][0-9]*$ ]] || fail
  memtotal_mib=$((memtotal_kib / 1024))
  ((memtotal_mib >= e2_micro_minimum_memtotal_mib)) || fail
  ((memtotal_mib <= e2_micro_maximum_memtotal_mib)) || fail

  ((web_node_old_space_mib < web_memory_high_mib)) || fail
  ((backoffice_node_old_space_mib < backoffice_memory_high_mib)) || fail
  ((web_memory_high_mib < web_memory_max_mib)) || fail
  ((backoffice_memory_high_mib < backoffice_memory_max_mib)) || fail
  ((deployer_memory_high_mib < deployer_memory_max_mib)) || fail
  managed_memory_high_mib=$((
    web_memory_high_mib + backoffice_memory_high_mib + deployer_memory_high_mib
  ))
  managed_memory_max_mib=$((
    web_memory_max_mib + backoffice_memory_max_mib + deployer_memory_max_mib
  ))
  managed_memory_swap_max_mib=$((
    web_memory_swap_max_mib + backoffice_memory_swap_max_mib + deployer_memory_swap_max_mib
  ))
  ((managed_memory_high_mib < managed_memory_max_mib)) || fail
  ((managed_memory_max_mib + minimum_host_memory_reserve_mib <= memtotal_mib)) || fail
  ((managed_memory_max_mib < e2_micro_nominal_memory_mib)) || fail
  ((managed_memory_swap_max_mib <= 512)) || fail
}

assert_ipv6_disabled() {
  [[ -f "$ipv6_sysctl_path" && ! -L "$ipv6_sysctl_path" ]] || fail
  [[ "$(readlink --canonicalize-existing -- "$ipv6_sysctl_path")" == \
    "$ipv6_sysctl_path" ]] || fail
  [[ "$(stat -c '%U:%G:%a:%h' -- "$ipv6_sysctl_path")" == root:root:644:1 ]] || fail
  [[ "$(</proc/sys/net/ipv6/conf/all/disable_ipv6)" == 1 ]] || fail
  [[ "$(</proc/sys/net/ipv6/conf/default/disable_ipv6)" == 1 ]] || fail
  [[ "$(</proc/sys/net/ipv6/conf/lo/disable_ipv6)" == 1 ]] || fail
}

configure_ipv6_disabled() {
  local candidate="$temporary_root/60-setlivre-ipv6-disabled.conf"
  [[ ! -e "$ipv6_sysctl_path" && ! -L "$ipv6_sysctl_path" ]] || fail
  cat >"$candidate" <<'SYSCTL'
net.ipv6.conf.all.disable_ipv6 = 1
net.ipv6.conf.default.disable_ipv6 = 1
net.ipv6.conf.lo.disable_ipv6 = 1
SYSCTL
  install -o root -g root -m 0644 -- "$candidate" "$ipv6_sysctl_path"
  sync -- "$ipv6_sysctl_path"
  sysctl --load="$ipv6_sysctl_path" >/dev/null
  assert_ipv6_disabled
}

assert_service_memory_contract() {
  local unit_name="$1"
  local memory_high_mib="$2"
  local memory_max_mib="$3"
  local memory_swap_max_mib="$4"
  [[ "$(systemctl show -p MemoryAccounting --value "$unit_name")" == yes ]] || fail
  [[ "$(systemctl show -p MemoryHigh --value "$unit_name")" \
    == "$((memory_high_mib * 1024 * 1024))" ]] || fail
  [[ "$(systemctl show -p MemoryMax --value "$unit_name")" \
    == "$((memory_max_mib * 1024 * 1024))" ]] || fail
  [[ "$(systemctl show -p MemorySwapMax --value "$unit_name")" \
    == "$((memory_swap_max_mib * 1024 * 1024))" ]] || fail
  [[ "$(systemctl show -p OOMPolicy --value "$unit_name")" == kill ]] || fail
}

assert_bootstrap_sentinel() {
  local expected_state="$1"
  [[ -f "$bootstrap_sentinel" && ! -L "$bootstrap_sentinel" ]] || fail
  [[ "$(readlink --canonicalize-existing -- "$bootstrap_sentinel")" == \
    "$bootstrap_sentinel" ]] || fail
  [[ "$(stat -c '%U:%G:%a:%h' -- "$bootstrap_sentinel")" == root:root:600:1 ]] || fail
  [[ "$(<"$bootstrap_sentinel")" == "$expected_state" ]] || fail
}

claim_bootstrap() {
  local candidate="$temporary_root/bootstrap.state"
  [[ ! -e "$bootstrap_state_directory" && ! -L "$bootstrap_state_directory" ]] || fail
  mkdir --mode=0700 -- "$bootstrap_state_directory"
  [[ -d "$bootstrap_state_directory" && ! -L "$bootstrap_state_directory" ]] || fail
  [[ "$(readlink --canonicalize-existing -- "$bootstrap_state_directory")" == \
    "$bootstrap_state_directory" ]] || fail
  [[ "$(stat -c '%U:%G:%a' -- "$bootstrap_state_directory")" == root:root:700 ]] || fail
  printf '%s\n' in-progress >"$candidate"
  install -o root -g root -m 0600 -- "$candidate" "$bootstrap_sentinel"
  sync -- "$bootstrap_sentinel"
  assert_bootstrap_sentinel in-progress
}

complete_bootstrap() {
  local candidate="$temporary_root/bootstrap.completed"
  local replacement="$bootstrap_state_directory/.state.setlivre-installing"
  assert_bootstrap_sentinel in-progress
  [[ ! -e "$replacement" && ! -L "$replacement" ]] || fail
  printf '%s\n' completed >"$candidate"
  install -o root -g root -m 0600 -- "$candidate" "$replacement"
  [[ "$(stat -c '%U:%G:%a:%h' -- "$replacement")" == root:root:600:1 ]] || fail
  sync -- "$replacement"
  mv --no-target-directory -- "$replacement" "$bootstrap_sentinel"
  sync -- "$bootstrap_sentinel"
  assert_bootstrap_sentinel completed
}

assert_runtime_identity() {
  local group_snapshot="$temporary_root/runtime.group"
  local passwd_snapshot="$temporary_root/runtime.passwd"
  local target_passwd_snapshot="$temporary_root/runtime.target-passwd"
  getent group "$runtime_group" >"$group_snapshot" || fail
  getent passwd >"$passwd_snapshot" || fail
  getent passwd "$runtime_user" >"$target_passwd_snapshot" || fail
  chmod 0600 "$group_snapshot" "$passwd_snapshot" "$target_passwd_snapshot"
  "$node_root/bin/node" - \
    "$group_snapshot" "$passwd_snapshot" "$target_passwd_snapshot" \
    "$runtime_group" "$runtime_user" "$runtime_home" <<'RUNTIME_IDENTITY_NODE'
const fs = require("node:fs");

const [groupPath, passwdPath, targetPath, expectedGroup, expectedUser, expectedHome] =
  process.argv.slice(2);
const groupLines = fs.readFileSync(groupPath, "utf8").trimEnd().split("\n");
const targetLines = fs.readFileSync(targetPath, "utf8").trimEnd().split("\n");
if (groupLines.length !== 1 || targetLines.length !== 1) {
  process.exit(1);
}

const groupFields = groupLines[0].split(":");
const passwdFields = targetLines[0].split(":");
if (groupFields.length !== 4 || passwdFields.length !== 7) {
  process.exit(1);
}
if (groupFields[0] !== expectedGroup || passwdFields[0] !== expectedUser) {
  process.exit(1);
}
if (
  !/^\d+$/.test(groupFields[2]) ||
  !/^\d+$/.test(passwdFields[2]) ||
  !/^\d+$/.test(passwdFields[3])
) {
  process.exit(1);
}

const gid = Number(groupFields[2]);
const uid = Number(passwdFields[2]);
if (
  uid <= 0 ||
  uid >= 1000 ||
  gid <= 0 ||
  gid >= 1000 ||
  passwdFields[3] !== groupFields[2] ||
  passwdFields[5] !== expectedHome ||
  passwdFields[6] !== "/usr/sbin/nologin" ||
  groupFields[3] !== ""
) {
  process.exit(1);
}

const effectiveMembers = [];
for (const line of fs.readFileSync(passwdPath, "utf8").trimEnd().split("\n")) {
  const fields = line.split(":");
  if (fields.length !== 7 || !/^\d+$/.test(fields[3])) {
    process.exit(1);
  }
  if (fields[3] === groupFields[2]) {
    effectiveMembers.push(fields[0]);
  }
}
if (effectiveMembers.length !== 1 || effectiveMembers[0] !== expectedUser) {
  process.exit(1);
}
RUNTIME_IDENTITY_NODE
  [[ "$(id -Gn "$runtime_user")" == "$runtime_group" ]] || fail
  [[ "$(id -G "$runtime_user")" == "$(getent group "$runtime_group" | cut -d: -f3)" ]] || fail
  [[ "$(passwd --status "$runtime_user" | awk '{print $2}')" == L ]] || fail
}

extract_oracle_essential_firewall_rules() {
  local source_path="$1"
  local destination_path="$2"
  grep -Eq '169[.]254[.]0[.]2(/32)?' "$source_path" || fail
  grep -Fq '169.254.2.0/24' "$source_path" || fail
  grep -q -- '--dport 3260' "$source_path" || fail
  grep -E '169[.]254[.]0[.]2(/32)?|169[.]254[.]2[.]0/24' "$source_path" |
    LC_ALL=C sort >"$destination_path"
  [[ -s "$destination_path" ]] || fail
}

configure_host_firewall() {
  local rules_before_packages="$1"
  local rules_after_packages="$temporary_root/iptables.after-packages"
  local rules_after_configuration="$temporary_root/iptables.after-configuration"
  local essential_before="$temporary_root/oracle-essential.before"
  local essential_after_packages="$temporary_root/oracle-essential.after-packages"
  local essential_after_configuration="$temporary_root/oracle-essential.after-configuration"

  iptables-save >"$rules_after_packages"
  extract_oracle_essential_firewall_rules "$rules_before_packages" "$essential_before"
  extract_oracle_essential_firewall_rules "$rules_after_packages" "$essential_after_packages"
  cmp --silent -- "$essential_before" "$essential_after_packages" || fail

  ! iptables -w -S SETLIVRE_INPUT >/dev/null 2>&1 || fail
  iptables -w -N SETLIVRE_INPUT
  iptables -w -A SETLIVRE_INPUT -i lo -j ACCEPT
  iptables -w -A SETLIVRE_INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  iptables -w -A SETLIVRE_INPUT -p udp --sport 67 --dport 68 -j ACCEPT
  iptables -w -A SETLIVRE_INPUT -p icmp --icmp-type 3/4 -j ACCEPT
  iptables -w -A SETLIVRE_INPUT -p tcp -s "$administrative_cidr" --dport 22 \
    -m conntrack --ctstate NEW -j ACCEPT
  iptables -w -A SETLIVRE_INPUT -p tcp --dport 80 -m conntrack --ctstate NEW -j ACCEPT
  iptables -w -A SETLIVRE_INPUT -p tcp --dport 443 -m conntrack --ctstate NEW -j ACCEPT
  iptables -w -A SETLIVRE_INPUT -j DROP
  iptables -w -I INPUT 1 -j SETLIVRE_INPUT

  iptables-save >"$rules_after_configuration"
  extract_oracle_essential_firewall_rules \
    "$rules_after_configuration" "$essential_after_configuration"
  cmp --silent -- "$essential_before" "$essential_after_configuration" || fail
  [[ "$(grep -Fxc -- '-A INPUT -j SETLIVRE_INPUT' "$rules_after_configuration")" -eq 1 ]] || fail
  [[ "$(grep -Fxc -- '-A SETLIVRE_INPUT -j DROP' "$rules_after_configuration")" -eq 1 ]] || fail
  [[ "$(grep -Fxc -- "-A SETLIVRE_INPUT -s ${administrative_cidr%/*}/32 -p tcp -m tcp --dport 22 -m conntrack --ctstate NEW -j ACCEPT" "$rules_after_configuration")" -eq 1 ]] || fail

  netfilter-persistent save >/dev/null
  [[ -f /etc/iptables/rules.v4 && ! -L /etc/iptables/rules.v4 ]] || fail
  chown root:root /etc/iptables/rules.v4
  chmod 0600 /etc/iptables/rules.v4
  [[ "$(stat -c '%U:%G:%a:%h' -- /etc/iptables/rules.v4)" == root:root:600:1 ]] || fail
  extract_oracle_essential_firewall_rules \
    /etc/iptables/rules.v4 "$temporary_root/oracle-essential.persisted"
  cmp --silent -- "$essential_before" "$temporary_root/oracle-essential.persisted" || fail
  [[ "$(grep -Fxc -- '-A INPUT -j SETLIVRE_INPUT' /etc/iptables/rules.v4)" -eq 1 ]] || fail
  [[ "$(grep -Fxc -- '-A SETLIVRE_INPUT -j DROP' /etc/iptables/rules.v4)" -eq 1 ]] || fail
}

[[ "$EUID" -eq 0 && "$#" -eq 3 ]] || fail
for command_name in \
  awk bash chmod chown cmp curl cut env fallocate getent grep id install iptables iptables-save \
  ln mkdir mkswap mktemp mv passwd python3 readlink rm rmdir sha256sum sort stat swapon sync \
  sysctl tar; do
  command -v "$command_name" >/dev/null 2>&1 || fail
done
readonly administrative_cidr="$1"
readonly release_manager_source="$2"
readonly release_manager_sha256="$3"
python3 - "$administrative_cidr" <<'PY'
import ipaddress
import sys

network = ipaddress.ip_network(sys.argv[1], strict=True)
if network.version != 4 or network.prefixlen != 32:
    raise SystemExit(1)
PY
[[ "$release_manager_source" == /* ]] || fail
[[ -f "$release_manager_source" && ! -L "$release_manager_source" ]] || fail
[[ "$(readlink --canonicalize-existing -- "$release_manager_source")" == \
  "$release_manager_source" ]] || fail
assert_sha256 "$release_manager_sha256"
# shellcheck disable=SC1091
source /etc/os-release
[[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == 24.04 ]] || fail
[[ "$(uname -m)" == x86_64 ]] || fail
id ubuntu >/dev/null 2>&1 || fail
[[ ! -e "$bootstrap_state_directory" && ! -L "$bootstrap_state_directory" ]] || fail
assert_e2_micro_memory_budget

temporary_root="$(mktemp -d --tmpdir=/var/tmp 'setlivre-bootstrap.XXXXXXXX')"
node_install_staging=""
cleanup() {
  local exit_code="$?"
  if [[ -n "${node_install_staging:-}" && \
    "$node_install_staging" == "/opt/.node-v${node_version}.setlivre."* && \
    -d "$node_install_staging" && ! -L "$node_install_staging" && \
    "$(stat -c '%U:%G:%a:%h' -- "$node_install_staging")" == root:root:700:1 ]]; then
    rm -rf --one-file-system -- "$node_install_staging"
  fi
  rm -rf --one-file-system -- "$temporary_root"
  return "$exit_code"
}
trap cleanup EXIT
readonly release_manager_frozen="$temporary_root/production-release-manager.sh"
readonly oracle_firewall_before_packages="$temporary_root/iptables.before-packages"
install -o root -g root -m 0600 -- "$release_manager_source" "$release_manager_frozen"
[[ "$(file_sha256 "$release_manager_frozen")" == "$release_manager_sha256" ]] || fail
bash -n "$release_manager_frozen"
iptables-save >"$oracle_firewall_before_packages"
extract_oracle_essential_firewall_rules \
  "$oracle_firewall_before_packages" "$temporary_root/oracle-essential.preflight"
claim_bootstrap
configure_ipv6_disabled

readonly swap_path=/swapfile
[[ ! -e "$swap_path" && ! -L "$swap_path" ]] || fail
fallocate --length 2G -- "$swap_path"
chown root:root -- "$swap_path"
chmod 0600 -- "$swap_path"
[[ "$(stat -c '%U:%G:%a:%h:%s' -- "$swap_path")" == root:root:600:1:2147483648 ]] || fail
mkswap -- "$swap_path" >/dev/null
swapon -- "$swap_path"
[[ "$(swapon --noheadings --raw --show=NAME | awk 'NF { print }')" == "$swap_path" ]] || fail
[[ "$(grep -Fxc '/swapfile none swap sw 0 0' /etc/fstab)" -eq 0 ]] || fail
printf '%s\n' '/swapfile none swap sw 0 0' >>/etc/fstab
[[ "$(grep -Fxc '/swapfile none swap sw 0 0' /etc/fstab)" -eq 1 ]] || fail

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get dist-upgrade -y
apt-get purge -y ufw
apt-get install -y --no-install-recommends \
  ca-certificates certbot curl fail2ban iptables iptables-persistent netfilter-persistent nginx \
  openssl postgresql-client python3 sudo unattended-upgrades xz-utils
! dpkg-query --show --showformat='${db:Status-Abbrev}' ufw 2>/dev/null | grep -q '^ii ' || fail
! dpkg-query --show --showformat='${db:Status-Abbrev}' python3-certbot-nginx 2>/dev/null | \
  grep -q '^ii ' || fail

install_supabase_cli
install_node_runtime

getent group "$runtime_group" >/dev/null || groupadd --system "$runtime_group"
id "$runtime_user" >/dev/null 2>&1 || useradd \
  --system --gid "$runtime_group" --home-dir "$runtime_home" --no-create-home \
  --shell /usr/sbin/nologin "$runtime_user"
passwd --lock "$runtime_user" >/dev/null
assert_runtime_identity
install -d -o root -g "$runtime_group" -m 0750 \
  /opt/setlivre /opt/setlivre/releases /opt/setlivre/shared \
  /opt/setlivre/shared/runtime /opt/setlivre/shared/runtime/releases
install -o root -g root -m 0750 "$release_manager_frozen" \
  /usr/local/sbin/setlivre-release-manager

cat >"/etc/systemd/system/$recovery_service" <<'UNIT'
[Unit]
Description=Recover Set Livre release state before accepting traffic
After=local-fs.target
Before=setlivre-web.service setlivre-backoffice.service nginx.service

[Service]
Type=oneshot
User=root
Group=root
UMask=0077
ExecStart=/usr/local/sbin/setlivre-release-manager recover-boot
RemainAfterExit=yes
NoNewPrivileges=true
PrivateDevices=true
PrivateTmp=true
ProtectClock=true
ProtectControlGroups=true
ProtectHome=true
ProtectHostname=true
ProtectKernelLogs=true
ProtectKernelModules=true
ProtectKernelTunables=true
ProtectSystem=strict
ReadWritePaths=/opt/setlivre /run/lock
RestrictAddressFamilies=AF_UNIX
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
CapabilityBoundingSet=
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
UNIT

install -d -o root -g root -m 0755 /etc/systemd/system/nginx.service.d
cat >/etc/systemd/system/nginx.service.d/setlivre-release-recovery.conf <<UNIT
[Unit]
Requires=${recovery_service}
After=${recovery_service}
UNIT

cat >/etc/systemd/system/setlivre-web.service <<UNIT
[Unit]
Description=Set Livre public web
After=network-online.target ${recovery_service}
Wants=network-online.target
Requires=${recovery_service}
ConditionPathIsSymbolicLink=/opt/setlivre/current

[Service]
Type=simple
User=setlivre
Group=setlivre
WorkingDirectory=/opt/setlivre/current/web
LoadCredential=runtime.env:/opt/setlivre/shared/runtime/current/web.env
LoadCredential=supabase-server-ca.pem:${supabase_server_ca}
Environment=NODE_OPTIONS=--max-old-space-size=${web_node_old_space_mib}
UnsetEnvironment=APP_ENV APP_RELEASE_SHA DATABASE_TLS_CA_PATH DATABASE_TLS_CA_SHA256 DATABASE_URL_APP_DAL HOSTNAME NEXT_PUBLIC_APP_URL NEXT_PUBLIC_SUPABASE_ANON_KEY NEXT_PUBLIC_SUPABASE_URL NEXT_TELEMETRY_DISABLED NODE_ENV PORT
ExecStart=/usr/local/bin/node --env-file=%d/runtime.env /opt/setlivre/current/web/server.js
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30s
MemoryAccounting=true
MemoryHigh=${web_memory_high_mib}M
MemoryMax=${web_memory_max_mib}M
MemorySwapMax=${web_memory_swap_max_mib}M
OOMPolicy=kill
UMask=0027
NoNewPrivileges=true
PrivateDevices=true
PrivateTmp=true
ProtectClock=true
ProtectControlGroups=true
ProtectHome=true
ProtectHostname=true
ProtectKernelLogs=true
ProtectKernelModules=true
ProtectKernelTunables=true
ProtectSystem=strict
SystemCallArchitectures=native
RestrictAddressFamilies=AF_INET AF_UNIX
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
CapabilityBoundingSet=
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
UNIT

cat >/etc/systemd/system/setlivre-backoffice.service <<UNIT
[Unit]
Description=Set Livre backoffice
After=network-online.target ${recovery_service}
Wants=network-online.target
Requires=${recovery_service}
ConditionPathIsSymbolicLink=/opt/setlivre/current

[Service]
Type=simple
User=setlivre
Group=setlivre
WorkingDirectory=/opt/setlivre/current/backoffice/apps/backoffice
LoadCredential=runtime.env:/opt/setlivre/shared/runtime/current/backoffice.env
LoadCredential=supabase-server-ca.pem:${supabase_server_ca}
Environment=NODE_OPTIONS=--max-old-space-size=${backoffice_node_old_space_mib}
UnsetEnvironment=APP_ENV APP_RELEASE_SHA DATABASE_TLS_CA_PATH DATABASE_TLS_CA_SHA256 DATABASE_URL_APP_DAL HOSTNAME NEXT_PUBLIC_APP_URL NEXT_PUBLIC_SUPABASE_ANON_KEY NEXT_PUBLIC_SUPABASE_URL NEXT_TELEMETRY_DISABLED NODE_ENV PORT
ExecStart=/usr/local/bin/node --env-file=%d/runtime.env /opt/setlivre/current/backoffice/apps/backoffice/server.js
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30s
MemoryAccounting=true
MemoryHigh=${backoffice_memory_high_mib}M
MemoryMax=${backoffice_memory_max_mib}M
MemorySwapMax=${backoffice_memory_swap_max_mib}M
OOMPolicy=kill
UMask=0027
NoNewPrivileges=true
PrivateDevices=true
PrivateTmp=true
ProtectClock=true
ProtectControlGroups=true
ProtectHome=true
ProtectHostname=true
ProtectKernelLogs=true
ProtectKernelModules=true
ProtectKernelTunables=true
ProtectSystem=strict
SystemCallArchitectures=native
RestrictAddressFamilies=AF_INET AF_UNIX
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
CapabilityBoundingSet=
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
UNIT

cat >/etc/nginx/conf.d/setlivre-proxy.conf <<'NGINX'
map $http_upgrade $setlivre_connection_upgrade {
  default upgrade;
  '' close;
}

log_format setlivre_sanitized escape=json
  '$remote_addr [$time_iso8601] "$request_method $uri $server_protocol" '
  '$status $body_bytes_sent request_id=$request_id';

limit_req_zone $binary_remote_addr zone=setlivre_public:10m rate=20r/s;
limit_req_zone $binary_remote_addr zone=setlivre_ops_health:1m rate=5r/s;
NGINX
install -d -o root -g root -m 0755 /var/lib/letsencrypt/.well-known/acme-challenge
readonly nginx_bootstrap_site=/etc/nginx/sites-available/setlivre-bootstrap
readonly nginx_tls_site=/etc/nginx/sites-available/setlivre-tls
readonly nginx_enabled_site=/etc/nginx/sites-enabled/setlivre
cat >"$nginx_bootstrap_site" <<'NGINX_BOOTSTRAP'
server {
  listen 80 default_server;
  server_name _;
  access_log /var/log/nginx/setlivre-access.log setlivre_sanitized buffer=32k flush=5s;
  server_tokens off;
  return 308 https://setlivre.com$request_uri;
}

server {
  listen 80;
  server_name setlivre.com www.setlivre.com;
  access_log /var/log/nginx/setlivre-access.log setlivre_sanitized buffer=32k flush=5s;
  server_tokens off;

  location ^~ /.well-known/acme-challenge/ {
    root /var/lib/letsencrypt;
    default_type text/plain;
    try_files $uri =404;
  }

  location / {
    return 308 https://setlivre.com$request_uri;
  }
}

server {
  listen 80;
  server_name ops.setlivre.com;
  access_log /var/log/nginx/setlivre-access.log setlivre_sanitized buffer=32k flush=5s;
  server_tokens off;

  location ^~ /.well-known/acme-challenge/ {
    root /var/lib/letsencrypt;
    default_type text/plain;
    try_files $uri =404;
  }

  location / {
    return 308 https://ops.setlivre.com$request_uri;
  }
}

server {
  listen 443 ssl default_server;
  server_name _;
  access_log /var/log/nginx/setlivre-access.log setlivre_sanitized buffer=32k flush=5s;
  server_tokens off;
  ssl_reject_handshake on;
}
NGINX_BOOTSTRAP

cat >"$nginx_tls_site" <<'NGINX_TLS'
server {
  listen 80 default_server;
  server_name _;
  access_log /var/log/nginx/setlivre-access.log setlivre_sanitized buffer=32k flush=5s;
  server_tokens off;
  return 308 https://setlivre.com$request_uri;
}

server {
  listen 80;
  server_name setlivre.com www.setlivre.com;
  access_log /var/log/nginx/setlivre-access.log setlivre_sanitized buffer=32k flush=5s;
  server_tokens off;

  location ^~ /.well-known/acme-challenge/ {
    root /var/lib/letsencrypt;
    default_type text/plain;
    try_files $uri =404;
  }

  location / {
    return 308 https://setlivre.com$request_uri;
  }
}

server {
  listen 80;
  server_name ops.setlivre.com;
  access_log /var/log/nginx/setlivre-access.log setlivre_sanitized buffer=32k flush=5s;
  server_tokens off;

  location ^~ /.well-known/acme-challenge/ {
    root /var/lib/letsencrypt;
    default_type text/plain;
    try_files $uri =404;
  }

  location / {
    return 308 https://ops.setlivre.com$request_uri;
  }
}

server {
  listen 443 ssl default_server;
  server_name _;
  access_log /var/log/nginx/setlivre-access.log setlivre_sanitized buffer=32k flush=5s;
  server_tokens off;
  ssl_certificate /etc/letsencrypt/live/setlivre.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/setlivre.com/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_session_cache shared:SSL:10m;
  ssl_session_timeout 1d;
  ssl_session_tickets off;
  ssl_reject_handshake on;
}

server {
  listen 443 ssl;
  server_name www.setlivre.com;
  access_log /var/log/nginx/setlivre-access.log setlivre_sanitized buffer=32k flush=5s;
  server_tokens off;
  ssl_certificate /etc/letsencrypt/live/setlivre.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/setlivre.com/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_session_cache shared:SSL:10m;
  ssl_session_timeout 1d;
  ssl_session_tickets off;
  add_header Strict-Transport-Security "max-age=31536000" always;
  return 308 https://setlivre.com$request_uri;
}

server {
  listen 443 ssl;
  server_name setlivre.com;
  access_log /var/log/nginx/setlivre-access.log setlivre_sanitized buffer=32k flush=5s;
  server_tokens off;
  client_max_body_size 1m;
  ssl_certificate /etc/letsencrypt/live/setlivre.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/setlivre.com/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_session_cache shared:SSL:10m;
  ssl_session_timeout 1d;
  ssl_session_tickets off;
  add_header Strict-Transport-Security "max-age=31536000" always;

  location / {
    limit_req zone=setlivre_public burst=40 nodelay;
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $setlivre_connection_upgrade;
    proxy_connect_timeout 5s;
    proxy_read_timeout 60s;
    proxy_send_timeout 60s;
  }
}

server {
  listen 443 ssl;
  server_name ops.setlivre.com;
  access_log /var/log/nginx/setlivre-access.log setlivre_sanitized buffer=32k flush=5s;
  server_tokens off;
  client_max_body_size 1m;
  ssl_certificate /etc/letsencrypt/live/setlivre.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/setlivre.com/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_session_cache shared:SSL:10m;
  ssl_session_timeout 1d;
  ssl_session_tickets off;
  add_header Strict-Transport-Security "max-age=31536000" always;

  location = /api/health/live {
    limit_req zone=setlivre_ops_health burst=10 nodelay;
    allow __SETLIVRE_ADMINISTRATIVE_CIDR__;
    allow 10.20.1.0/24;
    deny all;
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $remote_addr;
  }

  location = /api/health/ready {
    limit_req zone=setlivre_ops_health burst=10 nodelay;
    allow __SETLIVRE_ADMINISTRATIVE_CIDR__;
    allow 10.20.1.0/24;
    deny all;
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $remote_addr;
  }

  location / {
    allow __SETLIVRE_ADMINISTRATIVE_CIDR__;
    deny all;
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $setlivre_connection_upgrade;
    proxy_connect_timeout 5s;
    proxy_read_timeout 60s;
    proxy_send_timeout 60s;
  }
}
NGINX_TLS
python3 - "$nginx_tls_site" "$administrative_cidr" <<'PY'
import ipaddress
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
network = ipaddress.ip_network(sys.argv[2], strict=True)
if network.version != 4 or network.prefixlen != 32:
    raise SystemExit(1)
placeholder = "__SETLIVRE_ADMINISTRATIVE_CIDR__"
configuration = path.read_text(encoding="utf-8")
if configuration.count(placeholder) != 3:
    raise SystemExit(1)
configuration = configuration.replace(placeholder, network.with_prefixlen)
if placeholder in configuration:
    raise SystemExit(1)
path.write_text(configuration, encoding="utf-8")
PY
ln -sfn "$nginx_bootstrap_site" "$nginx_enabled_site"
rm -f /etc/nginx/sites-enabled/default
chown root:root "$nginx_bootstrap_site" "$nginx_tls_site"
chmod 0644 "$nginx_bootstrap_site" "$nginx_tls_site"

cat >"$tls_enable_path" <<'TLS_ENABLE'
#!/usr/bin/env bash

set -euo pipefail
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
readonly bootstrap_site=/etc/nginx/sites-available/setlivre-bootstrap
readonly tls_site=/etc/nginx/sites-available/setlivre-tls
readonly enabled_site=/etc/nginx/sites-enabled/setlivre
readonly certificate=/etc/letsencrypt/live/setlivre.com/fullchain.pem
readonly private_key=/etc/letsencrypt/live/setlivre.com/privkey.pem

fail() {
  printf '%s\n' "Set Livre TLS activation rejected the operation." >&2
  exit 1
}

restore_site() {
  local target="$1"
  local candidate="${enabled_site}.rollback.$$"
  [[ "$target" == "$bootstrap_site" || "$target" == "$tls_site" ]] || return 1
  [[ ! -e "$candidate" && ! -L "$candidate" ]] || return 1
  ln -s -- "$target" "$candidate" || return 1
  mv -Tf -- "$candidate" "$enabled_site" || return 1
  sync -- /etc/nginx/sites-enabled || return 1
}

[[ "$EUID" -eq 0 && "$#" -eq 0 ]] || fail
for command_name in ln mv nginx openssl python3 readlink stat sync systemctl; do
  command -v "$command_name" >/dev/null 2>&1 || fail
done
for configuration in "$bootstrap_site" "$tls_site"; do
  [[ -f "$configuration" && ! -L "$configuration" ]] || fail
  [[ "$(readlink --canonicalize-existing -- "$configuration")" == "$configuration" ]] || fail
  [[ "$(stat -c '%U:%G:%a:%h' -- "$configuration")" == root:root:644:1 ]] || fail
done
[[ -f "$certificate" && -f "$private_key" ]] || fail
certificate_real="$(readlink --canonicalize-existing -- "$certificate")" || fail
private_key_real="$(readlink --canonicalize-existing -- "$private_key")" || fail
[[ "$certificate_real" == /etc/letsencrypt/archive/setlivre.com/fullchain*.pem ]] || fail
[[ "$private_key_real" == /etc/letsencrypt/archive/setlivre.com/privkey*.pem ]] || fail
[[ "$(stat -c '%U:%h' -- "$certificate_real")" == root:1 ]] || fail
[[ "$(stat -c '%U:%h' -- "$private_key_real")" == root:1 ]] || fail
private_key_mode="$(stat -c '%a' -- "$private_key_real")" || fail
[[ "$private_key_mode" =~ ^[0-7]{3,4}$ ]] || fail
(((8#$private_key_mode & 8#077) == 0)) || fail
openssl x509 -in "$certificate" -noout -checkend 604800 >/dev/null || fail
san_extension="$(openssl x509 -in "$certificate" -noout -ext subjectAltName)" || fail
python3 - "$san_extension" <<'CERTIFICATE_SAN_PY'
import re
import sys

names = re.findall(r"DNS:([^,\s]+)", sys.argv[1])
expected = {"setlivre.com", "www.setlivre.com", "ops.setlivre.com"}
if len(names) != len(expected) or set(names) != expected:
    raise SystemExit(1)
CERTIFICATE_SAN_PY
for hostname in setlivre.com www.setlivre.com ops.setlivre.com; do
  openssl x509 -in "$certificate" -noout -checkhost "$hostname" >/dev/null || fail
done
previous_site="$(readlink --canonicalize-existing -- "$enabled_site")" || fail
[[ "$previous_site" == "$bootstrap_site" || "$previous_site" == "$tls_site" ]] || fail
restore_site "$tls_site" || fail
if ! nginx -t >/dev/null 2>&1; then
  restore_site "$previous_site" || fail
  nginx -t >/dev/null 2>&1 || fail
  fail
fi
if ! systemctl reload nginx; then
  restore_site "$previous_site" || fail
  nginx -t >/dev/null 2>&1 || fail
  systemctl reload nginx || fail
  fail
fi
[[ "$(readlink --canonicalize-existing -- "$enabled_site")" == "$tls_site" ]] || fail
systemctl is-active --quiet nginx || fail
TLS_ENABLE
chown root:root "$tls_enable_path"
chmod 0750 "$tls_enable_path"
[[ -f "$tls_enable_path" && ! -L "$tls_enable_path" ]] || fail
[[ "$(readlink --canonicalize-existing -- "$tls_enable_path")" == "$tls_enable_path" ]] || fail
[[ "$(stat -c '%U:%G:%a:%h' -- "$tls_enable_path")" == root:root:750:1 ]] || fail
bash -n "$tls_enable_path"

readonly tls_issue_candidate="$temporary_root/setlivre-issue-tls-certificate"
cat >"$tls_issue_candidate" <<'TLS_ISSUE'
#!/usr/bin/env bash

set -euo pipefail
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
unset BASH_ENV CDPATH ENV GLOBIGNORE GREP_OPTIONS PYTHONHOME PYTHONPATH
readonly webroot=/var/lib/letsencrypt

fail() {
  printf '%s\n' "Set Livre TLS certificate issuance rejected the operation." >&2
  exit 1
}

[[ "$EUID" -eq 0 && "$#" -eq 1 ]] || fail
readonly email="$1"
[[ "${#email}" -le 254 ]] || fail
[[ "$email" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$ ]] || fail
[[ "$(command -v certbot)" == /usr/bin/certbot ]] || fail
[[ -d "$webroot" && ! -L "$webroot" ]] || fail
[[ "$(readlink --canonicalize-existing -- "$webroot")" == "$webroot" ]] || fail
[[ "$(stat -c '%U:%G:%a' -- "$webroot")" == root:root:755 ]] || fail
exec /usr/bin/certbot certonly \
  --non-interactive \
  --agree-tos \
  --no-eff-email \
  --preferred-challenges http-01 \
  --cert-name setlivre.com \
  --webroot \
  --webroot-path "$webroot" \
  --email "$email" \
  --domain setlivre.com \
  --domain www.setlivre.com \
  --domain ops.setlivre.com
TLS_ISSUE
install -o root -g root -m 0750 -- "$tls_issue_candidate" "$tls_issue_path"
[[ -f "$tls_issue_path" && ! -L "$tls_issue_path" ]] || fail
[[ "$(readlink --canonicalize-existing -- "$tls_issue_path")" == "$tls_issue_path" ]] || fail
[[ "$(stat -c '%U:%G:%a:%h' -- "$tls_issue_path")" == root:root:750:1 ]] || fail
cmp --silent -- "$tls_issue_candidate" "$tls_issue_path" || fail
bash -n "$tls_issue_path"

install -d -o root -g root -m 0755 -- \
  /etc/letsencrypt/renewal-hooks /etc/letsencrypt/renewal-hooks/deploy
for directory in /etc/letsencrypt /etc/letsencrypt/renewal-hooks \
  /etc/letsencrypt/renewal-hooks/deploy; do
  [[ -d "$directory" && ! -L "$directory" ]] || fail
  [[ "$(readlink --canonicalize-existing -- "$directory")" == "$directory" ]] || fail
  [[ "$(stat -c '%U:%G:%a' -- "$directory")" == root:root:755 ]] || fail
done
readonly tls_renewal_hook_candidate="$temporary_root/setlivre-enable-tls-renewal-hook"
cat >"$tls_renewal_hook_candidate" <<'TLS_RENEWAL_HOOK'
#!/usr/bin/env bash

set -euo pipefail
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
unset BASH_ENV CDPATH ENV GLOBIGNORE GREP_OPTIONS PYTHONHOME PYTHONPATH
readonly tls_enable=/usr/local/sbin/setlivre-enable-tls

[[ "$EUID" -eq 0 && "$#" -eq 0 ]] || exit 1
[[ -f "$tls_enable" && ! -L "$tls_enable" ]] || exit 1
[[ "$(readlink --canonicalize-existing -- "$tls_enable")" == "$tls_enable" ]] || exit 1
[[ "$(stat -c '%U:%G:%a:%h' -- "$tls_enable")" == root:root:750:1 ]] || exit 1
exec "$tls_enable"
TLS_RENEWAL_HOOK
install -o root -g root -m 0750 -- "$tls_renewal_hook_candidate" "$tls_renewal_hook"
[[ -f "$tls_renewal_hook" && ! -L "$tls_renewal_hook" ]] || fail
[[ "$(readlink --canonicalize-existing -- "$tls_renewal_hook")" == "$tls_renewal_hook" ]] || fail
[[ "$(stat -c '%U:%G:%a:%h' -- "$tls_renewal_hook")" == root:root:750:1 ]] || fail
cmp --silent -- "$tls_renewal_hook_candidate" "$tls_renewal_hook" || fail
bash -n "$tls_renewal_hook"

cat >/etc/ssh/sshd_config.d/60-setlivre-hardening.conf <<'SSHD'
AddressFamily inet
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
PermitEmptyPasswords no
MaxAuthTries 3
LoginGraceTime 30
AllowAgentForwarding no
AllowTcpForwarding no
GatewayPorts no
X11Forwarding no
PermitTunnel no
AllowUsers ubuntu
SSHD
install -d -o root -g root -m 0755 /run/sshd
[[ "$(stat -c '%U:%G:%a' -- /run/sshd)" == root:root:755 ]] || fail
sshd -t

cat >/etc/fail2ban/jail.d/setlivre-sshd.local <<'FAIL2BAN'
[sshd]
enabled = true
backend = systemd
bantime = 1h
findtime = 10m
maxretry = 5
FAIL2BAN
cat >/etc/apt/apt.conf.d/52setlivre-unattended-upgrades <<'APT'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
Unattended-Upgrade::Automatic-Reboot "false";
APT

configure_host_firewall "$oracle_firewall_before_packages"
assert_ipv6_disabled

timedatectl set-timezone UTC
nginx -t
systemctl daemon-reload
systemd-analyze verify \
  "/etc/systemd/system/$recovery_service" \
  /etc/systemd/system/setlivre-web.service \
  /etc/systemd/system/setlivre-backoffice.service >/dev/null
assert_service_memory_contract \
  setlivre-web.service "$web_memory_high_mib" "$web_memory_max_mib" "$web_memory_swap_max_mib"
assert_service_memory_contract \
  setlivre-backoffice.service "$backoffice_memory_high_mib" \
  "$backoffice_memory_max_mib" "$backoffice_memory_swap_max_mib"
systemctl enable \
  "$recovery_service" nginx fail2ban netfilter-persistent unattended-upgrades \
  setlivre-web.service setlivre-backoffice.service
systemctl restart nginx fail2ban unattended-upgrades
systemctl reload ssh
/usr/local/sbin/setlivre-release-manager version | grep -qx '3'
[[ "$(systemctl is-enabled setlivre-web.service)" == enabled ]] || fail
[[ "$(systemctl is-enabled setlivre-backoffice.service)" == enabled ]] || fail
[[ "$(systemctl is-enabled "$recovery_service")" == enabled ]] || fail
[[ "$(systemctl is-active "$recovery_service")" == active ]] || fail
[[ "$(systemctl show -p Requires --value setlivre-web.service)" \
  == *"$recovery_service"* ]] || fail
[[ "$(systemctl show -p Requires --value setlivre-backoffice.service)" \
  == *"$recovery_service"* ]] || fail
[[ "$(systemctl show -p Requires --value nginx.service)" == *"$recovery_service"* ]] || fail
[[ "$(systemctl is-enabled netfilter-persistent.service)" == enabled ]] || fail
assert_runtime_identity
assert_installed_supabase_cli
complete_bootstrap
if [[ -e /var/run/reboot-required ]]; then
  printf '%s\n' \
    "Set Livre host bootstrap completed; reboot is required before deployer installation."
else
  printf '%s\n' "Set Livre host bootstrap completed; application services await the first release."
fi
