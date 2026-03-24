<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick, computed } from 'vue'
import MindMap from 'simple-mind-map'

const props = defineProps<{
  content: string
  theme: string
  readonly?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:content', value: string): void
}>()

const container = ref<HTMLDivElement>()
const isDark = computed(() => props.theme === 'dark')
const parseError = ref('')
let mindMap: InstanceType<typeof MindMap> | null = null
let isInternalChange = false
let ready = false

function parseMindMapData(json: string) {
  try {
    const data = JSON.parse(json)
    if (data && data.data && typeof data.data.text === 'string') {
      parseError.value = ''
      return data
    }
    parseError.value = '数据格式不符合思维导图结构（需包含 data.text）'
    return null
  } catch {
    parseError.value = 'JSON 解析失败'
    return null
  }
}

const FONT_FAMILY = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Noto Sans SC', sans-serif"

function getDarkThemeConfig() {
  return {
    backgroundColor: '#181818',
    lineColor: '#6c7086',
    lineWidth: 2,
    lineStyle: 'curve',
    generalizationLineColor: '#6c7086',
    root: {
      fillColor: '#313244',
      color: '#cdd6f4',
      fontFamily: FONT_FAMILY,
      borderColor: '#585b70',
      borderWidth: 2,
      borderRadius: 8,
      fontSize: 16,
      fontWeight: 'bold',
    },
    second: {
      fillColor: '#1e1e2e',
      color: '#cdd6f4',
      fontFamily: FONT_FAMILY,
      borderColor: '#45475a',
      borderWidth: 1,
      borderRadius: 6,
      fontSize: 14,
      marginX: 80,
      marginY: 30,
    },
    node: {
      fillColor: 'transparent',
      color: '#bac2de',
      fontFamily: FONT_FAMILY,
      borderColor: 'transparent',
      borderWidth: 0,
      borderRadius: 4,
      fontSize: 13,
      marginX: 50,
      marginY: 6,
    },
    generalization: {
      fillColor: '#1e1e2e',
      color: '#cdd6f4',
      fontFamily: FONT_FAMILY,
      borderColor: '#45475a',
      borderWidth: 1,
      borderRadius: 6,
      fontSize: 13,
    },
  }
}

function getLightThemeConfig() {
  return {
    backgroundColor: '#ffffff',
    lineColor: '#549688',
    lineWidth: 2,
    lineStyle: 'curve',
    root: {
      fontFamily: FONT_FAMILY,
      borderRadius: 8,
    },
    second: {
      fontFamily: FONT_FAMILY,
      borderRadius: 6,
      marginX: 80,
      marginY: 30,
    },
    node: {
      fontFamily: FONT_FAMILY,
      borderRadius: 4,
      marginX: 50,
      marginY: 6,
    },
    generalization: {
      fontFamily: FONT_FAMILY,
      borderRadius: 6,
    },
  }
}

function getThemeConfig() {
  return isDark.value ? getDarkThemeConfig() : getLightThemeConfig()
}

function initMindMap() {
  if (!container.value) return
  const data = parseMindMapData(props.content)
  if (!data) return

  destroyMindMap()

  ready = false

  mindMap = new MindMap({
    el: container.value,
    data,
    readonly: props.readonly ?? false,
    theme: 'default',
    themeConfig: getThemeConfig(),
    layout: 'logicalStructure',
    mousewheelAction: 'move',
    fit: true,
    enableShortcutOnlyWhenMouseInSvg: true,
    isEndNodeTextEditOnClickOuter: true,
    nodeTextEditZIndex: 9000,
  })

  mindMap.on('node_tree_render_end', () => {
    if (!ready) ready = true
  })

  mindMap.on('data_change', (newData: any) => {
    if (!ready || isInternalChange) {
      isInternalChange = false
      return
    }
    const json = JSON.stringify(newData, null, 2)
    emit('update:content', json)
  })
}

function destroyMindMap() {
  if (mindMap) {
    mindMap.destroy()
    mindMap = null
  }
  ready = false
}

function fitCanvas() {
  mindMap?.view?.fit()
}

watch(() => props.content, (newVal) => {
  if (!mindMap) {
    nextTick(initMindMap)
    return
  }
  const data = parseMindMapData(newVal)
  if (!data) return
  isInternalChange = true
  mindMap.setData(data)
  nextTick(() => {
    isInternalChange = false
  })
})

watch(() => props.theme, () => {
  if (mindMap) {
    mindMap.setThemeConfig(getThemeConfig())
  }
})

onMounted(() => {
  nextTick(initMindMap)
})

onBeforeUnmount(() => {
  destroyMindMap()
})

defineExpose({ fitCanvas })
</script>

<template>
  <div class="smm-wrapper">
    <div v-if="parseError" class="smm-error">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <span>{{ parseError }}</span>
    </div>
    <div v-show="!parseError" ref="container" class="smm-container"></div>
    <div v-if="!parseError" class="smm-toolbar">
      <button class="smm-toolbar-btn" title="适应画布 (Ctrl+I)" @click="fitCanvas">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M15 3h6v6" /><path d="M9 21H3v-6" />
          <path d="M21 3l-7 7" /><path d="M3 21l7-7" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.smm-wrapper {
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.smm-container {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.smm-container :deep(*) {
  margin: 0;
  padding: 0;
}

.smm-error {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 0.85rem;
  color: var(--c-overlay0);
}

.smm-error svg {
  flex-shrink: 0;
  color: var(--c-peach);
}

.smm-toolbar {
  position: absolute;
  bottom: 12px;
  right: 12px;
  display: flex;
  gap: 4px;
  background: var(--c-mantle);
  border: 1px solid var(--c-surface0);
  border-radius: 8px;
  padding: 4px;
  box-shadow: 0 2px 10px var(--c-shadow);
  z-index: 10;
}

.smm-toolbar-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--c-overlay0);
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}

.smm-toolbar-btn:hover {
  background: var(--c-surface0);
  color: var(--c-text);
}
</style>
