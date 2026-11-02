'use strict';
/**
 * Unraid Provider —— GraphQL API 客户端 + 数据归一化。
 *
 * 设计要点：
 *  - 官方 API 端点: http://<server>/graphql ，鉴权头 x-api-key
 *  - Unraid 各版本 GraphQL schema 字段名存在差异（例如 uptime/time、capacity.kilobytes/disks、
 *    memory.used/active），因此每个数据区块都用「候选查询」依次探测，命中的查询会被缓存。
 *  - 各区块独立请求、独立容错：某个区块失败（如未启用 VM 服务）不会影响其它区块。
 *
 * 参考: https://docs.unraid.net/API/how-to-use-the-api/
 */
const { URL } = require('url');
const { request } = require('./http');
const {
  toNum, fmtSize, fmtRate, fmtDate, fmtUptime, fmtLink, cleanVersion,
} = require('./format');
const { makeSnapshot } = require('./provider');
const { PROVIDERS } = require('./provider');

const META = PROVIDERS.unraid;

/* =========================================================================
 * 基础工具
 * =======================================================================*/

/** 把用户输入整理成规范的 GraphQL 端点地址 */
function normalizeEndpoint(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('服务器地址不能为空');
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  const u = new URL(s);
  let p = u.pathname.replace(/\/+$/, '');
  if (!/\/graphql$/i.test(p)) p = p + '/graphql';
  u.pathname = p;
  u.hash = '';
  return u.toString();
}

/** 端点地址的展示形式（去掉末尾 /graphql） */
function displayHost(endpoint) {
  try {
    const u = new URL(normalizeEndpoint(endpoint));
    return u.host;
  } catch (_) {
    return String(endpoint || '');
  }
}

/** 解析 info.os.uptime —— 可能是 ISO 开机时间字符串、秒数或时长 */
function parseUptime(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v > 1e11 ? Date.now() - v : v * 1000;
  }
  const s = String(v).trim();
  if (!s) return null;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return Date.now() - t;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return n > 1e11 ? Date.now() - n : n * 1000;
  }
  return null; // 无法解析，交由调用方原样展示
}

/* =========================================================================
 * GraphQL 传输层（底层 HTTP 复用 src/http.js）
 * =======================================================================*/
function rawRequest(endpoint, apiKey, body, opts) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  return request(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    allowSelfSigned: opts.allowSelfSigned !== false,
    timeout: opts.timeout || 12000,
  });
}

/** 执行一次 GraphQL 请求，返回原始响应体；有 errors 且无 data 时抛出异常 */
async function gql(endpoint, apiKey, query, opts) {
  const { status, json, text } = await rawRequest(endpoint, apiKey, { query }, opts);
  if (status === 401 || status === 403) {
    throw new Error('鉴权失败 (HTTP ' + status + ')：请检查 API Key 是否正确、是否具备 ADMIN 角色');
  }
  if (!json) {
    throw new Error('响应不是合法 JSON (HTTP ' + status + ')：' + String(text).slice(0, 160));
  }
  const errs = Array.isArray(json.errors) ? json.errors : [];
  const hasData = json.data && Object.keys(json.data).length > 0;
  if (errs.length && !hasData) {
    throw new Error(errs.map((e) => e.message).filter(Boolean).join('; ') || 'GraphQL 请求失败');
  }
  return { data: json.data || {}, errors: errs, status };
}

/* =========================================================================
 * 多版本字段探测
 * =======================================================================*/
const variantCache = Object.create(null); // section -> 命中的候选名

/**
 * 依次尝试候选查询，返回第一个「可解析」的结果。
 * @param {string} section 区块名（用于缓存命中项）
 * @param {Array<{name:string,q:string,pick:Function}>} variants
 */
async function probe(section, variants, endpoint, apiKey, opts) {
  const order = [];
  const cached = variantCache[section];
  if (cached) {
    const hit = variants.find((v) => v.name === cached);
    if (hit) order.push(hit);
  }
  for (const v of variants) if (!order.includes(v)) order.push(v);

  let lastErr = null;
  for (const v of order) {
    try {
      const { data } = await gql(endpoint, apiKey, v.q, opts);
      const value = v.pick(data);
      if (value !== undefined) {
        variantCache[section] = v.name;
        return { value, variant: v.name };
      }
      lastErr = new Error('字段缺失 (' + v.name + ')');
    } catch (e) {
      lastErr = e;
    }
  }
  const err = lastErr || new Error('无可用查询');
  err.section = section;
  throw err;
}

