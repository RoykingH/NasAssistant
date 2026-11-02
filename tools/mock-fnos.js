'use strict';
/**
 * 本地 Mock fnOS（飞牛私有云）服务 —— 无需真实飞牛即可预览挂件 / 跑自检。
 * ============================================================================
 * 这是一个 **WebSocket 服务端**，完整复刻 fnOS 的握手 + 混合加密 + 签名协议，
 * 且**线格与真实机（fnOS 1.2.0800）逐字段对齐**（2026-10-14 实测）：
 *   - util.crypto.getRSAPub  → {pub, si}（不签名）
 *   - user.login             → 解密 AES+RSA，校验账号密码 → {token, secret, backId, uid, admin}
 *   - 业务请求               → 校验 HMAC-SHA256 签名后返回
 *   - 响应包裹：appcgi.* 用 {data:{...}}，stor.* 直接顶层，dockermgr 用 {rsp:...}
 *   - 错误码：100000004=方法不存在 / 52428803=参数缺失 / 52428814=容器不存在 / 266240=模块不存在
 *   - 心跳：{"req":"ping"} → {"res":"pong"}
 *   - 可选两步验证           → MOCK_FNOS_REQUIRE_OTP=1（验证码 123456）
 *
 * 用法:
 *   node tools/mock-fnos.js                            # 默认（无两步验证，含虚拟机）
 *   MOCK_FNOS_REQUIRE_OTP=1 node tools/mock-fnos.js    # 强制两步验证
 *   MOCK_FNOS_NO_VM=1 node tools/mock-fnos.js          # 模拟「未安装虚拟机模块」（errno 266240）
 *   MOCK_FNOS_NO_DOCKER=1 node tools/mock-fnos.js      # 模拟「未安装 Docker 模块」
 *   MOCK_FNOS_FNID=yyy node tools/mock-fnos.js         # 自定义 FN ID（默认 mocknas）
 *   PORT=8099 node tools/mock-fnos.js
 *
 * 然后在挂件引导页里选「飞牛 fnOS」并填:
 *   服务器地址: 127.0.0.1:8099
 *   账号: admin      密码: demo-pass
 * ========================================================================*/
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const { FrameParser, encodeFrame, acceptKey, OP } = require('../src/ws');

const PORT = Number(process.env.PORT || 8099);
const VALID_USER = process.env.MOCK_FNOS_USER || 'admin';
const VALID_PASS = process.env.MOCK_FNOS_PASS || 'demo-pass';
const OTP_CODE = process.env.MOCK_FNOS_OTP || '123456';
const REQUIRE_OTP = process.env.MOCK_FNOS_REQUIRE_OTP === '1';
const NO_VM = process.env.MOCK_FNOS_NO_VM === '1';
const NO_DOCKER = process.env.MOCK_FNOS_NO_DOCKER === '1';

/** 服务端的 RSA 密钥对（每次启动重新生成） */
const RSA = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/* =========================================================== 错误码（真实机实测） */
const ERR = {
  METHOD_MISSING: 100000004,   // 模块存在但方法不存在
  PARAM_MISSING: 52428803,     // 参数缺失 / 不合法
  NO_CONTAINER: 52428814,      // 找不到指定容器
  NO_MODULE: 266240,           // 模块 / 命名空间不存在
  BAD_CRED: 131072,            // 账号或密码错误
  BAD_TOKEN: 135168,           // 凭证失效
  BAD_OTP: 131073,             // 验证码错误
};

/* =========================================================== 可变数据 */
const BOOT = Date.now() - (9 * 86400 + 4 * 3600 + 12 * 60) * 1000;
const GiB = 1024 * 1024 * 1024;

/** 容器列表（Docker Engine API 风格，与真实 fnOS 一致：Id / Names / Image / State / Status / Created） */
const hex64 = (seed) => crypto.createHash('sha256').update('fnos-mock-' + seed).digest('hex');
let containers = [
  { Id: hex64('emby'), Names: ['/emby'], Image: 'lovechen/embyserver:latest', State: 'running', Status: 'Up 3 days', Created: Date.now() - 3 * 86400, autoStart: true },
  { Id: hex64('jellyfin'), Names: ['/jellyfin'], Image: 'jellyfin/jellyfin:latest', State: 'running', Status: 'Up 3 days', Created: Date.now() - 3 * 86400, autoStart: true },
  { Id: hex64('qbittorrent'), Names: ['/qbittorrent'], Image: 'linuxserver/qbittorrent:latest', State: 'running', Status: 'Up 2 days', Created: Date.now() - 2 * 86400, autoStart: true },
  { Id: hex64('clash'), Names: ['/clash'], Image: 'dreamacro/clash:latest', State: 'running', Status: 'Up 2 days', Created: Date.now() - 2 * 86400, autoStart: true },
  { Id: hex64('qinglong'), Names: ['/qinglong'], Image: 'whyour/qinglong:latest', State: 'exited', Status: 'Exited (0) 5 hours ago', Created: Date.now() - 5 * 86400, autoStart: false },
  { Id: hex64('moviepilot'), Names: ['/moviepilot'], Image: 'jxxghp/moviepilot:latest', State: 'exited', Status: 'Exited (0) 1 day ago', Created: Date.now() - 6 * 86400, autoStart: false },
];

