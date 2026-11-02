'use strict';
/**
 * 本地 Mock Synology DSM 服务 —— 无需真实群晖即可预览挂件 / 跑自检。
 *
 * 用法:
 *   node tools/mock-dsm.js                       # 默认：已装 Docker + VMM
 *   MOCK_DSM_NO_DOCKER=1 node tools/mock-dsm.js  # 不装 Container Manager
 *   MOCK_DSM_NO_VMM=1 node tools/mock-dsm.js     # 不装 VMM
 *   MOCK_DSM_OTP=123456 node tools/mock-dsm.js   # 强制两步验证（首次登录返回 403）
 *   PORT=8098 node tools/mock-dsm.js
 *
 * 然后在挂件引导页里选「Synology DSM」并填:
 *   服务器地址: http://127.0.0.1:8098
 *   账号: admin      密码: demo-pass
 *
 * 说明：Mock 走明文 HTTP；客户端 normalizeEndpoint 在显式 http:// 时保留协议。
 */
const http = require('http');

const VALID_USER = process.env.MOCK_DSM_USER || 'admin';
const VALID_PASS = process.env.MOCK_DSM_PASS || 'demo-pass';
const OTP_CODE = process.env.MOCK_DSM_OTP || '';           // 非空则启用两步验证
const NO_DOCKER = process.env.MOCK_DSM_NO_DOCKER === '1';
const NO_VMM = process.env.MOCK_DSM_NO_VMM === '1';

const BOOT = Date.now() - (14 * 86400 + 6 * 3600 + 24 * 60) * 1000;

