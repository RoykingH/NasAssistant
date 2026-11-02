'use strict';
/**
 * fnOS 真实环境只读探测脚本
 * ============================================================================
 * 用途：
 *   1. 验证握手 / 登录 / 签名全链路
 *   2. dump 各数据命令的真实返回（用于校正 src/fnos.js 的字段映射）
 *   3. 探测容器操作的真实 API 名
 *   4. 探测**虚拟机 REST API**（/vm/api/v1）—— 虚拟机不在 WebSocket RPC 里
 *
 * ⚠️ 安全约束：**只读**。所有操作类命令一律用不存在的目标（BOGUS）调用，
 *    目的是区分「端点/命令不存在」与「存在但目标不存在」，
 *    不会对真实容器 / 虚拟机产生任何状态变更。
 *
 * 用法：
 *   node tools/probe-fnos.js http://192.168.1.40:5666 demo-nas <密码> [--full]
 *   PROBE_URL=... PROBE_USER=... PROBE_PASS=... node tools/probe-fnos.js
 * ============================================================================
 */
const fs = require('fs');
const path = require('path');
const fnos = require('../src/fnos');
const { request } = require('../src/http');

const argv = process.argv.slice(2);
const FULL = argv.includes('--full');
const pos = argv.filter((a) => !a.startsWith('--'));

const URL_ = process.env.PROBE_URL || pos[0];
const USER = process.env.PROBE_USER || pos[1];
const PASS = process.env.PROBE_PASS || pos[2];

if (!URL_ || !USER || !PASS) {
  console.error('用法: node tools/probe-fnos.js <http://host:5666> <账号> <密码> [--full]');
  process.exit(1);
}

const BOGUS = '__probe_nonexistent_target__';

/** 打印用的裁剪（避免刷屏；--full 时不裁） */
function brief(v, depth = 0) {
  if (v == null) return v;
  if (typeof v === 'string') return v.length > 160 ? v.slice(0, 160) + '…(' + v.length + '字)' : v;
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    const head = v.slice(0, FULL ? v.length : 1).map((x) => brief(x, depth + 1));
    return depth > 2 ? `[Array(${v.length})]` : head;
  }
  if (depth > 2) return '{…}';
  const out = {};
  for (const k of Object.keys(v)) out[k] = brief(v[k], depth + 1);
  return out;
}

function j(v, maxLen = 4000) {
  let s;
  try { s = JSON.stringify(v, null, 2); } catch (_) { s = String(v); }
  if (!FULL && s && s.length > maxLen) s = s.slice(0, maxLen) + '\n…(截断，加 --full 看全量)';
  return s;
}

function hr(title) {
  console.log('\n' + '='.repeat(72) + '\n' + title + '\n' + '='.repeat(72));
}

/* ------------------------------------------------------------------ */
/* 命令清单                                                            */
/* ------------------------------------------------------------------ */

/** ① 数据命令：参考实现里已确证的 */
const DATA_CMDS = [
  // 系统
  ['appcgi.sysinfo.getHostName', null],
  ['appcgi.sysinfo.getTrimVersion', null],
  ['appcgi.sysinfo.getHardwareInfo', null],
  ['appcgi.sysinfo.getUptime', null],
  ['appcgi.sysinfo.getMachineId', null],
  ['appcgi.sysinfo.getReservedPartition', null],
  // 资源监控
  ['appcgi.resmon.cpu', null],
  ['appcgi.resmon.mem', null],
  ['appcgi.resmon.net', null],
  ['appcgi.resmon.disk', null],
  ['appcgi.resmon.gen', { item: ['storeSpeed', 'netSpeed', 'cpuBusy', 'memPercent'] }],
  ['appcgi.resmon.sysFan', null],
  ['appcgi.resmon.gpu', null],
  // 存储
  ['stor.general', null],
  ['stor.calcSpace', null],
  ['stor.listDisk', { noHotSpare: true }],
  // 网络
  ['appcgi.network.net.list', { type: 0 }],
  ['appcgi.network.net.getMultiGWStatus', null],
  ['appcgi.network.gw.getting', null],
  // Docker
  ['appcgi.dockermgr.containerList', { all: true }],
  ['appcgi.dockermgr.stats', null],
  ['appcgi.dockermgr.composeList', null],
  ['appcgi.dockermgr.systemSettingGet', null],
];

/**
 * ③ 虚拟机 —— **不在 WebSocket RPC 里**。
 * 实测真机 appcgi.vmm/virt/vm/virtual 全部返回 errno 266240（命名空间不存在），
 * 那是「找错地方」而不是「没装」：虚拟机是可选应用（trim.vm），
 * 有独立的 REST 服务挂在 HTTP 的 /vm/api/v1。
 * 这里两条都测：先确认 WS 上确实没有，再 dump REST 的真实返回。
 */
