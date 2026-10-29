/**
 * Preload 桥（contextIsolation 开启）：向渲染进程暴露最小窗口控制 API。
 * 沙箱模式下 preload 仅可使用 electron 的 contextBridge / ipcRenderer，满足。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('draWindow', {
  /** 最小化 */
  minimize: () => ipcRenderer.invoke('dra:minimize'),
  /** 最大化 / 还原切换，返回切换后是否最大化 */
  toggleMaximize: () => ipcRenderer.invoke('dra:toggle-maximize'),
  /** 关闭窗口 */
  close: () => ipcRenderer.invoke('dra:close'),
  /** 全屏 / 退出全屏切换，返回切换后是否全屏 */
  toggleFullscreen: () => ipcRenderer.invoke('dra:toggle-fullscreen'),
  /** 查询当前是否全屏 */
  isFullscreen: () => ipcRenderer.invoke('dra:is-fullscreen'),
  /** 订阅窗口状态变化（最大化 / 全屏），返回取消订阅函数 */
  onWindowStateChange: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('dra:window-state', listener);
    return () => ipcRenderer.removeListener('dra:window-state', listener);
  },
});

/**
 * 加密保险库桥：渲染层持久化数据（画布 / 工作区等）在主进程的专属数据
 * 文件夹（userData/data/appstore）加密落盘，与加载端口 / 源无关。
 * 详见 main.cjs 的「专属本地数据保险库」段。
 */
contextBridge.exposeInMainWorld('draStore', {
  /** 启动引导：一次拉取全部键值（已解密） */
  loadAll: () => ipcRenderer.invoke('dra:store-load'),
  /** 写入并加密落盘 */
  set: (key, value) => ipcRenderer.invoke('dra:store-set', key, value),
  /** 删除 */
  remove: (key) => ipcRenderer.invoke('dra:store-remove', key),
});
