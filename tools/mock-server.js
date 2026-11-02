'use strict';
/**
 * 本地 Mock Unraid GraphQL 服务 —— 无需真实服务器即可预览挂件 / 跑自检。
 *
 * 用法:
 *   node tools/mock-server.js                    # 模拟 Unraid 7.3 真实 schema（默认）
 *   MOCK_MODE=legacy node tools/mock-server.js   # 模拟旧版 schema（用于测试字段回退逻辑）
 *   PORT=8099 node tools/mock-server.js
 *
 * 然后在挂件引导页里填:
 *   服务器地址: http://127.0.0.1:8099
 *   API Key:    任意非空字符串（例如 demo）
 *
 * 两种模式的差异刻意对齐真实世界的版本漂移：
 *   modern（Unraid 7.3）: networkInterfaces / info.versions.core.unraid / vms{domain[]} /
 *                         容器 id 为 PrefixedID；docker 无 restart；变更返回对象需子字段选择
 *   legacy              : network / info.versions.unraid / vms 直接是数组 /
 *                         容器 id 为裸值（需加 container: 前缀）；docker 支持 restart
 */
const http = require('http');

const BOOT = Date.now() - (3 * 86400 + 5 * 3600 + 12 * 60) * 1000; // 3 天 5 小时前
const MACHINE = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

function makeState() {
  return {
    containers: [
      { hex: 'a1b2c3d4e5f6', names: ['/plex'], image: 'plexinc/pms-docker:latest', state: 'RUNNING', status: 'Up 3 days', autoStart: true, labels: { 'net.unraid.docker.icon': 'https://raw.githubusercontent.com/example/plex/main/icon.png', 'net.unraid.docker.managed': 'dockerman' } },
      { hex: 'b2c3d4e5f6a1', names: ['/sonarr'], image: 'linuxserver/sonarr:latest', state: 'RUNNING', status: 'Up 3 days', autoStart: true, labels: {} },
      { hex: 'c3d4e5f6a1b2', names: ['/radarr'], image: 'linuxserver/radarr:latest', state: 'EXITED', status: 'Exited (0) 2 hours ago', autoStart: false, labels: {} },
      { hex: 'd4e5f6a1b2c3', names: ['/nginx-proxy-manager'], image: 'jc21/nginx-proxy-manager:latest', state: 'RUNNING', status: 'Up 3 days', autoStart: true, labels: {} },
      { hex: 'e5f6a1b2c3d4', names: ['/postgres'], image: 'postgres:16-alpine', state: 'RUNNING', status: 'Up 3 days', autoStart: true, labels: {} },
      { hex: 'f6a1b2c3d4e5', names: ['/uptime-kuma'], image: 'louislam/uptime-kuma:1', state: 'PAUSED', status: 'Up 3 days (Paused)', autoStart: false, labels: {} },
    ],
    vms: [
      { uuid: '9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f', name: 'Windows 11', state: 'RUNNING' },
      { uuid: '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d', name: 'Ubuntu Server', state: 'RUNNING' },
      { uuid: '2b3c4d5e-6f7a-8b9c-0d1e-2f3a4b5c6d7e', name: 'OpenWrt', state: 'SHUTOFF' },
    ],
    tick: 0,
  };
}

/** 现代模式容器的操作 ID：PrefixedID（机器前缀 + 64 位 hash） */
function modernContainerId(hex) { return MACHINE + ':' + hex.padEnd(64, hex.slice(0, 1)); }
/** 旧版模式容器的操作 ID：裸值（客户端需自行补 container: 前缀） */
function legacyContainerId(hex) { return hex; }

function containerOpId(mode, hex) {
  return mode === 'legacy' ? legacyContainerId(hex) : modernContainerId(hex);
}

/** 各模式下「不存在」的字段片段，用于模拟 schema 版本差异 */
const BANS = {
  modern: [
    'query { network {',                // 7.3 无 Query.network（网卡在根级 networkInterfaces）
    'versions { unraid',                // 7.3 版本在 versions.core 下
    'memory { total active',            // 7.3 用 memory.used
    'capacity { disks {',               // 7.3 优先 kilobytes
    'vms { id name state }',            // 7.3 的 vms 是对象，数组在 domain 下
  ],
  legacy: [
    'networkInterfaces',                // 旧版无此字段
    'versions { core',                  // 旧版版本直接在 versions 上
    'memory { total used free available',
    'capacity { kilobytes {',
    'vms { domain',                     // 旧版 vms 直接是数组
    'baseboard {',                      // 旧版没有 baseboard
    'sensors {',                        // 旧版 metrics 无温度传感器
    'rxSec',                            // 旧版 metrics.network 无实时吞吐
    'cpus {',                           // 旧版 metrics.cpu 无每核心数据
    'created labels',                   // 旧版容器无创建时间/标签
  ],
};

