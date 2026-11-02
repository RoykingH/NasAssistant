'use strict';
/**
 * Synology DSM Provider —— CGI 风格 API 客户端 + 数据归一化。
 *
 * 设计要点：
 *  - 协议：DSM 自家 WebAPI（CGI 风格），所有调用都走
 *        POST/GET  <base>/webapi/<path>.cgi
 *    参数统一为 { api, method, version, _sid, ...data }。
 *  - 鉴权：**账号 + 密码登录**（不是 API Key）。
 *        POST /webapi/entry.cgi  api=SYNO.API.Auth & method=login & version=4
 *          account / passwd / otp_code(可选) / session=webui / rememberme=1
 *      → data:{ sid, device_id, ik_message, synotoken, is_portal_port }
 *    之后每次请求带上 `_sid`（body/query）以及请求头 `sid` / `did`。
 *  - 会话：sid 缓存在内存里（按 base 分桶），失效（错误码 119）时自动重登一次。
 *  - 两步验证：登录返回错误码 403（需 OTP）/ 404（OTP 错误）/ 414（邮箱验证码已发送）。
 *
 * 关键端点（对照 dsm_helper 开源实现核实）：
 *   POST /webapi/query.cgi                 api=SYNO.API.Info  method=query query=all  → API 目录（探测套件）
 *   POST /webapi/entry.cgi  SYNO.API.Auth           method=login  v4 / logout v7
 *   POST /webapi/entry.cgi  SYNO.Core.System        method=info   v1              → 主机/固件/CPU/温度/运行时间
 *   POST /webapi/entry.cgi  SYNO.Core.System        method=info   v1  data={type:'network'}
 *   POST /webapi/entry.cgi  SYNO.Core.System.Utilization method=get v1              → CPU/内存/网络/磁盘实时
 *   POST /webapi/entry.cgi  SYNO.Core.Storage.Volume     method=list v1            → 存储空间
 *   POST /webapi/entry.cgi  SYNO.Docker.Container        method=list/start/stop/restart v1
 *   POST /webapi/entry.cgi  SYNO.Virtualization.Guest    method=list v1
 *   POST /webapi/entry.cgi  SYNO.Virtualization.Guest.Action method=pwr_ctl v1
 *
 * 参考：https://github.com/ApaipaiLtd/dsm_helper
 */
const { URL } = require('url');
const { request } = require('./http');
const {
  toNum, fmtSize, fmtRate, fmtDate, fmtUptime, fmtLink, cleanVersion, clampPct,
} = require('./format');
const { makeSnapshot, PROVIDERS } = require('./provider');

const META = PROVIDERS.dsm;

/* =========================================================================
 * 地址 / 凭据
 * =======================================================================*/

/**
 * 把用户输入整理成 DSM 站点根地址，例如：
 *   '192.168.1.30'                -> 'https://192.168.1.30:5001'
 *   'https://nas.local:5001/'     -> 'https://nas.local:5001'
 *   'http://127.0.0.1:8100'       -> 'http://127.0.0.1:8100'（显式 http 时尊重）
 *   'https://nas.local:5001/webapi/entry.cgi' -> 收敛回根地址
 *
 * 真实 DSM 默认 HTTPS 5001 / HTTP 5000；未写协议时默认 https + 5001。
 */
function normalizeEndpoint(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('服务器地址不能为空');
  const explicitProto = /^https?:\/\//i.test(s);
  if (!explicitProto) s = 'https://' + s;
  const u = new URL(s);
  // 未显式写端口时补 DSM 默认管理端口
  if (!u.port) u.port = u.protocol === 'https:' ? '5001' : '5000';
  // 无论用户填了根路径还是 /webapi/xxx.cgi，统一收敛到站点根
  u.pathname = '';
  u.search = '';
  u.hash = '';
  return u.toString().replace(/\/$/, '');
}

/** 展示用 host（含端口） */
function displayHost(endpoint) {
  try {
    const u = new URL(normalizeEndpoint(endpoint));
    return u.host;
  } catch (_) {
    return String(endpoint || '');
  }
}

