'use strict';
/**
 * Proxmox VE 端到端自检：启动 Mock PVE REST 服务，验证客户端的
 * 取数、归一化、聚合与 LXC / QEMU 启停流程。
 * 用法: node tools/selftest-proxmox.js
 */
const assert = require('assert');
const proxmox = require('../src/proxmox');
const { createServer, VALID_TOKEN, VALID_SECRET } = require('./mock-proxmox');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function log(snap) {
  console.log('server   :', snap.server.name, '| PVE', snap.server.version,
    '| uptime', snap.server.uptimeText, '| 内核', snap.server.kernel);
  console.log('cpu      :', snap.cpu.pct && snap.cpu.pct.toFixed(1) + '%', '|', snap.cpu.label);
  console.log('ram      :', snap.ram.pct && snap.ram.pct.toFixed(1) + '%', '|', snap.ram.usedText, '/', snap.ram.totalText);
  console.log('disk     :', snap.disk.pct && snap.disk.pct.toFixed(1) + '%', '|', snap.disk.usedText, '/', snap.disk.totalText, '| 剩余', snap.disk.freeText);
  console.log('net      :', snap.net.iface, '|', snap.ip, '|', snap.net.speedText, '| 下载', snap.net.rxText, '/ 上传', snap.net.txText);
  console.log('lxc      :', snap.docker.ok ? snap.docker.items.length + ' 个' : 'ERR ' + snap.docker.error);
  snap.docker.items.forEach((i) => console.log('   -', 'CT' + i.vmid, (i.name || '').padEnd(20), i.stateLabel, i.memText || ''));
  console.log('qemu     :', snap.vms.ok ? snap.vms.items.length + ' 台' : 'ERR ' + snap.vms.error);
  snap.vms.items.forEach((i) => console.log('   -', 'VM' + i.vmid, (i.name || '').padEnd(20), i.stateLabel, i.memText || ''));
  if (snap.warnings.length) console.log('warnings :', snap.warnings);
}

