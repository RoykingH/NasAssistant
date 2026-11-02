'use strict';
/**
 * Electron 主进程
 *
 *  三个挂件窗口：
 *   - topWin   时钟卡片：200×155，时钟 + CPU/RAM/DISK 三环（默认显示，替代旧简约条）
 *   - miniWin  顶部简约条：吸附屏幕顶部，显示 CPU / RAM / DISK 三个环形仪表
 *   - infoWin  详情挂件：系统状态、Docker 容器、虚拟机、服务器详情
 *
 *  交互：点组件展开/收起详情；详情标题栏的 ⌃ 收起回组件；
 *        托盘右键「组件样式」可切换 时钟卡片 / 简约条。
 *
 *  另有设置窗口、系统托盘、轮询推送、配置持久化与 IPC。
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const providers = require('./providers');

const ASSETS = path.join(__dirname, '..', 'assets');
const PRELOAD = path.join(__dirname, 'preload.js');

/* 时钟卡片窗口尺寸：设计稿卡片 1162×900，按 200px 宽等比 ⇒ 200×155 */
const TOP_W = 155;
const TOP_H = 140;
/* 简约条窗口尺寸：设计稿 ui/top_mini.png 为 547×112，此处按 1/2 等比缩小（含发光留白） */
const MINI_W = 274;
const MINI_H = 56;
/* 详情挂件：设计稿卡片 368×561，运行时放宽以保证中文可读性（顶部指标改为 2×2 后略加高） */
const INFO_W = 400;
const INFO_H = 632;

let topWin = null;
let miniWin = null;
let infoWin = null;
let settingsWin = null;
let tray = null;

let snapshot = { ok: false, error: null, ts: 0, unconfigured: true };
let cpuHistory = [];          // CPU 使用率历史（用于详情面板的折线）
const HISTORY_MAX = 48;
let pollTimer = null;
let polling = false;
let quitting = false;
let miniDragOrig = null;      // 简约条拖动起点（窗口原始位置）
let topDragOrig = null;       // 时钟卡片拖动起点（窗口原始位置）

/* ------------------------------------------------------------------ 图标 */
function appIcon() {
  let img = nativeImage.createFromPath(path.join(ASSETS, 'icon.png'));
  if (img.isEmpty()) img = nativeImage.createEmpty();
  return img;
}
function trayIcon() {
  const img = appIcon();
  return img.isEmpty() ? img : img.resize({ width: 16, height: 16 });
}

