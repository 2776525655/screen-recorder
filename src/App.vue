<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRecorder } from './composables/useRecorder'
import { setCursor } from './lib/cursorState'

const r = useRecorder()

// 麦克风多选（默认全选；点按钮弹出下拉面板可多选）
const audioInputs = r.audioInputs
const selectedAudioIds = r.selectedAudioIds
const hasAudio = r.hasAudio
const micPanelOpen = ref(false)

// 录制源选择（整个屏幕 / 具体窗口）
const srcScreens = r.screens
const srcWindows = r.windows
const srcLoading = r.loading
const srcSelected = r.selected
const sourcePanelOpen = ref(false)

// 回放状态（主进程推送）
const replayOn = ref(false)
const replayBuffered = ref(0)
const replayKeep = ref(180)

// 录制按钮状态（widget 显示用）
const recordClass = computed(() => {
  if (r.phase.value === 'recording') return 'recording'
  if (r.phase.value === 'paused') return 'recording-paused'
  return ''
})

// 录制中收起为迷你悬浮条（只留 暂停/结束 + 计时）
const recCompact = computed(() => ['recording', 'paused', 'saving'].includes(r.phase.value))
const recTimeText = computed(() => r.elapsedText.value)
const recSizeNow = computed(() => r.recSizeText.value)

function togglePause() {
  if (r.phase.value === 'recording') r.pauseRecording()
  else if (r.phase.value === 'paused') r.resumeRecording()
}
function stopNow() {
  if (r.phase.value === 'saving') return
  closeMicPanel()
  closeSourcePanel()
  r.stopRecording()
}
watch(
  () => r.phase.value,
  (v) => {
    if (v === 'recording' || v === 'paused' || v === 'saving') {
      window.screenRec?.widgetLayout('compact')
    } else {
      window.screenRec?.widgetLayout('normal')
    }
  },
)

