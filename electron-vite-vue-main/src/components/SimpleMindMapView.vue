<script setup lang="ts">
import { ref, reactive, watch, onMounted, onBeforeUnmount, nextTick, computed } from 'vue'
import MindMap from 'simple-mind-map'
import Select from 'simple-mind-map/src/plugins/Select.js'
import Drag from 'simple-mind-map/src/plugins/Drag.js'

MindMap.usePlugin(Select)
MindMap.usePlugin(Drag)

const props = defineProps<{
  content: string
  theme: string
  readonly?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:content', value: string): void
}>()

const container = ref<HTMLDivElement>()
/** 库默认把节点编辑层挂到 body，scoped 样式无法命中；挂到此层并保持穿透点击 */
const editLayerMount = ref<HTMLDivElement>()
const isDark = computed(() => props.theme === 'dark')
const parseError = ref('')
let mindMap: InstanceType<typeof MindMap> | null = null
let isInternalChange = false
let ready = false
let lastEmittedJson = ''
let historyRecoveryTimer: ReturnType<typeof setTimeout> | null = null
let resizeObserver: ResizeObserver | null = null
let resizeRaf = 0

const ctxMenu = reactive({ visible: false, x: 0, y: 0, node: null as any })
const aiExpanding = ref(false)
const aiError = ref('')
let aiErrorTimer: ReturnType<typeof setTimeout> | null = null

/** AI 展开模型：默认与对话相同；可单独指定并写入 localStorage */
const LS_AI_FOLLOW = 'simpleMindMap.aiFollowChat'
const LS_AI_PROV = 'simpleMindMap.aiProviderId'
const LS_AI_MODEL = 'simpleMindMap.aiModel'
const LS_AI_DEBUG = 'simpleMindMap.aiDebug'

const aiFollowChat = ref(localStorage.getItem(LS_AI_FOLLOW) !== '0')
const customProviderId = ref(localStorage.getItem(LS_AI_PROV) || '')
const customModel = ref(localStorage.getItem(LS_AI_MODEL) || '')
const aiSettingsOpen = ref(false)
const aiSettingsWrapRef = ref<HTMLElement>()
const providers = ref<ModelProvider[]>([])
const globalActive = reactive({ providerId: '', model: '' })

function persistAiMindMapSettings() {
  localStorage.setItem(LS_AI_FOLLOW, aiFollowChat.value ? '1' : '0')
  localStorage.setItem(LS_AI_PROV, customProviderId.value)
  localStorage.setItem(LS_AI_MODEL, customModel.value)
}

watch([aiFollowChat, customProviderId, customModel], persistAiMindMapSettings)

function ensureCustomAiProviderSeeded() {
  if (providers.value.length === 0) return
  if (!customProviderId.value || !providers.value.some((p) => p.id === customProviderId.value))
    customProviderId.value = providers.value[0].id
  const p = providers.value.find((x) => x.id === customProviderId.value)
  if (p?.models?.length && (!customModel.value || !p.models.includes(customModel.value)))
    customModel.value = p.models[0]
}

watch(aiFollowChat, (follow) => {
  if (!follow) ensureCustomAiProviderSeeded()
})

async function refreshMindMapAiConfig() {
  try {
    const c = await window.aiChat.getConfig()
    providers.value = c.providers || []
    globalActive.providerId = c.activeProviderId || ''
    globalActive.model = c.activeModel || ''
    if (!aiFollowChat.value && customProviderId.value) {
      const p = providers.value.find((x) => x.id === customProviderId.value)
      if (!p) {
        customProviderId.value = ''
        customModel.value = ''
      } else if (p.models?.length && customModel.value && !p.models.includes(customModel.value)) {
        customModel.value = p.models[0]
      }
    }
    if (!aiFollowChat.value) ensureCustomAiProviderSeeded()
  } catch {
    /* ignore */
  }
}

watch(customProviderId, (id) => {
  const p = providers.value.find((x) => x.id === id)
  if (!p?.models?.length) return
  if (!customModel.value || !p.models.includes(customModel.value))
    customModel.value = p.models[0]
})

