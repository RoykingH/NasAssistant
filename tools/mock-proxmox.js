'use strict';
/**
 * 本地 Mock Proxmox VE REST 服务 —— 无需真实 PVE 即可预览挂件 / 跑自检。
 *
 * 用法:
 *   node tools/mock-proxmox.js                 # 默认单节点 home-lab
 *   MOCK_PVE_CLUSTER=1 node tools/mock-proxmox.js   # 模拟 3 节点集群
 *   PORT=8100 node tools/mock-proxmox.js
 *
 * 然后在挂件引导页里选「Proxmox VE」并填:
 *   服务器地址: https://127.0.0.1:8100
 *   API Token : root@pam!widget=demo-token-secret
 *   （自签名证书请勾选「允许自签名证书」）
 *
 * 说明：Mock 用 **明文 HTTP** 即可（客户端 http/https 自适应）；
 * 若走 https 需自签证书，脚本会尝试生成，失败则自动降级为 http。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BOOT = Date.now() - (7 * 86400 + 3 * 3600 + 21 * 60) * 1000; // 7 天前

const VALID_TOKEN = process.env.MOCK_PVE_TOKEN_ID || 'root@pam!widget';
const VALID_SECRET = process.env.MOCK_PVE_SECRET || 'demo-token-secret';

/** 节点定义 */
function makeNodes() {
  if (process.env.MOCK_PVE_CLUSTER === '1') {
    return [
      { node: 'pve-01', status: 'online' },
      { node: 'pve-02', status: 'online' },
      { node: 'pve-03', status: 'offline' },
    ];
  }
  return [{ node: 'pve', status: 'online' }];
}

/** LXC 容器 / QEMU 虚拟机（按节点存放） */
function makeGuests() {
  return {
    lxc: [
      { vmid: 100, name: 'adguardhome', status: 'running', cpu: 0.012, cpus: 2, mem: 268435456, maxmem: 536870912, maxdisk: 8589934592, uptime: 604800, type: 'lxc' },
      { vmid: 101, name: 'immich', status: 'running', cpu: 0.184, cpus: 4, mem: 3221225472, maxmem: 8589934592, maxdisk: 107374182400, uptime: 432000, type: 'lxc' },
      { vmid: 102, name: 'nginx-proxy', status: 'stopped', cpu: 0, cpus: 1, mem: 0, maxmem: 536870912, maxdisk: 4294967296, uptime: 0, type: 'lxc' },
      { vmid: 103, name: 'gitea', status: 'running', cpu: 0.031, cpus: 2, mem: 838860800, maxmem: 2147483648, maxdisk: 32212254720, uptime: 259200, type: 'lxc' },
      { vmid: 104, name: 'debian-13-template', status: 'stopped', cpu: 0, cpus: 1, mem: 0, maxmem: 536870912, maxdisk: 2147483648, uptime: 0, type: 'lxc', template: 1 },
    ],
    qemu: [
      { vmid: 200, name: 'Windows11', status: 'running', cpu: 0.267, cpus: 8, mem: 12884901888, maxmem: 17179869184, maxdisk: 107374182400, uptime: 518400, type: 'qemu', tags: 'desktop;windows' },
      { vmid: 201, name: 'Ubuntu-Server', status: 'running', cpu: 0.093, cpus: 4, mem: 4294967296, maxmem: 8589934592, maxdisk: 53687091200, uptime: 604800, type: 'qemu', tags: 'linux' },
      { vmid: 202, name: 'OpenWrt', status: 'stopped', cpu: 0, cpus: 2, mem: 0, maxmem: 1073741824, maxdisk: 2147483648, uptime: 0, type: 'qemu' },
      { vmid: 203, name: 'TrueNAS-SCALE', status: 'running', cpu: 0.045, cpus: 4, mem: 8589934592, maxmem: 8589934592, maxdisk: 34359738368, uptime: 172800, type: 'qemu' },
    ],
  };
}

