'use strict';
/**
 * fnOS（飞牛私有云）Provider —— WebSocket RPC + 混合加密客户端。
 * ============================================================================
 * fnOS 与 Unraid(HTTP+GraphQL) / Proxmox(REST) / DSM(CGI) 都不同：
 *
 *   1. 传输：**WebSocket 长连接**  ws(s)://host:5666|5667/websocket?type=main
 *   2. 握手：连上后先取 RSA 公钥
 *        → {"req":"util.crypto.getRSAPub","reqid":"…"}  (不签名)
 *        ← {pub:<PEM>, si:<会话序号>, result:"succ", reqid}
 *   3. 登录：AES-256-CBC 加密正文，AES 密钥用 RSA(PKCS#1 v1.5) 加密后同发
 *        key = randomBytes(32)，iv = randomBytes(16)
 *        {"req":"encrypted", iv:b64(iv), rsa:b64(rsaEncrypt(key)), aes:b64(aes(json))}
 *        json = {reqid, req:"user.login", user, password, stay, deviceType, deviceName, did, si}
 *      ← {token, secret, backId, uid, admin, result:"succ", reqid}
 *   4. 签名密钥：signKey = base64( AES-256-CBC-decrypt(secret, 本次的 key/iv) )
 *   5. 业务请求：明文 JSON + HMAC-SHA256 签名**前置拼接**
 *        json = JSON.stringify({req, reqid, ...参数})
 *        sig  = base64( HMAC-SHA256( base64decode(signKey), json ) )
 *        发送 "sig" + json          ← 注意是字符串拼接，不是 JSON
 *      白名单 req 不签名：encrypted / util.getSI / util.crypto.getRSAPub
 *   6. 心跳：应用层文本 {"req":"ping"} → 服务端回 {"res":"pong"}（无 reqid）
 *   7. 两步验证：登录返回 {result:"succ", isBindTwofaSecret:true,
 *      isTrustedDevice:false, accessToken} → 再加密提交
 *      {req:"user.2fa.loginVerify", code, isTrustedDevice, accessToken,
 *       stay, deviceName, deviceType, did, si}
 *
 * ---------------------------------------------------------------------------
 * ★ 虚拟机走**另一条完全独立的通道**（2026-10-14 实测确认，勿再走 WS RPC）
 * ---------------------------------------------------------------------------
 * 网络上常见的「fnOS 无虚拟机 API」猜测是错的：虚拟机功能是**可选应用**
 * （应用中心里的「虚拟机」，trim.vm），它有**自己的 REST 服务**，
 * 挂在同一个 HTTP 端口的 /vm/api/v1 下，**与 WebSocket RPC 毫无关系**。
 * 因此 appcgi.vmm.* / appcgi.vm.* 之类命令一律返回 errno 266240 —— 那不是
 * 「没装」，而是「找错了地方」。
 *
 *   传输：HTTP/JSON（同一个 base，路径前缀 /vm/api/v1）
 *   鉴权：Authorization: <WebSocket 登录返回的 cli.token>（**裸 token，无 Bearer**）
 *         不带 → HTTP 401 {code:401,message:"unauthorized"}
 *   响应：{code, msg, data}，code === 0 为成功
 *
 *   端点（GET 用 query，POST 用 JSON body，参数一律 { name: <虚拟机内部名> }）：
 *     GET  /domain/list          → 虚拟机列表
 *     GET  /domain/status        → 运行中虚拟机的实时指标（monitor.cpu / memory / networks）
 *     GET  /domain/info?name=…   → 单台详情（cpuCoreCnt / memCapacityInBytes / disks[]…）
 *     POST /domain/start | shutdown | forceshutdown | reboot | pause | resume | delete
 *     GET  /system/hardwareInfo | /system/allVolsInfo
 *     GET  /ovs/isInited | /ovs/listDetail
 *     GET  /hostdev/support | /isSigned | /isHostdevEnabled | /lsusb | /lspci
 *     GET  /snapshot/list?name=… , POST /snapshot/create | delete | revert
 *     GET  /dashboard/summary    （SSE，实时推送）
 *
 *   错误码（VM 应用自己的编号段，与上面 WS 的 errno 不通用）：
 *     12021 = 找不到指定虚拟机     12033 = 当前状态不允许该操作
 *     12020 = 连接异常             12024 = 无法启动
 *     HTTP 404（路由不存在）        = 未安装「虚拟机」应用
 *     HTTP 401                      = 会话失效，需重新登录后重试
 *
 * 参考实现（协议逆向来源）：
 *   - https://github.com/FNOSP/fnnas-api            (Python；官方文档 fnosp.github.io/fnnas-api)
 *   - https://github.com/Timandes/fnos-ts-client    (TypeScript，含 2FA)
 *   - https://github.com/Cp0204/pyfnos              (Python SDK)
 * ========================================================================*/
const crypto = require('crypto');
const { URL } = require('url');
const { connect } = require('./ws');
const { request } = require('./http');
const {
  toNum, fmtSize, fmtRate, fmtDate, fmtUptime, fmtLink, cleanVersion, clampPct,
} = require('./format');
const { makeSnapshot, PROVIDERS } = require('./provider');

const META = PROVIDERS.fnos;

/* =========================================================================
 * 命令表 —— 全部命令名于 2026-10-14 在真实机（fnOS 1.2.0800）上实测确认
 * =======================================================================*/
const CMD = {
  // 握手 / 鉴权（免签名）
  rsaPub: 'util.crypto.getRSAPub',
  si: 'util.getSI',
  login: 'user.login',
  twofa: 'user.2fa.loginVerify',

  // 系统信息（appcgi.sysinfo.*）
  hostName: 'appcgi.sysinfo.getHostName',
  trimVersion: 'appcgi.sysinfo.getTrimVersion',
  hardware: 'appcgi.sysinfo.getHardwareInfo',
  uptime: 'appcgi.sysinfo.getUptime',
  machineId: 'appcgi.sysinfo.getMachineId',

  // 资源监控（appcgi.resmon.*）
  cpu: 'appcgi.resmon.cpu',
  mem: 'appcgi.resmon.mem',
  net: 'appcgi.resmon.net',
  disk: 'appcgi.resmon.disk',
  resmonGen: 'appcgi.resmon.gen',
  sysFan: 'appcgi.resmon.sysFan',

  // 存储（**顶层 stor.*，无 appcgi 前缀**）
  storeGeneral: 'stor.general',
  storeCalc: 'stor.calcSpace',
  listDisk: 'stor.listDisk',

  // 网络（appcgi.network.*）
  networkList: 'appcgi.network.net.list',

  // Docker（appcgi.dockermgr.*）
  dockerList: 'appcgi.dockermgr.containerList',
  dockerStats: 'appcgi.dockermgr.stats',
  dockerComposeList: 'appcgi.dockermgr.composeList',
};

/** 容器操作命令（实测存在；参数名 = containerId） */
const DOCKER_ACTION_CMD = {
  start: 'appcgi.dockermgr.containerStart',
  stop: 'appcgi.dockermgr.containerStop',
  restart: 'appcgi.dockermgr.containerRestart',
  kill: 'appcgi.dockermgr.containerKill',
};

/* =========================================================================
 * 虚拟机 REST 路由（实测自 fnOS 1.2.0800 的「虚拟机」应用前端 trim.vm 0.9.0）
 * 注意：**不吃签名**，只需 Authorization 头带 WebSocket 会话 token。
 * =======================================================================*/
/** REST 前缀 */
const VM_API = '/vm/api/v1';

/** 只读端点 */
const VM_GET = {
  list: '/domain/list',
  status: '/domain/status',
  info: '/domain/info',
  availableTitle: '/domain/availableTitle',
  hardware: '/system/hardwareInfo',
  vols: '/system/allVolsInfo',
  ovsInited: '/ovs/isInited',
  ovsList: '/ovs/listDetail',
  hostdevSupport: '/hostdev/support',
  hostdevEnabled: '/hostdev/isHostdevEnabled',
};

/**
 * 操作端点 —— 参数一律 { name: <虚拟机内部名> }。
 * 与 UI 动作名的对应关系（语义与其它 provider 保持一致）：
 *   UI「停止」= shutdown（优雅关机）、UI「强制停止」= forceshutdown（断电）
 */
const VM_ACTION_API = {
  start: { method: 'POST', path: '/domain/start' },
  stop: { method: 'POST', path: '/domain/shutdown' },
  forceStop: { method: 'POST', path: '/domain/forceshutdown' },
  restart: { method: 'POST', path: '/domain/reboot' },
  pause: { method: 'POST', path: '/domain/pause' },
  resume: { method: 'POST', path: '/domain/resume' },
};