const fmt2 = (s) => {
  s = Math.max(0, Math.floor(s || 0))
  const m = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${m}:${ss}`
}
const statusText = computed(() => {
  if (r.phase.value === 'recording') {
    const size = r.recSizeText.value ? ' · ' + r.recSizeText.value : ''
    return 'REC ' + r.elapsedText.value + size
  }
  if (r.phase.value === 'paused') return '已暂停 ' + r.elapsedText.value
  if (r.phase.value === 'saving') return '正在保存…'
  if (replayOn.value) return '缓冲 ' + fmt2(replayBuffered.value) + ' / ' + fmt2(replayKeep.value) + ' · 点「回放」保存'
  if (r.phase.value === 'ready' && srcSelected.value) return '就绪 · ' + srcName(srcSelected.value)
  return '就绪'
})
const recordTitle = computed(() =>
  r.phase.value === 'recording' || r.phase.value === 'paused' ? '点击停止并保存录制' : '选择要录制的屏幕或窗口',
)

function srcName(s) {
  if (!s) return ''
  return (s.name || (s.type === 'screen' ? '屏幕' : '窗口')).replace(/\s+\(.*\)$/, '')
}

const micTitle = computed(() =>
  hasAudio.value
    ? `麦克风（已选 ${selectedAudioIds.value.length} 个），点击选择要采集的设备`
    : '未选择麦克风，点击选择要采集的设备',
)

// —— 面板展开：麦克风 / 源选择 ——
function panelHeight() {
  if (micPanelOpen.value) {
    const n = Math.max(1, Math.min(audioInputs.value.length, 6))
    return 158 + 64 + n * 38 // 基础区 + 面板头/尾 + 设备行
  }
  const rows = Math.min(Math.max(srcScreens.value.length + srcWindows.value.length, 1), 9)
  return 158 + 96 + rows * 36 // 基础区 + 头/两组标题/行
}
function resizePanel() {
  if (micPanelOpen.value || sourcePanelOpen.value) window.screenRec?.widgetResize(panelHeight())
  else window.screenRec?.widgetResize(160)
}
function closeMicPanel() {
  micPanelOpen.value = false
  resizePanel()
}
function closeSourcePanel() {
  sourcePanelOpen.value = false
  resizePanel()
}
function toggleMicPanel() {
  sourcePanelOpen.value = false
  if (micPanelOpen.value) closeMicPanel()
  else {
    micPanelOpen.value = true
    resizePanel()
  }
}
async function openSourcePanel() {
  micPanelOpen.value = false
  sourcePanelOpen.value = true
  resizePanel()
  try {
    await r.loadSources()
  } catch (_) {}
}
function onWinBlur() {
  if (micPanelOpen.value || sourcePanelOpen.value) {
    closeMicPanel()
    closeSourcePanel()
  }
}
function isMicChecked(id) {
  return selectedAudioIds.value.includes(id)
}
function onToggleMic(id) {
  r.toggleAudioDevice(id)
}
function selectAllMics() {
  r.selectAllMic()
}
function selectNoneMics() {
  r.selectNoneMic()
}

async function saveReplayClick() {
  if (!replayOn.value) return
  const res = await window.screenRec.replaySave()
  if (res && res.saved) {
    r.toast(`已保存回放：${res.path}`, 'success', { label: '打开所在文件夹', path: res.path })
  } else {
    r.toast('保存回放失败：' + ((res && (res.message || res.reason)) || '未知错误'), 'error')
  }
}

// 置顶状态：true=screen-saver（最上） / false=normal
const pinned = ref(true)

function openSettings() {
  closeMicPanel()
  closeSourcePanel()
  window.screenRec.openSettings()
}
function togglePin() {
  pinned.value = !pinned.value
  window.screenRec.widgetSetPinned(pinned.value)
}
function hideWidget() {
  closeMicPanel()
  closeSourcePanel()
  window.screenRec.hideWidget()
}

// 录屏按钮：录制中点一下=停止；空闲/就绪点一下=选择录制源
async function onRecordToggle() {
  if (r.phase.value === 'recording' || r.phase.value === 'paused') {
    closeMicPanel()
    closeSourcePanel()
    await r.stopRecording()
    return
  }
  closeMicPanel()
  await openSourcePanel()
}

async function onSourceClick(source) {
  if (r.busy.value) return
  closeMicPanel()
  sourcePanelOpen.value = false
  resizePanel()
  const started = await r.pickSourceAndStart(source)
  if (!started) {
    // 开始失败时保留面板供重选
    sourcePanelOpen.value = true
    resizePanel()
  }
}

const replayLabel = computed(() => (replayOn.value ? '保存片段' : '回放'))
const replayTitle = computed(() =>
  replayOn.value
    ? `已自动缓冲最近 ${fmt2(replayKeep.value)}，点击保存该片段`
    : '记忆回放未运行，点击开启',
)
const savingReplay = ref(false)

async function onReplayToggle() {
  closeMicPanel()
  closeSourcePanel()
  if (savingReplay.value) return
  if (replayOn.value) {
    savingReplay.value = true
    try {
      await saveReplayClick()
    } finally {
      savingReplay.value = false
    }
    return
  }
  const rr = await window.screenRec.replayToggleAuto()
  if (rr && !rr.ok) r.toast(rr.message || '记忆回放开启失败', 'error')
}

onMounted(() => {
  r.boot()
  window.screenRec?.onAppNotice((d) => {
    if (d) r.toast(d.message, d.type || 'info')
  })
  window.screenRec?.onWidgetState((d) => {
    if (!d) return
    replayOn.value = !!(d.replay && d.replay.on)
    if (d.replay) {
      replayBuffered.value = d.replay.buffered || 0
      replayKeep.value = d.replay.keep || 180
    }
  })
  // 主进程推送的系统光标坐标（用于手动录屏叠加鼠标）
  window.screenRec?.onRecorderCursor((d) => setCursor(d))
  window.addEventListener('blur', onWinBlur)
})
onUnmounted(() => {
  window.removeEventListener('blur', onWinBlur)
})
</script>

<template>
  <div class="widget" :class="{ compact: recCompact }">
    <!-- 录制中：迷你悬浮条（半透明、可拖动） -->
    <div v-if="recCompact" class="mini" :title="recSizeNow ? recTimeText + ' · ' + recSizeNow : ''">
      <span class="mini-dot" :class="{ rec: r.phase.value === 'recording', pause: r.phase.value === 'paused' }"></span>
      <span class="mini-time">{{ r.phase.value === 'saving' ? '保存中…' : recTimeText }}</span>
      <span v-if="recSizeNow" class="mini-size">{{ recSizeNow }}</span>
      <span class="mini-spacer"></span>
      <button class="mini-btn" :title="r.phase.value === 'paused' ? '继续' : '暂停'" @click="togglePause" v-if="r.phase.value !== 'saving'">
        <svg viewBox="0 0 24 24" fill="currentColor"><rect v-if="r.phase.value === 'recording'" x="6" y="4" width="4" height="16" rx="1"/><rect v-if="r.phase.value === 'recording'" x="14" y="4" width="4" height="16" rx="1"/><path v-else d="M8 5v14l11-7z"/></svg>
      </button>
      <button class="mini-btn stop" title="结束并保存" @click="stopNow">
        <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>
      </button>
    </div>
    <!-- 常规面板 -->
    <div v-else class="full-ui">
    <div class="head">
      <span class="title">捕获</span>
      <div class="head-actions">
        <button class="hbtn" :class="{ on: pinned }" :title="pinned ? '已置顶（点击取消）' : '置顶'" @click="togglePin">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M14 4l6 6-3 1-1 5-6-6 4-6z" />
            <path d="M5 19l4-4 6 6-4 4z" />
          </svg>
        </button>
        <button class="hbtn" title="关闭（隐藏到托盘）" @click="hideWidget">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M6 6 L18 18 M18 6 L6 18" />
          </svg>
        </button>
      </div>
    </div>

    <div class="row">
      <button class="btn" title="设置" @click="openSettings">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        <span class="label">设置</span>
      </button>
      <button class="btn replay-btn" :class="{ active: replayOn }" :title="replayTitle" @click="onReplayToggle">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 12a9 9 0 1 0 3-6.7l-3-2.3v9h9L9 9l3 2.3A6 6 0 1 1 6 18.7" /></svg>
        <span class="label">{{ replayLabel }}</span>
      </button>
      <button class="btn rec-btn" :class="recordClass" :title="recordTitle" @click="onRecordToggle">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="6" fill="currentColor" stroke="none"/></svg>
        <span class="label">录屏</span>
      </button>
      <button
        class="btn mic-btn"
        :class="{ 'mic-off': !hasAudio }"
        :title="micTitle"
        @click.stop="toggleMicPanel"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/></svg>
        <span class="mic-dot-wrap"><span class="mic-dot" :class="{ on: hasAudio }"></span></span>
        <span class="label">麦克风</span>
      </button>
    </div>

    <!-- 录制源选择面板 -->
    <div v-if="sourcePanelOpen" class="mic-panel" @click.stop>
      <div class="mp-head">
        <span class="mp-title">选择录制区域</span>
        <button class="mp-link muted" @click="closeSourcePanel">收起</button>
      </div>
      <div class="src-scroll">
        <template v-if="srcScreens.length">
          <div class="src-group">屏幕</div>
          <button
            v-for="s in srcScreens"
            :key="s.id"
            class="src-item"
            :class="{ on: srcSelected && srcSelected.id === s.id }"
            @click="onSourceClick(s)"
          >
            <svg class="src-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
            <span class="src-name" :title="s.name">{{ srcName(s) }}</span>
            <span class="src-rec" v-if="srcSelected && srcSelected.id === s.id">当前</span>
          </button>
        </template>
        <template v-if="srcWindows.length">
          <div class="src-group">窗口</div>
          <button
            v-for="s in srcWindows"
            :key="s.id"
            class="src-item"
            :class="{ on: srcSelected && srcSelected.id === s.id }"
            @click="onSourceClick(s)"
          >
            <svg class="src-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/></svg>
            <span class="src-name" :title="s.name">{{ srcName(s) }}</span>
            <span class="src-rec" v-if="srcSelected && srcSelected.id === s.id">当前</span>
          </button>
        </template>
        <div v-if="srcLoading" class="src-empty">正在获取屏幕与窗口…</div>
        <div v-else-if="!srcScreens.length && !srcWindows.length" class="src-empty">未发现可录制的屏幕/窗口</div>
      </div>
      <div class="mp-foot">点击上方某项，立即开始录制该屏幕或窗口；再次点「录屏」结束并保存</div>
    </div>

    <!-- 麦克风多选面板 -->
    <div v-if="micPanelOpen" class="mic-panel" @click.stop>
      <div class="mp-head">
        <span class="mp-title">采集麦克风（可多选）</span>
        <div class="mp-actions">
          <button class="mp-link" v-if="audioInputs.length > selectedAudioIds.length" @click="selectAllMics">全选</button>
          <button class="mp-link muted" v-else-if="selectedAudioIds.length" @click="selectNoneMics">清空</button>
        </div>
      </div>
      <div class="mp-list">
        <label
          v-for="d in audioInputs"
          :key="d.deviceId"
          class="mp-item"
          :class="{ on: isMicChecked(d.deviceId) }"
        >
          <input type="checkbox" class="mp-check" :checked="isMicChecked(d.deviceId)" @change="onToggleMic(d.deviceId)" />
          <span class="mp-name" :title="d.label">{{ d.label }}</span>
          <span v-if="isMicChecked(d.deviceId)" class="mp-tag">录制</span>
        </label>
        <div v-if="!audioInputs.length" class="mp-empty">未检测到麦克风设备</div>
      </div>
      <div class="mp-foot">录屏时将同时采集以上所选设备的声音，全部默认开启</div>
    </div>

    <div class="status-row">
      <div class="status" :class="{ recording: r.phase.value === 'recording', paused: r.phase.value === 'paused' }">
        <span class="dot"></span>{{ statusText }}
      </div>
    </div>
    </div>
  </div>
</template>

<style scoped>
html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; }
::global(body) { font-family: 'Microsoft YaHei UI', 'Segoe UI', sans-serif; }
.widget {
  width: 420px;
  padding: 10px 14px 10px;
  background: rgba(20, 22, 28, 0.95);
  border: 1px solid #3a4150;
  border-radius: 14px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.55);
  color: #e9ebf2;
  user-select: none;
  -webkit-user-region: drag;
  -webkit-app-region: drag;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.title { font-size: 12px; color: #a6aebc; letter-spacing: 1px; font-weight: 600; }
.head-actions { display: flex; gap: 2px; -webkit-app-region: no-drag; }
.hbtn {
  width: 22px; height: 22px; border: none; background: transparent; color: #a6aebc;
  display: inline-flex; align-items: center; justify-content: center; border-radius: 4px;
  cursor: pointer;
}
.hbtn:hover { background: rgba(255,255,255,0.08); color: #fff; }
.hbtn.on { color: #e6a23c; }
.row { display: flex; gap: 10px; justify-content: space-between; }
.btn {
  -webkit-app-region: no-drag;
  position: relative;
  width: 88px; height: 70px;
  border-radius: 12px;
  background: #262a33; color: #cfd5e0; border: 1px solid #343a48;
  display: flex; align-items: center; justify-content: center; flex-direction: column;
  gap: 2px; cursor: pointer; font-size: 11px;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}
.btn:hover { background: #2e333d; color: #fff; }
.btn svg { width: 22px; height: 22px; stroke: currentColor; fill: none; stroke-width: 1.6; }
.btn .label { font-size: 10px; color: #a6aebc; }
.btn.rec-btn.recording { background: #f0483e; color: #fff; border-color: #f0483e; }
.btn.rec-btn.recording .label { color: #fff; }
.btn.rec-btn.recording-paused { background: #e6a23c; border-color: #e6a23c; color: #fff; }
.btn.rec-btn.recording-paused .label { color: #fff; }
.btn.replay-btn.active { border-color: #4c7cf0; background: rgba(76, 124, 240, 0.16); color: #fff; }
.btn.replay-btn.active .label { color: #b9c6ec; }
.mic-dot-wrap { position: absolute; right: 8px; top: 8px; }
.mic-dot {
  display: inline-block;
  width: 7px; height: 7px; border-radius: 50%;
  background: #6b7485;
}
.mic-dot.on { background: #2ebd85; }
.btn.mic-off { opacity: 0.65; }
.btn.mic-off .label { color: #6b7485; }
.btn.mic-off svg { color: #6b7485; }
.mic-panel {
  -webkit-app-region: no-drag;
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-top: 1px solid #2c313c;
  padding-top: 8px;
}
.mp-head { display: flex; align-items: center; justify-content: space-between; }
.mp-title { font-size: 11px; color: #a6aebc; letter-spacing: 0.5px; }
.mp-actions { display: flex; gap: 10px; }
.mp-link {
  background: none; border: none; cursor: pointer;
  font-size: 11px; color: #4c7cf0; padding: 0;
}
.mp-link:hover { color: #6f97ff; }
.mp-link.muted { color: #8a93a5; }
.mp-link.muted:hover { color: #aeb6c6; }
.mp-list { display: flex; flex-direction: column; gap: 2px; max-height: 176px; overflow-y: auto; }
.mp-item {
  display: flex; align-items: center; gap: 8px;
  font-size: 12px; color: #cfd5e0;
  padding: 5px 8px; border-radius: 7px; cursor: pointer;
}
.mp-item:hover { background: rgba(255, 255, 255, 0.06); }
.mp-item.on { color: #e9ebf2; }
.mp-check { accent-color: #4c7cf0; width: 14px; height: 14px; flex-shrink: 0; }
.mp-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mp-tag {
  font-size: 10px; color: #2ebd85;
  border: 1px solid rgba(46, 189, 133, 0.5);
  border-radius: 999px; padding: 0 7px;
}
.mp-empty { font-size: 12px; color: #6b7485; text-align: center; padding: 10px 0; }
.mp-foot { font-size: 10px; color: #6b7485; }
.src-scroll {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 236px;
  overflow-y: auto;
}
.src-group {
  font-size: 10px; color: #6b7485; letter-spacing: 1px;
  padding: 6px 8px 2px;
}
.src-item {
  display: flex; align-items: center; gap: 8px;
  width: 100%;
  background: transparent; border: none; cursor: pointer;
  color: #cfd5e0; font-size: 12px;
  padding: 5px 8px; border-radius: 7px;
  text-align: left;
}
.src-item:hover { background: rgba(255, 255, 255, 0.06); }
.src-item.on { color: #fff; background: rgba(76, 124, 240, 0.14); }
.src-ico { width: 14px; height: 14px; flex-shrink: 0; color: #8a93a5; }
.src-item.on .src-ico { color: #4c7cf0; }
.src-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.src-rec {
  font-size: 10px; color: #4c7cf0;
  border: 1px solid rgba(76, 124, 240, 0.5);
  border-radius: 999px; padding: 0 6px;
}
.src-empty { font-size: 12px; color: #6b7485; text-align: center; padding: 12px 0; }
.status-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 18px;
}
.status {
  font-size: 12px;
  color: #a6aebc;
  display: flex;
  align-items: center;
  gap: 6px;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status .dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #6b7485;
  flex-shrink: 0;
}
.status.recording .dot { background: #f0483e; animation: blink 1s infinite; }
.status.paused .dot { background: #e6a23c; animation: none; }
@keyframes blink { 0%,100%{opacity:1} 50%{opacity:.2} }
.widget.compact {
  width: auto;
  padding: 5px 9px;
  opacity: 0.72; /* 录制中半透明 */
  transition: opacity 0.15s ease;
}
.widget.compact:hover { opacity: 1; }
.full-ui { display: flex; flex-direction: column; gap: 6px; }
.mini {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 46px;
  -webkit-app-region: drag; /* 迷你条整体可拖动 */
  box-sizing: border-box;
}
.mini-dot { width: 9px; height: 9px; border-radius: 50%; background: #6b7485; flex-shrink: 0; }
.mini-dot.rec { background: #f0483e; animation: blink 1s infinite; }
.mini-dot.pause { background: #e6a23c; }
.mini-time {
  font-size: 14px;
  color: #fff;
  font-variant-numeric: tabular-nums;
  font-family: Consolas, 'Courier New', monospace;
  letter-spacing: 0.5px;
  white-space: nowrap;
}
.mini-size { font-size: 10px; color: #a6aebc; white-space: nowrap; flex-shrink: 0; }
.mini-spacer { flex: 1; min-width: 4px; }
.mini-btn {
  -webkit-app-region: no-drag;
  width: 26px; height: 26px;
  border: none; border-radius: 7px; cursor: pointer;
  background: #2c313d; color: #e9ebf2;
  display: inline-flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.mini-btn:hover { background: #3a4150; }
.mini-btn.stop { background: #f0483e; color: #fff; }
.mini-btn.stop:hover { background: #ff5c52; }
.mini-btn svg { width: 13px; height: 13px; }
</style>