const effectiveAiModelLabel = computed(() => {
  if (aiFollowChat.value) {
    const name = providers.value.find((x) => x.id === globalActive.providerId)?.name || ''
    const m = globalActive.model
    if (!m) return '未配置'
    return name ? `${m} · ${name}` : m
  }
  const name = providers.value.find((x) => x.id === customProviderId.value)?.name || ''
  const m = customModel.value
  if (!m) return '未选择模型'
  return name ? `${m} · ${name}` : m
})

const customProviderModels = computed(() => {
  const p = providers.value.find((x) => x.id === customProviderId.value)
  return p?.models || []
})

function toggleAiSettings(e: MouseEvent) {
  e.stopPropagation()
  aiSettingsOpen.value = !aiSettingsOpen.value
  if (aiSettingsOpen.value) void refreshMindMapAiConfig()
}

const aiDebugEnabled = ref(localStorage.getItem(LS_AI_DEBUG) === '1')

watch(aiDebugEnabled, (on) => {
  localStorage.setItem(LS_AI_DEBUG, on ? '1' : '0')
})

interface SmmAiDebugSnapshot {
  at: number
  providerId: string
  model: string
  systemPrompt: string
  userPrompt: string
  rawResponse: string
  error?: string
  parseOk: boolean
}

const lastAiDebug = ref<SmmAiDebugSnapshot | null>(null)

function toggleAiDebugPanel(e: MouseEvent) {
  e.stopPropagation()
  aiDebugEnabled.value = !aiDebugEnabled.value
}

function clearAiDebug() {
  lastAiDebug.value = null
}

function logAiDebugToConsole(snap: SmmAiDebugSnapshot) {
  console.groupCollapsed(`[思维导图 AI 展开] ${new Date(snap.at).toLocaleString()} · ${snap.model}`)
  console.log('providerId', snap.providerId)
  console.log('--- system ---\n', snap.systemPrompt)
  console.log('--- user ---\n', snap.userPrompt)
  if (snap.error) console.error('--- error ---\n', snap.error)
  else console.log('--- assistant (raw) ---\n', snap.rawResponse)
  console.log('parseOk', snap.parseOk)
  console.groupEnd()
}

function formatAiDebugMeta(s: SmmAiDebugSnapshot) {
  let t = `${new Date(s.at).toLocaleString()}\nproviderId: ${s.providerId}\nmodel: ${s.model}\nparseOk: ${s.parseOk}`
  if (s.error) t += `\nerror: ${s.error}`
  return t
}

function scheduleSimpleMindMapResize() {
  if (!mindMap || !container.value) return
  cancelAnimationFrame(resizeRaf)
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0
    const r = container.value!.getBoundingClientRect()
    if (r.width <= 1 || r.height <= 1) return
    try {
      mindMap!.resize()
    } catch {
      /* 容器短暂为 0 时库会抛错，忽略 */
    }
  })
}

function ensureResizeObserver() {
  if (resizeObserver || !container.value) return
  resizeObserver = new ResizeObserver(() => scheduleSimpleMindMapResize())
  resizeObserver.observe(container.value)
}

/** 去掉库写入的字段，便于与磁盘 JSON 比较、导出更干净 */
function stripMindMapNoise(root: unknown): unknown {
  if (!root || typeof root !== 'object') return root
  const copy = JSON.parse(JSON.stringify(root)) as Record<string, unknown>
  delete copy.smmVersion
  function walk(node: unknown) {
    if (!node || typeof node !== 'object') return
    const n = node as { data?: Record<string, unknown>; children?: unknown[] }
    if (n.data && typeof n.data === 'object') {
      const d = n.data
      delete d.uid
      delete d.isActive
      if (d.expand === true) delete d.expand
      if (d.richText === false) delete d.richText
    }
    if (Array.isArray(n.children)) n.children.forEach(walk)
  }
  walk(copy)
  return copy
}

