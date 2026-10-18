// desktop-shell v2 — 「桌面星穹浮层」主进程
// 透明 · 无边框 · 全屏 · 光标轮询分区点击穿透 · 本机 HTTP 消息接口 · 状态持久化
const { app, BrowserWindow, ipcMain, screen, shell, dialog, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

/* 统一工作目录: 无论从哪启动(快捷方式 / 注册表 Run 自启 / 命令行), koffi 原生模块解析与相对路径都稳定 */
try { process.chdir(__dirname); } catch (e) { /* ignore */ }

/* Chromium 原生遮挡检测(CalculateNativeWinOcclusion): 桌面层真子窗口(W1)极易被
   Chromium 误判为"被遮挡"而冻结渲染 → 星空定格。必须在 app ready 之前关闭该特性。 */
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

/* ---------------- 原生窗口层级 (koffi → user32!SetWindowPos) ----------------
   本浮层是"桌面层"小组件, 必须永远待在普通应用窗口【之下】。
   实测: 普通窗口被点击/聚焦时 Windows 自动把它抬到最前(Z 序 5 → 1), 全屏透明层于是
   盖住应用 —— 这就是"格子浮到应用界面上边"的根因。
   对策: 每次 focus/blur/show 后主动把它沉回 Z 序最底(HWND_BOTTOM=1), 同时
   SWP_NOACTIVATE 不改变键盘焦点, 所以待办输入框仍能正常打字。
   实测沉底后落在"普通窗口带"最底、仍高于 WorkerW/Progman 桌面带 → 既不遮挡应用,
   也不会掉到壁纸后面。 */
const HWND_BOTTOM = 1;
const SWP_FLAGS = 0x0001 | 0x0002 | 0x0010; // SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE
let setWindowPos = null;
let lowerCount = 0;
try {
  const koffi = require('koffi');
  setWindowPos = koffi.load('user32.dll')
    .func('bool __stdcall SetWindowPos(intptr_t hWnd, intptr_t hWndInsertAfter, int x, int y, int cx, int cy, uint32 uFlags)');
} catch (e) {
  console.warn('[lower] koffi 不可用, 层级保护失效:', e && e.message);
}
/* 防 Win+D (单窗口合并 · 方案甲): 沉底顶层窗被最小化时重新显示并再次沉底。
   绑定独立于 setWindowPos, 任一失败只降级该功能, 不影响层级保护。 */
const SW_SHOWNOACTIVATE = 4;   // ShowWindow: 重新显示但不抢焦点
let isIconic = null;
let showWindow = null;
try {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  isIconic = user32.func('bool __stdcall IsIconic(intptr_t hwnd)');
  showWindow = user32.func('bool __stdcall ShowWindow(intptr_t hwnd, int cmd)');
} catch (e) {
  console.warn('[win+d] koffi 不可用, 防最小化失效:', e && e.message);
}
function nativeHwnd() {
  const buf = win.getNativeWindowHandle();
  return buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
}
function lowerWindow() {
  if (!setWindowPos || !win || win.isDestroyed()) return false;
  try {
    const ok = setWindowPos(nativeHwnd(), BigInt(HWND_BOTTOM), 0, 0, 0, 0, SWP_FLAGS);
    if (ok) lowerCount++;
    return !!ok;
  } catch (e) { return false; }
}
function lowerSoon() { setTimeout(lowerWindow, 0); setTimeout(lowerWindow, 90); }

const APP_NAME = 'desktop-shell';
const APP_VERSION = 5;
const HTTP_PORT = 17650;
const STATE_FILE = path.join(__dirname, 'data', 'state.json');
const PROJECT_DIR = app.getPath('desktop');   // 中性默认(便于分享给别人)

let win = null;
let state = null;
let rects = [];              // [{x,y,w,h}] 屏幕(DIP)坐标, 由渲染进程上报
let forceInteractive = false; // 拖拽/输入框聚焦时强制接收鼠标
let ignoring = null;         // 当前穿透态(null=未设置)
/* 诊断(只增, 不进 state.json): 判断壁纸是否真的在向浮层发轮询请求 */
let httpAnyHits = 0;         // HTTP 收到请求总数
let httpHealthHits = 0;      // /health 命中数
let httpLastAt = 0;          // 最近一次任意请求时间戳
let httpLastHealthAt = 0;    // 最近一次 /health 时间戳
let httpLastUA = '';         // 最近一次请求的 User-Agent(区分 Electron/WebView2/Edge)

/* ---------------- 状态 ---------------- */
function seedState() {
  return {
    version: APP_VERSION,
    cells: [
      { id: 'c0', title: '工作 · 正在工作', kind: 'folder', dynamic: 'working', path: PROJECT_DIR, x: 8, y: 4, w: 300, h: 340 },
    ],
    todos: [],
    messages: [
      { time: Date.now(), level: 'ok', text: '桌面星穹浮层 v2 已就绪（/health 可用）' },
    ],
  };
}
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!raw || !Array.isArray(raw.cells)) throw new Error('bad state');
    state = raw;
  } catch (e) {
    state = seedState();
  }
  migrateState();
  persist();
}
/* 修复被双重转义的反斜杠: c0.path 曾存成 C:\\Users\\... (字面双反斜杠)。
   幂等; 保留 UNC 前缀 \\server\share / \\?\ (前导连续反斜杠归一为 2 个); 已正确的路径原样返回。 */
