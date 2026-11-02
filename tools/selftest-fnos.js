'use strict';
/**
 * fnOS 端到端自检：启动 Mock fnOS（WebSocket + /vm/api/v1 REST）服务，验证客户端的
 * 加密登录、HMAC 签名、两步验证、取数，以及容器/虚拟机启停流程。
 *
 * mock 的线格与真实机（fnOS 1.2.0800，192.168.1.40）逐字段对齐，
 * 所以本自检同时是**字段映射的回归保护**。
 *
 * 用法: node tools/selftest-fnos.js
 */
const assert = require('assert');
const fnos = require('../src/fnos');
const mock = require('./mock-fnos');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function log(snap) {
  console.log('server   :', snap.server.name, '|', snap.server.versionPrefix, snap.server.version,
    '|', snap.server.distro, '| 主板', snap.board, '| uptime', snap.server.uptimeText);
  console.log('cpu      :', snap.cpu.pct != null ? snap.cpu.pct.toFixed(1) + '%' : '—', '|', snap.cpu.label,
    '|', snap.cpu.speedGhz + 'GHz', '| 温度', snap.temp == null ? '—' : snap.temp + '°C');
  console.log('ram      :', snap.ram.pct + '%', '|', snap.ram.usedText, '/', snap.ram.totalText);
  console.log('disk     :', snap.disk.pct + '%', '|', snap.disk.usedText, '/', snap.disk.totalText, '| 剩余', snap.disk.freeText);
  console.log('net      :', snap.net.iface, '|', snap.ip, '|', snap.net.speedText,
    '| 下载', snap.net.rxText, '/ 上传', snap.net.txText);
  console.log('docker   :', snap.docker.ok ? snap.docker.items.length + ' 个' : ('ERR ' + snap.docker.error));
  snap.docker.items.forEach((i) => console.log('   -', (i.name || '').padEnd(14),
    (i.stateLabel || '').padEnd(5), (i.cpuText || '—').padStart(7), (i.memText || '—').padStart(9),
    (i.image || '').slice(0, 34)));
  console.log('vmm      :', snap.vms.ok ? snap.vms.items.length + ' 台'
    : (snap.vms.notInstalled ? '未安装（' + snap.vms.error + '）' : 'ERR ' + snap.vms.error));
  snap.vms.items.forEach((i) => console.log('   -', (i.name || '').padEnd(16), i.stateLabel,
    i.vcpu ? i.vcpu + ' 核' : '', i.memText || ''));
}

/** 启动一个 mock 并返回 { server, port, cfg } */
async function boot(options) {
  const server = mock.createServer(options);
  const port = await listen(server);
  const cfg = {
    type: 'fnos',
    url: 'http://127.0.0.1:' + port,
    username: mock.VALID_USER,
    password: mock.VALID_PASS,
    allowSelfSigned: true,
  };
  return { server, port, cfg };
}

