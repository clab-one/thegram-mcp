#!/usr/bin/env python3
import argparse
import base64
from contextlib import ExitStack
import hashlib
import http.server
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request


def port():
    with socket.socket() as connection:
        connection.bind(('127.0.0.1', 0))
        return connection.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description='Run the complete coding-agent Cloud E2E against isolated real Vault, Access and Core binaries.')
    for name in ('vaultd', 'accessd', 'core', 'work', 'evidence'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    evidence = Path(args.evidence).resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    work = Path(args.work).resolve()
    work.mkdir(parents=True, exist_ok=True)
    processes, logs = [], []
    identity = None
    owned = None
    result = {'passed': False}

    def stop_resources():
        nonlocal identity
        for child in reversed(processes):
            if child.poll() is None:
                child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=10)
        if identity is not None:
            identity.shutdown()
            identity.server_close()
            identity = None
        for log in logs:
            log.close()
        logs.clear()

    try:
        with ExitStack() as resources:
            temporary = resources.enter_context(tempfile.TemporaryDirectory(prefix='cloud-fixture-', dir=work))
            resources.callback(stop_resources)
            owned = Path(temporary)
            data = owned / 'data'
            for folder in ('auth/users', 'auth/sessions'):
                (data / folder).mkdir(parents=True, mode=0o700)
            for folder in ('hot', 'mcp', 'home'):
                (owned / folder).mkdir(mode=0o700)
            now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            future = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() + 86400))
            accounts = []
            for index in range(2):
                principal = f'u-coding-e2e-{index}'
                cookie, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(24)
                session = hashlib.sha256(cookie.encode()).hexdigest()
                user = {'principal': principal, 'email': f'coding-{index}@example.test', 'name': f'Coding fixture {index}', 'provider': 'email', 'logto_sub': f'coding-sub-{index}', 'created_at': now, 'last_login_at': now}
                signed_in = {'id': session, 'principal': principal, 'created_at': now, 'last_seen_at': now, 'expires_at': future, 'csrf': csrf, 'user_agent': 'Coding E2E fixture'}
                for path, value in ((data / 'auth/users' / (principal + '.json'), user), (data / 'auth/sessions' / (session + '.json'), signed_in)):
                    path.write_text(json.dumps(value))
                    path.chmod(0o600)
                accounts.append({'cookie': cookie, 'csrf': csrf})

            class Identity(http.server.BaseHTTPRequestHandler):
                def do_GET(self):
                    if self.path == '/oidc/.well-known/openid-configuration':
                        body = {'issuer': issuer + '/oidc', 'authorization_endpoint': issuer + '/authorize', 'token_endpoint': issuer + '/oidc/token', 'jwks_uri': issuer + '/jwks', 'end_session_endpoint': issuer + '/logout'}
                    elif self.path == '/jwks':
                        body = {'keys': []}
                    else:
                        self.send_error(404)
                        return
                    raw = json.dumps(body).encode()
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Content-Length', str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)

                def log_message(self, *_):
                    pass

            identity = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Identity)
            issuer = f'http://127.0.0.1:{identity.server_port}'
            threading.Thread(target=identity.serve_forever, daemon=True).start()
            server, access = f'http://127.0.0.1:{port()}', f'http://127.0.0.1:{port()}'
            common = {'PATH': os.environ['PATH'], 'HOME': str(owned / 'home'), 'TMPDIR': str(owned / 'hot')}
            token = secrets.token_urlsafe(32)
            access_env = {**common, 'THEGRAM_ACCESS_ADDR': access.removeprefix('http://'), 'THEGRAM_ACCESS_DATA_DIR': str(owned / 'access'), 'THEGRAM_ACCESS_TOKEN': token, 'THEGRAM_ACCESS_KEK': base64.b64encode(secrets.token_bytes(32)).decode()}
            vault_env = {**common, 'GRAM_VAULT_DATA_DIR': str(data), 'GRAM_VAULT_ADDR': server.removeprefix('http://'), 'GRAM_VAULT_PUBLIC_URL': server, 'GRAM_VAULT_SECRET_KEY': base64.b64encode(secrets.token_bytes(32)).decode(), 'GRAM_VAULT_KEK': base64.b64encode(secrets.token_bytes(32)).decode(), 'GRAM_CORE_BIN': str(Path(args.core).resolve()), 'GRAM_VAULT_GOOGLE_CLIENT_ID': 'local', 'GRAM_VAULT_GOOGLE_CLIENT_SECRET': 'local', 'GRAM_VAULT_OIDC_ISSUER': issuer + '/oidc', 'GRAM_VAULT_OIDC_CLIENT_ID': 'web', 'GRAM_VAULT_OIDC_CLIENT_SECRET': 'local', 'GRAM_VAULT_LOGTO_ENDPOINT': issuer, 'GRAM_VAULT_LOGTO_M2M_ID': 'local', 'GRAM_VAULT_LOGTO_M2M_SECRET': 'local', 'GRAM_VAULT_API_RESOURCE': server + '/api', 'GRAM_VAULT_MCP_RESOURCE': server + '/mcp', 'GRAM_VAULT_ACCESS_URL': access, 'GRAM_VAULT_ACCESS_TOKEN': token, 'GRAM_VAULT_CREATOR_EMAILS': 'coding-0@example.test,coding-1@example.test', 'GRAM_VAULT_UNLIMITED_EMAILS': 'coding-0@example.test,coding-1@example.test', 'GRAM_VAULT_MCP_CACHE_DIR': str(owned / 'mcp')}
            vault_log = (evidence / 'vaultd.log').open('w')
            access_log = (evidence / 'accessd.log').open('w')
            logs.extend((vault_log, access_log))
            preflight = subprocess.Popen([str(Path(args.vaultd).resolve()), 'serve'], env=vault_env, stdout=vault_log, stderr=vault_log)
            processes.append(preflight)
            try:
                preflight.wait(timeout=10)
            except subprocess.TimeoutExpired:
                preflight.terminate()
                preflight.wait(timeout=10)
            if preflight.returncode not in (0, -15):
                vault_log.flush()
                if 'unsupported vault layout marker "vaultd-layout 2\\n"' not in (evidence / 'vaultd.log').read_text():
                    raise RuntimeError('Vault bootstrap failed unexpectedly; inspect retained vaultd.log')
                subprocess.run([str(Path(args.vaultd).resolve()), 'migrate-encrypt', str(data)], env=vault_env, stdout=vault_log, stderr=vault_log, check=True)
            for binary, env, log, origin in ((args.accessd, access_env, access_log, access), (args.vaultd, vault_env, vault_log, server)):
                child = subprocess.Popen([str(Path(binary).resolve()), 'serve'], env=env, stdout=log, stderr=log)
                processes.append(child)
                deadline = time.monotonic() + 30
                while True:
                    if child.poll() is not None:
                        raise RuntimeError(f'{Path(binary).name} exited during fixture startup; inspect retained logs')
                    try:
                        with urllib.request.urlopen(origin + '/healthz', timeout=1) as response:
                            if response.status == 200:
                                break
                    except (OSError, TimeoutError):
                        pass
                    if time.monotonic() >= deadline:
                        raise RuntimeError(f'{Path(binary).name} did not become ready')
                    time.sleep(0.05)
            state = owned / 'state.json'
            state.write_text(json.dumps({'server': server, 'accounts': accounts, 'git_home': os.environ.get('HOME', str(Path.home())), **accounts[0]}))
            state.chmod(0o600)
            env = {**common, 'THEGRAM_E2E_STATE': str(state), 'THEGRAM_E2E_REPORT': str(evidence / 'report.json')}
            command = ['node', '--experimental-strip-types', str(Path(__file__).with_name('cloud.mjs'))]
            completed = subprocess.run(command, env=env, check=False)
            result.update({'exit_code': completed.returncode, 'passed': completed.returncode == 0})
            if completed.returncode:
                raise RuntimeError('Complete Cloud E2E failed; inspect report.json and server logs')
    except BaseException as error:
        result['error'] = str(error)
        raise
    finally:
        stop_resources()
        result.update({'fixture_directory_removed': owned is None or not owned.exists(), 'fixture_processes_stopped': all(child.poll() is not None for child in processes)})
        (evidence / 'runner.json').write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