/** 取登录凭据（账号密码模式） */
function creds(cfg) {
  const account = String((cfg && cfg.username) || '').trim();
  const passwd = String((cfg && cfg.password) || '');
  if (!account) throw new Error('尚未配置 DSM 账号');
  if (!passwd) throw new Error('尚未配置 DSM 密码');
  return { account, passwd };
}

/* =========================================================================
 * 会话缓存（sid 按 base 分桶，内存级）
 * =======================================================================*/
const sessions = new Map();   // base -> { sid, deviceId, account, ts }

function sessKey(base, cfg) {
  return base + '|' + String((cfg && cfg.username) || '');
}

function getSession(base, cfg) {
  const s = sessions.get(sessKey(base, cfg));
  if (!s || !s.sid) return null;
  // sid 默认 7 天有效，这里保守 12 小时
  if (Date.now() - s.ts > 12 * 3600 * 1000) return null;
  return s;
}

function setSession(base, cfg, s) {
  sessions.set(sessKey(base, cfg), Object.assign({ ts: Date.now() }, s));
}

/** 清空会话（配置变更 / 切换服务器时调用） */
function clearCache(base, cfg) {
  if (base) {
    if (cfg) sessions.delete(sessKey(base, cfg));
    else for (const k of [...sessions.keys()]) if (k.indexOf(base + '|') === 0) sessions.delete(k);
  } else {
    sessions.clear();
  }
}

/* =========================================================================
 * 错误码翻译
 * =======================================================================*/
/**
 * DSM 常见错误码（部分来自 dsm_helper 与 DSM 官方文档）：
 *   100 未知错误   101 参数错误     102 API 不存在
 *   103 方法不存在 104 版本不支持   105 权限不足（该账号不允许使用此 API）
 *   106 会话超时   107 会话被中断   119 会话失效/需重新登录
 *   117 操作失败（目标不存在 / 状态不允许，如对已停止的容器执行停止）
 *   400 用户名或密码错误
 *   401 账号已被锁定 / 未启用二次验证
 *   403 需要二次验证码
 *   404 验证码错误
 *   407 账号已被停用或锁定
 *   414 邮箱验证码已发送
 */
const ERR = {
  100: 'DSM 返回未知错误',
  101: '参数错误',
  102: '该 API 不存在（可能未安装对应套件）',
  103: '该 API 方法不存在',
  104: '该 API 版本不受支持',
  105: '权限不足：该账号无权使用此功能',
  106: '会话超时',
  107: '会话被中断',
  117: '操作失败：目标不存在或当前状态不允许该操作',
  119: '会话已失效，请重新登录',
  400: '用户名或密码有误',
  401: '账号被锁定或未启用两步验证',
  403: '该账号已开启双重验证，请输入验证码',
  404: '验证码错误，请重新输入',
  407: '账号已被停用或锁定',
  414: '验证码已发送至绑定邮箱，请在 5 分钟内输入',
};

function errText(code, extra) {
  const c = toNum(code);
  const base = ERR[c] || ('DSM 错误码 ' + code);
  if (extra) return base + '：' + extra;
  return base;
}

/** 会话失效类错误 */
function isSessionError(code) {
  const c = toNum(code);
  return c === 119 || c === 106 || c === 107;
}

/* =========================================================================
 * CGI 传输层
 * =======================================================================*/

function reqOpts(cfg, timeout) {
  return {
    allowSelfSigned: cfg.allowSelfSigned !== false,
    timeout: timeout || cfg.timeout || 12000,
  };
}

/** 表单编码 */
function form(obj) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) {
    if (v == null) continue;
    qs.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  return qs.toString();
}

/**
 * 调用一次 DSM CGI 接口。
 * @param {string} base 站点根地址
 * @param {object} cfg  服务器配置
 * @param {object} o    { path?, api, method, version?, data?, query?, post?, sid?, timeout?, raw? }
 *        raw=true 时返回整个 { success, data, error }（用于容忍失败场景）
 * @returns {Promise<any>} 解包后的 data
 */
