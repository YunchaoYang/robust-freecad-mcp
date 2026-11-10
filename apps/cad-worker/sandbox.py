"""In-process sandbox for untrusted FreeCAD Python jobs.

Applied by the worker *before* any job-supplied code runs, and inherited by
every thread. Once applied it cannot be lifted by the process.

Layers (all unprivileged; no root, user namespaces or containers required):

1. rlimits   - CPU seconds, address space, max file size, open files, no core dumps.
2. Landlock  - filesystem: read/execute only under an allowlist of runtime
               paths, read/write only inside the job directory; network: TCP
               bind/connect denied; scoping: no abstract-unix-socket or signal
               access outside the sandbox (ABI >= 6).
3. seccomp   - socket() denied for every address family, and execve, fork,
               non-thread clone, ptrace, mount, namespace, bpf, io_uring,
               keyring and similar syscalls denied with EPERM.

If Landlock is unavailable the worker refuses to run untrusted code unless
the operator explicitly opted out (FREECAD_MCP_ALLOW_UNSANDBOXED=1).
"""

from __future__ import annotations

import ctypes
import errno
import os
import platform
import resource
import struct

_libc = ctypes.CDLL(None, use_errno=True)
_libc.syscall.restype = ctypes.c_long
_libc.prctl.restype = ctypes.c_int

# --------------------------------------------------------------------------- rlimits


def apply_rlimits(cpu_seconds: int, address_space_mb: int, file_size_mb: int, open_files: int = 256) -> None:
    def _set(kind: int, value: int) -> None:
        soft, hard = resource.getrlimit(kind)
        if hard != resource.RLIM_INFINITY:
            value = min(value, hard)
        resource.setrlimit(kind, (value, value))

    _set(resource.RLIMIT_CPU, cpu_seconds)
    _set(resource.RLIMIT_AS, address_space_mb * 1024 * 1024)
    _set(resource.RLIMIT_FSIZE, file_size_mb * 1024 * 1024)
    _set(resource.RLIMIT_NOFILE, open_files)
    _set(resource.RLIMIT_CORE, 0)


# --------------------------------------------------------------------------- Landlock

_SYS_LANDLOCK_CREATE_RULESET = 444
_SYS_LANDLOCK_ADD_RULE = 445
_SYS_LANDLOCK_RESTRICT_SELF = 446
_LANDLOCK_CREATE_RULESET_VERSION = 1
_LANDLOCK_RULE_PATH_BENEATH = 1

FS_EXECUTE = 1 << 0
FS_WRITE_FILE = 1 << 1
FS_READ_FILE = 1 << 2
FS_READ_DIR = 1 << 3
FS_REMOVE_DIR = 1 << 4
FS_REMOVE_FILE = 1 << 5
FS_MAKE_CHAR = 1 << 6
FS_MAKE_DIR = 1 << 7
FS_MAKE_REG = 1 << 8
FS_MAKE_SOCK = 1 << 9
FS_MAKE_FIFO = 1 << 10
FS_MAKE_BLOCK = 1 << 11
FS_MAKE_SYM = 1 << 12
FS_REFER = 1 << 13  # ABI 2
FS_TRUNCATE = 1 << 14  # ABI 3
FS_IOCTL_DEV = 1 << 15  # ABI 5

NET_BIND_TCP = 1 << 0  # ABI 4
NET_CONNECT_TCP = 1 << 1  # ABI 4

SCOPE_ABSTRACT_UNIX_SOCKET = 1 << 0  # ABI 6
SCOPE_SIGNAL = 1 << 1  # ABI 6

_PR_SET_NO_NEW_PRIVS = 38


def landlock_abi() -> int:
    r = _libc.syscall(_SYS_LANDLOCK_CREATE_RULESET, None, ctypes.c_size_t(0), ctypes.c_uint32(_LANDLOCK_CREATE_RULESET_VERSION))
    return int(r) if r > 0 else 0


def _fs_mask_for_abi(abi: int) -> int:
    mask = (1 << 13) - 1  # ABI 1: bits 0..12
    if abi >= 2:
        mask |= FS_REFER
    if abi >= 3:
        mask |= FS_TRUNCATE
    if abi >= 5:
        mask |= FS_IOCTL_DEV
    return mask