/** 不需要签名的 req（签名拼接前会跳过） */
const NO_SIGN = new Set(['encrypted', 'util.getSI', 'util.crypto.getRSAPub']);

/* =========================================================================
 * 地址 / 凭据
 * =======================================================================*/
/**
 * 归一化端点（返回站点根地址，协议用 http/https 表示）。
 *   '192.168.1.5'            -> 'http://192.168.1.5:5666'
 *   '192.168.1.5:5667'       -> 'http://192.168.1.5:5667'
 *   'https://nas.local'      -> 'https://nas.local:5667'
 *   'ws://192.168.1.5:5666'  -> 'http://192.168.1.5:5666'
 *   'wss://nas.local'        -> 'https://nas.local:5667'
 * fnOS 默认 HTTP 5666 / HTTPS 5667，未写协议时按 http 处理。
 */
function normalizeEndpoint(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('服务器地址不能为空');
  if (/^wss:\/\//i.test(s)) s = 'https://' + s.slice(6);
  else if (/^ws:\/\//i.test(s)) s = 'http://' + s.slice(5);
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  const u = new URL(s);
  const secure = u.protocol === 'https:';
  if (!u.port) u.port = secure ? '5667' : '5666';
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

/** 由站点根地址推出 WebSocket 地址 */
function wsEndpoint(base) {
  const u = new URL(base);
  const scheme = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return scheme + '//' + u.host + '/websocket?type=main';
}

/** 取登录凭据（账号密码模式） */
function creds(cfg) {
  const account = String((cfg && cfg.username) || '').trim();
  const passwd = String((cfg && cfg.password) || '');
  if (!account) throw new Error('尚未配置 fnOS 账号');
  if (!passwd) throw new Error('尚未配置 fnOS 密码');
  return { account, passwd };
}

/* =========================================================================
 * ★ fnConnect 地址发现（只填 FN ID，自动挑当下最优地址）
 * -------------------------------------------------------------------------
 * 飞牛官方的 FN Connect 远程访问服务只需要一个 FN ID（形如 `demo-nas`），
 * 客户端再按「当下所处的网络环境」自动选一条最优路径。其实测入口是云端接口
 * （逆向自官方门户 https://fnos.net/<fnid> 的前端资源，2026-10-14 实测）：
 *
 *   POST https://fnos.net/api/v1/fn/con      body: {"fnId":"demo-nas"}
 *     headers:
 *       fn-sign : SHA256("trim_connect`" + fnId + "`" + ts + "`anna")
 *       authx   : nonce=<6位随机>&timestamp=<ms>&sign=<MD5(串)>
 *                 串 = 前缀 _ 路径 _ nonce _ ts _ MD5(body) _ apiKey
 *   响应:
 *     { code:0, data:{
 *         ipv4:        [ "192.168.1.40" ],            ← ★ 局域网地址（NAS 上报）
 *         ipv6:        [],
 *         publicIpv4:  [ "203.0.113.10" ],           ← 公网 IPv4
 *         publicIpv6:  [ "2001:db8::5ce0", "2001:db8::3ef" ],
 *         fn:          [ "demo-nas.fnos.net:443" ],   ← FN Connect 中继域名
 *         ddns:        null,                          ← 自建 DDNS（可为 null）
 *         port:        { httpPort:5666, httpsPort:5667 },
 *         checkSum, ver } }
 *
 * 拿到候选后逐个探活（GET /static/bridge.html —— 与官方门户同款探针，
 * 该页由 NAS 自己提供，含 `xhrRequest` 标记），再按优先级取第一个可达的：
 *
 *     局域网 → 公网 IPv4 → 公网 IPv6 → DDNS → 中继
 *
 * 结果带 5 分钟缓存（探测过的地址不重复探），解析/探活失败则缓存 30 秒避免抖动。
 * 未配置 FN ID 时完全走老路（直接用手填地址），行为不变。
 * =======================================================================*/
const FN_CONNECT = {
  domain: 'fnos.net',
  /** 官方门户支持的域名池（netsvr.domain.list 实测返回前两个） */
  domains: ['fnos.net', '5ddd.com', 'trzznas.com'],
  resolvePath: '/api/v1/fn/con',
  signPrefix: 'NDzZTVxnRKP8Z0jXg1VAMonaG8akvh',
  apiKey: 'zIGtkc3dqZnJpd29qZXJqa2w7c',
  /** 探活路径：由 NAS 自身提供，官方门户也用这个（iframe + bridge.html） */
  probePath: '/static/bridge.html',
  probeMark: /xhrRequest|bridge/i,
  ttl: 5 * 60 * 1000,
  failTtl: 30 * 1000,
  probeTimeout: 2500,
};

/**
 * 各类候选的探活超时（毫秒）。
 * 局域网一定是亚秒级，没必要等满 2.5s；公网/中继才给宽限。
 * 关键：按优先级**分组串行**探活，高优先级组一命中就返回，不等低优先级超时。
 */
const PROBE_TIMEOUT = {
  lan: 800,
  lan6: 800,
  public4: 2000,
  public6: 2000,
  ddns: 2500,
  relay: 2500,
};

/** fnConnect 云端错误码（前端 ErrorCode 枚举 + 实测） */
const FN_ERR = {
  3000006: '找不到该 FN ID，请确认 FN Connect 已在 NAS 上开启',
  3000009: '无法连接飞牛云端，请检查本机网络',
  3000037: '找不到该 FN ID，请确认 FN Connect 已在 NAS 上开启',
};

const md5hex = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** fnConnect 云端入口（cfg.fnDomain 可覆盖，默认 fnos.net） */
function fnOrigin(cfg) {
  let d = String((cfg && cfg.fnDomain) || '').trim() || FN_CONNECT.domain;
  if (!/^https?:\/\//i.test(d)) d = 'https://' + d;
  return d.replace(/\/+$/, '');
}

/** 构造 authx 头（官方门户 HttpClient 拦截器同款算法） */
function fnAuthHeader(urlPath, bodyStr) {
  const nonce = String(Math.floor(Math.random() * 900000) + 100000);
  const ts = Date.now();
  const joined = [
    FN_CONNECT.signPrefix, urlPath, nonce, ts, md5hex(bodyStr), FN_CONNECT.apiKey,
  ].join('_');
  return 'nonce=' + nonce + '&timestamp=' + ts + '&sign=' + md5hex(joined);
}

/**
 * FN ID → 候选地址集合。
 * 不需要任何登录态，只要 FN ID（与官方门户一致）。
 */
async function resolveFnId(fnId, cfg) {
  const id = String(fnId || '').trim();
  if (!id) throw new Error('尚未配置 FN ID');
  const bodyStr = JSON.stringify({ fnId: id });
  const origin = fnOrigin(cfg);
  let r;
  try {
    r = await request(origin + FN_CONNECT.resolvePath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'fn-sign': sha256hex('trim_connect`' + id + '`' + Date.now() + '`anna'),
        authx: fnAuthHeader(FN_CONNECT.resolvePath, bodyStr),
      },
      body: bodyStr,
      timeout: 8000,
    });
  } catch (e) {
    throw new Error('无法连接飞牛云端（' + origin + '）：' + ((e && e.message) || e));
  }
  const j = (r && r.json) || {};
  if (j.code !== 0 || !j.data) {
    const c = Number(j.code);
    if (FN_ERR[c]) throw new Error(FN_ERR[c]);
    throw new Error('FN Connect 解析失败：' + ((j && j.msg) || ('HTTP ' + (r && r.status))));
  }
  const d = j.data || {};
  const port = d.port || {};
  const arr = (x) => (Array.isArray(x) ? x.filter(Boolean) : []);
  return {
    fnId: id,
    lan4: arr(d.ipv4),
    lan6: arr(d.ipv6),
    pub4: arr(d.publicIpv4),
    pub6: arr(d.publicIpv6),
    relay: arr(d.fn),
    ddns: arr(d.ddns),
    httpPort: Number(port.httpPort) || 5666,
    httpsPort: Number(port.httpsPort) || 5667,
  };
}

/** 拼地址（IPv6 自动加方括号） */
function fnJoin(host, port, secure) {
  const h = String(host || '').trim();
  if (!h) return '';
  const isV6 = h.indexOf(':') >= 0 && h[0] !== '[';
  const hp = isV6 ? '[' + h + ']' : h;
  return (secure ? 'https://' : 'http://') + hp + (port ? ':' + port : '');
}

/** 候选地址列表（顺序即优先级） */
function buildCandidates(res) {
  const out = [];
  const seen = new Set();
  const push = (kind, base, label) => {
    if (!base || seen.has(base)) return;
    seen.add(base);
    out.push({ kind, base, label });
  };
  res.lan4.forEach((ip) => push('lan', fnJoin(ip, res.httpPort, false), '局域网直连'));
  res.lan6.forEach((ip) => push('lan6', fnJoin(ip, res.httpPort, false), '局域网 IPv6'));
  res.pub4.forEach((ip) => push('public4', fnJoin(ip, res.httpPort, false), '公网直连'));
  res.pub6.forEach((ip) => push('public6', fnJoin(ip, res.httpPort, false), '公网 IPv6 直连'));
  res.ddns.forEach((h) => push('ddns', fnJoin(String(h).replace(/:\d+$/, ''), res.httpsPort, true), 'DDNS 域名'));
  res.relay.forEach((h) => push('relay', fnJoin(String(h).replace(/:\d+$/, ''), 0, true), 'FN Connect 中继'));
  return out;
}

/** 探活单个候选地址（命中 NAS 自带的 bridge 页即算通） */
async function probeBase(base, timeout) {
  try {
    const r = await request(base + FN_CONNECT.probePath, {
      method: 'GET',
      timeout: timeout || FN_CONNECT.probeTimeout,
    });
    if (!r || r.status !== 200) return false;
    return FN_CONNECT.probeMark.test(String(r.text || ''));
  } catch (_) {
    return false;
  }
}

/**
 * 按优先级**分组串行**探活：同组并行、高优先级组命中即返回。
 * 这样局域网环境下只需一次探测（~几十毫秒），不必等公网/中继超时。
 */
async function pickReachable(cands) {
  if (!cands.length) return null;
  let i = 0;
  while (i < cands.length) {
    const kind = cands[i].kind;
    const group = [];
    while (i < cands.length && cands[i].kind === kind) group.push(cands[i++]);
    const t = PROBE_TIMEOUT[kind] || FN_CONNECT.probeTimeout;
    const flags = await Promise.all(group.map((c) => probeBase(c.base, t)));
    for (let j = 0; j < group.length; j++) if (flags[j]) return group[j];
  }
  return null;
}

/** base 缓存（key = fnId|域名|账号），命中即免去云端解析与探活 */
const fnBaseCache = new Map();

function fnCacheKey(cfg) {
  return [
    String((cfg && cfg.fnId) || '').trim(),
    String((cfg && cfg.fnDomain) || '').trim(),
    String((cfg && cfg.username) || '').trim(),
  ].join('|');
}

/** 清掉某个 FN ID 的缓存（配置变更 / 连接失败时用） */
function clearFnBase(fnId) {
  if (!fnId) { fnBaseCache.clear(); return; }
  const id = String(fnId).trim();
  for (const k of [...fnBaseCache.keys()]) {
    if (k.indexOf(id + '|') === 0) fnBaseCache.delete(k);
  }
}

/**
 * 取得本次要用的 base。
 *   - 没配 FN ID → 老逻辑（手填地址）
 *   - 配了 FN ID → 云端解析 + 探活 + 缓存
 */
async function getBase(cfg, opts) {
  const manual = String((cfg && cfg.url) || '').trim();
  const fnId = String((cfg && cfg.fnId) || '').trim();
  if (!fnId) {
    return { base: normalizeEndpoint(manual), kind: 'manual', label: '手动地址', res: null };
  }

  const key = fnCacheKey(cfg);
  const force = !!(opts && opts.force);
  const hit = fnBaseCache.get(key);
  if (!force && hit) {
    const age = Date.now() - hit.at;
    if (hit.base && age < FN_CONNECT.ttl) return hit;
    if (!hit.base && age < FN_CONNECT.failTtl) throw hit.err;
  }

  /* ---- 云端解析：默认域名失败时依次尝试域名池 ---- */
  const domains = String((cfg && cfg.fnDomain) || '').trim()
    ? [String(cfg.fnDomain).trim()]
    : FN_CONNECT.domains;
  let res = null;
  let lastErr = null;
  for (const d of domains) {
    try {
      res = await resolveFnId(fnId, Object.assign({}, cfg, { fnDomain: d }));
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!res) {
    // FN Connect 用不了（未开启 / 云端不通 / FN ID 错）：
    // 手填了地址就退回老路，不探测（与未配 FN ID 时行为一致）
    const err = lastErr || new Error('FN Connect 解析失败');
    if (manual) {
      const out = { base: normalizeEndpoint(manual), kind: 'manual', label: '手动地址', at: Date.now(), res: null };
      fnBaseCache.set(key, out);
      return out;
    }
    fnBaseCache.set(key, { base: null, at: Date.now(), err });
    throw err;
  }

  /* ---- 探活选路 ---- */
  const cands = buildCandidates(res);
  const best = await pickReachable(cands);
  if (best) {
    const out = { base: best.base, kind: best.kind, label: best.label, at: Date.now(), res };
    fnBaseCache.set(key, out);
    return out;
  }

  /* ---- 全部不可达：若手填了地址则回退 ---- */
  if (manual) {
    try {
      const fb = normalizeEndpoint(manual);
      if (await probeBase(fb)) {
        const out = { base: fb, kind: 'manual', label: '手动地址', at: Date.now(), res };
        fnBaseCache.set(key, out);
        return out;
      }
    } catch (_) { /* ignore */ }
  }

  const tried = cands.map((c) => c.label).join(' / ') || '无';
  const err = new Error(
    'FN Connect 解析到 ' + cands.length + ' 个地址，但都不可达（' + tried +
    '）。请确认 NAS 在线、FN Connect 已开启，或在设置里直接填写地址。'
  );
  fnBaseCache.set(key, { base: null, at: Date.now(), err });
  throw err;
}

/* =========================================================================
 * 加密 / 签名工具（全部基于 Node 内置 crypto）
 * =======================================================================*/
/** AES-256-CBC 加密（自动 PKCS#7 填充），返回 base64 */
function aesEncrypt(plain, key, iv) {
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]).toString('base64');
}

/** AES-256-CBC 解密（自动去填充），返回原始字节 */
function aesDecryptBytes(b64, key, iv) {
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const buf = Buffer.from(String(b64), 'base64');
  return Buffer.concat([decipher.update(buf), decipher.final()]);
}

/** RSA 公钥加密（PKCS#1 v1.5），返回 base64 */
function rsaEncrypt(dataBuf, pem) {
  return crypto.publicEncrypt(
    { key: pem, padding: crypto.constants.RSA_PKCS1_PADDING },
    dataBuf
  ).toString('base64');
}

/** HMAC-SHA256 签名（key 为 base64 字符串），返回 base64 */
function hmacSign(jsonStr, signKeyB64) {
  const key = Buffer.from(String(signKeyB64), 'base64');
  return crypto.createHmac('sha256', key).update(jsonStr, 'utf8').digest('base64');
}

/** 由登录返回的 secret 派生签名密钥（再 base64 一次，与官方实现一致） */
function deriveSignKey(secretB64, key, iv) {
  return aesDecryptBytes(secretB64, key, iv).toString('base64');
}

/** 生成设备 ID（形如 'xxxx-xxxx-xxxx'） */
function makeDid() {
  return [8, 8, 8]
    .map(() => crypto.randomBytes(6).toString('hex').slice(0, 8))
    .join('-');
}

/* =========================================================================
 * 错误码 —— 于真实机实测标定（各模块的 errno 不通用，此处做通用解释）
 * =======================================================================*/
const ERR = {
  131072: '账号或密码错误',
  135168: '登录凭证已失效，请重新登录',
  266240: '该功能模块在本机未安装',
  100000004: '不支持的操作',
  52428802: '容器当前状态不允许该操作',
  52428803: '请求参数不完整',
  52428814: '找不到指定容器',
  100000002: '请求参数不合法',
  8192: '请求参数不合法',
  100060001: '该信息在此设备上不可用',
};

/** errno 266240 = 模块/命名空间不存在 */
const ERRNO_NO_MODULE = 266240;
/** errno 52428814 = 目标容器不存在 */
const ERRNO_NO_CONTAINER = 52428814;

/* =========================================================================
 * 虚拟机专属错误码（编号段 12xxx，与 WS 的 errno 完全无关）
 * 取名自「虚拟机」应用前端枚举，仅列常用项
 * =======================================================================*/
const ERR_VM = {
  12001: '虚拟机业务规则异常',
  12020: '虚拟机连接异常',
  12021: '找不到指定虚拟机',
  12022: '虚拟机配置异常',
  12023: '芯片组不支持 IDE 磁盘',
  12024: '虚拟机无法启动',
  12025: '虚拟机依赖的设备缺失',
  12029: '不支持指定的虚拟机类型',
  12030: '虚拟机未关机，无法编辑',
  12031: '虚拟机未关机，无法删除',
  12032: '快照保护的设备被修改',
  12033: '虚拟机当前状态不允许该操作',
  12040: '找不到指定虚拟磁盘',
  12041: '存储空间不足',
  12042: '找不到磁盘或光驱',
  12043: '磁盘容量只能扩容，不支持缩小',
  12047: '存储空间不存在',
  12048: '磁盘为只读',
  12049: '磁盘文件打开失败',
  12050: '找不到指定快照',
  12052: '快照名称重复',
  12053: '不支持在线快照',
  12056: '快照不存在',
  12057: '快照异常',
  12061: '虚拟网络不存在',
  12080: '不支持直通设备',
  12081: '找不到直通设备',
  12083: '直通设备已被其他虚拟机占用',
  12085: '设备直通失败',
};

/** VM 应用状态 → { label, cls, running, paused } */
const VM_STATE = {
  RUNNING: { label: '运行中', cls: 'run', running: true, paused: false },
  SHUTOFF: { label: '已关机', cls: 'stop', running: false, paused: false },
  SHUTTING_DOWN: { label: '关机中', cls: 'warn', running: true, paused: false },
  PAUSED: { label: '已暂停', cls: 'warn', running: true, paused: true },
  BLOCKED: { label: '已阻塞', cls: 'err', running: false, paused: false },
  CRASHED: { label: '已崩溃', cls: 'err', running: false, paused: false },
  OVA_EXPORT: { label: '导出中', cls: 'warn', running: false, paused: false },
  NO_STATE: { label: '未知', cls: 'stop', running: false, paused: false },
};

/** VM 应用状态 → 结构化信息（未知状态回落 OTHER） */
function vmState(raw) {
  const k = String(raw || '').trim().toUpperCase();
  return VM_STATE[k] || { label: k || '未知', cls: 'stop', running: false, paused: false };
}


function errText(code, data) {
  const n = toNum(code);
  if (n == null) return null;
  if (ERR[n]) return ERR[n];
  // 两步验证相关
  if (data && data.isBindTwofaSecret && !data.token) return '该账号已开启两步验证，请输入验证码';
  return 'fnOS 返回错误码 ' + n;
}

/** 构造带 errno 的错误（便于上游区分「模块未安装」等） */
function fnosError(data) {
  const e = new Error(errText(data && data.errno, data) || 'fnOS 请求失败');
  e.errno = toNum(data && data.errno);
  e.req = (data && data.req) || null;
  return e;
}

/* =========================================================================
 * 响应取值工具
 * 实测响应形态：
 *   appcgi.*  → { data: {...}, reqid, result:'succ', rev, req }
 *   stor.*    → 直接顶层字段（无 data 包裹），如 { fssizeStor, frsizeStor, ... }
 *   dockermgr → { rsp: ... }（imageList/networkList 为数组，stats 为按容器键的对象）
 * =======================================================================*/
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}
function pickNum(obj, keys) {
  return toNum(pick(obj, keys));
}
/** 依次尝试 data / rsp 包裹，取出真正的载荷 */
function unwrap(resp) {
  if (!resp || typeof resp !== 'object') return resp;
  if (resp.data && typeof resp.data === 'object') return resp.data;
  if (resp.rsp !== undefined) return resp.rsp;
  return resp;
}
/** 取数组型载荷（自动穿透 data / rsp 包裹） */
function pickArray(resp, keys) {
  const cands = [resp, resp && resp.data, resp && resp.rsp];
  for (const c of cands) {
    if (Array.isArray(c)) return c;
    if (c && typeof c === 'object') {
      for (const k of keys) if (Array.isArray(c[k])) return c[k];
    }
  }
  return [];
}

