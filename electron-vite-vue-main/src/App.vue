<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import ChatView from './components/ChatView.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import Sidebar from './components/Sidebar.vue'
import WorkspacePane from './components/WorkspacePane.vue'
import { MIN_SPLIT_RATIO } from './types/workspace'
import type { DragTabState, DropPosition, DropTarget, PaneLeafNode, PaneNode, PaneSplitNode, PaneState, TabInfo, TabInsertTarget } from './types/workspace'

const SKILLS_TAB_ID = '__skills__'
const WEBVIEW_PREFIX = '__webview__:'
const EDITOR_PREFIX = '__editor__:'

interface TabContext {
  root: PaneNode
  activePaneId: string
}

interface WelcomeSendPayload {
  text: string
  images?: string[]
  providerId: string
  model: string
  mode: 'chat' | 'agent'
}

const showSettings = ref(false)
const chatRefs = ref<Record<string, InstanceType<typeof ChatView>>>({})
const sidebarRef = ref<InstanceType<typeof Sidebar>>()

const runningConvIds = reactive(new Set<string>())
const tabTitles = reactive<Record<string, string>>({})
const activeProject = ref<ProjectData | null>(null)
const draggingTab = ref<DragTabState | null>(null)
const splitResizeActive = ref(false)
const dropTarget = ref<DropTarget | null>(null)
const tabInsertTarget = ref<TabInsertTarget | null>(null)

let tabIdCounter = 1
let paneIdCounter = 1

function createTab(convId = ''): TabInfo {
  return { id: `tab-${tabIdCounter++}`, convId }
}

function createPane(tabs: TabInfo[] = [createTab()]): PaneState {
  return {
    id: `pane-${paneIdCounter++}`,
    tabs,
    activeTabIdx: 0,
  }
}

function createLeafNode(tabs?: TabInfo[]): PaneLeafNode {
  return {
    type: 'pane',
    pane: createPane(tabs),
  }
}

function createContext(): TabContext {
  const root = createLeafNode()
  return {
    root,
    activePaneId: root.pane.id,
  }
}

const tabContexts = reactive<Record<string, TabContext>>({
  '__home__': createContext(),
})

const ctxKey = computed(() => activeProject.value?.id || '__home__')

function ensureCtx(key: string): TabContext {
  if (!tabContexts[key]) {
    tabContexts[key] = createContext()
  }
  return tabContexts[key]
}

watch(ctxKey, (key) => ensureCtx(key), { immediate: true })

function getCtx(): TabContext {
  return ensureCtx(ctxKey.value)
}

function isConversationTab(convId: string): boolean {
  return !!convId
    && convId !== SKILLS_TAB_ID
    && !convId.startsWith(WEBVIEW_PREFIX)
    && !convId.startsWith(EDITOR_PREFIX)
}

function findPaneById(node: PaneNode, paneId: string): PaneState | null {
  if (node.type === 'pane') {
    return node.pane.id === paneId ? node.pane : null
  }
  return findPaneById(node.first, paneId) || findPaneById(node.second, paneId)
}

function getFirstPane(node: PaneNode): PaneState {
  return node.type === 'pane' ? node.pane : getFirstPane(node.first)
}

function getActivePane(ctx = getCtx()): PaneState {
  const pane = findPaneById(ctx.root, ctx.activePaneId)
  if (pane) return pane
  const fallback = getFirstPane(ctx.root)
  ctx.activePaneId = fallback.id
  return fallback
}

function forEachPane(node: PaneNode, visit: (pane: PaneState) => void) {
  if (node.type === 'pane') {
    visit(node.pane)
    return
  }
  forEachPane(node.first, visit)
  forEachPane(node.second, visit)
}

function countPanes(node: PaneNode): number {
  if (node.type === 'pane') return 1
  return countPanes(node.first) + countPanes(node.second)
}

