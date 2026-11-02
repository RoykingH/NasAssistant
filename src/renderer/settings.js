'use strict';
/* ==========================================================================
 * 设置窗口逻辑 —— 服务器列表 + 添加/编辑弹层
 * 支持 Unraid / Proxmox VE / Synology DSM 三种类型，字段随类型切换
 * （DSM 走账号密码登录，字段与另两家不同）。
 * ========================================================================*/
const $ = (id) => document.getElementById(id);

/* provider 元数据 */
let PROV = null;
function meta(kind) {
  if (PROV && PROV.items && PROV.items[kind]) return PROV.items[kind];
  const FB = {
    unraid: {
      label: 'Unraid', credentialLabel: 'API Key', authMode: 'apikey',
      urlHint: 'http://192.168.1.10', urlNote: '', containerLabel: 'Docker 容器', guestLabel: '虚拟机', docsUrl: '',
    },
    proxmox: {
      label: 'Proxmox VE', credentialLabel: 'API Token', authMode: 'apikey',
      urlHint: 'https://192.168.1.20:8006', urlNote: '', containerLabel: 'LXC 容器', guestLabel: 'QEMU 虚拟机', docsUrl: '',
    },
    dsm: {
      label: 'Synology DSM', credentialLabel: '账号', credentialLabel2: '密码', authMode: 'password',
      urlHint: 'https://192.168.1.30:5001', urlNote: '', containerLabel: 'Docker 容器', guestLabel: '虚拟机', docsUrl: '',
    },
  };
  return FB[kind] || FB.unraid;
}
const TYPE_COLOR = { unraid: '#0a69fe', proxmox: '#e57000', dsm: '#1f8fd8', fnos: '#14b8a6' };
/** 该类型是否走账号密码登录 */
function isPasswordAuth(kind) {
  const m = meta(kind);
  return m.authMode === 'password' || kind === 'dsm';
}

/* 列表与表单状态 */
let SERVERS = [];
let ACTIVE_ID = '';
let editingId = null;    // null = 新增
let editingFnDomain = ''; // 编辑中服务器的 fnConnect 域名（不开放设置，仅原样保留）
let curType = 'unraid';

/* ------------------------------------------------------------ 小工具 */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function svgIcon(paths, cls) {
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg');
  if (cls) s.setAttribute('class', cls);
  s.setAttribute('viewBox', '0 0 24 24');
  for (const p of paths) {
    const node = document.createElementNS(NS, 'path');
    node.setAttribute('d', p.d);
    node.setAttribute('fill', p.fill || 'none');
    node.setAttribute('stroke', p.stroke || 'currentColor');
    node.setAttribute('stroke-width', p.w || '2');
    node.setAttribute('stroke-linecap', 'round');
    node.setAttribute('stroke-linejoin', 'round');
    s.appendChild(node);
  }
  return s;
}
function hostOf(s) {
  const raw = String((s && s.url) || '');
  if (!raw) {
    // fnOS 只填了 FN ID：展示成 FN:<id>，避免卡片出现空地址
    const fnId = String((s && s.fnId) || '').trim();
    return fnId ? 'FN:' + fnId : '';
  }
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
    return u.host || raw;
  } catch (_) {
    return raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  }
}
/* --------------------------------------------------------------------------
 * fnOS 的「服务器地址 / FN ID」共用一个输入框，靠内容判断走哪条路：
 *   含协议、斜杠、冒号或点 → 按服务器地址直连
 *   其余（纯名称，如 demo-nas）→ 当 FN ID 走 fnConnect 自动寻址
 * ------------------------------------------------------------------------*/
function isAddressLike(v) {
  const s = String(v || '').trim();
  if (!s) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return true;   // http:// / wss:// …
  return /[./:]/.test(s);                                 // 端口、路径或点分主机 / IP
}
/** 拆分输入框内容 → { url, fnId }（两者互斥） */
function splitAddr(v) {
  const s = String(v || '').trim();
  if (!s) return { url: '', fnId: '' };
  return isAddressLike(s) ? { url: s, fnId: '' } : { url: '', fnId: s };
}
/** 实时告诉用户当前输入会被当成地址还是 FN ID（避免「自动判断」像个黑盒） */
function updateAddrMode() {
  const n = $('urlMode');
  if (!n) return;
  const v = $('url').value.trim();
  if (!v) { n.hidden = true; n.textContent = ''; return; }
  const addr = isAddressLike(v);
  n.hidden = false;
  n.className = 'addrmode ' + (addr ? 'addr' : 'fnid');
  n.textContent = addr ? '→ 按服务器地址直连' : '→ 按 FN ID 自动寻址（fnConnect）';
}