function fixPath(p) {
  if (typeof p !== 'string' || p.indexOf('\\\\') === -1) return p;   // 没有连续双反斜杠 → 原样
  const m = /^\\+/.exec(p);                                          // 开头的连续反斜杠
  const n = m ? m[0].length : 0;
  const head = n >= 2 ? '\\\\' : (n === 1 ? '\\' : '');               // UNC / \\?\ 前导保留 2 个
  const rest = p.slice(n).replace(/\\{2,}/g, '\\');                  // 其余 2+ 个反斜杠 → 1 个
  return head + rest;
}
/* v2 → v3/v4: 老格子没有 kind 的一律视为镜像文件夹格子; collect 格子补 items 数组; 补默认高 h。
   纯向后兼容: 已有 kind / dynamic / path / url / items 原样保留; 未知键(含 sky)一概不动。 */
function migrateState() {
  if (!Array.isArray(state.cells)) state.cells = [];
  state.cells.forEach(c => {
    if (!c.kind) c.kind = 'folder';
    if (c.kind === 'link') { if (typeof c.url !== 'string') c.url = ''; }
    else if (c.kind === 'collect') { if (!Array.isArray(c.items)) c.items = []; c.items = c.items.map(fixPath); }
    else { c.kind = 'folder'; } // 未知 kind 归一为 folder
    if (typeof c.path === 'string') c.path = fixPath(c.path);
    if (typeof c.h !== 'number' || !isFinite(c.h) || c.h <= 0) c.h = 220;   // 新增: 格子高度, 缺省 220
  });
  if (Array.isArray(state.todos)) state.todos.forEach(t => { if (typeof t.path === 'string') t.path = fixPath(t.path); });
  /* 消息: 显示端只取最近 3 条; 存储端硬上限 50, 丢弃最旧的 */
  if (!Array.isArray(state.messages)) state.messages = [];
  if (state.messages.length > 50) state.messages.length = 50;
  if (!Array.isArray(state.shortcuts)) state.shortcuts = [];   // 工作格子空闲态的快捷方式(网址/软件/文件)
  state.version = APP_VERSION;
}
function persist() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) { /* ignore */ }
}
function pushState() { if (win && !win.isDestroyed()) win.webContents.send('state:changed', state); }
function addMessage(text, level, extra) {
  const m = { time: Date.now(), level: level || 'info', text: String(text == null ? '' : text) };
  if (extra && typeof extra === 'object' && extra.path) m.path = String(extra.path);   // 可点击条目(如新文件提醒)带上路径
  state.messages.unshift(m);
  if (state.messages.length > 50) state.messages.length = 50;
  persist(); pushState();
  return m;
}

/* ---------------- 窗口 + 光标轮询穿透 ---------------- */
function createWindow() {
  const b = screen.getPrimaryDisplay().bounds;
  win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    transparent: true, frame: false, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, hasShadow: false, alwaysOnTop: false, focusable: true,
    show: false, backgroundColor: '#03060f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(false);
  win.loadFile('index.html');
  win.once('ready-to-show', () => { try { win.showInactive(); } catch (e) { win.show(); } lowerSoon(); });

  /* 层级保护: 一旦被激活(点击/聚焦)立刻沉回最底, 全屏透明层不再盖住应用窗口。
     只在 focus/blur/show 时下沉 —— 不设定时器: 实测反复调 HWND_BOTTOM 会让窗口
     持续下沉, 最终掉到壁纸带之后(小组件会看不见)。事件驱动已足够覆盖"激活即抬升"。 */
  win.on('focus', lowerSoon);
  win.on('blur', lowerSoon);
  win.on('show', lowerSoon);

  // 光标轮询: 命中交互矩形才接收鼠标, 否则穿透; 同时把全局光标+是否在UI上喂给渲染进程(星穹悬停用)
  let lastCurX = -1, lastCurY = -1, lastUI = null;
  setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    let hit = forceInteractive;
    if (!hit) {
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) { hit = true; break; }
      }
    }
    if (p.x !== lastCurX || p.y !== lastCurY || hit !== lastUI) {
      lastCurX = p.x; lastCurY = p.y; lastUI = hit;
      try { win.webContents.send('cursor-pos', { x: p.x, y: p.y, ui: hit }); } catch (e) { /* ignore */ }
    }
    const ignore = !hit;
    /* 不再用 {forward:true}: forward 会给窗口加 WS_EX_TRANSPARENT 并把鼠标消息转发给下层,
       导致其下窗口(含任务栏)的悬停多一跳→迟钝。悬停已改由主进程全局光标驱动, 无需转发。 */
    if (ignore !== ignoring) { ignoring = ignore; win.setIgnoreMouseEvents(ignore); }
    /* 防 Win+D (单窗口合并 · 方案甲): 唯一窗口被最小化 → 不抢焦点地重新显示并沉底 (契约 §7.1) */
    if (isIconic && showWindow) {
      try {
        const wh = nativeHwnd();
        if (isIconic(wh)) { showWindow(wh, SW_SHOWNOACTIVATE); lowerWindow(); }
      } catch (e) { /* ignore */ }
    }
  }, 40);   // 光标轮询 40ms (原 30ms): 穿透判定足够跟手, 省下 1/4 的空转唤醒
}

