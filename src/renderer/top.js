'use strict';
/**
 * 时钟卡片（top 组件）渲染：
 *  - 时钟走本机真实时间（对齐到整分钟刷新）
 *  - 三个环形（CPU / RAM / DISK）绑定主进程推送的真实快照，弧从 12 点起逆时针扫过
 *  - 单击展开详情面板；按住可自由拖动（位置由主进程记忆在 topBounds）
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const widget = $('widget');

  /* ---------------------------------------------------------- 时钟 */
  const g1 = document.querySelector('.g1'), g2 = document.querySelector('.g2');
  const g3 = document.querySelector('.g3'), g4 = document.querySelector('.g4');
  const pad = (n) => String(n).padStart(2, '0');
  function tick() {
    const now = new Date();
    const hh = pad(now.getHours()), mm = pad(now.getMinutes());
    g1.textContent = hh.charAt(0); g2.textContent = hh.charAt(1);
    g3.textContent = mm.charAt(0); g4.textContent = mm.charAt(1);
  }
  tick();
  /* 对齐到下一个整分钟再每分钟刷新，避免每秒重排 */
  setTimeout(() => { tick(); setInterval(tick, 60000); }, (60 - new Date().getSeconds()) * 1000);

  /* ---------------------------------------------------------- 环形 */
  const RINGS = [
    { key: 'cpu', arc: document.querySelector('.arc[data-ring="cpu"]'), pct: $('pctCpu') },
    { key: 'ram', arc: document.querySelector('.arc[data-ring="ram"]'), pct: $('pctRam') },
    { key: 'disk', arc: document.querySelector('.arc[data-ring="disk"]'), pct: $('pctDisk') },
  ];
  RINGS.forEach((r) => {
    r.len = r.arc.getTotalLength();                  /* 逆时针 path 的全长 */
    r.arc.style.strokeDasharray = '0 ' + r.len.toFixed(2);
  });

  /** 弧长与中心数值；v == null 视为无数据 */
  function setRing(r, v) {
    if (v == null || !Number.isFinite(v)) {
      r.arc.style.strokeDasharray = '0 ' + r.len.toFixed(2);
      r.pct.textContent = '—';
      return;
    }
    const pct = Math.max(0, Math.min(100, v));
    r.arc.style.strokeDasharray = (r.len * pct / 100).toFixed(2) + ' ' + r.len.toFixed(2);
    r.pct.textContent = Math.round(pct) + '%';
  }

  function paint(s) {
    const ok = !!(s && s.ok);
    document.body.classList.toggle('offline', !ok);
    for (const r of RINGS) setRing(r, ok ? (s[r.key] && s[r.key].pct) : null);
  }

  /* -------------------------------------------------- 拖动 vs 单击 */
  let down = null;
  let dragged = false;

  widget.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    down = { sx: e.screenX, sy: e.screenY };
    dragged = false;
    try { widget.setPointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
  });

  widget.addEventListener('pointermove', (e) => {
    if (!down) return;
    const dx = e.screenX - down.sx, dy = e.screenY - down.sy;
    if (!dragged && Math.hypot(dx, dy) > 4) {
      dragged = true;
      document.body.classList.add('grabbing');
      window.api.topDragBegin();
    }
    if (dragged) window.api.topDragTo(dx, dy);
  });

  function finish() {
    if (!down) return;
    const wasDrag = dragged;
    down = null;
    dragged = false;
    document.body.classList.remove('grabbing');
    if (wasDrag) window.api.topDragEnd();
    else window.api.toggleInfo();                    /* 单击 → 展开/收起详情面板 */
  }
  widget.addEventListener('pointerup', finish);
  widget.addEventListener('pointercancel', () => {
    if (!down) return;
    down = null; dragged = false;
    document.body.classList.remove('grabbing');
    window.api.topDragEnd();
  });

  /* ---------------------------------------------------------- 启动 */
  window.api.getState().then(paint).catch(() => paint(null));
  window.api.onState(paint);
})();