/** 容器实时统计（rsp 以**容器名**为键，与真实机 "none" 键风格一致） */
const STATS = {
  emby: { cpuUsage: 12.4, usedMem: 512 * 1024 * 1024, networkRx: 138240, networkTx: 45056 },
  jellyfin: { cpuUsage: 3.1, usedMem: 384 * 1024 * 1024, networkRx: 20480, networkTx: 8192 },
  qbittorrent: { cpuUsage: 8.7, usedMem: 256 * 1024 * 1024, networkRx: 1048576, networkTx: 262144 },
  clash: { cpuUsage: 1.2, usedMem: 96 * 1024 * 1024, networkRx: 65536, networkTx: 32768 },
  qinglong: { cpuUsage: 0, usedMem: 0, networkRx: 0, networkTx: 0 },
  moviepilot: { cpuUsage: 0, usedMem: 0, networkRx: 0, networkTx: 0 },
};

/**
 * 虚拟机 —— 与真机一致：**不在 WebSocket RPC 里**，而是走 HTTP 的 /vm/api/v1。
 * 字段形状照抄真机实测（2026-10-14，fnOS 1.2.0800 / trim.vm 0.9.0）：
 *   name 是内部标识、title 才是展示名；state 用大写枚举。
 */
let guests = [
  {
    name: 'a1b2c3d4', uuid: '100b8f66-6d90-4353-8ccd-44f649abeed3', title: 'OpenWrt', desc: '',
    state: 'RUNNING', osType: 'linux', osVersion: '6.x - 2.6 Kernel',
    totalDisksCapacity: 0, totalDisksCapacityInBytes: 978321408, clipboard: true,
    info: {
      cpuCoreCnt: 1, memCapacityInBytes: 512 * 1024 * 1024, autostart: true,
      hypervisor: 'kvm', firmware: 'bios', chipset: 'pc', videoType: 'vmvga',
      cpuMode: 'host-passthrough', memCapacityUnit: 'MiB',
      disks: [{ pool: 1, poolName: 'vol1', volumePath: '/vol1/vm/pool/100b8f66-9n1k.qcow2', busType: 'scsi', capacityInBytes: 978321408, capacityUnit: 'MiB' }],
      networks: [{ name: 'vnet0', mac: '52:54:00:11:22:33' }],
    },
    monitor: { cpu: 4.21, memory: 236 * 1024 * 1024, networks: [{ name: 'vnet0', rxBytes: 138240, txBytes: 45056 }] },
  },
  {
    name: '7a1c3d9e', uuid: '5f2a9c14-8b31-4d77-9e02-1c8a4b6d0f31', title: 'Ubuntu-Server', desc: '',
    state: 'SHUTOFF', osType: 'linux', osVersion: '6.x - 2.6 Kernel',
    totalDisksCapacity: 0, totalDisksCapacityInBytes: 0, clipboard: true,
    info: {
      cpuCoreCnt: 4, memCapacityInBytes: 4 * GiB, autostart: false,
      hypervisor: 'kvm', firmware: 'bios', chipset: 'pc', videoType: 'vmvga',
      disks: [{ pool: 1, poolName: 'vol1', volumePath: '/vol1/vm/pool/5f2a9c14-3k2m.qcow2', busType: 'virtio', capacityInBytes: 32 * GiB, capacityUnit: 'MiB' }],
      networks: [],
    },
    monitor: null,
  },
];

/** 初始副本（resetState 用；guests 含嵌套结构故需深拷贝） */
const GUESTS_SEED = JSON.parse(JSON.stringify(guests));

