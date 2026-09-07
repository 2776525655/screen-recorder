const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('screenRec', {
  recTempCreate: () => ipcRenderer.invoke('rec:temp-create'),
  recTempAppend: (p) => ipcRenderer.invoke('rec:temp-append', p),
  recTempStat: (p) => ipcRenderer.invoke('rec:temp-stat', p),
  recTempRemove: (p) => ipcRenderer.invoke('rec:temp-remove', p),
  recTempSave: (p) => ipcRenderer.invoke('rec:temp-save', p),
  recDebugRetain: (p) => ipcRenderer.invoke('rec:debug-retain', p),

  getSources: () => ipcRenderer.invoke('sources:list'),
  getSaveDir: () => ipcRenderer.invoke('save:get-dir'),
  chooseSaveDir: () => ipcRenderer.invoke('save:choose-dir'),
  showInFolder: (filePath) => ipcRenderer.invoke('path:show', filePath),
  openSoundPanel: () => ipcRenderer.invoke('sound:panel'),
  diskFree: (p) => ipcRenderer.invoke('disk:free', p),

  replayStart: (keepSec, sysAudio) => ipcRenderer.invoke('replay:start', { keepSec, sysAudio }),
  replayStop: () => ipcRenderer.invoke('replay:stop'),
  replayState: () => ipcRenderer.invoke('replay:state'),
  replaySave: () => ipcRenderer.invoke('replay:save'),
  replayAudioCheck: () => ipcRenderer.invoke('replay:audio-check'),
  replayToggleAuto: () => ipcRenderer.invoke('replay:toggle-auto'),

  notifyState: (payload) => ipcRenderer.send('state:change', payload),
  onRecorderCmd: (cb) => ipcRenderer.on('recorder:cmd', (_e, a, p) => cb(a, p)),
  onRecorderCursor: (cb) => ipcRenderer.on('recorder:cursor', (_e, p) => cb(p)),
  onAppNotice: (cb) => ipcRenderer.on('app:notice', (_e, d) => cb(d)),

  widgetCmd: (action, payload) => ipcRenderer.send('widget:cmd', action, payload),
  onWidgetState: (cb) => ipcRenderer.on('widget:state', (_e, d) => cb(d)),
  hideWidget: () => ipcRenderer.send('widget:hide'),
  widgetSetPinned: (v) => ipcRenderer.send('widget:set-pinned', v),
  widgetResize: (height) => ipcRenderer.send('widget:resize', height),
  widgetLayout: (mode) => ipcRenderer.send('widget:layout', mode),

  openSettings: () => ipcRenderer.send('settings:open'),
  settingsGetAll: () => ipcRenderer.invoke('settings:get-all'),
  settingsSave: (settings) => ipcRenderer.invoke('settings:save', settings),
  settingsChooseDir: () => ipcRenderer.invoke('settings:choose-dir'),
  settingsClose: () => ipcRenderer.send('settings:close'),
  onSettingsChanged: (cb) => ipcRenderer.on('settings:changed', () => cb()),

  // 后台采集引擎（隐藏采集窗口）
  onBgCmd: (cb) => ipcRenderer.on('bg:cmd', (_e, d) => cb(d)),
  bgReady: () => ipcRenderer.send('bg:ready'),
  bgLog: (msg) => ipcRenderer.send('bg:log', msg),
  bgMeta: (p) => ipcRenderer.send('bg:meta', p),
  bgMkFile: (p) => ipcRenderer.invoke('bg:mkfile', p),

  minimize: () => ipcRenderer.send('win:min'),
  maximize: () => ipcRenderer.invoke('win:max'),
  close: () => ipcRenderer.send('win:close'),
  onMaximized: (cb) => ipcRenderer.on('window:maximized', (_e, v) => cb(v)),
})