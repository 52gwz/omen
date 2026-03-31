<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ChatView from './ChatView.vue'
import MonacoEditor from './MonacoEditor.vue'
import SkillsTab from './SkillsTab.vue'
import TerminalTab from './TerminalTab.vue'
import WindowMonitorTab from './WindowMonitorTab.vue'
import WebViewTab from './WebViewTab.vue'
import WelcomeScreen from './WelcomeScreen.vue'
import { MIN_SPLIT_RATIO } from '../types/workspace'
import { getFileIcon } from '../utils/fileIcons'
import type { DragTabState, DropPosition, DropTarget, PaneNode, PaneSplitNode, PaneState, TabInfo, TabInsertTarget } from '../types/workspace'

defineOptions({ name: 'WorkspacePane' })

interface WelcomeSendPayload {
  text: string
  images?: string[]
  providerId: string
  model: string
  mode: 'chat' | 'agent'
}

const props = defineProps<{
  node: PaneNode
  activePaneId: string
  runningConvIds: Set<string>
  tabTitles: Record<string, string>
  projectName?: string
  draggingTab: DragTabState | null
  interactionActive: boolean
  dropTarget: DropTarget | null
  tabInsertTarget: TabInsertTarget | null
  skillsTabId: string
  webviewPrefix: string
  editorPrefix: string
  terminalPrefix: string
  monitorPrefix: string
  projectPath?: string
}>()

const emit = defineEmits<{
  focusPane: [paneId: string]
  switchTab: [paneId: string, idx: number]
  addTab: [paneId: string]
  addWebviewTab: [paneId: string]
  addTerminalTab: [paneId: string]
  addMonitorTab: [paneId: string]
  closeTab: [paneId: string, idx: number]
  tabDragStart: [paneId: string, tabId: string]
  tabDragEnd: []
  dropZoneDragOver: [paneId: string, position: DropPosition]
  dropZoneDrop: [paneId: string, position: DropPosition]
  tabInsertDragOver: [paneId: string, index: number]
  tabInsertDrop: [paneId: string, index: number]
  streamingChange: [convId: string, streaming: boolean]
  titleChange: [convId: string, title: string]
  setChatRef: [convId: string, el: any]
  welcomeSend: [payload: WelcomeSendPayload]
  openProject: [project: ProjectData]
  splitResizeStart: []
  splitResizeEnd: []
  splitResize: [splitNode: PaneSplitNode, ratio: number]
  fileRefDrop: [paneId: string, position: DropPosition, filePaths: string[]]
  fileRefDragOver: [paneId: string, position: DropPosition]
  fileRefDragLeave: []
}>()

const splitPaneEl = ref<HTMLElement | null>(null)
const isResizingSplit = ref(false)

let removeSplitResizeListeners: (() => void) | null = null

function isConversationTab(convId: string): boolean {
  return !!convId
    && convId !== props.skillsTabId
    && !convId.startsWith(props.webviewPrefix)
    && !convId.startsWith(props.editorPrefix)
    && !convId.startsWith(props.terminalPrefix)
    && !convId.startsWith(props.monitorPrefix)
}

function getTabLabel(tab: TabInfo): string {
  if (!tab.convId) return '首页'
  if (tab.convId === props.skillsTabId) return '技能'
  if (tab.convId.startsWith(props.webviewPrefix)) {
    const fp = tab.convId.slice(props.webviewPrefix.length)
    if (fp.startsWith('__blank_')) return '浏览器'
    return fp.replace(/\\/g, '/').split('/').pop() || '预览'
  }
  if (tab.convId.startsWith(props.editorPrefix)) {
    const fp = tab.convId.slice(props.editorPrefix.length)
    return fp.replace(/\\/g, '/').split('/').pop() || '编辑器'
  }
  if (tab.convId.startsWith(props.terminalPrefix)) return '终端'
  if (tab.convId.startsWith(props.monitorPrefix)) return '窗口监视'
  return props.tabTitles[tab.convId] || '对话'
}

const pane = computed<PaneState | null>(() => props.node.type === 'pane' ? props.node.pane : null)
const activeConvId = computed(() => {
  if (!pane.value) return ''
  return pane.value.tabs[pane.value.activeTabIdx]?.convId || ''
})

const conversationTabIds = computed(() => {
  if (!pane.value) return []
  return pane.value.tabs
    .map(tab => tab.convId)
    .filter((convId, idx, arr) => isConversationTab(convId) && arr.indexOf(convId) === idx)
})

const webviewTabIds = computed(() => {
  if (!pane.value) return []
  return pane.value.tabs
    .map(tab => tab.convId)
    .filter((convId, idx, arr) => convId.startsWith(props.webviewPrefix) && arr.indexOf(convId) === idx)
})

const terminalTabIds = computed(() => {
  if (!pane.value) return []
  return pane.value.tabs
    .map(tab => tab.convId)
    .filter((convId, idx, arr) => convId.startsWith(props.terminalPrefix) && arr.indexOf(convId) === idx)
})

const monitorTabIds = computed(() => {
  if (!pane.value) return []
  return pane.value.tabs
    .map(tab => tab.convId)
    .filter((convId, idx, arr) => convId.startsWith(props.monitorPrefix) && arr.indexOf(convId) === idx)
})