function replaceNode(target: PaneNode, source: PaneNode) {
  if (source.type === 'pane') {
    delete (target as any).direction
    delete (target as any).ratio
    delete (target as any).first
    delete (target as any).second
    ;(target as any).type = 'pane'
    ;(target as any).pane = source.pane
    return
  }

  delete (target as any).pane
  ;(target as any).type = 'split'
  ;(target as any).direction = source.direction
  ;(target as any).ratio = source.ratio
  ;(target as any).first = source.first
  ;(target as any).second = source.second
}

function removePaneAt(node: PaneNode, paneId: string): boolean {
  if (node.type === 'pane') return false

  if (node.first.type === 'pane' && node.first.pane.id === paneId) {
    replaceNode(node, node.second)
    return true
  }

  if (node.second.type === 'pane' && node.second.pane.id === paneId) {
    replaceNode(node, node.first)
    return true
  }

  return removePaneAt(node.first, paneId) || removePaneAt(node.second, paneId)
}

function findTabLocationByConvId(node: PaneNode, convId: string): { pane: PaneState; idx: number } | null {
  if (node.type === 'pane') {
    const idx = node.pane.tabs.findIndex((tab) => tab.convId === convId)
    return idx === -1 ? null : { pane: node.pane, idx }
  }
  return findTabLocationByConvId(node.first, convId) || findTabLocationByConvId(node.second, convId)
}

function normalizePaneAfterTabRemoval(pane: PaneState, removedIdx: number) {
  if (!pane.tabs.length) {
    pane.tabs.push(createTab())
    pane.activeTabIdx = 0
    return
  }
  if (pane.activeTabIdx >= pane.tabs.length) {
    pane.activeTabIdx = pane.tabs.length - 1
  } else if (pane.activeTabIdx > removedIdx) {
    pane.activeTabIdx--
  }
}

function removePaneIfPossible(ctx: TabContext, paneId: string): boolean {
  if (countPanes(ctx.root) <= 1) return false
  const removed = removePaneAt(ctx.root, paneId)
  if (removed) {
    ctx.activePaneId = getFirstPane(ctx.root).id
  }
  return removed
}

function splitPaneAt(node: PaneNode, paneId: string, position: Exclude<DropPosition, 'center'>, newPane: PaneState): boolean {
  if (node.type === 'pane') {
    if (node.pane.id !== paneId) return false
    const currentPane = node.pane
    const currentLeaf: PaneLeafNode = { type: 'pane', pane: currentPane }
    const newLeaf: PaneLeafNode = { type: 'pane', pane: newPane }
    const insertBefore = position === 'left' || position === 'top'
    const direction = position === 'left' || position === 'right' ? 'row' : 'column'
    Object.assign(node as any, {
      type: 'split',
      direction,
      ratio: 0.5,
      first: insertBefore ? newLeaf : currentLeaf,
      second: insertBefore ? currentLeaf : newLeaf,
    })
    delete (node as any).pane
    return true
  }
  return splitPaneAt(node.first, paneId, position, newPane)
    || splitPaneAt(node.second, paneId, position, newPane)
}

function focusExistingTab(convId: string): boolean {
  const c = getCtx()
  const existing = findTabLocationByConvId(c.root, convId)
  if (!existing) return false
  c.activePaneId = existing.pane.id
  existing.pane.activeTabIdx = existing.idx
  return true
}

function openConversationTab(convId: string, options?: { title?: string; reuseActiveEmptyTab?: boolean }) {
  if (options?.title) tabTitles[convId] = options.title
  if (focusExistingTab(convId)) return

  const c = getCtx()
  const pane = getActivePane(c)
  const activeTab = pane.tabs[pane.activeTabIdx]

  if (options?.reuseActiveEmptyTab && activeTab && !activeTab.convId) {
    activeTab.convId = convId
  } else {
    pane.tabs.push(createTab(convId))
    pane.activeTabIdx = pane.tabs.length - 1
  }

  c.activePaneId = pane.id
}