/* =========================================================================
 * FnClient —— 一条 WebSocket 长连接上的 fnOS 会话
 * =======================================================================*/
class FnClient {
  constructor(base, cfg) {
    this.base = base;
    this.cfg = cfg || {};
    this.url = wsEndpoint(base);
    this.timeout = toNum(this.cfg.timeout) || 10000;

    this.conn = null;
    this.connecting = null;
    this.loggedIn = false;
    this.lastError = null;

    // 握手/登录状态
    this.pub = null;
    this.si = null;
    this.lastKey = null;   // 最近一次加密请求使用的 AES key
    this.lastIv = null;
    this.signKey = null;
    this.token = null;
    this.backId = '0000000000000000';
    this.uid = null;
    this.admin = null;
    this.did = makeDid();

    this.pending = new Map();   // reqid -> { resolve, reject, timer }
    this.seq = 1;
    this.heartbeat = null;
  }

  /* ---- 生命周期 ---- */

  /** 确保已连接且已登录（并发调用会复用同一次连接） */
  async ensure() {
    if (this.conn && !this.conn.closed && this.loggedIn) return;
    if (this.connecting) return this.connecting;
    this.connecting = this._open().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async _open() {
    this._teardown();
    const allowSelfSigned = this.cfg.allowSelfSigned !== false;
    this.conn = await connect(this.url, { allowSelfSigned, timeout: this.timeout });
    this.conn.on('message', (msg) => this._onMessage(msg));
    this.conn.on('close', () => this._onClosed());
    this.conn.on('error', (e) => { this.lastError = e; this._failAll(e); });
    await this._login();
  }

  _teardown() {
    this._stopHeartbeat();
    if (this.conn) {
      try { this.conn.removeAllListeners(); } catch (_) { /* ignore */ }
      try { this.conn.close(); } catch (_) { /* ignore */ }
      this.conn = null;
    }
    this.loggedIn = false;
  }

  _onClosed() {
    this.loggedIn = false;
    this._stopHeartbeat();
    this._failAll(new Error('连接已断开'));
  }

  _failAll(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err instanceof Error ? err : new Error(String(err)));
    }
    this.pending.clear();
  }

  close() {
    this._teardown();
  }

  /* ---- 心跳 ---- */

  _startHeartbeat() {
    this._stopHeartbeat();
    const tick = () => {
      if (!this.conn || this.conn.closed) return;
      // 应用层心跳；服务端回 {"res":"pong"}（无 reqid，不参与请求匹配）
      try { this.conn.send('{"req":"ping"}'); } catch (_) { /* ignore */ }
    };
    tick();
    this.heartbeat = setInterval(tick, 30000);
    if (this.heartbeat && typeof this.heartbeat.unref === 'function') this.heartbeat.unref();
  }

  _stopHeartbeat() {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
  }

  /* ---- reqid ---- */

  _nextReqid() {
    const t = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
    this.seq = (this.seq + 1) & 0xffff;
    let bid = String(this.backId || '');
    if (bid.length < 16) bid = bid.padEnd(16, '0');
    if (bid.length > 16) bid = bid.slice(0, 16);
    return t + bid + this.seq.toString(16).padStart(4, '0');
  }

  /* ---- 收发 ---- */

  _send(raw, reqid) {
    return new Promise((resolve, reject) => {
      if (!this.conn || this.conn.closed) { reject(new Error('连接已断开')); return; }
      const timer = setTimeout(() => {
        this.pending.delete(reqid);
        reject(new Error('fnOS 请求超时'));
      }, this.timeout);
      this.pending.set(reqid, { resolve, reject, timer });
      const ok = this.conn.send(raw);
      if (!ok) {
        clearTimeout(timer);
        this.pending.delete(reqid);
        reject(new Error('发送失败：连接已关闭'));
      }
    });
  }

  _onMessage(msg) {
    let data;
    try { data = JSON.parse(msg); } catch (_) { return; }
    const reqid = data && data.reqid;
    if (!reqid) return;                       // 心跳 {"res":"pong"} 等无 reqid 的消息
    const p = this.pending.get(reqid);
    if (!p) return;
    this.pending.delete(reqid);
    clearTimeout(p.timer);
    if (data.errno != null && data.result !== 'succ') {
      p.reject(fnosError(data));
    } else {
      p.resolve(data);
    }
  }

  /** 明文请求（业务命令，自动签名） */
  async request(req, params) {
    const reqid = this._nextReqid();
    const data = Object.assign({ reqid, req }, params || {});
    const json = JSON.stringify(data);
    let raw = json;
    if (!NO_SIGN.has(req) && this.signKey) raw = hmacSign(json, this.signKey) + json;
    return this._send(raw, reqid);
  }

  /** 加密请求（登录 / 两步验证） */
  async requestEncrypted(req, params) {
    const reqid = this._nextReqid();
    const data = Object.assign({ reqid, req }, params || {});
    const json = JSON.stringify(data);
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(16);
    this.lastKey = key;      // 解密本次响应里的 secret 时要用同一对 key/iv
    this.lastIv = iv;
    const rsa = rsaEncrypt(key, this.pub);
    const aes = aesEncrypt(json, key, iv);
    const msg = JSON.stringify({ req: 'encrypted', iv: iv.toString('base64'), rsa, aes });
    return this._send(msg, reqid);
  }

  /* ---- 登录 ---- */

  async _login() {
    const { account, passwd } = creds(this.cfg);

    // 1) 取 RSA 公钥
    const r = await this.request(CMD.rsaPub, null);
    this.pub = pick(r, ['pub', 'publicKey', 'public_key', 'key']);
    this.si = pick(r, ['si', 'sessionId', 'session_id']);
    if (!this.pub) throw new Error('fnOS 未返回 RSA 公钥，请确认地址端口');

    // 2) 登录
    const resp = await this.requestEncrypted(CMD.login, {
      user: account,
      password: passwd,
      stay: true,
      deviceType: 'Browser',
      deviceName: 'NasAssistant',
      did: this.did,
      si: this.si,
    });

    // 3) 两步验证
    if (resp && resp.isBindTwofaSecret === true && !resp.token) {
      const otp = String(this.cfg.otpCode || '').trim();
      if (!otp) throw new Error('该账号已开启两步验证，请在设置中填写 6 位验证码');
      if (!/^\d{6}$/.test(otp)) throw new Error('两步验证码必须是 6 位数字');
      const resp2 = await this.requestEncrypted(CMD.twofa, {
        code: otp,
        isTrustedDevice: false,
        accessToken: resp.accessToken,
        stay: 1,
        deviceName: 'NasAssistant',
        deviceType: 'Browser',
        did: this.did,
        si: this.si,
      });
      this._finishLogin(resp2);
      return;
    }

    this._finishLogin(resp);
  }

  _finishLogin(resp) {
    if (!resp || resp.result !== 'succ' || !resp.token) {
      throw fnosError(resp);
    }
    this.token = resp.token;
    if (resp.backId) this.backId = String(resp.backId);
    if (resp.secret) this.signKey = deriveSignKey(resp.secret, this.lastKey, this.lastIv);
    this.uid = resp.uid;
    this.admin = resp.admin;
    this.loggedIn = true;
    this._startHeartbeat();
  }

  /** 业务调用（保证已登录；连接失效时自动重连一次） */
  async call(req, params) {
    await this.ensure();
    try {
      return await this.request(req, params);
    } catch (e) {
      // 会话失效 → 重连一次
      if (e && /凭证已失效|连接已断开|未登录/.test(e.message)) {
        this._teardown();
        await this.ensure();
        return this.request(req, params);
      }
      throw e;
    }
  }

  /** 依次尝试多个候选命令名，返回第一个不报错的响应 */
  async callFirst(candidates, params) {
    let lastErr = null;
    for (const req of candidates) {
      try {
        return await this.call(req, params);
      } catch (e) {
        lastErr = e;
        // 「模块未安装」时无需再试其余候选
        if (e && e.errno === ERRNO_NO_MODULE) break;
      }
    }
    throw lastErr || new Error('所有候选命令均失败');
  }
}

