'use strict';
/**
 * 端到端自检：启动本地 Mock 服务，验证 GraphQL 客户端在「现代(Unraid 7.3 真实 schema) /
 * 旧版」两种 schema 下的取数、归一化与 Docker / VM 控制流程。
 * 用法: node tools/selftest.js
 */
const assert = require('assert');
const providers = require('../src/providers');
const unraid = require('../src/unraid');
const { createServer } = require('./mock-server');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const EXPECT = {
  modern: { version: '7.3.2', iface: 'br0' },
  legacy: { version: '7.2.0', iface: 'eth0' },
};

async function run(mode) {
  unraid.clearCache();               // 两种模式互不影响
  const server = createServer({ mode });
  const port = await listen(server);
  // 不带 type：验证「旧配置（只有 url/apiKey）自动识别为 unraid」
  const cfg = { url: '127.0.0.1:' + port, apiKey: 'demo', allowSelfSigned: true };
  const expect = EXPECT[mode];

  /* ---- provider 路由：无 type 应落到 unraid ---- */
  assert.strictEqual(providers.kindOf(cfg), 'unraid', '无 type 的旧配置应识别为 unraid');
  assert.strictEqual(providers.meta(providers.kindOf(cfg)).label, 'Unraid');

  const snap = await providers.fetchSnapshot(cfg);
  console.log('\n===== MOCK_MODE = ' + mode + ' =====');
  console.log('server   :', snap.server.name, '| Unraid', snap.server.version, '| uptime', snap.server.uptimeText);
  console.log('os/board :', snap.server.kernel, '|', snap.server.distro, '| 主板', snap.board);
  console.log('ip/iface :', snap.ip, '|', snap.net.iface, '| 链路', snap.net.speedText);
  console.log('吞吐     :', '上传', snap.net.txText, '/ 下载', snap.net.rxText);
  console.log('temp     :', snap.temp == null ? '—' : snap.temp + '°C');
  console.log('cpu      :', snap.cpu.pct && snap.cpu.pct.toFixed(1) + '%', '|', snap.cpu.label, '| 每核', snap.cpu.perCore.length);
  console.log('ram      :', snap.ram.pct && snap.ram.pct.toFixed(1) + '%', '|', snap.ram.usedText, '/', snap.ram.totalText);
  console.log('disk     :', snap.disk.pct && snap.disk.pct.toFixed(1) + '%', '|', snap.disk.usedText, '/', snap.disk.totalText, '| 剩余', snap.disk.freeText, '|', snap.disk.state);
  console.log('docker   :', snap.docker.ok ? snap.docker.items.length + ' 个' : 'ERR ' + snap.docker.error);
  snap.docker.items.forEach((i) => console.log('   -', i.name.padEnd(20), i.stateLabel, '(' + i.state + ')', i.createdText || '', i.icon ? '[icon]' : ''));
  console.log('vms      :', snap.vms.ok ? snap.vms.items.length + ' 台' : 'ERR ' + snap.vms.error);
  snap.vms.items.forEach((i) => console.log('   -', i.name.padEnd(20), i.stateLabel, '(' + i.state + ')', i.icon ? '[icon]' : '[首字母]'));
  if (snap.warnings.length) console.log('warnings :', snap.warnings);

  /* ---- 基本取数 ---- */
  assert.ok(snap.ok, '快照应成功');
  assert.strictEqual(snap.warnings.length, 0, '不应有任何区块降级告警: ' + JSON.stringify(snap.warnings));
  assert.strictEqual(snap.provider, 'unraid', '统一快照应带 provider 标识');
  assert.strictEqual(snap.server.versionPrefix, 'Unraid', '版本前缀');
  assert.strictEqual(snap.docker.label, 'Docker 容器', '容器区块标题');
  assert.strictEqual(snap.vms.label, '虚拟机', '虚拟机区块标题');
  assert.strictEqual(snap.server.name, 'tower');
  assert.strictEqual(snap.server.version, expect.version, '版本号（' + mode + '）');
  assert.ok(snap.cpu.pct != null, 'CPU 使用率');
  assert.ok(snap.ram.pct != null, '内存使用率');
  assert.ok(snap.disk.pct != null, '磁盘使用率');
  assert.strictEqual(snap.disk.state, 'STARTED');

  /* ---- 服务器详情（设计稿 ui/info.png 的「服务器详情」区块）---- */
  assert.strictEqual(snap.server.kernel, '6.18.38-Unraid', '内核版本');
  assert.strictEqual(snap.server.distro, 'Unraid OS', '发行版');
  assert.ok(snap.cpu.brand && snap.cpu.brand.length > 3, '处理器型号');
  assert.strictEqual(snap.cpu.cores, 16, 'CPU 核心数');
  assert.strictEqual(snap.cpu.threads, 32, 'CPU 线程数');
  assert.ok(/TUF GAMING/.test(snap.board), '主板型号（现代走 baseboard / 旧版回退 system）: ' + snap.board);

  /* ---- 网卡：必须选中主网卡（不是 lo），并取到协商速率 ---- */
  assert.strictEqual(snap.ip, '192.168.1.10', '主网卡 IP（不应是 127.0.0.1）');
  assert.strictEqual(snap.net.iface, expect.iface, '主网卡名');
  assert.strictEqual(snap.net.linkMbps, 1000, '链路速率');
  assert.strictEqual(snap.net.speedText, '1 Gbps', '速率展示文案');

  /* ---- 实时吞吐 / 温度 / 每核心：现代模式必须全部拿到 ---- */
  if (mode === 'modern') {
    assert.ok(snap.disk.freeText && snap.disk.freeText !== '—', '剩余空间文案');
    assert.ok(snap.net.rx > 0 && snap.net.tx > 0, '应取到实时上传/下载速率');
    assert.ok(/\/s$/.test(snap.net.rxText) && /\/s$/.test(snap.net.txText), '吞吐文案应带 /s');
    assert.ok(snap.temp != null && snap.temp > 0 && snap.temp < 120, 'CPU 温度');
    assert.strictEqual(snap.cpu.perCore.length, 16, '每核心占用（用于 CPU 折线）');
  } else {
    // 旧版 schema 无这些字段：应「安静降级」而不是报错
    assert.strictEqual(snap.net.rx, null, '旧版无实时吞吐');
    assert.strictEqual(snap.net.txText, '—', '旧版吞吐文案应为占位符');
    assert.strictEqual(snap.temp, null, '旧版无温度传感器');
    assert.strictEqual(snap.cpu.perCore.length, 0, '旧版无每核心数据');
    assert.strictEqual(snap.warnings.length, 0, '降级不应产生告警');
  }

  /* ---- 列表 ---- */
  assert.ok(snap.docker.ok && snap.docker.items.length === 6, 'Docker 容器数量');
  assert.ok(snap.vms.ok && snap.vms.items.length === 3, '虚拟机数量');
  assert.ok(snap.vms.items.every((v) => v.id && !/^vm:/.test(v.id)), 'VM id 应为裸 UUID');
  assert.ok(snap.vms.items.every((v) => v.uuid), 'VM 应带 uuid');
  assert.ok(snap.vms.items.every((v) => v.name !== '(未命名)'), 'VM 名称应解析正确');
  /* VmDomain 只有 id/uuid/name/state —— 不含图标字段，界面需回退「首字母 + 随机底色」。
     若将来 Unraid 提供 icon，这条断言会失败，提醒同步开启图标展示。 */
  assert.ok(snap.vms.items.every((v) => v.icon == null), 'VmDomain 当前不返回图标（应走首字母头像兜底）');
  assert.ok(snap.docker.items.every((i) => i.initial), '容器应有首字母头像兜底');
  if (mode === 'modern') {
    assert.ok(snap.docker.items.every((i) => /^\d{4}-\d{2}-\d{2}$/.test(i.createdText || '')), '容器创建时间文案');
    assert.ok(snap.docker.items.some((i) => i.icon), '应解析出 net.unraid.docker.icon 图标');
  }

  const containers = snap.docker.items;
  const running = containers.find((i) => i.running);
  const stopped = containers.find((i) => !i.running);
  assert.ok(running && stopped, '应有运行中与已停止的容器');

  /* ---- 回归守卫：变更操作必须复用查询返回的 id 原值 ----
     （真实 Unraid 返回 PrefixedID，自行加 container: 前缀会找不到容器） */
  assert.strictEqual(stopped.id, containers.find((i) => i.id === stopped.id).id);
  assert.ok(!/^container:/.test(stopped.id) || mode === 'legacy', '现代模式的容器 id 不应被加 container: 前缀');

  /* ---- Docker 启动（曾因缺少子字段选择而报错） ---- */
  await providers.containerAction(cfg, stopped.id, 'start');
  const snap2 = await providers.fetchSnapshot(cfg);
  assert.ok(snap2.docker.items.find((i) => i.id === stopped.id).running, '容器应已启动');

  /* ---- Docker 停止 ---- */
  await providers.containerAction(cfg, stopped.id, 'stop');
  const snap3 = await providers.fetchSnapshot(cfg);
  assert.ok(!snap3.docker.items.find((i) => i.id === stopped.id).running, '容器应已停止');

  /* ---- Docker 重启（API 无 restart mutation，应由 stop + start 组合实现） ---- */
  await providers.containerAction(cfg, running.id, 'restart');
  const snap4 = await providers.fetchSnapshot(cfg);
  assert.ok(snap4.docker.items.find((i) => i.id === running.id).running, '容器重启后应仍在运行');

  /* ---- VM 启动 / 强制停止 ---- */
  const vm = snap.vms.items.find((i) => !i.running);
  assert.ok(vm, '存在已关机的虚拟机');
  await providers.guestAction(cfg, vm.id, 'start');
  const snap5 = await providers.fetchSnapshot(cfg);
  assert.ok(snap5.vms.items.find((i) => i.id === vm.id).running, '虚拟机应已启动');

  await providers.guestAction(cfg, vm.id, 'forceStop');
  const snap6 = await providers.fetchSnapshot(cfg);
  assert.ok(!snap6.vms.items.find((i) => i.id === vm.id).running, '虚拟机应已停止');

  /* ---- 连接测试 ---- */
  const t = await providers.testConnection(cfg);
  assert.ok(t.ok && t.hostname === 'tower', '连接测试');
  assert.strictEqual(t.version, expect.version, '连接测试应返回版本号');

  const bad = await providers.testConnection({ url: cfg.url, apiKey: '' });
  assert.strictEqual(bad.ok, false, '空 API Key 应失败');

  /* ---- 首次配置引导页的「连接测试」路径 ---- */
  const dead = await providers.testConnection({ url: '127.0.0.1:1', apiKey: 'demo' });
  assert.strictEqual(dead.ok, false, '不可达地址应返回失败');
  assert.ok(dead.error, '不可达地址应带回错误信息');

  const noUrl = await providers.testConnection({ url: '', apiKey: 'demo' });
  assert.strictEqual(noUrl.ok, false, '空地址应返回失败');
  assert.ok(noUrl.error, '空地址应带回错误信息');

  const junk = await providers.testConnection({ url: '这不是一个地址', apiKey: 'demo' });
  assert.strictEqual(junk.ok, false, '非法地址应返回失败');

  const none = await providers.testConnection(undefined);
  assert.strictEqual(none.ok, false, '空参数应返回失败');

  console.log('✔ ' + mode + ' 模式全部断言通过');
  server.close();
}

(async function main() {
  await run('modern');
  await run('legacy');
  console.log('\n全部自检通过 ✅');
})().catch((e) => {
  console.error('\n✘ 自检失败:', e && e.stack ? e.stack : e);
  process.exit(1);
});
