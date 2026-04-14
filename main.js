const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const chokidar = require('chokidar');
const fs = require('fs');
const os = require('os');

const LOG_DIR    = process.env.AGENT_LOG_DIR    || path.join(os.homedir(), 'agents', 'logs');
const EVENT_DIR  = process.env.AGENT_EVENT_DIR  || path.join(os.homedir(), 'agents', 'events');
const VAULT_DIR  = process.env.OBSIDIAN_VAULT   || path.join(os.homedir(), 'Ocean', 'Obsidian NueroMechanical Mesh', 'aIrZdOwN BLAK Mesh');

// Agent definitions — which logs they own and what patterns mean what
const AGENTS = {
  aria: {
    name: 'ARIA', role: 'Assistant',
    logs: ['assistant.log'],
    workPattern: /POST \/ask|processing|request/i,
    errorPattern: /500|error|fail/i,
    completePattern: /complete|done|success/i,
    commsTarget: null
  },
  orca: {
    name: 'ORCA', role: 'Orchestrator',
    logs: ['orchestrator.log'],
    workPattern: /Event:|routing|→|handling/i,
    errorPattern: /escalate|critical|fail/i,
    completePattern: /resolved|complete/i,
    commsTarget: 'vita'
  },
  vita: {
    name: 'VITA', role: 'Health Monitor',
    logs: ['health.log'],
    workPattern: /health check|checking|monitoring/i,
    errorPattern: /critical|unreachable|down/i,
    completePattern: /complete|ok|healthy/i,
    commsTarget: 'orca'
  },
  tidy: {
    name: 'TIDY', role: 'Disk Cleanup',
    logs: ['disk.log'],
    workPattern: /cleanup|cleaning|checking/i,
    errorPattern: /error|fail|critical/i,
    completePattern: /complete|ok/i,
    commsTarget: null
  },
  wade: {
    name: 'WADE', role: 'Kodi Guard',
    logs: ['kodi.log'],
    workPattern: /watchdog|restart|checking/i,
    errorPattern: /down|fail|error/i,
    completePattern: /running|ok|restarted/i,
    commsTarget: 'orca'
  },
  scribe: {
    name: 'SCRIBE', role: 'Vault Keeper',
    logs: ['obsidian.log'],
    workPattern: /vault watch|new:|modified:/i,
    errorPattern: /not found|error/i,
    completePattern: /complete|no changes/i,
    commsTarget: 'aria'
  }
};

// Install logs → ARIA gets credit
const INSTALL_LOG_PATTERN = /^install-\d+\.log$/;

let mainWindow;
let logSizes = {};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1200,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    title: 'Agent Office',
    backgroundColor: '#1a1208',
    show: false
  });

  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

function detectAgentFromLog(filename) {
  if (INSTALL_LOG_PATTERN.test(filename)) return 'aria';
  for (const [id, agent] of Object.entries(AGENTS)) {
    if (agent.logs.includes(filename)) return id;
  }
  return null;
}

function classifyLine(agentId, line) {
  const agent = AGENTS[agentId];
  if (!agent) return null;
  if (agent.errorPattern.test(line)) return 'alert';
  if (agent.completePattern.test(line)) return 'complete';
  if (agent.workPattern.test(line)) return 'working';
  return 'working'; // any new log line = they're doing something
}

function startWatching() {
  if (!fs.existsSync(LOG_DIR)) return;

  // Watch for new/changed log files
  const watcher = chokidar.watch(LOG_DIR, {
    persistent: true,
    ignoreInitial: true,
    usePolling: true,
    interval: 500
  });

  watcher.on('change', (filepath) => {
    const filename = path.basename(filepath);
    const agentId = detectAgentFromLog(filename);
    if (!agentId) return;

    // Read only the new bytes
    let newContent = '';
    try {
      const stat = fs.statSync(filepath);
      const prevSize = logSizes[filepath] || 0;
      if (stat.size <= prevSize) return;

      const buf = Buffer.alloc(stat.size - prevSize);
      const fd = fs.openSync(filepath, 'r');
      fs.readSync(fd, buf, 0, buf.length, prevSize);
      fs.closeSync(fd);
      logSizes[filepath] = stat.size;
      newContent = buf.toString('utf8');
    } catch (e) { return; }

    const lines = newContent.split('\n').filter(l => l.trim());
    if (!lines.length) return;

    // Use the last meaningful line to classify state
    const lastLine = lines[lines.length - 1];
    const state = classifyLine(agentId, lastLine);
    const agent = AGENTS[agentId];

    const event = {
      agentId,
      state,
      message: lastLine.substring(0, 120),
      commsTarget: state === 'working' ? agent.commsTarget : null,
      timestamp: Date.now()
    };

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent-event', event);
    }
  });

  watcher.on('add', (filepath) => {
    const filename = path.basename(filepath);
    if (INSTALL_LOG_PATTERN.test(filename)) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('agent-event', {
          agentId: 'aria',
          state: 'working',
          message: 'Starting installation research...',
          commsTarget: null,
          timestamp: Date.now()
        });
      }
    }
    try { logSizes[filepath] = fs.statSync(filepath).size; } catch(e) {}
  });

  // Init sizes
  try {
    fs.readdirSync(LOG_DIR).forEach(f => {
      const fp = path.join(LOG_DIR, f);
      try { logSizes[fp] = fs.statSync(fp).size; } catch(e) {}
    });
  } catch(e) {}

  // Watch events dir for obsidian_change_* files → wake SCRIBE
  const eventDir = EVENT_DIR;
  if (!fs.existsSync(eventDir)) { try { fs.mkdirSync(eventDir, { recursive: true }); } catch(e) {} }
  const evtWatcher = chokidar.watch(eventDir, {
    persistent: true, ignoreInitial: true, usePolling: true, interval: 800
  });
  evtWatcher.on('add', (filepath) => {
    const fname = path.basename(filepath);
    if (fname.startsWith('obsidian_change_')) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('agent-event', {
          agentId: 'scribe', state: 'working',
          message: 'New note detected in vault', commsTarget: 'aria', timestamp: Date.now()
        });
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('agent-event', {
              agentId: 'scribe', state: 'complete',
              message: 'Note indexed ✓', commsTarget: null, timestamp: Date.now()
            });
          }
        }, 4000);
      }
      try { fs.unlinkSync(filepath); } catch(e) {}
    }
  });

  // Watch vault .md files directly for real-time note changes
  if (fs.existsSync(VAULT_DIR)) {
    const vaultWatcher = chokidar.watch(path.join(VAULT_DIR, '**/*.md'), {
      persistent: true, ignoreInitial: true, usePolling: true, interval: 2000,
      ignored: /.obsidian/
    });
    const sendScribeEvent = (fname, verb) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('agent-event', {
          agentId: 'scribe', state: 'working',
          message: `${verb}: ${path.basename(fname, '.md')}`, commsTarget: 'aria', timestamp: Date.now()
        });
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('agent-event', {
              agentId: 'scribe', state: 'complete',
              message: 'Indexed ✓', commsTarget: null, timestamp: Date.now()
            });
          }
        }, 3000);
      }
    };
    vaultWatcher.on('add',    fp => sendScribeEvent(fp, 'New note'));
    vaultWatcher.on('change', fp => sendScribeEvent(fp, 'Updated'));
  }
}

app.whenReady().then(() => {
  createWindow();
  startWatching();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