/* =========================================================================
 * 会话缓存（按 base + 账号分桶）
 * =======================================================================*/
const clients = new Map();

function clientKey(base, cfg) {
  return base + '|' + String((cfg && cfg.username) || '');
}

function getClient(base, cfg) {
  const k = clientKey(base, cfg);
  let c = clients.get(k);
  if (!c) {
    c = new FnClient(base, cfg);
    clients.set(k, c);
  } else {
    c.cfg = cfg || c.cfg;         // 凭据/验证码变化时即时生效
  }
  return c;
}

/** 清空会话（配置变更 / 切换服务器时调用） */
function clearCache(base, cfg) {
  let b = base;
  // 走 FN ID 时可能没有手填 url —— 用缓存里的实际端点，避免误清其它服务器的会话
  if (!b && cfg && cfg.fnId) {
    const hit = fnBaseCache.get(fnCacheKey(cfg));
    if (hit && hit.base) b = hit.base;
  }
  if (b) {
    if (cfg) {
      const k = clientKey(b, cfg);
      const c = clients.get(k);
      if (c) { c.close(); clients.delete(k); }
    } else {
      for (const [k, c] of [...clients.entries()]) {
        if (k.indexOf(b + '|') === 0) { c.close(); clients.delete(k); }
      }
    }
  } else {
    for (const [, c] of clients) c.close();
    clients.clear();
  }
  // 同时丢弃 fnConnect 选路结果（地址/网络环境可能已变）
  if (cfg) clearFnBase(String(cfg.fnId || '').trim());
  else clearFnBase('');
}