const editorTabIds = computed(() => {
  if (!pane.value) return []
  return pane.value.tabs
    .map(tab => tab.convId)
    .filter((convId, idx, arr) => convId.startsWith(props.editorPrefix) && arr.indexOf(convId) === idx)
})

const disableSelfDropPreview = computed(() => {
  if (!pane.value || !props.draggingTab) return false
  return props.draggingTab.paneId === pane.value.id && pane.value.tabs.length <= 1
})

const fileRefDropTarget = ref<DropPosition | null>(null)

function isFileRefDrag(e: DragEvent): boolean {
  return !!e.dataTransfer?.types.includes('application/x-file-refs')
}

function onFileRefDragOver(event: DragEvent) {
  if (!isFileRefDrag(event)) return
  if (!pane.value) return
  event.preventDefault()
  event.stopPropagation()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  const position = resolveDropPosition(event)
  fileRefDropTarget.value = position
  emit('fileRefDragOver', pane.value.id, position)
}

function onFileRefDragLeave(event: DragEvent) {
  fileRefDropTarget.value = null
  emit('fileRefDragLeave')
}

function onFileRefDrop(event: DragEvent) {  
  if (!isFileRefDrag(event)) return
  if (!pane.value) return
  event.preventDefault()
  event.stopPropagation()
  const position = resolveDropPosition(event)
  fileRefDropTarget.value = null
  const data = event.dataTransfer?.getData('application/x-file-refs')
  if (!data) return
  try {
    const refs: Array<{ filePath: string; isDirectory: boolean }> = JSON.parse(data)
    const filePaths = refs.filter(r => !r.isDirectory).map(r => r.filePath)
    if (filePaths.length) {
      emit('fileRefDrop', pane.value.id, position, filePaths)
    }
  } catch {}
}

function onTabDragStart(paneId: string, tabId: string, event: DragEvent) {
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', tabId)
  }
  emit('tabDragStart', paneId, tabId)
}

function onZoneDragOver(position: DropPosition, event: DragEvent) {
  event.preventDefault()
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move'
  }
  if (pane.value) {
    emit('dropZoneDragOver', pane.value.id, position)
  }
}

function onZoneDrop(position: DropPosition, event: DragEvent) {
  event.preventDefault()
  if (pane.value) {
    emit('dropZoneDrop', pane.value.id, position)
  }
}

function onTabInsertDragOver(index: number, event: DragEvent) {
  event.preventDefault()
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move'
  }
  if (pane.value) {
    emit('tabInsertDragOver', pane.value.id, index)
  }
}

function onTabInsertDrop(index: number, event: DragEvent) {
  event.preventDefault()
  if (pane.value) {
    emit('tabInsertDrop', pane.value.id, index)
  }
}

function resolveDropPosition(event: DragEvent): DropPosition {
  const el = event.currentTarget as HTMLElement | null
  if (!el) return 'center'

  const rect = el.getBoundingClientRect()
  const width = Math.max(rect.width, 1)
  const height = Math.max(rect.height, 1)
  const x = (event.clientX - rect.left) / width
  const y = (event.clientY - rect.top) / height

  const centerInsetX = Math.min(0.28, Math.max(0.18, 120 / width))
  const centerInsetY = Math.min(0.28, Math.max(0.18, 120 / height))

  if (
    x >= centerInsetX
    && x <= 1 - centerInsetX
    && y >= centerInsetY
    && y <= 1 - centerInsetY
  ) {
    return 'center'
  }

  const distances: Array<[DropPosition, number]> = [
    ['left', x],
    ['right', 1 - x],
    ['top', y],
    ['bottom', 1 - y],
  ]

  distances.sort((a, b) => a[1] - b[1])
  return distances[0][0]
}

function onPaneDragOver(event: DragEvent) {
  if (disableSelfDropPreview.value) return
  onZoneDragOver(resolveDropPosition(event), event)
}

function onPaneDrop(event: DragEvent) {
  if (disableSelfDropPreview.value) return
  onZoneDrop(resolveDropPosition(event), event)
}

function resolveTabInsertIndex(idx: number, event: DragEvent): number {
  const el = event.currentTarget as HTMLElement | null
  if (!el) return idx
  const rect = el.getBoundingClientRect()
  const midpoint = rect.left + rect.width / 2
  return event.clientX < midpoint ? idx : idx + 1
}

function isDropTarget(position: DropPosition): boolean {
  return !!pane.value
    && props.dropTarget?.paneId === pane.value.id
    && props.dropTarget.position === position
}

function isTabInsertMarker(index: number): boolean {
  return !!pane.value
    && props.tabInsertTarget?.paneId === pane.value.id
    && props.tabInsertTarget.index === index
}

function getTabInsertClass(idx: number): Record<string, boolean> {
  return {
    'insert-before': isTabInsertMarker(idx),
    'insert-after': isTabInsertMarker(idx + 1),
  }
}

function clampSplitRatio(value: number): number {
  return Math.min(1 - MIN_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, value))
}

function cleanupSplitResize() {
  const hadActiveResize = isResizingSplit.value
  removeSplitResizeListeners?.()
  removeSplitResizeListeners = null
  isResizingSplit.value = false
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  if (hadActiveResize) {
    emit('splitResizeEnd')
  }
}

