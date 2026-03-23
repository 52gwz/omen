<script setup lang="ts">
import { computed, nextTick, onMounted, provide, reactive, ref, watch } from 'vue'
import ChatView from './components/ChatView.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import Sidebar from './components/Sidebar.vue'
import WorkspacePane from './components/WorkspacePane.vue'
import { MIN_SPLIT_RATIO } from './types/workspace'
import { useTheme } from './composables/useTheme'
import type { CodeReference, DragTabState, DropPosition, DropTarget, FileReference, MentionTab, PaneLeafNode, PaneNode, PaneSplitNode, PaneState, TabInfo, TabInsertTarget, ChatMessage } from './types/workspace'

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

type DocumentWithViewTransition = Document & {
  startViewTransition?: (update: () => void | Promise<void>) => {
    finished: Promise<void>
  }
}

const { theme, toggleTheme } = useTheme()

const showSettings = ref(false)
const chatRefs = ref<Record<string, InstanceType<typeof ChatView>>>({})
const sidebarRef = ref<InstanceType<typeof Sidebar>>()

const runningConvIds = reactive(new Set<string>())
const tabTitles = reactive<Record<string, string>>({})
const activeProject = ref<ProjectData | null>(null)
// 全局消息缓存，同一个 convId 共享同一个消息数组
interface ConversationState {
  messages: ChatMessage[]
  currentRequestId?: string
  isStreaming: boolean
  chatMode?: 'chat' | 'agent'
}
const globalConvState = reactive<Record<string, ConversationState>>({})

provide('globalConvState', globalConvState)
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

// ---- Workspace state persistence ----

function serializeNode(node: PaneNode): any {
  if (node.type === 'pane') {
    return {
      type: 'pane',
      pane: {
        id: node.pane.id,
        tabs: node.pane.tabs.map(t => ({ id: t.id, convId: t.convId })),
        activeTabIdx: node.pane.activeTabIdx,
      },
    }
  }
  return {
    type: 'split',
    direction: node.direction,
    ratio: node.ratio,
    first: serializeNode(node.first),
    second: serializeNode(node.second),
  }
}

function serializeWorkspace() {
  const contexts: Record<string, any> = {}
  for (const [key, ctx] of Object.entries(tabContexts)) {
    contexts[key] = {
      root: serializeNode(ctx.root),
      activePaneId: ctx.activePaneId,
    }
  }
  return {
    contexts,
    activeProjectId: activeProject.value?.id || null,
    tabIdCounter,
    paneIdCounter,
  }
}

function deserializeNode(data: any): PaneNode {
  if (data.type === 'pane') {
    return {
      type: 'pane',
      pane: {
        id: data.pane.id,
        tabs: data.pane.tabs.map((t: any) => ({ id: t.id, convId: t.convId })),
        activeTabIdx: data.pane.activeTabIdx,
      },
    }
  }
  return {
    type: 'split',
    id: data.id,
    direction: data.direction,
    ratio: data.ratio,
    first: deserializeNode(data.first),
    second: deserializeNode(data.second),
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

function debouncedSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    window.workspaceApi.save(serializeWorkspace())
  }, 500)
}

async function restoreWorkspace() {
  const saved = await window.workspaceApi.load()
  if (!saved?.contexts) return

  // Restore counters to avoid ID collisions
  if (saved.tabIdCounter) tabIdCounter = saved.tabIdCounter
  if (saved.paneIdCounter) paneIdCounter = saved.paneIdCounter

  // Restore tab contexts
  for (const [key, ctx] of Object.entries(saved.contexts) as [string, any][]) {
    try {
      tabContexts[key] = {
        root: deserializeNode(ctx.root),
        activePaneId: ctx.activePaneId,
      }
    } catch {
      // Skip corrupted context
    }
  }

  // Restore active project
  if (saved.activeProjectId) {
    const projects = await window.projectApi.list()
    const project = projects.find(p => p.id === saved.activeProjectId)
    if (project) activeProject.value = project
  }
}