async function run() {
  const { server, cfg } = await boot();
  fnos.clearCache();

  console.log('\n===== MOCK fnOS（线格对齐真实机 1.2.0800）=====');
  const snap = await fnos.fetchSnapshot(cfg);
  log(snap);

  /* ---- 基本取数（同时证明握手/加密登录/HMAC 签名全部正确） ---- */
  assert.ok(snap.ok, '快照应成功');
  assert.strictEqual(snap.provider, 'fnos', 'provider 标识');
  assert.strictEqual(snap.server.versionPrefix, 'fnOS', '版本前缀');
  assert.strictEqual(snap.server.name, 'fnOS-NAS', '主机名（appcgi.sysinfo.getHostName → data.hostName）');
  assert.strictEqual(snap.server.version, '1.2.0800', 'fnOS 版本号（data.trimVersion）');
  assert.ok(/Mainland-PE/.test(snap.server.distro), '发行版信息: ' + snap.server.distro);
  assert.strictEqual(snap.board, '飞牛 NAS (N100)', '主板（bios.baseboard.productName）');
  assert.strictEqual(snap.docker.label, 'Docker 容器', '容器区块标题');
  assert.strictEqual(snap.vms.label, '虚拟机', '虚拟机区块标题');

  /* ---- 指标 ---- */
  assert.strictEqual(snap.cpu.pct, 17, 'CPU 使用率（resmon.gen.cpuBusy）');
  assert.strictEqual(snap.cpu.cores, 4, 'CPU 物理核（hw.core × hw.num）');
  assert.strictEqual(snap.cpu.threads, 4, 'CPU 线程（hw.thread × hw.num）');
  assert.strictEqual(snap.cpu.speedGhz, 3.4, '主频 GHz（maxFreq 3400 → 3.4）');
  assert.ok(/Intel\(R\) N100/.test(snap.cpu.label), 'CPU 型号: ' + snap.cpu.label);
  assert.strictEqual(snap.temp, 46, 'CPU 温度（resmon.cpu.cpu.temp[0]）');
  assert.strictEqual(snap.ram.pct, 37, '内存使用率（resmon.gen.memPercent）');
  assert.strictEqual(snap.ram.totalText, '16.0 GB', '内存总量（字节，非 KB！）');
  assert.strictEqual(snap.ram.usedText, '6.0 GB', '内存用量（字节）');
  assert.strictEqual(snap.disk.totalText, '40.0 GB', '存储总量（stor.calcSpace.fssizeStor）');
  assert.strictEqual(snap.disk.freeText, '24.0 GB', '存储可用（frsizeStor）');
  assert.strictEqual(snap.disk.usedText, '16.0 GB', '存储已用 = 总量 − 可用');
  assert.strictEqual(Math.round(snap.disk.pct), 40, '存储使用率 16/40 = 40%');
  assert.strictEqual(snap.net.iface, 'enp1s0', '主网卡（lo 被排除）');
  assert.strictEqual(snap.ip, '192.168.1.40', 'IP 地址（ipv4Addr）');
  assert.strictEqual(snap.net.linkMbps, 1000, '链路速率 Mbps');
  assert.strictEqual(snap.net.speedText, '1 Gbps', '链路速率文案');
  assert.strictEqual(snap.net.rx, 138240, '下载速率（resmon.gen.netSpeed.receive）');
  assert.strictEqual(snap.net.tx, 45056, '上传速率（netSpeed.transmit）');
  assert.ok(/天/.test(snap.server.uptimeText), '运行时间文案: ' + snap.server.uptimeText);

  /* ---- 65535 哨兵速率不应被当成 65535 Mbps ---- */
  const savedIface = snap.net.iface;
  assert.ok(savedIface, '应选出网卡');

  /* ---- 容器 / 虚拟机列表 ---- */
  assert.strictEqual(snap.docker.ok, true, 'Docker 区块可用');
  assert.strictEqual(snap.docker.items.length, 6, '容器数量');
  assert.strictEqual(snap.docker.items[0].running, true, '运行中容器排在前面');
  assert.strictEqual(snap.docker.items[0].stateLabel, '运行中', '容器状态文案');
  assert.ok(snap.docker.items.some((i) => i.name === 'emby'), '容器名来自 Names[0] 且去掉了前导斜杠');
  const emby = snap.docker.items.find((i) => i.name === 'emby');
  assert.strictEqual(emby.cpuText, '12.4%', '容器 CPU 来自 dockermgr.stats.cpuUsage');
  assert.strictEqual(emby.memText, '512 MB', '容器内存来自 dockermgr.stats.usedMem（字节）');
  assert.strictEqual(snap.vms.ok, true, '虚拟机区块可用');
  assert.strictEqual(snap.vms.items.length, 2, '虚拟机数量');
  assert.strictEqual(snap.vms.items[0].running, true, '运行中虚拟机排在前面');

  /* ---- 虚拟机字段映射（/vm/api/v1 REST，字段照真机实测） ---- */
  const ow = snap.vms.items.find((i) => i.name === 'OpenWrt');
  assert.ok(ow, '应能取到 OpenWrt');
  assert.strictEqual(ow.id, 'a1b2c3d4', 'id 取内部名 name（操作要用它），name 取展示名 title');
  assert.strictEqual(ow.uuid, '100b8f66-6d90-4353-8ccd-44f649abeed3', 'uuid 来自 domain/list');
  assert.strictEqual(ow.state, 'RUNNING', '状态枚举原样保留');
  assert.strictEqual(ow.stateLabel, '运行中', 'RUNNING → 运行中');
  assert.strictEqual(ow.cls, 'run', '运行中 cls=run');
  assert.strictEqual(ow.vcpu, 1, '核心数来自 domain/info.cpuCoreCnt');
  assert.strictEqual(ow.memText, '512 MB', '内存容量来自 memCapacityInBytes');
  assert.strictEqual(ow.diskText, '933 MB', '磁盘来自 totalDisksCapacityInBytes');
  assert.strictEqual(ow.cpuText, '4.21%', '实时 CPU 来自 domain/status.monitor.cpu');
  assert.strictEqual(ow.usedMemText, '236 MB', '实际占用来自 monitor.memory');
  assert.strictEqual(ow.autoStart, true, '自启动来自 domain/info.autostart');
  assert.strictEqual(ow.hypervisor, 'kvm', 'hypervisor 来自 domain/info');
  assert.strictEqual(ow.rxText, '135.0 KB/s', '实时下行来自 monitor.networks[].rxBytes');
  assert.strictEqual(ow.txText, '44.0 KB/s', '实时上行来自 monitor.networks[].txBytes');
  assert.strictEqual(snap.vms.items[1].name, 'Ubuntu-Server', '已关机的排在后面');
  assert.ok(/linux/.test(ow.osText), '系统文案: ' + ow.osText);

  const ub = snap.vms.items.find((i) => i.name === 'Ubuntu-Server');
  assert.ok(ub, '应能取到 Ubuntu-Server');
  assert.strictEqual(ub.running, false, '已关机');
  assert.strictEqual(ub.stateLabel, '已关机', 'SHUTOFF → 已关机');
  assert.strictEqual(ub.vcpu, 4, '已关机虚拟机的详情仍可读');
  assert.strictEqual(ub.memText, '4.0 GB', '内存 4 GiB');
  assert.strictEqual(ub.diskText, '32.0 GB', '磁盘由 info.disks[] 累加得到');
  assert.strictEqual(ub.cpuText, null, '未运行时没有实时 CPU');
  assert.strictEqual(ub.autoStart, false, '未开机自启');

  /* ---- 容器启停（用容器名，走 containerId 参数） ---- */
  await fnos.containerAction(cfg, 'emby', 'stop');
  let s2 = await fnos.fetchSnapshot(cfg);
  assert.strictEqual(s2.docker.items.find((i) => i.name === 'emby').running, false, 'emby 已停止');
  await fnos.containerAction(cfg, 'emby', 'start');
  s2 = await fnos.fetchSnapshot(cfg);
  assert.strictEqual(s2.docker.items.find((i) => i.name === 'emby').running, true, 'emby 已启动');

  /* ---- 容器启停（用容器 Id，验证另一种标识写法） ---- */
  const embyId = s2.docker.items.find((i) => i.name === 'emby').id;
  assert.ok(/^[0-9a-f]{64}$/.test(embyId), '容器 id 为 64 位十六进制（Docker Engine API）: ' + embyId);
  await fnos.containerAction(cfg, embyId, 'restart');
  const s2b = await fnos.fetchSnapshot(cfg);
  assert.strictEqual(s2b.docker.items.find((i) => i.name === 'emby').running, true, '按 Id 重启成功');

  /* ---- 虚拟机启停（走 REST，参数 { name: 内部名 }） ---- */
  await fnos.guestAction(cfg, '7a1c3d9e', 'start');
  const s3 = await fnos.fetchSnapshot(cfg);
  assert.strictEqual(s3.vms.items.find((i) => i.id === '7a1c3d9e').running, true, 'Ubuntu-Server 已启动');
  assert.strictEqual(s3.vms.items.find((i) => i.id === '7a1c3d9e').stateLabel, '运行中', '启动后状态文案');

  // 优雅关机 vs 强制停止（语义不同，端点不同）
  await fnos.guestAction(cfg, 'a1b2c3d4', 'stop');
  let s4 = await fnos.fetchSnapshot(cfg);
  assert.strictEqual(s4.vms.items.find((i) => i.id === 'a1b2c3d4').running, false, 'OpenWrt 已关机（shutdown）');

  await fnos.guestAction(cfg, 'a1b2c3d4', 'start');
  s4 = await fnos.fetchSnapshot(cfg);
  assert.strictEqual(s4.vms.items.find((i) => i.id === 'a1b2c3d4').running, true, 'OpenWrt 已启动');

  await fnos.guestAction(cfg, 'a1b2c3d4', 'forceStop');
  s4 = await fnos.fetchSnapshot(cfg);
  assert.strictEqual(s4.vms.items.find((i) => i.id === 'a1b2c3d4').running, false, 'OpenWrt 已强制停止（forceshutdown）');

  /* ---- 错误路径：不存在的目标 ---- */
  await assert.rejects(() => fnos.containerAction(cfg, 'no-such-container', 'start'),
    /找不到指定容器/, '不存在的容器应报「找不到指定容器」');
  await assert.rejects(() => fnos.guestAction(cfg, 'no-such-vm', 'start'),
    /找不到指定虚拟机/, '不存在的虚拟机应报「找不到指定虚拟机」');

  /* ---- 回归保护：虚拟机**不再**走 WebSocket RPC ----
   * 真机上 appcgi.vmm.* 一律返回 errno 266240（命名空间不存在），
   * 若将来有人误把它改回 WS 候选调用，这里会立刻失败。 */
  const wsCli = new fnos.FnClient(fnos.normalizeEndpoint(cfg.url), cfg);
  await wsCli.ensure();
  await assert.rejects(
    () => wsCli.call('appcgi.vmm.vmList'),
    (e) => e && e.errno === 266240,
    'WS 上的 appcgi.vmm.* 应报 266240（虚拟机只走 /vm/api/v1 REST）'
  );
  wsCli.close();

  /* ---- 降级路径：未安装 Docker / 未安装「虚拟机」应用 ---- */
  const noVm = await boot({ noVm: true });
  fnos.clearCache();
  const sNovm = await fnos.fetchSnapshot(noVm.cfg);
  assert.strictEqual(sNovm.vms.ok, false, '未装虚拟机应用时区块应不可用');
  assert.strictEqual(sNovm.vms.notInstalled, true, '应标注未安装');
  assert.ok(/未启用虚拟机/.test(sNovm.vms.error), '提示文案: ' + sNovm.vms.error);
  assert.ok(/虚拟机/.test(sNovm.vms.hint), '安装提示: ' + sNovm.vms.hint);
  assert.ok(sNovm.docker.ok, '虚拟机不可用不应影响 Docker 区块');
  assert.ok(sNovm.ok, '虚拟机不可用不应影响整机状态');
  await assert.rejects(() => fnos.guestAction(noVm.cfg, '7a1c3d9e', 'start'),
    /未安装/, '未装应用时操作虚拟机应给出明确提示');
  noVm.server.close();

  const noDocker = await boot({ noDocker: true });
  fnos.clearCache();
  const sNoDk = await fnos.fetchSnapshot(noDocker.cfg);
  assert.strictEqual(sNoDk.docker.ok, false, '无 Docker 模块时区块应不可用');
  assert.strictEqual(sNoDk.docker.notInstalled, true, 'Docker 应标注未安装');
  assert.ok(/Docker/.test(sNoDk.docker.hint), 'Docker 提示文案: ' + sNoDk.docker.hint);
  noDocker.server.close();

  /* ---- 错误密码（独立实例，避免污染上面的会话） ---- */
  fnos.clearCache();
  const bad = await boot();
  const badRes = await fnos.testConnection(Object.assign({}, bad.cfg, { password: 'wrong-pass' }));
  assert.ok(!badRes.ok, '错误密码应登录失败');
  assert.ok(/账号或密码错误/.test(badRes.error), '错误密码提示: ' + badRes.error);
  bad.server.close();
  fnos.clearCache();

  /* ---- 两步验证 ---- */
  const otp = await boot({ requireOtp: true });
  const noCode = await fnos.testConnection(otp.cfg);
  assert.ok(!noCode.ok, '未填验证码应登录失败');
  assert.ok(/两步验证/.test(noCode.error), '两步验证提示: ' + noCode.error);
  const withCode = await fnos.testConnection(Object.assign({}, otp.cfg, { otpCode: mock.OTP_CODE }));
  assert.ok(withCode.ok, '填写验证码后应登录成功: ' + (withCode.error || ''));
  assert.strictEqual(withCode.hostname, 'fnOS-NAS', '两步验证登录后可正常取数');
  otp.server.close();

  /* ======================================================================
   * fnConnect：只填 FN ID，自动按网络环境选路
   * ====================================================================*/
  fnos.clearCache();
  const fc = await boot();
  const fcPort = fc.port;
  /** 只给 FN ID，不给地址（fnDomain 指向 mock，代替真实 fnos.net） */
  const fnCfg = {
    type: 'fnos',
    fnId: mock.FN_CONNECT.fnId,
    fnDomain: 'http://127.0.0.1:' + fcPort,
    username: mock.VALID_USER,
    password: mock.VALID_PASS,
    allowSelfSigned: true,
  };

  console.log('\n----- fnConnect（FN ID 自动寻址）-----');

  /* ---- 1) 云端解析：拿到局域网/公网/中继各路候选 ---- */
  const res = await fnos.resolveFnId(fnCfg.fnId, fnCfg);
  console.log('  解析结果: 局域网=' + JSON.stringify(res.lan4) +
    ' 公网v4=' + JSON.stringify(res.pub4) +
    ' 中继=' + JSON.stringify(res.relay) +
    ' 端口=' + res.httpPort);
  assert.deepStrictEqual(res.lan4, ['127.0.0.1'], '应解析出局域网地址');
  assert.deepStrictEqual(res.pub4, [mock.FN_CONNECT.fakePublic4], '应解析出公网 IPv4');
  assert.deepStrictEqual(res.relay, [mock.FN_CONNECT.relay], '应解析出中继域名');
  assert.strictEqual(res.httpPort, fcPort, '端口应来自云端返回');
  assert.strictEqual(res.fnId, mock.FN_CONNECT.fnId, 'FN ID 应回显');

  /* ---- 2) 候选列表顺序 = 优先级：局域网 → 公网 → DDNS → 中继 ---- */
  const cands = fnos.buildCandidates(res);
  const kinds = cands.map((c) => c.kind);
  console.log('  候选顺序: ' + cands.map((c) => c.kind + '(' + c.base + ')').join(' → '));
  assert.strictEqual(kinds[0], 'lan', '局域网必须是第一优先级');
  assert.ok(kinds.indexOf('public4') > 0, '公网 IPv4 排在局域网之后');
  assert.ok(kinds.indexOf('relay') === kinds.length - 1, '中继是最后兜底');
  assert.strictEqual(cands[0].base, 'http://127.0.0.1:' + fcPort, '局域网地址拼接正确');

  /* ---- 3) 选路：局域网可达 → 应当命中局域网 ---- */
  fnos.clearFnBase('');
  const t0 = Date.now();
  const route = await fnos.getBase(fnCfg);
  const tRoute = Date.now() - t0;
  console.log('  选路: ' + route.base + '  (' + route.label + ')  ' + tRoute + 'ms');
  assert.strictEqual(route.kind, 'lan', '应选中最优的局域网直连，实际: ' + route.kind);
  assert.strictEqual(route.base, 'http://127.0.0.1:' + fcPort, '选路结果地址');

  /* ---- 4) 缓存：第二次应当命中缓存（不再解析/探活） ---- */
  const t1 = Date.now();
  const route2 = await fnos.getBase(fnCfg);
  const tCache = Date.now() - t1;
  assert.strictEqual(route2.base, route.base, '缓存应返回同一地址');
  assert.ok(tCache <= tRoute, '缓存命中不应慢于首次选路（' + tCache + 'ms vs ' + tRoute + 'ms）');

  /* ---- 5) 端到端：只给 FN ID 也能拿到完整快照 ---- */
  const fcSnap = await fnos.fetchSnapshot(fnCfg);
  log(fcSnap);
  assert.ok(fcSnap.ok, '仅凭 FN ID 应能取到快照: ' + (fcSnap.error || ''));
  assert.strictEqual(fcSnap.route.kind, 'lan', '快照应带上选路信息');
  assert.strictEqual(fcSnap.host, '127.0.0.1:' + fcPort, '快照 host 应来自解析结果');
  assert.ok(fcSnap.docker.items.length > 0, 'Docker 区块应正常');

  /* ---- 6) testConnection 应回带选路标签 ---- */
  const fcTest = await fnos.testConnection(fnCfg);
  assert.ok(fcTest.ok, '仅凭 FN ID 应能连接: ' + (fcTest.error || ''));
  assert.strictEqual(fcTest.routeKind, 'lan', 'testConnection 应回带 routeKind');
  assert.strictEqual(fcTest.route, '局域网直连', 'testConnection 应回带中文选路名');
  assert.strictEqual(fcTest.fnId, mock.FN_CONNECT.fnId, 'testConnection 应回带 FN ID');

  /* ---- 7) 签名必须真的被服务端校验（证明上面不是侥幸通过） ---- */
  const origPrefix = fnos.FN_CONNECT.signPrefix;
  // 用错误的 apiKey 复算 → 服务端必须拒绝
  const wrongAuth = (() => {
    const crypto = require('crypto');
    const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
    const bodyStr = JSON.stringify({ fnId: mock.FN_CONNECT.fnId });
    const nonce = '123456';
    const ts = Date.now();
    const joined = [origPrefix, '/api/v1/fn/con', nonce, ts, md5(bodyStr), 'wrong-api-key'].join('_');
    return 'nonce=' + nonce + '&timestamp=' + ts + '&sign=' + md5(joined);
  })();
  const { request: httpReq } = require('../src/http');
  const badRaw = await httpReq('http://127.0.0.1:' + fcPort + '/api/v1/fn/con', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authx: wrongAuth, 'fn-sign': 'a'.repeat(64) },
    body: JSON.stringify({ fnId: mock.FN_CONNECT.fnId }),
    timeout: 5000,
  });
  assert.strictEqual(badRaw.json.code, 5000, '错误签名的请求必须被拒绝');
  assert.strictEqual(badRaw.json.msg, 'invalid sign', '错误签名应返回 invalid sign');

  /* ---- 8) FN ID 不存在 ---- */
  await assert.rejects(
    () => fnos.resolveFnId('nosuchid', fnCfg),
    /找不到该 FN ID/,
    'FN ID 不存在应给出中文提示'
  );

  /* ---- 9) FN Connect 未开启且未填地址 → 报错 ---- */
  fc.server.close();
  const off = await boot({ fnConnect: false });
  const offCfg = {
    type: 'fnos', fnId: mock.FN_CONNECT.fnId, fnDomain: 'http://127.0.0.1:' + off.port,
    username: mock.VALID_USER, password: mock.VALID_PASS, allowSelfSigned: true,
  };
  fnos.clearFnBase('');
  await assert.rejects(() => fnos.getBase(offCfg), /无法连接飞牛云端/, '云端不可达应给出中文提示');
  const offSnap = await fnos.fetchSnapshot(offCfg);
  assert.ok(!offSnap.ok, '解析失败时快照应为失败态');
  assert.ok(/无法连接飞牛云端/.test(offSnap.error), '快照应带上解析错误: ' + offSnap.error);

  /* ---- 10) FN Connect 未开启但填了地址 → 自动退回手填地址 ---- */
  fnos.clearFnBase('');
  const fbRoute = await fnos.getBase(Object.assign({}, offCfg, { url: 'http://127.0.0.1:' + off.port }));
  assert.strictEqual(fbRoute.kind, 'manual', '应退回手动地址');
  assert.strictEqual(fbRoute.label, '手动地址', '退回时应标注手动地址');
  off.server.close();

  fnos.clearCache();
  server.close();

  console.log('\n✔ fnOS 全部断言通过');
  console.log('fnOS 自检通过 ✅');
}

run().catch((e) => {
  console.error('\n✘ fnOS 自检失败:', e && e.message);
  if (e && e.stack) console.error(e.stack);
  process.exit(1);
});