/* ------------------------------------------------------------ 公共窗口项 */
function baseWebPreferences() {
  return {
    preload: PRELOAD,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    spellcheck: false,
  };
}
function openExternal(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* ----------------------------------------------------- 时钟卡片（top 组件） */
function createTop() {
  if (topWin && !topWin.isDestroyed()) return topWin;
  const cfg = store.load();
  const tb = cfg.topBounds && typeof cfg.topBounds === 'object' ? cfg.topBounds : {};
  const wa = screen.getPrimaryDisplay().workArea;

  /* 默认落在工作区右上角 */
  const x = typeof tb.x === 'number' ? tb.x : Math.round(wa.x + wa.width - TOP_W - 24);
  const y = typeof tb.y === 'number' ? tb.y : Math.round(wa.y + 24);

  topWin = new BrowserWindow({
    width: TOP_W,
    height: TOP_H,
    x, y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    alwaysOnTop: false,      /* 时钟卡片不做屏幕置顶，只当普通桌面挂件 */
    title: '时钟卡片',
    icon: path.join(ASSETS, 'icon.png'),
    webPreferences: baseWebPreferences(),
  });

  topWin.loadFile(path.join(__dirname, 'renderer', 'top.html'));
  topWin.setMinimumSize(TOP_W, TOP_H);

  topWin.once('ready-to-show', () => {
    if (isWidgetMode('top') && store.load().topVisible !== false) topWin.showInactive();
    pushState();
  });

  const persist = debounce(() => {
    if (!topWin || topWin.isDestroyed()) return;
    const b = topWin.getBounds();
    store.save({ topBounds: { x: b.x, y: b.y, width: TOP_W, height: TOP_H } });
  }, 400);
  topWin.on('move', persist);

  topWin.on('close', (e) => {
    if (!quitting) { e.preventDefault(); topWin.hide(); store.save({ topVisible: false }); refreshTrayMenu(); }
  });
  topWin.on('show', refreshTrayMenu);
  topWin.on('hide', refreshTrayMenu);
  topWin.on('closed', () => { topWin = null; });
  openExternal(topWin);
  return topWin;
}

/* --------------------------------------------------------------- 简约条 */
function createMini() {
  if (miniWin && !miniWin.isDestroyed()) return miniWin;
  const cfg = store.load();
  const mb = cfg.miniBounds && typeof cfg.miniBounds === 'object' ? cfg.miniBounds : {};
  const wa = screen.getPrimaryDisplay().workArea;

  const x = typeof mb.x === 'number' ? mb.x : Math.round(wa.x + (wa.width - MINI_W) / 2);

  miniWin = new BrowserWindow({
    width: MINI_W,
    height: MINI_H,
    x,
    y: wa.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    title: '顶部简约条',
    icon: path.join(ASSETS, 'icon.png'),
    webPreferences: baseWebPreferences(),
  });

  miniWin.loadFile(path.join(__dirname, 'renderer', 'mini.html'));
  // 永远贴住屏幕顶部（只允许水平拖动）
  miniWin.setMinimumSize(MINI_W, MINI_H);
  snapMiniTop();

  miniWin.once('ready-to-show', () => {
    if (store.load().miniVisible !== false) miniWin.showInactive();
    pushState();
  });

  const persist = debounce(() => {
    if (!miniWin || miniWin.isDestroyed()) return;
    const b = miniWin.getBounds();
    store.save({ miniBounds: { x: b.x, y: b.y, width: MINI_W, height: MINI_H } });
  }, 400);
  miniWin.on('move', () => { snapMiniTop(); persist(); });

  miniWin.on('close', (e) => {
    if (!quitting) { e.preventDefault(); miniWin.hide(); store.save({ miniVisible: false }); refreshTrayMenu(); }
  });
  miniWin.on('show', refreshTrayMenu);
  miniWin.on('hide', refreshTrayMenu);
  miniWin.on('closed', () => { miniWin = null; });
  openExternal(miniWin);
  return miniWin;
}

/** 把简约条吸到「它所在显示器」的工作区顶部 */
function snapMiniTop() {
  if (!miniWin || miniWin.isDestroyed()) return;
  const b = miniWin.getBounds();
  const d = screen.getDisplayMatching(b);
  const wa = d.workArea;
  const x = Math.max(wa.x, Math.min(b.x, wa.x + wa.width - MINI_W));
  if (b.y !== wa.y || b.x !== x) miniWin.setBounds({ x, y: wa.y, width: MINI_W, height: MINI_H });
}

/* --------------------------------------------------------------- 详情挂件 */
function createInfo() {
  if (infoWin && !infoWin.isDestroyed()) return infoWin;
  const cfg = store.load();
  const b = (cfg.infoBounds || cfg.bounds || {}) || {};
  const wa = screen.getPrimaryDisplay().workArea;

  infoWin = new BrowserWindow({
    width: b.width || INFO_W,
    height: b.height || INFO_H,
    x: typeof b.x === 'number' ? b.x : Math.round(wa.x + (wa.width - INFO_W) / 2),
    y: typeof b.y === 'number' ? b.y : wa.y + MINI_H + 10,
    minWidth: 340,
    minHeight: 420,
    maxWidth: 900,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    alwaysOnTop: !!cfg.alwaysOnTop,
    title: appLabel(),
    icon: path.join(ASSETS, 'icon.png'),
    webPreferences: baseWebPreferences(),
  });

  infoWin.loadFile(path.join(__dirname, 'renderer', 'widget.html'));
  infoWin.once('ready-to-show', () => {
    if (store.load().infoVisible) infoWin.show();
    pushState();
  });

  const persist = debounce(() => {
    if (!infoWin || infoWin.isDestroyed() || infoWin.isMinimized()) return;
    store.save({ infoBounds: infoWin.getBounds() });
  }, 400);
  infoWin.on('move', persist);
  infoWin.on('resize', persist);

  infoWin.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      infoWin.hide();
      store.save({ infoVisible: false });
      refreshTrayMenu();
    }
  });
  infoWin.on('show', refreshTrayMenu);
  infoWin.on('hide', refreshTrayMenu);
  infoWin.on('closed', () => { infoWin = null; });
  openExternal(infoWin);
  return infoWin;
}