function showResult(kind, text) {
  const r = $('result');
  r.hidden = false;
  r.className = 'result' + (kind === 'bad' ? ' bad' : kind === 'loading' ? ' loading' : '');
  r.innerHTML = text;
}

/* ==========================================================================
 * 服务器列表渲染
 * ========================================================================*/
function renderList() {
  const box = $('srvList');
  box.textContent = '';
  $('srvCount').textContent = SERVERS.length ? '共 ' + SERVERS.length + ' 台' : '';

  if (!SERVERS.length) {
    box.appendChild(el('div', 'srv-empty', '还没有服务器，点击下方「添加服务器」开始'));
    return;
  }

  for (const s of SERVERS) {
    const m = meta(s.type);
    const card = el('div', 'srv-card' + (s.id === ACTIVE_ID ? ' is-active' : ''));
    card.dataset.id = s.id;

    const badge = el('div', 'srv-badge', (s.name || hostOf(s) || '?').trim().charAt(0).toUpperCase() || '?');
    badge.style.background = TYPE_COLOR[s.type] || '#3a4656';
    card.appendChild(badge);

    const main = el('div', 'srv-main');
    const nameRow = el('div', 'srv-name');
    nameRow.appendChild(el('span', null, s.name || hostOf(s) || '未命名'));
    const tagCls = s.type === 'proxmox' ? ' pve' : (s.type === 'dsm' ? ' dsm' : (s.type === 'fnos' ? ' fnos' : ''));
    const tag = el('span', 'srv-tag' + tagCls, m.label);
    nameRow.appendChild(tag);
    if (s.id === ACTIVE_ID) nameRow.appendChild(el('span', 'srv-tag now', '当前'));
    main.appendChild(nameRow);
    main.appendChild(el('div', 'srv-addr', hostOf(s) || (s.fnId ? '' : '（未填写地址）')));
    card.appendChild(main);

    const ops = el('div', 'srv-ops');
    /* 编辑 */
    const bEdit = el('button', 'srv-op');
    bEdit.type = 'button'; bEdit.title = '编辑'; bEdit.dataset.op = 'edit';
    bEdit.appendChild(svgIcon([
      { d: 'M12 20h9', w: '2' },
      { d: 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z', w: '1.8' },
    ]));
    ops.appendChild(bEdit);
    /* 删除 */
    const bDel = el('button', 'srv-op danger');
    bDel.type = 'button'; bDel.title = '删除'; bDel.dataset.op = 'del';
    bDel.appendChild(svgIcon([
      { d: 'M3 6h18', w: '2' },
      { d: 'M8 6V4.6A1.6 1.6 0 0 1 9.6 3h4.8A1.6 1.6 0 0 1 16 4.6V6', w: '1.8' },
      { d: 'M5.5 6l1 13.2A1.8 1.8 0 0 0 8.3 21h7.4a1.8 1.8 0 0 0 1.8-1.8L18.5 6', w: '1.8' },
    ]));
    ops.appendChild(bDel);
    card.appendChild(ops);

    box.appendChild(card);
  }
}

/* ==========================================================================
 * 弹层表单
 * ========================================================================*/
function applyType(kind) {
  curType = kind;
  const m = meta(kind);
  const isPve = kind === 'proxmox';
  const isPwd = isPasswordAuth(kind);
  const pwdName = kind === 'fnos' ? 'fnOS' : 'DSM';

  for (const b of $('typeSeg').querySelectorAll('.seg-btn')) {
    const on = b.dataset.type === kind;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  }

  $('typeHint').textContent = isPwd
    ? (kind === 'fnos'
      ? '通过 fnOS WebSocket API（混合加密 + 签名）读写，使用飞牛账号密码登录（非 API Key）。'
      : '通过群晖 DSM WebAPI（CGI）读写，使用 DSM 账号密码登录（非 API Key）。')
    : (isPve
      ? '通过 Proxmox VE REST API（/api2/json）读写，需 API Token。'
      : '通过 Unraid 官方 GraphQL API 读写（需 ADMIN 角色密钥）。');

  /* ---- 地址框：fnOS 一框两用（地址 ↔ FN ID 自动识别） ---- */
  const isFnos = kind === 'fnos';
  $('urlLabel').innerHTML = isFnos
    ? '服务器地址 <span class="opt">/ FN ID</span>'
    : '服务器地址';
  if (isFnos) {
    $('url').placeholder = 'http://192.168.1.40:5666  或  demo-nas';
    $('urlHint').innerHTML =
      '<span class="addrmode" id="urlMode" hidden></span>'
      + '填 <b>FN ID</b>（如 <code>demo-nas</code>，见 NAS 的 <b>系统设置 → 远程访问 → FN Connect</b>）'
      + '即自动向飞牛云端解析地址，并按当下网络选路（<b>局域网 → 公网 IPv4 → IPv6 → DDNS → 中继</b>）；'
      + '填 IP / 域名 / 端口则按地址直连。';
    updateAddrMode();
  } else {
    $('url').placeholder = m.urlHint || '';
    $('urlHint').innerHTML = m.urlNote || '';
  }

  /* ---- 凭据区：API Key/Token 与 账号密码 互斥显示 ---- */
  $('keyBlock').hidden = isPwd;
  $('loginBlock').hidden = !isPwd;

  if (!isPwd) {
    $('keyLabel').textContent = m.credentialLabel;
    $('apiKey').placeholder = isPve ? 'user@realm!tokenid=secret' : '在 Unraid 中生成，需要 ADMIN 角色';
    $('keyHint').innerHTML = isPve
      ? '在 PVE 中创建：<b>数据中心 → 权限 → API 令牌</b> 新建令牌（取消勾选「特权分离」可省去单独授权）。' +
        '需至少 <code>PVEAudit</code> 权限读取、<code>VM.PowerMgmt</code> 用于启停。'
      : '获取方式：Unraid WebGUI → <b>设置 → 管理访问 → API Keys</b> 新建一个 ADMIN 角色的密钥；' +
        '或命令行 <code>unraid-api apikey --create --name widget --roles ADMIN --json</code>。';
  } else {
    $('username').placeholder = pwdName + ' 登录账号（例如 admin）';
    $('password').placeholder = pwdName + ' 登录密码';
    $('loginHint').innerHTML = '使用 ' + pwdName + ' 账号密码登录（非 API Key）。若账号已开启双重验证，可在下方预填动态验证码；'
      + '登录失效时会自动重新登录。'
      + (m.docsUrl
        ? '协议参考：<a href="' + esc(m.docsUrl) + '" target="_blank">'
          + (kind === 'fnos' ? 'fnnas-api' : 'dsm_helper') + '</a>。'
        : '');
  }

  $('pveExtra').hidden = !isPve;

  const link = $('docsLink');
  if (m.docsUrl) link.href = m.docsUrl;
  link.textContent = isPwd
    ? (kind === 'fnos' ? 'fnOS WebSocket API' : 'DSM WebAPI')
    : (isPve ? 'pve.proxmox.com/pve-docs' : 'docs.unraid.net/API');

  $('result').hidden = true;
}

function openModal(srv) {
  editingId = (srv && srv.id) || null;
  editingFnDomain = (srv && srv.fnDomain) || '';
  $('mTitle').textContent = editingId ? '编辑服务器' : '添加服务器';
  $('btnSave').textContent = editingId ? '保存修改' : '保存';

  applyType((srv && srv.type) || (PROV && PROV.default) || 'unraid');
  $('name').value = (srv && srv.name) || '';
  /* fnOS 的地址框里可能存的是地址，也可能只存了 FN ID ⇒ 回填时两者取其一 */
  $('url').value = (srv && (srv.url || srv.fnId)) || '';
  $('apiKey').value = (srv && srv.apiKey) || '';
  $('tokenId').value = (srv && srv.tokenId) || '';
  $('username').value = (srv && srv.username) || '';
  $('password').value = (srv && srv.password) || '';
  $('otpCode').value = (srv && srv.otpCode) || '';
  $('allowSelfSigned').checked = !srv || srv.allowSelfSigned !== false;
  updateAddrMode();
  /* 重置密码可见性 */
  $('apiKey').type = 'password';
  $('password').type = 'password';
  $('btnEye').textContent = '显示';
  $('btnEyePwd').textContent = '显示';

  $('modal').hidden = false;
  setTimeout(() => { (isPasswordAuth(curType) ? $('username') : $('url')).focus(); }, 30);
}
function closeModal() {
  $('modal').hidden = true;
  editingId = null;
  editingFnDomain = '';
}

/** 校验当前草稿的连接字段，返回错误文案（无错则返回 ''） */
function validate(d, kind) {
  // fnOS 可以用 FN ID 替代地址
  const hasAddr = !!d.url || (kind === 'fnos' && !!d.fnId);
  if (!hasAddr) {
    return kind === 'fnos' ? '请填写服务器地址或 FN ID' : '请先填写服务器地址';
  }
  if (isPasswordAuth(kind)) {
    const pwdName = kind === 'fnos' ? 'fnOS' : 'DSM';
    if (!d.username) return '请先填写 ' + pwdName + ' 账号';
    if (!d.password) return '请先填写 ' + pwdName + ' 密码';
  } else if (!d.apiKey) {
    return '请先填写 ' + meta(kind).credentialLabel;
  }
  return '';
}

function draft() {
  const d = {
    type: curType,
    name: $('name').value.trim(),
    url: $('url').value.trim(),
    allowSelfSigned: $('allowSelfSigned').checked,
  };
  if (editingId) d.id = editingId;
  /* fnOS：地址框一框两用，按内容决定落成 url 还是 fnId；
     fnConnect 域名不开放设置，沿用原有值（新条目为空 ⇒ 走域名池） */
  if (curType === 'fnos') {
    const p = splitAddr(d.url);
    d.url = p.url;
    d.fnId = p.fnId;
    d.fnDomain = editingFnDomain;
  } else {
    d.fnId = '';
    d.fnDomain = '';
  }
  if (isPasswordAuth(curType)) {
    d.username = $('username').value;
    d.password = $('password').value;
    d.otpCode = $('otpCode').value.trim();
    /* 切到账号密码类型时，清掉旧的 key 字段避免混淆 */
    d.apiKey = '';
    d.tokenId = '';
  } else {
    d.apiKey = $('apiKey').value.trim();
    if (curType === 'proxmox') d.tokenId = $('tokenId').value.trim();
  }
  return d;
}

/* ==========================================================================
 * 启动
 * ========================================================================*/
async function refreshServers() {
  try {
    const p = await window.api.listServers();
    SERVERS = (p && Array.isArray(p.servers)) ? p.servers : [];
    ACTIVE_ID = (p && p.activeId) || '';
  } catch (_) {
    SERVERS = []; ACTIVE_ID = '';
  }
  renderList();
}

async function init() {
  /* 外部链接用系统浏览器打开 */
  document.body.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="http"]');
    if (a) { e.preventDefault(); window.open(a.href, '_blank'); }
  });

  /* provider 元数据（先取，供列表与表单文案使用） */
  try { PROV = await window.api.getProviders(); } catch (_) {}

  /* ---- 列表交互 ---- */
  $('srvList').addEventListener('click', async (e) => {
    const opBtn = e.target.closest('.srv-op');
    const card = e.target.closest('.srv-card');
    if (!card) return;
    const id = card.dataset.id;
    const srv = SERVERS.find((x) => x.id === id);
    if (!srv) return;

    if (opBtn && opBtn.dataset.op === 'edit') { openModal(srv); return; }

    if (opBtn && opBtn.dataset.op === 'del') {
      if (!confirm('确定删除服务器「' + (srv.name || hostOf(srv)) + '」？')) return;
      const r = await window.api.removeServer(id);
      await refreshServers();
      if (r && !r.removed) showResult('bad', '删除失败：未找到该服务器');
      return;
    }

    /* 点卡片空白处 = 设为当前 */
    if (id !== ACTIVE_ID) {
      await window.api.setActiveServer(id);
      await refreshServers();
    }
  });

  $('btnAdd').addEventListener('click', () => openModal(null));

  /* ---- 弹层 ---- */
  $('modalMask').addEventListener('click', closeModal);
  $('mClose').addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('modal').hidden) closeModal();
  });

  $('typeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (b && b.dataset.type) applyType(b.dataset.type);
  });

  /* fnOS 地址框：边输入边提示走地址还是 FN ID */
  $('url').addEventListener('input', () => { if (curType === 'fnos') updateAddrMode(); });

  $('btnEye').addEventListener('click', () => {
    const inp = $('apiKey');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    $('btnEye').textContent = show ? '隐藏' : '显示';
  });

  $('btnEyePwd').addEventListener('click', () => {
    const inp = $('password');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    $('btnEyePwd').textContent = show ? '隐藏' : '显示';
  });

  $('btnTest').addEventListener('click', async () => {
    const d = draft();
    const bad = validate(d, curType);
    if (bad) { showResult('bad', esc(bad)); return; }
    const b = $('btnTest');
    b.disabled = true;
    showResult('loading', '正在连接服务器…');
    try {
      const res = await window.api.testServer(d);
      if (res && res.ok) {
        const m = meta(res.provider || curType);
        showResult('ok',
          '连接成功 ✓<br>服务器：<b>' + esc(res.hostname || res.endpoint || d.url || d.fnId) + '</b>' +
          (res.model ? ' ｜ 机型 <b>' + esc(res.model) + '</b>' : '') +
          (res.version ? ' ｜ ' + esc(m.label) + ' <b>' + esc(res.version) + '</b>' : '') +
          (res.route ? '<br>选路：<b>' + esc(res.route) + '</b>' : '') +
          '<br>端点：' + esc(res.endpoint || ''));
      } else {
        showResult('bad', '连接失败：' + esc((res && res.error) || '未知错误'));
      }
    } catch (e) {
      showResult('bad', '连接失败：' + esc(e.message));
    } finally {
      b.disabled = false;
    }
  });

  $('btnSave').addEventListener('click', async () => {
    const d = draft();
    const bad = validate(d, curType);
    if (bad) { showResult('bad', esc(bad)); return; }
    const b = $('btnSave');
    b.disabled = true;
    try {
      await window.api.saveServer(d);
      await refreshServers();
      closeModal();
      /* 短暂提示（复用列表区块下方） */
      flash('已保存 ✓');
    } catch (e) {
      showResult('bad', '保存失败：' + esc(e.message));
    } finally {
      b.disabled = false;
    }
  });

  /* ---- 通用设置 ---- */
  try {
    const cfg = await window.api.getConfig();
    if (cfg) {
      $('alwaysOnTop').checked = cfg.alwaysOnTop !== false;
      $('autoStart').checked = !!cfg.autoStart;
      const iv = String(cfg.refreshInterval || 5000);
      if ([...$('interval').options].some((o) => o.value === iv)) $('interval').value = iv;
    }
  } catch (_) {}

  const saveCommon = () => window.api.saveConfig({
    refreshInterval: Number($('interval').value) || 5000,
    alwaysOnTop: $('alwaysOnTop').checked,
    autoStart: $('autoStart').checked,
  });
  $('interval').addEventListener('change', saveCommon);
  $('alwaysOnTop').addEventListener('change', saveCommon);
  $('autoStart').addEventListener('change', saveCommon);

  /* ---- 列表数据 ---- */
  await refreshServers();

  $('ver').textContent = 'v1.10.4';
  try {
    const v = await window.api.getVersion();
    if (v) $('ver').textContent = 'v' + v;
  } catch (_) {}
}

let flashTimer = null;
function flash(msg) {
  let n = $('__flash');
  if (!n) {
    n = el('div', 'result');
    n.id = '__flash';
    n.style.position = 'fixed';
    n.style.left = '50%'; n.style.bottom = '16px';
    n.style.transform = 'translateX(-50%)';
    n.style.zIndex = '60'; n.style.margin = '0';
    document.body.appendChild(n);
  }
  n.textContent = msg;
  n.hidden = false;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { n.hidden = true; }, 1800);
}

init();