async function cgi(base, cfg, o) {
  const path = o.path || '/webapi/entry.cgi';
  const sid = o.sid != null ? o.sid : (function () {
    const s = getSession(base, cfg);
    return s ? s.sid : null;
  })();

  const payload = Object.assign({}, o.data || {});
  payload.version = o.version != null ? o.version : 1;
  payload.api = o.api;
  payload.method = o.method;
  if (sid) payload._sid = sid;

  let url = base + path;
  const headers = { 'Accept': 'application/json' };
  if (sid) headers['sid'] = sid;
  const s = getSession(base, cfg);
  if (s && s.deviceId) headers['did'] = s.deviceId;

  let method = o.post === false ? 'GET' : 'POST';
  let body = null;
  if (method === 'POST') {
    // 多数 DSM 接口要求表单体；query 参数拼到 URL 上
    body = form(payload);
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (o.query) {
      const q = form(o.query);
      if (q) url += (url.includes('?') ? '&' : '?') + q;
    }
  } else {
    const q = form(Object.assign({}, payload, o.query || {}));
    if (q) url += (url.includes('?') ? '&' : '?') + q;
  }

  const res = await request(url, {
    method,
    headers,
    body,
    ...reqOpts(cfg, o.timeout),
  });

  if (!res.json) {
    throw new Error('响应不是合法 JSON (HTTP ' + res.status + ')：' + String(res.text).slice(0, 160));
  }
  if (o.raw) return res.json;

  const j = res.json;
  if (j.success) return j.data;
  const code = j.error ? j.error.code : null;
  const err = new Error(errText(code));
  err.dsmCode = toNum(code);
  err.dsmError = j.error || null;
  throw err;
}

/**
 * 登录换取 sid。
 * @param {object} cfg 需含 username / password，可选 otpCode
 * @returns {Promise<{sid, deviceId, synotoken, account}>}
 */
async function login(base, cfg, otpCode) {
  const { account, passwd } = creds(cfg);
  const otp = otpCode != null ? String(otpCode) : String((cfg && cfg.otpCode) || '');
  const data = {
    account,
    passwd,
    otp_code: otp,
    session: 'webui',
    enable_device_token: 'yes',
    enable_sync_token: 'yes',
    rememberme: 1,
    format: 'sid',
  };
  const d = await cgi(base, cfg, {
    api: 'SYNO.API.Auth',
    method: 'login',
    version: 4,
    data,
    sid: '',            // 登录时无 sid
    timeout: cfg.timeout || 15000,
  });
  if (!d || !d.sid) throw new Error('登录成功但未返回会话 sid');
  const sess = { sid: d.sid, deviceId: d.device_id || null, account };
  setSession(base, cfg, sess);
  return sess;
}

/** 请求时自动带会话；遇到会话失效自动重登一次。 */
async function authed(base, cfg, o, retried) {
  let sess = getSession(base, cfg);
  if (!sess) sess = await login(base, cfg);
  try {
    return await cgi(base, cfg, Object.assign({}, o, { sid: sess.sid }));
  } catch (e) {
    if (!retried && isSessionError(e.dsmCode)) {
      clearCache(base, cfg);
      await login(base, cfg);
      return authed(base, cfg, o, true);
    }
    throw e;
  }
}

/** 允许失败的调用：返回 { ok, data|error, code? } */
async function tryAuthed(base, cfg, o) {
  try {
    return { ok: true, data: await authed(base, cfg, o) };
  } catch (e) {
    return { ok: false, error: e.message, code: e.dsmCode };
  }
}

/* =========================================================================
 * API 目录（套件探测）
 * =======================================================================*/
/**
 * query.cgi 返回所有 API 的 { maxVersion, minVersion, path }。
 * 我们据此判断某个套件是否安装：Docker 需 SYNO.Docker.Container，
 * 虚拟机需 SYNO.Virtualization.Guest。
 */
function apiCatalog(base, cfg) {
  return cgi(base, cfg, {
    path: '/webapi/query.cgi',
    api: 'SYNO.API.Info',
    method: 'query',
    version: 1,
    data: { query: 'all' },
    sid: '',
    timeout: cfg.timeout || 12000,
  });
}

/** 从目录里取某 API 推荐版本号 */
function apiVersion(catalog, api, fallback) {
  const m = catalog && catalog[api];
  const v = m && (toNum(m.maxVersion) || toNum(m.minVersion));
  return v || fallback || 1;
}

/* =========================================================================
 * 归一化辅助
 * =======================================================================*/