/* =========================================================================
 * 查询定义（每个区块给出跨版本候选项）
 * =======================================================================*/
const VARIANTS = {
  host: [
    { name: 'os.hostname', q: 'query { info { os { hostname } } }', pick: (d) => d.info && d.info.os && d.info.os.hostname },
    { name: 'root.hostname', q: 'query { info { hostname } }', pick: (d) => d.info && d.info.hostname },
    { name: 'server.name', q: 'query { server { name } }', pick: (d) => d.server && d.server.name },
  ],
  uptime: [
    { name: 'os.uptime', q: 'query { info { os { uptime } } }', pick: (d) => d.info && d.info.os && d.info.os.uptime },
    { name: 'root.time', q: 'query { info { time } }', pick: (d) => d.info && d.info.time },
  ],
  cpuInfo: [
    { name: 'cpu.brand', q: 'query { info { cpu { manufacturer brand cores threads speed } } }', pick: (d) => d.info && d.info.cpu },
    { name: 'cpu.model', q: 'query { info { cpu { model cores threads } } }', pick: (d) => d.info && d.info.cpu },
    { name: 'cpu.cores', q: 'query { info { cpu { cores threads } } }', pick: (d) => d.info && d.info.cpu },
  ],
  versions: [
    // Unraid 7.3+：版本挂在 info.versions.core 下
    { name: 'versions.core', q: 'query { info { versions { core { unraid api kernel } } } }', pick: (d) => d.info && d.info.versions && d.info.versions.core },
    // Unraid 7.2：直接在 info.versions 上
    { name: 'versions.unraid', q: 'query { info { versions { unraid kernel } } }', pick: (d) => d.info && d.info.versions },
    // 兜底：用 info.os.release 当版本号
    { name: 'versions.os', q: 'query { info { os { distro release } } }', pick: (d) => d.info && d.info.os },
  ],
  osInfo: [
    // Unraid 7.3：info.os 带 kernel / release / distro
    {
      name: 'os.full',
      q: 'query { info { os { hostname uptime kernel release distro platform arch } } }',
      pick: (d) => d.info && d.info.os,
    },
    { name: 'os.basic', q: 'query { info { os { hostname uptime } } }', pick: (d) => d.info && d.info.os },
  ],
  board: [
    // 主板信息：baseboard（多数版本）→ system 兜底
    {
      name: 'baseboard',
      q: 'query { info { baseboard { manufacturer model version } } }',
      pick: (d) => d.info && d.info.baseboard,
    },
    {
      name: 'system',
      q: 'query { info { system { manufacturer model } } }',
      pick: (d) => d.info && d.info.system,
    },
  ],
  metrics: [
    // 首选：实时吞吐（rxSec/txSec，字节/秒）+ 每核心占用 + 温度传感器
    {
      name: 'mem.full',
      q:
        'query { metrics { cpu { percentTotal cpus { percentTotal } } ' +
        'memory { total used free available active percentTotal } ' +
        'network { name bytesReceived bytesSent rxSec txSec } ' +
        'temperature { sensors { name type current { value unit } } } } }',
      pick: (d) => d.metrics,
    },
    // 次选：有吞吐但没有温度/每核
    {
      name: 'mem.traffic',
      q:
        'query { metrics { cpu { percentTotal } ' +
        'memory { total used free available percentTotal } ' +
        'network { name bytesReceived bytesSent rxSec txSec } } }',
      pick: (d) => d.metrics,
    },
    {
      name: 'mem.used',
      q: 'query { metrics { cpu { percentTotal } memory { total used free available percentTotal } } }',
      pick: (d) => d.metrics,
    },
    {
      name: 'mem.active',
      q: 'query { metrics { cpu { percentTotal } memory { total active available percentTotal } } }',
      pick: (d) => d.metrics,
    },
    {
      name: 'mem.basic',
      q: 'query { metrics { cpu { percentTotal } memory { total percentTotal } } }',
      pick: (d) => d.metrics,
    },
  ],
  array: [
    { name: 'cap.kilobytes', q: 'query { array { state capacity { kilobytes { free used total } } } }', pick: (d) => d.array },
    { name: 'cap.disks', q: 'query { array { state capacity { disks { free used total } } } }', pick: (d) => d.array },
    { name: 'state.only', q: 'query { array { state } }', pick: (d) => d.array },
  ],
  network: [
    // Unraid 7.3+：网卡信息在根级 networkInterfaces（类型 InfoNetworkInterface）
    {
      name: 'netif.root',
      q: 'query { networkInterfaces { name operstate speed type ipAddress virtual macAddress } }',
      pick: (d) => d.networkInterfaces,
    },
    // 同样数据也可挂在 info 下
    {
      name: 'netif.info',
      q: 'query { info { networkInterfaces { name operstate speed type ipAddress virtual } } }',
      pick: (d) => d.info && d.info.networkInterfaces,
    },
    // 旧版：单个 network 对象
    { name: 'net.full', q: 'query { network { iface ifaceName ipv4 mac operstate speed type } }', pick: (d) => d.network },
    { name: 'net.basic', q: 'query { network { iface ipv4 operstate } }', pick: (d) => d.network },
    { name: 'net.iface', q: 'query { network { iface ipv4 } }', pick: (d) => d.network },
  ],
  docker: [
    {
      name: 'docker.containers',
      q: 'query { docker { containers { id names image state status autoStart created labels } } }',
      pick: (d) => d.docker && d.docker.containers,
    },
    {
      name: 'docker.noLabels',
      q: 'query { docker { containers { id names image state status autoStart created } } }',
      pick: (d) => d.docker && d.docker.containers,
    },
    {
      name: 'docker.namesOnly',
      q: 'query { docker { containers { id names state } } }',
      pick: (d) => d.docker && d.docker.containers,
    },
  ],
  vms: [
    // Unraid 7.x：vms 是对象，虚拟机列表在 vms.domain（[VmDomain!]）下
    {
      name: 'vms.domain',
      q: 'query { vms { domain { id uuid name state } } }',
      pick: (d) => d.vms && (d.vms.domain || d.vms.domains),
    },
    // 少数版本：vms 直接返回数组
    { name: 'vms.flat', q: 'query { vms { id name state } }', pick: (d) => d.vms },
  ],
};

