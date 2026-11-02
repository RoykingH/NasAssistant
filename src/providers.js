'use strict';
/**
 * Provider 解析器 —— 根据配置里的 `type` 字段路由到具体实现。
 *
 * 对上层暴露与单一 provider 完全相同的接口，因此 main.js / 自检
 * 只需把 `require('./unraid')` 换成 `require('./providers')` 即可支持多类型。
 */
const provider = require('./provider');
const unraid = require('./unraid');
const proxmox = require('./proxmox');
const dsm = require('./dsm');
const fnos = require('./fnos');

const IMPL = { unraid, proxmox, dsm, fnos };

/** 取某个类型的实现（未知类型回退 unraid） */
function impl(kind) {
  return IMPL[kind] || IMPL[provider.DEFAULT_KIND];
}

/** 从配置解析出类型（兼容旧配置：无 type 视为 unraid） */
function kindOf(cfg) {
  const k = cfg && cfg.type;
  return provider.isSupported(k) ? k : provider.DEFAULT_KIND;
}

/** 当前配置对应的 provider 实现 */
function of(cfg) {
  return impl(kindOf(cfg));
}

module.exports = {
  /* provider 元数据 */
  PROVIDERS: provider.PROVIDERS,
  DEFAULT_KIND: provider.DEFAULT_KIND,
  meta: provider.meta,
  isSupported: provider.isSupported,
  makeSnapshot: provider.makeSnapshot,
  kindOf,
  of,

  /* ---- 统一的 provider 接口 ---- */
  fetchSnapshot: (cfg) => of(cfg).fetchSnapshot(cfg),
  containerAction: (cfg, id, action) => of(cfg).containerAction(cfg, id, action),
  guestAction: (cfg, id, action) => of(cfg).guestAction(cfg, id, action),
  testConnection: (cfg) => of(cfg).testConnection(cfg),
  normalizeUrl: (cfg) => of(cfg).normalizeUrl(cfg.url),
  displayHost: (cfg) => of(cfg).displayHost(cfg.url),
  clearCache: (cfg) => of(cfg).clearCache(cfg.url ? of(cfg).normalizeUrl(cfg.url) : undefined, cfg),

  /* 向后兼容别名 */
  dockerAction: (cfg, id, action) => of(cfg).containerAction(cfg, id, action),
  vmAction: (cfg, id, action) => of(cfg).guestAction(cfg, id, action),
  clearProbeCache: (cfg) => of(cfg).clearCache(cfg.url ? of(cfg).normalizeUrl(cfg.url) : undefined, cfg),
};
