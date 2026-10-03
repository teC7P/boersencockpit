#!/usr/bin/env python3
"""Ver- und entschlüsselt die data.json mit dem Cockpit-Passwort.

Gleiches Format wie die Video-Reports vom Mac (publish.py) und lock.js im
Browser: PBKDF2-SHA256 (600.000 Runden) -> AES-256-CBC + HMAC-SHA256.
Das Passwort kommt aus der Umgebungsvariable COCKPIT_PASSWORD.

Aufruf:
  python scripts/seal.py close site/data.json site/data.enc.json
  python scripts/seal.py open URL_ODER_PFAD prev.json
"""
import base64
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

ITER = 600_000
b64e = lambda b: base64.b64encode(b).decode()  # noqa: E731
b64d = base64.b64decode


def keys(pw, salt, iters):
    bits = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, iters, 64)
    return bits[:32], bits[32:]


def seal(text, pw):
    salt, iv = os.urandom(16), os.urandom(16)
    aes, mac = keys(pw, salt, ITER)
    p = padding.PKCS7(128).padder()
    data = p.update(text.encode()) + p.finalize()
    enc = Cipher(algorithms.AES(aes), modes.CBC(iv)).encryptor()
    ct = enc.update(data) + enc.finalize()
    tag = hmac.new(mac, iv + ct, "sha256").digest()
    return {"v": 1, "iter": ITER, "salt": b64e(salt), "iv": b64e(iv), "ct": b64e(ct), "mac": b64e(tag)}


def unseal(box, pw):
    iv, ct = b64d(box["iv"]), b64d(box["ct"])
    aes, mac = keys(pw, b64d(box["salt"]), box["iter"])
    if not hmac.compare_digest(hmac.new(mac, iv + ct, "sha256").digest(), b64d(box["mac"])):
        raise ValueError("falsches Passwort")
    dec = Cipher(algorithms.AES(aes), modes.CBC(iv)).decryptor()
    u = padding.PKCS7(128).unpadder()
    return (u.update(dec.update(ct) + dec.finalize()) + u.finalize()).decode()


def read(src):
    if src.startswith("http"):
        req = urllib.request.Request(f"{src}?t={int(time.time())}", headers={"User-Agent": "boersencockpit"})
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.read().decode()
    return Path(src).read_text("utf-8")


def main():
    pw = os.environ.get("COCKPIT_PASSWORD", "")
    if not pw:
        sys.exit("COCKPIT_PASSWORD fehlt")
    cmd, src, dst = sys.argv[1:4]
    if cmd == "close":
        Path(dst).write_text(json.dumps(seal(read(src), pw)), "utf-8")
    elif cmd == "open":
        Path(dst).write_text(unseal(json.loads(read(src)), pw), "utf-8")
    else:
        sys.exit(f"unbekannt: {cmd}")


if __name__ == "__main__":
    main()