function onSplitResizeStart(event: PointerEvent) {
  if (props.node.type !== 'split') return

  const container = splitPaneEl.value
  if (!container) return

  event.preventDefault()
  cleanupSplitResize()
  isResizingSplit.value = true
  emit('splitResizeStart')

  const direction = props.node.direction
  const splitNode = props.node
  const updateRatio = (pointerEvent: PointerEvent) => {
    const rect = container.getBoundingClientRect()
    const size = direction === 'row' ? rect.width : rect.height
    if (size <= 0) return
    const offset = direction === 'row'
      ? pointerEvent.clientX - rect.left
      : pointerEvent.clientY - rect.top
    emit('splitResize', splitNode, clampSplitRatio(offset / size))
  }

  const handlePointerMove = (pointerEvent: PointerEvent) => {
    pointerEvent.preventDefault()
    updateRatio(pointerEvent)
  }
  const handlePointerUp = () => cleanupSplitResize()

  updateRatio(event)
  document.body.style.cursor = direction === 'row' ? 'col-resize' : 'row-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('pointermove', handlePointerMove)
  window.addEventListener('pointerup', handlePointerUp)
  window.addEventListener('pointercancel', handlePointerUp)
  removeSplitResizeListeners = () => {
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', handlePointerUp)
    window.removeEventListener('pointercancel', handlePointerUp)
  }
}

const tabsScrollEl = ref<HTMLElement | null>(null)
const canScrollLeft = ref(false)
const canScrollRight = ref(false)
const showTabList = ref(false)
function addChatTab() {
  if (!pane.value) return
  emit('addTab', pane.value.id)
}

function addBrowserTab() {
  if (!pane.value) return
  emit('addWebviewTab', pane.value.id)
}

function addTerminalTab() {
  if (!pane.value) return
  emit('addTerminalTab', pane.value.id)
}

function addMonitorTab() {
  if (!pane.value) return
  emit('addMonitorTab', pane.value.id)
}

function updateScrollState() {
  const el = tabsScrollEl.value
  if (!el) {
    canScrollLeft.value = false
    canScrollRight.value = false
    return
  }
  canScrollLeft.value = el.scrollLeft > 1
  canScrollRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
}

let scrollObserver: ResizeObserver | null = null

function onTabsWheel(event: WheelEvent) {
  const el = tabsScrollEl.value
  if (!el) return
  if (el.scrollWidth <= el.clientWidth) return
  event.preventDefault()
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
  el.scrollLeft += delta
}

function setupScrollObserver() {
  cleanupScrollObserver()
  const el = tabsScrollEl.value
  if (!el) return
  scrollObserver = new ResizeObserver(() => updateScrollState())
  scrollObserver.observe(el)
  el.addEventListener('scroll', updateScrollState, { passive: true })
  el.addEventListener('wheel', onTabsWheel, { passive: false })
  updateScrollState()
}

function cleanupScrollObserver() {
  const el = tabsScrollEl.value
  if (el) {
    el.removeEventListener('scroll', updateScrollState)
    el.removeEventListener('wheel', onTabsWheel)
  }
  scrollObserver?.disconnect()
  scrollObserver = null
}

function scrollTabs(direction: 'left' | 'right') {
  const el = tabsScrollEl.value
  if (!el) return
  const amount = el.clientWidth * 0.6
  el.scrollBy({ left: direction === 'left' ? -amount : amount, behavior: 'smooth' })
}

function scrollActiveTabIntoView() {
  if (!pane.value) return
  const el = tabsScrollEl.value
  if (!el) return
  const activeIdx = pane.value.activeTabIdx
  const tabEl = el.querySelectorAll('.tab-item')[activeIdx] as HTMLElement | undefined
  if (!tabEl) return
  const pad = 20
  const tabLeft = tabEl.offsetLeft
  const tabRight = tabLeft + tabEl.offsetWidth
  const viewLeft = el.scrollLeft
  const viewRight = viewLeft + el.clientWidth
  if (tabLeft - pad < viewLeft) {
    el.scrollTo({ left: Math.max(0, tabLeft - pad), behavior: 'smooth' })
  } else if (tabRight + pad > viewRight) {
    el.scrollTo({ left: tabRight + pad - el.clientWidth, behavior: 'smooth' })
  }
}

function selectFromList(idx: number) {
  if (!pane.value) return
  emit('switchTab', pane.value.id, idx)
  showTabList.value = false
}

function onClickOutsideTabList(event: MouseEvent) {
  const target = event.target as HTMLElement
  if (!target.closest('.tab-list-dropdown') && !target.closest('.tab-list-btn')) {
    showTabList.value = false
  }
}

watch(() => pane.value?.activeTabIdx, () => {
  nextTick(scrollActiveTabIntoView)
})

watch([canScrollLeft, canScrollRight], () => {
  nextTick(() => {
    requestAnimationFrame(scrollActiveTabIntoView)
  })
})

watch(() => pane.value?.tabs.length, () => {
  nextTick(() => {
    updateScrollState()
    scrollActiveTabIntoView()
  })
  // RAF after nextTick: ensure layout is fully settled for newly added tabs
  nextTick(() => {
    requestAnimationFrame(() => {
      updateScrollState()
      scrollActiveTabIntoView()
    })
  })
})

