'use strict';
/**
 * Provider 抽象层
 * ============================================================================
 * 挂件支持的服务器类型各不相同（Unraid 用 GraphQL、Proxmox VE 用 REST），
 * 但上层（主进程 / 渲染进程 / 托盘）只应感知「统一的快照结构」。
 *
 * 因此这里定义：
 *   1. 统一快照的快照骨架 makeSnapshot()
 *   2. provider 注册表与解析函数 resolve(kind)
 *   3. provider 必须实现的接口契约（见下方 Provider 接口说明）
 *
 * ---------------------------------------------------------------------------
 * Provider 接口（每个 provider 模块需导出）
 * ---------------------------------------------------------------------------
 *   kind            : string   例如 'unraid' | 'proxmox' | 'dsm'
 *   label           : string   界面展示名，例如 'Unraid'
 *   normalizeUrl(input) -> string
 *       把用户输入整理成规范端点地址；用于展示与请求。
 *   displayHost(url) -> string
 *       端点地址的展示形式（简化后的 host / host:port）。
 *   configToUrl(cfg) -> string
 *       ?? 兼容：旧配置只有 url 字段时使用。默认返回 cfg.url。
 *   testConnection(cfg) -> { ok, endpoint?, hostname?, version?, error? }
 *   fetchSnapshot(cfg)  -> Snapshot（见 makeSnapshot）
 *   containerAction(cfg, id, action) -> true   容器/Docker 启停（action: start|stop|restart|pause|unpause）
 *   guestAction(cfg, id, action)     -> true   虚拟机/LXC 启停（action: start|stop|forceStop|pause|resume）
 *   clearCache()        -> void    清空探测缓存（切换服务器时调用）
 *   guestKindLabel()    -> string  虚拟化区块标题，例如 '虚拟机' / 'LXC 与虚拟机'
 *
 * ---------------------------------------------------------------------------
 * 统一快照结构（UI 只依赖这些字段）
 * ---------------------------------------------------------------------------
 * {
 *   ts, ok, error, provider, host,
 *   server: { name, version, versionPrefix, uptimeText, kernel, distro },
 *   board, temp, ip,
 *   cpu:   { pct, label, brand, cores, threads, speedGhz, perCore[] },
 *   ram:   { pct, usedText, totalText, usedBytes, totalBytes },
 *   disk:  { pct, usedText, totalText, freeText, state },
 *   net:   { speedText, iface, linkMbps, rx, tx, rxText, txText },
 *   docker: { ok, error, items[], label },      // 容器列表（PVE 为 LXC）
 *   vms:    { ok, error, items[], label },      // 虚拟机列表（PVE 为 QEMU）
 *   warnings: [],
 * }
 *
 * `docker` / `vms` 两个区块名保持历史命名（UI 与配置 sections 均依赖），
 * 仅通过 label 呈现不同叫法。
 * ========================================================================*/

/** 统一快照骨架 */
function makeSnapshot(providerKind, host) {
  return {
    ts: Date.now(),
    ok: false,
    error: null,
    provider: providerKind || null,
    host: host || '',
    server: {
      name: null,
      version: null,
      versionPrefix: null,   // 版本号前缀，例如 'Unraid' / 'PVE'
      uptimeText: '—',
      kernel: null,
      distro: null,
    },
    board: null,
    temp: null,
    ip: null,
    cpu: { pct: null, label: null, brand: null, cores: null, threads: null, speedGhz: null, perCore: [] },
    ram: { pct: null, usedText: '—', totalText: '—', usedBytes: null, totalBytes: null },
    disk: { pct: null, usedText: '—', totalText: '—', freeText: '—', state: null },
    net: { speedText: '—', iface: null, linkMbps: null, rx: null, tx: null, rxText: '—', txText: '—' },
    docker: { ok: false, error: null, items: [], label: 'Docker 容器' },
    vms: { ok: false, error: null, items: [], label: '虚拟机' },
    warnings: [],
  };
}

/** 服务器类型元数据（设置页 / 引导页使用） */
const PROVIDERS = {
  unraid: {
    kind: 'unraid',
    label: 'Unraid',
    credentialLabel: 'API Key',
    urlHint: 'http://192.168.1.10  或  https://tower.local',
    urlNote: '支持填写 IP、主机名或完整 GraphQL 地址；未填 /graphql 时会自动补全。',
    containerLabel: 'Docker 容器',
    guestLabel: '虚拟机',
    docsUrl: 'https://docs.unraid.net/API/how-to-use-the-api/',
  },
  proxmox: {
    kind: 'proxmox',
    label: 'Proxmox VE',
    credentialLabel: 'API Token',
    urlHint: 'https://192.168.1.20:8006',
    urlNote: '填写 PVE 管理地址与端口（默认 8006）；路径会自动补全为 /api2/json。',
    containerLabel: 'LXC 容器',
    guestLabel: 'QEMU 虚拟机',
    docsUrl: 'https://pve.proxmox.com/pve-docs/chapter-pveum.html#pveum_tokens',
  },
  dsm: {
    kind: 'dsm',
    label: 'Synology DSM',
    credentialLabel: '账号',
    credentialLabel2: '密码',
    authMode: 'password',          // 账号密码登录（非 API Key）
    supportsOtp: true,             // 支持两步验证码（otp_code）
    urlHint: 'https://192.168.1.30:5001',
    urlNote: '填写 DSM 管理地址与端口（默认 HTTPS 5001 / HTTP 5000）；使用 DSM 账号密码登录，不使用 API Key。',
    containerLabel: 'Docker 容器',
    guestLabel: '虚拟机',
    docsUrl: 'https://github.com/ApaipaiLtd/dsm_helper',
  },
  fnos: {
    kind: 'fnos',
    label: '飞牛 fnOS',
    credentialLabel: '账号',
    credentialLabel2: '密码',
    authMode: 'password',          // 账号密码登录（非 API Key）
    supportsOtp: true,             // 支持两步验证码（user.2fa.loginVerify）
    urlHint: 'http://192.168.1.40:5666',
    urlNote: '填写 fnOS 管理地址与端口（默认 HTTP 5666 / HTTPS 5667）；使用 fnOS 账号密码登录，不使用 API Key。',
    containerLabel: 'Docker 容器',
    guestLabel: '虚拟机',
    docsUrl: 'https://github.com/FNOSP/fnnas-api',
  },
};

/** 默认类型 */
const DEFAULT_KIND = 'unraid';

/** 取某个类型的元数据（未知类型回退 unraid） */
function meta(kind) {
  return PROVIDERS[kind] || PROVIDERS[DEFAULT_KIND];
}

/** 类型是否受支持 */
function isSupported(kind) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, kind);
}

module.exports = {
  makeSnapshot,
  PROVIDERS,
  DEFAULT_KIND,
  meta,
  isSupported,
};
