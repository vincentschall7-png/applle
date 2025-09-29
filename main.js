const { app, BrowserWindow, ipcMain, session } = require('electron');
const { autoUpdater } = require('electron-updater');
// Use GPU for better FPS
// (Previously disabled; re-enable to improve rendering performance)
const path = require('path');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

// --- LAN chat socket (singleton) ---
const CHAT_PORT = 41234;
const chatSocket = dgram.createSocket('udp4');
chatSocket.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('UDP error', err);
});
chatSocket.on('listening', () => {
  try { chatSocket.setBroadcast(true); } catch (_) {}
});
try { chatSocket.bind(CHAT_PORT); } catch (_) {}

function broadcastChatMessage(payload) {
  try {
    const buf = Buffer.from(JSON.stringify(payload));
    chatSocket.send(buf, 0, buf.length, CHAT_PORT, '255.255.255.255');
  } catch (e) {
    // ignore
  }
}

// Relay incoming UDP to all renderer windows
chatSocket.on('message', (msg) => {
  try {
    const data = JSON.parse(String(msg));
    BrowserWindow.getAllWindows().forEach((w) => {
      w.webContents.send('chat:message', data);
    });
  } catch (_) {}
});

/**
 * Creates the main application window with a phone-like size.
 */
function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 390,
    height: 844,
    minWidth: 320,
    minHeight: 568,
    backgroundColor: '#111111',
    frame: false,
    autoHideMenuBar: true,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      backgroundThrottling: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Toggle fullscreen on '0'
  function attachBeforeInput(webContents) {
    if (!webContents || webContents.__hasFSHandler) return;
    webContents.__hasFSHandler = true;
    webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === '0' && !input.alt && !input.control && !input.meta && !input.shift) {
        const isFs = mainWindow.isFullScreen();
        mainWindow.setFullScreen(!isFs);
        event.preventDefault();
      }
    });
  }
  attachBeforeInput(mainWindow.webContents);

  return mainWindow;
}

app.whenReady().then(() => {
  // Reduce Chromium throttling in background/occluded windows for stable FPS
  try {
    app.commandLine.appendSwitch('disable-renderer-backgrounding');
    app.commandLine.appendSwitch('disable-background-timer-throttling');
    app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  } catch {}
  createMainWindow();

  // Auto update check (GitHub provider configured in package.json)
  try {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.checkForUpdatesAndNotify();
  } catch {}

  // Capture key events from any webview/contents to allow '0' fullscreen
  app.on('web-contents-created', (_e, contents) => {
    try {
      const win = BrowserWindow.fromWebContents(contents.hostWebContents || contents);
      if (!win) return;
      contents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === '0' && !input.alt && !input.control && !input.meta && !input.shift) {
          const isFs = win.isFullScreen();
          win.setFullScreen(!isFs);
          event.preventDefault();
        }
      });
    } catch (_) {}
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Window control IPC
ipcMain.handle('win:minimize', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) win.minimize();
});

// Settings IPC (registered once)
ipcMain.handle('settings:get-always-on-top', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  return win ? win.isAlwaysOnTop() : false;
});

ipcMain.handle('settings:set-always-on-top', (e, shouldBeOnTop) => {
  try {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return { ok: false };
    win.setAlwaysOnTop(Boolean(shouldBeOnTop), 'screen-saver');
    return { ok: true, value: win.isAlwaysOnTop() };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});

// Chat IPC
ipcMain.handle('chat:send', (e, payload) => {
  if (!payload || !payload.text) return;
  const msg = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: payload.name || 'Unbekannt',
    text: String(payload.text).slice(0, 2000),
    ts: Date.now()
  };
  // Echo to the sender window immediately so the user sees their own message
  try {
    e.sender.send('chat:message', msg);
  } catch (_) {}
  broadcastChatMessage(msg);
});

ipcMain.handle('win:new', () => {
  createMainWindow();
});

ipcMain.handle('win:toggle-compact', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  const isCompact = win.getSize()[0] <= 320 && win.getSize()[1] <= 620;
  if (isCompact) {
    win.setSize(390, 844);
  } else {
    win.setSize(320, 620);
  }
});

// Close window
ipcMain.handle('win:close', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) win.close();
});

// Toggle fullscreen
ipcMain.handle('win:toggle-fullscreen', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  win.setFullScreen(!win.isFullScreen());
});

// removed open:external handler