onMounted(() => {
  nextTick(setupScrollObserver)
  document.addEventListener('click', onClickOutsideTabList, true)
  
})

onBeforeUnmount(() => {
  cleanupSplitResize()
  cleanupScrollObserver()
  document.removeEventListener('click', onClickOutsideTabList, true)
  
})
</script>

<template>
  <div v-if="node.type === 'split'" ref="splitPaneEl" class="split-pane" :class="node.direction">
    <div class="split-slot" :style="{ flex: String(node.ratio) }">
      <WorkspacePane
        :key="node.first.type === 'pane' ? node.first.pane.id : node.first.id"
        :node="node.first"
        :active-pane-id="activePaneId"
        :running-conv-ids="runningConvIds"
        :tab-titles="tabTitles"
        :project-name="projectName"
        :dragging-tab="draggingTab"
        :interaction-active="interactionActive"
        :drop-target="dropTarget"
        :tab-insert-target="tabInsertTarget"
        :skills-tab-id="skillsTabId"
        :webview-prefix="webviewPrefix"
        :editor-prefix="editorPrefix"
        :terminal-prefix="terminalPrefix"
        :monitor-prefix="monitorPrefix"
        :project-path="projectPath"
        @focus-pane="emit('focusPane', $event)"
        @switch-tab="(paneId, idx) => emit('switchTab', paneId, idx)"
        @add-tab="emit('addTab', $event)"
        @add-webview-tab="emit('addWebviewTab', $event)"
        @add-terminal-tab="emit('addTerminalTab', $event)"
        @add-monitor-tab="emit('addMonitorTab', $event)"
        @close-tab="(paneId, idx) => emit('closeTab', paneId, idx)"
        @tab-drag-start="(paneId, tabId) => emit('tabDragStart', paneId, tabId)"
        @tab-drag-end="emit('tabDragEnd')"
        @drop-zone-drag-over="(paneId, position) => emit('dropZoneDragOver', paneId, position)"
        @drop-zone-drop="(paneId, position) => emit('dropZoneDrop', paneId, position)"
        @tab-insert-drag-over="(paneId, index) => emit('tabInsertDragOver', paneId, index)"
        @tab-insert-drop="(paneId, index) => emit('tabInsertDrop', paneId, index)"
        @streaming-change="(convId, streaming) => emit('streamingChange', convId, streaming)"
        @title-change="(convId, title) => emit('titleChange', convId, title)"
        @set-chat-ref="(convId, el) => emit('setChatRef', convId, el)"
        @welcome-send="emit('welcomeSend', $event)"
        @open-project="emit('openProject', $event)"
        @split-resize-start="emit('splitResizeStart')"
        @split-resize-end="emit('splitResizeEnd')"
        @split-resize="(splitNode, ratio) => emit('splitResize', splitNode, ratio)"
        @file-ref-drop="(paneId, position, filePaths) => emit('fileRefDrop', paneId, position, filePaths)"
      />
    </div>
    <div
      class="split-divider"
      :class="node.direction"
      @pointerdown="onSplitResizeStart"
    ></div>
    <div class="split-slot" :style="{ flex: String(1 - node.ratio) }">
      <WorkspacePane
        :key="node.second.type === 'pane' ? node.second.pane.id : node.second.id"
        :node="node.second"
        :active-pane-id="activePaneId"
        :running-conv-ids="runningConvIds"
        :tab-titles="tabTitles"
        :project-name="projectName"
        :dragging-tab="draggingTab"
        :interaction-active="interactionActive"
        :drop-target="dropTarget"
        :tab-insert-target="tabInsertTarget"
        :skills-tab-id="skillsTabId"
        :webview-prefix="webviewPrefix"
        :editor-prefix="editorPrefix"
        :terminal-prefix="terminalPrefix"
        :monitor-prefix="monitorPrefix"
        :project-path="projectPath"
        @focus-pane="emit('focusPane', $event)"
        @switch-tab="(paneId, idx) => emit('switchTab', paneId, idx)"
        @add-tab="emit('addTab', $event)"
        @add-webview-tab="emit('addWebviewTab', $event)"
        @add-terminal-tab="emit('addTerminalTab', $event)"
        @add-monitor-tab="emit('addMonitorTab', $event)"
        @close-tab="(paneId, idx) => emit('closeTab', paneId, idx)"
        @tab-drag-start="(paneId, tabId) => emit('tabDragStart', paneId, tabId)"
        @tab-drag-end="emit('tabDragEnd')"
        @drop-zone-drag-over="(paneId, position) => emit('dropZoneDragOver', paneId, position)"
        @drop-zone-drop="(paneId, position) => emit('dropZoneDrop', paneId, position)"
        @tab-insert-drag-over="(paneId, index) => emit('tabInsertDragOver', paneId, index)"
        @tab-insert-drop="(paneId, index) => emit('tabInsertDrop', paneId, index)"
        @streaming-change="(convId, streaming) => emit('streamingChange', convId, streaming)"
        @title-change="(convId, title) => emit('titleChange', convId, title)"
        @set-chat-ref="(convId, el) => emit('setChatRef', convId, el)"
        @welcome-send="emit('welcomeSend', $event)"
        @open-project="emit('openProject', $event)"
        @split-resize-start="emit('splitResizeStart')"
        @split-resize-end="emit('splitResizeEnd')"
        @split-resize="(splitNode, ratio) => emit('splitResize', splitNode, ratio)"
        @file-ref-drop="(paneId, position, filePaths) => emit('fileRefDrop', paneId, position, filePaths)"
      />
    </div>
  </div>

  <div
    v-else
    class="workspace-pane"
    @mousedown="emit('focusPane', node.pane.id)"
  >
    <div class="tab-bar">
      <div class="tab-bar-content">
        <button
          v-if="canScrollLeft"
          class="tab-scroll-btn left"
          @click.stop="scrollTabs('left')"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div
          ref="tabsScrollEl"
          class="tabs-scroll"
          :class="{ 'has-scroll-left': canScrollLeft, 'has-scroll-right': canScrollRight }"
          @dragover="draggingTab ? onTabInsertDragOver(node.pane.tabs.length, $event) : undefined"
          @drop="draggingTab ? onTabInsertDrop(node.pane.tabs.length, $event) : undefined"
        >
          <div
            v-for="(tab, idx) in node.pane.tabs"
            :key="tab.id"
            class="tab-item"
            :class="{
              active: node.pane.activeTabIdx === idx,
              'home-tab': !tab.convId,
              'skills-tab': tab.convId === skillsTabId,
              'webview-tab': tab.convId.startsWith(webviewPrefix),
              'editor-tab': tab.convId.startsWith(editorPrefix),
              'terminal-tab': tab.convId.startsWith(terminalPrefix),
              'monitor-tab': tab.convId.startsWith(monitorPrefix),
              'conv-tab': isConversationTab(tab.convId),
              ...getTabInsertClass(idx)
            }"
            draggable="true"
            @click="emit('switchTab', node.pane.id, idx)"
            @dragstart="onTabDragStart(node.pane.id, tab.id, $event)"
            @dragend="emit('tabDragEnd')"
            @dragover.stop="onTabInsertDragOver(resolveTabInsertIndex(idx, $event), $event)"
            @drop.stop="onTabInsertDrop(resolveTabInsertIndex(idx, $event), $event)"
          >
            <svg v-if="!tab.convId" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
            <svg v-else-if="tab.convId === skillsTabId" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="7" cy="7" r="3" />
              <circle cx="17" cy="7" r="3" />
              <circle cx="7" cy="17" r="3" />
              <circle cx="17" cy="17" r="3" />
            </svg>
            <svg v-else-if="tab.convId.startsWith(webviewPrefix)" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
            <svg v-else-if="tab.convId.startsWith(terminalPrefix)" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            <svg v-else-if="tab.convId.startsWith(monitorPrefix)" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4" width="18" height="14" rx="2" />
              <line x1="9" y1="20" x2="15" y2="20" />
              <circle cx="12" cy="11" r="2" />
            </svg>
            <img v-else-if="tab.convId.startsWith(editorPrefix)" :src="getFileIcon(tab.convId.slice(editorPrefix.length))" width="14" height="14" alt="file icon" />
            <svg v-else-if="isConversationTab(tab.convId)" class="conv-tab-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span
              v-if="isConversationTab(tab.convId) && runningConvIds.has(tab.convId)"
              class="tab-running-dot"
            ></span>
            <span class="tab-title">{{ getTabLabel(tab) }}</span>
            <button class="tab-close-btn" title="关闭" @click.stop="emit('closeTab', node.pane.id, idx)">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <!-- + 按钮在没有滚动时跟随在最后一个 tab 后面 -->
          <button v-if="!canScrollLeft && !canScrollRight" class="tab-add-btn inline" title="新建对话" @click.stop="addChatTab">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>
        <!-- + 按钮在有滚动时固定在右侧 -->
        <button v-if="canScrollLeft || canScrollRight" class="tab-add-btn fixed" title="新建对话" @click.stop="addChatTab">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <button
          v-if="canScrollRight"
          class="tab-scroll-btn right"
          @click.stop="scrollTabs('right')"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        <div v-if="(canScrollLeft || canScrollRight) && node.pane.tabs.length > 1" class="tab-list-wrapper">
          <button class="tab-list-btn" title="所有标签页" @click.stop="showTabList = !showTabList">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          <div v-if="showTabList" class="tab-list-dropdown">
            <div
              v-for="(tab, idx) in node.pane.tabs"
              :key="tab.id"
              class="tab-list-item"
              :class="{ active: node.pane.activeTabIdx === idx }"
              @click="selectFromList(idx)"
            >
              <svg v-if="!tab.convId" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <polyline points="9 22 9 12 15 12 15 22" />
              </svg>
              <svg v-else-if="tab.convId === skillsTabId" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="7" cy="7" r="3" />
                <circle cx="17" cy="7" r="3" />
                <circle cx="7" cy="17" r="3" />
                <circle cx="17" cy="17" r="3" />
              </svg>
              <svg v-else-if="tab.convId.startsWith(webviewPrefix)" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              <svg v-else-if="tab.convId.startsWith(terminalPrefix)" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
              <svg v-else-if="tab.convId.startsWith(monitorPrefix)" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="4" width="18" height="14" rx="2" />
                <line x1="9" y1="20" x2="15" y2="20" />
                <circle cx="12" cy="11" r="2" />
              </svg>
              <img v-else-if="tab.convId.startsWith(editorPrefix)" :src="getFileIcon(tab.convId.slice(editorPrefix.length))" width="14" height="14" alt="file icon" />
              <svg v-else-if="isConversationTab(tab.convId)" class="conv-tab-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              <span class="tab-list-label">{{ getTabLabel(tab) }}</span>
              <button class="tab-list-close" @click.stop="emit('closeTab', node.pane.id, idx)">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>
        </div>
        <button class="tab-browser-btn" title="新建浏览器" @click.stop="addBrowserTab">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
        </button>
        <button class="tab-browser-btn" title="新建终端" @click.stop="addTerminalTab">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
        </button>
        <button class="tab-browser-btn" title="新建窗口监视" @click.stop="addMonitorTab">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="4" width="18" height="14" rx="2" />
            <line x1="9" y1="20" x2="15" y2="20" />
            <circle cx="12" cy="11" r="2" />
          </svg>
        </button>
      </div>
    </div>

    <div
      class="pane-content"
      @dragover="draggingTab && !disableSelfDropPreview ? onPaneDragOver($event) : onFileRefDragOver($event)"
      @drop="draggingTab && !disableSelfDropPreview ? onPaneDrop($event) : onFileRefDrop($event)"
      @dragleave="onFileRefDragLeave"
    >
      <ChatView
        v-for="convId in conversationTabIds"
        v-show="convId === activeConvId"
        :key="convId"
        :ref="(el: any) => emit('setChatRef', convId, el)"
        :conversation-id="convId"
        @streaming-change="(streaming: boolean) => emit('streamingChange', convId, streaming)"
        @title-change="(title: string) => emit('titleChange', convId, title)"
      />

      <SkillsTab v-if="activeConvId === skillsTabId" />

      <WebViewTab
        v-for="convId in webviewTabIds"
        v-show="convId === activeConvId"
        :key="convId"
        :file-path="convId.slice(webviewPrefix.length)"
        :drag-active="interactionActive"
      />

      <TerminalTab
        v-for="convId in terminalTabIds"
        v-show="convId === activeConvId"
        :key="convId"
        :terminal-id="convId.slice(terminalPrefix.length)"
        :cwd="projectPath"
        :active="convId === activeConvId"
        :drag-active="interactionActive"
      />

      <WindowMonitorTab
        v-for="convId in monitorTabIds"
        v-show="convId === activeConvId"
        :key="convId"
        :monitor-id="convId.slice(monitorPrefix.length)"
        :active="convId === activeConvId"
        :drag-active="interactionActive"
      />

      <MonacoEditor
        v-for="convId in editorTabIds"
        v-show="convId === activeConvId"
        :key="convId"
        :file-path="convId.slice(editorPrefix.length)"
      />

      <WelcomeScreen
        v-if="!activeConvId"
        :project-name="projectName"
        @send="emit('welcomeSend', $event)"
        @open-project="emit('openProject', $event)"
      />

      <div
        v-if="draggingTab && !disableSelfDropPreview"
        class="pane-drop-capture"
        @dragover.stop="onPaneDragOver"
        @drop.stop="onPaneDrop"
      ></div>

      <div
        v-if="draggingTab && !disableSelfDropPreview && dropTarget?.paneId === node.pane.id"
        class="pane-drop-overlay"
      >
        <div v-if="isDropTarget('left')" class="pane-drop-highlight is-left"></div>
        <div v-else-if="isDropTarget('right')" class="pane-drop-highlight is-right"></div>
        <div v-else-if="isDropTarget('top')" class="pane-drop-highlight is-top"></div>
        <div v-else-if="isDropTarget('bottom')" class="pane-drop-highlight is-bottom"></div>
        <div v-else-if="isDropTarget('center')" class="pane-drop-highlight is-center"></div>
      </div>

      <div
        v-if="!draggingTab && fileRefDropTarget"
        class="pane-drop-overlay"
      >
        <div v-if="fileRefDropTarget === 'left'" class="pane-drop-highlight is-left"></div>
        <div v-else-if="fileRefDropTarget === 'right'" class="pane-drop-highlight is-right"></div>
        <div v-else-if="fileRefDropTarget === 'top'" class="pane-drop-highlight is-top"></div>
        <div v-else-if="fileRefDropTarget === 'bottom'" class="pane-drop-highlight is-bottom"></div>
        <div v-else-if="fileRefDropTarget === 'center'" class="pane-drop-highlight is-center"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.split-pane,