/** DSM up_time 形如 "240:6:24"（时:分:秒）或 "8days, 3:20:11" */
function dsmUptime(v) {
  const s = String(v || '').trim();
  if (!s) return '—';
  // 天数形态： "12days, 3:20:11" / "1day, 0:00:05"
  const dm = s.match(/^(\d+)\s*days?\s*,\s*(\d+):(\d+):(\d+)/i);
  if (dm) {
    const ms = ((+dm[1] * 86400) + (+dm[2] * 3600) + (+dm[3] * 60) + (+dm[4])) * 1000;
    return fmtUptime(ms);
  }
  // "240:6:24"
  const hm = s.match(/^(\d+):(\d+):(\d+)$/);
  if (hm) {
    const ms = ((+hm[1] * 3600) + (+hm[2] * 60) + (+hm[3])) * 1000;
    return fmtUptime(ms);
  }
  return s;
}

/** CPU 型号文案：INTEL / Celeron / J3455 → "Intel Celeron J3455" */
function cpuBrand(sys) {
  const vendor = sys.cpu_vendor ? String(sys.cpu_vendor) : '';
  const fam = sys.cpu_family ? String(sys.cpu_family) : '';
  const ser = sys.cpu_series ? String(sys.cpu_series) : '';
  const part = [fam, ser].filter(Boolean).join(' ');
  const v = vendor ? vendor.charAt(0).toUpperCase() + vendor.slice(1).toLowerCase() : '';
  const s = [v, part].filter(Boolean).join(' ').trim();
  return s || null;
}

/** 存储空间状态映射 */
const VOL_STATE = {
  normal: ['正常', 'run'],
  attention: ['需注意', 'warn'],
  crashed: ['已损毁', 'err'],
  degraded: ['已降级', 'warn'],
  readonly: ['只读', 'warn'],
};

function volState(vol) {
  if (vol && (vol.crashed === true)) return VOL_STATE.crashed;
  const k = String((vol && vol.status) || '').toLowerCase();
  if (VOL_STATE[k]) return VOL_STATE[k];
  if (vol && vol.readonly === true) return VOL_STATE.readonly;
  return ['未知', 'stop'];
}

/* =========================================================================
 * 快照抓取
 * =======================================================================*/
/**
 * @param {object} cfg { url, username, password, otpCode?, allowSelfSigned?, timeout? }
 */