/** 首次展开时把详情挂件放到「当前组件窗口」正下方居中（并夹到工作区内） */
function placeInfoNearMini() {
  if (!infoWin || infoWin.isDestroyed()) return;
  const cfg = store.load();
  if (cfg.infoBounds && typeof cfg.infoBounds.x === 'number') return; // 用户已摆过位置，尊重记忆
  const src = activeWidgetWin();
  if (!src || src.isDestroyed() || !src.isVisible()) return;
  const b = infoWin.getBounds();
  const mb = src.getBounds();
  const wa = screen.getDisplayMatching(mb).workArea;
  let x = Math.round(mb.x + (mb.width - b.width) / 2);
  let y = Math.round(mb.y + mb.height + 6);
  x = Math.max(wa.x + 4, Math.min(x, wa.x + wa.width - b.width - 4));
  y = Math.max(wa.y + 4, Math.min(y, wa.y + wa.height - b.height - 4));
  infoWin.setPosition(x, y);
}

/* ---------------------------------------------- 组件样式（top / mini） */
/** 当前组件样式：'top' 时钟卡片（默认）| 'mini' 顶部简约条 */
function widgetMode() { return store.load().widgetMode === 'mini' ? 'mini' : 'top'; }
function isWidgetMode(m) { return widgetMode() === m; }
/** 当前生效的组件窗口 */
function activeWidgetWin() { return isWidgetMode('mini') ? miniWin : topWin; }
function activeWidgetVisible() { return isVisible(activeWidgetWin()); }

/** 切换组件样式：亮出新的、收起旧的 */
function switchWidgetMode(mode) {
  const m = mode === 'mini' ? 'mini' : 'top';
  store.save({ widgetMode: m });
  if (m === 'top') { showMini(false); showTop(true); }
  else { showTop(false); showMini(true); }
  broadcast('config', store.load());
  refreshTrayMenu();
  return { ok: true, widgetMode: m };
}
/** 显示 / 隐藏当前组件 */
function setWidgetVisible(show) {
  if (isWidgetMode('mini')) showMini(show); else showTop(show);
}

/* ------------------------------------------------------------- 窗口开关 */
function showMini(show) {
  const w = createMini();
  if (!w) return;
  if (show) w.showInactive(); else w.hide();
  store.save({ miniVisible: !!show });
  refreshTrayMenu();
}
function showTop(show) {
  const w = createTop();
  if (!w) return;
  if (show) w.showInactive(); else w.hide();
  store.save({ topVisible: !!show });
  refreshTrayMenu();
}
function showInfo(show) {
  const w = createInfo();
  if (!w) return;
  if (show) {
    placeInfoNearMini();
    w.show();
    w.focus();
  } else {
    w.hide();
  }
  store.save({ infoVisible: !!show });
  refreshTrayMenu();
}
function toggleMini() { showMini(!isVisible(miniWin)); }
function toggleTop() { showTop(!isVisible(topWin)); }
function toggleInfo() { showInfo(!(infoWin && !infoWin.isDestroyed() && infoWin.isVisible())); }
/** 由组件（时钟卡片 / 简约条）点击触发：切换详情面板 */
function toggleInfoFromMini() { showInfo(!(infoWin && !infoWin.isDestroyed() && infoWin.isVisible())); }

/* ------------------------------------------------------------- 设置窗口 */
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 480,
    height: 600,
    resizable: false,
    maximizable: false,
    minimizable: true,
    title: appLabel() + ' · 设置',
    icon: path.join(ASSETS, 'icon.png'),
    backgroundColor: '#0a1218',
    show: false,
    autoHideMenuBar: true,
    webPreferences: baseWebPreferences(),
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => { settingsWin = null; });
  openExternal(settingsWin);
}