/* =========================================================================
 * 归一化
 * =======================================================================*/
function asArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'object') return Object.values(v);
  return [];
}

/**
 * 从 network / networkInterfaces 两种形态中挑出「主网卡」。
 *  - 新版：`networkInterfaces` 返回 InfoNetworkInterface[]（name / ipAddress / speed / type / virtual）
 *  - 旧版：`network` 返回单个对象（iface / ipv4 / speed）
 */
function pickNetwork(raw) {
  if (!raw) return null;
  let list;
  if (Array.isArray(raw)) {
    list = raw.filter(Boolean);
  } else if (typeof raw === 'object') {
    // 单个网卡对象；少数版本是 { iface: {...} } 映射
    if (raw.ipv4 || raw.ipAddress || raw.iface || raw.ifaceName || raw.name) list = [raw];
    else list = Object.values(raw).filter((v) => v && typeof v === 'object');
  } else {
    return null;
  }
  if (!list.length) return null;

  const items = list.map((n) => ({
    name: n.name || n.iface || n.ifaceName || null,
    ip: n.ipAddress || n.ipv4 || null,
    speed: toNum(n.speed),
    type: String(n.type || '').toLowerCase(),
    virtual: n.virtual === true || String(n.type || '').toLowerCase() === 'virtual',
    operstate: String(n.operstate || '').toLowerCase(),
  }));

  const isLoop = (ip) => /^127\./.test(String(ip || '')) || String(ip || '') === '::1';
  const usable = items.filter((n) => !isLoop(n.ip));
  if (!usable.length) return items[0] || null;

  // 打分挑主网卡：up + 有协商速率 + 物理网卡 优先
  const score = (n) => {
    let s = 0;
    if (n.operstate.includes('up')) s += 8;
    if (n.speed != null && n.speed > 0) s += 4;
    if (n.type === 'wired') s += 2;
    if (n.virtual) s -= 6;
    if (!n.ip) s -= 4;
    if (/^(br|eth|bond|en)/i.test(n.name || '')) s += 3;
    if (n.name === 'lo') s -= 20;
    return s;
  };
  usable.sort((a, b) => score(b) - score(a));
  return usable[0];
}