async function fetchSnapshot(cfg) {
  const base = normalizeEndpoint(cfg.url);
  creds(cfg);

  const snap = makeSnapshot('dsm', displayHost(base));
  snap.server.versionPrefix = 'DSM';
  snap.docker.label = META.containerLabel;   // Docker 容器
  snap.vms.label = META.guestLabel;          // 虚拟机

  // ---- 确保已登录（消费型调用，失败直接抛出）----
  await authed(base, cfg, { api: 'SYNO.Core.System', method: 'info', version: 1 });

  // ---- 系统信息（主机名 / 固件 / CPU / 温度 / 运行时间 / 内存条容量）----
  const sysR = await tryAuthed(base, cfg, { api: 'SYNO.Core.System', method: 'info', version: 1 });
  if (sysR.ok && sysR.data) {
    const d = sysR.data;
    snap.server.version = cleanVersion(d.firmware_ver) || null;
    snap.server.distro = d.firmware_ver ? String(d.firmware_ver) : 'Synology DSM';
    if (d.sys_temp != null) snap.temp = toNum(d.sys_temp);
    if (d.model) snap.board = String(d.model);
    if (d.up_time) snap.server.uptimeText = dsmUptime(d.up_time);
    if (d.time_zone_desc) snap.server.kernel = null;  // DSM 不暴露内核版本

    const cores = toNum(d.cpu_cores) || toNum(d.cpu_core);
    snap.cpu.cores = cores;
    snap.cpu.brand = cpuBrand(d);
    const clock = toNum(d.cpu_clock_speed);
    snap.cpu.speedGhz = clock != null ? +(clock / 1000).toFixed(2) : null;
    snap.cpu.threads = cores;   // DSM 的 cpu_cores 为可见逻辑核数
    snap.cpu.label = [snap.cpu.brand, cores ? cores + ' 核' : null].filter(Boolean).join(' · ') || null;

    // RAM 总容量（MB）
    const ramMb = toNum(d.ram_size);
    if (ramMb != null && ramMb > 0) {
      snap.ram.totalBytes = ramMb * 1024 * 1024;
      snap.ram.totalText = fmtSize(snap.ram.totalBytes);
    }
  } else if (!sysR.ok) {
    throw new Error(sysR.error);
  }

  // ---- 实时资源（CPU / 内存实际占用 / 网络吞吐）----
  const utilR = await tryAuthed(base, cfg, {
    api: 'SYNO.Core.System.Utilization',
    method: 'get',
    version: 1,
    data: { type: 'current', resource: ['cpu', 'memory', 'network'] },
  });
  if (utilR.ok && utilR.data) {
    const u = utilR.data;

    // CPU：totalLoad = user_load + system_load（百分比）
    if (u.cpu) {
      const user = toNum(u.cpu.user_load) || 0;
      const sysl = toNum(u.cpu.system_load) || 0;
      const other = toNum(u.cpu.other_load) || 0;
      snap.cpu.pct = clampPct(user + sysl + (other > 0 && other < 100 ? other : 0));
      if (!snap.cpu.label && u.cpu.device) snap.cpu.label = String(u.cpu.device);
    }

    // 内存：memory_size / total_real / avail_real 单位均为 **KB**；real_usage 为占用百分比
    // （实测样本：memory_size 8388608 KB ↔ 机型 ram_size 8192 MB，两者一致）
    if (u.memory) {
      const m = u.memory;
      const sizeKb = toNum(m.memory_size);
      if (sizeKb != null && sizeKb > 0) {
        snap.ram.totalBytes = sizeKb * 1024;
        snap.ram.totalText = fmtSize(snap.ram.totalBytes);
      }
      const usage = toNum(m.real_usage);
      if (usage != null) snap.ram.pct = clampPct(usage);
      const totalReal = toNum(m.total_real);
      const availReal = toNum(m.avail_real);
      if (snap.ram.pct != null && snap.ram.totalBytes != null) {
        snap.ram.usedBytes = Math.round(snap.ram.totalBytes * snap.ram.pct / 100);
        snap.ram.usedText = fmtSize(snap.ram.usedBytes);
      } else if (totalReal != null && availReal != null) {
        const usedBytes = Math.max(0, totalReal - availReal) * 1024;
        snap.ram.usedBytes = usedBytes;
        snap.ram.usedText = fmtSize(usedBytes);
        snap.ram.pct = totalReal > 0 ? clampPct(usedBytes / (totalReal * 1024) * 100) : null;
      }
    }

    // 网络吞吐：device === 'total' 优先；单位字节/秒
    if (Array.isArray(u.network) && u.network.length) {
      const total = u.network.find((n) => String(n.device) === 'total') || u.network[0];
      const rx = toNum(total.rx);
      const tx = toNum(total.tx);
      snap.net.rx = rx;
      snap.net.tx = tx;
      snap.net.rxText = fmtRate(rx);
      snap.net.txText = fmtRate(tx);
    }
  } else if (!utilR.ok) {
    snap.warnings.push('实时资源: ' + utilR.error);
  }

  // ---- 网络（主机名 / 主网卡 / IP / 链路速率）----
  const netR = await tryAuthed(base, cfg, {
    api: 'SYNO.Core.System',
    method: 'info',
    version: 1,
    data: { type: 'network' },
  });
  if (netR.ok && netR.data) {
    const n = netR.data;
    if (n.hostname) snap.server.name = String(n.hostname);
    const nic = pickNif(n.nif);
    if (nic) {
      snap.net.iface = nic.id || null;
      snap.ip = nic.addr || null;
      const sp = toNum(nic.speed);
      if (sp != null && sp > 0) {
        snap.net.linkMbps = sp;
        snap.net.speedText = fmtLink(sp);
      }
    }
  } else if (!netR.ok) {
    snap.warnings.push('网络: ' + netR.error);
  }
  if (!snap.server.name) {
    try { snap.server.name = new URL(base).hostname; } catch (_) { /* 忽略 */ }
  }

  // ---- 存储空间（汇总所有 active 卷）----
  const volR = await tryAuthed(base, cfg, {
    api: 'SYNO.Core.Storage.Volume',
    method: 'list',
    version: 1,
    data: { limit: -1, offset: 0, location: 'internal' },
  });
  if (volR.ok && volR.data) {
    const vols = Array.isArray(volR.data.volumes) ? volR.data.volumes : [];
    let totalBytes = 0;
    let freeBytes = 0;
    let worst = ['run', 0];
    for (const v of vols) {
      if (v.location && String(v.location) !== 'internal') continue;
      const t = toNum(v.size_total_byte);
      const f = toNum(v.size_free_byte);
      if (t != null && t > 0) { totalBytes += t; if (f != null) freeBytes += f; }
      const st = volState(v);
      // 记录最严重的告警级别（err > warn > run > stop）
      const rank = { err: 3, warn: 2, run: 1, stop: 0 };
      if ((rank[st[1]] || 0) > worst[1]) worst = [st[1], rank[st[1]] || 0];
    }
    if (totalBytes > 0) {
      const usedBytes = Math.max(0, totalBytes - freeBytes);
      snap.disk.pct = clampPct(usedBytes / totalBytes * 100);
      snap.disk.usedText = fmtSize(usedBytes);
      snap.disk.totalText = fmtSize(totalBytes);
      snap.disk.freeText = fmtSize(freeBytes);
      snap.disk.state = totalBytes > 0 ? 'ACTIVE' : null;
      snap.disk.warn = worst[1] >= 2 ? worst[0] : null;
    }
  } else if (!volR.ok) {
    snap.warnings.push('存储空间: ' + volR.error);
  }

  // ---- 套件探测：Docker / 虚拟机是否安装 ----
  let catalog = null;
  const catR = await (async () => {
    try { return { ok: true, data: await apiCatalog(base, cfg) }; }
    catch (e) { return { ok: false, error: e.message }; }
  })();
  if (catR.ok) catalog = catR.data;
  const hasDocker = !!(catalog && catalog['SYNO.Docker.Container']);
  const hasVmm = !!(catalog && catalog['SYNO.Virtualization.Guest']);

  // ---- Docker 容器 ----
  if (hasDocker) {
    const dk = await tryAuthed(base, cfg, {
      api: 'SYNO.Docker.Container',
      method: 'list',
      version: apiVersion(catalog, 'SYNO.Docker.Container', 1),
      data: { limit: -1, offset: 0, type: 'all' },
    });
    if (dk.ok && dk.data) {
      const items = (Array.isArray(dk.data.containers) ? dk.data.containers : []).map(normContainer);
      snap.docker.ok = true;
      snap.docker.items = sortItems(items);
    } else {
      snap.docker.ok = false;
      snap.docker.error = dk.error;
    }
  } else {
    snap.docker.ok = false;
    snap.docker.error = '未安装套件';
    snap.docker.notInstalled = true;
    snap.docker.hint = '未检测到 Docker 套件（Container Manager）。请在 DSM「套件中心」安装后刷新。';
  }

  // ---- 虚拟机（Virtual Machine Manager）----
  if (hasVmm) {
    const vm = await tryAuthed(base, cfg, {
      api: 'SYNO.Virtualization.Guest',
      method: 'list',
      version: apiVersion(catalog, 'SYNO.Virtualization.Guest', 1),
      data: { limit: -1, offset: 0, additional: [] },
    });
    if (vm.ok && vm.data) {
      const items = (Array.isArray(vm.data.guests) ? vm.data.guests : []).map(normGuest);
      snap.vms.ok = true;
      snap.vms.items = sortItems(items);
    } else {
      snap.vms.ok = false;
      snap.vms.error = vm.error;
    }
  } else {
    snap.vms.ok = false;
    snap.vms.error = '未安装套件';
    snap.vms.notInstalled = true;
    snap.vms.hint = '未检测到 Virtual Machine Manager 套件。请在 DSM「套件中心」安装后刷新。';
  }

  snap.ok = true;
  return snap;
}