/* ----------------------------------------------------------------- 托盘 */
/** 当前活动服务器（无则 null） */
function curServer() {
  return store.active();
}
/** 当前 provider 的界面文案（区块名随服务器类型变化） */
function curMeta() {
  const srv = curServer();
  return providers.meta(providers.kindOf(srv));
}
function appLabel() {
  return 'NAS桌面助手';
}
/** 活动服务器的展示名：自定义 name > 快照里的 hostname > host > 未连接 */
function activeDisplayName() {
  const srv = curServer();
  if (!srv) return '未配置';
  if (snapshot && snapshot.ok && snapshot.server && snapshot.server.name) return snapshot.server.name;
  return srv.name || srv.url || (srv.fnId ? 'FN:' + srv.fnId : '') || '未连接';
}
function buildTrayMenu() {
  const srv = curServer();
  const meta = providers.meta(providers.kindOf(srv));
  const running = snapshot && snapshot.ok;
  const count = store.list().length;
  const statusLabel = !srv
    ? '状态：未配置'
    : (running
        ? '状态：在线 · ' + activeDisplayName()
        : '状态：' + (snapshot.error ? '异常' : '未连接'));
  const dockerUp = snapshot && snapshot.docker && snapshot.docker.ok ? snapshot.docker.items.filter((i) => i.running).length : '-';
  const dockerAll = snapshot && snapshot.docker && snapshot.docker.ok ? snapshot.docker.items.length : '-';
  const vmUp = snapshot && snapshot.vms && snapshot.vms.ok ? snapshot.vms.items.filter((i) => i.running).length : '-';
  const vmAll = snapshot && snapshot.vms && snapshot.vms.ok ? snapshot.vms.items.length : '-';
  const mode = widgetMode();
  const widgetOn = activeWidgetVisible();
  const infoOn = isVisible(infoWin);

  /* 服务器切换子菜单（多服务器时才展开） */
  const srvItems = store.list().map((s) => ({
    label: (s.id === (srv && srv.id) ? '● ' : '○ ') + (s.name || s.url || (s.fnId ? 'FN:' + s.fnId : '') || '未命名') +
      '  (' + providers.meta(s.type).label + ')',
    click: () => switchServer(s.id),
  }));
  const srvMenu = {
    label: '切换服务器 (' + count + ')',
    submenu: srvItems.length ? srvItems : [{ label: '（暂无服务器）', enabled: false }],
  };

  return Menu.buildFromTemplate([
    { label: appLabel(), enabled: false },
    { label: '当前：' + activeDisplayName(), enabled: false },
    { label: '类型：' + meta.label, enabled: false },
    { label: statusLabel, enabled: false },
    { type: 'separator' },
    srvMenu,
    { label: '添加 / 管理服务器…', click: openSettings },
    { type: 'separator' },
    {
      label: '组件样式',
      submenu: [
        { label: '时钟卡片（时钟 + 三环）', type: 'radio', checked: mode === 'top', click: () => switchWidgetMode('top') },
        { label: '顶部简约条', type: 'radio', checked: mode === 'mini', click: () => switchWidgetMode('mini') },
      ],
    },
    { label: '显示组件', type: 'checkbox', checked: widgetOn, click: () => setWidgetVisible(!widgetOn) },
    { label: '详情面板', type: 'checkbox', checked: infoOn, click: () => showInfo(!infoOn) },
    { label: '立即刷新', click: () => poll(true) },
    { label: '设置…', click: openSettings },
    { type: 'separator' },
    { label: meta.containerLabel + '运行中：' + dockerUp + ' / ' + dockerAll, enabled: false },
    { label: meta.guestLabel + '运行中：' + vmUp + ' / ' + vmAll, enabled: false },
    { type: 'separator' },
    {
      label: '窗口置顶',
      type: 'checkbox',
      checked: !!(srv || store.load()).alwaysOnTop,
      click: (item) => {
        store.save({ alwaysOnTop: item.checked });
        for (const w of [topWin, miniWin, infoWin]) {
          if (w && !w.isDestroyed()) w.setAlwaysOnTop(item.checked);
        }
        // 简约条始终置顶；时钟卡片不置顶（只作普通桌面挂件）
        if (miniWin && !miniWin.isDestroyed()) miniWin.setAlwaysOnTop(true);
        if (topWin && !topWin.isDestroyed()) topWin.setAlwaysOnTop(false);
        broadcast('config', store.load());
      },
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: !!store.load().autoStart,
      click: (item) => setAutoStart(item.checked),
    },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
}
function refreshTrayMenu() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}
function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip(appLabel());
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', toggleInfo);
}