.workspace-pane {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.split-pane {
  display: flex;
  background: var(--c-base);
}

.split-pane.row {
  flex-direction: row;
}

.split-pane.column {
  flex-direction: column;
}

.split-slot {
  display: flex;
  min-width: 0;
  min-height: 0;
}

.split-divider {
  position: relative;
  flex-shrink: 0;
  background: transparent;
  -webkit-app-region: no-drag;
  touch-action: none;
  z-index: 2;
}

/* flex 只占 1px；透明 ::before 向两侧各伸出，总感应宽度 8px */
.split-divider::before {
  content: '';
  position: absolute;
  pointer-events: auto;
}

.split-divider.row::before {
  left: 50%;
  top: 0;
  bottom: 0;
  width: 8px;
  transform: translateX(-50%);
  cursor: col-resize;
}

.split-divider.column::before {
  top: 50%;
  left: 0;
  right: 0;
  height: 8px;
  transform: translateY(-50%);
  cursor: row-resize;
}

.split-divider::after {
  content: '';
  position: absolute;
  background: color-mix(in srgb, var(--c-surface1) 55%, var(--c-mantle));
  pointer-events: none;
  z-index: 1;
}

.split-divider.row {
  width: 1px;
  cursor: col-resize;
}

.split-divider.row::after {
  left: 50%;
  top: 0;
  bottom: 0;
  width: 1px;
  transform: translateX(-50%);
}

.split-divider.column {
  height: 1px;
  cursor: row-resize;
}

.split-divider.column::after {
  top: 50%;
  left: 0;
  right: 0;
  height: 1px;
  transform: translateY(-50%);
}

.workspace-pane {
  display: flex;
  flex-direction: column;
  background: var(--c-base);
  overflow: hidden;
}

.tab-bar {
  flex-shrink: 0;
  background: var(--c-tab-bar-bg);
  -webkit-app-region: drag;
}

.tab-bar-content {
  display: flex;
  align-items: stretch;
  padding: 0;
  gap: 0;
  min-height: 35px;
}

.tabs-scroll {
  display: flex;
  align-items: stretch;
  gap: 0;
  flex: 1;
  overflow-x: auto;
  min-width: 0;
  scrollbar-width: none;
  -ms-overflow-style: none;
  mask-image: linear-gradient(to right, transparent 0px, black 0px);
  -webkit-mask-image: linear-gradient(to right, transparent 0px, black 0px);
}

.tabs-scroll.has-scroll-left {
  mask-image: linear-gradient(to right, transparent 0px, black 12px);
  -webkit-mask-image: linear-gradient(to right, transparent 0px, black 12px);
}

.tabs-scroll.has-scroll-right {
  mask-image: linear-gradient(to left, transparent 0px, black 12px);
  -webkit-mask-image: linear-gradient(to left, transparent 0px, black 12px);
}

.tabs-scroll.has-scroll-left.has-scroll-right {
  mask-image: linear-gradient(to right, transparent 0px, black 12px, black calc(100% - 12px), transparent 100%);
  -webkit-mask-image: linear-gradient(to right, transparent 0px, black 12px, black calc(100% - 12px), transparent 100%);
}

.tabs-scroll::-webkit-scrollbar {
  display: none;
}

.tab-scroll-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 26px;
  align-self: center;
  border-radius: 2px;
  border: none;
  background: transparent;
  color: var(--c-overlay0);
  cursor: pointer;
  flex-shrink: 0;
  transition: color 0.12s, background 0.12s;
  -webkit-app-region: no-drag;
}