function mindMapJsonLooselyEqual(a: string, b: string): boolean {
  try {
    const sa = JSON.stringify(stripMindMapNoise(JSON.parse(a)))
    const sb = JSON.stringify(stripMindMapNoise(JSON.parse(b)))
    return sa === sb
  } catch {
    return false
  }
}

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
      fillColor: '#2a2a3c',
      color: '#e6eaf8',
      fontFamily: FONT_FAMILY,
      fontWeight: 'bold',
      borderColor: '#585b70',
      borderWidth: 1,
      borderRadius: 6,
      fontSize: 14,
      marginX: 80,
      marginY: 30,
    },
    node: {
      fillColor: 'transparent',
      color: '#e6eaf8',
      fontFamily: FONT_FAMILY,
      fontWeight: '500',
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
  if (historyRecoveryTimer) {
    clearTimeout(historyRecoveryTimer)
    historyRecoveryTimer = null
  }

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
    customInnerElsAppendTo: editLayerMount.value ?? undefined,
  } as any)

  mindMap.command.pause()

  // 仅首屏渲染结束后做一次 recovery + 历史基准；后续每次 node_tree_render_end 都会触发，
  // 若重复 clearHistory 会不断清空撤销栈，导致「不能撤销」。
  let initialHistorySeeded = false
  mindMap.on('node_tree_render_end', () => {
    if (!ready) ready = true
    if (initialHistorySeeded) return
    if (historyRecoveryTimer) clearTimeout(historyRecoveryTimer)
    historyRecoveryTimer = setTimeout(() => {
      historyRecoveryTimer = null
      if (!mindMap) return
      mindMap.command.recovery()
      mindMap.command.clearHistory()
      mindMap.command.originAddHistory()
      initialHistorySeeded = true
    }, 320)
  })

  mindMap.on('data_change', (newData: any) => {
    if (!ready || isInternalChange) {
      isInternalChange = false
      return
    }
    try {
      const json = JSON.stringify(stripMindMapNoise(newData), null, 2)
      if (!json || json === 'null' || json === 'undefined') return
      if (mindMapJsonLooselyEqual(json, props.content)) return
      lastEmittedJson = json
      emit('update:content', json)
    } catch {
      // ignore serialization errors
    }
  })

  mindMap.on('back_forward', (index: number, len: number) => {
    if (!mindMap || index < 0 || index >= len) return
    try {
      const dataStr = mindMap.command.history[index]
      if (!dataStr) return
      const data = JSON.parse(dataStr)
      const json = JSON.stringify(stripMindMapNoise(data), null, 2)
      if (!json || json === 'null') return
      if (mindMapJsonLooselyEqual(json, props.content)) return
      lastEmittedJson = json
      emit('update:content', json)
    } catch {
      // ignore
    }
  })

  mindMap.on('node_contextmenu', (e: MouseEvent, node: any) => {
    e.preventDefault()
    ctxMenu.visible = true
    ctxMenu.x = e.clientX
    ctxMenu.y = e.clientY
    ctxMenu.node = node
  })

  ensureResizeObserver()
}

function closeCtxMenu() {
  ctxMenu.visible = false
  ctxMenu.node = null
}

function showAiError(msg: string) {
  aiError.value = msg
  if (aiErrorTimer) clearTimeout(aiErrorTimer)
  aiErrorTimer = setTimeout(() => { aiError.value = '' }, 4000)
}

function getNodePath(node: any): string[] {
  const path: string[] = []
  let cur = node
  while (cur) {
    path.unshift(cur.getData('text') || '')
    cur = cur.parent
  }
  return path.filter(Boolean)
}

function parseAiChildren(response: string): Array<{ data: { text: string }; children: any[] }> {
  let text = response.trim()
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) text = fenceMatch[1].trim()
  const arrMatch = text.match(/\[[\s\S]*\]/)
  if (!arrMatch) return []
  try {
    const arr = JSON.parse(arrMatch[0])
    if (!Array.isArray(arr)) return []
    return arr
      .filter((item: any) => item?.data?.text && typeof item.data.text === 'string')
      .map((item: any) => ({
        data: { text: item.data.text },
        children: Array.isArray(item.children) ? item.children : [],
      }))
  } catch {
    return []
  }
}