/**
 * 从 metrics.network 里挑出与主网卡匹配的流量项。
 * 返回 { rx, tx }（字节/秒）—— rxSec = 下载，txSec = 上传。
 * 找不到 rxSec 时用累计字节计数（两次采样差）兜底。
 */
function pickNetStat(list, ifaceName, prev) {
  const arr = asArray(list).filter(Boolean);
  if (!arr.length) return { rx: null, tx: null, name: null };

  const nameOf = (n) => String((n && (n.name || n.iface)) || '');
  let item = ifaceName ? arr.find((n) => nameOf(n) === ifaceName) : null;
  if (!item) item = arr.find((n) => /^(br|eth|bond|en)/i.test(nameOf(n)));
  if (!item) item = arr.find((n) => nameOf(n) !== 'lo') || arr[0];

  const name = nameOf(item) || null;
  let rx = toNum(item.rxSec);
  let tx = toNum(item.txSec);

  // 兜底：用累计字节差 / 时间差
  if (rx == null && prev && prev.name === name && prev.ts && prev.bytesReceived != null) {
    const dt = (Date.now() - prev.ts) / 1000;
    const br = toNum(item.bytesReceived);
    if (dt > 0.2 && br != null && br >= prev.bytesReceived) rx = (br - prev.bytesReceived) / dt;
  }
  if (tx == null && prev && prev.name === name && prev.ts && prev.bytesSent != null) {
    const dt = (Date.now() - prev.ts) / 1000;
    const bs = toNum(item.bytesSent);
    if (dt > 0.2 && bs != null && bs >= prev.bytesSent) tx = (bs - prev.bytesSent) / dt;
  }
  return {
    rx: rx == null ? null : Math.max(0, rx),
    tx: tx == null ? null : Math.max(0, tx),
    name,
    bytesReceived: toNum(item.bytesReceived),
    bytesSent: toNum(item.bytesSent),
  };
}

/** 从温度传感器里挑 CPU 温度：优先「CPU Temp」，其次 CPU_CORE 的平均值 */
function pickCpuTemp(metrics) {
  const t = metrics && metrics.temperature;
  const sensors = asArray(t && t.sensors).filter(Boolean);
  if (!sensors.length) return null;
  const val = (s) => toNum(s && s.current && s.current.value);
  const named = sensors.find((s) => /cpu\s*temp/i.test(String(s.name || '')) && val(s) != null);
  if (named) return Math.round(val(named));
  const cores = sensors.filter((s) => String(s.type || '').toUpperCase() === 'CPU_CORE' && val(s) != null);
  if (cores.length) return Math.round(cores.reduce((a, s) => a + val(s), 0) / cores.length);
  const first = sensors.find((s) => val(s) != null);
  return first ? Math.round(val(first)) : null;
}

const DOCKER_STATE = {
  RUNNING: ['运行中', 'run'],
  EXITED: ['已停止', 'stop'],
  PAUSED: ['已暂停', 'run'],
  RESTARTING: ['重启中', 'warn'],
  CREATED: ['已创建', 'stop'],
  DEAD: ['已终止', 'stop'],
  REMOVED: ['已删除', 'stop'],
};
const VM_STATE = {
  RUNNING: ['运行中', 'run'],
  SHUTOFF: ['已关机', 'stop'],
  STOPPED: ['已关机', 'stop'],
  PAUSED: ['已暂停', 'run'],
  IDLE: ['空闲', 'run'],
  CRASHED: ['已崩溃', 'warn'],
  PMSUSPENDED: ['已休眠', 'run'],
  SHUTDOWN: ['关机中', 'warn'],
};

