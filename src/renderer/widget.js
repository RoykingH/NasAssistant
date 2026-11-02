'use strict';
/* ==========================================================================
 * Unraid 挂件 · 详情面板渲染逻辑
 * 设计稿 ui/info.png —— 三项指标 / Docker 容器 / 虚拟机 / 服务器详情
 * ========================================================================*/
const $ = (id) => document.getElementById(id);

let SNAP = null;
const expanded = new Set();               // 展开的条目："docker:<id>" / "vms:<id>"
const busy = new Set();                   // 操作中的条目
const collapsed = { docker: false, vms: false, srv: false };
const lastSig = { docker: null, vms: null, srv: null };
let toastTimer = null;

/* 视图状态：null(未定) / 'onboard'(首次配置) / 'main'(监控) */
let view = null;
let entryLocked = false;
let entryLockTimer = null;
let onboardPrefilled = false;

/* provider 元数据（由主进程提供；引导页文案随类型变化） */
let PROV = null;
let obType = 'unraid';
/** 已保存的服务器列表 + 活动 id（由主进程 state/servers 推送） */
let SERVERS = [];
let ACTIVE_ID = '';
/** 正在引导页「添加服务器」时标记为新服务器（不复用旧条目） */
let obEditingId = null;
function meta(kind) {
  if (PROV && PROV.items && PROV.items[kind]) return PROV.items[kind];
  const FB = {
    unraid: { label: 'Unraid', credentialLabel: 'API Key', authMode: 'apikey', containerLabel: 'Docker 容器', guestLabel: '虚拟机', urlHint: '', urlNote: '', docsUrl: 'https://docs.unraid.net/API/how-to-use-the-api/' },
    proxmox: { label: 'Proxmox VE', credentialLabel: 'API Token', authMode: 'apikey', containerLabel: 'LXC 容器', guestLabel: 'QEMU 虚拟机', urlHint: '', urlNote: '', docsUrl: 'https://pve.proxmox.com/pve-docs/' },
    dsm: { label: 'Synology DSM', credentialLabel: '账号', credentialLabel2: '密码', authMode: 'password', containerLabel: 'Docker 容器', guestLabel: '虚拟机', urlHint: '', urlNote: '', docsUrl: '' },
    fnos: { label: '飞牛 fnOS', credentialLabel: '账号', credentialLabel2: '密码', authMode: 'password', containerLabel: 'Docker 容器', guestLabel: '虚拟机', urlHint: '', urlNote: '', docsUrl: 'https://github.com/FNOSP/fnnas-api' },
  };
  return FB[kind] || FB.unraid;
}
/** 该类型是否走账号密码登录 */
function isPasswordAuth(kind) {
  const m = meta(kind);
  return m.authMode === 'password' || kind === 'dsm';
}
/** 服务器类型徽标底色（与详情页头像色板同源，按类型固定） */
const TYPE_COLOR = { unraid: '#0a69fe', proxmox: '#e57000', dsm: '#1f8fd8', fnos: '#14b8a6' };

/* ------------------------------------------------------------ 小工具 */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function icon(id, cls) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  if (cls) svg.setAttribute('class', cls);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + id);
  svg.appendChild(use);
  return svg;
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function pairText(a, b) {
  if (!a || !b || a === '—' || b === '—') return '';
  return a + ' · ' + b;
}
/** 指标行文本紧凑化：「15.2 GB」→「15.2GB」（设计稿不带空格） */
function tight(s) {
  const t = String(s == null ? '' : s);
  return t.replace(/([0-9])\s+([A-Za-z])/g, '$1$2');
}
/** 设置文本并给截断内容加 tooltip */
function setText(id, text) {
  const e = $(id);
  const t = text == null ? '' : String(text);
  e.textContent = t;
  if (e.scrollWidth > e.clientWidth + 1) e.title = t;
  else e.removeAttribute('title');
}
function shortId(id) {
  const s = String(id || '');
  const tail = s.includes(':') ? s.split(':').pop() : s;
  return tail.slice(0, 12);
}
function toast(msg, bad) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