async function aiExpandNode() {
  const node = ctxMenu.node
  if (!node || !mindMap) return
  closeCtxMenu()

  aiExpanding.value = true
  try {
    await refreshMindMapAiConfig()
    const config = await window.aiChat.getConfig()
    const useFollow = aiFollowChat.value
    const providerId = useFollow ? config.activeProviderId : customProviderId.value
    const model = useFollow ? config.activeModel : customModel.value
    if (!providerId || !model) {
      showAiError(useFollow ? '请先在设置中配置 AI 模型' : '请在右下角「AI 展开」设置中选择模型')
      return
    }

    const path = getNodePath(node)
    const existingChildren = (node.nodeData.children || [])
      .map((c: any) => c.data?.text)
      .filter(Boolean) as string[]

    const systemPrompt = [
      '根据用户传递的思维导图 JSON 数据和要展开的节点路径，返回纯 JSON 数组，每个元素为 { "data": { "text": "节点名" }, "children": [] }',
    ].join('\n')

    const rootData = mindMap.getData(false) as unknown
    const fullTree = stripMindMapNoise(rootData)
    let mapJson = JSON.stringify(fullTree, null, 2)
    const MAX_MAP_CONTEXT_CHARS = 400_000
    const totalLen = mapJson.length
    if (totalLen > MAX_MAP_CONTEXT_CHARS) {
      mapJson = `${mapJson.slice(0, MAX_MAP_CONTEXT_CHARS)}\n\n…（思维导图 JSON 过长已截断，完整约 ${totalLen} 字符）`
    }

    let userPrompt = [
      '以下是当前完整思维导图数据（JSON；含 data.text、可选 data.note / tag 等，children 为子节点）：',
      '',
      mapJson,
      '',
      '---',
      `当前要展开的节点路径：${path.join(' > ')}`,
    ].join('\n')
    if (existingChildren.length > 0) {
      userPrompt += `\n该节点已有直接子节点标题：${existingChildren.join('、')}`
    }
    userPrompt += `\n\n为节点「${node.getData('text')}」生成子节点。`

    lastAiDebug.value = {
      at: Date.now(),
      providerId,
      model,
      systemPrompt,
      userPrompt,
      rawResponse: '',
      error: undefined,
      parseOk: false,
    }

    const response = await window.aiChat.sendMessage({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      providerId,
    })

    const children = parseAiChildren(response)
    if (lastAiDebug.value) {
      lastAiDebug.value.rawResponse = response
      lastAiDebug.value.parseOk = children.length > 0
    }
    if (aiDebugEnabled.value && lastAiDebug.value)
      logAiDebugToConsole(lastAiDebug.value)

    if (children.length === 0) {
      showAiError('AI 未返回有效的子节点数据')
      return
    }

    for (const child of children) {
      node.nodeData.children.push(child)
    }
    node.setData({ expand: true })
    // simple-mind-map 的类型声明要求 render(callback, source)
    mindMap.render(() => {}, 'aiExpandNode')
  } catch (err: any) {
    if (lastAiDebug.value) {
      lastAiDebug.value.error = err?.message || String(err)
      if (aiDebugEnabled.value) logAiDebugToConsole(lastAiDebug.value)
    }
    showAiError(err?.message || 'AI 调用失败')
  } finally {
    aiExpanding.value = false
  }
}

function destroyMindMap() {
  cancelAnimationFrame(resizeRaf)
  resizeRaf = 0
  resizeObserver?.disconnect()
  resizeObserver = null
  if (historyRecoveryTimer) {
    clearTimeout(historyRecoveryTimer)
    historyRecoveryTimer = null
  }
  if (mindMap) {
    try {
      mindMap.command.recovery()
    } catch {
      /* ignore */
    }
    mindMap.destroy()
    mindMap = null
  }
  ready = false
}

function fitCanvas() {
  // simple-mind-map 的类型声明要求 fit(getRbox, enlarge, fitPadding)
  mindMap?.view?.fit(() => {}, false, undefined)
}

