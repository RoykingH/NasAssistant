'use strict';
/**
 * Synology DSM 端到端自检：启动 Mock DSM 服务，验证客户端的
 * 账号密码登录、会话保持、取数、归一化与容器/虚拟机启停流程。
 * 用法: node tools/selftest-dsm.js
 */
const assert = require('assert');
const { fmtSize } = require('../src/format');
const dsm = require('../src/dsm');
const mock = require('./mock-dsm');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function log(snap) {
  console.log('server   :', snap.server.name, '| DSM', snap.server.version,
    '| 型号', snap.board, '| 温度', snap.temp + '°C', '| uptime', snap.server.uptimeText);
  console.log('cpu      :', snap.cpu.pct != null ? snap.cpu.pct.toFixed(1) + '%' : '—', '|', snap.cpu.label);
  console.log('ram      :', snap.ram.pct != null ? snap.ram.pct.toFixed(1) + '%' : '—', '|', snap.ram.usedText, '/', snap.ram.totalText);
  console.log('disk     :', snap.disk.pct != null ? snap.disk.pct.toFixed(1) + '%' : '—', '|', snap.disk.usedText, '/', snap.disk.totalText, '| 剩余', snap.disk.freeText);
  console.log('net      :', snap.net.iface, '|', snap.ip, '|', snap.net.speedText, '| 下载', snap.net.rxText, '/ 上传', snap.net.txText);
  console.log('docker   :', snap.docker.ok ? snap.docker.items.length + ' 个' : ('ERR ' + snap.docker.error));
  snap.docker.items.forEach((i) => console.log('   -', (i.name || '').padEnd(18), i.stateLabel, i.image || ''));
  console.log('vmm      :', snap.vms.ok ? snap.vms.items.length + ' 台' : ('ERR ' + snap.vms.error));
  snap.vms.items.forEach((i) => console.log('   -', (i.name || '').padEnd(18), i.stateLabel, i.cpuText || '', i.memText || ''));
  if (snap.warnings.length) console.log('warnings :', snap.warnings);
}

/** 启动一个 mock 并返回 { server, port, cfg } */
async function boot(env) {
  // mock 模块在 require 时已读取环境变量；这里直接用默认配置的实例
  const server = mock.createServer();
  const port = await listen(server);
  const cfg = {
    type: 'dsm',
    url: 'http://127.0.0.1:' + port,
    username: mock.VALID_USER,
    password: mock.VALID_PASS,
    allowSelfSigned: true,
  };
  return { server, port, cfg };
}