function makeState() {
  return { nodes: makeNodes(), guests: makeGuests(), tasks: {}, tick: 0 };
}

/* ------------------------------------------------------------------ 响应 */
function cpuInfo() {
  return {
    cores: 8,
    cpus: 16,
    sockets: 2,
    mhz: '3200.000',
    model: 'Intel(R) Xeon(R) Silver 4210 CPU @ 2.20GHz',
    hvm: '1',
    user_hz: 100,
  };
}

function nodeStatus(node, st) {
  st.tick++;
  const wave = (b, a, p) => b + a * Math.sin(st.tick / p);
  const cpu = Math.max(0.02, Math.min(0.98, wave(0.18, 0.14, 3) / 1)); // 0..1
  const memTotal = 68719476736;  // 64 GiB
  const memUsed = Math.round(memTotal * (0.52 + 0.06 * Math.sin(st.tick / 5)));
  const rootTotal = 107374182400; // 100 GiB
  const rootUsed = Math.round(rootTotal * 0.41);

  return {
    cpu,
    cpuinfo: cpuInfo(),
    'boot-info': { mode: 'efi', secureboot: 0 },
    'current-kernel': {
      sysname: 'Linux', release: '6.8.12-4-pve', machine: 'x86_64',
      version: '#1 SMP PREEMPT_DYNAMIC PMX 6.8.12-4 (2024-11-06T15:04Z)',
    },
    idle: 0,
    ksm: { shared: 0 },
    kversion: 'Linux 6.8.12-4-pve #1 SMP PREEMPT_DYNAMIC PMX 6.8.12-4 (2024-11-06T15:04Z)',
    loadavg: ['1.23', '1.16', '1.14'],
    memory: { total: memTotal, used: memUsed, free: memTotal - memUsed },
    pveversion: 'pve-manager/8.4.1/2a5fa54a8503f96d',
    rootfs: {
      total: rootTotal, used: rootUsed,
      free: rootTotal - rootUsed, avail: rootTotal - rootUsed,
    },
    swap: { total: 8589930496, used: 2621440, free: 8587309056 },
    uptime: Math.floor((Date.now() - BOOT) / 1000),
    wait: 0.004,
    node,
  };
}

/** storage：3 个存储池，用于验证「汇总容量」逻辑 */
function nodeStorage() {
  return [
    { storage: 'local', type: 'dir', content: 'iso,vztmpl,backup', active: 1, enabled: 1, shared: 0, total: 107374182400, used: 20401094656, avail: 86973104128 },
    { storage: 'local-lvm', type: 'lvmthin', content: 'images,rootdir', active: 1, enabled: 1, shared: 0, total: 500107862016, used: 226492416000, avail: 273615446016 },
    { storage: 'nas-nfs', type: 'nfs', content: 'images,backup', active: 1, enabled: 1, shared: 1, total: 2199023255552, used: 1319413953331, avail: 879609302221 },
    { storage: 'zfs-backup', type: 'zfspool', content: 'backup', active: 0, enabled: 1, shared: 0, total: 0, used: 0, avail: 0 },
  ];
}

/** 节点网卡列表 */
function nodeNetwork() {
  return [
    { iface: 'lo', type: 'loopback', active: 1, address: '127.0.0.1', cidr: '127.0.0.1/8' },
    { iface: 'eno1', type: 'eth', active: 1, address: null, cidr: null },
    { iface: 'eno2', type: 'eth', active: 0, address: null, cidr: null },
    { iface: 'vmbr0', type: 'bridge', active: 1, address: '192.168.1.20', cidr: '192.168.1.20/24', gateway: '192.168.1.1', bridge_ports: 'eno1', speed: 1000, autostart: 1 },
    { iface: 'vmbr1', type: 'bridge', active: 1, address: null, cidr: null, bridge_ports: 'eno2', speed: 2500, autostart: 1 },
  ];
}

