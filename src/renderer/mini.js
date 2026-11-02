'use strict';
/**
 * 顶部简约条渲染：
 *  - 三个环形仪表（CPU / RAM / DISK），弧从 12 点方向起「逆时针」扫过
 *  - 单击展开详情面板；按住左右拖动可移动（自动吸附屏幕顶部）
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const bar = $('bar');

  const RINGS = [
    { key: 'cpu', cx: 71.75, cy: 21, r: 16, arc: 'arcCpu', val: 'valCpu' },
    { key: 'ram', cx: 135.75, cy: 21, r: 16, arc: 'arcRam', val: 'valRam' },
    { key: 'disk', cx: 199.75, cy: 21, r: 16, arc: 'arcDisk', val: 'valDisk' },
  ];

  /**
   * 生成圆环进度弧。
   * 约定：从 12 点方向起、逆时针扫过 `pct% × 360°`（与设计稿方向一致）。
   */
  function arcPath(cx, cy, r, pct) {
    const sweep = (Math.max(0, Math.min(100, pct)) / 100) * 360;
    if (sweep < 0.6) return '';
    if (sweep >= 359.4) {
      // 满环：用两段半圆，避免起终点重合导致不渲染
      return (
        'M ' + cx + ' ' + (cy - r) +
        ' A ' + r + ' ' + r + ' 0 1 0 ' + cx + ' ' + (cy + r) +
        ' A ' + r + ' ' + r + ' 0 1 0 ' + cx + ' ' + (cy - r)
      );
    }
    const rad = (-sweep * Math.PI) / 180;
    const ex = cx + r * Math.sin(rad);
    const ey = cy - r * Math.cos(rad);
    const large = sweep > 180 ? 1 : 0;
    return (
      'M ' + cx + ' ' + (cy - r) +
      ' A ' + r + ' ' + r + ' 0 ' + large + ' 0 ' + ex.toFixed(2) + ' ' + ey.toFixed(2)
    );
  }

  /* ------------------------------------------ 数值动画（缓动到新值） */
  const cur = {};     // key -> 当前显示值（动画起点）
  const raf = {};     // key -> requestAnimationFrame 句柄
  const DUR = 700;

  function draw(r, v) {
    $(r.arc).setAttribute('d', arcPath(r.cx, r.cy, r.r, v));
    $(r.val).textContent = Math.round(v) + '%';
  }
  function stopAnim(key) {
    if (raf[key]) { cancelAnimationFrame(raf[key]); raf[key] = 0; }
  }
  /** 首次直接就位（不从 0 冲上来），之后平滑缓动 */
  function animateTo(r, to) {
    const key = r.key;
    stopAnim(key);
    const from = Object.prototype.hasOwnProperty.call(cur, key) ? cur[key] : to;
    if (Math.abs(from - to) < 0.05) { cur[key] = to; draw(r, to); return; }
    const t0 = performance.now();
    draw(r, from);                                  // 起手先绘一帧，避免等 rAF 期间仍显示旧值
    const step = (t) => {
      /* rAF 时间戳可能早于上面取的 t0（帧起始时刻），必须钳到 [0,1]，
         否则 k 为负会让缓动反向、数值朝错误方向漂移。 */
      const k = Math.max(0, Math.min(1, (t - t0) / DUR));
      const ease = 1 - Math.pow(1 - k, 3);          // easeOutCubic
      const v = from + (to - from) * ease;
      cur[key] = v;
      draw(r, v);
      if (k < 1) raf[key] = requestAnimationFrame(step);
      else { cur[key] = to; raf[key] = 0; draw(r, to); }
    };
    raf[key] = requestAnimationFrame(step);
  }

  function paint(s) {
    const ok = !!(s && s.ok);
    bar.classList.toggle('offline', !ok);
    const vals = {
      cpu: ok ? s.cpu && s.cpu.pct : null,
      ram: ok ? s.ram && s.ram.pct : null,
      disk: ok ? s.disk && s.disk.pct : null,
    };
    for (const r of RINGS) {
      const v = vals[r.key];
      if (v == null || !Number.isFinite(v)) {
        stopAnim(r.key);
        delete cur[r.key];
        $(r.arc).setAttribute('d', '');
        $(r.val).textContent = '—';
      } else {
        animateTo(r, v);
      }
    }
  }

  /* ------------------------------------------------- 拖动 vs 单击 */
  let down = null;
  let dragged = false;

  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    down = { sx: e.screenX, dx: 0 };
    dragged = false;
    try { bar.setPointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
  });

  bar.addEventListener('pointermove', (e) => {
    if (!down) return;
    const dx = e.screenX - down.sx;
    down.dx = dx;
    if (!dragged && Math.abs(dx) > 4) {
      dragged = true;
      bar.classList.add('grabbing');
      window.api.miniDragBegin();
    }
    if (dragged) window.api.miniDragTo(dx);
  });

  function finish() {
    if (!down) return;
    const wasDrag = dragged;
    down = null;
    dragged = false;
    bar.classList.remove('grabbing');
    if (wasDrag) {
      window.api.miniDragEnd();
    } else {
      window.api.toggleInfo();
    }
  }
  bar.addEventListener('pointerup', finish);
  bar.addEventListener('pointercancel', () => { if (down) { down = null; dragged = false; bar.classList.remove('grabbing'); window.api.miniDragEnd(); } });

  /* ------------------------------------------------- 启动 */
  window.api.getState().then(paint).catch(() => paint(null));
  window.api.onState(paint);
})();