function stateInfo(map, state) {
  const key = String(state || '').toUpperCase();
  const hit = map[key];
  if (hit) return { label: hit[0], cls: hit[1], running: hit[1] === 'run' };
  return { label: key || '未知', cls: 'stop', running: false };
}

function stripSlash(s) { return String(s || '').replace(/^\/+/, ''); }

/**
 * 容器的操作 ID。
 * Unraid 7.x 返回的 id 本身就是可直接用于 mutation 的 PrefixedID
 * （形如 `<machineId>:<sha256>`），必须原样使用 —— 自行加 `container:` 前缀会找不到容器。
 */
function containerId(c) {
  const raw = c && (c.id || c.Id);
  return raw == null ? null : String(raw);
}

/**
 * 虚拟机的操作 ID。
 * vm.start/stop/forceStop 的 id 接受裸 UUID（也接受 `vm:<uuid>`），
 * 而 vms.domain[].id 是 `<machineId>:<uuid>`，因此需要从中取出 UUID。
 */
function vmId(d) {
  if (!d) return null;
  if (d.uuid) return String(d.uuid);
  const raw = String(d.id || '');
  if (!raw) return null;
  const m = raw.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/i);
  return m ? m[1] : raw;
}

/* =========================================================================
 * 快照抓取
 * =======================================================================*/
/** 上一次的网卡累计字节计数，用于 rxSec/txSec 缺失时按差值兜底 */
let lastNetStat = null;

