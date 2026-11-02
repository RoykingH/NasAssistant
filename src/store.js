'use strict';
/**
 * 配置持久化：userData/config.json
 * ============================================================================
 * v1.6.0 起支持**多服务器**：
 *
 *   {
 *     version: 2,
 *     activeId: 'srv_xxx',            // 当前选中的服务器 id
 *     servers: [                       // 服务器列表
 *       { id, name, type, url, apiKey, tokenId, allowSelfSigned }
 *     ],
 *     // ↓ 全局设置（与具体服务器无关）
 *     refreshInterval, alwaysOnTop, autoStart, opacity, sections,
 *     miniBounds, infoBounds, miniVisible, infoVisible,
 *     topBounds, topVisible, widgetMode
 *   }
 *
 * 兼容：旧版扁平配置（顶层直接是 type/url/apiKey/...）会被自动迁移成
 * 单元素 servers 数组，并保留 activeId 指向它。
 * ========================================================================*/
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const CONFIG_VERSION = 2;

/** 新建服务器条目时的默认字段 */
const SERVER_DEFAULTS = {
  id: '',
  name: '',                // 展示名（用户自定义；空则用 host）
  type: 'unraid',          // unraid | proxmox | dsm | fnos
  url: '',                 // 手动地址（fnOS 配了 fnId 时可留空）
  apiKey: '',              // Unraid: API Key；PVE: API Token 或 secret
  tokenId: '',             // PVE 可选：拆分填写时放 `user@realm!tokenid`
  username: '',            // DSM/fnOS：登录账号（也兼容 PVE 场景留空）
  password: '',            // DSM/fnOS：登录密码
  otpCode: '',             // DSM/fnOS：两步验证码（可选，按需填写/重登时用）
  fnId: '',                // fnOS：FN Connect 的 FN ID（只填它即可自动解析地址）
  fnDomain: '',            // fnOS：fnConnect 域名覆盖（默认 fnos.net，另可选 5ddd.com）
  allowSelfSigned: true,
};

/** 受支持的服务器类型 */
const SERVER_TYPES = ['unraid', 'proxmox', 'dsm', 'fnos'];

const DEFAULTS = {
  version: CONFIG_VERSION,
  activeId: '',
  servers: [],
  /* ↓ 全局设置 */
  refreshInterval: 5000,   // 轮询间隔 ms
  alwaysOnTop: true,       // 挂件置顶
  autoStart: false,        // 开机自启
  opacity: 0.96,           // 挂件不透明度
  sections: { docker: true, vms: true, server: true }, // 面板折叠状态持久化
  miniBounds: null,        // 顶部简约条位置（吸附屏幕顶部，只有 x/y 有意义）
  infoBounds: null,        // 详情挂件窗口位置尺寸
  miniVisible: true,       // 顶部简约条是否显示
  topBounds: null,         // 时钟卡片窗口位置尺寸（top 组件）
  topVisible: true,        // 时钟卡片是否显示
  widgetMode: 'top',       // 组件样式：'top' 时钟卡片 | 'mini' 顶部简约条
  infoVisible: false,      // 详情挂件是否展开
  bounds: null             // 旧版字段（保留兼容，迁移到 infoBounds）
};

let cache = null;
let seq = 0;

function file() {
  return path.join(app.getPath('userData'), 'config.json');
}

/** 生成服务器 id（时间戳 + 递增序号，避免同毫秒冲突） */
function newId() {
  seq = (seq + 1) % 1000;
  return 'srv_' + Date.now().toString(36) + '_' + seq.toString(36);
}

/** 规范化单个服务器条目：补齐字段 + 校验类型 */
function normServer(s) {
  const src = s && typeof s === 'object' ? s : {};
  const type = SERVER_TYPES.indexOf(src.type) >= 0 ? src.type : 'unraid';
  return Object.assign({}, SERVER_DEFAULTS, src, {
    id: String(src.id || '') || newId(),
    type,
    name: typeof src.name === 'string' ? src.name : '',
    url: typeof src.url === 'string' ? src.url : '',
    apiKey: typeof src.apiKey === 'string' ? src.apiKey : '',
    tokenId: typeof src.tokenId === 'string' ? src.tokenId : '',
    username: typeof src.username === 'string' ? src.username : '',
    password: typeof src.password === 'string' ? src.password : '',
    otpCode: typeof src.otpCode === 'string' ? src.otpCode : '',
    fnId: typeof src.fnId === 'string' ? src.fnId : '',
    fnDomain: typeof src.fnDomain === 'string' ? src.fnDomain : '',
    allowSelfSigned: src.allowSelfSigned !== false,
  });
}

/**
 * 把任意形态的原始配置规整成 v2 结构。
 * 旧版（扁平）配置：顶层就有 type/url/apiKey → 视为一台服务器。
 */