/* =========================================================================
 * 虚拟机 REST 客户端
 * -------------------------------------------------------------------------
 * 与 WebSocket 会话共用登录 token；不吃 HMAC 签名。
 * =======================================================================*/
/**
 * 是否属于「虚拟机应用未安装」。
 * 该应用的路由不存在时 fnOS 会回落到前端首页（HTML），因此要连 200+HTML 一起判。
 */
function isVmMissing(res) {
  if (!res) return true;
  if (res.status === 404 || res.status === 405 || res.status === 501) return true;
  if (res.status === 200 && !res.json && /<html/i.test(String(res.text || ''))) return true;
  return false;
}

/**
 * 调用虚拟机 REST 接口。
 * @param {string} base  站点根地址（normalizeEndpoint 的结果）
 * @param {object} cfg   服务器配置（复用其凭据与超时）
 * @param {string} pathq 形如 '/domain/list'
 * @param {object} [opts] { method, body }
 * @returns {Promise<any>} 成功时返回响应里的 data
 * @throws {Error} 错误上带标记：vmMissing / vmUnauthorized / vmCode
 */
async function vmFetch(base, cfg, pathq, opts) {
  const o = opts || {};
  const cli = getClient(base, cfg);
  await cli.ensure();

  const url = base + VM_API + pathq;
  const body = o.body != null ? JSON.stringify(o.body) : null;
  const send = (token) => request(url, {
    method: o.method || 'GET',
    headers: token ? { Authorization: token } : {},
    body,
    allowSelfSigned: !(cfg && cfg.allowSelfSigned === false),
    timeout: (cfg && toNum(cfg.timeout)) || 10000,
  });

  let res = await send(cli.token);

  // 会话失效 → 重登一次再试（token 与 WS 会话同源，重登即刷新）
  if (res.status === 401) {
    cli._teardown();
    await cli.ensure();
    res = await send(cli.token);
  }

  if (isVmMissing(res)) {
    const e = new Error('未安装「虚拟机」应用');
    e.vmMissing = true;
    throw e;
  }
  if (res.status === 401) {
    const e = new Error('虚拟机接口鉴权失败，请确认账号具备管理员权限');
    e.vmUnauthorized = true;
    throw e;
  }

  const j = res.json;
  if (!j || typeof j !== 'object') {
    throw new Error('虚拟机接口返回异常 (HTTP ' + res.status + ')');
  }
  if (toNum(j.code) !== 0) {
    const code = toNum(j.code);
    const e = new Error(ERR_VM[code] || (j.msg || ('虚拟机接口返回错误码 ' + code)));
    e.vmCode = code;
    throw e;
  }
  return j.data;
}

/** 把 /domain/status 的返回整理成「按虚拟机内部名索引」的表 */
function vmStatusMap(data) {
  const out = {};
  const arr = Array.isArray(data) ? data
    : (data && Array.isArray(data.list) ? data.list : null);
  if (arr) {
    for (const x of arr) {
      const n = pick(x, ['name', 'vmName']);
      if (n) out[String(n)] = x;
    }
    return out;
  }
  if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object') out[k] = v;
    }
  }
  return out;
}

/* =========================================================================
 * 条目规范化（字段名按真实机实测的 Docker Engine API 风格映射）
 * =======================================================================*/

/** 状态文本 → { label, cls, running, paused } */
function containerState(raw) {
  const s = String(raw || '').toLowerCase();
  if (s === 'running') return { label: '运行中', cls: 'run', running: true, paused: false };
  if (s === 'paused') return { label: '已暂停', cls: 'warn', running: true, paused: true };
  if (s === 'restarting') return { label: '重启中', cls: 'warn', running: true, paused: false };
  if (s === 'created') return { label: '已创建', cls: 'stop', running: false, paused: false };
  if (s === 'exited' || s === 'dead') return { label: '已停止', cls: 'stop', running: false, paused: false };
  return { label: raw ? String(raw) : '未知', cls: 'stop', running: false, paused: false };
}