async function fetchSnapshot(cfg) {
  const endpoint = normalizeEndpoint(cfg.url);
  const apiKey = String(cfg.apiKey || '').trim();
  if (!apiKey) throw new Error('尚未配置 API Key');
  const opts = { allowSelfSigned: cfg.allowSelfSigned !== false, timeout: cfg.timeout || 12000 };

  const snap = makeSnapshot('unraid', displayHost(cfg.url));
  snap.server.versionPrefix = META.label;
  snap.docker.label = META.containerLabel;
  snap.vms.label = META.guestLabel;

  // ---- 系统核心（主机名 / 运行时间 / CPU / 版本）----
  const core = await Promise.allSettled([
    probe('host', VARIANTS.host, endpoint, apiKey, opts),
    probe('uptime', VARIANTS.uptime, endpoint, apiKey, opts),
    probe('cpuInfo', VARIANTS.cpuInfo, endpoint, apiKey, opts),
    probe('versions', VARIANTS.versions, endpoint, apiKey, opts),
    probe('osInfo', VARIANTS.osInfo, endpoint, apiKey, opts),
    probe('board', VARIANTS.board, endpoint, apiKey, opts),
  ]);
  const [hostR, upR, cpuR, verR, osR, boardR] = core;

  if (hostR.status === 'fulfilled') snap.server.name = hostR.value.value || null;
  else snap.warnings.push('主机名: ' + hostR.reason.message);

  if (upR.status === 'fulfilled') {
    const raw = upR.value.value;
    const ms = parseUptime(raw);
    snap.server.uptimeText = ms == null ? String(raw == null ? '—' : raw) : fmtUptime(ms);
  } else {
    snap.warnings.push('运行时间: ' + upR.reason.message);
  }

  if (cpuR.status === 'fulfilled') {
    const c = cpuR.value.value || {};
    const brand = c.brand || c.model || c.manufacturer || '';
    const cores = c.cores != null ? c.cores : null;
    const threads = c.threads != null ? c.threads : null;
    snap.cpu.brand = brand || null;
    snap.cpu.cores = cores;
    snap.cpu.threads = threads;
    snap.cpu.speedGhz = toNum(c.speed);
    snap.cpu.label = [brand, cores ? cores + ' 核' : null, threads && threads !== cores ? threads + ' 线程' : null]
      .filter(Boolean).join(' · ') || null;
  } else {
    snap.warnings.push('CPU 信息: ' + cpuR.reason.message);
  }

  if (osR.status === 'fulfilled' && osR.value.value) {
    const o = osR.value.value;
    snap.server.kernel = o.kernel || null;
    snap.server.distro = o.distro || null;
    // 主机名 / 运行时间优先取 info.os（更完整）
    if (!snap.server.name && o.hostname) snap.server.name = o.hostname;
    if (o.uptime) {
      const ms = parseUptime(o.uptime);
      if (ms != null) snap.server.uptimeText = fmtUptime(ms);
    }
  }

  if (boardR.status === 'fulfilled' && boardR.value.value) {
    const b = boardR.value.value;
    const model = b.model || null;
    const maker = b.manufacturer || null;
    if (model) snap.board = maker && !/to be filled|default string/i.test(maker) ? maker + ' ' + model : model;
  }

  if (verR.status === 'fulfilled' && verR.value.value) {
    const v = verR.value.value;
    snap.server.version = cleanVersion(v.unraid) || cleanVersion(v.release) || null;
  }

  // ---- 实时指标（CPU% / 内存% / 吞吐 / 温度）----
  let netMetricsRaw = null;
  try {
    const m = (await probe('metrics', VARIANTS.metrics, endpoint, apiKey, opts)).value || {};
    if (m.cpu) {
      snap.cpu.pct = toNum(m.cpu.percentTotal);
      snap.cpu.perCore = asArray(m.cpu.cpus)
        .map((c) => toNum(c && c.percentTotal))
        .filter((v) => v != null);
    }
    const mem = m.memory || {};
    snap.ram.pct = toNum(mem.percentTotal);
    const total = toNum(mem.total);
    const used = toNum(mem.used != null ? mem.used : mem.active);
    if (total != null) {
      snap.ram.totalBytes = total;
      snap.ram.totalText = fmtSize(total); // metrics 中的内存为字节
    }
    if (used != null) {
      snap.ram.usedBytes = used;
      snap.ram.usedText = fmtSize(used);
    }
    if (snap.ram.pct == null && total != null && used != null) snap.ram.pct = (used / total) * 100;
    snap.temp = pickCpuTemp(m);
    netMetricsRaw = m.network;
  } catch (e) {
    snap.warnings.push('实时指标: ' + e.message);
  }

  // ---- 存储阵列容量 ----
  try {
    const a = (await probe('array', VARIANTS.array, endpoint, apiKey, opts)).value || {};
    snap.disk.state = a.state || null;
    const cap = a.capacity || {};
    const kb = cap.kilobytes;
    const dk = cap.disks;
    const clamp = (p) => Math.max(0, Math.min(100, p));
    if (kb && kb.total != null) {
      // kilobytes.* 单位为 KB → ×1000 转字节
      const used = toNum(kb.used);
      const total = toNum(kb.total);
      const free = toNum(kb.free);
      if (total > 0 && used != null) {
        snap.disk.pct = clamp((used / total) * 100);
        snap.disk.usedText = fmtSize(used * 1000);
        snap.disk.totalText = fmtSize(total * 1000);
        snap.disk.freeText = free != null ? fmtSize(free * 1000) : fmtSize((total - used) * 1000);
      }
    } else if (dk && dk.total != null) {
      // disks.* 是「磁盘槽位数量」而非容量，只能算比例、不能折算字节
      const used = toNum(dk.used);
      const total = toNum(dk.total);
      if (total > 0 && used != null) {
        snap.disk.pct = clamp((used / total) * 100);
        snap.disk.usedText = used + ' 盘';
        snap.disk.totalText = total + ' 盘';
      }
    }
  } catch (e) {
    snap.warnings.push('阵列: ' + e.message);
  }

  // ---- 网络（主网卡 IP / 协商速率）----
  try {
    const n = pickNetwork((await probe('network', VARIANTS.network, endpoint, apiKey, opts)).value);
    if (n) {
      snap.ip = n.ip || null;
      snap.net.iface = n.name || null;
      const sp = n.speed;
      if (sp != null && sp > 0) {
        snap.net.linkMbps = sp;
        snap.net.speedText = fmtLink(sp);
      }
    }
  } catch (e) {
    snap.warnings.push('网络: ' + e.message);
  }

  // ---- 实时吞吐（下载 = rxSec，上传 = txSec，单位 字节/秒）----
  if (netMetricsRaw) {
    const s = pickNetStat(netMetricsRaw, snap.net.iface, lastNetStat);
    if (s.name && !snap.net.iface) snap.net.iface = s.name;
    snap.net.rx = s.rx;
    snap.net.tx = s.tx;
    snap.net.rxText = fmtRate(s.rx);
    snap.net.txText = fmtRate(s.tx);
    lastNetStat = { name: s.name, ts: Date.now(), bytesReceived: s.bytesReceived, bytesSent: s.bytesSent };
  }

  if (!snap.ip) snap.ip = displayHost(cfg.url).split(':')[0] || null;

  // ---- Docker 容器 ----
  try {
    const list = asArray((await probe('docker', VARIANTS.docker, endpoint, apiKey, opts)).value);
    snap.docker.items = list.map((c) => {
      const st = stateInfo(DOCKER_STATE, c.state);
      const labels = c.labels && typeof c.labels === 'object' ? c.labels : {};
      const icon = labels['net.unraid.docker.icon'] || null;
      const name = stripSlash(Array.isArray(c.names) ? (c.names[0] || '') : (c.names || c.name || ''));
      return {
        id: containerId(c),
        name,
        initial: (name || '?').charAt(0).toUpperCase(),
        icon: /^https?:\/\//i.test(String(icon || '')) ? icon : null,
        image: c.image || '',
        state: String(c.state || '').toUpperCase(),
        stateLabel: st.label,
        cls: st.cls,
        running: st.running,
        status: c.status || '',
        autoStart: !!c.autoStart,
        created: c.created != null ? toNum(c.created) : null,
        createdText: fmtDate(c.created),
      };
    });
    snap.docker.ok = true;
  } catch (e) {
    snap.docker.ok = false;
    snap.docker.error = e.message;
  }

  // ---- 虚拟机 ----
  try {
    const raw = (await probe('vms', VARIANTS.vms, endpoint, apiKey, opts)).value;
    const list = asArray(raw);
    snap.vms.items = list.map((item) => {
      const d = item && item.domain ? item.domain : item;
      const st = stateInfo(VM_STATE, d.state);
      const uuid = d.uuid || (d.id ? String(d.id).split(':').pop() : null);
      return {
        id: vmId(d),
        uuid,
        name: d.name || d.uuid || d.id || '(未命名)',
        state: String(d.state || '').toUpperCase(),
        stateLabel: st.label,
        cls: st.cls,
        running: st.running,
        // 7.3.2 的 VmDomain 不含图标字段；此处做前向兼容，将来若返回则直接使用
        icon: d.icon || d.iconUrl || null,
      };
    });
    snap.vms.ok = true;
  } catch (e) {
    snap.vms.ok = false;
    snap.vms.error = e.message;
  }

  snap.ok = true;
  return snap;
}