/* =========================================================== 加密 / 签名工具 */
/** 用私钥 + AES 还原客户端发来的加密请求体 */
function decryptEnvelope(msg) {
  const aesKey = crypto.privateDecrypt(
    { key: RSA.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(msg.rsa, 'base64')
  );
  const iv = Buffer.from(msg.iv, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
  const plain = Buffer.concat([
    decipher.update(Buffer.from(msg.aes, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return { inner: JSON.parse(plain), aesKey, iv };
}

/** 生成 HMAC 签名（key 为原始字节） */
function sign(jsonStr, keyRaw) {
  return crypto.createHmac('sha256', keyRaw).update(jsonStr, 'utf8').digest('base64');
}

/** 完成登录：生成 signKey，加密成 secret 回给客户端 */
function finishLogin(sess, aesKey, iv, reqid, send) {
  const signKeyRaw = crypto.randomBytes(32);
  sess.signKeyRaw = signKeyRaw;
  const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
  const secret = Buffer.concat([cipher.update(signKeyRaw), cipher.final()]).toString('base64');
  sess.token = crypto.randomBytes(24).toString('base64');
  sess.backId = '6acf23a700000003';
  vmTokens.add(sess.token);          // 该 token 同时用于 /vm/api/v1 的 Authorization
  send({
    result: 'succ',
    reqid,
    uid: 1000,
    admin: true,
    token: sess.token,
    secret,
    backId: sess.backId,
  });
}

/* =========================================================== 响应工具 */
const SUCC = (reqid, payload, req, rev) =>
  Object.assign({}, payload || {}, { result: 'succ', reqid, rev: rev || '0.1', req });
const FAIL = (reqid, errno) => ({ result: 'fail', errno, reqid });
const DATA = (reqid, req, data, rev) => SUCC(reqid, { data }, req, rev);
const RSP = (reqid, req, rsp, rev) => SUCC(reqid, { rsp }, req, rev || '0.9.27');

/* =========================================================== 路由 */
function route(sess, msg, reqid, send) {
  const req = String(msg.req || '');

  /* ---------- Docker 模块（未安装 → 整个命名空间 266240） ---------- */
  if (req.startsWith('appcgi.dockermgr.')) {
    if (sess.noDocker) return send(FAIL(reqid, ERR.NO_MODULE));
    return routeDocker(msg, reqid, send, req);
  }

  /* ---------- 虚拟机：真机**没有**任何 WS 命令 ----------
   * 实测 appcgi.vmm/virt/vm/virtual 全部返回 266240（命名空间不存在），
   * 虚拟机的真实入口是 HTTP /vm/api/v1（见 routeVmRest）。这里如实复现。 */
  if (/^appcgi\.(vmm|vm|virt|virtual)\./.test(req)) {
    return send(FAIL(reqid, ERR.NO_MODULE));
  }

  switch (req) {
    /* ---------- 系统信息 ---------- */
    case 'appcgi.sysinfo.getHostName':
      return send(DATA(reqid, req, { hostName: 'fnOS-NAS', hasUsers: true, trimVersion: '1.2.0800' }));

    case 'appcgi.sysinfo.getTrimVersion':
      return send(DATA(reqid, req, { trimVersion: '1.2.0800', edition: 'Mainland-PE', platform: 'x86' }));

    case 'appcgi.sysinfo.getHardwareInfo':
      return send(DATA(reqid, req, {
        cpu: { name: 'Intel(R) N100', num: 1, core: 4, thread: 4 },
        mem: { num: 1, total: 16 * GiB, frequency: 4800, type: 'DDR5', vendor: 'Kingston' },
        gpu: [{ vendor: 'Intel Corporation', vendorId: 32902, device: 'UHD Graphics' }],
        // available=0 表示本机不支持/未安装虚拟机；mock 用 noVm 控制
        vm: { available: sess.noVm ? 0 : 1, iommu: 1, sriov: 1 },
        bios: {
          vendor: 'American Megatrends',
          version: '5.27',
          baseboard: { vendor: 'FNNAS', productName: '飞牛 NAS (N100)' },
          system: { vendor: 'FNNAS', productName: 'fnOS Device', version: '1.0' },
        },
        sysdisk: { size: 128 * GiB, model: 'NVMe SSD', protocol: 'NVMe', serialNumber: 'MOCK12345' },
      }));

    case 'appcgi.sysinfo.getUptime':
      return send(DATA(reqid, req, { uptime: Math.floor((Date.now() - BOOT) / 1000) }));

    case 'appcgi.sysinfo.getMachineId':
      return send(DATA(reqid, req, { machineId: 'mockmachineid0000000000000000000000000000' }));

    case 'appcgi.sysinfo.getReservedPartition':
      return send(FAIL(reqid, 100060001));

    /* ---------- 资源监控（单位：字节 / B/s / 百分比） ---------- */
    case 'appcgi.resmon.cpu':
      return send(DATA(reqid, req, {
        cpu: {
          name: 'Intel(R) N100', num: 1, core: 4, thread: 4, maxFreq: 3400,
          temp: [46],
          busy: { all: 17, user: 9, system: 6, iowait: 1, other: 1 },
          loadavg: { avg1min: 0.42, avg5min: 0.38, avg15min: 0.31 },
        },
      }));

    case 'appcgi.resmon.mem':
      return send(DATA(reqid, req, {
        mem: {
          reserved: 189120512,
          total: 16 * GiB,
          free: 8 * GiB,
          used: 6 * GiB,
          available: 9 * GiB,
          cached: 2 * GiB,
          buffers: 52031488,
        },
        swap: { total: 4 * GiB, free: 4 * GiB - 32 * 1024 * 1024, used: 32 * 1024 * 1024 },
      }));

    case 'appcgi.resmon.net':
      return send(DATA(reqid, req, {
        ifs: [{ name: 'enp1s0', index: 1, ifType: 0, receive: 138240, transmit: 45056, bond: false }],
      }));

    case 'appcgi.resmon.disk':
      return send(DATA(reqid, req, {
        num: 1,
        disk: [{ name: 'nvme0n1', temp: 38, standby: false, busy: 3, read: 4096, write: 8192 }],
      }));

    case 'appcgi.resmon.gen':
      return send(DATA(reqid, req, {
        item: {
          storeSpeed: { read: 0, write: 0 },
          netSpeed: { transmit: 45056, receive: 138240 },
          cpuBusy: 17,
          memPercent: 37,
        },
      }));

    case 'appcgi.resmon.sysFan':
      return send(DATA(reqid, req, { isTrim: false }));

    /* ---------- 存储（顶层字段，无 data 包裹；单位字节） ---------- */
    case 'stor.general':
      return send(SUCC(reqid, {
        array: [{
          name: 'dm-0', uuid: 'trim_mock_0', mountpoint: '/vol1',
          frsize: 24 * GiB, fssize: 40 * GiB, level: 'basic', storId: 1, comment: '',
        }],
        block: [],
      }, req));

    case 'stor.calcSpace':
      return send(SUCC(reqid, {
        fssizeSys: 32 * GiB, frsizeSys: 13 * GiB, sysDiskType: 'SSD',
        storTotal: 1, fssizeStor: 40 * GiB, frsizeStor: 24 * GiB,
        HDD: 1, SSD: 0, USB: 0,
      }, req));

    case 'stor.listDisk':
      return send(SUCC(reqid, {
        disk: [{ name: 'nvme0n1', size: 128 * GiB, sys: 1, frsizeSys: 13 * GiB, fssizeSys: 32 * GiB, type: 'SSD', diskGroup: 'sysSSD' }],
      }, req));

    /* ---------- 网络 ---------- */
    case 'appcgi.network.net.list':
      return send(DATA(reqid, req, {
        net: {
          ifs: [
            {
              name: 'lo', index: 1, ifType: 0, enable: true, running: true, state: 100,
              duplex: false, speed: 0, mtu: 65536, hwAddr: '00:00:00:00:00:00',
              wireless: false, ipv4: ['127.0.0.1'], ipv4Addr: '127.0.0.1',
            },
            {
              name: 'enp1s0', index: 2, ifType: 0, enable: true, running: true, state: 100,
              duplex: true, speed: 1000, mtu: 1500, hwAddr: '52:54:00:36:74:99',
              wireless: false, ipv4Dhcp: false, ipv4Mode: 'manual',
              ipv4Broad: '192.168.1.255', ipv4Mask: '255.255.255.0',
              ipv4Gateway: '192.168.1.1', ipv4Dns: '192.168.1.1',
              ipv4: ['192.168.1.40'], ipv4Addr: '192.168.1.40',
            },
          ],
        },
      }));

    case 'appcgi.network.net.getMultiGWStatus':
      return send(DATA(reqid, req, { multiGwStatus: false }));

    case 'appcgi.network.gw.getting':
      return send(DATA(reqid, req, { force_https: false, redirect: true }));

    /* ---------- 未知 ---------- */
    default:
      // 已知前缀但方法不存在 → 100000004；完全未知 → 266240
      if (/^appcgi\.(sysinfo|resmon|network|backup|share|security)\./.test(req)) {
        return send(FAIL(reqid, ERR.METHOD_MISSING));
      }
      return send(FAIL(reqid, ERR.NO_MODULE));
  }
}

/* =========================================================== Docker 路由 */
function routeDocker(msg, reqid, send, req) {
  const R = '0.9.27';
  switch (req) {
    case 'appcgi.dockermgr.containerList':
      return send(RSP(reqid, req, containers.map((c) => ({
        Id: c.Id,
        Names: c.Names,
        Image: c.Image,
        ImageID: 'sha256:' + c.Id,
        Command: '/init',
        Created: Math.floor(c.Created / 1000),
        State: c.State,
        Status: c.Status,
        Labels: { 'com.docker.compose.project': c.Names[0].slice(1) },
      })), R));

    case 'appcgi.dockermgr.stats': {
      const rsp = {};
      for (const c of containers) {
        const nm = c.Names[0].slice(1);
        rsp[nm] = STATS[nm] || { cpuUsage: 0, usedMem: 0, networkRx: 0, networkTx: 0 };
      }
      if (!Object.keys(rsp).length) rsp.none = { cpuUsage: 0, usedMem: 0, networkRx: 0, networkTx: 0 };
      return send(RSP(reqid, req, rsp, R));
    }

    case 'appcgi.dockermgr.composeList':
      return send(RSP(reqid, req, [], R));

    case 'appcgi.dockermgr.systemSettingGet':
      return send(RSP(reqid, req, {
        dataRoot: 1, currentMirror: '', autoBoot: true, status: true,
        mirrorsV2: [{ res: true, url: '默认加速源', name: '--' }, { res: true, url: 'docker', name: '--' }],
        mirrors: { '--': { url: 'docker' } },
      }, R));

    case 'appcgi.dockermgr.imageList':
      return send(RSP(reqid, req, [{ Id: 'sha256:' + hex64('img'), Created: Math.floor(Date.now() / 1000), Containers: containers.length, RepoTags: ['lovechen/embyserver:latest'] }], R));

    case 'appcgi.dockermgr.networkList':
      return send(RSP(reqid, req, [{ Id: hex64('net'), Name: 'bridge', Driver: 'bridge', Scope: 'local', Created: new Date().toISOString() }], R));

    case 'appcgi.dockermgr.containerStats': {
      const ref = containerRef(msg);
      if (ref === null) return send(FAIL(reqid, ERR.PARAM_MISSING));
      // 实测：容器不存在时仍返回 succ（rsp 为空），不报错
      if (!ref) return send(RSP(reqid, req, {}, R));
      const nm = ref.Names[0].slice(1);
      return send(RSP(reqid, req, { [nm]: STATS[nm] || { cpuUsage: 0, usedMem: 0, networkRx: 0, networkTx: 0 } }, R));
    }

    case 'appcgi.dockermgr.containerStart':
    case 'appcgi.dockermgr.containerStop':
    case 'appcgi.dockermgr.containerRestart':
    case 'appcgi.dockermgr.containerKill': {
      const ref = containerRef(msg);
      if (ref === null) return send(FAIL(reqid, ERR.PARAM_MISSING));   // 参数缺失
      if (!ref) return send(FAIL(reqid, ERR.NO_CONTAINER));            // 容器不存在
      const act = req.slice(req.lastIndexOf('.') + 1);
      if (act === 'containerStart') {
        if (ref.State === 'running') return send(FAIL(reqid, 52428802));  // 状态不允许
        ref.State = 'running'; ref.Status = 'Up 1 second';
      } else if (act === 'containerStop') {
        if (ref.State !== 'running') return send(FAIL(reqid, 52428802));
        ref.State = 'exited'; ref.Status = 'Exited (0) 1 second ago';
      } else if (act === 'containerRestart') {
        ref.State = 'running'; ref.Status = 'Up 1 second';
      } else if (act === 'containerKill') {
        ref.State = 'exited'; ref.Status = 'Exited (137) 1 second ago';
      }
      return send(RSP(reqid, req, { Id: ref.Id, Name: ref.Names[0].slice(1), State: ref.State }, R));
    }

    case 'appcgi.dockermgr.containerInspect':
    case 'appcgi.dockermgr.containerLogs':
    case 'appcgi.dockermgr.containerTop': {
      const ref = containerRef(msg);
      if (ref === null) return send(FAIL(reqid, ERR.PARAM_MISSING));
      if (!ref) return send(FAIL(reqid, ERR.NO_CONTAINER));
      return send(RSP(reqid, req, { Id: ref.Id, Name: ref.Names[0].slice(1) }, R));
    }

    default:
      return send(FAIL(reqid, ERR.METHOD_MISSING));
  }
}

/** 解析 containerId 参数；返回 undefined=没传参数、null 由调用方转成 PARAM_MISSING、对象=命中 */
function containerRef(msg) {
  if (msg.containerId === undefined || msg.containerId === null || msg.containerId === '') return null;
  const key = String(msg.containerId);
  return containers.find((c) => c.Id === key || c.Names[0].slice(1) === key || c.Names[0] === key) || undefined;
}

/* =================================================== 虚拟机 REST（/vm/api/v1） */
/**
 * 会话 token 登记表：finishLogin 发放的 token 才能通过 Authorization 校验。
 * （真机行为：Authorization 头带 WebSocket 登录返回的 token，裸值、无 Bearer）
 */
const vmTokens = new Set();

const V_OK = (data) => ({ code: 0, msg: 'success', data });
const V_ERR = (code) => ({ code, msg: '', data: '' });

/** 按内部名找虚拟机 */
function vmByName(n) {
  return guests.find((g) => g.name === n) || guests.find((g) => g.title === n) || null;
}

/**
 * 处理虚拟机 REST 请求。
 * @returns {{status:number, body:object}}
 */
function routeVmRest(method, pathname, query, headers, body, opts) {
  const o = opts || {};
  // 未安装「虚拟机」应用 → 真机是路由不存在（404）
  if (o.noVm) return { status: 404, body: { message: 'The route you are looking for is not found.' } };

  const auth = headers['authorization'];
  if (!auth || !vmTokens.has(String(auth))) {
    return { status: 401, body: { code: 401, message: 'unauthorized' } };
  }

  const p = pathname.replace(/^\/vm\/api\/v1/, '');
  // GET 用 query，POST 用 JSON body（真机语义：axios 对非 GET 走 data）
  const name = query.get('name') || (body && body.name) || '';

  /* ---------------- 只读 ---------------- */
  if (method === 'GET') {
    switch (p) {
      case '/domain/list':
        return { status: 200, body: V_OK(guests.map((g) => ({
          name: g.name, uuid: g.uuid, title: g.title, desc: g.desc, state: g.state,
          osType: g.osType, osVersion: g.osVersion,
          totalDisksCapacity: g.totalDisksCapacity,
          totalDisksCapacityInBytes: g.totalDisksCapacityInBytes,
          clipboard: g.clipboard,
        }))) };

      case '/domain/status':
        // 只返回「运行中」的虚拟机实时指标
        return { status: 200, body: V_OK(guests
          .filter((g) => g.state === 'RUNNING' && g.monitor)
          .map((g) => ({ name: g.name, state: g.state, monitor: g.monitor }))) };

      case '/domain/info': {
        const g = vmByName(name);
        if (!g) return { status: 200, body: V_ERR(12021) };
        return { status: 200, body: V_OK(Object.assign({
          name: g.name, uuid: g.uuid, title: g.title, desc: g.desc, state: g.state,
          osType: g.osType, osVersion: g.osVersion, clipboard: g.clipboard,
        }, g.info)) };
      }

      case '/domain/availableTitle':
        return { status: 200, body: V_OK(false) };

      case '/system/hardwareInfo':
        return { status: 200, body: V_OK({
          cpu: { name: 'Intel(R) N100', num: 1, core: 4, thread: 4 },
          mem: { num: 1, total: 16 * GiB, frequency: 4800, type: 'DDR5', vendor: 'Kingston' },
        }) };

      case '/system/allVolsInfo':
        return { status: 200, body: V_OK({
          count: 1,
          vols: [{ index: 1, sysname: 'dm-0', state: 0, uuid: 'trim_mock_vol1', size: 40063156224, used: 15154913280, voltype: 2435016766 }],
        }) };

      case '/ovs/isInited':
        return { status: 200, body: V_OK(false) };
      case '/ovs/listDetail':
        return { status: 200, body: V_OK([]) };
      case '/hostdev/support':
        return { status: 200, body: V_OK({ kvm: true, iommu: false, sriov: false }) };
      case '/hostdev/isSigned':
        return { status: 200, body: V_OK(false) };
      case '/hostdev/isHostdevEnabled':
        return { status: 200, body: V_OK(false) };
      case '/hostdev/lsusb':
        return { status: 200, body: V_OK([]) };
      case '/hostdev/lspci':
        return { status: 200, body: V_OK([]) };

      case '/snapshot/list': {
        const g = vmByName(name);
        if (!g) return { status: 200, body: V_ERR(12021) };
        return { status: 200, body: V_OK([]) };
      }
      default:
        return { status: 404, body: { message: 'The route you are looking for is not found.' } };
    }
  }

  /* ---------------- 操作（POST，参数 { name }） ---------------- */
  if (method === 'POST') {
    const ACTIONS = {
      '/domain/start': 'RUNNING',
      '/domain/shutdown': 'SHUTOFF',
      '/domain/forceshutdown': 'SHUTOFF',
      '/domain/reboot': 'RUNNING',
      '/domain/pause': 'PAUSED',
      '/domain/resume': 'RUNNING',
    };
    const next = ACTIONS[p];
    if (!next) return { status: 404, body: { message: 'The route you are looking for is not found.' } };

    const g = vmByName(name);
    if (!g) return { status: 200, body: V_ERR(12021) };

    // 状态不允许的操作：对已关机的机器执行 shutdown/reboot/pause/resume
    const running = g.state === 'RUNNING' || g.state === 'PAUSED';
    const needRunning = p !== '/domain/start';
    if (needRunning && !running) return { status: 200, body: V_ERR(12033) };
    if (p === '/domain/start' && g.state === 'RUNNING') return { status: 200, body: V_ERR(12033) };

    g.state = next;
    if (next === 'RUNNING') {
      g.monitor = { cpu: 3.2, memory: 212 * 1024 * 1024, networks: [{ name: 'vnet0', rxBytes: 4096, txBytes: 2048 }] };
    } else {
      g.monitor = null;
    }
    return { status: 200, body: V_OK({ name: g.name, state: g.state }) };
  }

  return { status: 405, body: { message: 'method not allowed' } };
}

/* =========================================================== 消息分发 */
function handleMessage(sess, text, send) {
  let jsonStr = text;
  let sig = null;
  if (text[0] !== '{') {           // "sig" + json 的拼接形态
    sig = text.slice(0, 44);
    jsonStr = text.slice(44);
  }

  let msg;
  try { msg = JSON.parse(jsonStr); } catch (_) { return; }

  // 应用层心跳 → 真实机回 {"res":"pong"}（无 reqid）
  if (msg.req === 'ping') { send({ res: 'pong' }); return; }

  /* 加密信封 */
  if (msg.req === 'encrypted') {
    let inner;
    let aesKey;
    let iv;
    try {
      const d = decryptEnvelope(msg);
      inner = d.inner; aesKey = d.aesKey; iv = d.iv;
    } catch (_) {
      return;                       // 解密失败：静默丢弃
    }
    if (inner.req === 'user.login') {
      if (inner.user !== VALID_USER || inner.password !== VALID_PASS) {
        return send(FAIL(inner.reqid, ERR.BAD_CRED));
      }
      if (sess.requireOtp && !sess.twofaDone) {
        sess.pendingAccess = crypto.randomBytes(16).toString('hex');
        return send({
          result: 'succ', reqid: inner.reqid,
          isBindTwofaSecret: true, isTrustedDevice: false, accessToken: sess.pendingAccess,
        });
      }
      return finishLogin(sess, aesKey, iv, inner.reqid, send);
    }
    if (inner.req === 'user.2fa.loginVerify') {
      if (inner.code !== OTP_CODE || inner.accessToken !== sess.pendingAccess) {
        return send(FAIL(inner.reqid, ERR.BAD_OTP));
      }
      sess.twofaDone = true;
      return finishLogin(sess, aesKey, iv, inner.reqid, send);
    }
    return send(FAIL(inner.reqid, ERR.METHOD_MISSING));
  }

  /* 取公钥（不签名） */
  if (msg.req === 'util.crypto.getRSAPub') {
    return send({ result: 'succ', reqid: msg.reqid, pub: RSA.publicKey, si: '299108991032' });
  }

  /* getSI（不签名，免登录） */
  if (msg.req === 'util.getSI') {
    return send({ result: 'succ', reqid: msg.reqid, si: '299108991034' });
  }

  /* 业务请求：验签 */
  if (sess.signKeyRaw) {
    const expect = sign(jsonStr, sess.signKeyRaw);
    if (expect !== sig) {
      return send(FAIL(msg.reqid, ERR.BAD_TOKEN));
    }
  } else {
    // 未登录却发业务请求
    return send(FAIL(msg.reqid, ERR.BAD_TOKEN));
  }

  return route(sess, msg, msg.reqid, send);
}

/* ============================================ fnConnect 地址解析
 * （POST /api/v1/fn/con）
 * ------------------------------------------------------------------------
 * 与飞牛云端同名同参，真机实测（2026-10-14）：
 *   POST /api/v1/fn/con    body {"fnId":"demo-nas"}
 *   headers:
 *     fn-sign = SHA256("trim_connect`" + fnId + "`" + ts + "`anna")
 *     authx   = nonce=<6位>&timestamp=<ms>&sign=MD5(前缀_路径_nonce_ts_MD5(body)_apiKey)
 * 这里**真的去校验 authx**（客户端把 nonce/ts 都放在头里，可完整复算），
 * 用来证明客户端的签名实现没写错；fn-sign 随其自身 ts 变化，只验形状。
 *
 * 返回的地址刻意做成「局域网可达 + 公网不可达」，好让自检验证优先级选路。
 * ======================================================================*/
const FN_CONNECT = {
  prefix: 'NDzZTVxnRKP8Z0jXg1VAMonaG8akvh',
  apiKey: 'zIGtkc3dqZnJpd29qZXJqa2w7c',
  path: '/api/v1/fn/con',
  fnId: process.env.MOCK_FNOS_FNID || 'mocknas',
  /** 测试网段（RFC 5737 / RFC 3849），保证探不通 */
  fakePublic4: '203.0.113.10',
  fakePublic6: '2001:db8::1',
  relay: 'mock.fnos.net:443',
};
const md5hex = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

/** 探活页：客户端 probeBase 会 GET 它并检查 xhrRequest 标记 */
const BRIDGE_HTML =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><title></title></head><body>' +
  '<script>function xhrRequest(o){/* fnOS bridge mock */return o;}</script>' +
  '</body></html>';

/** authx: nonce=…&timestamp=…&sign=… → 对象 */
function parseAuthx(v) {
  const out = {};
  for (const seg of String(v || '').split('&')) {
    const i = seg.indexOf('=');
    if (i > 0) out[seg.slice(0, i)] = seg.slice(i + 1);
  }
  return out;
}

/**
 * 解析 FN ID → 地址集合。返回 { status, body }。
 * raw = 原始请求体字符串（签名要对它取 md5）。
 * opts: { fnConnect?:boolean 关掉服务以模拟未开启, port?:number }
 */
function routeFnConnect(method, pathname, headers, raw, json, opts) {
  const o = opts || {};
  if (pathname !== FN_CONNECT.path) {
    return { status: 404, body: { code: 3000006, msg: 'Not Found Error', data: null } };
  }
  if (String(method || '').toUpperCase() !== 'POST') {
    return { status: 405, body: { code: 3000007, msg: 'Method Not Allowed', data: null } };
  }
  /* 模拟「FN Connect 未开启 / 云端不可达」 */
  if (o.fnConnect === false) {
    return { status: 200, body: { code: 3000009, msg: 'Network Error', data: null } };
  }
  /* ---- 校验 authx（完整性 + 可复算） ---- */
  const ax = parseAuthx(headers && headers.authx);
  const expect = md5hex([
    FN_CONNECT.prefix, FN_CONNECT.path, ax.nonce, ax.timestamp, md5hex(raw || ''), FN_CONNECT.apiKey,
  ].join('_'));
  if (!ax.nonce || !ax.timestamp || ax.sign !== expect) {
    return { status: 200, body: { code: 5000, msg: 'invalid sign', data: null } };
  }
  /* ---- 校验 fn-sign 形状 ---- */
  if (!/^[a-f0-9]{64}$/i.test(String((headers && headers['fn-sign']) || ''))) {
    return { status: 200, body: { code: 5000, msg: 'invalid fn-sign', data: null } };
  }
  /* ---- FN ID 匹配 ---- */
  const fnId = String((json && json.fnId) || '');
  if (fnId !== FN_CONNECT.fnId) {
    return { status: 200, body: { code: 3000037, msg: 'Not Found Error', data: null } };
  }
  const port = Number(o.port || PORT);
  return {
    status: 200,
    body: {
      code: 0,
      msg: '',
      data: {
        ddns: null,
        ipv4: ['127.0.0.1'],                       // ★ 局域网（本机）
        ipv6: [],
        publicIpv4: [FN_CONNECT.fakePublic4],      // 故意不可达
        publicIpv6: [FN_CONNECT.fakePublic6],
        fn: [FN_CONNECT.relay],
        port: { httpPort: port, httpsPort: port + 1 },
        checkSum: '',
        ver: '3.0.0',
        forbbidPublicIpv6: false,
      },
    },
  };
}

/* =========================================================== 服务 */
function createServer(options) {
  const o = options || {};
  const requireOtp = o.requireOtp != null ? o.requireOtp : REQUIRE_OTP;
  const noVm = o.noVm != null ? o.noVm : NO_VM;
  const noDocker = o.noDocker != null ? o.noDocker : NO_DOCKER;
  const fnConnect = o.fnConnect != null ? o.fnConnect : true;
  const port = Number(o.port || PORT);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));

    /* ---- fnConnect 地址解析 ---- */
    if (u.pathname === FN_CONNECT.path) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (_) { json = null; }
        // 端口取实际监听值（自检里用 0 让系统随机分配）
        const addr = server.address();
        const livePort = (addr && typeof addr === 'object' && addr.port) || port;
        const out = routeFnConnect(req.method, u.pathname, req.headers, raw, json, { fnConnect, port: livePort });
        res.writeHead(out.status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(out.body));
      });
      return;
    }

    /* ---- 探活页（客户端 probeBase 用） ---- */
    if (u.pathname === '/static/bridge.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(BRIDGE_HTML);
      return;
    }

    /* ---- 虚拟机 REST API ---- */
    if (u.pathname.startsWith('/vm/api/v1')) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body = null;
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw) { try { body = JSON.parse(raw); } catch (_) { body = null; } }
        const out = routeVmRest(req.method, u.pathname, u.searchParams, req.headers, body, { noVm });
        res.writeHead(out.status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(out.body));
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('fnOS mock: 请使用 WebSocket 连接 /websocket?type=main');
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n'
    );

    const sess = {
      signKeyRaw: null, token: null, backId: '0000000000000000',
      twofaDone: false, pendingAccess: null, requireOtp, noVm, noDocker,
    };
    const send = (obj) => {
      try { socket.write(encodeFrame(OP.TEXT, JSON.stringify(obj), false)); } catch (_) { /* ignore */ }
    };
    const parser = new FrameParser((f) => {
      if (f.opcode === OP.CLOSE) { socket.end(); return; }
      if (f.opcode === OP.PING) {
        try { socket.write(encodeFrame(OP.PONG, f.payload, false)); } catch (_) { /* ignore */ }
        return;
      }
      if (f.opcode === OP.TEXT) {
        try { handleMessage(sess, f.payload.toString('utf8'), send); } catch (_) { /* ignore */ }
      }
    });
    socket.on('data', (c) => { try { parser.push(c); } catch (_) { /* ignore */ } });
    socket.on('error', () => { /* ignore */ });
  });

  return server;
}