onMounted(async () => {
  await restoreWorkspace()

  // Watch tab contexts deeply for auto-save
  watch(() => tabContexts, debouncedSave, { deep: true })
  watch(activeProject, debouncedSave)
})

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

type TabCategory = 'conversation' | 'editor' | 'webview' | 'skills' | 'home'

function getTabCategory(convId: string): TabCategory {
  if (!convId) return 'home'
  if (convId === SKILLS_TAB_ID) return 'skills'
  if (convId.startsWith(WEBVIEW_PREFIX)) return 'webview'
  if (convId.startsWith(EDITOR_PREFIX)) return 'editor'
  return 'conversation'
}

/** 在有分栏时，优先找当前激活tab为同类型的栏 */
function findBestPaneForCategory(ctx: TabContext, category: TabCategory): PaneState {
  const activePane = getActivePane(ctx)
  // 没有分栏或当前栏的激活tab就是同类型，直接用当前栏
  const activeTab = activePane.tabs[activePane.activeTabIdx]
  if (countPanes(ctx.root) <= 1 || getTabCategory(activeTab?.convId ?? '') === category) {
    return activePane
  }
  // 遍历所有栏，找激活tab类型匹配的
  let matched: PaneState | null = null
  forEachPane(ctx.root, (pane) => {
    if (matched) return
    const tab = pane.tabs[pane.activeTabIdx]
    if (tab && getTabCategory(tab.convId) === category) {
      matched = pane
    }
  })
  return matched ?? activePane
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
      id: `split_${Date.now()}_${Math.random().toString(36).slice(2)}`,
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

  // When reusing an empty tab, always prefer the currently active pane's empty tab.
  // This ensures conversations created from the right column's WelcomeScreen stay there.
  if (options?.reuseActiveEmptyTab) {
    const activePaneVal = getActivePane(c)
    const activeTab = activePaneVal.tabs[activePaneVal.activeTabIdx]
    if (activeTab && !activeTab.convId) {
      activeTab.convId = convId
      c.activePaneId = activePaneVal.id
      return
    }
  }

  const pane = findBestPaneForCategory(c, 'conversation')
  pane.tabs.push(createTab(convId))
  pane.activeTabIdx = pane.tabs.length - 1
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

let blankWebviewCounter = 0

function addNewWebviewTab(paneId?: string) {
  const blankId = `__blank_${Date.now()}_${blankWebviewCounter++}`
  const c = getCtx()
  const pane = paneId ? findPaneById(c.root, paneId) : getActivePane(c)
  if (!pane) return
  pane.tabs.push(createTab(WEBVIEW_PREFIX + blankId))
  pane.activeTabIdx = pane.tabs.length - 1
  c.activePaneId = pane.id
}

function openSkills() {
  if (focusExistingTab(SKILLS_TAB_ID)) return
  const c = getCtx()
  const pane = findBestPaneForCategory(c, 'skills')
  pane.tabs[pane.activeTabIdx].convId = SKILLS_TAB_ID
  c.activePaneId = pane.id
}

function openWebView(filePath: string) {
  const webviewId = WEBVIEW_PREFIX + filePath
  if (focusExistingTab(webviewId)) return
  const c = getCtx()
  const pane = findBestPaneForCategory(c, 'webview')
  pane.tabs.push(createTab(webviewId))
  pane.activeTabIdx = pane.tabs.length - 1
  c.activePaneId = pane.id
}

function onOpenFile(filePath: string) {
  const editorId = EDITOR_PREFIX + filePath
  if (focusExistingTab(editorId)) return
  const c = getCtx()
  const pane = findBestPaneForCategory(c, 'editor')
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

function onFileRefDrop(paneId: string, position: DropPosition, filePaths: string[]) {
  if (!filePaths.length) return
  const c = getCtx()

  // Create editor tabs for each file
  const tabs: TabInfo[] = filePaths.map(fp => createTab(EDITOR_PREFIX + fp))

  if (position === 'center') {
    // Add to existing pane
    const pane = findPaneById(c.root, paneId)
    if (!pane) return
    for (const tab of tabs) {
      if (!pane.tabs.some(t => t.convId === tab.convId)) {
        pane.tabs.push(tab)
      }
    }
    pane.activeTabIdx = pane.tabs.length - 1
    c.activePaneId = pane.id
  } else {
    // Split into new pane
    const newPane = createPane(tabs)
    splitPaneAt(c.root, paneId, position, newPane)
    c.activePaneId = newPane.id
  }
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

const webviewCurrentUrls = reactive<Record<string, string>>({})

const fileHighlights = reactive(new Map<string, { ranges: { startLine: number; endLine: number }[]; deletions: { afterLine: number; count: number; lines: string[] }[] }>())

const codeRefStore = reactive(new Map<string, CodeReference>())

const pendingFileReferences = reactive<FileReference[]>([])

function addFileReferences(refs: FileReference[]) {
  for (const r of refs) {
    if (!pendingFileReferences.some(f => f.filePath === r.filePath)) {
      pendingFileReferences.push(r)
    }
  }
}

function removeFileReference(index: number) {
  pendingFileReferences.splice(index, 1)
}

function clearFileReferences() {
  pendingFileReferences.splice(0)
}

function addCodeReference(ref: CodeReference) {
  const id = crypto.randomUUID()
  codeRefStore.set(id, ref)

  let target: InstanceType<typeof ChatView> | undefined
  const active = activeConvId.value
  if (chatRefs.value[active]) {
    target = chatRefs.value[active]
  }
  if (!target) {
    for (const convId of activeTabConvIds.value) {
      if (chatRefs.value[convId]) {
        target = chatRefs.value[convId]
        break
      }
    }
  }
  if (!target) {
    const refs = Object.values(chatRefs.value)
    if (refs.length) target = refs[0]
  }
  target?.insertCodeReference(id, ref)
}

function setWebviewCurrentUrl(filePath: string, url: string) {
  webviewCurrentUrls[filePath] = url
}

const allOpenTabs = computed<MentionTab[]>(() => {
  const result: MentionTab[] = []
  const seen = new Set<string>()
  const ctx = tabContexts[ctxKey.value]
  if (!ctx) return result
  forEachPane(ctx.root, (pane) => {
    for (const tab of pane.tabs) {
      if (!tab.convId || seen.has(tab.convId)) continue
      seen.add(tab.convId)
      if (tab.convId.startsWith(EDITOR_PREFIX)) {
        const fp = tab.convId.slice(EDITOR_PREFIX.length)
        const normalized = fp.replace(/\\/g, '/')
        const filename = normalized.split('/').pop() || fp
        const dir = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : ''
        result.push({ key: filename, value: tab.convId, type: 'file', path: dir })
      } else if (tab.convId.startsWith(WEBVIEW_PREFIX)) {
        const fp = tab.convId.slice(WEBVIEW_PREFIX.length)
        const currentUrl = webviewCurrentUrls[fp] ?? (fp.startsWith('__blank_') ? '' : fp)
        let label: string
        if (!currentUrl || currentUrl === 'about:blank') {
          label = '浏览器'
        } else if (currentUrl.startsWith('file://')) {
          label = currentUrl.replace(/^file:\/\//, '').split('/').pop() || fp
        } else {
          label = currentUrl.replace(/^https?:\/\//, '').split('/')[0] || currentUrl
        }
        result.push({ key: label, value: tab.convId, type: 'webview', currentUrl })
      }
    }
  })
  return result
})

function openTabById(tabId: string) {
  if (focusExistingTab(tabId)) return
  if (tabId.startsWith(EDITOR_PREFIX)) {
    onOpenFile(tabId.slice(EDITOR_PREFIX.length))
  } else if (tabId.startsWith(WEBVIEW_PREFIX)) {
    openWebView(tabId.slice(WEBVIEW_PREFIX.length))
  }
}

const activeTabConvIds = computed<Set<string>>(() => {
  const ids = new Set<string>()
  const ctx = tabContexts[ctxKey.value]
  if (!ctx) return ids
  forEachPane(ctx.root, (pane) => {
    const convId = pane.tabs[pane.activeTabIdx]?.convId
    if (convId) ids.add(convId)
  })
  return ids
})

provide('openTabs', allOpenTabs)
provide('openTabById', openTabById)
provide('appActiveConvId', activeConvId)
provide('activeTabConvIds', activeTabConvIds)
provide('setWebviewCurrentUrl', setWebviewCurrentUrl)
provide('webviewCurrentUrls', webviewCurrentUrls)
provide('addCodeReference', addCodeReference)
provide('codeRefStore', codeRefStore)
provide('fileHighlights', fileHighlights)
provide('pendingFileReferences', pendingFileReferences)
provide('addFileReferences', addFileReferences)
provide('removeFileReference', removeFileReference)
provide('clearFileReferences', clearFileReferences)

async function openWelcomeConversation(payload: WelcomeSendPayload) {
  const meta = await window.conversationApi.create('新对话', activeProject.value?.id)
  const title = payload.text
    ? (payload.text.length > 30 ? payload.text.slice(0, 30) + '...' : payload.text)
    : '新对话'
  openConversationTab(meta.id, { title, reuseActiveEmptyTab: true })
  sidebarRef.value?.loadConversations()
  await nextTick()
  const chatRef = chatRefs.value[meta.id]
  if (chatRef) {
    chatRef.sendWithContent(payload.text, payload.images, payload.providerId, payload.model, payload.mode)
  }
}

async function handleWelcomeSend(payload: WelcomeSendPayload) {
  const doc = document as DocumentWithViewTransition
  if (!doc.startViewTransition) {
    await openWelcomeConversation(payload)
    return
  }

  try {
    const transition = doc.startViewTransition(() => openWelcomeConversation(payload))
    await transition.finished
  } catch {
    await openWelcomeConversation(payload)
  }
}
</script>

<template>
  <div class="app-root">
    <!-- 全局顶部状态栏 -->
    <div class="titlebar">
      <div class="titlebar-left">
        <div class="traffic-light-spacer"></div>
        <button class="titlebar-icon-btn" title="折叠侧边栏" @click="sidebarRef?.toggleCollapse()">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
          </svg>
        </button>
        <button class="titlebar-icon-btn" :title="theme === 'light' ? '切换暗色' : '切换明亮'" @click="toggleTheme">
          <svg v-if="theme === 'light'" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
          <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="5" />
            <line x1="12" y1="1" x2="12" y2="3" />
            <line x1="12" y1="21" x2="12" y2="23" />
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
            <line x1="1" y1="12" x2="3" y2="12" />
            <line x1="21" y1="12" x2="23" y2="12" />
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
          </svg>
        </button>
      </div>
      <div class="titlebar-right">
        <button class="titlebar-icon-btn" title="设置" @click="showSettings = true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </div>

    <!-- 主内容区 -->
    <div class="content-row">
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
          @add-webview-tab="addNewWebviewTab"
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
          @file-ref-drop="onFileRefDrop"
        />

        <SettingsPanel v-if="showSettings" @close="onSettingsClose" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.app-root {
  display: flex;
  flex-direction: column;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
}

.titlebar {
  height: 38px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--c-chrome-bg);
  border-bottom: 1px solid var(--c-surface0);
  -webkit-app-region: drag;
  z-index: 100;
}

.titlebar-left {
  display: flex;
  align-items: center;
  gap: 2px;
}

.titlebar-right {
  display: flex;
  align-items: center;
  gap: 2px;
  padding-right: 6px;
}

.traffic-light-spacer {
  width: 72px;
  flex-shrink: 0;
}

.titlebar-icon-btn {
  -webkit-app-region: no-drag;
  background: none;
  border: none;
  color: var(--c-overlay0);
  cursor: pointer;
  padding: 4px;
  border-radius: 5px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.2s, background 0.2s;
}

.titlebar-icon-btn:hover {
  color: var(--c-text);
  background: var(--c-chrome-hover-bg);
}

.content-row {
  flex: 1;
  display: flex;
  min-height: 0;
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
</style>
