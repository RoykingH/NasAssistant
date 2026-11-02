'use strict';
/**
 * Proxmox VE Provider —— REST API 客户端 + 数据归一化。
 *
 * 设计要点：
 *  - REST 端点: https://<host>:8006/api2/json/...
 *  - 鉴权：API Token（推荐）
 *        Authorization: PVEAPIToken=USER@REALM!TOKENID=SECRET
 *    也支持用户名密码换取 ticket（此处不做，Token 更安全且可免 2FA）。
 *  - 所有响应统一包在 { data: ... } 中；POST 成功返回 { data: "UPID:..." }（异步任务）。
 *  - 集群可能有多个节点：默认取第一个在线节点作为「主节点」展示，
 *    LXC / QEMU 列表则聚合所有在线节点。
 *
 * 关键端点（已核对 PVE 官方 API）：
 *   GET  /version                          版本 / 仓库
 *   GET  /nodes                            节点列表
 *   GET  /nodes/{n}/status                 详细状态（cpu / memory / rootfs / kernel / uptime）
 *   GET  /nodes/{n}/lxc                    LXC 容器列表
 *   GET  /nodes/{n}/qemu                   QEMU/KVM 虚拟机列表
 *   GET  /nodes/{n}/storage                存储列表（容量）
 *   GET  /nodes/{n}/rrddata?timeframe=hour&cf=AVERAGE   实时指标（含 netin/netout，字节/秒）
 *   POST /nodes/{n}/{lxc|qemu}/{vmid}/status/{start|stop|shutdown|reboot|pause|resume}
 *
 * 参考: https://pve.proxmox.com/pve-docs/api-viewer/
 */
const { URL } = require('url');
const { request } = require('./http');
const {
  toNum, fmtSize, fmtRate, fmtDate, fmtUptime, fmtLink, cleanVersion, clampPct,
} = require('./format');
const { makeSnapshot, PROVIDERS } = require('./provider');

const META = PROVIDERS.proxmox;

/* =========================================================================
 * 地址 / 凭据
 * =======================================================================*/

/**
 * 把用户输入整理成 API 根地址，例如：
 *   '192.168.1.20'                 -> 'https://192.168.1.20:8006/api2/json'
 *   'https://pve.local:8006/'      -> 'https://pve.local:8006/api2/json'
 *   'https://pve.local:8006/api2/json' -> 原样
 *   'http://127.0.0.1:8100'        -> 'http://127.0.0.1:8100/api2/json'（显式 http 时尊重）
 *
 * 真实 PVE 只提供 HTTPS，因此未写协议时默认按 https 处理；
 * 但显式写了 http:// 时予以保留（反向代理 / 本地 mock / 调试场景）。
 */