/** docker ps 名称形如 "/name"，去掉前导斜杠 */
function stripSlash(s) {
  return String(s == null ? '' : s).replace(/^\/+/, '');
}

/**
 * 容器条目规范化（Docker Engine API 风格）
 * 实测可能来源：containerList 返回的容器对象 + dockermgr.stats 的按容器键统计
 */
function normContainer(c, idx, stat) {
  const names = pick(c, ['Names', 'names', 'Names0']);
  const name = stripSlash(Array.isArray(names) ? (names[0] || '') : (names || pick(c, ['Name', 'name', 'containerName']) || ''));
  const rawId = pick(c, ['Id', 'id', 'ID', 'containerId']);
  const id = String(rawId || name || ('c' + idx));
  const st = containerState(pick(c, ['State', 'state', 'status']));

  const s = stat && typeof stat === 'object' ? stat : {};
  const cpu = toNum(pick(s, ['cpuUsage', 'cpu']));
  const memBytes = toNum(pick(s, ['usedMem', 'memUsage']));
  const rx = toNum(pick(s, ['networkRx', 'rx']));
  const tx = toNum(pick(s, ['networkTx', 'tx']));

  const statusRaw = pick(c, ['Status', 'status']);
  return {
    id,
    name: name || (id ? String(id).slice(0, 12) : '(未命名)'),
    image: pick(c, ['Image', 'image', 'imageName']) || null,
    initial: String(name || '?').charAt(0).toUpperCase() || '?',
    icon: null,
    state: String(pick(c, ['State', 'state']) || '').toUpperCase(),
    stateLabel: st.label,
    cls: st.cls,
    running: st.running,
    paused: st.paused,
    // 展开面板明细
    status: st.label,
    upText: typeof statusRaw === 'string' ? statusRaw : null,
    cmd: pick(c, ['Command', 'command', 'cmd']) || null,
    created: toNum(pick(c, ['Created', 'created'])),
    createdText: fmtDate(toNum(pick(c, ['Created', 'created']))),
    autoStart: null,
    cpuText: cpu != null ? cpu.toFixed(1) + '%' : null,
    memText: memBytes != null ? fmtSize(memBytes) : null,
    rxText: rx != null ? fmtRate(rx) : null,
    txText: tx != null ? fmtRate(tx) : null,
  };
}

/** 每轮快照最多为多少台虚拟机遇补 /domain/info 详情（避免轮询压力） */
const VM_INFO_MAX = 8;

/**
 * 虚拟机条目规范化（字段取自 /vm/api/v1/domain/list + domain/status，实测）
 *   list 项：{ name(内部名), uuid, title(展示名), desc, state,
 *              osType, osVersion, totalDisksCapacityInBytes, clipboard }
 *   status 项：{ name, state, monitor: { cpu, memory, networks:[{rxBytes,txBytes}] } }
 *   info 项：{ cpuCoreCnt, memCapacityInBytes, disks[], networks[], autostart,
 *              hypervisor, firmware, chipset, videoType, osType, osVersion … }
 * 注意：列表里的 name 是内部标识（如 'a1b2c3d4'），**title 才是用户看到的名字**；
 * 操作用的是内部 name，故 id 取 name、name 取 title。
 */
function normVm(v, idx, stat, info) {
  const innerName = String(pick(v, ['name']) || '');
  const title = String(pick(v, ['title', 'desc', 'name']) || '');
  const id = innerName || String(pick(v, ['uuid']) || ('vm' + idx));
  const rawState = String(pick(v, ['state', 'status']) || (stat && stat.state) || '').toUpperCase();
  const st = vmState(rawState);

  const mon = (stat && stat.monitor) || {};
  const cpu = toNum(pick(mon, ['cpu']));
  const memUsed = toNum(pick(mon, ['memory', 'mem']));
  let rx = 0;
  let tx = 0;
  const nets = Array.isArray(mon.networks) ? mon.networks : [];
  for (const n of nets) {
    rx += toNum(pick(n, ['rxBytes', 'rx'])) || 0;
    tx += toNum(pick(n, ['txBytes', 'tx'])) || 0;
  }

  const inf = info && typeof info === 'object' ? info : {};
  const memCap = toNum(pick(inf, ['memCapacityInBytes'])) ?? toNum(pick(v, ['memCapacityInBytes']));
  const cores = toNum(pick(inf, ['cpuCoreCnt'])) ?? toNum(pick(v, ['cpuCoreCnt', 'vcpu']));
  // 磁盘容量：列表里的 totalDisksCapacityInBytes **可能是 0**（实测 Ubuntu-Server 即是），
  // 故优先用 domain/info 的 disks[] 累加值，它更可靠。
  let diskCap = toNum(pick(v, ['totalDisksCapacityInBytes']));
  const disks = Array.isArray(inf.disks) ? inf.disks : [];
  if (disks.length) {
    const sum = disks.reduce((a, x) => a + (toNum(pick(x, ['capacityInBytes', 'capacity'])) || 0), 0);
    if (sum > 0) diskCap = sum;
  }
  const osType = pick(inf, ['osType']) || pick(v, ['osType']);
  const osVer = pick(inf, ['osVersion']) || pick(v, ['osVersion']);
  const autoStart = pick(inf, ['autostart']);

  return {
    id,
    uuid: pick(v, ['uuid']) || pick(inf, ['uuid']) || null,
    name: title || innerName || '(未命名)',
    state: rawState,
    stateLabel: st.label,
    cls: st.cls,
    running: st.running,
    paused: st.paused,
    icon: null,
    initial: String(title || innerName || '?').charAt(0).toUpperCase() || '?',

    // 展开面板明细
    osText: osType ? String(osType) + (osVer ? ' · ' + osVer : '') : null,
    vcpu: cores,
    cpuText: cpu != null ? cpu.toFixed(2) + '%' : null,
    memText: memCap != null ? fmtSize(memCap) : null,
    diskText: diskCap != null ? fmtSize(diskCap) : null,
    usedMemText: memUsed != null ? fmtSize(memUsed) : null,
    rxText: rx ? fmtRate(rx) : null,
    txText: tx ? fmtRate(tx) : null,
    autoStart: autoStart === true ? true : (autoStart === false ? false : null),
    hypervisor: pick(inf, ['hypervisor']) || null,
  };
}

/** 取 IP 字符串（fnOS 的 ipv4 是数组，另有 ipv4Addr 单值） */
function ifaceIp(x) {
  const single = pick(x, ['ipv4Addr', 'ipv4Address', 'ip', 'address']);
  if (single) return String(single);
  const arr = pick(x, ['ipv4']);
  if (Array.isArray(arr) && arr.length) return String(arr[0]);
  return null;
}

/** 选主网卡：非回环 + 已启用/运行 + 有 IPv4 优先 */
function pickNetwork(nlist) {
  if (!Array.isArray(nlist) || !nlist.length) return null;
  const nameOf = (x) => String(pick(x, ['name', 'iface', 'device', 'id']) || '');
  const isLoop = (x) => /^lo\b|^docker|^br-|^veth|^virbr/i.test(nameOf(x)) || /^127\./.test(ifaceIp(x) || '');
  const up = (x) => pick(x, ['running', 'enable']) !== false;
  const scored = nlist
    .map((x) => {
      let s = 0;
      if (!isLoop(x)) s += 8;
      if (up(x)) s += 4;
      if (ifaceIp(x)) s += 3;
      if (pick(x, ['wireless']) === false) s += 2;   // 有线优先
      if (!pick(x, ['virtual'])) s += 1;
      if (isLoop(x)) s -= 20;
      return { x, s };
    })
    .sort((a, b) => b.s - a.s);
  return scored.length ? scored[0].x : null;
}

/** 按运行状态排序：运行中在前 */
function sortItems(list) {
  const rank = (s) => (s.status === 'running' || s.running ? 0 : s.paused ? 1 : 2);
  return list.slice().sort((a, b) => {
    const d = rank(a) - rank(b);
    return d !== 0 ? d : String(a.name).localeCompare(String(b.name));
  });
}

/* =========================================================================
 * 快照
 * =======================================================================*/