/* ------------------------------------------------------------- 轮询逻辑 */
function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}
function pushState() {
  broadcast('state', withHistory(snapshot));
}
function withHistory(s) {
  return Object.assign({}, s, {
    history: cpuHistory.slice(),
    /* 多服务器：把列表与活动 id 一并带上，详情页切换器依赖它 */
    servers: store.list(),
    activeId: store.load().activeId,
  });
}
/** 服务器是否已配置好连接信息（不同 provider 的凭据字段不同） */
function isConfigured(srv) {
  if (!srv) return false;
  if (srv.type === 'fnos') {
    // fnOS：地址与 FN ID 二者有其一即可，但账号密码必填
    if (!srv.url && !srv.fnId) return false;
    return !!(srv.username && srv.password);
  }
  if (!srv.url) return false;
  if (srv.type === 'dsm') return !!(srv.username && srv.password);
  return !!srv.apiKey;
}

async function poll(force) {
  const srv = store.active();
  if (!isConfigured(srv)) {
    snapshot = { ok: false, error: '尚未配置服务器地址与凭据', ts: Date.now(), unconfigured: true };
    pushState();
    updateTrayTooltip();
    return;
  }
  if (polling && !force) return;
  polling = true;
  try {
    snapshot = await providers.fetchSnapshot(srv);
    if (snapshot.ok && snapshot.cpu && snapshot.cpu.pct != null) {
      cpuHistory.push(Math.round(snapshot.cpu.pct * 10) / 10);
      if (cpuHistory.length > HISTORY_MAX) cpuHistory.shift();
    }
  } catch (e) {
    snapshot = { ok: false, error: e.message, ts: Date.now() };
  } finally {
    polling = false;
  }
  pushState();
  updateTrayTooltip();
  refreshTrayMenu();
}
function updateTrayTooltip() {
  if (!tray) return;
  const label = appLabel();
  if (!snapshot || !snapshot.ok) {
    tray.setToolTip(label + '\n' + (snapshot && snapshot.error ? snapshot.error : '未连接'));
    return;
  }
  const cpu = snapshot.cpu.pct == null ? '—' : snapshot.cpu.pct.toFixed(0) + '%';
  const ram = snapshot.ram.pct == null ? '—' : snapshot.ram.pct.toFixed(0) + '%';
  const disk = snapshot.disk.pct == null ? '—' : snapshot.disk.pct.toFixed(0) + '%';
  tray.setToolTip(
    label + '\n' +
    (snapshot.server.name || snapshot.host) + '\n' +
    'CPU ' + cpu + ' · 内存 ' + ram + ' · 磁盘 ' + disk
  );
}
function startPolling() {
  stopPolling();
  const cfg = store.load();
  const iv = Math.max(1000, Number(cfg.refreshInterval) || 5000);
  poll(true);
  pollTimer = setInterval(() => poll(false), iv);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

/** 切换到某台服务器：清缓存 → 重开轮询 → 广播 */
function switchServer(id) {
  const cur = store.load();
  const prev = cur.activeId ? store.get(cur.activeId) : null;
  const next = store.setActive(id);
  const srv = store.active();
  if (!srv || next !== srv.id) return { ok: false, error: '服务器不存在' };
  const typeChanged = !prev || prev.type !== srv.type;
  if (typeChanged) providers.clearCache(srv);
  cpuHistory = [];
  /* 立即广播一个「加载中」骨架（沿用上一份快照的结构），避免渲染层因
     缺字段 / ok:false 而闪出「未知错误」错误条。真正的数据随后由 poll() 补上。 */
  snapshot = providers.makeSnapshot
    ? providers.makeSnapshot(srv.type, providers.displayHost ? providers.displayHost(srv) : '')
    : Object.assign({}, snapshot, { ok: false, error: null });
  snapshot.loading = true;
  pushState();
  startPolling();
  broadcast('servers', serverListPayload());
  broadcast('config', store.load());
  refreshTrayMenu();
  return { ok: true, active: srv, servers: store.list() };
}

/** 服务器列表载荷（不含敏感字段之外的东西，apiKey 交给渲染层但仅本机） */
function serverListPayload() {
  return { activeId: store.load().activeId, servers: store.list() };
}

/* ------------------------------------------------------------- 开机自启 */
function setAutoStart(enabled) {
  store.save({ autoStart: !!enabled });
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled, args: [] });
  } catch (_) { /* 某些环境下不可用 */ }
  broadcast('config', store.load());
  refreshTrayMenu();
}