watch(() => props.content, (newVal) => {
  if (!mindMap) {
    nextTick(initMindMap)
    return
  }
  if (lastEmittedJson && mindMapJsonLooselyEqual(newVal, lastEmittedJson)) {
    lastEmittedJson = ''
    return
  }
  lastEmittedJson = ''
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

function onGlobalMousedown(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (ctxMenu.visible && !target.closest('.smm-ctx-menu'))
    closeCtxMenu()
  if (
    aiSettingsOpen.value
    && aiSettingsWrapRef.value
    && !aiSettingsWrapRef.value.contains(target)
    && !target.closest('.smm-ai-debug')
  )
    aiSettingsOpen.value = false
}

onMounted(() => {
  document.addEventListener('mousedown', onGlobalMousedown)
  void refreshMindMapAiConfig()
  nextTick(initMindMap)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onGlobalMousedown)
  if (aiErrorTimer) clearTimeout(aiErrorTimer)
  destroyMindMap()
})

defineExpose({ fitCanvas })
</script>

<template>
  <div class="smm-wrapper" :class="{ 'is-dark': isDark }">
    <div v-if="parseError" class="smm-error">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <span>{{ parseError }}</span>
    </div>
    <div v-show="!parseError" ref="editLayerMount" class="smm-edit-mount" aria-hidden="true" />
    <div v-show="!parseError" ref="container" class="smm-container"></div>

    <div v-if="!parseError && aiDebugEnabled" class="smm-ai-debug">
      <div class="smm-ai-debug-head">
        <span class="smm-ai-debug-title">AI 展开 · 对话调试</span>
        <button type="button" class="smm-ai-debug-clear" @click="clearAiDebug">清除记录</button>
      </div>
      <div v-if="!lastAiDebug" class="smm-ai-debug-empty">
        右键节点使用「AI 展开」后，将显示本次请求的 system / user 与模型原始回复（开发者工具控制台也会打一条折叠日志）。
      </div>
      <div v-else class="smm-ai-debug-body">
        <details open class="smm-ai-debug-details">
          <summary>元信息</summary>
          <pre class="smm-ai-debug-pre">{{ formatAiDebugMeta(lastAiDebug) }}</pre>
        </details>
        <details open class="smm-ai-debug-details">
          <summary>system</summary>
          <pre class="smm-ai-debug-pre">{{ lastAiDebug.systemPrompt }}</pre>
        </details>
        <details open class="smm-ai-debug-details">
          <summary>user（含完整导图 JSON）</summary>
          <pre class="smm-ai-debug-pre">{{ lastAiDebug.userPrompt }}</pre>
        </details>
        <details open class="smm-ai-debug-details">
          <summary>assistant（原始文本）</summary>
          <pre class="smm-ai-debug-pre">{{ lastAiDebug.rawResponse || '（无，可能请求失败）' }}</pre>
        </details>
      </div>
    </div>

    <div v-if="!parseError" ref="aiSettingsWrapRef" class="smm-toolbar-anchor">
      <Transition name="smm-toast">
        <div v-if="aiSettingsOpen" class="smm-ai-settings-pop" @mousedown.stop>
          <div class="smm-ai-settings-title">AI 展开所用模型</div>
          <p class="smm-ai-settings-hint">当前：{{ effectiveAiModelLabel }}</p>
          <label class="smm-ai-settings-row">
            <input v-model="aiFollowChat" type="radio" :value="true" />
            <span>与对话相同</span>
          </label>
          <label class="smm-ai-settings-row">
            <input v-model="aiFollowChat" type="radio" :value="false" />
            <span>自定义</span>
          </label>
          <template v-if="!aiFollowChat">
            <div v-if="!providers.length" class="smm-ai-settings-empty">请先在应用设置中配置模型供应商</div>
            <template v-else>
              <label class="smm-ai-settings-field">
                <span>供应商</span>
                <select v-model="customProviderId" class="smm-ai-settings-select">
                  <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
                </select>
              </label>
              <label v-if="customProviderModels.length" class="smm-ai-settings-field">
                <span>模型</span>
                <select v-model="customModel" class="smm-ai-settings-select">
                  <option v-for="m in customProviderModels" :key="m" :value="m">{{ m }}</option>
                </select>
              </label>
              <label v-else class="smm-ai-settings-field">
                <span>模型 ID</span>
                <input v-model="customModel" type="text" class="smm-ai-settings-select" placeholder="手动填写模型名" autocomplete="off" />
              </label>
            </template>
          </template>
          <label class="smm-ai-settings-row smm-ai-settings-debug-row">
            <input v-model="aiDebugEnabled" type="checkbox" />
            <span>显示 AI 展开调试面板</span>
          </label>
        </div>
      </Transition>
      <div class="smm-toolbar">
        <button
          type="button"
          class="smm-toolbar-btn"
          :class="{ 'smm-toolbar-btn-active': aiDebugEnabled }"
          title="切换 AI 展开调试面板（system / user / 原始回复）"
          aria-label="切换 AI 展开调试面板"
          @click="toggleAiDebugPanel"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <line x1="10" y1="9" x2="8" y2="9" />
          </svg>
        </button>
        <button
          type="button"
          class="smm-toolbar-btn"
          :class="{ 'smm-toolbar-btn-active': aiSettingsOpen }"
          :title="`AI 展开模型：${effectiveAiModelLabel}`"
          aria-label="AI 展开模型设置"
          @click="toggleAiSettings"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
          </svg>
        </button>
        <button type="button" class="smm-toolbar-btn" title="适应画布 (Ctrl+I)" @click="fitCanvas">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 3h6v6" /><path d="M9 21H3v-6" />
            <path d="M21 3l-7 7" /><path d="M3 21l7-7" />
          </svg>
        </button>
      </div>
    </div>

    <Transition name="smm-toast">
      <div v-if="aiExpanding" class="smm-toast">
        <span class="smm-toast-spinner" />
        <span>AI 正在展开节点…</span>
      </div>
    </Transition>

    <Transition name="smm-toast">
      <div v-if="aiError" class="smm-toast smm-toast-error">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span>{{ aiError }}</span>
      </div>
    </Transition>

    <Teleport to="body">
      <div
        v-if="ctxMenu.visible"
        class="smm-ctx-menu"
        :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
        @mousedown.stop
      >
        <button @click="aiExpandNode" :disabled="aiExpanding">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 11V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6" />
            <path d="m12 12 4 10 1.7-4.3L22 16Z" />
          </svg>
          AI 展开
        </button>
      </div>
    </Teleport>
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

.smm-edit-mount {
  position: fixed;
  inset: 0;
  pointer-events: none;
  /* 与 nodeTextEditZIndex 同级，否则整层会压在 z-index>0 的侧栏下面 */
  z-index: 9000;
}

.smm-edit-mount :deep(.smm-node-edit-wrap) {
  pointer-events: auto;
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

.smm-ai-debug {
  position: absolute;
  top: 8px;
  left: 8px;
  right: 8px;
  max-height: min(42vh, 520px);
  z-index: 12;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--c-surface0);
  border-radius: 10px;
  background: var(--c-mantle);
  box-shadow: 0 8px 28px var(--c-shadow-heavy, var(--c-shadow));
  overflow: hidden;
}

.smm-ai-debug-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--c-surface0);
  flex-shrink: 0;
}