function migrate(raw) {
  const parsed = raw && typeof raw === 'object' ? raw : {};
  const base = Object.assign({}, DEFAULTS, {
    sections: Object.assign({}, DEFAULTS.sections, parsed.sections || {}),
  });

  // 已经是 v2：规整 servers 与 activeId
  if (Array.isArray(parsed.servers)) {
    const servers = parsed.servers.filter(Boolean).map(normServer);
    const ids = new Set(servers.map((s) => s.id));
    let activeId = String(parsed.activeId || '');
    if (!ids.has(activeId)) activeId = servers.length ? servers[0].id : '';
    return Object.assign(base, parsed, {
      version: CONFIG_VERSION,
      servers,
      activeId,
      sections: base.sections,
    });
  }

  // 旧版扁平配置：把顶层连接字段收进 servers[0]
  const legacyKeys = ['type', 'url', 'apiKey', 'tokenId', 'username', 'password', 'otpCode', 'allowSelfSigned'];
  const hasLegacy = legacyKeys.some((k) => parsed[k] !== undefined && parsed[k] !== '');
  if (hasLegacy) {
    const srv = normServer({
      type: parsed.type,
      url: parsed.url,
      apiKey: parsed.apiKey,
      tokenId: parsed.tokenId,
      username: parsed.username,
      password: parsed.password,
      otpCode: parsed.otpCode,
      allowSelfSigned: parsed.allowSelfSigned,
      name: parsed.name,
    });
    return Object.assign(base, parsed, {
      version: CONFIG_VERSION,
      servers: [srv],
      activeId: srv.id,
      sections: base.sections,
    });
  }

  // 全新安装
  return base;
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(file(), 'utf8');
    cache = migrate(JSON.parse(raw));
  } catch (_) {
    cache = migrate(null);
  }
  return cache;
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(cache, null, 2), 'utf8');
  } catch (_) { /* 忽略写盘失败 */ }
}

/** 合并式保存全局设置（不含 servers） */
function save(patch) {
  const cur = load();
  const next = Object.assign({}, cur, patch || {});
  if (patch && patch.sections) {
    next.sections = Object.assign({}, cur.sections, patch.sections);
  }
  // 不允许通过 save() 直接覆盖 servers / activeId（走专用方法）
  next.servers = cur.servers;
  next.activeId = cur.activeId;
  next.version = CONFIG_VERSION;
  cache = next;
  persist();
  return cache;
}

/* --------------------------------------------------------- 服务器列表操作 */

/** 服务器列表（副本） */
function list() {
  return load().servers.map((s) => Object.assign({}, s));
}

/** 当前活动的服务器条目（没有则返回 null） */
function active() {
  const c = load();
  if (!c.activeId) return null;
  const s = c.servers.find((x) => x.id === c.activeId);
  return s ? Object.assign({}, s) : null;
}

/** 按 id 取服务器 */
function get(id) {
  const s = load().servers.find((x) => x.id === id);
  return s ? Object.assign({}, s) : null;
}

/**
 * 新增或更新服务器。
 * 传 srv.id 且存在 → 更新；否则新增。
 * 返回保存后的条目（含 id）。
 */
function upsert(srv) {
  const cur = load();
  const incoming = normServer(srv);
  const idx = incoming.id ? cur.servers.findIndex((x) => x.id === incoming.id) : -1;

  if (idx >= 0) {
    // 更新：保留 id
    cur.servers[idx] = Object.assign({}, cur.servers[idx], incoming, { id: cur.servers[idx].id });
    persist();
    return Object.assign({}, cur.servers[idx]);
  }

  // 新增：分配全新 id
  const fresh = Object.assign({}, incoming, { id: newId() });
  cur.servers.push(fresh);
  if (!cur.activeId) cur.activeId = fresh.id;   // 第一台自动成为活动服务器
  persist();
  return Object.assign({}, fresh);
}

/**
 * 删除服务器。
 * 若删的是活动服务器：优先切到列表里的下一台，没有则清空 activeId。
 * 返回 { removed, activeId }
 */
function remove(id) {
  const cur = load();
  const before = cur.servers.length;
  cur.servers = cur.servers.filter((x) => x.id !== id);
  const removed = cur.servers.length < before;
  if (removed && cur.activeId === id) {
    cur.activeId = cur.servers.length ? cur.servers[0].id : '';
  }
  persist();
  return { removed, activeId: cur.activeId };
}

/** 切换活动服务器（id 不存在则不生效） */
function setActive(id) {
  const cur = load();
  if (id && cur.servers.some((x) => x.id === id)) {
    cur.activeId = id;
    persist();
  }
  return cur.activeId;
}

module.exports = {
  CONFIG_VERSION,
  SERVER_DEFAULTS,
  SERVER_TYPES,
  DEFAULTS,
  file,
  load,
  save,
  list,
  active,
  get,
  upsert,
  remove,
  setActive,
  newId,
};