/** 挑主网卡：偏好 connected + 有 IPv4 + 有速率，排除 lo / docker 等虚拟网卡 */
function pickNif(list) {
  const items = (list || []).filter((x) => x && x.addr && String(x.id || '') !== 'lo');
  if (!items.length) return null;
  const score = (n) => {
    let s = 0;
    if (String(n.status) === 'connected') s += 8;
    if (/\d+\.\d+\.\d+\.\d+/.test(String(n.addr))) s += 6;
    if (toNum(n.speed) > 0) s += 4;
    if (/^(eth|ovs_eth|bond)/i.test(String(n.id || ''))) s += 3;
    if (/^(docker|veth|virbr)/i.test(String(n.id || ''))) s -= 8;
    return s;
  };
  const best = [...items].sort((a, b) => score(b) - score(a))[0];
  return best;
}

/** Docker 容器条目归一化 */
function normContainer(c) {
  const rawStatus = String(c.status || '').toLowerCase();
  const st = c.State || {};
  const running = rawStatus === 'running' || st.Running === true;
  const paused = st.Paused === true || rawStatus === 'paused';
  const name = c.name || (c.id ? String(c.id).slice(0, 12) : '(未命名)');
  const stateText = paused ? '已暂停' : (running ? '运行中' : '已停止');
  const cls = paused ? 'warn' : (running ? 'run' : 'stop');
  return {
    id: c.name || c.id,             // DSM 的启停接口以 name 定位
    name,
    image: c.image || null,
    initial: String(name).charAt(0).toUpperCase(),
    icon: null,                     // DSM 不返回图标
    state: rawStatus.toUpperCase(),
    stateLabel: stateText,
    cls,
    running,
    paused,
    // 面板明细
    status: rawStatus,
    upText: c.up_status ? String(c.up_status) : null,
    cmd: c.cmd ? String(c.cmd) : null,
    created: toNum(c.created),
    createdText: fmtDate(toNum(c.created)),
    uptimeText: toNum(c.up_time) ? fmtUptime(Date.now() - toNum(c.up_time) * 1000) : null,
    exitCode: toNum(st.ExitCode),
    memText: null,
    diskText: null,
    cpuText: null,
  };
}