/* 由镜像名生成稳定的头像底色 */
const AVATAR_COLORS = [
  ['#1f6feb', '#dbeafe'], ['#14855f', '#d6ffee'], ['#8b5cf6', '#efe7ff'],
  ['#c2410c', '#ffe6d5'], ['#0e7490', '#cffafe'], ['#a16207', '#fef3c7'],
  ['#be123c', '#ffe4e6'], ['#4338ca', '#e0e7ff'],
];
function avatarColor(seed) {
  let h = 0;
  const s = String(seed || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/* --------------------------------------------------------------------------
 * 虚拟机头像
 * 现状：Unraid GraphQL 的 VmDomain 只有 id/uuid/name/state，**不返回图标**，
 * 且 Unraid Web 端 /plugins/dynamix.vm.manager/templates/images/ 需要登录会话
 * （匿名与 x-api-key 均 302 跳登录），因此无法取得官方图标。
 * 处理：若后端将来返回 icon 字段则直接用它；否则退化为「名称首字大写 + 随机底色」。
 * 随机底色按名称缓存，同一台虚拟机在本次运行内保持稳定，避免每次轮询闪色。
 * ------------------------------------------------------------------------ */
const VM_PALETTE = [
  ['#7c3aed', '#ede9fe'], ['#2563eb', '#dbeafe'], ['#0d9488', '#ccfbf1'],
  ['#db2777', '#fce7f3'], ['#ea580c', '#ffedd5'], ['#65a30d', '#ecfccb'],
  ['#0891b2', '#cffafe'], ['#c026d3', '#fae8ff'], ['#4f46e5', '#e0e7ff'],
  ['#b45309', '#fef3c7'], ['#059669', '#d1fae5'], ['#dc2626', '#fee2e2'],
  ['#0f766e', '#ccfbf1'], ['#9333ea', '#f3e8ff'], ['#1d4ed8', '#dbeafe'],
  ['#be185d', '#fce7f3'],
];
const vmColorCache = new Map();
function vmColor(name) {
  const key = String(name || '(未命名)');
  if (!vmColorCache.has(key)) {
    vmColorCache.set(key, VM_PALETTE[Math.floor(Math.random() * VM_PALETTE.length)]);
  }
  return vmColorCache.get(key);
}
/** 名称首字（字母转大写 / 汉字原样），无可用字符时回退 '?' */
function initialsOf(name) {
  const n = String(name || '').trim();
  const m = n.match(/[A-Za-z0-9\u4e00-\u9fa5]/);
  return (m ? m[0] : (n[0] || '?')).toUpperCase();
}
/** 无图标时把容器涂成首字母头像 */
function paintVmAvatar(ico, it) {
  ico.textContent = initialsOf(it.name);
  const c = vmColor(it.name);
  ico.style.background = c[0];
  ico.style.color = c[1];
  ico.classList.add('vm-avatar');
}

/* ---------------------------------------------------------- 视图切换 */
function setView(next) {
  if (view === next) return;
  view = next;
  const onboard = next === 'onboard';
  $('card').dataset.view = next;
  $('onboard').hidden = !onboard;
  $('viewMain').hidden = onboard;
  if (!onboard) $('body').scrollTop = 0;
}

/* ==========================================================================
 * 渲染
 * ========================================================================*/
function render(s) {
  SNAP = s;
  const errEl = $('err');
  const dot = $('dot');
  const unconfigured = !s || (s.unconfigured && !s.ok);

  /* 服务器列表随快照下发，先同步到本地状态并刷新切换器 */
  if (s && Array.isArray(s.servers)) {
    SERVERS = s.servers;
    ACTIVE_ID = s.activeId || '';
    syncServerMenu();
  }

  if (entryLocked && unconfigured) return;

  /* ---------------- 未配置：添加服务器引导页 ---------------- */
  if (unconfigured) {
    setView('onboard');
    $('srvName').textContent = '添加服务器';
    $('srvSub').textContent = '填写地址与凭据开始监控';
    dot.className = 'dot';
    errEl.hidden = true;
    prefillOnboard();
    return;
  }

  entryLocked = false;
  setView('main');

  /* ---------------- 加载中（切换服务器后的过渡骨架）---------------- */
  if (!s.ok && s.loading) {
    const cur = activeServer();
    $('srvName').textContent = (cur && (cur.name || cur.url)) || s.host || '服务器';
    $('srvSub').textContent = '连接中…';
    dot.className = 'dot';
    errEl.hidden = true;
    applySectionLabels(s);
    clearMetrics();
    renderDockerList(null);
    renderVmList(null);
    renderServerDetail(null);
    return;
  }

  /* ---------------- 连接异常 ---------------- */
  if (!s.ok) {
    const cur = activeServer();
    $('srvName').textContent = (cur && (cur.name || cur.url)) || s.host ||
      (PROV ? meta(s.provider || activeType()).label : '服务器');
    $('srvSub').textContent = '连接异常';
    dot.className = 'dot bad';
    errEl.hidden = false;
    errEl.textContent = s.error || '未知错误';
    applySectionLabels(s);
    clearMetrics();
    renderDockerList(null);
    renderVmList(null);
    renderServerDetail(null);
    return;
  }

  /* ---------------- 正常 ---------------- */
  errEl.hidden = true;
  dot.className = 'dot ok';
  /* 标题优先显示用户自定义名，其次服务器主机名 */
  const cur = activeServer();
  $('srvName').textContent = (cur && cur.name) || s.server.name || s.host || '服务器';
  $('srvSub').textContent = [
    s.ip,
    s.server.version ? (s.server.versionPrefix || '') + ' ' + s.server.version : null,
  ].filter(Boolean).join(' · ') || s.host || '';

  applySectionLabels(s);
  renderMetrics(s);
  renderDockerList(s);
  renderVmList(s);
  renderServerDetail(s);
}

/** 当前活动服务器条目 */
function activeServer() {
  return SERVERS.find((x) => x.id === ACTIVE_ID) || null;
}
/** 当前活动服务器的类型（回退快照 provider / 默认） */
function activeType() {
  const cur = activeServer();
  return (cur && cur.type) || (SNAP && SNAP.provider) || (PROV && PROV.default) || 'unraid';
}

/* ==========================================================================
 * 服务器切换器
 * ========================================================================*/
function syncServerMenu() {
  const n = SERVERS.length;
  const countEl = $('swapCount');
  /* 只有一台服务器且已配置好 → 无需切换入口 */
  const show = n > 1;
  $('hd').classList.toggle('single', !show);
  if (countEl) {
    countEl.textContent = String(n);
    countEl.hidden = !show;
  }
  const btn = $('btnSwap');
  if (btn) { btn.disabled = n < 1; btn.title = show ? '切换服务器（共 ' + n + ' 台）' : '服务器'; }
  if (!$('srvMenu').hidden) renderServerMenuList();
}

function renderServerMenuList() {
  const list = $('srvMenuList');
  list.textContent = '';
  for (const s of SERVERS) {
    const m = meta(s.type);
    const item = el('button', 'srv-item' + (s.id === ACTIVE_ID ? ' is-active' : ''));
    item.type = 'button';
    item.dataset.id = s.id;

    const ico = el('span', 'srv-item-ico', (s.name || s.url || '?').trim().charAt(0).toUpperCase() || '?');
    ico.style.background = TYPE_COLOR[s.type] || '#3a4656';
    item.appendChild(ico);

    const txt = el('div', 'srv-item-txt');
    txt.appendChild(el('div', 'srv-item-name', s.name || displayHostOf(s)));
    txt.appendChild(el('div', 'srv-item-sub', m.label + ' · ' + displayHostOf(s)));
    item.appendChild(txt);

    const tick = el('span', 'srv-item-tick');
    tick.appendChild(icon('i-play', null));
    item.appendChild(tick);

    list.appendChild(item);
  }
  if (!SERVERS.length) {
    const empty = el('div', 'srv-item-sub', '还没有保存任何服务器');
    empty.style.padding = '10px 8px';
    list.appendChild(empty);
  }
}

/** 从 url 里取 host 展示 */
function displayHostOf(s) {
  const raw = String((s && s.url) || '');
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
    return u.host || raw;
  } catch (_) {
    return raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  }
}

function openServerMenu() {
  if (!SERVERS.length) { window.api.openSettings(); return; }
  renderServerMenuList();
  $('srvMenu').hidden = false;
  $('btnSwap').setAttribute('aria-expanded', 'true');
}
function closeServerMenu() {
  $('srvMenu').hidden = true;
  $('btnSwap').setAttribute('aria-expanded', 'false');
}
function toggleServerMenu() {
  if ($('srvMenu').hidden) openServerMenu(); else closeServerMenu();
}

/** 切换到指定服务器 */
async function switchTo(id) {
  if (!id || id === ACTIVE_ID) { closeServerMenu(); return; }
  closeServerMenu();
  expanded.clear();
  try {
    const r = await window.api.setActiveServer(id);
    if (r && r.ok) {
      const cur = r.active || {};
      toast('已切换到 ' + (cur.name || displayHostOf(cur)));
      await window.api.refresh();
    } else {
      toast('切换失败：' + ((r && r.error) || '未知错误'), true);
    }
  } catch (e) {
    toast('切换失败：' + e.message, true);
  }
}

/** 区块标题随服务器类型变化（Docker 容器 / LXC 容器 等） */
function applySectionLabels(s) {
  const kind = (s && s.provider) || activeType();
  const m = meta(kind);
  const d = s && s.docker && s.docker.label ? s.docker.label : m.containerLabel;
  const v = s && s.vms && s.vms.label ? s.vms.label : m.guestLabel;
  const dt = $('secDocker').querySelector('.sec-title');
  const vt = $('secVms').querySelector('.sec-title');
  if (dt && dt.textContent !== d) dt.textContent = d;
  if (vt && vt.textContent !== v) vt.textContent = v;
}

/* ------------------------------------------------------------ 三项指标 */
function renderMetrics(s) {
  const cpu = s.cpu.pct;
  const ram = s.ram.pct;
  const disk = s.disk.pct;

  animText('cpuVal', num(cpu, '%'));
  animText('ramVal', num(ram, '%'));
  // 存储：优先展示「已用容量」，与设计稿一致
  animText('diskVal', tight((s.disk.usedText && s.disk.usedText !== '—')
    ? s.disk.usedText : num(disk, '%')));

  const cores = s.cpu.cores ? (s.cpu.threads && s.cpu.threads !== s.cpu.cores
    ? s.cpu.cores + '/' + s.cpu.threads
    : String(s.cpu.cores)) : null;
  setText('cpuCap', cpu == null
    ? (s.cpu.brand || '—')
    : '使用 ' + Math.round(cpu) + '%' + (cores ? ' · ' + cores + ' 核' : ''));

  setText('ramCap', [
    s.ram.usedText && s.ram.usedText !== '—' ? '已用 ' + tight(s.ram.usedText) : null,
    s.ram.totalText && s.ram.totalText !== '—' ? '共 ' + tight(s.ram.totalText) : null,
  ].filter(Boolean).join(' · ') || '—');

  setText('diskCap', [
    s.disk.freeText && s.disk.freeText !== '—' ? '剩余 ' + tight(s.disk.freeText) : null,
    s.disk.totalText && s.disk.totalText !== '—' ? '共 ' + tight(s.disk.totalText) : null,
  ].filter(Boolean).join(' · ') || '—');

  setBar('ramBar', ram, 'green');
  setBar('diskBar', disk, 'amber');
  drawSpark(s.history);

  /* 实时网络速率（上传 / 下载），无实时数据时退回链路速率文案 */
  const net = s.net || {};
  animText('netRx', (net.rxText && net.rxText !== '—') ? tight(net.rxText) : '—');
  animText('netTx', (net.txText && net.txText !== '—') ? tight(net.txText) : '—');
  setText('netCap', [
    net.iface || null,
    (net.speedText && net.speedText !== '—') ? tight(net.speedText) : null,
  ].filter(Boolean).join(' · ') || '—');
}

/* ---------------------------------------------------- 数值动画（缓动到新值）
 * 只对「数字 + 单位后缀」形态的文本做补间（如 67% / 152GB / 72.6MB/s），
 * 首帧直接就位、不出现从 0 冲上来的抖动；单位变化或非数字文本则直接赋值。
 * ------------------------------------------------------------------------ */
const TW = new Map();          // key -> { raf }
function parseMeasure(s) {
  const m = String(s == null ? '' : s).match(/^(\d+(?:\.\d+)?)([\s\S]*)$/);
  if (!m) return null;
  return { n: parseFloat(m[1]), u: m[2], dec: (m[1].split('.')[1] || '').length };
}
function stopTween(key) {
  const st = TW.get(key);
  if (st && st.raf) cancelAnimationFrame(st.raf);
  TW.delete(key);
}
function animText(id, text, dur) {
  const e = $(id);
  const to = text == null ? '' : String(text);
  const key = 't:' + id;
  const a = parseMeasure(e.textContent);
  const b = parseMeasure(to);
  if (!a || !b || a.u !== b.u || Math.abs(a.n - b.n) < 1e-6) {
    stopTween(key);
    e.textContent = to;
    if (e.scrollWidth > e.clientWidth + 1) e.title = to; else e.removeAttribute('title');
    return;
  }
  stopTween(key);
  const from = a.n, DUR = dur || 650, t0 = performance.now();
  const st = { raf: 0 };
  TW.set(key, st);
  const step = (t) => {
    /* rAF 时间戳可能早于上面取的 t0（帧起始时刻），必须钳到 [0,1]，
       否则 k 为负会让缓动反向、数值朝错误方向漂移。 */
    const k = Math.max(0, Math.min(1, (t - t0) / DUR));
    const ease = 1 - Math.pow(1 - k, 3);          // easeOutCubic
    e.textContent = (from + (b.n - from) * ease).toFixed(b.dec) + b.u;
    if (k < 1) st.raf = requestAnimationFrame(step);
    else { st.raf = 0; TW.delete(key); e.textContent = to; }
  };
  st.raf = requestAnimationFrame(step);
}
function stopAllTweens() { for (const k of [...TW.keys()]) stopTween(k); }
function num(v, suffix) {
  return v == null || !isFinite(v) ? '—' : Math.round(v) + (suffix || '');
}
function setBar(id, pct, kind) {
  const b = $(id);
  if (pct == null || !isFinite(pct)) { b.style.width = '0%'; return; }
  b.style.width = Math.max(1.5, Math.min(100, pct)) + '%';
  b.classList.toggle('amber', kind === 'amber' && pct < 90);
  b.classList.toggle('red', pct >= 90);
}

/** CPU 折线：history 为百分比数组（最长 48 点） */
function drawSpark(history) {
  const line = $('cpuLine');
  const pts = Array.isArray(history) ? history.filter((v) => typeof v === 'number' && isFinite(v)) : [];
  if (pts.length < 2) {
    line.setAttribute('d', '');
    return;
  }
  const W = 100, H = 18, pad = 1.6;
  const max = Math.max(100, Math.max.apply(null, pts));
  const step = W / (pts.length - 1);
  const d = pts.map((v, i) => {
    const x = (i * step).toFixed(2);
    const y = (H - pad - (Math.max(0, v) / max) * (H - pad * 2)).toFixed(2);
    return (i ? 'L' : 'M') + x + ' ' + y;
  }).join(' ');
  line.setAttribute('d', d);
}
function clearMetrics() {
  stopAllTweens();
  $('cpuVal').textContent = '—';
  $('ramVal').textContent = '—';
  $('diskVal').textContent = '—';
  $('cpuCap').textContent = '';
  $('ramCap').textContent = '';
  $('diskCap').textContent = '';
  $('netRx').textContent = '—';
  $('netTx').textContent = '—';
  $('netCap').textContent = '';
  setBar('ramBar', null);
  setBar('diskBar', null);
  $('cpuLine').setAttribute('d', '');
}

/* ==========================================================================
 * Docker 容器
 * ========================================================================*/
function renderDockerList(s) {
  const sec = $('secDocker');
  const listEl = $('dockerList');
  const subEl = $('dockerSub');
  const sec$ = s ? s.docker : null;

  const sig = !sec$
    ? 'null'
    : !sec$.ok
      ? 'err|' + sec$.error
      : 'ok|' + sec$.items.map((i) => i.id + ':' + i.state).join(',') +
        '|e:' + [...expanded].filter((k) => k.startsWith('docker:')).join(',') +
        '|b:' + [...busy].filter((k) => k.startsWith('docker:')).join(',');
  if (sig === lastSig.docker) return;
  lastSig.docker = sig;

  listEl.textContent = '';
  if (!sec$) { subEl.textContent = ''; return; }

  const up = sec$.items.filter((i) => i.running).length;
  subEl.textContent = sec$.ok ? up + ' 个运行中' : '不可用';

  if (!sec$.ok) {
    if (sec$.notInstalled) {
      listEl.appendChild(el('div', 'sec-err', (sec$.label || '容器') + '：未安装套件'));
      if (sec$.hint) listEl.appendChild(el('div', 'sec-hint', sec$.hint));
    } else {
      listEl.appendChild(el('div', 'sec-err', (sec$.label || '容器') + '不可用：' + (sec$.error || '未知错误')));
    }
    return;
  }
  if (!sec$.items.length) {
    listEl.appendChild(el('div', 'empty', '暂无容器'));
    return;
  }

  const wrap = el('div', 'list');
  for (const it of sec$.items) wrap.appendChild(buildDockerRow(it));
  listEl.appendChild(wrap);
}

function buildDockerRow(it) {
  const key = 'docker:' + it.id;

  const row = el('div', 'row' + (expanded.has(key) ? ' open' : ''));
  row.dataset.key = key;
  row.dataset.id = it.id;

  /* 图标：优先 Unraid 模板图标，否则用首字母头像 */
  const ico = el('div', 'dev-ico');
  if (it.icon) {
    const img = document.createElement('img');
    img.src = it.icon;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => {
      ico.textContent = it.initial || '?';
      const c = avatarColor(it.image || it.name);
      ico.style.background = c[0];
      ico.style.color = c[1];
    });
    ico.appendChild(img);
  } else {
    ico.textContent = it.initial || '?';
    const c = avatarColor(it.image || it.name);
    ico.style.background = c[0];
    ico.style.color = c[1];
  }
  row.appendChild(ico);

  /* 名称 + 状态 */
  const txt = el('div', 'row-txt');
  const nm = el('div', 'row-name', it.name || '(未命名)');
  if (it.name && it.name.length > 14) nm.title = it.name;
  txt.appendChild(nm);
  const sub = el('div', 'row-sub');
  sub.appendChild(el('span', 'st ' + (it.running ? 'run' : 'stop')));
  sub.appendChild(el('span', null, it.stateLabel || it.state || '未知'));
  txt.appendChild(sub);
  row.appendChild(txt);

  row.appendChild(icon('i-chev-r', 'chev'));

  const frag = document.createDocumentFragment();
  frag.appendChild(row);
  if (expanded.has(key)) frag.appendChild(buildDockerPanel(it));
  return frag;
}