/* ------------------------------------------------------------------ 数据 */
const containers = [
  { id: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2', name: 'emby', image: 'lovechen/embyserver:latest', cmd: '/init', created: 1692757028, status: 'running', up_status: 'Up 22 hours', up_time: Math.floor(Date.now() / 1000) - 22 * 3600, ExitCode: 0, Running: true, Paused: false },
  { id: 'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3', name: 'qbittorrent', image: 'linuxserver/qbittorrent:latest', cmd: '/init', created: 1692756642, status: 'running', up_status: 'Up 22 hours', up_time: Math.floor(Date.now() / 1000) - 22 * 3600, ExitCode: 0, Running: true, Paused: false },
  { id: 'c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4', name: 'qinglong', image: 'whyour/qinglong:latest', cmd: './docker/docker-entrypoint.sh', created: 1692755214, status: 'running', up_status: 'Up 22 hours (healthy)', up_time: Math.floor(Date.now() / 1000) - 22 * 3600, ExitCode: 0, Running: true, Paused: false },
  { id: 'd4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5', name: 'jellyfin', image: 'jellyfin/jellyfin:latest', cmd: '/jellyfin/jellyfin', created: 1682756551, status: 'running', up_status: 'Up 23 hours (healthy)', up_time: Math.floor(Date.now() / 1000) - 23 * 3600, ExitCode: 0, Running: true, Paused: false },
  { id: 'e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6', name: 'ChatGPT', image: 'pengzhile/pandora:latest', cmd: 'bin/startup.sh', created: 1692754747, status: 'stopped', up_status: 'Exited (137) 10 days ago', up_time: 1694165421, ExitCode: 137, Running: false, Paused: false },
  { id: 'f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7', name: 'clash', image: 'dreamacro/clash:latest', cmd: '/clash', created: 1684305292, status: 'running', up_status: 'Up 2 days', up_time: Math.floor(Date.now() / 1000) - 2 * 86400, ExitCode: 0, Running: true, Paused: false },
  { id: 'a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8', name: 'moviepilot', image: 'jxxghp/moviepilot:latest', cmd: '/app/start.sh', created: 1690879348, status: 'stopped', up_status: 'Exited (0) 2 months ago', up_time: 1690879348, ExitCode: 0, Running: false, Paused: false },
];

const guests = [
  { guest_id: '5791b53f-6770-41b7-b4a7-b58de9399ff0', name: 'DSM7.2', status: 'running', vcpu_num: 4, vcpu_usage: 60, ram_used: 4318692, host_ram_size: 4096, ip: '192.168.0.135', host_name: 'dsm-nas', dsm_version: 'DSM 7.2-64570 Update 3', vdisk_num: 3, video_card: 'cirrus' },
  { guest_id: '6a82c64e-7881-42c8-b5b8-c69ef9400a01', name: 'Windows11', status: 'running', vcpu_num: 8, vcpu_usage: 27, ram_used: 12582912, host_ram_size: 16384, ip: '192.168.0.140', host_name: 'dsm-nas', dsm_version: '', vdisk_num: 2, video_card: 'vga' },
  { guest_id: '7b93d75f-8992-43d9-c6c9-d7af0511b112', name: 'Ubuntu-Server', status: 'shutdown', vcpu_num: 4, vcpu_usage: 0, ram_used: 0, host_ram_size: 8192, ip: '192.168.0.141', host_name: 'dsm-nas', dsm_version: '', vdisk_num: 1, video_card: 'vga' },
  { guest_id: '8ca4e860-9aa3-44ea-d7da-e8bf1622c223', name: 'OpenWrt', status: 'paused', vcpu_num: 2, vcpu_usage: 3, ram_used: 524288, host_ram_size: 1024, ip: '192.168.0.142', host_name: 'dsm-nas', dsm_version: '', vdisk_num: 1, video_card: 'vga' },
];

const volumes = [
  { volume_id: 1, display_name: '存储空间 1', size_total_byte: '13429160144896', size_free_byte: '13429136093184', fs_type: 'btrfs', status: 'normal', volume_path: '/volume1', raid_type: 'shr_without_disk_protect', crashed: false, readonly: false, location: 'internal' },
  { volume_id: 3, display_name: '存储空间 3', size_total_byte: '2875817492480', size_free_byte: '36847812608', fs_type: 'btrfs', status: 'attention', volume_path: '/volume3', raid_type: 'shr_without_disk_protect', crashed: false, readonly: false, location: 'internal' },
  { volume_id: 4, display_name: '存储空间 4', size_total_byte: '11515377745920', size_free_byte: '164999397376', fs_type: 'btrfs', status: 'normal', volume_path: '/volume4', raid_type: 'shr_without_disk_protect', crashed: false, readonly: false, location: 'internal' },
];

function makeState() {
  return { sid: null, deviceId: null, tick: 0, otpPending: false, sessions: new Map() };
}

/* ------------------------------------------------------- API 目录（套件探测） */
function apiCatalog() {
  const cat = {
    'SYNO.API.Auth': { maxVersion: 7, minVersion: 1, path: 'auth.cgi' },
    'SYNO.API.Info': { maxVersion: 1, minVersion: 1, path: 'query.cgi' },
    'SYNO.Core.System': { maxVersion: 3, minVersion: 1, path: 'entry.cgi' },
    'SYNO.Core.System.Utilization': { maxVersion: 1, minVersion: 1, path: 'entry.cgi' },
    'SYNO.Core.Storage.Volume': { maxVersion: 1, minVersion: 1, path: 'entry.cgi' },
  };
  if (!NO_DOCKER) cat['SYNO.Docker.Container'] = { maxVersion: 1, minVersion: 1, path: 'entry.cgi' };
  if (!NO_VMM) {
    cat['SYNO.Virtualization.Guest'] = { maxVersion: 1, minVersion: 1, path: 'entry.cgi' };
    cat['SYNO.Virtualization.Guest.Action'] = { maxVersion: 1, minVersion: 1, path: 'entry.cgi' };
  }
  return cat;
}

/* ------------------------------------------------------------------ 响应体 */
function systemInfo() {
  return {
    cpu_clock_speed: 1996,
    cpu_cores: '4',
    cpu_family: 'Celeron',
    cpu_series: 'J3455',
    cpu_vendor: 'INTEL',
    enabled_ntp: true,
    external_pci_slot_info: [],
    firmware_date: '2024/05/08',
    firmware_ver: 'DSM 7.2.1-69057 Update 5',
    model: 'DS918+',
    ntp_server: 'pool.ntp.org',
    ram_size: 8192,
    sata_dev: [],
    serial: '17A0PDN881802',
    support_esata: 'no',
    sys_temp: 45,
    sys_tempwarn: false,
    systempwarn: false,
    temperature_warning: false,
    time: new Date().toISOString().slice(0, 19).replace('T', ' '),
    time_zone: 'Beijing',
    time_zone_desc: '(GMT+08:00) Beijing, Chongqing, Hong Kong, Urumqi',
    up_time: '336:6:24',
    usb_dev: [],
  };
}

function networkInfo() {
  return {
    dns: '192.168.0.1',
    enabled_domain: false,
    enabled_samba: true,
    gateway: '192.168.0.1',
    hostname: 'dsm-nas',
    nif: [
      { id: 'lo', addr: '127.0.0.1', status: 'connected', type: 'loopback', speed: 0, mask: '255.0.0.0', mtu: 65536, mac: '00-00-00-00-00-00' },
      { id: 'ovs_eth0', addr: '192.168.0.100', status: 'connected', type: 'ovseth', speed: 1000, duplex: true, mask: '255.255.255.0', mtu: 1500, mac: '00-11-32-82-6E-3F', use_dhcp: false, ipv6: [{ addr: 'fe80::211:32ff:fe82:6e3f', prefix_len: 64, scope: 'link' }] },
      { id: 'docker0', addr: '172.17.0.1', status: 'connected', type: 'bridge', speed: 0, mask: '255.255.0.0', mtu: 1500, mac: '02-42-AC-11-00-02' },
    ],
    wins: '',
    workgroup: 'WORKGROUP',
  };
}

function utilization(st) {
  st.tick++;
  const wave = (b, a, p) => Math.max(0, Math.round(b + a * Math.sin(st.tick / p)));
  const memKb = 8388608;                          // KB（= 8192 MB = 8 GB，与机型 ram_size 一致）
  const memUsage = 38 + 8 * Math.sin(st.tick / 5);
  const memUsedKb = Math.round(memKb * memUsage / 100);
  return {
    cpu: {
      '1min_load': 141, '5min_load': 234, '15min_load': 163,
      device: 'System',
      other_load: wave(2, 1, 4),
      system_load: wave(4, 2, 3),
      user_load: wave(8, 5, 2),
    },
    disk: {
      disk: [
        { device: 'sda', display_name: 'Drive 1', type: 'internal', utilization: 7, read_byte: 0, write_byte: 458410, read_access: 0, write_access: 24 },
        { device: 'sdc', display_name: 'Drive 3', type: 'internal', utilization: 2, read_byte: 0, write_byte: 594517, read_access: 0, write_access: 38 },
      ],
      total: { device: 'total', utilization: 3, read_byte: 0, write_byte: 1052927, read_access: 0, write_access: 62 },
    },
    memory: {
      avail_real: memKb - memUsedKb,
      avail_swap: 4610020,
      buffer: 16888,
      cached: 4283888,
      device: 'Memory',
      memory_size: memKb,                          // KB
      real_usage: Math.round(memUsage),
      si_disk: 0,
      so_disk: 0,
      swap_usage: 33,
      total_real: memKb,                           // KB
      total_swap: 6913964,
    },
    network: [
      { device: 'total', rx: Math.max(1024, wave(10332, 8000, 2)), tx: Math.max(512, wave(28418, 20000, 2.3)) },
      { device: 'ovs_eth0', rx: Math.max(1024, wave(10332, 8000, 2)), tx: Math.max(512, wave(28418, 20000, 2.3)) },
    ],
    time: Math.floor(Date.now() / 1000),
  };
}

/* -------------------------------------------------------------- 请求处理 */
function createServer() {
  const state = makeState();

  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;

    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
    };

    // 读 body（表单）
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let params = {};
      try { params = Object.fromEntries(new URLSearchParams(raw)); } catch (_) { /* 忽略 */ }
      // GET 时参数在 query
      for (const [k, v] of u.searchParams.entries()) if (params[k] === undefined) params[k] = v;

      // 解析 data 里的 JSON 数组/对象字段（resource / additional 等）
      const jsonField = (k, d) => { try { return JSON.parse(params[k]); } catch (_) { return d; } };

      /* ---------------- 首页提示 ---------------- */
      if (p === '/' || p === '/webapi' || p === '/webapi/') {
        send(200, { ok: true, hint: 'DSM mock —— 请调用 /webapi/entry.cgi?api=...&method=...' });
        return;
      }

      /* ---------------- query.cgi：API 目录 ---------------- */
      if (p === '/webapi/query.cgi' || (params.api === 'SYNO.API.Info' && params.method === 'query')) {
        send(200, { success: true, data: apiCatalog() });
        return;
      }

      /* ---------------- entry.cgi / auth.cgi ---------------- */
      const isEntry = p === '/webapi/entry.cgi' || p === '/webapi/auth.cgi' ||
        p === '/webapi/entry.cgi/' || p === '/webapi/entry.cgi' ||
        p.startsWith('/webapi/entry.cgi/');
      // 子路径形式 /webapi/entry.cgi/SYNO.Xxx.Yyy
      const sub = (p.match(/^\/webapi\/entry\.cgi\/(.+)$/) || [])[1];
      if (sub && !params.api) params.api = decodeURIComponent(sub);

      if (!isEntry && !p.startsWith('/webapi/auth.cgi')) {
        // 其他 cgi：DSM 会返回 102（API 不存在）
        send(200, { success: false, error: { code: 102 } });
        return;
      }

      const api = params.api;
      const method = params.method;

      /* ---- 登录 ---- */
      if (api === 'SYNO.API.Auth' && method === 'login') {
        if (String(params.account || '') !== VALID_USER || String(params.passwd || '') !== VALID_PASS) {
          send(200, { success: false, error: { code: 400 } });
          return;
        }
        if (OTP_CODE) {
          const otp = String(params.otp_code || '');
          if (!otp) { send(200, { success: false, error: { code: 403 } }); return; }
          if (otp !== OTP_CODE) { send(200, { success: false, error: { code: 404 } }); return; }
        }
        const sid = 'MOCK-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        const deviceId = 'MOCKDEV-' + Math.random().toString(36).slice(2).toUpperCase();
        state.sessions.set(sid, { user: VALID_USER, ts: Date.now() });
        send(200, {
          success: true,
          data: { sid, device_id: deviceId, ik_message: '', is_portal_port: false, synotoken: '--------' },
        });
        return;
      }

      /* ---- 登出 ---- */
      if (api === 'SYNO.API.Auth' && method === 'logout') {
        state.sessions.delete(String(params._sid || ''));
        send(200, { success: true, data: {} });
        return;
      }

      /* ---- 会话校验（除登录/登出外都需要 _sid） ---- */
      const sid = String(params._sid || req.headers.sid || '');
      if (!sid || !state.sessions.has(sid)) {
        send(200, { success: false, error: { code: 119 } });
        return;
      }

      /* ---- 系统信息 ---- */
      if (api === 'SYNO.Core.System' && method === 'info') {
        if (params.type === 'network') { send(200, { success: true, data: networkInfo() }); return; }
        send(200, { success: true, data: systemInfo() });
        return;
      }

      /* ---- 实时资源 ---- */
      if (api === 'SYNO.Core.System.Utilization' && method === 'get') {
        send(200, { success: true, data: utilization(state) });
        return;
      }

      /* ---- 存储卷 ---- */
      if (api === 'SYNO.Core.Storage.Volume' && method === 'list') {
        send(200, {
          success: true,
          data: { offset: 0, total: volumes.length, volumes: volumes.map((v) => ({ ...v })) },
        });
        return;
      }

      /* ---- Docker 容器 ---- */
      if (api === 'SYNO.Docker.Container') {
        if (NO_DOCKER) { send(200, { success: false, error: { code: 102 } }); return; }
        if (method === 'list') {
          send(200, {
            success: true,
            data: {
              limit: containers.length,
              offset: 0,
              total: containers.length,
              containers: containers.map(containerJson),
            },
          });
          return;
        }
        const name = String(params.name || '');
        const c = containers.find((x) => x.name === name);
        if (!c) {
          // 真实 DSM 对不存在的容器返回 117（操作失败：目标不存在）
          send(200, { success: false, error: { code: 117 } });
          return;
        }
        if (method === 'start') {
          if (c.status === 'running') { send(200, { success: false, error: { code: 100 } }); return; }
          c.status = 'running'; c.Running = true; c.up_status = 'Up 1 second';
          c.up_time = Math.floor(Date.now() / 1000); c.ExitCode = 0;
          send(200, { success: true, data: {} });
          return;
        }
        if (method === 'stop') {
          if (c.status === 'stopped') { send(200, { success: false, error: { code: 100 } }); return; }
          c.status = 'stopped'; c.Running = false; c.up_status = 'Exited (0) 1 second ago';
          send(200, { success: true, data: {} });
          return;
        }
        if (method === 'restart') {
          // 真实 DSM 的 restart 对已停止容器会把它**重新启动**（实测），并非报错
          c.status = 'running'; c.Running = true; c.up_status = 'Up 1 second';
          c.up_time = Math.floor(Date.now() / 1000); c.ExitCode = 0;
          send(200, { success: true, data: {} });
          return;
        }
        send(200, { success: false, error: { code: 103 } });
        return;
      }

      /* ---- 虚拟机 ---- */
      if (api === 'SYNO.Virtualization.Guest' && method === 'list') {
        if (NO_VMM) { send(200, { success: false, error: { code: 102 } }); return; }
        send(200, { success: true, data: { canHA: false, canMove: true, is_freeze: false, guests: guests.map(guestJson) } });
        return;
      }
      if (api === 'SYNO.Virtualization.Guest.Action' && method === 'pwr_ctl') {
        if (NO_VMM) { send(200, { success: false, error: { code: 102 } }); return; }
        const gid = String(params.guest_id || '');
        const g = guests.find((x) => x.guest_id === gid);
        if (!g) { send(200, { success: false, error: { code: 101 } }); return; }
        const act = String(params.action || '');
        const map = { start: 'running', shutdown: 'shutdown', poweroff: 'shutdown', reboot: 'running', suspend: 'paused', resume: 'running' };
        const want = map[act];
        if (!want) { send(200, { success: false, error: { code: 103 } }); return; }
        if (act === 'start' && g.status === 'running') { send(200, { success: false, error: { code: 100 } }); return; }
        if ((act === 'shutdown' || act === 'poweroff') && g.status === 'shutdown') { send(200, { success: false, error: { code: 100 } }); return; }
        g.status = want;
        if (want === 'shutdown') { g.vcpu_usage = 0; g.ram_used = 0; }
        send(200, { success: true, data: {} });
        return;
      }

      send(200, { success: false, error: { code: 102 } });
    });
  });
}