/* ---------------- IPC ---------------- */
function listDir(dir) {
  try {
    const ents = fs.readdirSync(dir, { withFileTypes: true })
      .filter(n => !n.name.startsWith('.'))
      .map(n => ({ name: n.name, isDir: n.isDirectory() }))
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'zh') : a.isDir ? -1 : 1));
    return { ok: true, dir, entries: ents.slice(0, 200), total: ents.length };
  } catch (e) {
    return { ok: false, dir, error: String(e && e.message || e), entries: [] };
  }
}
/* ---------------- 文件图标缓存 (内存 Map + userData/icon-cache 磁盘) ---------------- */
const ICON_MEM = new Map();          // 绝对路径 → dataURL
const ICON_CACHE_VER = 'v5';         // 版本盐: 取图逻辑变了 → 旧缓存文件名不再命中(相当于失效)
function iconDir() { return path.join(app.getPath('userData'), 'icon-cache'); }
function iconFile(p) { return path.join(iconDir(), crypto.createHash('sha1').update(ICON_CACHE_VER + '|' + String(p)).digest('hex') + '.png'); }
/* 展开 %ENV% 形式的环境变量 */
function expandEnv(s) {
  return String(s || '').replace(/%([^%]+)%/g, (m, k) => (process.env[k] != null ? process.env[k] : m));
}
/* 快捷方式的【设计图标】候选来源(按优先级):
   .lnk → IconLocation → target;  .url → IconFile;  最后总是追加原路径。 */
function iconCandidates(p) {
  const out = [];
  const ext = String(path.extname(p) || '').toLowerCase();
  try {
    if (ext === '.lnk' && shell && typeof shell.readShortcutLink === 'function') {
      const l = shell.readShortcutLink(p);
      if (l && l.icon) { const c = expandEnv(l.icon).replace(/,\s*-?\d+\s*$/, ''); if (c) out.push(c); }
      if (l && l.target) out.push(l.target);
    } else if (ext === '.url') {
      const t = fs.readFileSync(p, 'utf8');
      const m = /^[ \t]*IconFile[ \t]*=[ \t]*(.+?)[ \t]*\r?$/im.exec(t);
      if (m) { const c = expandEnv(m[1].trim()).replace(/,\s*-?\d+\s*$/, ''); if (c) out.push(c); }
    }
  } catch (e) { /* 不是有效快捷方式 / 读失败 */ }
  out.push(p);
  return out;
}
/* 是否"空白图"(单色/全透明)。实测 app.getFileIcon 对 .ico 会返回一张空白 32x32(≈550B dataURL);
   若不判空, 会把空白图标缓存下来 → 格子里就没图标。 */
function imgIsBlank(img) {
  try {
    const b = img.toBitmap();
    if (!b || b.length < 8) return true;
    const B = b[0], G = b[1], R = b[2], A = b[3];
    let varied = false, opaque = false;
    for (let i = 0; i + 3 < b.length; i += 4) {
      if (b[i + 3] !== 0) opaque = true;
      if (b[i] !== B || b[i + 1] !== G || b[i + 2] !== R || b[i + 3] !== A) { varied = true; if (opaque) break; }
    }
    return (!varied) || (!opaque);
  } catch (e) { return false; }
}
/* ---------------- .lnk 图标兜底: PowerShell(ExtractIconEx) ----------------
   实测: Electron 的 app.getFileIcon 对 UWP 快捷方式(无 target) 与"无内嵌图标"的 exe 会返回
   【通用图标】; 而 .NET 的 ExtractAssociatedIcon(底层 ExtractIconEx) 能拿到【真实设计图标】。
   做法: 收集 80ms 内的请求 → 一个 powershell 进程批量解析 → 结果写磁盘缓存(命中缓存不再起进程)。 */
const { execFile } = require('child_process');
let psPending = new Map();     // path -> [resolve]
let psTimer = null;
function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
function psIcon(p) {
  return new Promise(resolve => {
    if (!psPending.has(p)) psPending.set(p, []);
    psPending.get(p).push(resolve);
    if (!psTimer) psTimer = setTimeout(flushPsIcons, 80);
  });
}
function flushPsIcons() {
  psTimer = null;
  const waiters = psPending; psPending = new Map();
  const paths = Array.from(waiters.keys());
  if (!paths.length) return;
  const arr = '[' + paths.map(psQuote).join(',') + ']';
  const script = 'Add-Type -AssemblyName System.Drawing; $o=@{}; foreach($p in ' + arr + '){ try{ $i=[System.Drawing.Icon]::ExtractAssociatedIcon($p); if($i){ $ms=New-Object System.IO.MemoryStream; $i.ToBitmap().Save($ms,[System.Drawing.Imaging.ImageFormat]::Png); $o[$p]=[Convert]::ToBase64String($ms.ToArray()) } }catch{} }; [Console]::Out.Write(($o | ConvertTo-Json -Compress))';
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 20000 },
    (err, stdout) => {
      let map = {};
      try { map = JSON.parse(String(stdout || '{}')) || {}; } catch (e) { map = {}; }
      for (const [p, list] of waiters) {
        let d = map[p] || null;
        if (d) {
          d = 'data:image/png;base64,' + d;
          ICON_MEM.set(p, d);
          try { fs.mkdirSync(iconDir(), { recursive: true }); fs.writeFileSync(iconFile(p), Buffer.from(d.split(',')[1] || '', 'base64')); } catch (e) { /* ignore */ }
        }
        list.forEach(fn => fn(d));
      }
    });
}
/* 取图标: 先按【设计图标】来源取, 失败再回退原路径。 */
async function fileIcon(p) {
  const key = String(p || '');
  if (!key) return null;
  if (ICON_MEM.has(key)) return ICON_MEM.get(key);
  const cf = iconFile(key);
  try {
    if (fs.existsSync(cf)) {
      const b = 'data:image/png;base64,' + fs.readFileSync(cf).toString('base64');
      ICON_MEM.set(key, b); return b;
    }
  } catch (e) { /* 磁盘缓存读失败, 继续取图 */ }
  const cands = iconCandidates(key);
  for (let i = 0; i < cands.length; i++) {
    const q = cands[i];
    try { if (!fs.existsSync(q)) continue; } catch (e) { /* 继续试下一个 */ }
    const data = await iconFromPath(q);
    if (!data) continue;
    ICON_MEM.set(key, data);
    try { fs.mkdirSync(iconDir(), { recursive: true }); fs.writeFileSync(cf, Buffer.from(data.split(',')[1] || '', 'base64')); } catch (e) { /* 磁盘写失败不影响内存缓存 */ }
    return data;
  }
  /* 兜底(放最后): .lnk 走 PowerShell(ExtractAssociatedIcon, 仅 32px) —— 只用于 UWP 快捷方式 / 无 ico 的情况。
     优先走上面: .ico 源可 nativeImage 出 256px、exe 源 getFileIcon 'large' 出 48px, 都比 32px 清晰得多。 */
  if (String(path.extname(key) || '').toLowerCase() === '.lnk') {
    const d = await psIcon(key);
    if (d) return d;
  }
  return null;
}
/* 从某一路径取图标:
   ① 若它本身是【图片/图标文件 (.ico/.png/.bmp... 或无扩展名的 MSI ProductIcon)】→ 直接当图读
      (Chromium 能解 ICO)。这条【必须优先】—— 实测 app.getFileIcon 对 .ico 会返回"空白"图 ~550 字节。
   ② 否则 (exe/dll) → 用 app.getFileIcon 取内嵌图标。
   阈值 120 用于丢弃空白 dataURL。 */