/* =========================================================================
 * 控制操作
 * -------------------------------------------------------------------------
 * 已针对真实 Unraid 7.3 验证的要点：
 *  1. docker 的变更字段返回类型是 `DockerContainer!`（对象），
 *     GraphQL 要求必须带子字段选择，否则报
 *     `Field "start" of type "DockerContainer!" must have a selection of subfields`。
 *  2. `docker` 下**没有 restart**（只有 start / stop / pause / unpause / removeContainer / updateContainer），
 *     所以「重启」用 stop + start 两步实现。
 *  3. 容器的 id 必须用查询返回的原值（PrefixedID，形如 `<machineId>:<sha256>`），
 *     不能自行加 `container:` 前缀。
 *  4. vm.start/stop/forceStop 的 id 接受裸 UUID，返回类型是标量，无需子字段选择。
 * =======================================================================*/
const DOCKER_ACTIONS = { start: 'start', stop: 'stop', restart: 'restart', pause: 'pause', unpause: 'unpause' };
const VM_ACTIONS = { start: 'start', stop: 'stop', forceStop: 'forceStop', pause: 'pause', resume: 'resume' };

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 执行一次 docker 变更；老版本若需要 `container:` 前缀则自动回退重试 */
async function dockerMutate(cfg, id, fn) {
  const endpoint = normalizeEndpoint(cfg.url);
  const apiKey = String(cfg.apiKey || '').trim();
  const opts = { allowSelfSigned: cfg.allowSelfSigned !== false, timeout: cfg.timeout || 30000 };
  const build = (target) =>
    'mutation { docker { ' + fn + '(id: ' + JSON.stringify(String(target)) + ') { id state } } }';
  const target = String(id);
  try {
    await gql(endpoint, apiKey, build(target), opts);
  } catch (e) {
    // 兼容老版本：其容器 id 可能是裸值，需要 container: 前缀
    const msg = String((e && e.message) || '');
    if (!/^container:/i.test(target) && /no such container|not found|找不到/i.test(msg)) {
      await gql(endpoint, apiKey, build('container:' + target), opts);
      return;
    }
    throw e;
  }
}