/* --------------------------------------------------------------- IPC */
function registerIpc() {
  ipcMain.handle('config:get', () => store.load());

  /* --- 服务器列表管理 --- */
  ipcMain.handle('servers:list', () => serverListPayload());

  ipcMain.handle('servers:get', (_e, id) => store.get(id));

  /** 新增 / 更新服务器。srv.id 存在则更新，否则新增。 */
  ipcMain.handle('servers:save', (_e, srv) => {
    const before = store.active();
    const saved = store.upsert(srv || {});
    const isActive = store.load().activeId === saved.id;
    // 改的是活动服务器的连接信息 → 清缓存重连
    if (isActive) {
      const typeChanged = !before || before.type !== saved.type ||
        before.url !== saved.url || before.apiKey !== saved.apiKey || before.tokenId !== saved.tokenId ||
        before.username !== saved.username || before.password !== saved.password ||
        before.otpCode !== saved.otpCode || before.fnId !== saved.fnId ||
        before.fnDomain !== saved.fnDomain ||
        before.allowSelfSigned !== saved.allowSelfSigned;
      if (typeChanged) {
        providers.clearCache(saved);
        cpuHistory = [];
        startPolling();
      }
    }
    // 从「无任何服务器」变成「有服务器」→ 亮出当前组件
    if (!before && saved.id) setWidgetVisible(true);
    broadcast('servers', serverListPayload());
    broadcast('config', store.load());
    refreshTrayMenu();
    return { ok: true, server: saved, activeId: store.load().activeId };
  });

  /** 删除服务器。若删的是活动服务器，自动切到剩余的第一台。 */
  ipcMain.handle('servers:remove', (_e, id) => {
    const wasActive = store.load().activeId === id;
    const r = store.remove(id);
    if (wasActive) {
      const srv = store.active();
      if (srv) {
        providers.clearCache(srv);
        cpuHistory = [];
        startPolling();
      } else {
        stopPolling();
        snapshot = { ok: false, error: '尚未配置服务器地址与凭据', ts: Date.now(), unconfigured: true };
        pushState();
      }
    }
    broadcast('servers', serverListPayload());
    broadcast('config', store.load());
    refreshTrayMenu();
    return { ok: true, removed: r.removed, activeId: r.activeId };
  });

  /** 切换活动服务器 */
  ipcMain.handle('servers:setActive', (_e, id) => switchServer(id));

  /** 主进程侧做一次连接探测（不落盘），用于设置页表单的「测试连接」 */
  ipcMain.handle('servers:test', async (_e, draft) => {
    try {
      return await providers.testConnection(draft || {});
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('config:save', (_e, patch) => {
    const before = store.load();
    const srvBefore = store.active();
    const cfg = store.save(patch || {});
    if (infoWin && !infoWin.isDestroyed() && typeof cfg.alwaysOnTop === 'boolean') {
      infoWin.setAlwaysOnTop(!!cfg.alwaysOnTop);
    }
    if (typeof cfg.autoStart === 'boolean' && cfg.autoStart !== before.autoStart) {
      setAutoStart(cfg.autoStart);
    }
    if (pollTimer && Number(cfg.refreshInterval) !== Number(before.refreshInterval)) {
      startPolling();
    }
    const srvAfter = store.active();
    if (srvAfter && (!srvBefore || srvBefore.id !== srvAfter.id)) {
      providers.clearCache(srvAfter);
      cpuHistory = [];
      startPolling();
    }
    broadcast('config', cfg);
    return { ok: true, config: cfg };
  });

  ipcMain.handle('config:test', async (_e, draft) => {
    /* 兼容旧调用：draft 里可能是活动服务器的局部覆盖 */
    const base = store.active() || {};
    const cfg = Object.assign({}, base, draft || {});
    try {
      return await providers.testConnection(cfg);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('state:get', () => withHistory(snapshot));

  ipcMain.handle('app:refresh', async () => { await poll(true); return withHistory(snapshot); });

  ipcMain.handle('app:version', () => app.getVersion());

  /* 服务器类型元数据（设置页 / 引导页用于渲染文案与占位符） */
  ipcMain.handle('app:providers', () => ({
    default: providers.DEFAULT_KIND,
    items: providers.PROVIDERS,
  }));

  ipcMain.handle('app:openSettings', () => { openSettings(); return true; });

  ipcMain.handle('app:quit', () => { quitting = true; app.quit(); return true; });

  /* --- 窗口 --- */
  ipcMain.handle('window:toggleInfo', () => { toggleInfoFromMini(); return isInfoVisible(); });
  ipcMain.handle('window:showInfo', () => { showInfo(true); return true; });
  ipcMain.handle('window:collapse', () => { showInfo(false); setWidgetVisible(true); return true; });
  ipcMain.handle('window:toggleMini', () => { toggleMini(); return isVisible(miniWin); });
  ipcMain.handle('window:hideMini', () => { showMini(false); return true; });
  ipcMain.handle('window:toggleTop', () => { toggleTop(); return isVisible(topWin); });
  ipcMain.handle('window:hideTop', () => { showTop(false); return true; });
  ipcMain.handle('window:state', () => ({
    top: isVisible(topWin),
    mini: isVisible(miniWin),
    info: isInfoVisible(),
    widgetMode: widgetMode(),
  }));

  /* --- 组件样式：时钟卡片 ⇄ 简约条 --- */
  ipcMain.handle('widget:setMode', (_e, mode) => switchWidgetMode(mode));

  /* --- 简约条拖动（渲染进程用 pointer 事件驱动，保证「单击」不被拖动区吞掉）--- */
  ipcMain.on('mini:dragBegin', () => {
    if (miniWin && !miniWin.isDestroyed()) miniDragOrig = miniWin.getBounds();
  });
  ipcMain.on('mini:dragTo', (_e, dx) => {
    if (!miniWin || miniWin.isDestroyed() || !miniDragOrig) return;
    const wa = screen.getDisplayMatching(miniWin.getBounds()).workArea;
    const x = Math.max(wa.x, Math.min(Math.round(miniDragOrig.x + Number(dx || 0)), wa.x + wa.width - MINI_W));
    miniWin.setBounds({ x, y: wa.y, width: MINI_W, height: MINI_H }); // 始终吸附工作区顶部
  });
  ipcMain.on('mini:dragEnd', () => {
    if (!miniWin || miniWin.isDestroyed()) return;
    const b = miniWin.getBounds();
    store.save({ miniBounds: { x: b.x, y: b.y, width: MINI_W, height: MINI_H } });
    miniDragOrig = null;
  });

  /* --- 时钟卡片自由拖动（dx/dy 均为相对起点的位移，夹在工作区内）--- */
  ipcMain.on('top:dragBegin', () => {
    if (topWin && !topWin.isDestroyed()) topDragOrig = topWin.getBounds();
  });
  ipcMain.on('top:dragTo', (_e, dx, dy) => {
    if (!topWin || topWin.isDestroyed() || !topDragOrig) return;
    const wa = screen.getDisplayMatching(topWin.getBounds()).workArea;
    const x = Math.max(wa.x, Math.min(Math.round(topDragOrig.x + Number(dx || 0)), wa.x + wa.width - TOP_W));
    const y = Math.max(wa.y, Math.min(Math.round(topDragOrig.y + Number(dy || 0)), wa.y + wa.height - TOP_H));
    topWin.setBounds({ x, y, width: TOP_W, height: TOP_H });
  });
  ipcMain.on('top:dragEnd', () => {
    if (!topWin || topWin.isDestroyed()) return;
    const b = topWin.getBounds();
    store.save({ topBounds: { x: b.x, y: b.y, width: TOP_W, height: TOP_H } });
    topDragOrig = null;
  });

  /* --- 控制 --- */
  ipcMain.handle('action:docker', async (_e, payload) => {
    const srv = store.active();
    if (!srv) return { ok: false, error: '尚未配置服务器' };
    const { id, action } = payload || {};
    try {
      await providers.containerAction(srv, id, action);
      setTimeout(() => poll(true), 900);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('action:vm', async (_e, payload) => {
    const srv = store.active();
    if (!srv) return { ok: false, error: '尚未配置服务器' };
    const { id, action } = payload || {};
    try {
      await providers.guestAction(srv, id, action);
      setTimeout(() => poll(true), 900);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

function isVisible(w) { return !!(w && !w.isDestroyed() && w.isVisible()); }
function isInfoVisible() { return isVisible(infoWin); }

/* ----------------------------------------------------------------- 小工具 */
function debounce(fn, ms) {
  let t = null;
  return function () {
    if (t) clearTimeout(t);
    const args = arguments;
    t = setTimeout(() => { t = null; fn.apply(null, args); }, ms);
  };
}

/* --------------------------------------------------------------- 生命周期 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (infoWin && !infoWin.isDestroyed()) { infoWin.show(); infoWin.focus(); }
    else { setWidgetVisible(true); }
  });

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('top.nasassistant.widget');
    registerIpc();
    createTray();
    createTop();
    createMini();
    createInfo();

    const cfg = store.load();
    if (cfg.autoStart) setAutoStart(true);

    // 没有可用服务器 → 组件无意义，直接展示详情窗口的「添加服务器」引导页
    const srv = store.active();
    if (!isConfigured(srv)) {
      showTop(false);
      showMini(false);
      showInfo(true);
    } else {
      // 按 widgetMode 亮出对应组件（默认「时钟卡片」），另一个保持隐藏
      if (widgetMode() === 'mini') {
        showTop(false);
        showMini(cfg.miniVisible !== false);
      } else {
        showMini(false);
        showTop(cfg.topVisible !== false);
      }
      showInfo(!!cfg.infoVisible);
    }

    startPolling();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) { createTop(); createMini(); createInfo(); }
      else { setWidgetVisible(true); }
    });

    // 冒烟测试钩子：UNRAID_WIDGET_SMOKE=<png路径> 自动截图后退出
    //   UNRAID_SMOKE_TARGET = info（默认）| mini | top
    //   UNRAID_WIDGET_SMOKE_JS / UNRAID_WIDGET_SMOKE_DELAY 可选
    if (process.env.UNRAID_WIDGET_SMOKE) {
      runSmokeTest(process.env.UNRAID_WIDGET_SMOKE);
    }
  });

  app.on('before-quit', () => { quitting = true; stopPolling(); });
  app.on('window-all-closed', () => { /* 常驻托盘，不退出 */ });
}

function runSmokeTest(shot) {
  const target = String(process.env.UNRAID_SMOKE_TARGET || 'info').toLowerCase();
  setTimeout(async () => {
    try {
      const w = target === 'mini' ? miniWin : (target === 'top' ? topWin : infoWin);
      if (w && !w.isDestroyed()) {
        if (target !== 'mini') w.show();
        const js = process.env.UNRAID_WIDGET_SMOKE_JS;
        if (js) {
          await w.webContents.executeJavaScript(js).catch(() => {});
          await new Promise((r) => setTimeout(r, 700));
        }
        const img = await w.webContents.capturePage();
        fs.writeFileSync(shot, img.toPNG());
        console.log('SMOKE_OK ' + shot);
      } else {
        console.log('SMOKE_FAIL no window');
      }
    } catch (e) {
      console.log('SMOKE_FAIL ' + e.message);
    }
    quitting = true;
    app.quit();
  }, Number(process.env.UNRAID_WIDGET_SMOKE_DELAY) || 6500);
}
