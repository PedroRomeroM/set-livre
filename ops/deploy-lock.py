#!/usr/bin/env python3

import fcntl
import os
import stat
import sys
import time


LOCK_PATH = "/run/lock/set-livre-deploy.lock"
LOCK_ARGUMENT = "--set-livre-deploy-lock-fd"


def fail(message: str) -> None:
    raise SystemExit(f"deploy-lock: {message}")


def validate_descriptor(file_descriptor: int, require_lock: bool = True) -> None:
    try:
        descriptor = os.fstat(file_descriptor)
        path = os.lstat(LOCK_PATH)
    except OSError:
        fail("não foi possível validar o descritor")
    if (
        not stat.S_ISREG(descriptor.st_mode)
        or not stat.S_ISREG(path.st_mode)
        or descriptor.st_uid != 0
        or descriptor.st_gid != 0
        or stat.S_IMODE(descriptor.st_mode) != 0o600
        or descriptor.st_nlink != 1
        or (descriptor.st_dev, descriptor.st_ino) != (path.st_dev, path.st_ino)
    ):
        fail("o descritor não corresponde ao lock root-only")
    if require_lock:
        try:
            fcntl.flock(file_descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail("o descritor herdado não mantém o lock exclusivo")


def open_lock() -> int:
    no_follow = getattr(os, "O_NOFOLLOW", None)
    if no_follow is None:
        fail("O_NOFOLLOW não está disponível")
    try:
        file_descriptor = os.open(
            LOCK_PATH,
            os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | no_follow,
            0o600,
        )
        metadata = os.fstat(file_descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != 0
            or metadata.st_gid != 0
            or metadata.st_nlink != 1
        ):
            fail("o lock existente não é um arquivo root-only regular")
        os.fchmod(file_descriptor, 0o600)
        validate_descriptor(file_descriptor, require_lock=False)
        return file_descriptor
    except OSError:
        fail("o lock não pôde ser aberto sem seguir links")


def acquire(file_descriptor: int, policy: str) -> None:
    if policy == "blocking":
        fcntl.flock(file_descriptor, fcntl.LOCK_EX)
        return
    if policy == "nonblocking":
        try:
            fcntl.flock(file_descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail("já existe outra operação de deploy")
        return
    if not policy.startswith("timeout="):
        fail("política de espera inválida")
    try:
        timeout = int(policy.removeprefix("timeout="))
    except ValueError:
        fail("timeout inválido")
    if timeout < 1 or timeout > 3600:
        fail("timeout fora do limite")
    deadline = time.monotonic() + timeout
    while True:
        try:
            fcntl.flock(file_descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            if time.monotonic() >= deadline:
                fail("o lock permaneceu ocupado além do limite")
            time.sleep(0.05)


def main(arguments: list[str]) -> None:
    if len(arguments) == 2 and arguments[0] == "verify":
        try:
            file_descriptor = int(arguments[1])
        except ValueError:
            fail("descritor herdado inválido")
        validate_descriptor(file_descriptor)
        return
    if len(arguments) < 3 or arguments[0] != "run":
        fail("uso inválido")
    policy, script, *script_arguments = arguments[1:]
    if not os.path.isabs(script):
        fail("o script protegido precisa usar caminho absoluto")
    file_descriptor = open_lock()
    acquire(file_descriptor, policy)
    validate_descriptor(file_descriptor)
    os.set_inheritable(file_descriptor, True)
    os.execve(
        "/usr/bin/bash",
        [
            "/usr/bin/bash",
            script,
            LOCK_ARGUMENT,
            str(file_descriptor),
            *script_arguments,
        ],
        os.environ.copy(),
    )


if __name__ == "__main__":
    main(sys.argv[1:])