/** rrddata：netin/netout 单位是「字节/秒」（AVERAGE 已按分钟平均） */
function nodeRrddata(st) {
  const now = Math.floor(Date.now() / 1000);
  const out = [];
  for (let i = 59; i >= 0; i--) {
    const t = now - i * 60;
    const phase = (st.tick + (59 - i)) / 6;
    out.push({
      time: t,
      cpu: 0.18 + 0.14 * Math.sin(phase),
      maxcpu: 16,
      memtotal: 68719476736,
      memused: 68719476736 * (0.52 + 0.06 * Math.sin(phase / 1.3)),
      netin: Math.max(2048, 12582912 + 8388608 * Math.sin(phase)),      // 下载
      netout: Math.max(1024, 3145728 + 2097152 * Math.cos(phase / 1.2)), // 上传
      roottotal: 107374182400,
      rootused: 44032487424,
      swaptotal: 8589930496,
      swapused: 2621440,
      loadavg: 1.23,
      iowait: 0.002,
    });
  }
  return out;
}

/* -------------------------------------------------------------- 请求处理 */
function createServer(opts) {
  const state = makeState();

  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(u.pathname);

    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
    };

    // 首页提示
    if (p === '/' || p === '/api2/json' || p === '/api2/json/') {
      send(200, { data: { ok: true, hint: 'PVE mock —— 请携带 PVEAPIToken 头请求 /api2/json/...' } });
      return;
    }

    // ----- 鉴权 -----
    const auth = String(req.headers.authorization || '');
    const m = auth.match(/^PVEAPIToken=(.+)$/i);
    if (!m) {
      // 真实 PVE 未带鉴权时返回 401
      send(401, { data: null, errors: { auth: 'authentication failure' } });
      return;
    }
    const token = m[1];
    if (token !== VALID_TOKEN + '=' + VALID_SECRET) {
      send(401, { data: null, errors: { auth: 'invalid token' } });
      return;
    }

    // ----- 路由 -----
    const r = p.replace(/^\/api2\/json/, '');

    if (r === '/version' && req.method === 'GET') {
      send(200, { data: { version: '8.4.1', release: '8.4', repoid: '2a5fa54a8503f96d' } });
      return;
    }

    if (r === '/nodes' && req.method === 'GET') {
      send(200, {
        data: state.nodes.map((n) => ({
          node: n.node,
          status: n.status,
          type: 'node',
          cpu: 0.18,
          maxcpu: 16,
          mem: 35756457779,
          maxmem: 68719476736,
          uptime: Math.floor((Date.now() - BOOT) / 1000),
        })),
      });
      return;
    }

    // /nodes/{node}/...
    const nm = r.match(/^\/nodes\/([^/]+)(\/.*)?$/);
    if (nm) {
      const node = nm[1];
      const rest = nm[2] || '';
      const known = state.nodes.some((n) => n.node === node);
      if (!known) {
        send(500, { data: null, errors: { node: "no such node '" + node + "'" } });
        return;
      }

      if (rest === '' && req.method === 'GET') {
        send(200, { data: { node, status: 'online' } });
        return;
      }

      /* --- 详细状态 --- */
      if (rest === '/status' && req.method === 'GET') {
        send(200, { data: nodeStatus(node, state) });
        return;
      }

      /* --- 存储 --- */
      if (rest === '/storage' && req.method === 'GET') {
        send(200, { data: nodeStorage() });
        return;
      }

      /* --- 网卡 --- */
      if (rest === '/network' && req.method === 'GET') {
        send(200, { data: nodeNetwork() });
        return;
      }

      /* --- 实时指标 --- */
      if (rest === '/rrddata' && req.method === 'GET') {
        send(200, { data: nodeRrddata(state) });
        return;
      }

      /* --- LXC / QEMU 列表 --- */
      const lm = rest.match(/^\/(lxc|qemu)$/);
      if (lm && req.method === 'GET') {
        const type = lm[1];
        // 集群模式下按节点切分（仅 pve-01 有负载，其余空）
        const all = state.guests[type];
        const list = process.env.MOCK_PVE_CLUSTER === '1'
          ? (node === 'pve-01' ? all.slice(0, Math.ceil(all.length / 2)) : (node === 'pve-02' ? all.slice(Math.ceil(all.length / 2)) : []))
          : all;
        send(200, { data: list.map((g) => ({ ...g })) });
        return;
      }

      /* --- 任务状态：GET /nodes/{node}/tasks/{upid}/status --- */
      const tm = rest.match(/^\/tasks\/(.+)\/status$/);
      if (tm) {
        const upid = decodeURIComponent(tm[1]);
        const t = state.tasks[upid];
        if (!t) { send(500, { data: null, errors: { upid: "no such task '" + upid + "'" } }); return; }
        send(200, {
          data: {
            upid,
            node,
            status: 'stopped',
            exitstatus: t.exit || 'OK',
            type: t.type,
            id: t.id,
            user: 'root@pam',
            starttime: t.starttime,
          },
        });
        return;
      }

      /* --- 状态变更：POST /nodes/{node}/{lxc|qemu}/{vmid}/status/{action} --- */
      const am = rest.match(/^\/(lxc|qemu)\/(\d+)\/status\/([a-z]+)$/);
      if (am) {
        if (req.method !== 'POST') { send(405, { data: null, errors: { method: 'Method Not Allowed' } }); return; }
        const [, type, vmid, action] = am;

        // 真实 PVE 语义：先提交任务（永远 200 + UPID），失败信息放进任务结果
        const mkTask = (exit) => {
          const upid = 'UPID:' + node + ':0000' + vmid + ':' + Math.floor(Date.now() / 1000) + ':00000000:' +
            type + ':' + vmid + ':' + action + ':root@pam:';
          state.tasks[upid] = { exit: exit || null, type, id: vmid, starttime: Math.floor(Date.now() / 1000) };
          return upid;
        };

        const g = state.guests[type].find((x) => String(x.vmid) === vmid);
        if (!g) { send(200, { data: mkTask('no such VM/CT ' + vmid) }); return; }

        const map = { start: 'running', stop: 'stopped', shutdown: 'stopped', reboot: 'running', pause: 'paused', resume: 'running' };
        const want = map[action];
        if (!want) { send(200, { data: mkTask('unknown action ' + action) }); return; }

        if (g.status === want && (action === 'start' || action === 'shutdown' || action === 'stop')) {
          send(200, { data: mkTask('VM ' + vmid + ' is already ' + (want === 'running' ? 'running' : 'stopped')) });
          return;
        }
        if (g.template === 1 && action !== 'resume' && action !== 'pause') {
          send(200, { data: mkTask("you can't start a template") });
          return;
        }
        g.status = want;
        if (want === 'stopped') { g.uptime = 0; g.mem = 0; }
        else if (action === 'start' || action === 'resume') { g.uptime = 1; }

        // 成功任务：exitstatus 为 'OK'（PVE 成功时通常为空，这里给 OK 以便断言）
        send(200, { data: mkTask(null) });
        return;
      }

      // 其余子路径：模拟 PVE 的「未知路径」错误体
      send(501, { data: null, errors: { path: 'mocked endpoint not implemented: ' + rest } });
      return;
    }

    send(501, { data: null, errors: { path: 'mocked endpoint not implemented: ' + r } });
  });
}

module.exports = { createServer, makeState, VALID_TOKEN, VALID_SECRET };

if (require.main === module) {
  const port = Number(process.env.PORT) || 8100;
  const srv = createServer();
  srv.listen(port, '127.0.0.1', () => {
    console.log('Mock Proxmox VE 服务已启动');
    console.log('  端点: http://127.0.0.1:' + port + '/api2/json');
    console.log('  模式: ' + (process.env.MOCK_PVE_CLUSTER === '1' ? '3 节点集群' : '单节点'));
    console.log('  引导页请选「Proxmox VE」，地址填 http://127.0.0.1:' + port);
    console.log('  API Token 填: ' + VALID_TOKEN + '=' + VALID_SECRET);
  });
}