async function fetchSnapshot(cfg) {
  let route;
  try {
    route = await getBase(cfg);
  } catch (e) {
    const snap = makeSnapshot('fnos', String((cfg && cfg.fnId) || (cfg && cfg.url) || ''));
    snap.error = e.message || String(e);
    return snap;
  }
  const base = route.base;
  const snap = makeSnapshot('fnos', displayHost(base));
  snap.route = { kind: route.kind, label: route.label, endpoint: base };
  const cli = getClient(base, cfg);

  try {
    await cli.ensure();
  } catch (e) {
    // 连接失败 → 丢掉本次选路结果，下一轮重新解析（可能已换网络环境）
    clearFnBase(String((cfg && cfg.fnId) || '').trim());
    snap.error = e.message || String(e);
    return snap;
  }

  const safe = (req, params, candidates) => {
    const list = candidates || [req];
    return cli.callFirst(list, params).catch(() => null);
  };

  const [hostName, trimVer, hardware, uptime, cpu, mem, gen, netList, storeCalc, storeGen] =
    await Promise.all([
      safe(CMD.hostName),
      safe(CMD.trimVersion),
      safe(CMD.hardware),
      safe(CMD.uptime),
      safe(CMD.cpu),
      safe(CMD.mem),
      safe(CMD.resmonGen, { item: ['storeSpeed', 'netSpeed', 'cpuBusy', 'memPercent'] }),
      safe(CMD.networkList, { type: 0 }),
      safe(CMD.storeCalc),
      safe(CMD.storeGeneral),
    ]);

  /* ---- 主机 ---- */
  const hn = unwrap(hostName) || {};
  snap.server.name = pick(hn, ['hostName', 'hostname', 'name', 'host']) || null;

  const tv = unwrap(trimVer) || {};
  snap.server.version = cleanVersion(pick(tv, ['trimVersion', 'version', 'osVersion', 'ver']));
  snap.server.versionPrefix = 'fnOS';
  const edition = pick(tv, ['edition']);
  snap.server.distro = edition ? 'fnOS · ' + edition : 'fnOS';

  const hw = unwrap(hardware) || {};
  const cpuHw = hw.cpu || {};
  snap.cpu.brand = pick(cpuHw, ['name', 'model', 'brand']) || null;
  const cpuNum = toNum(pick(cpuHw, ['num'])) || 1;
  const coresPer = toNum(pick(cpuHw, ['core']));
  const threadsPer = toNum(pick(cpuHw, ['thread']));
  if (coresPer != null) snap.cpu.cores = coresPer * cpuNum;
  if (threadsPer != null) snap.cpu.threads = threadsPer * cpuNum;

  const bios = hw.bios || {};
  const bb = bios.baseboard || {};
  const sysInfo = bios.system || {};
  snap.board =
    pick(bb, ['productName', 'vendor', 'model']) ||
    pick(sysInfo, ['productName', 'vendor']) ||
    null;

  // 注意 hw.vm = {available, iommu, sriov} 描述的是**本机硬件虚拟化能力**
  // （VT-x / VT-d / SR-IOV），**与「虚拟机应用是否安装」无关**：
  // 本机 fnOS 自身跑在 QEMU 里且未开嵌套虚拟化 ⇒ available=0，但虚拟机应用照装照用。
  // 判断「应用是否安装」请看 /vm/api/v1 是否可达（见下方 vms 区块）。

  const up = unwrap(uptime) || {};
  let upSec = pickNum(up, ['uptime', 'upTime', 'seconds', 'up']);
  if (upSec != null && upSec > 1e11) upSec = Math.floor(upSec / 1000);
  snap.server.uptimeText = upSec != null ? fmtUptime(upSec * 1000) : '—';

  /* ---- CPU ---- */
  const genItem = (unwrap(gen) || {}).item || {};
  const c = unwrap(cpu) || {};
  const cc = c.cpu || c;
  const busy = cc.busy && typeof cc.busy === 'object' ? cc.busy : null;
  snap.cpu.pct = clampPct(
    pickNum(genItem, ['cpuBusy']) != null
      ? pickNum(genItem, ['cpuBusy'])
      : (busy ? toNum(busy.all) : toNum(cc.busy))
  );
  if (snap.cpu.pct == null) snap.cpu.pct = clampPct(pickNum(cc, ['percent', 'usage']));

  const tempArr = pick(cc, ['temp']);
  const t0 = Array.isArray(tempArr) ? toNum(tempArr[0]) : toNum(tempArr);
  snap.temp = t0 != null && t0 > 0 ? t0 : null;

  const freq = pickNum(cc, ['maxFreq', 'freq', 'speed', 'frequency']);
  if (freq != null && freq > 0) {
    snap.cpu.speedGhz = freq > 1000 ? +(freq / 1000).toFixed(2) : +freq.toFixed(2);
  }
  if (snap.cpu.brand) {
    const nth = snap.cpu.threads || snap.cpu.cores;
    snap.cpu.label = nth ? snap.cpu.brand + ' · ' + nth + ' 线程' : snap.cpu.brand;
  } else if (snap.cpu.threads || snap.cpu.cores) {
    snap.cpu.label = (snap.cpu.threads || snap.cpu.cores) + ' 线程';
  }

  /* ---- 内存（fnOS 返回**字节**） ---- */
  const m = unwrap(mem) || {};
  const memObj = m.mem || m;
  const memTotal = pickNum(memObj, ['total', 'totalSize']);
  const memUsed = pickNum(memObj, ['used', 'usedSize']);
  if (memTotal != null) {
    snap.ram.totalBytes = memTotal;
    if (memUsed != null) snap.ram.usedBytes = memUsed;
    const gp = pickNum(genItem, ['memPercent']);
    snap.ram.pct = gp != null ? clampPct(gp)
      : (memUsed != null && memTotal ? clampPct(memUsed / memTotal * 100) : null);
    snap.ram.totalText = fmtSize(memTotal);
    snap.ram.usedText = memUsed != null ? fmtSize(memUsed) : '—';
  }

  /* ---- 网络 ---- */
  const gnet = genItem.netSpeed || {};
  snap.net.rx = pickNum(gnet, ['receive', 'rx', 'in']);
  snap.net.tx = pickNum(gnet, ['transmit', 'tx', 'out']);
  if (snap.net.rx == null || snap.net.tx == null) {
    const rn = unwrap(await safe(CMD.net)) || {};
    const ifs = Array.isArray(rn.ifs) ? rn.ifs : [];
    const pick1 = ifs.find((x) => /en|eth/i.test(String(pick(x, ['name']) || ''))) || ifs[0];
    if (pick1) {
      if (snap.net.rx == null) snap.net.rx = pickNum(pick1, ['receive', 'rx']);
      if (snap.net.tx == null) snap.net.tx = pickNum(pick1, ['transmit', 'tx']);
    }
  }
  snap.net.rxText = fmtRate(snap.net.rx);
  snap.net.txText = fmtRate(snap.net.tx);

  const nl = unwrap(netList) || {};
  const nlist = (nl.net && Array.isArray(nl.net.ifs)) ? nl.net.ifs
    : (Array.isArray(nl.ifs) ? nl.ifs : pickArray(netList, ['ifs', 'list', 'nics', 'interfaces']));
  const nif = pickNetwork(nlist);
  if (nif) {
    snap.net.iface = pick(nif, ['name', 'iface', 'device']) || null;
    snap.ip = ifaceIp(nif);
    const sp = pickNum(nif, ['speed']);
    // 65535 是 fnOS 在拿不到链路速率时返回的哨兵值（如 virtio 网卡）
    if (sp != null && sp > 0 && sp !== 65535) {
      snap.net.linkMbps = sp;
      snap.net.speedText = fmtLink(sp);
    }
  }

  /* ---- 存储（stor.calcSpace，**字节**） ---- */
  const sc = unwrap(storeCalc) || {};
  let diskTotal = pickNum(sc, ['fssizeStor', 'total', 'totalSize']);
  let diskFree = pickNum(sc, ['frsizeStor', 'free', 'freeSize']);
  if (diskTotal == null) {
    // 兜底：累加 stor.general.array[]
    const sg = unwrap(storeGen) || {};
    const arr = Array.isArray(sg.array) ? sg.array : [];
    if (arr.length) {
      diskTotal = arr.reduce((a, x) => a + (toNum(pick(x, ['fssize'])) || 0), 0);
      diskFree = arr.reduce((a, x) => a + (toNum(pick(x, ['frsize'])) || 0), 0);
    }
  }
  if (diskTotal != null) {
    const used = diskFree != null ? Math.max(0, diskTotal - diskFree) : null;
    snap.disk.totalText = fmtSize(diskTotal);
    if (diskFree != null) snap.disk.freeText = fmtSize(diskFree);
    if (used != null) snap.disk.usedText = fmtSize(used);
    snap.disk.pct = used != null && diskTotal ? clampPct(used / diskTotal * 100) : null;
  }

  /* ---- Docker 容器 ---- */
  snap.docker.label = META.containerLabel;
  try {
    const [dc, ds] = await Promise.all([
      cli.call(CMD.dockerList, { all: true }),
      cli.call(CMD.dockerStats).catch(() => null),
    ]);
    const statsMap = ds ? (unwrap(ds) || {}) : {};
    const list = pickArray(dc, ['containers', 'list', 'items']);
    // stats 的键既可能是容器名也可能是容器 ID（实测 fnOS 用「名」作键）
    const statOf = (x) => {
      const cid = String(pick(x, ['Id', 'id', 'ID']) || '');
      const names = pick(x, ['Names', 'names']);
      const nm = stripSlash(Array.isArray(names) ? names[0] : names);
      for (const k of [nm, cid, '/' + nm]) {
        if (k && statsMap[k]) return statsMap[k];
      }
      return null;
    };
    snap.docker.items = sortItems(list.map((x, i) => normContainer(x, i, statOf(x))));
    snap.docker.ok = true;
  } catch (e) {
    snap.docker.ok = false;
    snap.docker.error = e.message;
    if (e && e.errno === ERRNO_NO_MODULE) {
      snap.docker.notInstalled = true;
      snap.docker.hint = '请在飞牛应用中心安装「Docker」应用后重试';
    }
  }

  /* ---- 虚拟机（走 /vm/api/v1 REST，与 WS RPC 无关） ---- */
  snap.vms.label = META.guestLabel;
  try {
    const [vmList, vmStat] = await Promise.all([
      vmFetch(base, cfg, VM_GET.list),
      vmFetch(base, cfg, VM_GET.status).catch(() => null),
    ]);
    const list = Array.isArray(vmList) ? vmList
      : pickArray(vmList, ['list', 'vms', 'guests', 'items']);
    const statOf = vmStatusMap(vmStat);

    // /domain/list 不含核心数/内存容量，需逐台补 /domain/info。
    // 为避免轮询压力，仅在数量不多时补齐（超过则只显示列表可得的信息）。
    let infos = [];
    if (list.length && list.length <= VM_INFO_MAX) {
      infos = await Promise.all(
        list.map((x) => {
          const n = String(pick(x, ['name']) || '');
          if (!n) return null;
          return vmFetch(base, cfg, VM_GET.info + '?name=' + encodeURIComponent(n)).catch(() => null);
        })
      );
    }

    snap.vms.items = sortItems(
      list.map((x, i) => normVm(x, i, statOf[String(pick(x, ['name']) || '')], infos[i]))
    );
    snap.vms.ok = true;
  } catch (e) {
    snap.vms.ok = false;
    snap.vms.error = e.message;
    if (e && (e.vmMissing || e.vmUnauthorized)) {
      snap.vms.notInstalled = true;
      snap.vms.error = '本机未启用虚拟机功能';
      snap.vms.hint = '请在飞牛应用中心安装「虚拟机」应用后重试';
    }
  }

  snap.ok = true;
  return snap;
}

