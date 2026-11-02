'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  /* 配置（全局设置 + 服务器列表） */
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),
  testConfig: (draft) => ipcRenderer.invoke('config:test', draft),

  /* 多服务器管理 */
  listServers: () => ipcRenderer.invoke('servers:list'),
  getServer: (id) => ipcRenderer.invoke('servers:get', id),
  saveServer: (srv) => ipcRenderer.invoke('servers:save', srv),
  removeServer: (id) => ipcRenderer.invoke('servers:remove', id),
  setActiveServer: (id) => ipcRenderer.invoke('servers:setActive', id),
  testServer: (draft) => ipcRenderer.invoke('servers:test', draft),
  onServers: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('servers', h);
    return () => ipcRenderer.removeListener('servers', h);
  },

  /* 状态 */
  getState: () => ipcRenderer.invoke('state:get'),
  refresh: () => ipcRenderer.invoke('app:refresh'),
  onState: (cb) => {
    const h = (_e, s) => cb(s);
    ipcRenderer.on('state', h);
    return () => ipcRenderer.removeListener('state', h);
  },
  onConfig: (cb) => {
    const h = (_e, c) => cb(c);
    ipcRenderer.on('config', h);
    return () => ipcRenderer.removeListener('config', h);
  },

  /* 控制 */
  dockerAction: (id, action) => ipcRenderer.invoke('action:docker', { id, action }),
  vmAction: (id, action) => ipcRenderer.invoke('action:vm', { id, action }),

  /* 窗口 */
  openSettings: () => ipcRenderer.invoke('app:openSettings'),
  quit: () => ipcRenderer.invoke('app:quit'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  getProviders: () => ipcRenderer.invoke('app:providers'),

  /* 双窗口：简约条 ⇄ 详情面板 */
  toggleInfo: () => ipcRenderer.invoke('window:toggleInfo'),
  showInfo: () => ipcRenderer.invoke('window:showInfo'),
  collapse: () => ipcRenderer.invoke('window:collapse'),   // 收起详情、只留简约条
  toggleMini: () => ipcRenderer.invoke('window:toggleMini'),
  hideMini: () => ipcRenderer.invoke('window:hideMini'),
  windowState: () => ipcRenderer.invoke('window:state'),

  /* 组件样式：时钟卡片（top）/ 顶部简约条（mini） */
  setWidgetMode: (mode) => ipcRenderer.invoke('widget:setMode', mode),
  toggleTop: () => ipcRenderer.invoke('window:toggleTop'),
  hideTop: () => ipcRenderer.invoke('window:hideTop'),

  /* 简约条横向拖动（渲染进程用 pointer 事件驱动，避免拖动区吞掉单击） */
  miniDragBegin: () => ipcRenderer.send('mini:dragBegin'),
  miniDragTo: (dx) => ipcRenderer.send('mini:dragTo', dx),
  miniDragEnd: () => ipcRenderer.send('mini:dragEnd'),

  /* 时钟卡片自由拖动（dx/dy 均为相对起点的位移） */
  topDragBegin: () => ipcRenderer.send('top:dragBegin'),
  topDragTo: (dx, dy) => ipcRenderer.send('top:dragTo', dx, dy),
  topDragEnd: () => ipcRenderer.send('top:dragEnd'),

  /* 兼容旧调用 */
  hideWidget: () => ipcRenderer.invoke('window:collapse'),
});