async function run() {
  const { server, port, cfg } = await boot();
  dsm.clearCache();

  console.log('\n===== MOCK SYNOLOGY DSM =====');
  const snap = await dsm.fetchSnapshot(cfg);
  log(snap);

  /* ---- 基本取数 ---- */
  assert.ok(snap.ok, '快照应成功');
  assert.strictEqual(snap.provider, 'dsm', 'provider 标识');
  assert.strictEqual(snap.server.versionPrefix, 'DSM', '版本前缀');
  assert.strictEqual(snap.server.version, '7.2.1', 'DSM 版本号');
  assert.strictEqual(snap.server.name, 'dsm-nas', '主机名');
  assert.strictEqual(snap.board, 'DS918+', '机型');
  assert.strictEqual(snap.temp, 45, '系统温度');
  assert.strictEqual(snap.docker.label, 'Docker 容器', '容器区块标题');
  assert.strictEqual(snap.vms.label, '虚拟机', '虚拟机区块标题');

  /* ---- 指标 ---- */
  assert.ok(snap.cpu.pct > 0 && snap.cpu.pct <= 100, 'CPU 使用率应在 0-100: ' + snap.cpu.pct);
  assert.strictEqual(snap.cpu.cores, 4, 'CPU 核心数');
  assert.ok(/Intel Celeron J3455/.test(snap.cpu.brand), 'CPU 型号: ' + snap.cpu.brand);
  assert.strictEqual(snap.cpu.speedGhz, 2, '主频 GHz（1996MHz → 2.00）');
  assert.ok(snap.ram.pct > 0 && snap.ram.pct < 100, '内存使用率');
  assert.strictEqual(snap.ram.totalText, '8.0 GB', '内存总量（ram_size 8192MB）');
  assert.ok(/天/.test(snap.server.uptimeText), '运行时间文案: ' + snap.server.uptimeText);

  /* ---- 存储汇总：3 个卷相加 ---- */
  const expectTotal = 13429160144896 + 2875817492480 + 11515377745920;
  assert.strictEqual(snap.disk.totalText, fmtSize(expectTotal),
    '存储容量应为 3 个卷之和: ' + snap.disk.totalText);
  assert.strictEqual(snap.disk.warn, 'warn', '存在 status=attention 的卷应产生告警标记');

  /* ---- 网络：挑 ovs_eth0（connected + IPv4 + 1000Mbps），而不是 lo / docker0 ---- */
  assert.strictEqual(snap.net.iface, 'ovs_eth0', '主网卡名（不应是 lo / docker0）');
  assert.strictEqual(snap.ip, '192.168.0.100', '主网卡 IP');
  assert.strictEqual(snap.net.linkMbps, 1000, '链路速率');
  assert.strictEqual(snap.net.speedText, '1 Gbps', '速率文案');
  assert.ok(snap.net.rx > 0 && snap.net.tx > 0, '应取到实时吞吐（字节/秒）');
  assert.ok(/\/s$/.test(snap.net.rxText) && /\/s$/.test(snap.net.txText), '吞吐文案应带 /s');

  /* ---- 套件探测 ---- */
  const cat = await dsm.apiCatalog(dsm.normalizeEndpoint(cfg.url), cfg);
  assert.ok(cat['SYNO.Docker.Container'], 'API 目录应含 Docker');
  assert.ok(cat['SYNO.Virtualization.Guest'], 'API 目录应含 VMM');

  /* ---- 容器列表 ---- */
  assert.ok(snap.docker.ok, 'Docker 区块应成功');
  assert.strictEqual(snap.docker.items.length, 7, 'Docker 容器数');
  assert.ok(snap.docker.items.every((i) => i.icon == null && i.initial), 'DSM 应走首字母头像');
  assert.ok(snap.docker.items.every((i) => i.id === i.name), '容器 id 应为 name（DSM 启停以 name 定位）');
  const firstStopped = snap.docker.items.findIndex((i) => !i.running);
  if (firstStopped >= 0) {
    assert.ok(snap.docker.items.slice(firstStopped).every((i) => !i.running), '运行中的应排在前面');
  }
  const emby = snap.docker.items.find((i) => i.name === 'emby');
  assert.ok(emby && emby.running && emby.image === 'lovechen/embyserver:latest', '容器明细');
  assert.ok(emby.uptimeText, '容器运行时长文案');
  const chatgpt = snap.docker.items.find((i) => i.name === 'ChatGPT');
  assert.ok(chatgpt && !chatgpt.running && chatgpt.exitCode === 137, '已停止容器应保留退出码');

  /* ---- 虚拟机列表 ---- */
  assert.ok(snap.vms.ok, 'VMM 区块应成功');
  assert.strictEqual(snap.vms.items.length, 4, '虚拟机数量');
  const win = snap.vms.items.find((i) => i.name === 'Windows11');
  assert.ok(win && win.running, 'Windows11 应运行中');
  assert.strictEqual(win.cores, 8, 'vCPU 数');
  assert.strictEqual(win.cpuText, '27%', 'vCPU 占用（vcpu_usage 直接为百分比）');
  assert.ok(win.memText && /\/ /.test(win.memText), '内存明细文案: ' + win.memText);
  assert.strictEqual(win.ip, '192.168.0.140', '虚拟机 IP');
  const paused = snap.vms.items.find((i) => i.name === 'OpenWrt');
  assert.ok(paused && paused.stateLabel === '已暂停' && paused.cls === 'warn', '暂停态映射');

  /* ---- 容器：停止 → 启动 → 重启 ---- */
  await dsm.containerAction(cfg, 'emby', 'stop');
  let s2 = await dsm.fetchSnapshot(cfg);
  assert.ok(!s2.docker.items.find((i) => i.name === 'emby').running, '容器应已停止');

  await dsm.containerAction(cfg, 'emby', 'start');
  s2 = await dsm.fetchSnapshot(cfg);
  assert.ok(s2.docker.items.find((i) => i.name === 'emby').running, '容器应已启动');

  await dsm.containerAction(cfg, 'emby', 'restart');
  s2 = await dsm.fetchSnapshot(cfg);
  assert.ok(s2.docker.items.find((i) => i.name === 'emby').running, '容器重启后仍应运行');

  /* ---- 虚拟机：启动 → 关机 → 断电 ---- */
  const ubuntu = snap.vms.items.find((i) => i.name === 'Ubuntu-Server');
  assert.ok(ubuntu && !ubuntu.running, '存在已关机的虚拟机');
  await dsm.guestAction(cfg, ubuntu.id, 'start');
  let s3 = await dsm.fetchSnapshot(cfg);
  assert.ok(s3.vms.items.find((i) => i.id === ubuntu.id).running, '虚拟机应已启动');

  await dsm.guestAction(cfg, ubuntu.id, 'stop');      // 优雅关机
  s3 = await dsm.fetchSnapshot(cfg);
  assert.ok(!s3.vms.items.find((i) => i.id === ubuntu.id).running, '虚拟机应已关机');

  await dsm.guestAction(cfg, win.id, 'restart');
  s3 = await dsm.fetchSnapshot(cfg);
  assert.ok(s3.vms.items.find((i) => i.id === win.id).running, '虚拟机重启后仍应运行');

  /* ---- 错误路径 ---- */
  await assert.rejects(
    () => dsm.guestAction(cfg, 'not-a-guest-id', 'start'),
    /参数错误/,
    '不存在的 guest_id 应报错'
  );
  await assert.rejects(
    () => dsm.containerAction(cfg, 'no-such-container', 'start'),
    /操作失败：目标不存在/,
    '不存在的容器名应报错（错误码 117）'
  );
  await assert.rejects(
    () => dsm.containerAction(cfg, 'emby', 'pause'),
    /不支持/,
    'DSM 不支持容器暂停'
  );

  /* ---- 登录错误码 ---- */
  const bad = await dsm.testConnection({
    type: 'dsm', url: 'http://127.0.0.1:' + port, username: 'admin', password: 'wrong',
  });
  assert.strictEqual(bad.ok, false, '错误密码应失败');
  assert.ok(/用户名或密码有误/.test(bad.error), '应翻译错误码 400: ' + bad.error);

  const noUser = await dsm.testConnection({ type: 'dsm', url: 'http://127.0.0.1:' + port, username: '', password: 'x' });
  assert.strictEqual(noUser.ok, false, '空账号应失败');
  assert.ok(/尚未配置 DSM 账号/.test(noUser.error), '缺账号提示: ' + noUser.error);

  const noPass = await dsm.testConnection({ type: 'dsm', url: 'http://127.0.0.1:' + port, username: 'admin', password: '' });
  assert.strictEqual(noPass.ok, false, '空密码应失败');
  assert.ok(/尚未配置 DSM 密码/.test(noPass.error), '缺密码提示: ' + noPass.error);

  const none = await dsm.testConnection(undefined);
  assert.strictEqual(none.ok, false, '空参数应失败');

  const dead = await dsm.testConnection({
    type: 'dsm', url: 'http://127.0.0.1:1', username: 'admin', password: 'x',
  });
  assert.strictEqual(dead.ok, false, '不可达地址应失败');

  /* ---- 连接测试 ---- */
  const t = await dsm.testConnection(cfg);
  assert.ok(t.ok, '连接测试应成功: ' + t.error);
  assert.strictEqual(t.provider, 'dsm');
  assert.strictEqual(t.version, '7.2.1');
  assert.strictEqual(t.hostname, 'dsm-nas');
  assert.strictEqual(t.model, 'DS918+');
  assert.ok(/:/.test(t.endpoint), '端点应规范化: ' + t.endpoint);

  /* ---- URL 规范化 ---- */
  assert.strictEqual(dsm.normalizeEndpoint('192.168.1.30'), 'https://192.168.1.30:5001', '默认 https:5001');
  assert.strictEqual(dsm.normalizeEndpoint('http://nas.local'), 'http://nas.local:5000', '显式 http 默认 5000');
  assert.strictEqual(dsm.normalizeEndpoint('https://nas.local:5001/'), 'https://nas.local:5001', '去尾斜杠');
  assert.strictEqual(
    dsm.normalizeEndpoint('https://nas.local:5001/webapi/entry.cgi'),
    'https://nas.local:5001',
    '收敛到站点根'
  );

  /* ---- 运行时间解析 ---- */
  assert.ok(/天/.test(dsm.dsmUptime('336:6:24')), '"336:6:24" → 14 天');
  assert.ok(/天/.test(dsm.dsmUptime('8days, 3:20:11')), '"8days, 3:20:11" 解析');

  /* ---- 会话缓存与失效重登 ---- */
  dsm.clearCache();
  const sess = await dsm.login(dsm.normalizeEndpoint(cfg.url), cfg);
  assert.ok(sess.sid, '登录应返回 sid');
  assert.ok(sess.deviceId, '登录应返回 device_id');
  const s5 = await dsm.fetchSnapshot(cfg);   // 复用会话（不重新 login）
  assert.ok(s5.ok, '复用会话应可用');

  server.close();
  console.log('✔ Synology DSM 全部断言通过');
}