function buildDockerPanel(it) {
  const panel = el('div', 'panel');
  panel.dataset.id = it.id;
  panel.dataset.key = 'docker:' + it.id;
  const kv = el('div', 'panel-kv');
  const add = (k, v) => {
    const cell = el('div', 'cell');
    cell.appendChild(el('span', 'k', k));
    cell.appendChild(el('span', 'v', v == null || v === '' ? '—' : String(v)));
    kv.appendChild(cell);
  };
  const isPve = it.type === 'lxc' || it.type === 'qemu' || it.node;

  if (isPve) {
    add('状态', it.template ? '模板' : (it.stateLabel || it.state || '未知'));
    add('类型', pveType(it));
    add('VMID', it.vmid == null ? null : String(it.vmid));
    add('节点', it.node);
    add('核心', it.cores == null ? null : it.cores + ' 核');
    if (it.memText) add('内存', it.memText);
    if (it.diskText) add('磁盘', it.diskText);
    if (it.cpuText) add('CPU', it.cpuText);
    if (it.uptimeText) add('运行', it.uptimeText);
    if (it.tags) add('标签', it.tags);
  } else {
    add('镜像', it.image);
    add('状态', it.status || it.stateLabel || it.state);
    add('创建于', it.createdText);
    add('自启动', it.autoStart ? '是' : '否');
    add('标识', shortId(it.id));
  }
  panel.appendChild(kv);

  const acts = el('div', 'panel-acts');
  const key = 'docker:' + it.id;
  acts.appendChild(mkBtn('start', 'i-play', '启动', it.running, busy.has(key)));
  acts.appendChild(mkBtn('stop', 'i-stop', '停止', !it.running, busy.has(key)));
  acts.appendChild(mkBtn('restart', 'i-restart', '重启', !it.running, busy.has(key)));
  panel.appendChild(acts);
  return panel;
}

