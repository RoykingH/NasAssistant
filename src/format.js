'use strict';
/**
 * 通用格式化 / 数值工具 —— 供各 provider 与 UI 复用。
 * 与具体服务器类型（Unraid / Proxmox VE）无关。
 */

function toNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/** 字节 → 「152 GB」（1024 进制） */
function fmtSize(bytes) {
  const n = toNum(bytes);
  if (n == null || n < 0) return '—';
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i];
}

/** 传输速率（字节/秒）→ 文案 */
function fmtRate(bytesPerSec) {
  const n = toNum(bytesPerSec);
  if (n == null || n < 0) return '—';
  if (n < 1024) return n.toFixed(0) + ' B/s';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB/s';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB/s';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB/s';
}

/** epoch 秒（或毫秒）→ 「YYYY-MM-DD」 */
function fmtDate(epochSec) {
  const n = toNum(epochSec);
  if (n == null || n <= 0) return null;
  const ms = n > 1e11 ? n : n * 1000; // 兼容毫秒时间戳
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 时长（毫秒）→ 「3 天 5 小时」 */
function fmtUptime(ms) {
  if (ms == null || ms < 0) return '—';
  let s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return d + ' 天 ' + h + ' 小时';
  if (h > 0) return h + ' 小时 ' + m + ' 分';
  return m + ' 分';
}

/** 链路速率（Mbps）→ 「1 Gbps」 / 「2500 Mbps」 */
function fmtLink(mbps) {
  const n = toNum(mbps);
  if (n == null || n <= 0) return '—';
  if (n >= 1000) return (+(n / 1000).toFixed(2)) + ' Gbps';
  return n + ' Mbps';
}

/** 从 "7.3 x86_64" / "v7.3.2" / "8.2.2" / "DSM 7.2.1-69057 Update 5" 里取出纯版本号 */
function cleanVersion(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  // 先直接在串里找形如 7.2.1 的版本号（覆盖 "DSM 7.2.1-69057 Update 5" 这类前缀带字的形态）
  const m = s.match(/\d+(?:\.\d+)+/);
  if (m) return m[0];
  const m2 = s.match(/^v?(\d+(?:\.\d+)*)/);
  return m2 ? m2[1] : s;
}

/** 百分比钳制到 [0,100] */
function clampPct(p) {
  const n = toNum(p);
  if (n == null) return null;
  return Math.max(0, Math.min(100, n));
}

module.exports = {
  toNum,
  fmtSize,
  fmtRate,
  fmtDate,
  fmtUptime,
  fmtLink,
  cleanVersion,
  clampPct,
};