const VM_WS_PROBE = [
  'appcgi.vmm.list',
  'appcgi.vmm.vmList',
  'appcgi.vm.list',
  'appcgi.virt.list',
  'appcgi.vmm.vmStart',
];

/** ④ 虚拟机 REST 只读端点 */
const VM_REST_GET = [
  '/domain/list',
  '/domain/status',
  '/domain/availableTitle',
  '/system/hardwareInfo',
  '/system/allVolsInfo',
  '/ovs/isInited',
  '/ovs/listDetail',
  '/hostdev/support',
  '/hostdev/isSigned',
  '/hostdev/isHostdevEnabled',
  '/snapshot/list',
];

/** 操作端点候选（用不存在的目标试，只看端点是否存在 —— 无副作用） */
const VM_REST_ACTIONS = [
  '/domain/start', '/domain/shutdown', '/domain/forceshutdown',
  '/domain/reboot', '/domain/pause', '/domain/resume',
];

/**
 * ③ 容器操作命令（实测命令名 + 实测参数名 containerId）
 * 判据：返回 52428814（找不到目标）= 命令存在；100000004 = 方法不存在。
 */
const DOCKER_ACTION_CANDIDATES = [
  ['appcgi.dockermgr.containerStart', { containerId: BOGUS }],
  ['appcgi.dockermgr.containerStop', { containerId: BOGUS }],
  ['appcgi.dockermgr.containerRestart', { containerId: BOGUS }],
  ['appcgi.dockermgr.containerKill', { containerId: BOGUS }],
  ['appcgi.dockermgr.containerStart', { name: BOGUS }],
  ['appcgi.dockermgr.containerStart', { id: BOGUS }],
];

/** ⑤ 错误码语义基准：确定无疑不存在的命令 / 存在但参数非法的命令 */
const ERRNO_BASELINE = [
  ['appcgi.dockermgr.zzBogusMethodXyz', {}, '不存在的命令(基准:方法未找到)'],
  ['appcgi.zzz.zzz.zzz', {}, '不存在的命名空间'],
  ['appcgi.vmm.zzBogusXyz', {}, '不存在的 vmm 命令'],
  ['appcgi.network.net.info', {}, '真实命令但缺 ifName(基准:参数非法)'],
  ['stor.diskSmart', {}, '真实命令但缺 disk'],
  ['appcgi.dockermgr.containerList', { all: 'notabool' }, '真实命令但参数类型错'],
];

/** ⑥ Docker 容器操作命令二次探测（更贴合的命名 + 多种参数形状） */
const DOCKER_ACTION_ROUND2 = [
  ['appcgi.dockermgr.containerStart', { name: BOGUS }],
  ['appcgi.dockermgr.containerStart', { id: BOGUS }],
  ['appcgi.dockermgr.containerStart', { containerName: BOGUS }],
  ['appcgi.dockermgr.containerStop', { name: BOGUS }],
  ['appcgi.dockermgr.containerRestart', { name: BOGUS }],
  ['appcgi.dockermgr.containerPause', { name: BOGUS }],
  ['appcgi.dockermgr.containerRemove', { name: BOGUS }],
  ['appcgi.dockermgr.containerAction', { do: 'start', name: BOGUS }],
  ['appcgi.dockermgr.containerAction', { op: 'start', name: BOGUS }],
  ['appcgi.dockermgr.containerAction', { act: 'start', name: BOGUS }],
  ['appcgi.dockermgr.op', { action: 'start', name: BOGUS }],
  ['appcgi.dockermgr.operate', { action: 'start', name: BOGUS }],
];

/** ⑦ 命令发现类接口探测 */
const DISCOVERY_CANDIDATES = [
  'util.getApiList',
  'util.methodList',
  'util.getMethods',
  'util.getSI',
  'appcgi.methodList',
  'appcgi.apiList',
  'system.methodList',
  'req.methodList',
  'appcgi.dockermgr.methodList',
];

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