def apply_landlock(read_only: list[str], read_write: list[str]) -> dict:
    """Restrict filesystem (and, if supported, TCP and scoping). Returns a report."""
    abi = landlock_abi()
    if abi < 1:
        raise OSError(errno.ENOSYS, "Landlock is not available on this kernel")

    handled_fs = _fs_mask_for_abi(abi)
    handled_net = (NET_BIND_TCP | NET_CONNECT_TCP) if abi >= 4 else 0
    scoped = (SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL) if abi >= 6 else 0

    if abi >= 6:
        attr = struct.pack("=QQQ", handled_fs, handled_net, scoped)
    elif abi >= 4:
        attr = struct.pack("=QQ", handled_fs, handled_net)
    else:
        attr = struct.pack("=Q", handled_fs)
    buf = ctypes.create_string_buffer(attr, len(attr))
    ruleset_fd = _libc.syscall(_SYS_LANDLOCK_CREATE_RULESET, buf, ctypes.c_size_t(len(attr)), ctypes.c_uint32(0))
    if ruleset_fd < 0:
        e = ctypes.get_errno()
        raise OSError(e, f"landlock_create_ruleset failed: {os.strerror(e)}")

    ro_access = FS_EXECUTE | FS_READ_FILE | FS_READ_DIR
    # Inside the job directory: full file/dir manipulation, but no device
    # nodes, sockets, FIFOs or symlinks, and no cross-directory "refer" links.
    rw_access = handled_fs & ~(FS_MAKE_CHAR | FS_MAKE_BLOCK | FS_MAKE_SOCK | FS_MAKE_FIFO | FS_MAKE_SYM | FS_REFER | FS_IOCTL_DEV)

    granted: list[tuple[str, str]] = []
    try:
        for paths, access, label in ((read_only, ro_access, "ro"), (read_write, rw_access, "rw")):
            for p in paths:
                if not p or not os.path.exists(p):
                    continue
                fd = os.open(p, os.O_PATH | os.O_CLOEXEC)
                try:
                    acc = access
                    if not os.path.isdir(p):
                        # Directory-only rights are rejected for file rules.
                        acc &= FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_TRUNCATE | FS_IOCTL_DEV
                    rule = struct.pack("=Qi", acc & handled_fs, fd)  # packed struct (12 bytes)
                    rbuf = ctypes.create_string_buffer(rule, len(rule))
                    r = _libc.syscall(_SYS_LANDLOCK_ADD_RULE, ctypes.c_int(ruleset_fd), ctypes.c_int(_LANDLOCK_RULE_PATH_BENEATH), rbuf, ctypes.c_uint32(0))
                    if r < 0:
                        e = ctypes.get_errno()
                        raise OSError(e, f"landlock_add_rule({p}) failed: {os.strerror(e)}")
                    granted.append((label, p))
                finally:
                    os.close(fd)

        if _libc.prctl(_PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
            e = ctypes.get_errno()
            raise OSError(e, f"prctl(NO_NEW_PRIVS) failed: {os.strerror(e)}")
        if _libc.syscall(_SYS_LANDLOCK_RESTRICT_SELF, ctypes.c_int(ruleset_fd), ctypes.c_uint32(0)) < 0:
            e = ctypes.get_errno()
            raise OSError(e, f"landlock_restrict_self failed: {os.strerror(e)}")
    finally:
        os.close(ruleset_fd)

    return {"abi": abi, "network": bool(handled_net), "scoped": bool(scoped), "rules": granted}


# --------------------------------------------------------------------------- seccomp

_PR_SET_SECCOMP = 22
_SECCOMP_MODE_FILTER = 2
_SECCOMP_RET_ALLOW = 0x7FFF0000
_SECCOMP_RET_ERRNO = 0x00050000
_SECCOMP_RET_KILL_PROCESS = 0x80000000

_BPF_LD_W_ABS = 0x20
_BPF_JEQ_K = 0x15
_BPF_JSET_K = 0x45
_BPF_RET_K = 0x06

_CLONE_THREAD = 0x00010000

_ARCH = {
    # machine: (AUDIT_ARCH, syscall numbers)
    "aarch64": (
        0xC00000B7,
        {
            "socket": 198, "execve": 221, "execveat": 281, "clone": 220, "clone3": 435,
            "ptrace": 117, "process_vm_readv": 270, "process_vm_writev": 271, "mount": 40,
            "umount2": 39, "unshare": 97, "setns": 268, "bpf": 280, "perf_event_open": 241,
            "keyctl": 219, "add_key": 217, "request_key": 218, "io_uring_setup": 425,
            "userfaultfd": 282, "pivot_root": 41, "chroot": 51, "kexec_load": 104,
            "init_module": 105, "finit_module": 273, "reboot": 142,
        },
    ),
    "x86_64": (
        0xC000003E,
        {
            "socket": 41, "execve": 59, "execveat": 322, "clone": 56, "clone3": 435,
            "fork": 57, "vfork": 58, "ptrace": 101, "process_vm_readv": 310,
            "process_vm_writev": 311, "mount": 165, "umount2": 166, "unshare": 272,
            "setns": 308, "bpf": 321, "perf_event_open": 298, "keyctl": 250, "add_key": 248,
            "request_key": 249, "io_uring_setup": 425, "userfaultfd": 323, "pivot_root": 155,
            "chroot": 161, "kexec_load": 246, "init_module": 175, "finit_module": 313,
            "reboot": 169,
        },
    ),
}


def _insn(code: int, jt: int, jf: int, k: int) -> bytes:
    return struct.pack("=HBBI", code, jt, jf, k & 0xFFFFFFFF)


def apply_seccomp() -> dict:
    machine = platform.machine()
    if machine not in _ARCH:
        raise OSError(errno.ENOSYS, f"seccomp filter not defined for architecture {machine}")
    audit_arch, nrs = _ARCH[machine]
    eperm = _SECCOMP_RET_ERRNO | errno.EPERM
    eacces = _SECCOMP_RET_ERRNO | errno.EACCES
    enosys = _SECCOMP_RET_ERRNO | errno.ENOSYS

    denied = [n for n in nrs if n not in ("clone", "clone3", "socket")]
    prog: list[bytes] = []
    # [0] arch check
    prog.append(_insn(_BPF_LD_W_ABS, 0, 0, 4))
    prog.append(_insn(_BPF_JEQ_K, 1, 0, audit_arch))
    prog.append(_insn(_BPF_RET_K, 0, 0, _SECCOMP_RET_KILL_PROCESS))
    # load syscall nr
    prog.append(_insn(_BPF_LD_W_ABS, 0, 0, 0))
    # socket -> EACCES (all families; socketpair stays available)
    prog.append(_insn(_BPF_JEQ_K, 0, 1, nrs["socket"]))
    prog.append(_insn(_BPF_RET_K, 0, 0, eacces))
    # clone3 -> ENOSYS so libc falls back to clone(), which we can inspect
    prog.append(_insn(_BPF_JEQ_K, 0, 1, nrs["clone3"]))
    prog.append(_insn(_BPF_RET_K, 0, 0, enosys))
    # clone: allow only when CLONE_THREAD is set (threads yes, processes no)
    prog.append(_insn(_BPF_JEQ_K, 0, 4, nrs["clone"]))
    prog.append(_insn(_BPF_LD_W_ABS, 0, 0, 16))  # low 32 bits of args[0] (flags)
    prog.append(_insn(_BPF_JSET_K, 1, 0, _CLONE_THREAD))
    prog.append(_insn(_BPF_RET_K, 0, 0, eperm))
    prog.append(_insn(_BPF_RET_K, 0, 0, _SECCOMP_RET_ALLOW))
    # flat deny list
    for name in denied:
        prog.append(_insn(_BPF_JEQ_K, 0, 1, nrs[name]))
        prog.append(_insn(_BPF_RET_K, 0, 0, eperm))
    prog.append(_insn(_BPF_RET_K, 0, 0, _SECCOMP_RET_ALLOW))

    filt = b"".join(prog)
    filt_buf = ctypes.create_string_buffer(filt, len(filt))

    class SockFprog(ctypes.Structure):
        _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.c_void_p)]

    fprog = SockFprog(len(prog), ctypes.cast(filt_buf, ctypes.c_void_p))
    if _libc.prctl(_PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        e = ctypes.get_errno()
        raise OSError(e, f"prctl(NO_NEW_PRIVS) failed: {os.strerror(e)}")
    if _libc.prctl(_PR_SET_SECCOMP, _SECCOMP_MODE_FILTER, ctypes.byref(fprog), 0, 0) != 0:
        e = ctypes.get_errno()
        raise OSError(e, f"prctl(SECCOMP) failed: {os.strerror(e)}")
    return {"arch": machine, "denied": sorted(denied + ["socket", "clone(!CLONE_THREAD)"])}


# --------------------------------------------------------------------------- facade


def enter_sandbox(job_dir: str, read_only: list[str]) -> dict:
    """Apply Landlock + seccomp. Fail closed unless explicitly allowed."""
    allow_unsandboxed = os.environ.get("FREECAD_MCP_ALLOW_UNSANDBOXED") == "1"
    report: dict = {"landlock": None, "seccomp": None, "enforced": False}
    try:
        report["landlock"] = apply_landlock(read_only, [job_dir])
        report["seccomp"] = apply_seccomp()
        report["enforced"] = True
    except OSError as exc:
        if not allow_unsandboxed:
            raise
        report["warning"] = f"sandbox not enforced: {exc}"
    return report