/* ==========================================================================
 * 虚拟机
 * ========================================================================*/
function renderVmList(s) {
  const listEl = $('vmsList');
  const subEl = $('vmsSub');
  const sec$ = s ? s.vms : null;

  const sig = !sec$
    ? 'null'
    : !sec$.ok
      ? 'err|' + sec$.error
      : 'ok|' + sec$.items.map((i) => i.id + ':' + i.state).join(',') +
        '|e:' + [...expanded].filter((k) => k.startsWith('vms:')).join(',') +
        '|b:' + [...busy].filter((k) => k.startsWith('vms:')).join(',');
  if (sig === lastSig.vms) return;
  lastSig.vms = sig;

  listEl.textContent = '';
  if (!sec$) { subEl.textContent = ''; return; }

  const up = sec$.items.filter((i) => i.running).length;
  subEl.textContent = sec$.ok ? up + ' 个运行中' : '不可用';

  if (!sec$.ok) {
    if (sec$.notInstalled) {
      listEl.appendChild(el('div', 'sec-err', (sec$.label || '虚拟机') + '：未安装套件'));
      if (sec$.hint) listEl.appendChild(el('div', 'sec-hint', sec$.hint));
    } else {
      listEl.appendChild(el('div', 'sec-err', (sec$.label || '虚拟机') + '不可用：' + (sec$.error || '未知错误')));
    }
    return;
  }
  if (!sec$.items.length) {
    listEl.appendChild(el('div', 'empty', '暂无虚拟机'));
    return;
  }

  const wrap = el('div', 'list');
  for (const it of sec$.items) wrap.appendChild(buildVmRow(it));
  listEl.appendChild(wrap);
}