.smm-ai-debug-title {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--c-text);
}

.smm-ai-debug-clear {
  border: none;
  background: var(--c-surface0);
  color: var(--c-subtext0);
  font-size: 0.72rem;
  padding: 4px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-family: inherit;
}

.smm-ai-debug-clear:hover {
  color: var(--c-text);
}

.smm-ai-debug-empty {
  padding: 12px 10px;
  font-size: 0.75rem;
  color: var(--c-overlay0);
  line-height: 1.45;
}

.smm-ai-debug-body {
  overflow-y: auto;
  min-height: 0;
  flex: 1;
  padding: 6px 8px 10px;
}

.smm-ai-debug-details {
  margin-bottom: 8px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--c-base) 70%, transparent);
  border: 1px solid var(--c-surface0);
}

.smm-ai-debug-details summary {
  cursor: pointer;
  padding: 6px 8px;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--c-subtext0);
  user-select: none;
}

.smm-ai-debug-pre {
  margin: 0;
  padding: 0 8px 8px;
  font-size: 0.68rem;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--c-subtext0);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  max-height: 28vh;
  overflow-y: auto;
}

.smm-ai-settings-debug-row {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--c-surface0);
}

/*
 * TextEdit：domText() 会写入与节点一致的字色；getBackground() 用节点填充色作编辑区背景。
 * 深色主题下若再把字强制成 #16161f，会与根/二级节点的深色底叠在一起 → 完全看不清。
 * 编辑态统一用主题「表面 + 正文色」，保证一级/二级与透明节点都对比足够。
 * 类名见 simple-mind-map TextEdit.js：smm-node-edit-wrap
 */
