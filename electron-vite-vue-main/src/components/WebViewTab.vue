<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick, inject } from 'vue'

const props = defineProps<{
  filePath: string
  dragActive?: boolean
}>()

const webviewRef = ref<any>()

const setWebviewCurrentUrl = inject<(filePath: string, url: string) => void>('setWebviewCurrentUrl', () => {})
const webviewCurrentUrls = inject<Record<string, string>>('webviewCurrentUrls', {})

const isBlank = computed(() => props.filePath.startsWith('__blank_'))
const initialUrl = computed(() => isBlank.value ? '' : `file://${props.filePath}`)

const resolvedStartUrl = webviewCurrentUrls[props.filePath] ?? initialUrl.value
const addressInput = ref(resolvedStartUrl)
const currentUrl = ref(resolvedStartUrl)

const fileName = computed(() => {
  if (isBlank.value) return '新标签页'
  const parts = props.filePath.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || props.filePath
})

function onWebviewNavigate(e: any) {
  const url: string = e.url || ''
  if (!url || url === 'about:blank') return
  addressInput.value = url
  setWebviewCurrentUrl(props.filePath, url)
}

onMounted(() => {
  const wv = webviewRef.value
  if (!wv) return
  wv.addEventListener('did-navigate', onWebviewNavigate)
  wv.addEventListener('did-navigate-in-page', onWebviewNavigate)
  const targetUrl = currentUrl.value
  if (targetUrl && targetUrl !== 'about:blank') {
    nextTick(() => {
      try { wv.loadURL(targetUrl) } catch {}
    })
  }
})

onUnmounted(() => {
  const wv = webviewRef.value
  if (wv) {
    wv.removeEventListener('did-navigate', onWebviewNavigate)
    wv.removeEventListener('did-navigate-in-page', onWebviewNavigate)
  }
})

function navigate() {
  let url = addressInput.value.trim()
  if (!url) return
  if (!/^(https?:\/\/|file:\/\/)/.test(url)) {
    url = 'https://' + url
  }
  addressInput.value = url
  currentUrl.value = url
}

function onAddressKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    navigate()
  }
}

function reload() {
  webviewRef.value?.reload()
}

function openDevTools() {
  webviewRef.value?.openDevTools()
}

function goBack() {
  webviewRef.value?.goBack()
}

function goForward() {
  webviewRef.value?.goForward()
}

watch(() => props.filePath, () => {
  if (props.filePath.startsWith('__blank_')) {
    addressInput.value = ''
    currentUrl.value = ''
    return
  }
  const url = `file://${props.filePath}`
  addressInput.value = url
  currentUrl.value = url
})
</script>

<template>
  <div class="webview-tab">
    <div class="webview-toolbar">
      <button class="toolbar-btn" title="后退" @click="goBack">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>
      <button class="toolbar-btn" title="前进" @click="goForward">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
      <button class="toolbar-btn" title="刷新" @click="reload">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="23 4 23 10 17 10" />
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </svg>
      </button>

      <div class="address-bar">
        <svg class="address-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
        <input
          v-model="addressInput"
          class="address-input"
          placeholder="输入 URL 并回车"
          spellcheck="false"
          @keydown="onAddressKeydown"
        />
      </div>

      <button class="toolbar-btn" title="开发者工具" @click="openDevTools">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
      </button>
    </div>
    <webview
      ref="webviewRef"
      class="webview-frame"
      :class="{ 'no-pointer': dragActive }"
      :src="currentUrl || 'about:blank'"
      allowpopups
    />
    <div v-if="dragActive" class="webview-interaction-shield"></div>
  </div>
</template>

<style scoped>
.webview-tab {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--c-base);
  position: relative;
}

.webview-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  background: var(--c-mantle);
  border-bottom: 1px solid var(--c-surface0);
  flex-shrink: 0;
}

.address-bar {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--c-base);
  border: 1px solid var(--c-surface1);
  border-radius: 6px;
  padding: 4px 10px;
  min-width: 0;
  transition: border-color 0.15s;
}

.address-bar:focus-within {
  border-color: var(--c-blue);
}

.address-icon {
  color: var(--c-overlay0);
  flex-shrink: 0;
}

.address-input {
  flex: 1;
  background: none;
  border: none;
  outline: none;
  font-size: 0.78rem;
  font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
  color: var(--c-text);
  min-width: 0;
}

.address-input::placeholder {
  color: var(--c-surface2);
}

.toolbar-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--c-overlay0);
  cursor: pointer;
  flex-shrink: 0;
  transition: color 0.15s, background 0.15s;
}

.toolbar-btn:hover {
  color: var(--c-text);
  background: var(--c-surface0);
}

.webview-frame {
  flex: 1;
  border: none;
  width: 100%;
  height: 100%;
  background: #fff;
}

.webview-frame.no-pointer {
  pointer-events: none;
}

.webview-interaction-shield {
  position: absolute;
  inset: 0;
  z-index: 10;
}
</style>