function buildVmRow(it) {
  const key = 'vms:' + it.id;

  const row = el('div', 'row' + (expanded.has(key) ? ' open' : ''));
  row.dataset.key = key;
  row.dataset.id = it.id;

  /* 图标：后端若返回 icon 则用图标，否则用「名称首字大写 + 随机底色」 */
  const ico = el('div', 'dev-ico');
  if (it.icon) {
    const img = document.createElement('img');
    img.src = it.icon;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => { ico.textContent = ''; paintVmAvatar(ico, it); });
    ico.appendChild(img);
  } else {
    paintVmAvatar(ico, it);
  }
  row.appendChild(ico);

  const txt = el('div', 'row-txt');
  txt.appendChild(el('div', 'row-name', it.name || '(未命名)'));
  const sub = el('div', 'row-sub');
  sub.appendChild(el('span', 'st ' + (it.running ? 'run' : 'stop')));
  sub.appendChild(el('span', null, it.stateLabel || it.state || '未知'));
  txt.appendChild(sub);
  row.appendChild(txt);

  row.appendChild(icon('i-chev-r', 'chev'));

  const frag = document.createDocumentFragment();
  frag.appendChild(row);
  if (expanded.has(key)) frag.appendChild(buildVmPanel(it));
  return frag;
}

function buildVmPanel(it) {
  const panel = el('div', 'panel');
  panel.dataset.id = it.id;
  panel.dataset.key = 'vms:' + it.id;
  const kv = el('div', 'panel-kv');
  const add = (k, v) => {
    const cell = el('div', 'cell');
    cell.appendChild(el('span', 'k', k));
    cell.appendChild(el('span', 'v', v == null || v === '' ? '—' : String(v)));
    kv.appendChild(cell);
  };
  const isPve = it.type === 'qemu' || it.type === 'lxc' || it.node;

  if (isPve) {
    add('状态', it.template ? '模板' : (it.stateLabel || it.state || '未知'));
    add('类型', pveType(it));
    add('VMID', it.vmid == null ? null : String(it.vmid));
    add('节点', it.node);
    add('核心', it.cores == null ? null : it.cores + ' 核');
    if (it.memText) add('内存', it.memText);
    if (it.diskText) add('磁盘', it.diskText);
    if (it.cpuText) add('CPU', it.cpuText);
    if (it.uptimeText) add('运行', it.uptimeText);
    if (it.tags) add('标签', it.tags);
  } else {
    add('状态', it.stateLabel || it.state || '未知');
    add('类型', it.osText || vmType(it.name));
    add('标识', it.uuid ? String(it.uuid).slice(0, 18) : shortId(it.id));
    add('域 ID', shortId(it.id));
    // 以下为 provider 返回时才显示（fnOS 提供；Unraid 未提供则自动跳过）
    if (it.vcpu != null) add('核心', it.vcpu + ' 核');
    if (it.memText) add('内存', it.memText);
    if (it.diskText) add('磁盘', it.diskText);
    if (it.cpuText) add('CPU', it.cpuText);
    if (it.usedMemText) add('实际占用', it.usedMemText);
    if (it.rxText || it.txText) add('网络', (it.rxText || '—') + ' ↓  ' + (it.txText || '—') + ' ↑');
    if (it.autoStart != null) add('自启动', it.autoStart ? '是' : '否');
  }
  panel.appendChild(kv);

  /* 操作按钮：两种类型语义一致（启动 / 停止 / 强制停止） */
  if (!it.template) {
    const acts = el('div', 'panel-acts');
    const key = 'vms:' + it.id;
    acts.appendChild(mkBtn('start', 'i-play', '启动', it.running, busy.has(key)));
    acts.appendChild(mkBtn('stop', 'i-stop', '停止', !it.running, busy.has(key)));
    acts.appendChild(mkBtn('forceStop', 'i-zap', '强制停止', !it.running, busy.has(key)));
    panel.appendChild(acts);
  } else {
    panel.appendChild(el('div', 'sec-err', '模板不可直接启停，请先克隆为实例。'));
  }
  return panel;
}

/** PVE 条目的类型展示 */
function pveType(it) {
  if (it.type === 'lxc') return 'LXC 容器';
  if (it.type === 'qemu') return 'QEMU/KVM';
  return it.type || '—';
}

/** 由虚拟机名称猜测类型（Unraid API 不返回 osType） */
function vmType(name) {
  const n = String(name || '');
  if (/windows/i.test(n)) return 'Windows';
  if (/dsm|synology/i.test(n)) return '群晖 DSM';
  if (/openwrt|lede|router/i.test(n)) return 'OpenWrt 路由';
  if (/fnos|飞牛/i.test(n)) return 'fnOS';
  if (/macos|osx/i.test(n)) return 'macOS';
  if (/debian|ubuntu|centos|kali|fedora|arch|linux|mint|rocky|alma/i.test(n)) return 'Linux';
  return '—';
}

/* ==========================================================================
 * 服务器详情
 * ========================================================================*/