/** 复位可变数据（自检里多次跑用） */
function resetState() {
  containers = containers.map((c) => Object.assign({}, c));
  guests = GUESTS_SEED.map((g) => JSON.parse(JSON.stringify(g)));
  vmTokens.clear();
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, () => {
    console.log('Mock fnOS 已启动: ws://127.0.0.1:' + PORT + '/websocket?type=main');
    console.log('  虚拟机 REST   : http://127.0.0.1:' + PORT + '/vm/api/v1/domain/list');
    console.log('  fnConnect 解析: http://127.0.0.1:' + PORT + FN_CONNECT.path +
      '   (FN ID: ' + FN_CONNECT.fnId + ')');
    console.log('  账号: ' + VALID_USER + '   密码: ' + VALID_PASS +
      (REQUIRE_OTP ? '   两步验证码: ' + OTP_CODE : '   (无两步验证)'));
    console.log('  模块: Docker=' + (NO_DOCKER ? '未安装' : '已安装') +
      '  虚拟机=' + (NO_VM ? '未安装' : '已安装'));
  });
}

module.exports = {
  createServer, resetState, ERR,
  routeVmRest,
  routeFnConnect, FN_CONNECT, BRIDGE_HTML, md5hex,
  VALID_USER, VALID_PASS, OTP_CODE, REQUIRE_OTP, NO_VM, NO_DOCKER,
};