async function containerAction(cfg, id, action) {
  if (!DOCKER_ACTIONS[action]) throw new Error('不支持的容器操作: ' + action);
  if (!id) throw new Error('缺少容器 ID');

  // 该 API 无 restart 变更：用 停止 → 启动 组合实现
  if (action === 'restart') {
    try {
      await dockerMutate(cfg, id, 'stop');
    } catch (e) {
      // 已停止的容器 stop 会失败，此处忽略后继续启动
      if (!/is not running|already stopped|已停止/i.test(String(e.message || ''))) throw e;
    }
    await sleep(700);
    await dockerMutate(cfg, id, 'start');
    return true;
  }

  await dockerMutate(cfg, id, action);
  return true;
}

async function guestAction(cfg, id, action) {
  const fn = VM_ACTIONS[action];
  if (!fn) throw new Error('不支持的虚拟机操作: ' + action);
  if (!id) throw new Error('缺少虚拟机 ID');

  const endpoint = normalizeEndpoint(cfg.url);
  const apiKey = String(cfg.apiKey || '').trim();
  const opts = { allowSelfSigned: cfg.allowSelfSigned !== false, timeout: cfg.timeout || 30000 };
  const build = (target) =>
    'mutation { vm { ' + fn + '(id: ' + JSON.stringify(String(target)) + ') } }';
  const target = String(id);
  try {
    await gql(endpoint, apiKey, build(target), opts);
  } catch (e) {
    // 兼容只接受 `vm:<uuid>` 的版本
    const msg = String((e && e.message) || '');
    if (!/^vm:/i.test(target) && /invalid uuid|no domain|not found|找不到/i.test(msg)) {
      await gql(endpoint, apiKey, build('vm:' + target), opts);
      return true;
    }
    throw e;
  }
  return true;
}

/** 测试连接：返回服务器信息或错误 */
async function testConnection(cfg) {
  const conf = cfg || {};
  const apiKey = String(conf.apiKey || '').trim();
  if (!apiKey) return { ok: false, provider: 'unraid', error: '请先填写 API Key' };
  const opts = { allowSelfSigned: conf.allowSelfSigned !== false, timeout: 10000 };
  let endpoint = '';
  try {
    // 地址解析放在 try 内：空/非法地址也应返回 {ok:false}，而不是抛出异常
    endpoint = normalizeEndpoint(conf.url);
    const { value } = await probe('host', VARIANTS.host, endpoint, apiKey, opts);
    let version = null;
    try {
      const v = await probe('versions', VARIANTS.versions, endpoint, apiKey, opts);
      version = v.value ? (cleanVersion(v.value.unraid) || cleanVersion(v.value.release)) : null;
    } catch (_) { /* 忽略 */ }
    return { ok: true, provider: 'unraid', endpoint, hostname: value || null, version };
  } catch (e) {
    return { ok: false, provider: 'unraid', error: e.message };
  }
}

/** 清空「候选查询命中项」缓存（切换服务器 / 自检时用） */
function clearCache() {
  for (const k of Object.keys(variantCache)) delete variantCache[k];
  lastNetStat = null;
}

module.exports = {
  /* --- provider 元数据 --- */
  kind: 'unraid',
  label: META.label,

  /* --- provider 接口 --- */
  normalizeUrl: normalizeEndpoint,
  normalizeEndpoint,
  displayHost,
  fetchSnapshot,
  containerAction,
  guestAction,
  testConnection,
  clearCache,

  /* --- 向后兼容别名 --- */
  dockerAction: containerAction,
  vmAction: guestAction,
  clearProbeCache: clearCache,

  /* --- 复用工具（供其它模块引用） --- */
  fmtSize,
  fmtUptime,
  fmtRate,
};
