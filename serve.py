#!/usr/bin/env python3
"""로컬 HTTPS 개발 서버.

아이패드 Safari는 HTTPS(또는 localhost)에서만 카메라를 허용합니다.
같은 Wi-Fi의 아이패드에서 테스트하려면 이 스크립트로 자체 서명 인증서를 만들어 HTTPS로 서빙하세요.

    python3 serve.py            # https://0.0.0.0:8443
    python3 serve.py 9000       # 포트 변경
    python3 serve.py --http     # 인증서 없이 HTTP (localhost 테스트용)

아이패드에서 https://<컴퓨터 IP>:8443 접속 후 인증서 경고를 "계속" 하면 됩니다.
"""
import http.server
import os
import socket
import ssl
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
CERT_DIR = os.path.join(ROOT, '.certs')
CERT = os.path.join(CERT_DIR, 'dev.crt')
KEY = os.path.join(CERT_DIR, 'dev.key')


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.webmanifest': 'application/manifest+json',
        '.svg': 'image/svg+xml',
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):  # 조용한 로그
        sys.stderr.write('%s %s\n' % (self.address_string(), fmt % args))


def ensure_cert():
    if os.path.exists(CERT) and os.path.exists(KEY):
        return True
    os.makedirs(CERT_DIR, exist_ok=True)
    try:
        subprocess.run([
            'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '825',
            '-keyout', KEY, '-out', CERT, '-subj', '/CN=puck-trainer.local',
            '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:%s' % local_ip(),
        ], check=True, capture_output=True)
        return True
    except (OSError, subprocess.CalledProcessError) as e:
        print('인증서 생성 실패 (openssl 필요):', e, file=sys.stderr)
        return False


def local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        return s.getsockname()[0]
    except OSError:
        return '127.0.0.1'
    finally:
        s.close()


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    use_http = '--http' in sys.argv
    port = int(args[0]) if args else (8080 if use_http else 8443)
    httpd = http.server.ThreadingHTTPServer(('0.0.0.0', port), Handler)
    scheme = 'http'
    if not use_http and ensure_cert():
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(CERT, KEY)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        scheme = 'https'
    print('퍽 드리블 트레이너 개발 서버')
    print('  로컬:   %s://localhost:%d' % (scheme, port))
    print('  아이패드: %s://%s:%d' % (scheme, local_ip(), port))
    if scheme == 'https':
        print('  (자체 서명 인증서 경고가 뜨면 "세부사항 보기 > 웹사이트 방문"으로 계속하세요)')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
