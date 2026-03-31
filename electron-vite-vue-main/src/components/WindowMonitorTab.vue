<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{
  monitorId: string
  active?: boolean
  dragActive?: boolean
}>()

interface MonitorSource {
  id: string
  name: string
  displayId: string
  thumbnailDataUrl: string
  appIconDataUrl?: string
}

const query = ref('')
const sources = ref<MonitorSource[]>([])
const selectedSourceId = ref('')
const frameDataUrl = ref('')
const loadingSources = ref(false)
const capturing = ref(false)
const error = ref('')
const refreshTick = ref(0)
const previewWrapEl = ref<HTMLElement | null>(null)
const captureSize = ref({ width: 1920, height: 1080 })
const qualityMode = ref<'standard' | 'ultra'>('ultra')

let captureTimer: ReturnType<typeof setInterval> | null = null
let listDebounceTimer: ReturnType<typeof setTimeout> | null = null
let sizeObserver: ResizeObserver | null = null

const selectedSource = computed(() => sources.value.find((s) => s.id === selectedSourceId.value) || null)

async function loadSources() {
  loadingSources.value = true
  error.value = ''
  try {
    const result = await window.windowMonitorApi.list(query.value)
    sources.value = result
    if (!result.length) {
      selectedSourceId.value = ''
      frameDataUrl.value = ''
      return
    }
    if (!result.some((s) => s.id === selectedSourceId.value)) {
      selectedSourceId.value = result[0].id
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loadingSources.value = false
  }
}

async function captureFrame() {
  if (!props.active || !selectedSourceId.value) return
  capturing.value = true
  try {
    const minWidth = qualityMode.value === 'ultra' ? 1920 : 1280
    const minHeight = qualityMode.value === 'ultra' ? 1080 : 720
    const width = Math.max(minWidth, Math.floor(captureSize.value.width))
    const height = Math.max(minHeight, Math.floor(captureSize.value.height))
    const result = await window.windowMonitorApi.capture({
      sourceId: selectedSourceId.value,
      width,
      height,
    })
    if (result.error) {
      error.value = result.error
      return
    }
    error.value = ''
    frameDataUrl.value = result.dataUrl
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    capturing.value = false
  }
}

function updateCaptureSizeFromLayout() {
  const el = previewWrapEl.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return
  const dprCap = qualityMode.value === 'ultra' ? 3 : 2
  const dpr = Math.min(dprCap, Math.max(1, window.devicePixelRatio || 1))
  const scale = qualityMode.value === 'ultra' ? 1.8 : 1.25
  const maxWidth = qualityMode.value === 'ultra' ? 5120 : 3840
  const maxHeight = qualityMode.value === 'ultra' ? 3200 : 2160
  captureSize.value = {
    width: Math.min(maxWidth, Math.floor(rect.width * dpr * scale)),
    height: Math.min(maxHeight, Math.floor(rect.height * dpr * scale)),
  }
}

function startCaptureLoop() {
  stopCaptureLoop()
  if (!props.active || !selectedSourceId.value) return
  updateCaptureSizeFromLayout()
  void captureFrame()
  const interval = qualityMode.value === 'ultra' ? 1100 : 800
  captureTimer = setInterval(() => {
    void captureFrame()
  }, interval)
}

function stopCaptureLoop() {
  if (!captureTimer) return
  clearInterval(captureTimer)
  captureTimer = null
}

function manualRefresh() {
  refreshTick.value++
  void loadSources()
}

watch(
  () => props.active,
  (active) => {
    if (active) {
      startCaptureLoop()
    } else {
      stopCaptureLoop()
    }
  },
)

watch(selectedSourceId, () => {
  frameDataUrl.value = ''
  if (props.active) {
    startCaptureLoop()
  }
})

watch(query, () => {
  if (listDebounceTimer) clearTimeout(listDebounceTimer)
  listDebounceTimer = setTimeout(() => {
    void loadSources()
  }, 300)
})

watch(refreshTick, () => {
  if (props.active) {
    startCaptureLoop()
  }
})

watch(qualityMode, () => {
  updateCaptureSizeFromLayout()
  if (props.active) {
    startCaptureLoop()
  }
})

onMounted(async () => {
  updateCaptureSizeFromLayout()
  if (previewWrapEl.value) {
    sizeObserver = new ResizeObserver(() => {
      updateCaptureSizeFromLayout()
    })
    sizeObserver.observe(previewWrapEl.value)
  }
  await loadSources()
  if (props.active) startCaptureLoop()
})

onBeforeUnmount(() => {
  stopCaptureLoop()
  sizeObserver?.disconnect()
  sizeObserver = null
  if (listDebounceTimer) clearTimeout(listDebounceTimer)
})
</script>

<template>
  <div class="window-monitor-tab">
    <div class="toolbar">
      <input
        v-model="query"
        class="search-input"
        type="text"
        placeholder="筛选窗口名..."
      />
      <button class="btn" :disabled="loadingSources" @click="manualRefresh">
        {{ loadingSources ? '刷新中...' : '刷新列表' }}
      </button>
      <button
        class="btn"
        :title="qualityMode === 'ultra' ? '当前超清（更清晰、更吃性能）' : '当前标准（更流畅）'"
        @click="qualityMode = qualityMode === 'ultra' ? 'standard' : 'ultra'"
      >
        {{ qualityMode === 'ultra' ? '超清' : '标准' }}
      </button>
      <select v-model="selectedSourceId" class="window-select">
        <option v-for="source in sources" :key="source.id" :value="source.id">
          {{ source.name || '未命名窗口' }}
        </option>
      </select>
    </div>

    <div class="hint">
      当前版本支持实时监视窗口画面；可切换“标准/超清”。直接点击预览来控制目标应用（输入/点击穿透）暂不支持。
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>

    <div ref="previewWrapEl" class="preview-wrap" :class="{ 'no-pointer': dragActive }">
      <img v-if="frameDataUrl" :src="frameDataUrl" class="preview-image" alt="window frame" />
      <div v-else class="empty-state">
        <span v-if="!sources.length">未发现可捕获窗口，请确认系统权限与目标应用已打开。</span>
        <span v-else-if="capturing">正在捕获画面...</span>
        <span v-else>请选择一个窗口开始监视。</span>
      </div>
    </div>

    <div v-if="selectedSource" class="meta">
      <img
        v-if="selectedSource.appIconDataUrl"
        :src="selectedSource.appIconDataUrl"
        class="app-icon"
        alt="app icon"
      />
      <span class="meta-name">{{ selectedSource.name }}</span>
      <span class="meta-display">display: {{ selectedSource.displayId || 'unknown' }}</span>
    </div>
  </div>
</template>

<style scoped>
.window-monitor-tab {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  gap: 10px;
  padding: 12px;
  background: var(--c-base);
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.search-input,
.window-select {
  height: 32px;
  border: 1px solid var(--c-surface1);
  border-radius: 8px;
  background: var(--c-surface0);
  color: var(--c-text);
  padding: 0 10px;
  font-size: 13px;
}

.search-input {
  width: 240px;
}

.window-select {
  flex: 1;
  min-width: 180px;
}

.btn {
  height: 32px;
  border: 1px solid var(--c-surface1);
  border-radius: 8px;
  background: var(--c-surface0);
  color: var(--c-text);
  font-size: 12px;
  padding: 0 12px;
  cursor: pointer;
}

.btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.hint {
  font-size: 12px;
  color: var(--c-overlay0);
}

.error-banner {
  border: 1px solid color-mix(in srgb, var(--c-red, #f38ba8) 40%, transparent);
  background: color-mix(in srgb, var(--c-red, #f38ba8) 15%, transparent);
  color: var(--c-red, #f38ba8);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 12px;
}

.preview-wrap {
  flex: 1;
  min-height: 0;
  border: 1px solid var(--c-surface1);
  border-radius: 10px;
  overflow: hidden;
  background: #0f1117;
  display: flex;
  align-items: center;
  justify-content: center;
}

.preview-wrap.no-pointer {
  pointer-events: none;
}

.preview-image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.empty-state {
  color: var(--c-overlay0);
  font-size: 13px;
  padding: 16px;
  text-align: center;
}

.meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--c-overlay0);
}

.app-icon {
  width: 16px;
  height: 16px;
  border-radius: 4px;
}

.meta-name {
  color: var(--c-text);
}
</style>