function renderServerDetail(s) {
  const grid = $('srvGrid');
  if (!s) {
    grid.textContent = '';
    lastSig.srv = 'null';
    return;
  }
  const isPve = s.provider === 'proxmox';
  const cells = [
    ['i-clock', '运行时间', s.server.uptimeText],
    ['i-cpu', '处理器', shortBrand(s.cpu.brand)],
    ['i-chip', 'CPU 核心', coreText(s.cpu)],
    ['i-ram', '内存', s.ram.totalText],
    ['i-net', '网络', s.net.speedText],
    ['i-up', '上传', s.net.txText],
    ['i-down', '下载', s.net.rxText],
    // PVE 无主板信息；用「系统」展示发行版更贴切
    isPve ? ['i-board', '系统', s.server.distro] : ['i-board', '主板', s.board],
    ['i-term', '内核', s.server.kernel],
    ['i-temp', '系统温度', s.temp == null ? null : s.temp + '°C'],
  ];
  const sig = cells.map((c) => c[0] + '=' + (c[2] == null ? '' : c[2])).join('|');
  if (sig === lastSig.srv) return;
  lastSig.srv = sig;

  grid.textContent = '';
  for (const [ic, k, v] of cells) {
    const cell = el('div', 'kv2');
    cell.appendChild(icon(ic, 'ico'));
    cell.appendChild(el('span', 'k', k));
    const txt = v == null || v === '' || v === '—' ? '—' : String(v);
    const val = el('span', 'v', txt);
    if (txt !== '—') val.title = txt;     // 半宽栅格易截断，统一给完整内容提示
    cell.appendChild(val);
    grid.appendChild(cell);
  }
}
/** 处理器型号展示简化：去掉厂商前缀，半宽栅格才放得下完整型号 */
function shortBrand(v) {
  const t = String(v == null ? '' : v).trim();
  return t ? t.replace(/^(AMD|Intel|Apple|Ampere|Qualcomm|MediaTek)\s+/i, '') : t;
}
function coreText(cpu) {
  if (!cpu || cpu.cores == null) return null;
  return cpu.threads && cpu.threads !== cpu.cores
    ? cpu.cores + 'C / ' + cpu.threads + 'T'
    : cpu.cores + 'C';
}

/* ==========================================================================
 * 交互
 * ========================================================================*/
function mkBtn(action, iconId, label, disabled, isBusy) {
  const b = el('button', 'pill ' + action);
  b.dataset.act = action;
  b.appendChild(icon(iconId, null));
  b.appendChild(el('span', null, isBusy ? '处理中' : label));
  b.disabled = !!disabled || !!isBusy;
  return b;
}

function onListClick(e) {
  /* 展开面板 .panel 是 .row 的兄弟节点，必须一并匹配，
     否则面板里的按钮（虚拟机全部按钮都在面板里）点不到。 */
  const host = e.target.closest('.row, .panel');
  if (!host) return;
  const kind = e.currentTarget.id === 'dockerList' ? 'docker' : 'vms';
  const id = host.dataset.id;
  if (!id) return;

  const btn = e.target.closest('button[data-act]');
  if (btn) { e.stopPropagation(); doAction(kind, id, btn.dataset.act); return; }

  if (!host.classList.contains('row')) return;   // 面板空白处不触发折叠

  const key = kind + ':' + id;
  if (expanded.has(key)) expanded.delete(key);
  else expanded.add(key);
  if (SNAP) render(SNAP);
}

async function doAction(kind, id, act) {
  const key = kind + ':' + id;
  busy.add(key);
  if (SNAP) render(SNAP);
  const labels = { start: '启动', stop: '停止', restart: '重启', forceStop: '强制停止' };
  try {
    const res = kind === 'docker'
      ? await window.api.dockerAction(id, act)
      : await window.api.vmAction(id, act);
    if (res && res.ok) toast('已发送' + (labels[act] || act) + '指令：' + shortId(id));
    else toast('操作失败：' + ((res && res.error) || '未知错误'), true);
  } catch (err) {
    toast('操作失败：' + err.message, true);
  } finally {
    busy.delete(key);
    setTimeout(() => { if (SNAP) render(SNAP); }, 1200);
  }
}

function toggleSection(kind) {
  collapsed[kind] = !collapsed[kind];
  applyCollapsed();
  window.api.saveConfig({ sections: { [kind === 'srv' ? 'server' : kind]: !collapsed[kind] } }).catch(() => {});
}
function applyCollapsed() {
  $('secDocker').classList.toggle('collapsed', collapsed.docker);
  $('secVms').classList.toggle('collapsed', collapsed.vms);
  $('secSrv').classList.toggle('collapsed', collapsed.srv);
}

/* -------------------------------------------------- 首次配置引导页逻辑 */
/* fnOS 的「服务器地址 / FN ID」共用一个输入框，靠内容判断走哪条路：
   含协议、斜杠、冒号或点 → 按服务器地址直连；其余（纯名称）→ FN ID。
   （与设置页 settings.js 里的同名逻辑保持一致） */
function isAddressLike(v) {
  const s = String(v || '').trim();
  if (!s) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return true;
  return /[./:]/.test(s);
}
function splitAddr(v) {
  const s = String(v || '').trim();
  if (!s) return { url: '', fnId: '' };
  return isAddressLike(s) ? { url: s, fnId: '' } : { url: '', fnId: s };
}
/** 边输入边提示当前会被当成地址还是 FN ID */
function updateObAddrMode() {
  const n = $('obAddrMode');
  if (!n) return;
  const v = $('obUrl').value.trim();
  if (!v) { n.hidden = true; n.textContent = ''; return; }
  const addr = isAddressLike(v);
  n.hidden = false;
  n.className = 'addrmode ' + (addr ? 'addr' : 'fnid');
  n.textContent = addr ? '→ 按服务器地址直连' : '→ 按 FN ID 自动寻址（fnConnect）';
}

