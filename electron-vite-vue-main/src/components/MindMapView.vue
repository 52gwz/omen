<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick, computed } from 'vue'
import { Transformer } from 'markmap-lib'
import { Markmap } from 'markmap-view'

const props = defineProps<{
  content: string
  theme: string
}>()

const container = ref<HTMLDivElement>()
const isDark = computed(() => props.theme === 'dark')
let mm: Markmap | null = null
let svgEl: SVGSVGElement | null = null
let resizeObserver: ResizeObserver | null = null
let resizeRaf = 0
const transformer = new Transformer()

function scheduleMarkmapFit() {
  if (!mm) return
  cancelAnimationFrame(resizeRaf)
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0
    void mm!.fit().catch(() => {})
  })
}

function ensureResizeObserver() {
  if (resizeObserver || !container.value) return
  resizeObserver = new ResizeObserver(() => scheduleMarkmapFit())
  resizeObserver.observe(container.value)
}

function getColorScheme() {
  const style = getComputedStyle(document.documentElement)
  const vars = ['--c-blue', '--c-green', '--c-mauve', '--c-peach', '--c-teal', '--c-pink', '--c-yellow', '--c-lavender']
  const fallbacks = ['#89b4fa', '#a6e3a1', '#cba6f7', '#fab387', '#94e2d5', '#f5c2e7', '#f9e2af', '#b4befe']
  return vars.map((v, i) => {
    const val = style.getPropertyValue(v).trim()
    return val || fallbacks[i]
  })
}

function getNodeColor(node: any) {
  const colors = getColorScheme()
  const depth = node.state?.depth ?? 0
  return colors[depth % colors.length]
}

function ensureSvg() {
  if (svgEl || !container.value) return
  svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svgEl.style.width = '100%'
  svgEl.style.height = '100%'
  svgEl.style.display = 'block'
  container.value.insertBefore(svgEl, container.value.firstChild)
}

function renderMap() {
  ensureSvg()
  if (!svgEl) return
  const { root } = transformer.transform(props.content || '# Empty')

  // Update dark mode class on container
  container.value!.classList.toggle('markmap-dark', isDark.value)

  if (!mm) {
    mm = Markmap.create(svgEl, {
      color: getNodeColor,
      paddingX: 16,
      autoFit: true,
      duration: 300,
      scrollForPan: true,
    })

    // Custom zoom: Command+wheel or trackpad pinch (ctrlKey) for zoom
    mm.zoom.filter((event: any) => {
      if (event.type === 'wheel') {
        return (event.metaKey || event.ctrlKey) && !event.button
      }
      return !event.ctrlKey && !event.metaKey && !event.button
    })
  }

  mm.setData(root)
  mm.fit()
  ensureResizeObserver()
}

function fitToCanvas() {
  mm?.fit()
}

watch(() => props.content, () => {
  nextTick(renderMap)
})

watch(() => props.theme, () => {
  nextTick(renderMap)
})

onMounted(() => {
  nextTick(renderMap)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(resizeRaf)
  resizeRaf = 0
  resizeObserver?.disconnect()
  resizeObserver = null
  if (mm) {
    mm.destroy()
    mm = null
  }
  if (svgEl) {
    svgEl.remove()
    svgEl = null
  }
})
</script>

<template>
  <div ref="container" class="mindmap-container">
    <div class="mindmap-toolbar">
      <button class="mindmap-toolbar-btn" title="适应画布" @click="fitToCanvas">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M15 3h6v6" /><path d="M9 21H3v-6" />
          <path d="M21 3l-7 7" /><path d="M3 21l7-7" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.mindmap-container {
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
  background: var(--c-base);
}

/* markmap-view 默认浅色变量；与 data-theme 对齐，避免夜间模式白底 + 浅色字 */
.mindmap-container :deep(.markmap) {
  --markmap-text-color: var(--c-text);
  --markmap-code-bg: var(--c-surface0);
  --markmap-code-color: var(--c-subtext0);
  --markmap-circle-open-bg: var(--c-base);
  --markmap-a-color: var(--c-blue);
  --markmap-a-hover-color: var(--c-blue);
  --markmap-highlight-bg: color-mix(in srgb, var(--c-yellow) 40%, transparent);
}

.mindmap-toolbar {
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
}

.mindmap-toolbar-btn {
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

.mindmap-toolbar-btn:hover {
  background: var(--c-surface0);
  color: var(--c-text);
}
</style>