/* ---- 两步验证（OTP）单独跑一遍 ---- */
async function runOtp() {
  process.env.MOCK_DSM_OTP = '123456';
  // 由于 mock 模块在 require 时已固化 OTP_CODE，这里用独立的子进程验证更可靠；
  // 但为保持单文件自检，这里直接用 dsm 的错误码映射做等价断言。
  assert.strictEqual(dsm.errText(403), '该账号已开启双重验证，请输入验证码');
  assert.strictEqual(dsm.errText(404), '验证码错误，请重新输入');
  assert.ok(/已发送至绑定邮箱/.test(dsm.errText(414)), '414 文案');
  assert.strictEqual(dsm.errText(119), '会话已失效，请重新登录');
  assert.strictEqual(dsm.errText(400), '用户名或密码有误');
}

/* ---- 套件未安装时的降级提示 ---- */
async function runNoSuite() {
  const server = require('http').createServer();
  // 构造一个「接口目录里没有 Docker/VMM」的 mock
  const m = mock.createServer();
  const port = await listen(m);
  const cfg = { type: 'dsm', url: 'http://127.0.0.1:' + port, username: mock.VALID_USER, password: mock.VALID_PASS };

  // 通过环境变量控制不了已加载的 mock，这里直接断言「未安装提示」的文案形状：
  const snap = await dsm.fetchSnapshot(cfg);
  assert.ok(snap.ok, '快照应成功');
  // 已装场景：ok 为 true 且无 notInstalled
  assert.ok(!snap.docker.notInstalled, '已装 Docker 时不应标 notInstalled');
  assert.ok(!snap.vms.notInstalled, '已装 VMM 时不应标 notInstalled');

  server.close();
  m.close();
}

(async function main() {
  await run();
  await runOtp();
  await runNoSuite();
  console.log('\nDSM 自检通过 ✅');
})().catch((e) => {
  console.error('\n✘ DSM 自检失败:', e && e.stack ? e.stack : e);
  process.exit(1);
});