/** 容器 JSON（把扁平状态还原成 DSM 的 State 嵌套结构） */
function containerJson(c) {
  return {
    id: c.id,
    name: c.name,
    image: c.image,
    cmd: c.cmd,
    created: c.created,
    finish_time: c.up_time,
    is_ddsm: false,
    is_package: false,
    services: null,
    status: c.status,
    up_status: c.up_status,
    up_time: c.up_time,
    enable_service_portal: false,
    exporting: false,
    State: {
      Dead: false, Error: '', ExitCode: c.ExitCode,
      FinishedAt: new Date(c.up_time * 1000).toISOString(),
      FinishedTs: c.up_time,
      OOMKilled: false, Paused: c.Paused, Pid: c.Running ? 12345 : 0,
      Restarting: false, Running: c.Running,
      StartedAt: new Date(c.up_time * 1000).toISOString(),
      StartedTs: c.up_time,
      Status: c.status,
    },
  };
}

function guestJson(g) {
  return {
    guest_id: g.guest_id,
    name: g.name,
    status: g.status,
    vcpu_num: g.vcpu_num,
    vcpu_usage: g.vcpu_usage,
    ram_used: g.ram_used,
    host_ram_size: g.host_ram_size,
    ip: g.ip,
    host_name: g.host_name,
    dsm_version: g.dsm_version,
    vdisk_num: g.vdisk_num,
    video_card: g.video_card,
    is_online: g.status === 'running',
    autorun: 0,
    can_ha: false,
    cpu_passthru: false,
    ha_status: '',
    snap_num: 0,
  };
}

module.exports = { createServer, makeState, apiCatalog, VALID_USER, VALID_PASS, OTP_CODE };

if (require.main === module) {
  const port = Number(process.env.PORT) || 8098;
  const srv = createServer();
  srv.listen(port, '127.0.0.1', () => {
    console.log('Mock Synology DSM 服务已启动');
    console.log('  端点: http://127.0.0.1:' + port + '/webapi/entry.cgi');
    console.log('  套件: Docker=' + (NO_DOCKER ? '未装' : '已装') + '  VMM=' + (NO_VMM ? '未装' : '已装') +
      '  两步验证=' + (OTP_CODE ? '开(' + OTP_CODE + ')' : '关'));
    console.log('  引导页请选「Synology DSM」，地址填 http://127.0.0.1:' + port);
    console.log('  账号填: ' + VALID_USER + '   密码填: ' + VALID_PASS);
  });
}
