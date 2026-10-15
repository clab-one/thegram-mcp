#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import pty
import select
import shutil
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--state', required=True)
parser.add_argument('--evidence', required=True)
args = parser.parse_args()
state = json.loads(Path(args.state).read_text())
origin = urllib.parse.urlsplit(state['server'])
assert origin.scheme == 'http' and origin.hostname in ('127.0.0.1', '::1') and not origin.username and not origin.query and not origin.fragment
report = Path(args.evidence).resolve()
report.parent.mkdir(parents=True, exist_ok=True)
cli = Path(__file__).resolve().parent.parent / 'dist/thegram-memory.mjs'

def account(method, route, body=None):
    request = urllib.request.Request(state['server'] + route, method=method, headers={'Content-Type': 'application/json', 'Cookie': 'vault_session=' + state['cookie'], 'X-CSRF-Token': state['csrf']}, data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(request, timeout=10) as response:
        raw = response.read()
        return json.loads(raw) if raw else None

issued = account('POST', '/v1/me/api-keys', {'name': 'Hidden terminal input E2E', 'vaults': {state['vault']: 'read'}, 'drive': {}})
child, master = None, None
proof = {'passed': False, 'actualTTY': True}
try:
    with tempfile.TemporaryDirectory(prefix='thegram-hidden-tty-') as config:
        environment = {key: value for key, value in os.environ.items() if key not in ('THEGRAM_API_KEY', 'THEGRAM_MCP_URL', 'THEGRAM_MCP_MOUNT', 'NODE_OPTIONS')}
        environment['XDG_CONFIG_HOME'] = config
        master, slave = pty.openpty()
        child = subprocess.Popen([shutil.which('node'), str(cli), 'connect', '--url', state['server'] + '/mcp', '--mount', '@mounts/' + state['vault']], stdin=slave, stdout=slave, stderr=slave, env=environment, close_fds=True)
        os.close(slave)
        captured, sent = b'', False
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            readable, _, _ = select.select([master], [], [], max(0, deadline - time.monotonic()))
            if not readable:
                break
            try:
                chunk = os.read(master, 4096)
            except OSError:
                break
            if not chunk:
                break
            captured += chunk
            if not sent:
                os.write(master, issued['key'].encode() + b'\r')
                sent = True
        code = child.wait(timeout=5)
        assert sent and code == 0, 'Real TTY connection did not complete'
        assert issued['key'].encode() not in captured, 'Terminal echoed the secret'
        credentials = Path(config) / 'thegram-memory/connection.json'
        assert credentials.stat().st_mode & 0o777 == 0o600, 'Credential is not private'
        proof.update({'passed': True, 'secretNotEchoed': True, 'credentialMode': '0600', 'exitCode': code, 'inputSentOnFirstTerminalOutput': True})
        print('PASS real TTY hidden-key connection')
finally:
    if child is not None and child.poll() is None:
        child.terminate()
        child.wait(timeout=5)
    if master is not None:
        os.close(master)
    account('DELETE', '/v1/me/api-keys/' + issued['id'])
    report.write_text(json.dumps(proof, indent=2) + '\n')