function normalizeEndpoint(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('服务器地址不能为空');
  const explicitProto = /^https?:\/\//i.test(s);
  if (!explicitProto) s = 'https://' + s;
  const u = new URL(s);
  // 未显式写端口时补 PVE 默认管理端口（仅 https 场景）
  if (!u.port && u.protocol === 'https:') u.port = '8006';
  // 无论用户填了根路径、/api2/json 还是其子路径，统一收敛到 /api2/json
  u.pathname = '/api2/json';
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

/**
 * 组装 PVEAPIToken 鉴权头。
 * 用户可能填：
 *   ① 完整 token 串 `user@realm!tokenid=secret`
 *   ② 只填 secret，另在 tokenId 字段填 `user@realm!tokenid`
 * 两者都支持：优先用 apiKey 里的等号形式，否则用 tokenId + apiKey 拼接。
 */
function authHeader(cfg) {
  const raw = String(cfg.apiKey || '').trim();
  if (!raw) throw new Error('尚未配置 API Token');
  let token = raw;
  const colon = cfg.tokenId != null ? String(cfg.tokenId).trim() : '';
  // 形如 `user@realm!tokenid=secret`：直接可用
  if (/^[^=\s]+@[^=\s]+![^=\s]+=.+$/i.test(raw)) {
    token = raw;
  } else if (colon) {
    // tokenId 填 `user@realm!tokenid`，apiKey 填 secret
    token = colon + '=' + raw;
  } else if (/^[^=\s]+@[^=\s]+![^=\s]+$/.test(raw)) {
    throw new Error('API Token 缺少 secret，请填成 `user@realm!tokenid=secret` 形式');
  }
  return 'PVEAPIToken=' + token;
}

/* =========================================================================
 * REST 传输层
 * =======================================================================*/
function reqOpts(cfg, timeout) {
  return {
    allowSelfSigned: cfg.allowSelfSigned !== false,
    timeout: timeout || cfg.timeout || 12000,
  };
}

/**
 * 发一次请求并解包 { data }。
 * GET 时 query 对象会拼到 query string。
 */
async function api(base, cfg, path, opts) {
  const o = opts || {};
  let url = base + path;
  if (o.query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(o.query)) {
      if (v != null) qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }
  const headers = { Authorization: authHeader(cfg) };
  if (o.body) headers['Content-Type'] = 'application/x-www-form-urlencoded';

  const res = await request(url, {
    method: o.method || 'GET',
    headers,
    body: o.body || null,
    ...reqOpts(cfg, o.timeout),
  });

  if (res.status === 401) {
    throw new Error('鉴权失败 (HTTP 401)：请检查 API Token 是否正确、是否已授权（需 PVEAudit 或对应 VM 权限）');
  }
  if (res.status === 403) {
    throw new Error('权限不足 (HTTP 403)：该 Token 缺少所需权限（读取需 PVEAudit，启停需 VM.PowerMgmt）');
  }
  if (!res.json) {
    throw new Error('响应不是合法 JSON (HTTP ' + res.status + ')：' + String(res.text).slice(0, 160));
  }
  // PVE 错误体形如 { data: null, errors: {...} } 或直接 4xx + message
  if (res.json.errors && Object.keys(res.json.errors).length) {
    const msg = Object.values(res.json.errors).join('; ');
    throw new Error(msg || ('PVE 请求失败 (HTTP ' + res.status + ')'));
  }
  if (res.status >= 400) {
    throw new Error('PVE 请求失败 (HTTP ' + res.status + ')' + (res.text ? '：' + String(res.text).slice(0, 160) : ''));
  }
  return res.json.data;
}

/** 允许失败的请求：返回 { ok, data|error } */
async function tryApi(base, cfg, path, opts) {
  try {
    return { ok: true, data: await api(base, cfg, path, opts) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* =========================================================================
 * 归一化辅助
 * =======================================================================*/

/** PVE 的 state 值：running / stopped / paused / suspended 等 */
const PVE_STATE = {
  RUNNING: ['运行中', 'run'],
  STOPPED: ['已停止', 'stop'],
  PAUSED: ['已暂停', 'run'],
  SUSPENDED: ['已挂起', 'run'],
  PRELAUNCH: ['启动中', 'warn'],
  UNKNOWN: ['未知', 'stop'],
};

function stateInfo(state) {
  const key = String(state || '').toUpperCase();
  const hit = PVE_STATE[key];
  if (hit) return { label: hit[0], cls: hit[1], running: hit[1] === 'run' };
  return { label: key || '未知', cls: 'stop', running: false };
}

/** 从 pveversion 字符串取纯版本号："pve-manager/8.4.1/xxx" -> "8.4.1" */
function pveVersion(s) {
  const str = String(s || '');
  const m = str.match(/(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : cleanVersion(str);
}

/**
 * CPU 型号简化：PVE 的 model 形如
 *   "Intel(R) Xeon(R) Silver 4210 CPU @ 2.20GHz"
 *   "AMD Ryzen 9 5950X 16-Core Processor"
 * 保留原样（与 Unraid 一致，由 UI 侧 shortBrand 去厂商前缀）。
 */
function cpuBrand(cpuinfo) {
  if (!cpuinfo) return null;
  return cpuinfo.model || null;
}

/* =========================================================================
 * 快照抓取
 * =======================================================================*/

/**
 * 选择「主节点」：优先在线节点，其次名字排序第一。
 * 集群里我们只展示一个主节点指标，但列表聚合全部在线节点。
 */
function pickMainNode(nodes) {
  const list = (nodes || []).filter(Boolean);
  if (!list.length) return null;
  const online = list.filter((n) => String(n.status || '') === 'online');
  const pool = online.length ? online : list;
  pool.sort((a, b) => String(a.node || '').localeCompare(String(b.node || '')));
  return pool[0];
}

/**
 * @param {object} cfg { url, apiKey, tokenId?, allowSelfSigned?, timeout? }
 * @param {string} [nodeName] 指定节点；缺省用主节点
 */
async function fetchSnapshot(cfg, nodeName) {
  const base = normalizeEndpoint(cfg.url);
  if (!String(cfg.apiKey || '').trim()) throw new Error('尚未配置 API Token');

  const snap = makeSnapshot('proxmox', displayHost(base));
  snap.server.versionPrefix = 'PVE';
  snap.docker.label = META.containerLabel;   // LXC 容器
  snap.vms.label = META.guestLabel;          // QEMU 虚拟机

  // ---- 版本 ----
  const ver = await tryApi(base, cfg, '/version');
  if (ver.ok && ver.data) {
    snap.server.version = pveVersion(ver.data.version) || cleanVersion(ver.data.release);
  } else if (!ver.ok) {
    // 版本取不到通常意味着鉴权/地址有问题 —— 直接抛出让上层显示错误
    throw new Error(ver.error);
  }

  // ---- 节点列表 + 选主节点 ----
  const nodesR = await tryApi(base, cfg, '/nodes');
  if (!nodesR.ok) throw new Error(nodesR.error);
  const nodes = Array.isArray(nodesR.data) ? nodesR.data : [];
  if (!nodes.length) throw new Error('该集群没有任何节点');
  const main = nodeName
    ? (nodes.find((n) => String(n.node) === String(nodeName)) || pickMainNode(nodes))
    : pickMainNode(nodes);
  const node = String(main.node);
  snap.server.name = node;

  const onlineNodes = nodes.filter((n) => String(n.status || '') === 'online').map((n) => String(n.node));
  const scanNodes = onlineNodes.length ? onlineNodes : [node];

  // ---- 主节点详细状态（CPU / 内存 / 根分区 / 内核 / 运行时间）----
  const st = await tryApi(base, cfg, '/nodes/' + encodeURIComponent(node) + '/status');
  if (st.ok && st.data) {
    const d = st.data;

    // CPU：cpu 是 0..1 的比例（占整机）
    snap.cpu.pct = clampPct(toNum(d.cpu) != null ? toNum(d.cpu) * 100 : null);

    const ci = d.cpuinfo || {};
    snap.cpu.brand = cpuBrand(ci);
    snap.cpu.cores = toNum(ci.cores);       // 物理核心
    // PVE 的 cpus = 逻辑处理器总数（核 × socket）
    const cpus = toNum(ci.cpus);
    snap.cpu.threads = cpus != null ? cpus : null;
    snap.cpu.speedGhz = toNum(ci.mhz) != null ? +(toNum(ci.mhz) / 1000).toFixed(2) : null;
    snap.cpu.label = [
      snap.cpu.brand,
      snap.cpu.cores ? snap.cpu.cores + ' 核' : null,
      (snap.cpu.threads && snap.cpu.threads !== snap.cpu.cores) ? snap.cpu.threads + ' 线程' : null,
    ].filter(Boolean).join(' · ') || null;

    // 内存（字节）
    const mem = d.memory || {};
    const mTotal = toNum(mem.total);
    const mUsed = toNum(mem.used);
    if (mTotal != null) {
      snap.ram.totalBytes = mTotal;
      snap.ram.totalText = fmtSize(mTotal);
    }
    if (mUsed != null) {
      snap.ram.usedBytes = mUsed;
      snap.ram.usedText = fmtSize(mUsed);
    }
    snap.ram.pct = (mTotal > 0 && mUsed != null) ? clampPct((mUsed / mTotal) * 100) : null;

    // 根分区容量
    const rf = d.rootfs || {};
    const rTotal = toNum(rf.total);
    const rUsed = toNum(rf.used);
    const rFree = toNum(rf.free) != null ? toNum(rf.free) : toNum(rf.avail);
    if (rTotal > 0 && rUsed != null) {
      snap.disk.pct = clampPct((rUsed / rTotal) * 100);
      snap.disk.usedText = fmtSize(rUsed);
      snap.disk.totalText = fmtSize(rTotal);
      snap.disk.freeText = rFree != null ? fmtSize(rFree) : fmtSize(rTotal - rUsed);
    }
    snap.disk.state = 'ACTIVE';

    // 运行时间（秒）
    const up = toNum(d.uptime);
    if (up != null) snap.server.uptimeText = fmtUptime(up * 1000);

    // 内核
    if (d.kversion) snap.server.kernel = d.kversion;
    else if (d['current-kernel'] && d['current-kernel'].release) snap.server.kernel = d['current-kernel'].release;

    // CPU 温度：PVE 的 /status 不返回温度（在 /nodes/{n}/sensors 才有），此处留 null
    snap.server.distro = 'Proxmox VE';
  } else if (!st.ok) {
    snap.warnings.push('节点状态: ' + st.error);
  }

  // ---- 存储容量（把所有 active 存储的 total/used 求和）----
  const sto = await tryApi(base, cfg, '/nodes/' + encodeURIComponent(node) + '/storage');
  if (sto.ok && Array.isArray(sto.data)) {
    let total = 0;
    let used = 0;
    let hasCap = false;
    for (const s of sto.data) {
      if (!s || s.active === 0 || s.enabled === 0) continue;
      const t = toNum(s.total);
      const u = toNum(s.used);
      if (t != null && t > 0 && u != null) { total += t; used += u; hasCap = true; }
    }
    if (hasCap && total > 0) {
      // 用存储池汇总替换 rootfs（更贴近「存储」语义），失败则保留 rootfs 结果
      snap.disk.pct = clampPct((used / total) * 100);
      snap.disk.usedText = fmtSize(used);
      snap.disk.totalText = fmtSize(total);
      snap.disk.freeText = fmtSize(total - used);
      snap.disk.state = 'ACTIVE';
    }
  } else if (!sto.ok) {
    snap.warnings.push('存储: ' + sto.error);
  }

  // ---- 实时网络吞吐（rrddata 的 netin / netout，单位 字节/秒）----
  const rrd = await tryApi(base, cfg, '/nodes/' + encodeURIComponent(node) + '/rrddata', {
    query: { timeframe: 'hour', cf: 'AVERAGE' },
  });
  if (rrd.ok && Array.isArray(rrd.data) && rrd.data.length) {
    // 取最后一个有数据的时间点
    const last = [...rrd.data].reverse().find((p) => p && toNum(p.netin) != null) || rrd.data[rrd.data.length - 1];
    const netin = toNum(last.netin);    // 下载（进入主机）
    const netout = toNum(last.netout);  // 上传
    snap.net.rx = netin;
    snap.net.tx = netout;
    snap.net.rxText = fmtRate(netin);
    snap.net.txText = fmtRate(netout);
  } else if (!rrd.ok) {
    snap.warnings.push('网络指标: ' + rrd.error);
  }

  // ---- 网卡 / IP / 链路速率 ----
  const ifs = await tryApi(base, cfg, '/nodes/' + encodeURIComponent(node) + '/network');
  if (ifs.ok && Array.isArray(ifs.data)) {
    const n = pickIface(ifs.data);
    if (n) {
      snap.net.iface = n.iface || null;
      snap.ip = n.address || null;
      const sp = toNum(n.speed);
      if (sp != null && sp > 0) {
        // PVE 的 speed 单位已是 Mbps
        snap.net.linkMbps = sp;
        snap.net.speedText = fmtLink(sp);
      }
    }
  } else if (!ifs.ok) {
    snap.warnings.push('网卡: ' + ifs.error);
  }

  // ---- LXC 容器（聚合所有在线节点）----
  const lxcItems = [];
  const lxcErrs = [];
  for (const n of scanNodes) {
    const r = await tryApi(base, cfg, '/nodes/' + encodeURIComponent(n) + '/lxc');
    if (r.ok && Array.isArray(r.data)) {
      for (const c of r.data) lxcItems.push(normGuest(c, n, 'lxc'));
    } else if (!r.ok) {
      lxcErrs.push(n + ': ' + r.error);
    }
  }
  if (lxcErrs.length && !lxcItems.length) {
    snap.docker.ok = false;
    snap.docker.error = lxcErrs.join('; ');
  } else {
    snap.docker.ok = true;
    snap.docker.items = sortGuests(lxcItems);
  }

  // ---- QEMU/KVM 虚拟机（聚合所有在线节点）----
  const qemuItems = [];
  const qemuErrs = [];
  for (const n of scanNodes) {
    const r = await tryApi(base, cfg, '/nodes/' + encodeURIComponent(n) + '/qemu');
    if (r.ok && Array.isArray(r.data)) {
      for (const c of r.data) qemuItems.push(normGuest(c, n, 'qemu'));
    } else if (!r.ok) {
      qemuErrs.push(n + ': ' + r.error);
    }
  }
  if (qemuErrs.length && !qemuItems.length) {
    snap.vms.ok = false;
    snap.vms.error = qemuErrs.join('; ');
  } else {
    snap.vms.ok = true;
    snap.vms.items = sortGuests(qemuItems);
  }

  // ---- 主机 IP 兜底（网卡接口没取到时用地址栏里的主机名）----
  if (!snap.ip) {
    try { snap.ip = new URL(base).hostname; } catch (_) { snap.ip = null; }
  }

  snap.ok = true;
  return snap;
}

/** 挑主网卡：偏好 up + 有 IP + 物理网卡（vmbr/bond/eth/en）*/
function pickIface(list) {
  const items = list.filter((x) => x && x.type !== 'loopback' && String(x.iface || '') !== 'lo');
  if (!items.length) return null;
  const score = (n) => {
    let s = 0;
    if (String(n.active) === '1' || n.active === 1) s += 8;
    if (n.address) s += 6;
    if (n.cidr && /\d+\.\d+\.\d+\.\d+/.test(String(n.cidr))) s += 4;
    if (/^vmbr/i.test(String(n.iface || ''))) s += 5;
    if (/^(eth|en|bond)/i.test(String(n.iface || ''))) s += 4;
    if (n.type === 'bridge') s += 3;
    return s;
  };
  const sorted = [...items].sort((a, b) => score(b) - score(a));
  const best = sorted[0];
  const addr = best.address || (best.cidr ? String(best.cidr).split('/')[0] : null);
  return { iface: best.iface, address: addr, speed: best.speed };
}

/**
 * 归一化 LXC / QEMU 条目（两者字段基本一致）。
 *
 * 实测（PVE 8.0.3）列表接口返回的字段是：
 *   { vmid, name, status, cpu, cpus, mem, maxmem, disk, maxdisk, uptime, netin, netout, ... }
 *
 * ⚠️ 两个易错点（真实环境踩过，mock 曾按错误语义实现导致自检假绿）：
 *   1. 核数字段名是 **`cpus`**（不是 `maxcpu`；`maxcpu` 只在 `/cluster/resources` 里出现）。
 *   2. `cpu` 是 **0..1 的占整机比例**（不是「占用核数」）。实测 vmid=100(2核) cpu=0.0301
 *      ≈ 占 12 线程的 3.01%，与 PVE Web UI 口径一致 ⇒ 直接 ×100，不要再除以核数。
 */
function normGuest(c, node, type) {
  const st = stateInfo(c.status);
  const name = c.name || (String(c.vmid)) || '(未命名)';
  const maxmem = toNum(c.maxmem);
  const mem = toNum(c.mem);
  const maxdisk = toNum(c.maxdisk);
  const cpuFrac = toNum(c.cpu);
  // 核数：列表接口是 `cpus`；`maxcpu` 为兼容 /cluster/resources 形态一并接受
  const maxcpu = toNum(c.cpus) != null ? toNum(c.cpus) : toNum(c.maxcpu);
  const isTemplate = c.template === 1 || c.template === true;

  return {
    id: node + '/' + type + '/' + c.vmid,
    vmid: toNum(c.vmid),
    node,
    type,
    name,
    initial: String(name).charAt(0).toUpperCase(),
    // PVE 不提供图标 -> UI 走首字母头像
    icon: null,
    state: String(c.status || '').toUpperCase(),
    stateLabel: isTemplate ? '模板' : st.label,
    cls: isTemplate ? 'stop' : st.cls,
    running: st.running,
    template: isTemplate,
    // 面板明细
    status: String(c.status || ''),
    cores: maxcpu,
    memBytes: mem,
    memTotalBytes: maxmem,
    memText: maxmem ? fmtSize(mem) + ' / ' + fmtSize(maxmem) : null,
    diskText: maxdisk ? fmtSize(maxdisk) : null,
    uptimeText: toNum(c.uptime) != null ? fmtUptime(toNum(c.uptime) * 1000) : null,
    // cpu 已是 0..1 占整机比例（与 PVE Web UI 一致）
    cpuText: cpuFrac != null ? Math.round(clampPct(cpuFrac * 100)) + '%' : null,
    tags: c.tags ? String(c.tags) : null,
    created: null,
    createdText: null,
  };
}

/** 排序：运行中优先，其次按 vmid */
function sortGuests(list) {
  return [...list].sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1;
    return (a.vmid || 0) - (b.vmid || 0);
  });
}

/* =========================================================================
 * 控制操作
 * -------------------------------------------------------------------------
 * PVE 的启停都是 POST，返回 UPID（异步任务）。参数：
 *   start   : 可选 force
 *   stop    : 硬停止（类似断电）
 *   shutdown: 优雅关机（ACPI）
 *   reboot  : 重启
 *   pause / resume
 * 请求体必须是 x-www-form-urlencoded。
 * =======================================================================*/
const ACTION_MAP = {
  start: 'start',
  stop: 'shutdown',      // UI 的「停止」= 优雅关机，更安全
  forceStop: 'stop',     // UI 的「强制停止」= 硬停止
  restart: 'reboot',
  pause: 'pause',
  resume: 'resume',
};

/**
 * 等待异步任务（UPID）结束，返回任务结果。
 *
 * ⚠️ 实测关键点（PVE 8.0.3）：启停接口是**异步**的 —— POST 立刻返回 HTTP 200 + UPID，
 * 真正的成败在任务里。若只看 HTTP 状态码，对不存在的 VMID 也会「成功」：
 *   POST /nodes/server/qemu/9999/status/start → 200 + UPID
 *   GET  /nodes/server/tasks/{upid}/status    → status:"stopped",
 *                                                exitstatus:"Configuration file ... does not exist"
 * 因此提交后必须短轮询任务状态，失败时抛出真实错误，成功（status==='stopped' && 无 exitstatus）
 * 才算真正完成。
 */
async function waitTask(base, cfg, upid, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 20000);
  let last = null;
  while (Date.now() < deadline) {
    const st = await api(base, cfg, '/nodes/' + upidNode(upid) + '/tasks/' + encodeURIComponent(upid) + '/status',
      { timeout: Math.min(8000, Math.max(2000, deadline - Date.now())) });
    last = st;
    // 任务已结束：status 变为 'stopped'（running 表示仍在跑）
    if (st && String(st.status || '') !== 'running') {
      const exit = st.exitstatus != null ? String(st.exitstatus).trim() : '';
      if (exit && exit !== 'OK') throw new Error('任务执行失败：' + exit);
      return st;
    }
    await sleep(350);
  }
  // 超时：任务可能仍在跑（例如 shutdown 要等 ACPI），不算失败，返回最后状态
  return last;
}

/** 从 UPID 中解析节点名（UPID:node:pid:pstart:starttime:type:id:user:） */
function upidNode(upid) {
  const parts = String(upid || '').split(':');
  return parts.length > 1 && parts[1] ? parts[1] : '';
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function splitId(id) {
  // id 形如 `node/qemu/100` 或 `node/lxc/101`
  const parts = String(id || '').split('/');
  if (parts.length !== 3) throw new Error('无效的目标 ID: ' + id);
  const [node, type, vmid] = parts;
  if (!/^(lxc|qemu)$/.test(type)) throw new Error('无效的目标类型: ' + type);
  if (!/^\d+$/.test(vmid)) throw new Error('无效的 VMID: ' + vmid);
  return { node, type, vmid };
}

async function postStatus(cfg, id, action) {
  const { node, type, vmid } = splitId(id);
  const fn = ACTION_MAP[action];
  if (!fn) throw new Error('不支持的操作: ' + action);
  const base = normalizeEndpoint(cfg.url);
  const path = '/nodes/' + encodeURIComponent(node) + '/' +
    type + '/' + encodeURIComponent(vmid) + '/status/' + fn;
  // 空 body（PVE 接受空表单）
  const upid = await api(base, cfg, path, { method: 'POST', body: '', timeout: cfg.timeout || 30000 });
  // 异步任务：轮询到结束，失败则抛出真实错误（否则对不存在的 VMID 也会假成功）
  if (typeof upid === 'string' && upid.indexOf('UPID:') === 0) {
    return await waitTask(base, cfg, upid, cfg.actionTimeout || 20000);
  }
  return upid;
}

/** 容器（LXC）操作 */
async function containerAction(cfg, id, action) {
  const { type } = splitId(id);
  if (type !== 'lxc') throw new Error('该目标不是 LXC 容器: ' + id);
  // 与 QEMU 保持一致的语义：UI「停止」= 优雅关机（shutdown），「强制停止」= 硬停（stop）
  const map = { start: 'start', stop: 'stop', forceStop: 'stop', restart: 'reboot', pause: 'pause', resume: 'resume', unpause: 'resume' };
  if (action === 'unpause') action = 'resume';
  if (!map[action]) throw new Error('不支持的容器操作: ' + action);
  await postStatus(cfg, id, action);
  return true;
}

/** 虚拟机（QEMU）操作 */
async function guestAction(cfg, id, action) {
  const { type } = splitId(id);
  if (type !== 'qemu') throw new Error('该目标不是 QEMU 虚拟机: ' + id);
  if (!ACTION_MAP[action]) throw new Error('不支持的虚拟机操作: ' + action);
  await postStatus(cfg, id, action);
  return true;
}

/* =========================================================================
 * 连接测试
 * =======================================================================*/
async function testConnection(cfg) {
  const conf = cfg || {};
  if (!String(conf.apiKey || '').trim()) return { ok: false, provider: 'proxmox', error: '请先填写 API Token' };
  let base = '';
  try {
    base = normalizeEndpoint(conf.url);
    const data = await api(base, conf, '/version', { timeout: 10000 });
    let nodeName = null;
    try {
      const nodes = await api(base, conf, '/nodes', { timeout: 10000 });
      const n = pickMainNode(nodes);
      nodeName = n ? String(n.node) : null;
    } catch (_) { /* 忽略 */ }
    return {
      ok: true,
      provider: 'proxmox',
      endpoint: base,
      hostname: nodeName || displayHost(base),
      version: pveVersion(data && data.version),
    };
  } catch (e) {
    return { ok: false, provider: 'proxmox', error: e.message };
  }
}

/* =========================================================================
 * 导出
 * =======================================================================*/
module.exports = {
  /* --- provider 元数据 --- */
  kind: 'proxmox',
  label: META.label,

  /* --- provider 接口 --- */
  normalizeUrl: normalizeEndpoint,
  normalizeEndpoint,
  displayHost,
  fetchSnapshot,
  containerAction,
  guestAction,
  testConnection,
  clearCache() { /* PVE 无探测缓存，留空以统一接口 */ },

  /* --- 向后兼容别名（与 unraid provider 对齐） --- */
  dockerAction: containerAction,
  vmAction: guestAction,
  clearProbeCache() { /* noop */ },

  /* --- 内部工具（自检使用） --- */
  pveVersion,
  splitId,
};