.smm-edit-mount :deep(.smm-node-edit-wrap) {
  background: var(--c-mantle, #eff1f5) !important;
  color: var(--c-text, #111) !important;
  -webkit-text-fill-color: var(--c-text, #111) !important;
  caret-color: var(--c-blue, #1e66f5) !important;
  border: 1px solid var(--c-surface0, #ccd0da) !important;
  box-shadow: 0 4px 24px var(--c-shadow-heavy, rgba(0, 0, 0, 0.22)) !important;
}

.smm-edit-mount :deep(.smm-node-edit-wrap *) {
  color: inherit !important;
  -webkit-text-fill-color: inherit !important;
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

.smm-toolbar-anchor {
  position: absolute;
  bottom: 12px;
  right: 12px;
  z-index: 11;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}

.smm-ai-settings-pop {
  background: var(--c-mantle);
  border: 1px solid var(--c-surface0);
  border-radius: 10px;
  padding: 10px 12px;
  min-width: 248px;
  max-width: min(320px, 92vw);
  box-shadow: 0 8px 24px var(--c-shadow-heavy, var(--c-shadow));
  font-size: 0.78rem;
  color: var(--c-subtext0);
}

.smm-ai-settings-title {
  font-weight: 600;
  color: var(--c-text);
  margin-bottom: 6px;
  font-size: 0.82rem;
}

.smm-ai-settings-hint {
  margin: 0 0 8px;
  line-height: 1.35;
  word-break: break-all;
}

.smm-ai-settings-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  cursor: pointer;
  color: var(--c-text);
}

.smm-ai-settings-row input {
  flex-shrink: 0;
}

.smm-ai-settings-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 8px;
}

.smm-ai-settings-field span {
  color: var(--c-overlay0);
  font-size: 0.72rem;
}

.smm-ai-settings-select {
  width: 100%;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid var(--c-surface0);
  background: var(--c-base);
  color: var(--c-text);
  font-size: 0.78rem;
  font-family: inherit;
}

.smm-ai-settings-empty {
  margin-top: 8px;
  color: var(--c-peach);
  line-height: 1.35;
}

.smm-toolbar {
  display: flex;
  gap: 4px;
  background: var(--c-mantle);
  border: 1px solid var(--c-surface0);
  border-radius: 8px;
  padding: 4px;
  box-shadow: 0 2px 10px var(--c-shadow);
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

.smm-toolbar-btn-active {
  background: var(--c-surface0);
  color: var(--c-blue);
}

/* ── AI toast ── */
.smm-toast {
  position: absolute;
  bottom: 12px;
  left: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--c-mantle);
  border: 1px solid var(--c-surface0);
  border-radius: 8px;
  padding: 6px 14px;
  font-size: 0.8rem;
  color: var(--c-subtext0);
  box-shadow: 0 2px 10px var(--c-shadow);
  z-index: 10;
  pointer-events: none;
}

.smm-toast-error {
  color: var(--c-peach);
  border-color: color-mix(in srgb, var(--c-peach) 30%, var(--c-surface0));
}

.smm-toast-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--c-surface1);
  border-top-color: var(--c-blue);
  border-radius: 50%;
  animation: smm-spin 0.7s linear infinite;
}

@keyframes smm-spin {
  to { transform: rotate(360deg); }
}

.smm-toast-enter-active,
.smm-toast-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}

.smm-toast-enter-from,
.smm-toast-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
</style>

<style>
/* Context menu: unscoped so Teleport works */
.smm-ctx-menu {
  position: fixed;
  z-index: 9999;
  background: var(--c-surface-alt, var(--c-mantle));
  border: 1px solid var(--c-surface1);
  border-radius: 8px;
  padding: 4px;
  box-shadow: 0 6px 20px var(--c-shadow-heavy, rgba(0, 0, 0, 0.25));
  min-width: 120px;
}

.smm-ctx-menu button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 12px;
  background: none;
  border: none;
  color: var(--c-text);
  font-size: 0.82rem;
  text-align: left;
  cursor: pointer;
  border-radius: 5px;
  font-family: inherit;
  transition: background 0.12s;
}

.smm-ctx-menu button:hover {
  background: var(--c-chrome-hover-bg, var(--c-surface0));
}

.smm-ctx-menu button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.smm-ctx-menu button svg {
  flex-shrink: 0;
  color: var(--c-blue);
}
</style>
