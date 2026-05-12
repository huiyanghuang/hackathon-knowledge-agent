"""Tiny SSH helper for Vultr deployment. Usage:
    python -c "from deploy.ssh_helper import sh; print(sh('ls /'))"
"""
import os
import sys

import paramiko

HOST = "149.28.235.226"
USER = "root"
PASS = os.environ.get("VULTR_PASS", "Y$a6yeRL(qadthzo")


def _client():
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
