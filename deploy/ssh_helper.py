"""Tiny SSH helper for Vultr deployment.

Required env vars (put in .env, which is gitignored):
    VULTR_HOST=<server ip>
    VULTR_USER=root
    VULTR_PASS=<password>

Usage:
    python -c "from deploy.ssh_helper import sh; print(sh('ls /'))"
"""
import os
import sys

import paramiko

HOST = os.environ.get("VULTR_HOST")
USER = os.environ.get("VULTR_USER", "root")
PASS = os.environ.get("VULTR_PASS")


def _client():
    if not (HOST and PASS):
        raise RuntimeError(
            "Missing VULTR_HOST / VULTR_PASS env vars. "
            "Set them in .env or your shell before using ssh_helper."
        )
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, password=PASS, timeout=15)
    return c


def sh(cmd: str, check: bool = False, timeout: int = 120) -> tuple[int, str, str]:
    """Run a single command. Returns (rc, stdout, stderr)."""
    c = _client()
    try:
        stdin, stdout, stderr = c.exec_command(cmd, timeout=timeout, get_pty=False)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        rc = stdout.channel.recv_exit_status()
        if check and rc != 0:
            raise RuntimeError(f"cmd failed rc={rc}\nstdout={out}\nstderr={err}")
        return rc, out, err
    finally:
        c.close()


def put(local: str, remote: str):
    c = _client()
    try:
        sftp = c.open_sftp()
        sftp.put(local, remote)
        sftp.close()
    finally:
        c.close()


def write_remote(remote_path: str, content: str):
    """Write a string to a remote file."""
    c = _client()
    try:
        sftp = c.open_sftp()
        with sftp.open(remote_path, "w") as f:
            f.write(content)
        sftp.close()
    finally:
        c.close()


if __name__ == "__main__":
    cmd = " ".join(sys.argv[1:]) or "uname -a"
    rc, out, err = sh(cmd)
    print(f"[rc={rc}]")
    if out:
        print("--- stdout ---")
        print(out)
    if err:
        print("--- stderr ---")
        print(err)