/** 应用引导页的类型相关文案（占位符 / 标签 / 文档链接） */
function applyObType(kind) {
  obType = kind;
  const m = meta(kind);
  const isPve = kind === 'proxmox';
  const isFnos = kind === 'fnos';
  const isPwd = isPasswordAuth(kind);
  const pwdName = isFnos ? 'fnOS' : 'DSM';

  for (const b of $('obTypeSeg').querySelectorAll('.ob-seg-btn')) {
    const on = b.dataset.type === kind;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  }

  $('obTitle').textContent = '添加 ' + m.label + ' 服务器';
  if (isFnos) {
    $('obDesc').textContent = '服务器地址留空时，填 FN ID 也能连：连接时向飞牛云端解析地址并按当下网络自动选路。';
  } else if (isPwd) {
    $('obDesc').textContent = '填写服务器地址与 ' + pwdName +
      ' 账号密码，点击「连接测试」验证连通性。测试通过后将自动保存，并进入监控界面。';
  } else {
    $('obDesc').textContent = '填写服务器地址与 ' + m.credentialLabel +
      '，点击「连接测试」验证连通性。测试通过后将自动保存，并进入监控界面。';
  }

  /* 地址框：fnOS 一框两用（地址 ↔ FN ID 自动识别） */
  $('obUrlLabel').innerHTML = isFnos
    ? '服务器地址 <span class="f-opt">/ FN ID</span>'
    : '服务器地址';
  if (isFnos) {
    $('obUrl').placeholder = 'http://192.168.1.40:5666  或  demo-nas';
    $('obUrlHint').hidden = false;
    $('obUrlHint').innerHTML =
      '<span class="addrmode" id="obAddrMode" hidden></span>'
      + '填 <b>FN ID</b>（如 <code>demo-nas</code>）即自动向飞牛云端解析地址并按当下网络选路；'
      + '填 IP / 域名 / 端口则按地址直连。';
    updateObAddrMode();
  } else {
    $('obUrl').placeholder = m.urlHint || 'http://192.168.1.10';
    $('obUrlHint').hidden = true;
    $('obUrlHint').textContent = '';
  }

  /* 凭据区互斥显示 */
  $('obKeyBlock').hidden = isPwd;
  $('obLoginBlock').hidden = !isPwd;
  $('obTokenBlock').hidden = !isPve;
  if (!isPwd) {
    $('obKeyLabel').textContent = m.credentialLabel;
    $('obKey').placeholder = isPve
      ? 'user@realm!tokenid=secret'
      : 'Unraid 设置 → 管理访问 → API Keys';
  } else {
    $('obUser').placeholder = pwdName + ' 登录账号（例如 admin）';
    $('obPass').placeholder = pwdName + ' 登录密码';
  }

  $('obFootTip').textContent = isPwd
    ? ('使用 ' + pwdName + ' 账号密码登录（非 API Key）。')
    : (isPve ? '不知道如何创建 API 令牌？' : '不知道如何获取 API Key？');
  if (m.docsUrl) $('obDocs').href = m.docsUrl;
  $('obDocs').textContent = isPwd ? '协议参考' : '查看官方文档';

  // 切换类型后清除上一次的测试结果
  $('obResult').hidden = true;
  $('obTest').disabled = false;
  $('obTest').classList.remove('done');
  $('obTest').textContent = '连接测试';
}

async function prefillOnboard() {
  if (!PROV) { try { PROV = await window.api.getProviders(); } catch (_) {} }
  /* 引导页只在「一台服务器都没有」时出现；此时表单应为空白新条目 */
  if (!onboardPrefilled) {
    onboardPrefilled = true;
    applyObType((PROV && PROV.default) || 'unraid');
    clearOnboardForm();
  }
}

/** 清空引导页表单（用于「添加服务器」） */
function clearOnboardForm() {
  obEditingId = null;
  $('obName').value = '';
  $('obUrl').value = '';
  $('obTokenId').value = '';
  $('obKey').value = '';
  $('obUser').value = '';
  $('obPass').value = '';
  $('obOtp').value = '';
  $('obKey').type = 'password';
  $('obPass').type = 'password';
  $('obEye').textContent = '显示';
  $('obEyePwd').textContent = '显示';
  $('obSelfSigned').checked = true;
  $('obResult').hidden = true;
  $('obTest').disabled = false;
  $('obTest').classList.remove('done');
  $('obTest').textContent = '连接测试';
}
/** 用已有服务器条目回填引导页表单（用于编辑） */
function fillOnboardForm(srv) {
  obEditingId = (srv && srv.id) || null;
  applyObType((srv && srv.type) || (PROV && PROV.default) || 'unraid');
  if (!srv) return;
  $('obName').value = srv.name || '';
  /* fnOS 的地址框里可能存的是地址，也可能只存了 FN ID ⇒ 回填时两者取其一 */
  $('obUrl').value = srv.url || srv.fnId || '';
  $('obTokenId').value = srv.tokenId || '';
  $('obKey').value = srv.apiKey || '';
  $('obUser').value = srv.username || '';
  $('obPass').value = srv.password || '';
  $('obOtp').value = srv.otpCode || '';
  $('obSelfSigned').checked = srv.allowSelfSigned !== false;
  updateObAddrMode();
}
function obResult(kind, html) {
  const r = $('obResult');
  r.hidden = false;
  r.className = 'ob-result' + (kind === 'ok' ? ' ok' : kind === 'bad' ? ' bad' : ' loading');
  r.innerHTML = html;
}
function obBlocked(msg, focusId) {
  obResult('bad', esc(msg));
  const e2 = $(focusId);
  if (e2) e2.focus();
}
function lockEntry() {
  entryLocked = true;
  if (entryLockTimer) clearTimeout(entryLockTimer);
  entryLockTimer = setTimeout(() => {
    entryLocked = false;
    if (SNAP) render(SNAP);
  }, 12000);
}
async function doOnboardTest() {
  const raw = $('obUrl').value.trim();
  const allowSelfSigned = $('obSelfSigned').checked;
  const btn = $('obTest');
  const m = meta(obType);
  const isPwd = isPasswordAuth(obType);
  const isFnos = obType === 'fnos';
  const pwdName = isFnos ? 'fnOS' : 'DSM';

  const payload = { type: obType, name: $('obName').value.trim(), url: raw, allowSelfSigned };
  if (isFnos) {
    /* 一框两用：纯名称 ⇒ FN ID，其余按服务器地址 */
    const p = splitAddr(raw);
    payload.url = p.url;
    payload.fnId = p.fnId;
  }
  if (isPwd) {
    payload.username = $('obUser').value;
    payload.password = $('obPass').value;
    payload.otpCode = $('obOtp').value.trim();
  } else {
    payload.apiKey = $('obKey').value.trim();
    if (obType === 'proxmox') payload.tokenId = $('obTokenId').value.trim();
  }

  if (!raw) {
    obBlocked(isFnos ? '请先填写服务器地址或 FN ID' : '请先填写服务器地址', 'obUrl');
    return;
  }
  if (isPwd) {
    if (!payload.username) { obBlocked('请先填写 ' + pwdName + ' 账号', 'obUser'); return; }
    if (!payload.password) { obBlocked('请先填写 ' + pwdName + ' 密码', 'obPass'); return; }
  } else if (!payload.apiKey) {
    obBlocked('请先填写 ' + m.credentialLabel, 'obKey'); return;
  }

  btn.disabled = true;
  btn.classList.remove('done');
  btn.textContent = '正在测试…';
  obResult('loading', '正在连接服务器…');

  let res;
  try {
    res = await window.api.testServer(payload);
  } catch (e) {
    res = { ok: false, error: e.message };
  }

  if (!res || !res.ok) {
    const tip = isFnos
      ? (payload.fnId ? '（FN ID 需先在 NAS 上开启 FN Connect；也可直接填地址）' : '（fnOS 默认端口 5666/HTTP、5667/HTTPS）')
      : (isPwd
        ? '（DSM 默认端口 5001/HTTPS、5000/HTTP；请确认账号密码正确，且该账号允许登录）'
        : (obType === 'proxmox'
          ? '（PVE 默认端口 8006，需 HTTPS）'
          : '，且 API Key 具备 ADMIN 角色权限'));
    obResult('bad',
      '连接失败：' + esc((res && res.error) || '未知错误') +
      '<br><span class="ob-tip">请确认' + esc(isFnos && payload.fnId ? 'FN ID' : '地址') + '与 ' +
      esc(isPwd ? '账号密码' : m.credentialLabel) +
      ' 是否正确、服务器是否可访问' + tip + '。</span>');
    btn.disabled = false;
    btn.textContent = '连接测试';
    return;
  }

  const okLine =
    '连接成功 ✓<br>服务器：<b>' + esc(res.hostname || res.endpoint || raw) + '</b>' +
    (res.route ? '<br>选路：<b>' + esc(res.route) + '</b>' : '') +
    (res.model ? ' ｜ 机型 <b>' + esc(res.model) + '</b>' : '') +
    (res.version ? ' ｜ ' + esc(m.label) + ' <b>' + esc(res.version) + '</b>' : '');

  btn.textContent = '已连接，正在保存…';
  obResult('ok', okLine + '<br>正在保存服务器信息…');

  try {
    await window.api.saveServer(Object.assign({ id: obEditingId || undefined }, payload));
  } catch (e) {
    obResult('bad', '配置保存失败：' + esc(e.message));
    btn.disabled = false;
    btn.textContent = '连接测试';
    return;
  }

  btn.classList.add('done');
  btn.textContent = '连接成功 ✓';
  obResult('ok', okLine + '<br>配置已保存，正在进入监控界面…');
  toast('服务器已添加：' + (res.hostname || raw));

  lockEntry();
  try { await window.api.refresh(); } catch (_) {}
}