(async () => {
  const t0 = Date.now();
  const base = fnos.normalizeEndpoint(URL_);
  console.log('探测目标 :', base);
  console.log('WebSocket:', fnos.wsEndpoint(base));
  console.log('账号     :', USER, ' 密码长度:', String(PASS).length);

  const cfg = {
    url: base,
    username: USER,
    password: PASS,
    allowSelfSigned: true,
    timeout: 12000,
  };

  const cli = new (fnos.FnClient)(base, cfg);

  // 抓取所有入站原始消息（用于看清错误响应里到底有什么字段）
  const rawIn = [];
  const origOnMessage = cli._onMessage.bind(cli);
  cli._onMessage = (msg) => {
    rawIn.push(msg);
    return origOnMessage(msg);
  };
  const rawSince = (n) => rawIn.slice(n);

  const report = { base, startedAt: new Date().toISOString() };

  /* --- 1. 握手 + 登录 --- */
  hr('① 连接 / 登录');
  try {
    await cli.ensure();
    console.log('✔ 已连接并登录');
    console.log('  uid   :', cli.uid);
    console.log('  admin :', cli.admin);
    console.log('  backId:', cli.backId);
    console.log('  si    :', cli.si);
    console.log('  token :', cli.token ? String(cli.token).slice(0, 12) + '…' : '(无)');
    console.log('  signKey 长度 :', cli.signKey ? Buffer.from(cli.signKey, 'base64').length + ' 字节' : '(无)');
    console.log('  RSA 公钥     :', cli.pub ? String(cli.pub).split('\n')[0] : '(无)');
    report.login = {
      ok: true, uid: cli.uid, admin: cli.admin, backId: cli.backId, si: cli.si,
      hasSignKey: !!cli.signKey, signKeyBytes: cli.signKey ? Buffer.from(cli.signKey, 'base64').length : 0,
    };
  } catch (e) {
    console.log('✘ 登录失败:', e.message);
    report.login = { ok: false, error: e.message };
    fs.writeFileSync(path.join(__dirname, '..', '.smoke', 'probe-fnos.json'), JSON.stringify(report, null, 2));
    process.exit(2);
  }

  /* --- 2. 数据命令 dump --- */
  hr('② 数据命令真实返回');
  const probe = async (req, params) => {
    const t = Date.now();
    const mark = rawIn.length;
    try {
      const r = await cli.call(req, params || undefined);
      return { req, ok: true, ms: Date.now() - t, resp: r, errno: null };
    } catch (e) {
      const errs = rawSince(mark).filter((m) => m && m.errno != null);
      // e.errno 由 src/fnos.js 的 fnosError 附带，最可靠；raw 仅作补充
      return {
        req,
        ok: false,
        ms: Date.now() - t,
        error: e.message,
        errno: (e && e.errno != null) ? e.errno : null,
        raw: errs[errs.length - 1] || null,
      };
    }
  };

  const dataResults = [];
  for (const [req, params] of DATA_CMDS) {
    const r = await probe(req, params);
    dataResults.push(r);
    console.log('\n--- ' + req + '  [' + (r.ok ? '✔ ' + r.ms + 'ms' : '✘ ' + r.error) + ']');
    if (r.ok) console.log(j(brief(r.resp)));
  }
  report.data = dataResults;

  /* --- 3. 虚拟机：先证明 WS 上确实没有，再走 REST --- */
  hr('③ 虚拟机 —— WS 上不存在（预期全部 266240）');
  const vmHits = [];
  for (const req of VM_WS_PROBE) {
    const r = await probe(req);
    const errno = r.raw && r.raw.errno != null ? r.raw.errno
      : (r.error && /错误码 (\d+)/.exec(r.error) ? Number(RegExp.$1) : null);
    console.log('  ' + req.padEnd(30) + (r.ok ? '✔ 意外存在！' : '✘ ' + (errno || r.error)));
    if (r.ok) vmHits.push(r);
  }
  report.vmWsProbe = vmHits;
  console.log('  ⇒ 结论：虚拟机**不在 WebSocket RPC 里**，改走 HTTP /vm/api/v1（下一步）');

  /* --- 3b. 虚拟机 REST API dump --- */
  hr('③b 虚拟机 REST API（GET ' + fnos.VM_API + '）');
  const rest = [];
  const vmCli = new (fnos.FnClient)(base, cfg);
  await vmCli.ensure();
  const restCall = async (method, p, body) => request(base + fnos.VM_API + p, {
    method,
    headers: { Authorization: vmCli.token },
    body: body != null ? JSON.stringify(body) : null,
    allowSelfSigned: true,
    timeout: 10000,
  });
  for (const p of VM_REST_GET) {
    let out;
    try {
      const res = await restCall('GET', p);
      const bodyTxt = res.text.length > 900 ? res.text.slice(0, 900) + '…' : res.text;
      out = { path: p, status: res.status, body: bodyTxt };
      console.log('  GET ' + p.padEnd(28) + ' HTTP ' + res.status + '  ' + bodyTxt.slice(0, 260));
    } catch (e) {
      out = { path: p, status: 0, error: e.message };
      console.log('  GET ' + p.padEnd(28) + ' ✘ ' + e.message);
    }
    rest.push(out);
  }

  /* --- 3c. 虚拟机操作端点（目标 = 不存在的名字，无副作用） --- */
  hr('③c 虚拟机操作端点（目标 = ' + BOGUS + '，无副作用）');
  const restAct = [];
  for (const p of VM_REST_ACTIONS) {
    try {
      const res = await restCall('POST', p, { name: BOGUS });
      restAct.push({ path: p, status: res.status, body: res.text.slice(0, 200) });
      console.log('  POST ' + p.padEnd(26) + ' HTTP ' + res.status + '  ' + res.text.slice(0, 140));
    } catch (e) {
      restAct.push({ path: p, status: 0, error: e.message });
      console.log('  POST ' + p.padEnd(26) + ' ✘ ' + e.message);
    }
  }
  report.vmRest = { get: rest, actions: restAct };
  vmCli.close();

  /* --- 4. 容器操作命令探测（只读，用不存在的目标） --- */
  hr('④ 容器操作命令探测（目标 = ' + BOGUS + '，无副作用）');
  const actResults = [];
  for (const [req, params] of DOCKER_ACTION_CANDIDATES) {
    const r = await probe(req, params);
    const errno = (r.errno != null) ? r.errno
      : (r.raw && r.raw.errno != null ? r.raw.errno
        : (r.error && /错误码 (\d+)/.exec(r.error) ? Number(RegExp.$1) : null));
    const exists = errno === 52428814;      // 找不到目标 ⇒ 命令确实存在
    const rec = Object.assign({ errno, exists }, r);
    actResults.push(rec);
    console.log('  ' + (req + ' ' + JSON.stringify(params)).padEnd(60) +
      (r.ok ? '✔ 成功' : '✘ errno=' + errno) + (exists ? '  ← 命令存在（参数名正确）' : ''));
  }
  report.actions = actResults;

  /* --- 5. 错误码语义基准 --- */
  hr('⑤ 错误码语义基准（用来区分「命令不存在」与「参数/目标非法」）');
  const baseline = [];
  for (const [req, params, note] of ERRNO_BASELINE) {
    const r = await probe(req, params);
    baseline.push({ req, note, ...r });
    const raw = r.raw ? ' errno=' + r.raw.errno + (r.raw.errmsg ? ' msg=' + JSON.stringify(r.raw.errmsg) : '') : '';
    console.log('  ' + req.padEnd(38) + (r.ok ? '✔ 成功' : '✘ ' + r.error + raw) + '   ← ' + note);
    if (r.ok) console.log('     ' + j(brief(r.resp), 500));
  }
  report.errnoBaseline = baseline;

  /* --- 6. Docker 操作命令二次探测 --- */
  hr('⑥ Docker 容器操作命令二次探测');
  const r2 = [];
  for (const [req, params] of DOCKER_ACTION_ROUND2) {
    const r = await probe(req, params);
    r2.push(r);
    const raw = r.raw ? ' errno=' + r.raw.errno : '';
    console.log('  ' + (req + ' ' + JSON.stringify(params)).padEnd(64) + (r.ok ? '✔ 存在' : '✘ ' + r.error + raw));
    if (r.ok) console.log('     ' + j(brief(r.resp), 500));
  }
  report.dockerRound2 = r2;

  /* --- 7. 命令发现接口 --- */
  hr('⑦ 命令发现类接口');
  const disc = [];
  for (const req of DISCOVERY_CANDIDATES) {
    const r = await probe(req);
    disc.push(r);
    console.log('  ' + req.padEnd(34) + (r.ok ? '✔ 存在' : '✘ ' + r.error + (r.raw ? ' errno=' + r.raw.errno : '')));
    if (r.ok) console.log('     ' + j(brief(r.resp), 1500));
  }
  report.discovery = disc;

  /* --- 8. 收尾 --- */
  hr('⑧ 汇总');
  const okData = dataResults.filter((r) => r.ok).map((r) => r.req);
  const badData = dataResults.filter((r) => !r.ok).map((r) => r.req + ' → ' + r.error);
  console.log('数据命令成功 (' + okData.length + '/' + dataResults.length + '):');
  okData.forEach((r) => console.log('  ✔ ' + r));
  if (badData.length) {
    console.log('数据命令失败:');
    badData.forEach((r) => console.log('  ✘ ' + r));
  }
  console.log('虚拟机 WS 命令命中:', vmHits.length ? vmHits.map((h) => h.req).join(', ') : '(无 —— 符合预期，虚拟机走 REST)');
  console.log('虚拟机 REST 端点：GET ' + rest.filter((r) => r.status === 200).length + '/' + rest.length +
    ' 可用，操作端点 ' + restAct.filter((r) => r.status === 200).length + '/' + restAct.length + ' 可用');
  console.log('容器操作命令命中:', actResults.filter((r) => r.exists).map((r) => r.req).join(', ') || '(无)');
  console.log('\n总耗时', ((Date.now() - t0) / 1000).toFixed(1) + 's');

  const outDir = path.join(__dirname, '..', '.smoke');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (_) { /* ignore */ }
  const outFile = path.join(outDir, 'probe-fnos.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log('完整报告已写入:', outFile);

  cli.close();
  process.exit(0);
})().catch((e) => {
  console.error('探测异常:', e && e.stack ? e.stack : e);
  process.exit(9);
});
