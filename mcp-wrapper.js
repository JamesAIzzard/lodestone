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
const { spawn } = require('child_process');
const path = require('path');

const electronPath = path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe');
const entryPath = path.join(__dirname, '.vite', 'build', 'main.js');

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
  child = spawn(electronPath, [entryPath, '--mcp', `--ipc-path=${pipePath}`], {
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
  }
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.stdin.on('end', cleanup);