async function run() {
  const server = createServer();
  const port = await listen(server);
  const cfg = {
    type: 'proxmox',
    url: 'http://127.0.0.1:' + port,
    apiKey: VALID_TOKEN + '=' + VALID_SECRET,
    allowSelfSigned: true,
  };

  console.log('\n===== MOCK PROXMOX VE =====');
  const snap = await proxmox.fetchSnapshot(cfg);
  log(snap);

  /* ---- 基本取数 ---- */
  assert.ok(snap.ok, '快照应成功');
  assert.strictEqual(snap.provider, 'proxmox', 'provider 标识');
  assert.strictEqual(snap.warnings.length, 0, '不应有区块降级告警: ' + JSON.stringify(snap.warnings));
  assert.strictEqual(snap.server.versionPrefix, 'PVE', '版本前缀');
  assert.strictEqual(snap.server.version, '8.4.1', 'PVE 版本号');
  assert.strictEqual(snap.server.name, 'pve', '主节点名');
  assert.strictEqual(snap.docker.label, 'LXC 容器', '容器区块标题');
  assert.strictEqual(snap.vms.label, 'QEMU 虚拟机', '虚拟机区块标题');

  /* ---- 指标 ---- */
  assert.ok(snap.cpu.pct > 0 && snap.cpu.pct <= 100, 'CPU 使用率应在 0-100');
  assert.strictEqual(snap.cpu.cores, 8, '物理核心数');
  assert.strictEqual(snap.cpu.threads, 16, '逻辑处理器数');
  assert.ok(/Xeon/.test(snap.cpu.brand), 'CPU 型号: ' + snap.cpu.brand);
  assert.ok(snap.ram.pct > 0 && snap.ram.pct < 100, '内存使用率');
  assert.strictEqual(snap.ram.totalText, '64.0 GB', '内存总量');
  assert.ok(snap.disk.pct > 0 && snap.disk.pct < 100, '存储使用率');
  assert.ok(snap.disk.freeText !== '—', '剩余空间');
  assert.ok(/^\d{4}/.test(snap.server.uptimeText) || /天/.test(snap.server.uptimeText), '运行时间文案');

  /* ---- 存储汇总：三个 active 池相加（zfs-backup 为 inactive 应被排除）----
     total = 100G + 465.8G + 2T ≈ 2.54 TB */
  const expectTotal = 107374182400 + 500107862016 + 2199023255552;
  assert.strictEqual(snap.disk.totalText, require('../src/format').fmtSize(expectTotal),
    '存储容量应为三个 active 池之和（排除 inactive）: ' + snap.disk.totalText);

  /* ---- 网络：必须挑中 vmbr0（有 IP + active），而不是 lo ---- */
  assert.strictEqual(snap.ip, '192.168.1.20', '主网卡 IP（不应是 127.0.0.1）');
  assert.strictEqual(snap.net.iface, 'vmbr0', '主网卡名');
  assert.strictEqual(snap.net.linkMbps, 1000, '链路速率');
  assert.strictEqual(snap.net.speedText, '1 Gbps', '速率文案');
  assert.ok(snap.net.rx > 0 && snap.net.tx > 0, '应取到实时吞吐');
  assert.ok(/\/s$/.test(snap.net.rxText) && /\/s$/.test(snap.net.txText), '吞吐文案应带 /s');

  /* ---- 内核 ---- */
  assert.ok(/6\.8\.12-4-pve/.test(snap.server.kernel), '内核版本: ' + snap.server.kernel);

  /* ---- 列表 ---- */
  assert.ok(snap.docker.ok && snap.docker.items.length === 5, 'LXC 数量');
  assert.ok(snap.vms.ok && snap.vms.items.length === 4, 'QEMU 数量');
  assert.ok(snap.docker.items.every((i) => i.type === 'lxc'), '全为 LXC');
  assert.ok(snap.vms.items.every((i) => i.type === 'qemu'), '全为 QEMU');
  assert.ok(snap.docker.items.every((i) => i.id === i.node + '/lxc/' + i.vmid), 'id 组合正确');
  assert.ok(snap.vms.items.every((i) => i.id === i.node + '/qemu/' + i.vmid), 'id 组合正确');
  /* PVE 不提供图标 -> 必须走首字母头像，且 initial 有值 */
  assert.ok(snap.vms.items.every((i) => i.icon == null && i.initial), 'QEMU 应走首字母头像');
  assert.ok(snap.docker.items.every((i) => i.icon == null && i.initial), 'LXC 应走首字母头像');
  /* 排序：运行中优先 */
  const firstStopped = snap.docker.items.findIndex((i) => !i.running);
  if (firstStopped >= 0) {
    assert.ok(snap.docker.items.slice(firstStopped).every((i) => !i.running), '运行中的应排在前面');
  }
  /* 模板标记 */
  const tpl = snap.docker.items.find((i) => i.vmid === 104);
  assert.ok(tpl && tpl.template && tpl.stateLabel === '模板', '模板容器应被标记');

  /* ---- 面板明细字段 ---- */
  const running = snap.vms.items.find((i) => i.vmid === 200 && i.running);
  assert.ok(running, '存在运行中的 QEMU');
  assert.ok(running.memText && /\/ /.test(running.memText), '内存明细文案');
  // 回归：cpu 是 0..1 占整机比例 ⇒ ×100 取整。vmid=200 的 cpu=0.267 ⇒ 27%
  assert.strictEqual(running.cpuText, '27%', 'CPU 明细应为占整机百分比（0..1 比例 ×100）');
  assert.ok(running.uptimeText, '运行时间明细');
  assert.ok(running.tags === 'desktop;windows', '标签透传');
  // 回归：核数字段名是 `cpus`（列表接口不返回 maxcpu）
  assert.strictEqual(running.cores, 8, '核心数应取 cpus 字段');

  /* ---- LXC 停止 → 启动 ---- */
  const ctStopped = snap.docker.items.find((i) => !i.running && !i.template);
  assert.ok(ctStopped, '存在已停止的 LXC');
  await proxmox.containerAction(cfg, ctStopped.id, 'start');
  const s2 = await proxmox.fetchSnapshot(cfg);
  assert.ok(s2.docker.items.find((i) => i.id === ctStopped.id).running, 'LXC 应已启动');

  await proxmox.containerAction(cfg, ctStopped.id, 'stop');
  const s3 = await proxmox.fetchSnapshot(cfg);
  assert.ok(!s3.docker.items.find((i) => i.id === ctStopped.id).running, 'LXC 应已停止');

  /* ---- QEMU 启动 → 强制停止 → 重启 ---- */
  const vmStopped = snap.vms.items.find((i) => !i.running);
  assert.ok(vmStopped, '存在已停止的 QEMU');
  await proxmox.guestAction(cfg, vmStopped.id, 'start');
  const s4 = await proxmox.fetchSnapshot(cfg);
  assert.ok(s4.vms.items.find((i) => i.id === vmStopped.id).running, 'QEMU 应已启动');

  await proxmox.guestAction(cfg, vmStopped.id, 'forceStop');
  const s5 = await proxmox.fetchSnapshot(cfg);
  assert.ok(!s5.vms.items.find((i) => i.id === vmStopped.id).running, 'QEMU 应已强制停止');

  await proxmox.guestAction(cfg, running.id, 'restart');
  const s6 = await proxmox.fetchSnapshot(cfg);
  assert.ok(s6.vms.items.find((i) => i.id === running.id).running, 'QEMU 重启后应仍在运行');

  /* ---- 错误路径 ---- */
  await assert.rejects(
    () => proxmox.guestAction(cfg, 'pve/qemu/999', 'start'),
    /no such VM/,
    '不存在的 VMID 应报错'
  );
  await assert.rejects(
    () => proxmox.containerAction(cfg, 'pve/qemu/200', 'start'),
    /不是 LXC/,
    '把 QEMU id 传给容器操作应被拒绝'
  );
  await assert.rejects(
    () => proxmox.guestAction(cfg, 'pve/lxc/100', 'start'),
    /不是 QEMU/,
    '把 LXC id 传给虚拟机操作应被拒绝'
  );

  /* ---- 异步任务失败路径（回归：PVE 启停是异步的，HTTP 200 + UPID，
   *      真实错误在任务 exitstatus 里，必须轮询才能发现）---- */
  await assert.rejects(
    () => proxmox.guestAction(cfg, 'pve/qemu/999', 'start'),
    /no such VM/,
    '不存在的 QEMU：任务 exitstatus 应被识别为失败'
  );
  await assert.rejects(
    () => proxmox.containerAction(cfg, 'pve/lxc/999', 'start'),
    /no such VM/,
    '不存在的 LXC：任务 exitstatus 应被识别为失败'
  );
  // 已运行再启动：应报 already running，而不是假成功
  await assert.rejects(
    () => proxmox.guestAction(cfg, 'pve/qemu/200', 'start'),
    /already running/,
    '已运行的 QEMU 再启动应报 already running'
  );
  // 模板不可启动
  await assert.rejects(
    () => proxmox.containerAction(cfg, 'pve/lxc/104', 'start'),
    /template/,
    '模板容器不可启动'
  );

  /* ---- 连接测试 ---- */
  const t = await proxmox.testConnection(cfg);
  assert.ok(t.ok, '连接测试应成功: ' + t.error);
  assert.strictEqual(t.provider, 'proxmox');
  assert.strictEqual(t.version, '8.4.1');
  assert.strictEqual(t.hostname, 'pve');
  assert.ok(/\/api2\/json$/.test(t.endpoint), '端点应规范化: ' + t.endpoint);

  /* ---- 鉴权失败 ---- */
  const bad = await proxmox.testConnection({ type: 'proxmox', url: 'http://127.0.0.1:' + port, apiKey: 'wrong@t!x=y' });
  assert.strictEqual(bad.ok, false, '错误 Token 应失败');
  assert.ok(/鉴权失败|401/.test(bad.error), '应给出鉴权错误提示: ' + bad.error);

  const noKey = await proxmox.testConnection({ type: 'proxmox', url: 'http://127.0.0.1:' + port, apiKey: '' });
  assert.strictEqual(noKey.ok, false, '空 Token 应失败');

  const dead = await proxmox.testConnection({ type: 'proxmox', url: 'http://127.0.0.1:1', apiKey: 'a@b!c=d' });
  assert.strictEqual(dead.ok, false, '不可达地址应失败');
  assert.ok(dead.error, '应带回错误信息');

  const none = await proxmox.testConnection(undefined);
  assert.strictEqual(none.ok, false, '空参数应失败');

  /* ---- Token 两种填写方式等价 ---- */
  const split = { type: 'proxmox', url: 'http://127.0.0.1:' + port, apiKey: VALID_SECRET, tokenId: VALID_TOKEN };
  const t2 = await proxmox.testConnection(split);
  assert.ok(t2.ok, 'tokenId + secret 分填也应可用: ' + t2.error);

  server.close();
  console.log('✔ Proxmox VE 全部断言通过');
}

(async function main() {
  await run();
  console.log('\nPVE 自检通过 ✅');
})().catch((e) => {
  console.error('\n✘ PVE 自检失败:', e && e.stack ? e.stack : e);
  process.exit(1);
});