/** 虚拟机条目归一化（Virtual Machine Manager） */
function normGuest(g) {
  const st = String(g.status || '').toLowerCase();
  const stateMap = {
    running: ['运行中', 'run'],
    shutdown: ['已关机', 'stop'],
    stopped: ['已停止', 'stop'],
    paused: ['已暂停', 'warn'],
    suspend: ['已挂起', 'warn'],
    preparing: ['准备中', 'warn'],
    booting: ['启动中', 'warn'],
    shutting_down: ['关机中', 'warn'],
  };
  const hit = stateMap[st] || ['未知', 'stop'];
  const name = g.name || g.guest_id || '(未命名)';
  const vcpu = toNum(g.vcpu_num);
  const vcpuUsage = toNum(g.vcpu_usage);   // DSM 里是占「已分配 vCPU」的百分比
  const ramUsed = toNum(g.ram_used);       // KB
  const hostRam = toNum(g.host_ram_size);  // …此处为 guest 分配的 MB
  const ramTotalBytes = hostRam != null ? hostRam * 1024 * 1024 : null;
  const ramUsedBytes = ramUsed != null ? ramUsed * 1024 : null;
  return {
    id: g.guest_id,
    vmid: String(g.guest_id || '').slice(0, 8),
    node: g.host_name || null,
    type: 'vm',
    name,
    initial: String(name).charAt(0).toUpperCase(),
    icon: null,
    state: st.toUpperCase(),
    stateLabel: hit[0],
    cls: hit[1],
    running: hit[1] === 'run',
    template: false,
    // 面板明细
    status: st,
    cores: vcpu,
    memBytes: ramUsedBytes,
    memTotalBytes: ramTotalBytes,
    memText: (ramTotalBytes && ramUsedBytes != null)
      ? fmtSize(ramUsedBytes) + ' / ' + fmtSize(ramTotalBytes) : null,
    diskText: null,
    uptimeText: null,
    cpuText: vcpuUsage != null ? Math.round(clampPct(vcpuUsage)) + '%' : null,
    ip: g.ip || null,
    tags: null,
    created: null,
    createdText: null,
  };
}