/* =========================================================================
 * 容器 / 虚拟机操作
 * =======================================================================*/

/**
 * 由 UI 传来的标识反查「另一种写法」。
 * UI 里的 id 可能是容器名（Docker Names）也可能是容器 ID（Id 64 位十六进制），
 * 而服务端只认其中一种；这里取容器列表把两种写法都试一遍。
 */
async function altRef(cli, ref) {
  try {
    const dc = await cli.call(CMD.dockerList, { all: true });
    const list = pickArray(dc, ['containers', 'list', 'items']);
    for (const c of list) {
      const names = pick(c, ['Names', 'names']);
      const nm = stripSlash(Array.isArray(names) ? names[0] : names);
      const cid = String(pick(c, ['Id', 'id', 'ID']) || '');
      if (cid === ref && nm && nm !== ref) return nm;
      if (nm === ref && cid && cid !== ref) return cid;
    }
  } catch (_) { /* ignore */ }
  return null;
}

async function containerAction(cfg, id, action) {
  const base = (await getBase(cfg)).base;
  const cli = getClient(base, cfg);
  const cmd = DOCKER_ACTION_CMD[action];
  if (!cmd) throw new Error('不支持的操作: ' + action);

  const first = String(id);
  const cands = [first];
  const alt = await altRef(cli, first);
  if (alt && alt !== first) cands.push(alt);

  let lastErr = null;
  for (const ref of cands) {
    try {
      await cli.call(cmd, { containerId: ref });
      return true;
    } catch (e) {
      lastErr = e;
      // 「找不到容器」→ 换另一种标识再试；其余错误（含状态不允许）直接抛出
      if (e && e.errno === ERRNO_NO_CONTAINER) continue;
      throw e;
    }
  }
  throw lastErr || new Error('容器操作失败');
}

/**
 * 虚拟机操作 —— 走 /vm/api/v1 REST（参数 { name: <内部名> }）。
 * UI 动作名 → REST 端点见 VM_ACTION_API：
 *   start / stop(shutdown) / forceStop(forceshutdown) / restart(reboot) / pause / resume
 */
async function guestAction(cfg, id, action) {
  const base = (await getBase(cfg)).base;
  const api = VM_ACTION_API[action];
  if (!api) throw new Error('不支持的操作: ' + action);
  try {
    await vmFetch(base, cfg, api.path, { method: api.method, body: { name: String(id) } });
    return true;
  } catch (e) {
    if (e && e.vmMissing) {
      throw new Error('本机未安装「虚拟机」应用，无法操作虚拟机');
    }
    if (e && e.vmCode === 12021) {
      throw new Error('找不到指定虚拟机');
    }
    throw e;
  }
}

/* =========================================================================
 * 连接测试
 * =======================================================================*/
async function testConnection(cfg) {
  let route;
  try {
    route = await getBase(cfg, { force: !!(cfg && cfg.fnId) });
  } catch (e) {
    return {
      ok: false,
      endpoint: String((cfg && cfg.fnId) || (cfg && cfg.url) || ''),
      fnId: (cfg && cfg.fnId) || null,
      error: e.message || String(e),
    };
  }
  const base = route.base;
  const cli = getClient(base, cfg);
  try {
    cli._teardown();
    await cli.ensure();
    const hn = unwrap(await cli.call(CMD.hostName).catch(() => null)) || {};
    const tv = unwrap(await cli.call(CMD.trimVersion).catch(() => null)) || {};
    return {
      ok: true,
      endpoint: base,
      route: route.label,
      routeKind: route.kind,
      fnId: route.res ? route.res.fnId : ((cfg && cfg.fnId) || null),
      hostname: pick(hn, ['hostName', 'hostname', 'name', 'host']) || null,
      version: cleanVersion(pick(tv, ['trimVersion', 'version', 'osVersion'])) || null,
    };
  } catch (e) {
    clearCache(base, cfg);
    clearFnBase(String((cfg && cfg.fnId) || '').trim());
    return { ok: false, endpoint: base, route: route.label, fnId: (cfg && cfg.fnId) || null, error: e.message || String(e) };
  }
}

module.exports = {
  kind: 'fnos',
  label: META.label,
  normalizeUrl: normalizeEndpoint,
  normalizeEndpoint,
  displayHost,
  fetchSnapshot,
  containerAction,
  guestAction,
  testConnection,
  clearCache,

  /* 向后兼容别名 */
  dockerAction: containerAction,
  vmAction: guestAction,
  clearProbeCache: clearCache,

  /* 测试辅助 */
  FnClient,
  CMD,
  DOCKER_ACTION_CMD,
  VM_API,
  VM_GET,
  VM_ACTION_API,
  ERR,
  ERR_VM,
  VM_STATE,
  ERRNO_NO_MODULE,
  ERRNO_NO_CONTAINER,
  errText,
  fnosError,
  wsEndpoint,

  /* fnConnect（FN ID 地址发现） */
  FN_CONNECT,
  FN_ERR,
  resolveFnId,
  getBase,
  buildCandidates,
  probeBase,
  fnAuthHeader,
  clearFnBase,
  fnOrigin,
  aesEncrypt,
  aesDecryptBytes,
  rsaEncrypt,
  hmacSign,
  deriveSignKey,
  unwrap,
  pickArray,
  normContainer,
  normVm,
  vmState,
  vmFetch,
  vmStatusMap,
  pickNetwork,
};