const currentRoot = computed(() => tabContexts[ctxKey.value]?.root ?? null)
const activePane = computed(() => {
  const c = tabContexts[ctxKey.value]
  if (!c) return null
  return findPaneById(c.root, c.activePaneId) || getFirstPane(c.root)
})
const activeConvId = computed(() => {
  const pane = activePane.value
  if (!pane) return ''
  return pane.tabs[pane.activeTabIdx]?.convId || ''
})
const sidebarActiveConvId = computed(() => isConversationTab(activeConvId.value) ? activeConvId.value : '')

watch([ctxKey, sidebarActiveConvId], () => {
  nextTick(() => sidebarRef.value?.setActiveConv(sidebarActiveConvId.value))
}, { immediate: true })

function onOpenProject(project: ProjectData) {
  activeProject.value = project
}

function onCloseProject() {
  activeProject.value = null
}

function onRenameProject(projectId: string, newName: string) {
  if (activeProject.value?.id === projectId) {
    activeProject.value = { ...activeProject.value, name: newName }
  }
}

function onSettingsClose() {
  showSettings.value = false
  for (const r of Object.values(chatRefs.value)) {
    r?.loadConfig()
  }
}

function onSelectConversation(convId: string, title?: string) {
  openConversationTab(convId, { title })
}

function focusPane(paneId: string) {
  const c = getCtx()
  c.activePaneId = paneId
}

function switchTab(paneId: string, idx: number) {
  const c = getCtx()
  const pane = findPaneById(c.root, paneId)
  if (!pane || idx < 0 || idx >= pane.tabs.length) return
  pane.activeTabIdx = idx
  c.activePaneId = paneId
}

function addNewTab(paneId?: string) {
  const c = getCtx()
  const pane = paneId ? findPaneById(c.root, paneId) : getActivePane(c)
  if (!pane) return
  pane.tabs.push(createTab())
  pane.activeTabIdx = pane.tabs.length - 1
  c.activePaneId = pane.id
}

function openSkills() {
  if (focusExistingTab(SKILLS_TAB_ID)) return
  const c = getCtx()
  const pane = getActivePane(c)
  pane.tabs[pane.activeTabIdx].convId = SKILLS_TAB_ID
  c.activePaneId = pane.id
}

function openWebView(filePath: string) {
  const webviewId = WEBVIEW_PREFIX + filePath
  if (focusExistingTab(webviewId)) return
  const c = getCtx()
  const pane = getActivePane(c)
  pane.tabs.push(createTab(webviewId))
  pane.activeTabIdx = pane.tabs.length - 1
  c.activePaneId = pane.id
}

function onOpenFile(filePath: string) {
  const editorId = EDITOR_PREFIX + filePath
  if (focusExistingTab(editorId)) return
  const c = getCtx()
  const pane = getActivePane(c)
  pane.tabs.push(createTab(editorId))
  pane.activeTabIdx = pane.tabs.length - 1
  c.activePaneId = pane.id
}

function closeTab(paneId: string, idx: number) {
  const c = getCtx()
  const pane = findPaneById(c.root, paneId)
  if (!pane || idx < 0 || idx >= pane.tabs.length) return
  c.activePaneId = paneId
  if (pane.tabs.length <= 1) {
    if (!removePaneIfPossible(c, paneId)) {
      pane.tabs[0].convId = ''
      pane.activeTabIdx = 0
    }
    return
  }
  pane.tabs.splice(idx, 1)
  normalizePaneAfterTabRemoval(pane, idx)
}

function onConvTitleChange(convId: string, title: string) {
  tabTitles[convId] = title
  sidebarRef.value?.loadConversations()
}

function onNoSelection() {
  const pane = getActivePane()
  pane.tabs[pane.activeTabIdx].convId = ''
}

function onDeleteConversation(convId: string) {
  const c = getCtx()
  runningConvIds.delete(convId)
  delete chatRefs.value[convId]
  delete tabTitles[convId]
  forEachPane(c.root, (pane) => {
    for (const tab of pane.tabs) {
      if (tab.convId === convId) tab.convId = ''
    }
  })
}

function onStreamingChange(convId: string, streaming: boolean) {
  if (streaming) {
    runningConvIds.add(convId)
  } else {
    runningConvIds.delete(convId)
  }
}