.tab-scroll-btn:hover {
  color: var(--c-text);
  background: color-mix(in srgb, var(--c-text) 8%, transparent);
}

.tab-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  min-height: 35px;
  border-radius: 0;
  cursor: pointer;
  white-space: nowrap;
  font-size: 13px;
  line-height: 1.3;
  background: var(--c-tab-inactive-bg);
  color: var(--c-tab-inactive-text);
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
  flex-shrink: 0;
  user-select: none;
  border: none;
  border-top: 1px solid transparent;
  border-right: 1px solid var(--c-tab-bar-bg);
  box-sizing: border-box;
  -webkit-app-region: no-drag;
  position: relative;
  z-index: 0;
}

.tab-item.active + .tab-item,
.tab-item:has(+ .tab-item.active) {
  border-right-color: transparent;
}


.tab-item:hover:not(.active) {
  background: color-mix(in srgb, var(--c-tab-inactive-bg) 70%, var(--c-surface0) 30%);
  color: var(--c-tab-active-text);
}

.tab-item.active {
  background: var(--c-base);
  color: var(--c-tab-active-text);
  font-weight: 400;
  border-top: 1px solid var(--c-blue);
  border-right-color: transparent;
  margin-bottom: -1px;
  padding-bottom: 1px;
  z-index: 1;
  box-shadow: 0 1px 0 var(--c-base);
}