/** 排序：运行中优先，其次名称 */
function sortItems(list) {
  return [...list].sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

/* =========================================================================
 * 控制操作
 * =======================================================================*/
const CONTAINER_ACTIONS = {
  start: 'start',
  stop: 'stop',
  forceStop: 'stop',
  restart: 'restart',
  pause: null,        // DSM 的 Container 接口无 pause
  resume: null,
  unpause: null,
};

const GUEST_ACTIONS = {
  start: 'start',
  stop: 'shutdown',       // UI「停止」= 优雅关机
  forceStop: 'poweroff',  // UI「强制停止」= 断电
  restart: 'reboot',
  pause: 'suspend',
  resume: 'resume',
  unpause: 'resume',
};

/** Docker 容器操作：id 即容器名 */
async function containerAction(cfg, id, action) {
  const base = normalizeEndpoint(cfg.url);
  creds(cfg);
  const fn = CONTAINER_ACTIONS[action];
  if (action === 'unpause') {
    throw new Error('DSM 的 Container Manager 不支持暂停/恢复操作');
  }
  if (!fn) throw new Error('不支持的容器操作: ' + action);
  await authed(base, cfg, {
    api: 'SYNO.Docker.Container',
    method: fn,
    version: 1,
    data: { name: String(id) },
    timeout: cfg.actionTimeout || 30000,
  });
  return true;
}

/** 虚拟机操作：id 即 guest_id */
async function guestAction(cfg, id, action) {
  const base = normalizeEndpoint(cfg.url);
  creds(cfg);
  const fn = GUEST_ACTIONS[action];
  if (!fn) throw new Error('不支持的虚拟机操作: ' + action);
  await authed(base, cfg, {
    api: 'SYNO.Virtualization.Guest.Action',
    method: 'pwr_ctl',
    version: 1,
    data: { guest_id: String(id), action: fn },
    timeout: cfg.actionTimeout || 30000,
  });
  return true;
}

/* =========================================================================
 * 连接测试
 * =======================================================================*/
async function testConnection(cfg) {
  const conf = cfg || {};
  // 记录内存凭证供 authed 使用
  try {
    creds(conf);
  } catch (e) {
    return { ok: false, provider: 'dsm', error: e.message };
  }
  let base = '';
  try {
    base = normalizeEndpoint(conf.url);
    clearCache(base, conf);
    await login(base, conf);
    const sys = await authed(base, conf, { api: 'SYNO.Core.System', method: 'info', version: 1 });
    // 主机名需额外带 type=network 才有（SYNO.Core.System info 默认不返回 hostname）
    let hostname = null;
    try {
      const net = await authed(base, conf, {
        api: 'SYNO.Core.System', method: 'info', version: 1, data: { type: 'network' },
      });
      hostname = net && net.hostname ? String(net.hostname) : null;
    } catch (_) { /* 忽略：部分账号无网络信息权限 */ }
    return {
      ok: true,
      provider: 'dsm',
      endpoint: base,
      hostname: hostname || displayHost(base),
      version: cleanVersion(sys && sys.firmware_ver),
      model: sys && sys.model ? String(sys.model) : null,
    };
  } catch (e) {
    // 会话建立失败：清掉半成品
    if (base) clearCache(base, conf);
    return { ok: false, provider: 'dsm', error: e.message, code: e.dsmCode };
  }
}

/* =========================================================================
 * 导出
 * =======================================================================*/
module.exports = {
  /* --- provider 元数据 --- */
  kind: 'dsm',
  label: META.label,

  /* --- provider 接口 --- */
  normalizeUrl: normalizeEndpoint,
  normalizeEndpoint,
  displayHost,
  fetchSnapshot,
  containerAction,
  guestAction,
  testConnection,
  clearCache(base, cfg) { clearCache(base, cfg); },

  /* --- 向后兼容别名（与 unraid / proxmox provider 对齐） --- */
  dockerAction: containerAction,
  vmAction: guestAction,
  clearProbeCache(base, cfg) { clearCache(base, cfg); },

  /* --- 内部工具（自检使用） --- */
  login,
  apiCatalog,
  dsmUptime,
  pickNif,
  normContainer,
  normGuest,
  errText,
  ERR,
};