function setChatRef(convId: string, el: any) {
  if (el) {
    chatRefs.value[convId] = el
  } else {
    delete chatRefs.value[convId]
  }
}

function clearDragState() {
  draggingTab.value = null
  dropTarget.value = null
  tabInsertTarget.value = null
}

function onTabDragStart(paneId: string, tabId: string) {
  draggingTab.value = { paneId, tabId }
  dropTarget.value = null
  tabInsertTarget.value = null
}

function onTabDragEnd() {
  clearDragState()
}

function onDropZoneDragOver(paneId: string, position: DropPosition) {
  dropTarget.value = { paneId, position }
  tabInsertTarget.value = null
}

function onTabInsertDragOver(paneId: string, index: number) {
  tabInsertTarget.value = { paneId, index }
  dropTarget.value = null
}

function moveDraggedTabToIndex(targetPaneId: string, rawTargetIdx: number) {
  const drag = draggingTab.value
  if (!drag) return

  const c = getCtx()
  const sourcePane = findPaneById(c.root, drag.paneId)
  const targetPane = findPaneById(c.root, targetPaneId)
  if (!sourcePane || !targetPane) return

  const sourceIdx = sourcePane.tabs.findIndex((tab) => tab.id === drag.tabId)
  if (sourceIdx === -1) return

  const boundedTargetIdx = Math.max(0, Math.min(rawTargetIdx, targetPane.tabs.length))

  if (sourcePane === targetPane) {
    let nextIdx = boundedTargetIdx
    if (nextIdx > sourceIdx) nextIdx--
    if (nextIdx === sourceIdx) {
      sourcePane.activeTabIdx = sourceIdx
      c.activePaneId = sourcePane.id
      return
    }
    const [tab] = sourcePane.tabs.splice(sourceIdx, 1)
    sourcePane.tabs.splice(nextIdx, 0, tab)
    sourcePane.activeTabIdx = nextIdx
    c.activePaneId = sourcePane.id
    return
  }

  const shouldRemoveSourcePane = sourcePane.tabs.length === 1
  const [tab] = sourcePane.tabs.splice(sourceIdx, 1)

  if (shouldRemoveSourcePane) {
    removePaneIfPossible(c, sourcePane.id)
  } else {
    normalizePaneAfterTabRemoval(sourcePane, sourceIdx)
  }

  const insertionIdx = Math.max(0, Math.min(boundedTargetIdx, targetPane.tabs.length))
  targetPane.tabs.splice(insertionIdx, 0, tab)
  targetPane.activeTabIdx = insertionIdx
  c.activePaneId = targetPane.id
}

function moveDraggedTab(targetPaneId: string, position: DropPosition) {
  const drag = draggingTab.value
  if (!drag) return

  const c = getCtx()
  const sourcePane = findPaneById(c.root, drag.paneId)
  const targetPane = findPaneById(c.root, targetPaneId)
  if (!sourcePane || !targetPane) return

  const sourceIdx = sourcePane.tabs.findIndex((tab) => tab.id === drag.tabId)
  if (sourceIdx === -1) return

  if (position === 'center' && drag.paneId === targetPaneId) {
    sourcePane.activeTabIdx = sourceIdx
    c.activePaneId = targetPaneId
    return
  }

  const shouldRemoveSourcePane = drag.paneId !== targetPaneId && sourcePane.tabs.length === 1
  const [tab] = sourcePane.tabs.splice(sourceIdx, 1)
  if (shouldRemoveSourcePane) {
    removePaneIfPossible(c, sourcePane.id)
  } else {
    normalizePaneAfterTabRemoval(sourcePane, sourceIdx)
  }

  if (position === 'center') {
    targetPane.tabs.push(tab)
    targetPane.activeTabIdx = targetPane.tabs.length - 1
    c.activePaneId = targetPane.id
    return
  }

  const newPane = createPane([tab])
  splitPaneAt(c.root, targetPaneId, position, newPane)
  c.activePaneId = newPane.id
}

function onDropZoneDrop(paneId: string, position: DropPosition) {
  moveDraggedTab(paneId, position)
  clearDragState()
}