:root:not([data-theme="dark"]) .tab-item.active {
  background: #ffffff;
  box-shadow: 0 1px 0 #ffffff;
}

:root[data-theme="dark"] .tab-item.active {
  background: #181818;
  box-shadow: 0 1px 0 #181818;
}

.home-tab svg,
.skills-tab svg,
.webview-tab svg,
.editor-tab svg,
.conv-tab-icon {
  color: var(--c-overlay0);
  flex-shrink: 0;
  transition: color 0.15s;
}

.home-tab.active svg,
.home-tab:hover svg {
  color: var(--c-blue);
}

.skills-tab.active svg,
.skills-tab:hover svg {
  color: var(--c-text);
}

.webview-tab.active svg,
.webview-tab:hover svg {
  color: var(--c-teal, #179299);
}

.monitor-tab.active svg,
.monitor-tab:hover svg {
  color: var(--c-yellow, #df8e1d);
}

.conv-tab.active .conv-tab-icon,
.conv-tab:hover .conv-tab-icon {
  color: var(--c-blue);
}

.editor-tab.active svg,
.editor-tab:hover svg {
  color: var(--c-green, #40a02b);
}

.conv-tab {
  max-width: 180px;
  position: relative;
}

.tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tab-close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 2px;
  border: none;
  background: transparent;
  color: var(--c-overlay0);
  cursor: pointer;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.12s, background 0.12s, color 0.12s;
}

.tab-item:hover .tab-close-btn,
.tab-item.active .tab-close-btn {
  opacity: 1;
}

.tab-close-btn:hover {
  background: color-mix(in srgb, var(--c-text) 12%, transparent);
  color: var(--c-text);
}

.tab-running-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--c-green, #40a02b);
  flex-shrink: 0;
  animation: tab-pulse 1.5s ease-in-out infinite;
}

@keyframes tab-pulse {
  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0.35;
  }
}

