"""A private fake internet for browser tests.

The site rules match on real hostnames (claude.ai, github.com, ...), so a page
on localhost exercises nothing. This serves pages AT those names: a local
HTTPS proxy terminates TLS with a leaf certificate from a throwaway CA that
only the test profile trusts, and answers from a Python callback. Any host
without a handler is refused, so a test never touches the real network.

    net = FakeNet(hosts, handler)      # handler(host, path, query) -> (status, ctype, body)
    net.start(); net.prefs()           # proxy prefs for the profile; net.ca_b64 to trust
"""
import base64, os, socket, ssl, subprocess, threading, urllib.parse

CERTS = "/tmp/claude-1000/fakenet-certs"


def _openssl(*args):
    subprocess.run(["openssl", *args], check=True, capture_output=True)


def make_certs(hosts):
    """One CA and one leaf covering every host (and www.), cached by host set."""
    os.makedirs(CERTS, exist_ok=True)
    tag = str(abs(hash(tuple(sorted(hosts)))))
    ca_key, ca_crt = f"{CERTS}/ca.key", f"{CERTS}/ca.crt"
    leaf_key, leaf_crt = f"{CERTS}/leaf-{tag}.key", f"{CERTS}/leaf-{tag}.crt"
    if not os.path.exists(ca_crt):
        _openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30",
                 "-keyout", ca_key, "-out", ca_crt, "-subj", "/CN=zen fakenet test CA",
                 "-addext", "basicConstraints=critical,CA:TRUE",
                 "-addext", "keyUsage=critical,keyCertSign,cRLSign")
    if not os.path.exists(leaf_crt):
        san = ",".join(f"DNS:{h},DNS:www.{h}" for h in sorted(hosts))
        ext = f"{CERTS}/leaf-{tag}.ext"
        with open(ext, "w") as f:
            f.write(f"subjectAltName={san}\nextendedKeyUsage=serverAuth\n"
                    "basicConstraints=CA:FALSE\n")
        csr = f"{CERTS}/leaf-{tag}.csr"
        _openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", leaf_key,
                 "-out", csr, "-subj", "/CN=zen fakenet")
        _openssl("x509", "-req", "-in", csr, "-CA", ca_crt, "-CAkey", ca_key,
                 "-CAcreateserial", "-days", "30", "-out", leaf_crt, "-extfile", ext)
    with open(ca_crt) as f:
        pem = f.read()
    b64 = "".join(l for l in pem.splitlines() if "CERTIFICATE" not in l)
    return leaf_crt, leaf_key, b64


class FakeNet:
    def __init__(self, hosts, handler):
        self.hosts = set(hosts) | {f"www.{h}" for h in hosts}
        self.handler = handler
        leaf_crt, leaf_key, self.ca_b64 = make_certs(hosts)
        self.ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        self.ctx.load_cert_chain(leaf_crt, leaf_key)
        self.sock = socket.socket()
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.port = self.sock.getsockname()[1]
        self.refused = set()

    def prefs(self):
        p = self.port
        return (
            'user_pref("network.proxy.type", 1);\n'
            f'user_pref("network.proxy.ssl", "127.0.0.1");\nuser_pref("network.proxy.ssl_port", {p});\n'
            f'user_pref("network.proxy.http", "127.0.0.1");\nuser_pref("network.proxy.http_port", {p});\n'
            'user_pref("network.proxy.no_proxies_on", "");\n'
            'user_pref("network.proxy.allow_hijacking_localhost", true);\n'
            'user_pref("network.trr.mode", 5);\n'
        )

    def start(self):
        self.sock.listen(64)
        threading.Thread(target=self._accept, daemon=True).start()
        return self

    def _accept(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self._client, args=(conn,), daemon=True).start()

    def _client(self, conn):
        try:
            f = conn.makefile("rb")
            line = f.readline().decode("latin1")
            while f.readline() not in (b"\r\n", b"\n", b""):
                pass
            method, target, _ = (line.split(" ", 2) + ["", ""])[:3]
            if method != "CONNECT":
                conn.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
                return
            host = target.rsplit(":", 1)[0]
            if host not in self.hosts:
                self.refused.add(host)
                conn.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
                return
            conn.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
            tls = self.ctx.wrap_socket(conn, server_side=True)
            self._serve(tls, host.removeprefix("www."))
        except (OSError, ssl.SSLError, ValueError):
            pass
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def _serve(self, tls, host):
        f = tls.makefile("rb")
        while True:
            line = f.readline().decode("latin1")
            if not line:
                return
            length = 0
            while True:
                h = f.readline()
                if h in (b"\r\n", b"\n", b""):
                    break
                k, _, v = h.decode("latin1").partition(":")
                if k.lower() == "content-length":
                    length = int(v.strip())
            if length:
                f.read(length)
            _, target, _ = line.split(" ", 2)
            u = urllib.parse.urlsplit(target)
            status, ctype, body = self.handler(host, u.path, urllib.parse.parse_qs(u.query))
            if isinstance(body, str):
                body = body.encode()
            tls.sendall((f"HTTP/1.1 {status} OK\r\nContent-Type: {ctype}\r\n"
                         f"Content-Length: {len(body)}\r\nCache-Control: no-store\r\n\r\n").encode() + body)
