#!/usr/bin/env python3
"""Run the packaged app with isolated state; never touch the installed service."""
import json
import os
from pathlib import Path
import platform
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
APP = Path(os.environ.get('AGENT_REMOTE_TEST_APP', ROOT / 'build/mac/Agent Remote.app'))
force_intel = os.environ.get('AGENT_REMOTE_TEST_ARCH') == 'x86_64'
architecture = 'x64' if force_intel else ('arm64' if platform.machine() == 'arm64' else 'x64')
node = APP / f'Contents/Resources/runtime/{architecture}/bin/node'
admin = APP / 'Contents/Resources/service/desktop/src/admin.mjs'

with tempfile.TemporaryDirectory(prefix='agentremote-app-check-') as directory:
    state = Path(directory)
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0)); port = listener.getsockname()[1]
    environment = dict(os.environ, AGENT_REMOTE_WRAPPER_TEST='1', AGENT_REMOTE_STATE=directory, AGENT_REMOTE_PORT=str(port), NODE_NO_WARNINGS='1', AGENT_REMOTE_TEST_REPORT=str(state / 'interface.json'), AGENT_REMOTE_TEST_SNAPSHOT=str(ROOT / 'build/mac-app-preview.png'))
    agents = state / 'mock-agents'; agents.mkdir()
    for name in ['codex', 'claude']:
        path = agents / name
        path.write_text('#!/bin/sh\ncase "$*" in "login"|"login status"|"auth login"|"auth status") exit 0 ;; *) exit 1 ;; esac\n')
        path.chmod(0o700)
    environment['AGENT_REMOTE_TEST_AGENT_DIR'] = str(agents)
    output = open(state / 'wrapper.log', 'wb')
    command = [str(APP / 'Contents/MacOS/AgentRemote')]
    if force_intel: command = ['/usr/bin/arch', '-x86_64'] + command
    process = subprocess.Popen(command, env=environment, stdout=output, stderr=output)
    status = None
    try:
        deadline = time.time() + 45
        while time.time() < deadline:
            if process.poll() is not None: raise RuntimeError(f'Wrapper exited: {process.returncode}')
            try:
                status = json.loads((state / 'desktop-status.json').read_text())
                if status['relay'] == 'connected' and status['port'] == port: break
            except (FileNotFoundError, json.JSONDecodeError): pass
            time.sleep(0.3)
        else: raise RuntimeError('Packaged service did not connect to the relay.')
        try:
            urllib.request.urlopen(f'http://127.0.0.1:{port}/health')
            raise RuntimeError('Service unexpectedly accepted an unauthenticated API request.')
        except urllib.error.HTTPError as error:
            assert error.code == 401
        print('Native app launched its bundled Node service and connected to the public relay.', flush=True)
        report_deadline = time.time() + 80
        while time.time() < report_deadline:
            try:
                report = json.loads((state / 'interface.json').read_text())
                if report.get('error'): raise RuntimeError(report['error'])
                assert report.get('pairingUI') and report.get('closeKeepsRunning') and report.get('stopAndRestart') and report.get('signInCommandRouting')
                print('Native QR view, closing the window, stop/restart, and sign-in command routing passed.', flush=True)
                if report.get('loginItemUnregistered'): print(f"Login item registered (status {report['loginItemStatus']}) and unregistered successfully.", flush=True)
                break
            except (FileNotFoundError, json.JSONDecodeError): time.sleep(0.3)
        else: raise RuntimeError('Native interface checks did not finish.')
        status = json.loads((state / 'desktop-status.json').read_text())
        invite = subprocess.check_output([node, admin, 'pair-code'], env=environment)
        invite_file = state / 'invitation'; invite_file.write_bytes(invite); invite_file.chmod(0o600)
        subprocess.run([ROOT / 'build/mac-wrapper-relay-smoke', invite_file], check=True)
        # Simulate an app crash: the service must notice its parent has gone away.
        process.kill(); process.wait(timeout=10)
        deadline = time.time() + 10
        while time.time() < deadline:
            if not (state / 'desktop-status.json').exists(): break
            time.sleep(0.2)
        else: raise RuntimeError('Service did not clean up after its parent exited.')
        print('Bundled service cleaned up after wrapper exit. Existing Mac service was untouched.', flush=True)
    finally:
        if process.poll() is None:
            process.terminate()
            try: process.wait(timeout=10)
            except subprocess.TimeoutExpired: process.kill(); process.wait()
        if status:
            try: os.kill(status['pid'], signal.SIGTERM)
            except ProcessLookupError: pass
        output.close()