function buildData(q, st, mode) {
  const data = {};
  st.tick++;
  const wave = (base, amp, period) => base + amp * Math.sin(st.tick / period);
  const cpuPct = Math.max(1, Math.min(99, wave(24, 14, 3)));
  const memTotal = 34359738368;               // 32 GiB（字节）
  const memUsed = Math.round(memTotal * (0.41 + 0.05 * Math.sin(st.tick / 5)));
  const kbTotal = 24000000000;                // ~24 TB（KB）
  const kbUsed = Math.round(kbTotal * 0.63);

  if (/\binfo\b/.test(q)) {
    data.info = {
      os: { platform: 'linux', distro: 'Unraid OS', release: '7.3 x86_64', kernel: '6.18.38-Unraid',
            hostname: 'tower', arch: 'x64', uptime: new Date(BOOT).toISOString() },
      cpu: { manufacturer: 'AMD', brand: 'AMD Ryzen 9 5950X 16-Core', model: 'AMD Ryzen 9 5950X',
             cores: 16, threads: 32, speed: 3400 },
      // 现代：版本在 core 下；旧版：直接挂 unraid
      versions: mode === 'legacy'
        ? { unraid: '7.2.0', kernel: '6.6.78' }
        : { core: { unraid: '7.3.2', api: '4.35.1', kernel: '6.18.38-Unraid' } },
      // 主板：现代走 baseboard（旧版被 ban，客户端回退到 system）
      baseboard: /baseboard\s*\{/.test(q)
        ? { manufacturer: 'ASUSTeK COMPUTER INC.', model: 'TUF GAMING B560M-PLUS', version: 'Rev 1.xx' }
        : undefined,
      system: /system\s*\{/.test(q)
        ? { manufacturer: 'ASUSTeK COMPUTER INC.', model: 'TUF GAMING B560M-PLUS' }
        : undefined,
      time: new Date(BOOT).toISOString(),
      hostname: 'tower',
    };
  }
  if (/\bmetrics\b/.test(q)) {
    const perCore = Array.from({ length: 16 }, (_, i) =>
      Math.max(0.4, Math.min(99, cpuPct + 26 * Math.sin(st.tick / 4 + i * 0.9))));
    const rxSec = Math.max(1200, 8_600_000 + 6_000_000 * Math.sin(st.tick / 6));
    const txSec = Math.max(600, 1_900_000 + 1_400_000 * Math.cos(st.tick / 7));
    data.metrics = {
      // 只返回被请求的子字段，以便真正触发客户端的「候选回退」链路
      cpu: /cpus\s*\{/.test(q)
        ? { percentTotal: cpuPct, cpus: perCore.map((v) => ({ percentTotal: v })) }
        : { percentTotal: cpuPct },
      memory: {
        total: String(memTotal),
        used: String(memUsed),
        active: String(memUsed),
        free: String(memTotal - memUsed),
        available: String(memTotal - memUsed),
        percentTotal: (memUsed / memTotal) * 100,
      },
      // 实时吞吐（字节/秒）：br0 为主网卡，lo 只用于验证「挑主网卡」逻辑
      network: /rxSec/.test(q)
        ? [
            { name: 'lo', bytesReceived: '1024', bytesSent: '1024', rxSec: 12, txSec: 12 },
            { name: 'br0', bytesReceived: String(9_000_000_000 + st.tick * 1000),
              bytesSent: String(2_000_000_000 + st.tick * 400), rxSec, txSec },
          ]
        : undefined,
      temperature: /sensors\s*\{/.test(q)
        ? {
            sensors: [
              { name: 'CPU Temp', type: 'CPU', current: { value: 42 + Math.round(4 * Math.sin(st.tick / 5)), unit: 'CELSIUS' } },
              { name: 'Core 0', type: 'CPU_CORE', current: { value: 41, unit: 'CELSIUS' } },
              { name: 'Core 1', type: 'CPU_CORE', current: { value: 43, unit: 'CELSIUS' } },
              { name: 'Mainboard', type: 'MOTHERBOARD', current: { value: 33, unit: 'CELSIUS' } },
            ],
          }
        : undefined,
    };
  }
  if (/\barray\b/.test(q)) {
    data.array = {
      state: 'STARTED',
      capacity: {
        // 只返回被请求的形态，让客户端的候选回退真正生效
        kilobytes: /kilobytes\s*\{/.test(q)
          ? { free: String(kbTotal - kbUsed), used: String(kbUsed), total: String(kbTotal) }
          : undefined,
        // 注意：disks 是「磁盘槽位数量」，不是容量
        disks: /disks\s*\{/.test(q) ? { free: '1', used: '29', total: '30' } : undefined,
      },
    };
  }
  if (/\bnetworkInterfaces\b/.test(q)) {
    data.networkInterfaces = [
      { id: MACHINE + ':info/network/lo', name: 'lo', operstate: 'unknown', speed: null,
        type: 'virtual', ipAddress: '127.0.0.1', virtual: false, macAddress: '00:00:00:00:00:00', mtu: 65536 },
      { id: MACHINE + ':info/network/br0', name: 'br0', operstate: 'up', speed: 1000,
        type: 'wired', ipAddress: '192.168.1.10', virtual: false, macAddress: 'aa:bb:cc:dd:ee:ff', mtu: 1500 },
      { id: MACHINE + ':info/network/vnet0', name: 'vnet0', operstate: 'unknown', speed: 1000,
        type: 'unknown', ipAddress: '', virtual: false, macAddress: 'fe:54:00:11:22:33', mtu: 1500 },
    ];
    if (/\binfo\b/.test(q)) data.info = data.info || { networkInterfaces: data.networkInterfaces };
  }
  if (/\bnetwork\b/.test(q) && !/networkInterfaces/.test(q)) {
    data.network = {
      iface: 'eth0', ifaceName: 'eth0', ipv4: '192.168.1.10', ipv6: 'fe80::aabb:ccff:fedd:eeff',
      mac: 'aa:bb:cc:dd:ee:ff', operstate: 'up', speed: 1000, type: 'ether',
    };
  }
  if (/\bdocker\b/.test(q)) {
    const wantsCreated = /created/.test(q);
    const wantsLabels = /labels/.test(q);
    data.docker = {
      containers: st.containers.map((c, i) => {
        const o = {
          id: containerOpId(mode, c.hex), names: c.names, image: c.image,
          state: c.state, status: c.status, autoStart: c.autoStart,
        };
        if (wantsCreated) o.created = 1700000000 + i * 86400 * 37;  // epoch 秒
        if (wantsLabels) o.labels = c.labels || {};
        return o;
      }),
    };
  }
  if (/\bvms\b/.test(q)) {
    if (mode === 'legacy') {
      data.vms = st.vms.map((v) => ({ id: v.uuid, name: v.name, state: v.state }));
    } else {
      data.vms = {
        id: MACHINE + ':vms',
        domain: st.vms.map((v) => ({ id: MACHINE + ':' + v.uuid, uuid: v.uuid, name: v.name, state: v.state })),
      };
    }
  }
  if (/\bonline\b/.test(q)) data.online = true;
  if (/\bserver\b/.test(q)) data.server = { id: MACHINE + ':local', name: 'tower' };
  return data;
}

/**
 * 处理变更操作。刻意模拟真实 API 的两种约束：
 *  - docker 变更返回 DockerContainer（对象），缺少子字段选择时必须报校验错误
 *  - 容器 id 必须是该模式下 API 认的格式（旧版需 container: 前缀 / VM 需 vm: 前缀），
 *    否则报错，从而让客户端的「前缀回退」逻辑真正被覆盖到
 */
function handleMutation(q, st, mode) {
  // 1) docker 变更缺少子字段选择 → 与真实 API 相同的校验错误
  const missingSel = q.match(/docker\s*\{\s*(start|stop|pause|unpause|updateContainer)\s*\(\s*id:\s*"[^"]*"\s*\)\s*\}/);
  if (missingSel) {
    return { errors: [{ message: 'Field "' + missingSel[1] + '" of type "DockerContainer!" must have a selection of subfields. Did you mean "' + missingSel[1] + ' { ... }"?' }] };
  }

  // 2) docker 变更
  let m = q.match(/docker\s*\{\s*(start|stop|restart|pause|unpause)\s*\(\s*id:\s*"([^"]+)"\s*\)/);
  if (m) {
    const [, action, id] = m;
    if (action === 'restart' && mode !== 'legacy') {
      return { errors: [{ message: 'Cannot query field "restart" on type "DockerMutations". Did you mean "start"?' }] };
    }
    let c = st.containers.find((x) => containerOpId(mode, x.hex) === id);
    if (!c && mode === 'legacy') {
      // 旧版：只认 container: 前缀形式
      const hex = /^container:/.test(id) ? id.replace(/^container:/, '') : null;
      if (hex) c = st.containers.find((x) => x.hex === hex);
    }
    if (!c) return { errors: [{ message: '(HTTP code 404) no such container - No such container: ' + id }] };
    if (action === 'start') { c.state = 'RUNNING'; c.status = 'Up 1 second'; }
    else if (action === 'stop') {
      if (c.state !== 'RUNNING' && c.state !== 'PAUSED') {
        return { errors: [{ message: '(HTTP code 304) container already stopped - ' }] };
      }
      c.state = 'EXITED'; c.status = 'Exited (0) 1 second ago';
    } else if (action === 'restart') { c.state = 'RUNNING'; c.status = 'Up 1 second'; }
    else if (action === 'pause') { c.state = 'PAUSED'; c.status = 'Up 1 second (Paused)'; }
    else if (action === 'unpause') { c.state = 'RUNNING'; c.status = 'Up 1 second'; }
    return { data: { docker: { [action]: { id, state: c.state } } } };
  }

  // 3) VM 变更（返回标量，无需子字段）
  m = q.match(/vm\s*\{\s*(start|stop|forceStop|pause|resume)\s*\(\s*id:\s*"([^"]+)"\s*\)/);
  if (m) {
    const [, action, id] = m;
    let uuid = id;
    if (/^vm:/.test(id)) uuid = id.replace(/^vm:/, '');
    else if (mode === 'legacy') {
      // 旧版只接受 vm:<uuid> 形式
      return { errors: [{ message: 'Failed to set VM state: Invalid UUID' }] };
    }
    const v = st.vms.find((x) => x.uuid === uuid);
    if (!v) return { errors: [{ message: "Failed to set VM state: Domain not found: no domain with matching uuid '" + uuid + "'" }] };
    const want = { start: 'RUNNING', stop: 'SHUTOFF', forceStop: 'SHUTOFF', pause: 'PAUSED', resume: 'RUNNING' }[action];
    if (v.state === want) {
      return { errors: [{ message: 'Failed to set VM state: Invalid state transition from ' + v.state + ' to ' + want }] };
    }
    v.state = want;
    return { data: { vm: { [action]: true } } };
  }

  return null;
}

function createServer(opts) {
  const mode = (opts && opts.mode) || process.env.MOCK_MODE || 'modern';
  const bans = BANS[mode] || [];
  const state = makeState();

  return http.createServer((req, res) => {
    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };

    if (req.method === 'GET') { send(200, { ok: true, mode, hint: 'POST GraphQL 请求到 /graphql' }); return; }
    if (req.method !== 'POST') { send(405, { errors: [{ message: 'Method Not Allowed' }] }); return; }
    if (!req.headers['x-api-key']) { send(401, { errors: [{ message: 'Unauthorized: missing x-api-key' }] }); return; }

    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let q = '';
      try { q = JSON.parse(raw).query || ''; } catch (_) { send(400, { errors: [{ message: 'Bad JSON body' }] }); return; }

      // 模拟 schema 版本差异
      for (const token of bans) {
        if (q.includes(token)) {
          send(200, { errors: [{ message: 'Cannot query field on type "Query" (mock:' + mode + ')' }] });
          return;
        }
      }

      if (/^\s*mutation/m.test(q)) {
        const r = handleMutation(q, state, mode);
        if (r && r.errors) { send(200, { errors: r.errors }); return; }
        if (r) { send(200, { data: r.data }); return; }
        send(200, { errors: [{ message: 'Unknown mutation' }] });
        return;
      }

      send(200, { data: buildData(q, state, mode) });
    });
  });
}

module.exports = { createServer, makeState };

if (require.main === module) {
  const port = Number(process.env.PORT) || 8099;
  const mode = process.env.MOCK_MODE || 'modern';
  createServer({ mode }).listen(port, '127.0.0.1', () => {
    console.log('Mock Unraid GraphQL 服务已启动');
    console.log('  端点: http://127.0.0.1:' + port + '/graphql');
    console.log('  模式: ' + mode + (mode === 'modern' ? '（对齐 Unraid 7.3 真实 schema）' : '（旧版字段）'));
    console.log('  在挂件引导页填入该地址，API Key 随便填（例如 demo）');
  });
}
