const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

function waitForPort(host, port, timeoutMs = 45000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = net.createConnection({ host, port });
      const fail = () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting for port'));
        setTimeout(tryOnce, 250);
      };
      sock.once('error', fail);
      sock.once('connect', () => { sock.end(); resolve(true); });
    };
    tryOnce();
  });
}
async function isPortOpen(port) {
  try { await waitForPort('127.0.0.1', port, 500); return true; } catch { return false; }
}

function platformFolder() {
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'win32') return 'win';
  return 'linux';
}
function torBinaryName() {
  return process.platform === 'win32' ? 'tor.exe' : 'tor';
}

class TorManager {
  constructor(app) {
    this.app = app;
    this.proc = null;
    this.port = 9050;
    this.dataDir = path.join(app.getPath('userData'), 'tor-data');
    this.ready = false;
  }

  _candidatePaths() {
    const plat = platformFolder();
    const bin = torBinaryName();
    const list = [];

    // 1) Bundled inside the packed app
    if (process.resourcesPath) {
      list.push(path.join(process.resourcesPath, 'tor', plat, bin));
    }
    // 2) Dev tree vendor path
    const projectRoot = path.join(this.app.getAppPath(), '..'); // app/ -> project root
    list.push(path.join(projectRoot, 'vendor', 'tor', plat, bin));

    // 3) PATH fallback
    list.push(bin);

    return list;
  }

  _envFor(dir) {
    const env = { ...process.env };
    if (process.platform === 'darwin') {
      env.DYLD_LIBRARY_PATH = (dir + (env.DYLD_LIBRARY_PATH ? (':' + env.DYLD_LIBRARY_PATH) : ''));
    } else if (process.platform === 'linux') {
      env.LD_LIBRARY_PATH = (dir + (env.LD_LIBRARY_PATH ? (':' + env.LD_LIBRARY_PATH) : ''));
    } else if (process.platform === 'win32') {
      env.PATH = (dir + (env.PATH ? (';' + env.PATH) : ''));
    }
    return env;
  }

  _resolveTorBinary() {
    const candidates = this._candidatePaths();
    for (const p of candidates) {
      try {
        if (p.includes(path.sep)) { // absolute or relative path
          if (fs.existsSync(p)) return p;
        } else {
          // 'tor' on PATH: let spawn resolve it later
          return p;
        }
      } catch {}
    }
    return 'tor';
  }

  async startAndWait(onProgress) {
    const report = (pct, msg) => { try { onProgress && onProgress(pct, msg); } catch {} };

    // Use existing listener if present
    if (await isPortOpen(this.port)) {
      this.ready = true;
      report(100, 'existing tor');
      return true;
    }

    fs.mkdirSync(this.dataDir, { recursive: true });
    const torBin = this._resolveTorBinary();
    const binDir = path.dirname(torBin);

    // Check executability if we control the file path (not bare 'tor')
    if (torBin.includes(path.sep)) {
      try { fs.accessSync(torBin, fs.constants.X_OK); } catch (e) {
        report(-1, 'binary not executable');
        throw new Error('Tor binary missing or not executable at ' + torBin);
      }
    }

    const args = [
      '--DataDirectory', this.dataDir,
      '--SocksPort', `${this.port} IsolateSOCKSAuth`,
      '--ExitPolicy', 'reject *:*',
      '--ClientUseIPv6', '1',
      '--Log', 'notice stdout'
    ];

    const env = torBin.includes(path.sep) ? this._envFor(binDir) : process.env;

    this.ready = false;
    this.proc = spawn(torBin, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    this.proc.once('exit', () => { this.proc = null; this.ready = false; });
    this.proc.on('error', () => { this.ready = false; });

    this.proc.stdout?.setEncoding('utf8');
    this.proc.stdout?.on('data', (chunk) => {
      const lines = String(chunk).split('\n');
      for (const l of lines) {
        const m = l.match(/Bootstrapped\s+(\d+)%\s*\(([^)]+)\)/i);
        if (m) { const pct = parseInt(m[1], 10); const msg = m[2]; report(pct, msg); }
      }
    });

    await waitForPort('127.0.0.1', this.port, 45000);
    this.ready = true;
    report(100, 'done');
    return true;
  }

  stop() {
    this.ready = false;
    if (this.proc) { try { this.proc.kill(); } catch {} this.proc = null; }
  }

  isRunning() { return !!this.proc || this.ready; }
  isReady() { return !!this.ready; }
  proxyRules() { return `socks5://127.0.0.1:${this.port}`; }
}

module.exports = { TorManager };