.tab-add-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  min-height: 35px;
  border-radius: 0;
  border: none;
  background: transparent;
  color: var(--c-overlay0);
  cursor: pointer;
  flex-shrink: 0;
  align-self: stretch;
  transition: color 0.12s;
  -webkit-app-region: no-drag;
}

.tab-add-btn:hover {
  color: var(--c-text);
}

/* 内联模式：跟随在最后一个 tab 后面 */
.tab-add-btn.inline {
  margin-left: 0;
}

/* 固定模式：固定在右侧 */
.tab-add-btn.fixed {
  /* 保持原有样式，固定在 tabs-scroll 容器外 */
}

.tab-browser-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  min-height: 35px;
  border-radius: 0;
  border: none;
  border-left: 1px solid color-mix(in srgb, var(--c-surface1) 40%, var(--c-mantle));
  background: transparent;
  color: var(--c-overlay0);
  cursor: pointer;
  flex-shrink: 0;
  align-self: stretch;
  transition: color 0.12s, background 0.12s;
  -webkit-app-region: no-drag;
}

.tab-browser-btn:hover {
  color: var(--c-teal, #179299);
  background: color-mix(in srgb, var(--c-surface0) 35%, var(--c-mantle));
}

.tab-list-wrapper {
  position: relative;
  flex-shrink: 0;
  -webkit-app-region: no-drag;
}

.tab-list-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  min-height: 35px;
  border-radius: 0;
  border: none;
  border-left: 1px solid color-mix(in srgb, var(--c-surface1) 40%, var(--c-mantle));
  background: transparent;
  color: var(--c-overlay0);
  cursor: pointer;
  flex-shrink: 0;
  align-self: stretch;
  transition: color 0.12s, background 0.12s;
}

.tab-list-btn:hover {
  color: var(--c-text);
  background: color-mix(in srgb, var(--c-surface0) 35%, var(--c-mantle));
}

.tab-list-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 50;
  min-width: 180px;
  max-width: 280px;
  max-height: 320px;
  overflow-y: auto;
  background: var(--c-mantle);
  border: 1px solid var(--c-surface1);
  border-radius: 8px;
  padding: 4px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
}

.tab-list-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.78rem;
  color: var(--c-subtext0);
  transition: background 0.12s, color 0.12s;
}

.tab-list-item:hover {
  background: var(--c-surface0);
  color: var(--c-text);
}

.tab-list-item.active {
  color: var(--c-text);
  font-weight: 500;
  background: var(--c-surface0);
}

.tab-list-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.tab-list-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  border: none;
  background: transparent;
  color: var(--c-overlay0);
  cursor: pointer;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.12s, background 0.12s, color 0.12s;
}

.tab-list-item:hover .tab-list-close {
  opacity: 1;
}

.tab-list-close:hover {
  background: var(--c-surface1);
  color: var(--c-text);
}

.tab-item.insert-before::before,
.tab-item.insert-after::after {
  content: '';
  position: absolute;
  top: 6px;
  bottom: 6px;
  width: 2px;
  background: var(--c-blue);
  border-radius: 1px;
}

.tab-item.insert-before::before {
  left: -2px;
}

.tab-item.insert-after::after {
  right: -2px;
}

.pane-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  position: relative;
}

.pane-drop-overlay {
  position: absolute;
  inset: 0;
  z-index: 30;
  pointer-events: none;
}

.pane-drop-capture {
  position: absolute;
  inset: 0;
  z-index: 29;
  background: transparent;
}

.pane-drop-highlight {
  position: absolute;
  border: 1px solid color-mix(in srgb, var(--c-overlay1) 42%, transparent);
  background: color-mix(in srgb, var(--c-surface1) 56%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c-text) 4%, transparent);
  transition: all 0.08s ease-out;
}

.pane-drop-highlight.is-left {
  left: 0;
  top: 0;
  bottom: 0;
  width: 50%;
}

.pane-drop-highlight.is-right {
  right: 0;
  top: 0;
  bottom: 0;
  width: 50%;
}

.pane-drop-highlight.is-top {
  left: 0;
  right: 0;
  top: 0;
  height: 50%;
}

.pane-drop-highlight.is-bottom {
  left: 0;
  right: 0;
  bottom: 0;
  height: 50%;
}

.pane-drop-highlight.is-center {
  inset: 0;
}
</style>