async function iconFromPath(q) {
  const ext = String(path.extname(q) || '').toLowerCase();
  const looksImage = ext === '' || ['.ico', '.png', '.bmp', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg'].indexOf(ext) >= 0;
  if (looksImage) {
    try {
      const img = nativeImage.createFromPath(q);
      if (img && !img.isEmpty() && !imgIsBlank(img)) {
        const s = img.getSize();
        const out = (s.width > 96 || s.height > 96) ? img.resize({ width: 96, height: 96, quality: 'good' }) : img;
        const d = out.toDataURL();
        if (d && d.length > 120) return d;
      }
    } catch (e) { /* 落到 getFileIcon */ }
  }
  try {
    const img = await app.getFileIcon(q, { size: 'large' });
    if (img && !img.isEmpty() && !imgIsBlank(img)) { const d = img.toDataURL(); if (d && d.length > 120) return d; }
  } catch (e) { /* ignore */ }
  return null;
}
/* 收纳格子: 由主进程 stat 每个绝对路径, 返回 {path,name,isDir} 组合列表 (渲染进程不 stat) */
function listItems(items) {
  const arr = Array.isArray(items) ? items : [];
  const out = arr.map(p => {
    const s = String(p || '');
    try {
      const st = fs.statSync(s);
      return { path: s, name: path.basename(s) || s, isDir: st.isDirectory() };
    } catch (e) {
      return { path: s, name: path.basename(s) || s, isDir: false, missing: true };
    }
  });
  return { ok: true, items: out };
}
/* ---------------- 图片缩略图缓存 (仅图片格式, 内存 Map + userData/thumb-cache 磁盘) ---------------- */
const THUMB_MEM = new Map();          // 绝对路径 → dataURL
const THUMB_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico', 'avif']);
function thumbDir() { return path.join(app.getPath('userData'), 'thumb-cache'); }
function thumbFile(p) { return path.join(thumbDir(), crypto.createHash('sha1').update(String(p)).digest('hex') + '.png'); }
/* 仅图片文件生成缩略图; 非图片或任何失败一律返回 null(绝不抛异常) */
async function fileThumb(p) {
  const key = String(p || '');
  if (!key) return null;
  const ext = path.extname(key).slice(1).toLowerCase();
  if (!THUMB_EXT.has(ext)) return null;              // 非图片: 不生成
  if (THUMB_MEM.has(key)) return THUMB_MEM.get(key);
  const cf = thumbFile(key);
  try {
    if (fs.existsSync(cf)) {
      const b = 'data:image/png;base64,' + fs.readFileSync(cf).toString('base64');
      THUMB_MEM.set(key, b); return b;
    }
  } catch (e) { /* 磁盘缓存读失败, 继续生成 */ }
  try {
    const img = require('electron').nativeImage.createFromPath(key);
    if (img.isEmpty()) return null;
    const data = img.resize({ width: 48, height: 48, quality: 'good' }).toDataURL();
    if (!data) return null;
    THUMB_MEM.set(key, data);
    try { fs.mkdirSync(thumbDir(), { recursive: true }); fs.writeFileSync(cf, Buffer.from(data.split(',')[1] || '', 'base64')); } catch (e) { /* 磁盘写失败不影响内存缓存 */ }
    return data;
  } catch (e) { return null; }
}

/* ---------------- 新文件提醒: 监视"未收纳进任何格子"的新文件 ----------------
   每 60s 扫一次 桌面 / 下载 / 微信文件目录; 只报【本次运行之后新出现】且【不在任何格子 items/path 里】的,
   避免启动时刷屏。命中 → 往「消息」面板推一条 warn。 */
const APP_START = Date.now();
const reportedNew = new Set();
function watchTargets() {
  const dirs = [app.getPath('desktop'), app.getPath('downloads')];
  try {
    const base = path.join(app.getPath('documents'), 'WeChat Files');
    for (const a of fs.readdirSync(base, { withFileTypes: true })) {
      if (!a.isDirectory()) continue;
      const fsd = path.join(base, a.name, 'FileStorage', 'File');
      try { for (const m of fs.readdirSync(fsd, { withFileTypes: true })) { if (m.isDirectory()) dirs.push(path.join(fsd, m.name)); } } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
  return dirs;
}
function allCellPaths() {
  const set = new Set();
  (state.cells || []).forEach(c => {
    if (c.path) set.add(String(c.path).toLowerCase());
    if (Array.isArray(c.items)) c.items.forEach(p => set.add(String(p).toLowerCase()));
  });
  return set;
}
function scanNewFiles() {
  const known = allCellPaths();
  for (const dir of watchTargets()) {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of ents) {
      const name = e.name;
      if (name === 'desktop.ini' || name.startsWith('~$') || name.startsWith('.')) continue;
      const full = path.join(dir, name);
      const key = full.toLowerCase();
      if (known.has(key) || reportedNew.has(key)) continue;
      let st = null; try { st = fs.statSync(full); } catch (e) { continue; }
      if (st.mtimeMs < APP_START - 60000) continue;      // 只报本次运行之后新出现的
      reportedNew.add(key);
      addMessage('未收纳的新文件：' + name + '（点击收纳到格子）', 'warn', { path: full });
    }
  }
}
/* 打开"目标文件位置": 快捷方式 → 解析到真实目标再定位; 普通文件 → 自身 */
function revealTarget(p) {
  const s = String(p || '');
  if (!s) return;
  let t = s;
  try {
    if (String(path.extname(s)).toLowerCase() === '.lnk' && shell.readShortcutLink) {
      const l = shell.readShortcutLink(s);
      if (l && l.target) t = l.target;
    }
  } catch (e) { /* 用自身 */ }
  try { shell.showItemInFolder(t); } catch (e) { /* ignore */ }
}
/* 删除: 放入回收站(非永久), 并从格子 items 移除 */
async function trashRow(cellId, rowPath) {
  const p = String(rowPath || '');
  if (!p) return;
  try { await shell.trashItem(p); }
  catch (e) { addMessage('放入回收站失败：' + (e && e.message), 'err'); return; }
  const c = (state.cells || []).find(x => x.id === cellId);
  if (c && Array.isArray(c.items)) c.items = c.items.filter(x => x !== p);
  addMessage('已放入回收站：' + (path.basename(p) || p), 'info');
  persist(); pushState();
}
/* 开机自启: 写/删 当前用户启动项(HKCU Run), 免管理员 */
const AUTOSTART_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const AUTOSTART_NAME = '星穹桌面';
function autostartGet() {
  /* 只看退出码, 不解析输出: reg query 在"值不存在"时退出码=1。
     (不能用 output 匹配 —— reg 输出是控制台编码, 中文值名会被 Node 按 utf8 解成乱码而误判。) */
  try {
    require('child_process').execFileSync('reg', ['query', AUTOSTART_KEY, '/v', AUTOSTART_NAME], { windowsHide: true, stdio: 'ignore' });
    return true;
  } catch (e) { return false; }
}
function autostartSet(on) {
  try {
    const cp = require('child_process');
    if (on) {
      const isPkg = path.basename(process.execPath).toLowerCase() !== 'electron.exe';
      const cmd = isPkg ? ('"' + process.execPath + '"') : ('"' + process.execPath + '" "' + __dirname + '"');
      cp.execFileSync('reg', ['add', AUTOSTART_KEY, '/v', AUTOSTART_NAME, '/t', 'REG_SZ', '/d', cmd, '/f'], { windowsHide: true });
    } else {
      cp.execFileSync('reg', ['delete', AUTOSTART_KEY, '/v', AUTOSTART_NAME, '/f'], { windowsHide: true });
    }
    return true;
  } catch (e) { return false; }
}
/* 一键: 把桌面按类别归纳成格子(收纳格) —— 分享给别人的机器也能一键生成自己的分类 */
const CAT_RULES = [
  ['科研软件', ['matlab', 'mathematica', 'mathtype', 'zotero', 'cajviewer', 'tex']],
  ['开发工具', ['visual studio code', 'vs code', 'cc switch', 'ccswitch', 'deskbox', 'git bash', 'node', 'python', 'sublime']],
  ['人工智能', ['codex', '千问', 'chatgpt', 'claude', 'kimi', '豆包', '通义', 'ollama']],
  ['游戏娱乐', ['steam', 'cities skylines', '深海迷航', 'survivalcraft', 'plantsvs', 'paradox', 'qq音乐', '网易云', '游戏', 'epic']],
  ['影音图像', ['lightroom', 'photoshop', 'nikon', 'premiere', '剪映', 'potplayer', 'vlc', 'obs', '.mov', '.mp4', '.jpg', '.jpeg', '.png', '.avi']],
  ['通讯协作', ['微信', 'wechat', 'dingtalk', '钉钉', '腾讯会议', 'feishu', '飞书', 'zoom', 'telegram', 'qq.lnk']],
  ['网络浏览', ['chrome', 'edge', 'uc浏览器', 'firefox', '夸克', '浏览器', '百度网盘']],
  ['办公软件', ['wps', 'office', 'typora', 'xmind', '有道', 'translate', 'pdf', 'acrobat', 'onedrive', 'notion', 'obsidian']],
  ['系统工具', ['荣耀', 'honor', '小米', 'xiaomi', 'core temp', '向日葵', 'sunlogin', '电脑管家', '驱动', 'cpu-z', '鲁大师', '迅雷', 'thunder']],
];
const CAT_MERGE = { '办公软件': '办公科研', '科研软件': '办公科研', '开发工具': '开发与AI', '人工智能': '开发与AI', '游戏娱乐': '游戏娱乐', '网络浏览': '网络通讯', '通讯协作': '网络通讯', '系统工具': '工具与媒体', '影音图像': '工具与媒体', '其他': '工具与媒体', '文件夹': '文件夹' };
const CAT_ORDER = ['办公科研', '开发与AI', '游戏娱乐', '网络通讯', '工具与媒体', '文件夹'];
function classifyDesktop() {
  const desk = app.getPath('desktop');
  let ents = [];
  try { ents = fs.readdirSync(desk, { withFileTypes: true }); } catch (e) { return { ok: false, error: String(e && e.message) }; }
  const groups = {}; CAT_ORDER.forEach(c => { groups[c] = []; });
  for (const e of ents) {
    const name = e.name;
    if (name === 'desktop.ini' || name.startsWith('~$') || name.startsWith('.')) continue;
    const full = path.join(desk, name);
    let fine;
    if (e.isDirectory()) fine = '文件夹';
    else {
      const low = name.toLowerCase();
      fine = '其他';
      for (const [c, keys] of CAT_RULES) { if (keys.some(k => low.indexOf(k) >= 0)) { fine = c; break; } }
    }
    groups[CAT_MERGE[fine] || '工具与媒体'].push(full);
  }
  const cells = [];
  let i = 0;
  for (const cat of CAT_ORDER) {
    if (!groups[cat].length) continue;
    cells.push({ id: 'cc' + (i + 1), title: cat, kind: 'collect', items: groups[cat], x: 8 + i * 140, y: 4, w: 300, h: 340 });
    i++;
  }
  state.cells = cells;
  persist(); pushState();
  addMessage('已按分类重建 ' + cells.length + ' 个格子', 'ok');
  return { ok: true, cells: cells.length };
}
/* 把当前星空(渲染进程给的 PNG dataURL) 设为 Windows 桌面壁纸。
   用途: UAC 安全桌面 / 锁屏 / 权限弹窗时也看到同一片星空(静态), 且可关掉本程序省 CPU/GPU。
   SPI_SETDESKWALLPAPER=20, SPIF_UPDATEINIFILE|SPIF_SENDCHANGE=0x03 */
function setOsWallpaperFromDataUrl(dataUrl) {
  try {
    const b64 = String(dataUrl || '').split(',')[1] || '';
    if (!b64) return false;
    const p = path.join(app.getPath('temp'), 'skydome-wallpaper.png');
    fs.writeFileSync(p, Buffer.from(b64, 'base64'));
    const koffi = require('koffi');
    const u32 = koffi.load('user32.dll');
    const f = u32.func('bool __stdcall SystemParametersInfoW(uint32 uiAction, uint32 uiParam, const char16_t *pvParam, uint32 fWinIni)');
    return !!f(20, 0, p, 3);
  } catch (e) { console.warn('[wallpaper]', e && e.message); return false; }
}
function registerIpc() {
  ipcMain.handle('state:get', () => state);
  ipcMain.handle('state:set', (e, s) => { if (s && typeof s === 'object') { state = s; migrateState(); persist(); } return state; });
  ipcMain.handle('fs:list', (e, dir) => listDir(String(dir || '')));
  ipcMain.handle('fs:listItems', (e, items) => listItems(items));
  ipcMain.handle('fs:icon', (e, p) => fileIcon(String(p || '')));
  ipcMain.handle('fs:thumb', (e, p) => fileThumb(String(p || '')));
  ipcMain.handle('fs:reveal', (e, p) => {
    const s = String(p || '');
    if (!s) return false;
    try { shell.showItemInFolder(s); return true; } catch (err) { return false; }
  });
  ipcMain.handle('fs:open', async (e, p) => {
    const s = String(p || '');
    if (!s) return { ok: false, error: 'empty' };
    if (/^https?:\/\//i.test(s)) {
      try { await shell.openExternal(s); return { ok: true, path: s, via: 'external' }; }
      catch (err) { return { ok: false, path: s, error: String(err && err.message || err) }; }
    }
    try {
      const r = await shell.openPath(s);          // 成功返回 '', 失败返回错误串
      const ok = !r;
      addMessage((ok ? '打开 ' : '打开失败 ') + (path.basename(s) || s) + (ok ? '' : (' · ' + r)), ok ? 'info' : 'err');
      return { ok, path: s, result: r };
    } catch (err) {
      const msg = String(err && err.message || err);
      addMessage('打开异常 ' + (path.basename(s) || s) + ' · ' + msg, 'err');
      return { ok: false, path: s, error: msg };
    }
  });
  ipcMain.handle('fs:pick', async (e, mode) => {
    if (mode === 'files') {
      const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
      return r.canceled ? null : r.filePaths;               // 数组
    }
    const r = await dialog.showOpenDialog(win, { properties: [mode === 'folder' ? 'openDirectory' : 'openFile'] });
    return r.canceled ? null : r.filePaths[0];              // 单个路径 (签名不变)
  });
  /* 原生右键菜单: 由主进程构建 + Menu.popup(), 选择结果通过 'cell:action' 回送渲染进程 */
  ipcMain.handle('cell:menu', (e, payload) => {
    const { cellId, target, rowPath } = payload || {};
    const cell = (state.cells || []).find(c => c.id === cellId);
    const kind = cell ? cell.kind : 'folder';
    const send = (action, arg) => { if (win && !win.isDestroyed()) win.webContents.send('cell:action', { action, cellId, target, rowPath, arg }); };
    const tpl = [
      { label: '打开', click: () => send('open') },
      { label: '在资源管理器中显示', click: () => send('reveal') },
    ];
    /* 行(格子内条目)专属: 移出格子(不删文件) / 转移到其他收纳格子 */
    if (target === 'row') {
      tpl.push({ label: '移出格子（不删除文件）', click: () => send('eject') });
      tpl.push({ label: '打开目标文件位置', click: () => revealTarget(rowPath) });
      tpl.push({ label: '删除（放入回收站）', click: () => { trashRow(cellId, rowPath); } });
      const others = (state.cells || []).filter(c => c.id !== cellId && c.kind === 'collect');
      if (others.length) tpl.push({ label: '转移到其他格子', submenu: others.map(o => ({ label: o.title || o.id, click: () => send('moveTo', o.id) })) });
    }
    tpl.push({ type: 'separator' });
    tpl.push({ label: '重命名', click: () => send('rename') });
    if (kind === 'collect') tpl.push({ label: '清空内容', click: () => send('clear') });
    tpl.push({ type: 'separator' });
    /* 末栏: 「新建格子」与「删除格子」同栏 (2026-10-16 用户要求: 新建改由右键展出) */
    tpl.push({ label: '新建格子', submenu: [
      { label: '镜像文件夹格子', click: () => send('new', 'folder') },
      { label: '自由收纳格子', click: () => send('new', 'collect') },
      { label: '链接格子', click: () => send('new', 'link') },
    ] });
    tpl.push({ label: '删除格子', click: () => send('delete') });
    Menu.buildFromTemplate(tpl).popup({ window: win });
    return true;
  });
  /* 导入方式选择: 文件夹 / 文件 (原生菜单), 返回 'folder' | 'files' | null */
  ipcMain.handle('cell:import-choose', () => new Promise((resolve) => {
    let picked = null;
    const menu = Menu.buildFromTemplate([
      { label: '导入文件夹', click: () => { picked = 'folder'; } },
      { label: '导入文件', click: () => { picked = 'files'; } },
    ]);
    menu.popup({ window: win, callback: () => setTimeout(() => resolve(picked), 0) });
  }));
  /* 新建格子方式选择: 镜像文件夹 / 自由收纳 / 链接 */
  ipcMain.handle('cell:new-choose', () => new Promise((resolve) => {
    let picked = null;
    const menu = Menu.buildFromTemplate([
      { label: '镜像文件夹格子', click: () => { picked = 'folder'; } },
      { label: '自由收纳格子', click: () => { picked = 'collect'; } },
      { label: '链接格子', click: () => { picked = 'link'; } },
    ]);
    menu.popup({ window: win, callback: () => setTimeout(() => resolve(picked), 0) });
  }));
  /* 点「未收纳的新文件」提醒时: 弹出格子列表, 让用户选要收纳到哪个格子 */
  ipcMain.handle('cell:pick-target', () => new Promise((resolve) => {
    const cells = (state.cells || []);
    if (!cells.length) { resolve(null); return; }
    let picked = null;
    const menu = Menu.buildFromTemplate(cells.map(c => ({ label: c.title || c.id, click: () => { picked = c.id; } })));
    menu.popup({ window: win, callback: () => setTimeout(() => resolve(picked), 0) });
  }));
  ipcMain.handle('autostart:get', () => autostartGet());
  ipcMain.handle('autostart:set', (e, on) => autostartSet(!!on));
  ipcMain.handle('cells:classify', () => classifyDesktop());
  ipcMain.handle('os:wallpaper', (e, dataUrl) => setOsWallpaperFromDataUrl(dataUrl));
  ipcMain.on('hit-rects', (e, r) => { if (Array.isArray(r)) rects = r; });
  ipcMain.on('force-interactive', (e, v) => { forceInteractive = !!v; });
  ipcMain.on('msg:add', (e, text, level) => addMessage(text, level));
  ipcMain.on('quit-app', () => app.quit());
}

/* ---------------- HTTP 消息接口 ---------------- */
function startHttp() {
  const srv = http.createServer((req, res) => {
    let u; try { u = new URL(req.url, 'http://127.0.0.1'); } catch (e) { res.statusCode = 400; return res.end('bad'); }
    httpAnyHits++; httpLastAt = Date.now(); httpLastUA = String(req.headers['user-agent'] || '');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (u.pathname === '/health') {
      httpHealthHits++; httpLastHealthAt = Date.now();
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({
        ok: true, app: APP_NAME, version: APP_VERSION,
        cells: state.cells.length, todos: state.todos.length, messages: state.messages.length,
        layerGuard: !!setWindowPos, lowers: lowerCount, iconCache: ICON_MEM.size,
        /* 单窗口合并(方案甲): W1 键保留以兼容旧探针, enabled 恒 false; merged 标志置顶 */
        w1: { enabled: false, merged: true },
        merged: true,
        /* 新增字段(只增不改) —— 契约: 右列三块面板固定 id/顺序, msgs 只显最近 3 */
        panelIds: ['panel-work', 'panel-todo', 'panel-msgs'],
        msgStoredCap: 50, msgDisplayCap: 3, railBudget: 44,
        /* 诊断字段(只增): 穿透态 / 已上报矩形数 / 光标(DIP) / 强制交互 */
        ignoring: ignoring, rectsLen: rects.length, forceInteractive: forceInteractive,
        cursor: (function () { const p = screen.getCursorScreenPoint(); return { x: p.x, y: p.y }; })(),
        /* 诊断(只增): 壁纸是否真在轮询 —— 计数 + 最近请求时间/UA */
        httpAnyHits: httpAnyHits, httpHealthHits: httpHealthHits,
        httpLastAgoMs: httpLastAt ? (Date.now() - httpLastAt) : -1,
        httpLastHealthAgoMs: httpLastHealthAt ? (Date.now() - httpLastHealthAt) : -1,
        httpLastUA: httpLastUA ? httpLastUA.slice(0, 120) : '',
      }));
    }
    if (u.pathname === '/notify') {
      const m = addMessage(u.searchParams.get('text') || '(空消息)', u.searchParams.get('level') || 'info');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ ok: true, message: m }));
    }
    if (u.pathname === '/lower') { // 手动/诊断: 把浮层沉到 Z 序最底
      const ok = lowerWindow();
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ ok, lowers: lowerCount }));
    }
    if (u.pathname === '/state') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify(state));
    }
    if (u.pathname === '/dom') {
      // 诊断: 渲染进程 DOM 快照 (仅本机 127.0.0.1)
      const js = "JSON.stringify({" +
        "ready:true," +
        "panels:Array.from(document.querySelectorAll('#rail > .panel')).map(function(e){return e.id})," +
        "panelRects:Array.from(document.querySelectorAll('#rail > .panel')).map(function(e){var r=e.getBoundingClientRect();return {id:e.id,x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)}})," +
        "railRect:(function(){var e=document.getElementById('rail');if(!e)return null;var r=e.getBoundingClientRect();return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)}})()" +
        ",grips:document.querySelectorAll('.cell .grip').length," +
        "cellHeights:Array.from(document.querySelectorAll('.cell')).map(function(e){return Math.round(e.getBoundingClientRect().height)})," +
        "cells:document.querySelectorAll('.cell').length," +
        "rows:document.querySelectorAll('#tlist .row').length," +
        "working:document.querySelectorAll('#tlist .tag:not(.off)').length," +
        "msgs:document.querySelectorAll('#mlist .msg').length," +
        "work:(document.getElementById('workhd')||{}).textContent," +
        "wkitems:Array.from(document.querySelectorAll('#wklist .wkitem span.nm')).map(function(e){return e.textContent})," +
        "titles:Array.from(document.querySelectorAll('.cell .t span:first-child')).map(function(e){return e.textContent})," +
        "kinds:Array.from(document.querySelectorAll('.cell')).map(function(e){var s=e.querySelector('.t .sp');return s?s.textContent:''})," +
        "items:Array.from(document.querySelectorAll('.cell .b .it span.nm')).slice(0,8).map(function(e){return e.textContent})," +
        "icons:document.querySelectorAll('img.ico').length," +
        "sel:document.querySelectorAll('.sel').length," +
        "collect:Array.from(document.querySelectorAll('.cell')).filter(function(e){var s=e.querySelector('.t .sp');return s&&s.textContent==='BAG';}).length," +
        "itemRects:Array.from(document.querySelectorAll('.cell .it, #wklist .wkitem')).slice(0,80).map(function(e){var r=e.getBoundingClientRect();return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height),cls:e.className,p:e.dataset.path||''}})," +
        "dpr:window.devicePixelRatio,iw:window.innerWidth,ih:window.innerHeight,sx:window.screenX,sy:window.screenY,ow:window.outerWidth,oh:window.outerHeight," +
        "probe:(function(){var e=document.querySelector('.cell[data-cell-id=\"cprobe\"]');if(!e)return null;var r=e.getBoundingClientRect();var it=e.querySelector('.it');var ir=it?it.getBoundingClientRect():null;return {cell:{x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)},row:ir?{x:Math.round(ir.left),y:Math.round(ir.top),w:Math.round(ir.width),h:Math.round(ir.height)}:null};})()" +
        "})";
      return win.webContents.executeJavaScript(js).then(function (t) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        /* err 只报『最近一次错误事件』的文本(全量 state 里最新的 level==='err'),
           不再是 #mlist 整个列表的 textContent 拼接 */
        var out = t;
        try {
          var obj = JSON.parse(t);
          var lastErr = '';
          for (var i = 0; i < state.messages.length; i++) {
            if (state.messages[i].level === 'err') { lastErr = state.messages[i].text; break; }
          }
          obj.err = lastErr;
          out = JSON.stringify(obj);
        } catch (e0) { /* 非 JSON: 原样返回 */ }
        res.end(out);
      }).catch(function (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ ready: false, error: String(e && e.message || e) }));
      });
    }
    res.statusCode = 404; res.end('not found');
  });
  srv.on('error', () => { /* 端口占用等, 忽略 */ });
  srv.listen(HTTP_PORT, '127.0.0.1');
}

/* ---------------- 生命周期 ---------------- */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win && !win.isDestroyed()) { win.showInactive(); lowerSoon(); } });
  app.whenReady().then(() => { loadState(); registerIpc(); startHttp(); createWindow(); setTimeout(scanNewFiles, 20000); setInterval(scanNewFiles, 60000); });
  app.on('window-all-closed', () => app.quit());
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}