function onTabInsertDrop(paneId: string, index: number) {
  moveDraggedTabToIndex(paneId, index)
  clearDragState()
}

function onSplitResize(splitNode: PaneSplitNode, ratio: number) {
  splitNode.ratio = Math.min(1 - MIN_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio))
}

function onSplitResizeStart() {
  splitResizeActive.value = true
}

function onSplitResizeEnd() {
  splitResizeActive.value = false
}

async function handleWelcomeSend(payload: WelcomeSendPayload) {
  const meta = await window.conversationApi.create('新对话', activeProject.value?.id)
  const title = payload.text
    ? (payload.text.length > 30 ? payload.text.slice(0, 30) + '...' : payload.text)
    : '新对话'
  openConversationTab(meta.id, { title, reuseActiveEmptyTab: true })
  await sidebarRef.value?.loadConversations()
  await nextTick()
  const chatRef = chatRefs.value[meta.id]
  if (chatRef) {
    chatRef.sendWithContent(payload.text, payload.images, payload.providerId, payload.model, payload.mode)
  }
}
</script>

<template>
  <div class="app-root">
    <Sidebar
      ref="sidebarRef"
      :running-conv-ids="runningConvIds"
      :project-id="activeProject?.id"
      :project-name="activeProject?.name"
      :project-path="activeProject?.path"
      @select-conversation="onSelectConversation"
      @no-selection="onNoSelection"
      @delete-conversation="onDeleteConversation"
      @open-project="onOpenProject"
      @close-project="onCloseProject"
      @create-task="addNewTab"
      @rename-project="onRenameProject"
      @open-skills="openSkills"
      @open-file="onOpenFile"
      @preview-html="openWebView"
    />

    <div class="main-area">
      <WorkspacePane
        v-if="currentRoot"
        :node="currentRoot"
        :active-pane-id="activePane?.id || ''"
        :running-conv-ids="runningConvIds"
        :tab-titles="tabTitles"
        :project-name="activeProject?.name"
        :dragging-tab="draggingTab"
        :interaction-active="!!draggingTab || splitResizeActive"
        :drop-target="dropTarget"
        :tab-insert-target="tabInsertTarget"
        :skills-tab-id="SKILLS_TAB_ID"
        :webview-prefix="WEBVIEW_PREFIX"
        :editor-prefix="EDITOR_PREFIX"
        @focus-pane="focusPane"
        @switch-tab="switchTab"
        @add-tab="addNewTab"
        @close-tab="closeTab"
        @tab-drag-start="onTabDragStart"
        @tab-drag-end="onTabDragEnd"
        @drop-zone-drag-over="onDropZoneDragOver"
        @drop-zone-drop="onDropZoneDrop"
        @tab-insert-drag-over="onTabInsertDragOver"
        @tab-insert-drop="onTabInsertDrop"
        @streaming-change="onStreamingChange"
        @title-change="onConvTitleChange"
        @set-chat-ref="setChatRef"
        @welcome-send="handleWelcomeSend"
        @split-resize-start="onSplitResizeStart"
        @split-resize-end="onSplitResizeEnd"
        @split-resize="onSplitResize"
      />

      <button class="settings-fab" title="设置" @click="showSettings = true">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      <SettingsPanel v-if="showSettings" @close="onSettingsClose" />
    </div>
  </div>
</template>

<style scoped>
.app-root {
  display: flex;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
}

.main-area {
  flex: 1;
  display: flex;
  position: relative;
  min-width: 0;
  min-height: 0;
  background: var(--c-base);
}

.settings-fab {
  position: absolute;
  top: 14px;
  right: 14px;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--c-surface1) 85%, transparent);
  background: color-mix(in srgb, var(--c-mantle) 92%, transparent);
  color: var(--c-subtext0);
  cursor: pointer;
  transition: color 0.2s, background 0.2s, border-color 0.2s;
}

.settings-fab:hover {
  color: var(--c-text);
  background: var(--c-surface0);
  border-color: var(--c-surface2);
}
</style>