// --- Local Whisper STT IPC ---
ipcMain.handle('stt:transcribe', async (_e, payload) => {
  try {
    if (!payload || !payload.data || !payload.ext) {
      return { ok: false, error: 'invalid-audio' };
    }
    const whisperDir = path.join(__dirname, 'whisper');
    const tmpDir = os.tmpdir();
    const tmpBase = 'applle_voice_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const ext = String(payload.ext || 'webm').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'webm';
    const audioPath = path.join(tmpDir, tmpBase + '.' + ext);
    const outDir = path.join(tmpDir, tmpBase + '_out');
    try { fs.mkdirSync(outDir, { recursive: true }); } catch {}

    // Write audio file
    try {
      fs.writeFileSync(audioPath, Buffer.from(payload.data));
    } catch (err) {
      return { ok: false, error: 'write-failed:' + String(err) };
    }

    // Prefer 'python', fallback to 'py' on Windows
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const modelDir = path.join(app.getPath('userData'), 'whisper-models');
    try { fs.mkdirSync(modelDir, { recursive: true }); } catch {}
    const args = ['-m', 'whisper', audioPath, '--language', 'de', '--model', 'tiny', '--model_dir', modelDir, '--fp16', 'False', '--task', 'transcribe', '--verbose', 'False', '--output_format', 'txt', '--output_dir', outDir];
    // Ensure ffmpeg is on PATH for the subprocess (common Windows install paths)
    let envPath = process.env.PATH || '';
    const candidateDirs = [];
    try {
      const user = process.env.USERPROFILE || process.env.HOME || '';
      if (user) {
        candidateDirs.push(
          path.join(user, 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'Scripts'),
          path.join(user, 'AppData', 'Local', 'Programs', 'Python', 'Python310', 'Scripts'),
          path.join(user, 'AppData', 'Local', 'Programs', 'Python', 'Python39', 'Scripts')
        );
      }
      candidateDirs.push('C\\\\ffmpeg\\bin', 'C:\\ffmpeg\\bin');
    } catch {}
    for (const dir of candidateDirs) {
      try { if (dir && fs.existsSync(path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))) { envPath += (process.platform === 'win32' ? ';' : ':') + dir; } } catch {}
    }

    const proc = spawn(pythonCmd, args, { cwd: whisperDir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PATH: envPath } });

    let stderr = '';
    let stdout = '';
    proc.stderr.on('data', (d) => { try { const s = String(d); stderr += s; } catch {} });
    proc.stdout.on('data', (d) => { try { const s = String(d); stdout += s; } catch {} });

    const exitCode = await new Promise((resolve) => {
      proc.on('close', resolve);
      // Safety timeout (longer to allow first-time model download)
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} resolve(124); }, 180000);
    });

    if (exitCode !== 0) {
      const detail = [
        'code=' + exitCode,
        'python=' + pythonCmd,
        'cwd=' + whisperDir,
        'audio=' + audioPath,
        'args=' + JSON.stringify(args),
        'stdout=' + (stdout || '').slice(0, 4000),
        'stderr=' + (stderr || '').slice(0, 4000)
      ].join(' | ');
      return { ok: false, error: 'whisper-failed', detail };
    }

    // Whisper CLI writes <basename>.<ext>.txt. Find the first .txt in outDir
    let transcript = '';
    try {
      const files = fs.readdirSync(outDir).filter((f) => f.toLowerCase().endsWith('.txt'));
      if (files.length) {
        const txt = fs.readFileSync(path.join(outDir, files[0]), 'utf8');
        transcript = String(txt || '').trim();
      }
    } catch {}

    // Cleanup temp files (best-effort)
    try { fs.unlinkSync(audioPath); } catch {}
    try {
      const files = fs.readdirSync(outDir);
      for (const f of files) { try { fs.unlinkSync(path.join(outDir, f)); } catch {} }
      try { fs.rmdirSync(outDir); } catch {}
    } catch {}

    if (!transcript) {
      return { ok: false, error: 'no-transcript' };
    }
    return { ok: true, text: transcript };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});

// --- Reset All: clear storage for all sessions/partitions ---
ipcMain.handle('app:reset-all', async () => {
  try {
    const partitions = [
      'persist:whatsapp',
      'persist:iserv',
      'persist:chatgpt',
      'persist:teams-business',
      'persist:discord'
    ];
    const sessions = [session.defaultSession, ...partitions.map((p) => {
      try { return session.fromPartition(p); } catch (_) { return null; }
    })].filter(Boolean);

    for (const ses of sessions) {
      try { await ses.clearAuthCache(); } catch {}
      try { await ses.clearCache(); } catch {}
      try {
        await ses.clearStorageData({
          storages: ['appcache','cookies','filesystem','indexdb','localstorage','shadercache','websql','serviceworkers','cachestorage','webgpu'],
          quotas: ['temporary','persistent','syncable']
        });
      } catch {}
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});

