/**
 * MCP stdio wrapper for Lodestone.
 *
 * Electron is a GUI app and cannot receive piped stdin on Windows
 * (electron/electron#4218). This wrapper bridges the gap:
 *
 *   Claude Desktop  <─── stdio ───>  mcp-wrapper.js  <─── named pipe ───>  Electron
 *
 * The wrapper:
 *   1. Creates a Windows named pipe
 *   2. Spawns Electron with --mcp --ipc-path=<pipe>
 *   3. Relays stdin/stdout (MCP protocol) ↔ named pipe (Electron)
 *   4. Electron's actual stdout/stderr go to the wrapper's stderr (debug logs)
 *
 * Works in two modes:
 *
 *   Development — run from the project root:
 *     Uses node_modules/electron and .vite/build/main.js
 *
 *   Production — run from an installed Squirrel app:
 *     Finds the installed Lodestone.exe under %LOCALAPPDATA%\Lodestone\app-*\
 *     (No entry path needed — the ASAR is loaded automatically by Electron)
 *
 * Claude Desktop config (claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "lodestone": {
 *         "command": "node",
 *         "args": ["C:\\Users\\james\\Documents\\lodestone\\mcp-wrapper.js"]
 *       }
 *     }
 *   }
 */

const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

// ── Resolve Electron binary ──────────────────────────────────────────────────
// Try the installed Squirrel app first, fall back to the dev tree.

function findInstalledElectron() {
  const installDir = path.join(process.env.LOCALAPPDATA || '', 'Lodestone');
  if (!fs.existsSync(installDir)) return null;

  // Squirrel puts each version in app-x.x.x/ — find the latest one
  const appDirs = fs.readdirSync(installDir)
    .filter((d) => d.startsWith('app-'))
    .sort();

  if (appDirs.length === 0) return null;

  const latestApp = appDirs[appDirs.length - 1];
  const exePath = path.join(installDir, latestApp, 'Lodestone.exe');
  return fs.existsSync(exePath) ? exePath : null;
}

const installedPath = findInstalledElectron();
const devElectronPath = path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe');
const devEntryPath = path.join(__dirname, '.vite', 'build', 'main.js');

let electronPath, spawnArgs;

if (installedPath) {
  // Production: Electron loads app.asar automatically — no entry path needed
  electronPath = installedPath;
  spawnArgs = (pipePath) => ['--mcp', `--ipc-path=${pipePath}`];
  process.stderr.write(`[mcp-wrapper] using installed: ${installedPath}\n`);
} else {
  // Development: use node_modules/electron with explicit entry
  electronPath = devElectronPath;
  spawnArgs = (pipePath) => [devEntryPath, '--mcp', `--ipc-path=${pipePath}`];
  process.stderr.write(`[mcp-wrapper] using dev: ${devElectronPath}\n`);
}

// Generate a unique named pipe path for this session
const pipeId = crypto.randomBytes(4).toString('hex');
const pipePath = `\\\\.\\pipe\\lodestone-mcp-${pipeId}`;

let child = null;
let electronSocket = null;

// ── Named pipe server ────────────────────────────────────────────────────────
// Electron connects here. Once connected, we relay MCP traffic bidirectionally.

const ipcServer = net.createServer((socket) => {
  electronSocket = socket;
  process.stderr.write(`[mcp-wrapper] Electron connected via named pipe\n`);

  // Relay: Claude Desktop stdin → named pipe → Electron
  process.stdin.pipe(socket);

  // Relay: Electron → named pipe → Claude Desktop stdout
  socket.pipe(process.stdout);

  socket.on('error', (err) => {
    process.stderr.write(`[mcp-wrapper] pipe error: ${err.message}\n`);
  });

  socket.on('close', () => {
    process.stderr.write(`[mcp-wrapper] pipe closed\n`);
    cleanup();
  });
});

ipcServer.listen(pipePath, () => {
  process.stderr.write(`[mcp-wrapper] listening on ${pipePath}\n`);

  // Spawn Electron — stdin is ignored (we use the named pipe instead)
  child = spawn(electronPath, spawnArgs(pipePath), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Redirect Electron's stdout to stderr (catches Chromium native noise)
  child.stdout.on('data', (chunk) => {
    process.stderr.write(chunk);
  });

  // Forward Electron's stderr as-is (debug/log output)
  child.stderr.pipe(process.stderr);

  child.on('exit', (code) => {
    process.stderr.write(`[mcp-wrapper] Electron exited with code ${code}\n`);
    cleanup();
  });

  child.on('error', (err) => {
    process.stderr.write(`[mcp-wrapper] spawn error: ${err.message}\n`);
    cleanup();
  });
});

// ── Lifecycle ────────────────────────────────────────────────────────────────

let exiting = false;

function cleanup() {
  if (exiting) return;
  exiting = true;

  if (electronSocket) {
    electronSocket.destroy();
  }
  ipcServer.close();
  if (child && !child.killed) {
    child.kill();

    // On Windows, child.kill() sends SIGTERM which may not terminate a GUI
    // process promptly. If the child is still alive after 3 s, force-kill it.
    setTimeout(() => {
      try {
        process.kill(child.pid, 0); // throws if already dead
        process.stderr.write(`[mcp-wrapper] Electron still alive — force-killing PID ${child.pid}\n`);
        process.kill(child.pid, 'SIGKILL');
      } catch {
        // Already exited — nothing to do
      }
      process.exit(0);
    }, 3000).unref();

    // Exit immediately once the child exits (don't wait for the full 3 s)
    child.once('exit', () => process.exit(0));
    return;
  }
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.stdin.on('end', cleanup);

// Ensure cleanup runs even if the process is about to exit without an explicit
// cleanup trigger (e.g. parent terminated us and Node is winding down).
process.on('exit', () => {
  if (!exiting && child && !child.killed) {
    try { child.kill(); } catch { /* best-effort */ }
  }
});