/* -------------------------------------------------------------- 启动 */
(async function init() {
  /* 先取 provider 元数据，供区块标题与引导页文案使用 */
  try { PROV = await window.api.getProviders(); } catch (_) {}

  $('dockerList').addEventListener('click', onListClick);
  $('vmsList').addEventListener('click', onListClick);

  $('secDocker').querySelector('.sec-hd').addEventListener('click', () => toggleSection('docker'));
  $('secVms').querySelector('.sec-hd').addEventListener('click', () => toggleSection('vms'));
  $('secSrv').querySelector('.sec-hd').addEventListener('click', () => toggleSection('srv'));

  /* 标题栏拖动（仅非按钮区域） */
  $('hd').addEventListener('mousedown', (e) => {
    if (e.target.closest('.ic')) e.stopPropagation();
  });

  /* 引导页 */
  $('obTest').addEventListener('click', doOnboardTest);
  $('obTypeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('.ob-seg-btn');
    if (b && b.dataset.type) applyObType(b.dataset.type);
  });
  $('obEye').addEventListener('click', () => {
    const inp = $('obKey');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    $('obEye').textContent = show ? '隐藏' : '显示';
  });
  $('obEyePwd').addEventListener('click', () => {
    const inp = $('obPass');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    $('obEyePwd').textContent = show ? '隐藏' : '显示';
  });
  for (const id of ['obName', 'obUrl', 'obTokenId', 'obKey', 'obUser', 'obPass', 'obOtp']) {
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doOnboardTest(); }
    });
  }
  /* fnOS 地址框：边输入边提示走地址还是 FN ID */
  $('obUrl').addEventListener('input', () => { if (obType === 'fnos') updateObAddrMode(); });

  $('btnRefresh').addEventListener('click', async () => {
    const b = $('btnRefresh');
    b.classList.add('spin');
    try { await window.api.refresh(); } catch (_) {}
    setTimeout(() => b.classList.remove('spin'), 700);
  });
  $('btnSettings').addEventListener('click', () => window.api.openSettings());
  $('btnHide').addEventListener('click', () => window.api.collapse());

  /* ---- 服务器切换器 ---- */
  $('btnSwap').addEventListener('click', (e) => { e.stopPropagation(); toggleServerMenu(); });
  $('srvMenuList').addEventListener('click', (e) => {
    const it = e.target.closest('.srv-item');
    if (it && it.dataset.id) switchTo(it.dataset.id);
  });
  $('srvMenuAdd').addEventListener('click', () => { closeServerMenu(); window.api.openSettings(); });
  /* 点击别处 / Esc 关闭下拉 */
  document.addEventListener('click', (e) => {
    if ($('srvMenu').hidden) return;
    if (e.target.closest('#srvMenu') || e.target.closest('#btnSwap')) return;
    closeServerMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('srvMenu').hidden) closeServerMenu();
  });

  window.api.onState(render);
  /* 服务器列表变化（新增/删除/改名）时同步 */
  if (window.api.onServers) {
    window.api.onServers((p) => {
      if (!p) return;
      SERVERS = Array.isArray(p.servers) ? p.servers : [];
      ACTIVE_ID = p.activeId || '';
      syncServerMenu();
    });
  }

  try {
    const cfg = await window.api.getConfig();
    if (cfg && cfg.sections) {
      collapsed.docker = cfg.sections.docker === false;
      collapsed.vms = cfg.sections.vms === false;
      collapsed.srv = cfg.sections.server === false;
    }
  } catch (_) {}
  applyCollapsed();

  /* 先同步服务器列表，再取状态 */
  try {
    const p = await window.api.listServers();
    if (p) {
      SERVERS = Array.isArray(p.servers) ? p.servers : [];
      ACTIVE_ID = p.activeId || '';
      syncServerMenu();
    }
  } catch (_) {}

  try {
    const s = await window.api.getState();
    if (s) render(s);
    else syncServerMenu();
  } catch (_) {}
})();
