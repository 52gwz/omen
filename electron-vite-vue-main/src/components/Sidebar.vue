<script setup lang="ts">
import { ref, reactive, provide, onMounted, onUnmounted, watch, nextTick, computed } from 'vue'
import { useTheme } from '../composables/useTheme'
import FileTreeNode from './FileTreeNode.vue'

const props = defineProps<{
  runningConvIds: Set<string>
  /** 项目模式：传入后侧边栏只显示该项目的对话列表 */
  projectId?: string
  projectName?: string
  projectPath?: string
}>()

const emit = defineEmits<{
  selectConversation: [convId: string, title: string]
  noSelection: []
  deleteConversation: [convId: string]
  openProject: [project: ProjectData]
  closeProject: []
  createTask: []
  renameProject: [projectId: string, newName: string]
  openSkills: []
  openFile: [filePath: string]
  previewHtml: [filePath: string]
}>()

const { theme, toggleTheme } = useTheme()

const conversations = reactive<ConversationMeta[]>([])
const projects = reactive<ProjectData[]>([])
const activeConvId = ref('')
const isHomeActive = ref(true)
const projectsExpanded = ref(true)
const conversationsExpanded = ref(true)
const filesExpanded = ref(true)
const fileTree = reactive<FileEntry[]>([])
const expandedDirs = reactive(new Set<string>())
const dirChildren = reactive<Record<string, FileEntry[]>>({})
const contextMenu = ref<{ visible: boolean; x: number; y: number; targetId: string; type: 'conv' | 'project' }>({
  visible: false, x: 0, y: 0, targetId: '', type: 'conv',
})

const collapsed = ref(false)
const sidebarWidth = ref(240)
const widthBeforeCollapse = ref(240)
const isResizing = ref(false)
const actualWidth = computed(() => collapsed.value ? 48 : sidebarWidth.value)

function toggleCollapse() {
  if (collapsed.value) {
    collapsed.value = false
    sidebarWidth.value = widthBeforeCollapse.value
  } else {
    widthBeforeCollapse.value = sidebarWidth.value
    collapsed.value = true
  }
}

function onResizeStart(e: MouseEvent) {
  if (collapsed.value) return
  isResizing.value = true
  const startX = e.clientX
  const startW = sidebarWidth.value
  const onMove = (ev: MouseEvent) => {
    sidebarWidth.value = Math.max(180, Math.min(480, startW + (ev.clientX - startX)))
  }
  const onUp = () => {
    isResizing.value = false
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

function openSkillsTab() {
  emit('openSkills')
}

const editingProjectName = ref(false)
const editProjectNameValue = ref('')
const editProjectNameInput = ref<HTMLInputElement>()

function startEditProjectName() {
  editProjectNameValue.value = props.projectName || ''
  editingProjectName.value = true
  nextTick(() => editProjectNameInput.value?.select())
}

async function confirmEditProjectName() {
  const name = editProjectNameValue.value.trim()
  editingProjectName.value = false
  if (!name || !props.projectId || name === props.projectName) return
  await window.projectApi.rename(props.projectId, name)
  emit('renameProject', props.projectId, name)
}

function cancelEditProjectName() {
  editingProjectName.value = false
}

function onEditProjectNameKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    confirmEditProjectName()
  } else if (e.key === 'Escape') {
    cancelEditProjectName()
  }
}

const selectedFiles = reactive(new Set<string>())

function toggleFileSelect(path: string, entry: FileEntry, e: MouseEvent) {
  if (selectedFiles.has(path)) {
    selectedFiles.delete(path)
  } else {
    selectedFiles.add(path)
  }
}

function clearFileSelection() {
  selectedFiles.clear()
}

// ---- Inline file/folder creation ----
const newItemState = ref<{ parentDir: string; type: 'file' | 'dir'; name: string } | null>(null)
const newItemInput = ref<HTMLInputElement>()

function startCreateInDir(parentDir: string, type: 'file' | 'dir') {
  // Ensure parent dir is expanded
  if (!expandedDirs.has(parentDir) && parentDir !== props.projectPath) {
    toggleDir(parentDir)
  }
  newItemState.value = { parentDir, type, name: '' }
  nextTick(() => newItemInput.value?.focus())
}

function startCreateAtRoot(type: 'file' | 'dir') {
  if (!props.projectPath) return
  startCreateInDir(props.projectPath, type)
}

async function confirmNewItem() {
  const state = newItemState.value
  if (!state) return
  const name = state.name.trim()
  if (!name) { cancelNewItem(); return }

  const fullPath = state.parentDir + '/' + name
  const result = state.type === 'file'
    ? await window.fsApi.createFile(fullPath)
    : await window.fsApi.createDir(fullPath)

  newItemState.value = null
  if (result.error) {
    window.alert(result.error)
  } else if (state.type === 'file') {
    emit('openFile', fullPath)
  }
}

function cancelNewItem() {
  newItemState.value = null
}

function onNewItemKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    confirmNewItem()
  } else if (e.key === 'Escape') {
    cancelNewItem()
  }
}

provide('fileTree:expandedDirs', expandedDirs)
provide('fileTree:dirChildren', dirChildren)
provide('fileTree:toggleDir', toggleDir)
provide('fileTree:openFile', (filePath: string) => emit('openFile', filePath))
provide('fileTree:previewHtml', (filePath: string) => emit('previewHtml', filePath))
provide('fileTree:selectedFiles', selectedFiles)
provide('fileTree:toggleSelect', toggleFileSelect)
provide('fileTree:createInDir', startCreateInDir)
provide('fileTree:newItemState', newItemState)
provide('fileTree:confirmNewItem', confirmNewItem)
provide('fileTree:cancelNewItem', cancelNewItem)
provide('fileTree:onNewItemKeydown', onNewItemKeydown)

async function loadConversations() {
  const list = await window.conversationApi.list(props.projectId || null)
  conversations.length = 0
  conversations.push(...list)
}

async function loadProjects() {
  const list = await window.projectApi.list()
  projects.length = 0
  projects.push(...list)
}

function openHome() {
  activeConvId.value = ''
  isHomeActive.value = true
  emit('createTask')
}

async function loadFileTree() {
  if (!props.projectPath) return
  const entries = await window.fsApi.readDir(props.projectPath)
  fileTree.length = 0
  fileTree.push(...entries)
  expandedDirs.clear()
  selectedFiles.clear()
  for (const key in dirChildren) delete dirChildren[key]
  startWatching()
}

async function refreshFileTree() {
  if (!props.projectPath) return
  const entries = await window.fsApi.readDir(props.projectPath)
  fileTree.length = 0
  fileTree.push(...entries)
  for (const dirPath of [...expandedDirs]) {
    try {
      dirChildren[dirPath] = await window.fsApi.readDir(dirPath)
    } catch {
      expandedDirs.delete(dirPath)
      delete dirChildren[dirPath]
    }
  }
}

let offDirChanged: (() => void) | null = null

function startWatching() {
  stopWatching()
  if (!props.projectPath) return
  window.fsApi.watchDir(props.projectPath)
  offDirChanged = window.fsApi.onDirChanged((data) => {
    if (props.projectPath && data.dirPath === props.projectPath) {
      refreshFileTree()
    }
  })
}

function stopWatching() {
  if (offDirChanged) {
    offDirChanged()
    offDirChanged = null
  }
  if (props.projectPath) {
    window.fsApi.unwatchDir(props.projectPath)
  }
}

async function toggleDir(dirPath: string) {
  if (expandedDirs.has(dirPath)) {
    expandedDirs.delete(dirPath)
  } else {
    if (!dirChildren[dirPath]) {
      dirChildren[dirPath] = await window.fsApi.readDir(dirPath)
    }
    expandedDirs.add(dirPath)
  }
}

async function createProject() {
  const folderPath = await window.dialogApi.selectDirectory()
  if (!folderPath) return
  const project = await window.projectApi.add(folderPath)
  if (project && !projects.some((p) => p.id === project.id)) {
    projects.unshift(project)
  }
}

async function deleteConversation(convId: string) {
  await window.conversationApi.delete(convId)
  const idx = conversations.findIndex((c) => c.id === convId)
  if (idx >= 0) conversations.splice(idx, 1)
  emit('deleteConversation', convId)
  if (activeConvId.value === convId) {
    activeConvId.value = ''
    emit('noSelection')
  }
}

async function deleteProject(projectId: string) {
  await window.projectApi.remove(projectId)
  const idx = projects.findIndex((p) => p.id === projectId)
  if (idx >= 0) projects.splice(idx, 1)
}

function selectConv(convId: string) {
  activeConvId.value = convId
  isHomeActive.value = false
  const conv = conversations.find(c => c.id === convId)
  emit('selectConversation', convId, conv?.title || '对话')
}

function onConvContext(e: MouseEvent, convId: string) {
  e.preventDefault()
  contextMenu.value = { visible: true, x: e.clientX, y: e.clientY, targetId: convId, type: 'conv' }
}

function onProjectContext(e: MouseEvent, projectId: string) {
  e.preventDefault()
  contextMenu.value = { visible: true, x: e.clientX, y: e.clientY, targetId: projectId, type: 'project' }
}

function closeContextMenu() {
  contextMenu.value.visible = false
}

async function handleContextAction(action: string) {
  const { targetId, type } = contextMenu.value
  closeContextMenu()
  if (action === 'delete') {
    if (type === 'conv') await deleteConversation(targetId)
    else await deleteProject(targetId)
  }
}

watch(() => props.projectId, () => {
  activeConvId.value = ''
  loadConversations()
  if (props.projectId) loadFileTree()
})

onMounted(() => {
  loadConversations()
  if (!props.projectId) loadProjects()
  else loadFileTree()
  document.addEventListener('mousedown', closeContextMenu)
})

onUnmounted(() => {
  document.removeEventListener('mousedown', closeContextMenu)
  stopWatching()
})

function setActiveConv(convId: string) {
  activeConvId.value = convId
  isHomeActive.value = !convId
}

defineExpose({ loadConversations, setActiveConv })
</script>

<template>
  <div class="sidebar" :class="{ 'sidebar-collapsed': collapsed, resizing: isResizing }" :style="{ width: actualWidth + 'px', minWidth: actualWidth + 'px' }">
    <div class="titlebar-spacer"></div>

    <div v-if="collapsed" class="collapsed-view">
      <button class="collapse-toggle-btn" title="展开侧边栏" @click="toggleCollapse">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
    </div>

    <div v-show="!collapsed" class="sidebar-header">
      <!-- 项目模式 -->
      <template v-if="projectId">
        <button class="back-btn" title="返回" @click="emit('closeProject')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div class="sidebar-project-title" @click="!editingProjectName && startEditProjectName()">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <input
            v-if="editingProjectName"
            ref="editProjectNameInput"
            v-model="editProjectNameValue"
            class="project-name-input"
            @blur="confirmEditProjectName"
            @keydown="onEditProjectNameKeydown"
            @click.stop
          />
          <span v-else class="sidebar-title editable">{{ projectName || '项目' }}</span>
        </div>
      </template>
      <!-- 普通模式 -->
      <template v-else>
        <span class="sidebar-title">Omen</span>
      </template>

      <div class="header-actions">
        <button class="header-icon-btn" title="收起侧边栏" @click="toggleCollapse">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
          </svg>
        </button>
        <button class="header-icon-btn" :title="theme === 'light' ? '切换暗色' : '切换明亮'" @click="toggleTheme">
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
    </div>

    <div v-show="!collapsed" class="sidebar-body">
    <!-- 普通模式：项目区 -->
    <template v-if="!projectId">
      <div class="projects-section">
        <button
          class="new-chat-btn"
          @click="openHome"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          <span>发起对话</span>
        </button>

        <div class="skills-wrapper">
          <button class="skills-btn" @click="openSkillsTab">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
            <span>技能</span>
          </button>
        </div>

        <div class="section-header" @click="projectsExpanded = !projectsExpanded">
          <div class="section-header-left">
            <svg
              class="collapse-arrow"
              :class="{ collapsed: !projectsExpanded }"
              width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
            <span class="section-label">项目</span>
          </div>
        </div>

        <div v-show="projectsExpanded" class="project-list">
          <div class="project-item" @click="createProject">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <line x1="12" y1="11" x2="12" y2="17" />
              <line x1="9" y1="14" x2="15" y2="14" />
            </svg>
            <span class="project-name">创建项目</span>
          </div>
          <div
            v-for="project in projects"
            :key="project.id"
            class="project-item"
            @click="emit('openProject', project)"
            @contextmenu="onProjectContext($event, project.id)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            <span class="project-name">{{ project.name }}</span>
          </div>
        </div>
      </div>

    </template>

    <!-- 项目模式：发起对话 + 文件浏览器 -->
    <div v-if="projectId" class="projects-section">
      <button class="new-chat-btn" @click="openHome">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        <span>发起对话</span>
      </button>

      <div class="skills-wrapper">
        <button class="skills-btn" @click="openSkillsTab">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
          <span>技能</span>
        </button>
      </div>
    </div>

    <div v-if="projectId" class="files-section">
      <div class="section-header" @click="filesExpanded = !filesExpanded">
        <div class="section-header-left">
          <svg
            class="collapse-arrow"
            :class="{ collapsed: !filesExpanded }"
            width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
          <span class="section-label">文件</span>
        </div>
        <div class="section-header-actions" @click.stop>
          <button class="section-action-btn" title="新建文件" @click="startCreateAtRoot('file')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="12" y1="11" x2="12" y2="17" />
              <line x1="9" y1="14" x2="15" y2="14" />
            </svg>
          </button>
          <button class="section-action-btn" title="新建文件夹" @click="startCreateAtRoot('dir')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <line x1="12" y1="11" x2="12" y2="17" />
              <line x1="9" y1="14" x2="15" y2="14" />
            </svg>
          </button>
        </div>
      </div>

      <div v-show="filesExpanded" class="file-tree">
        <div v-if="newItemState && newItemState.parentDir === projectPath" class="new-item-row">
          <svg v-if="newItemState.type === 'dir'" class="file-icon dir-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <svg v-else class="file-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <input
            ref="newItemInput"
            v-model="newItemState.name"
            class="new-item-input"
            :placeholder="newItemState.type === 'file' ? '文件名' : '文件夹名'"
            @keydown="onNewItemKeydown"
            @blur="confirmNewItem"
          />
        </div>
        <FileTreeNode v-if="fileTree.length" :entries="fileTree" :depth="0" />
        <div v-else-if="!newItemState" class="section-empty">
          <span>暂无文件</span>
        </div>
      </div>
    </div>

    <!-- 对话区（可折叠） -->
    <div class="conversations-section">
      <div class="section-header" @click="conversationsExpanded = !conversationsExpanded">
        <div class="section-header-left">
          <svg
            class="collapse-arrow"
            :class="{ collapsed: !conversationsExpanded }"
            width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
          <span class="section-label">对话</span>
        </div>
      </div>

      <div v-show="conversationsExpanded" class="conversation-list">
        <div
          v-for="conv in conversations"
          :key="conv.id"
          class="conversation-item"
          :class="{ active: activeConvId === conv.id }"
          @click="selectConv(conv.id)"
          @contextmenu="onConvContext($event, conv.id)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <span class="conv-title">{{ conv.title }}</span>
          <span v-if="runningConvIds.has(conv.id)" class="running-dot" title="运行中"></span>
        </div>
        <div v-if="!conversations.length" class="empty-hint">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <p>暂无对话</p>
          <p class="empty-hint-sub">点击上方 + 创建新对话</p>
        </div>
      </div>
    </div>
    </div>

    <div v-show="!collapsed" class="resize-handle" @mousedown.prevent="onResizeStart" @dblclick="sidebarWidth = 240"></div>

    <Teleport to="body">
      <div
        v-if="contextMenu.visible"
        class="ctx-menu"
        :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
        @mousedown.stop
      >
        <button @click="handleContextAction('delete')">
          {{ contextMenu.type === 'project' ? '删除项目' : '删除对话' }}
        </button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.sidebar {
  height: 100vh;
  background: var(--c-mantle);
  border-right: 1px solid var(--c-surface0);
  display: flex;
  flex-direction: column;
  position: relative;
  user-select: none;
  -webkit-app-region: drag;
  transition: width 0.2s ease, min-width 0.2s ease;
}

.sidebar.resizing {
  transition: none;
}

.collapsed-view {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 8px;
  -webkit-app-region: no-drag;
}

.collapse-toggle-btn {
  background: none;
  border: none;
  color: var(--c-overlay0);
  cursor: pointer;
  padding: 6px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.2s, background 0.2s;
}

.collapse-toggle-btn:hover {
  color: var(--c-text);
  background: var(--c-surface0);
}

.sidebar-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.resize-handle {
  position: absolute;
  right: -3px;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  z-index: 10;
  -webkit-app-region: no-drag;
}

.resize-handle::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 2px;
  width: 2px;
  border-radius: 1px;
  background: transparent;
  transition: background 0.15s;
}

.resize-handle:hover::after {
  background: var(--c-blue);
}

.titlebar-spacer {
  height: 28px;
  flex-shrink: 0;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 12px 10px;
  border-bottom: 1px solid var(--c-surface0);
  gap: 6px;
}

.back-btn {
  -webkit-app-region: no-drag;
  background: none;
  border: none;
  color: var(--c-overlay0);
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: color 0.2s, background 0.2s;
}

.back-btn:hover {
  color: var(--c-text);
  background: var(--c-surface0);
}

.sidebar-project-title {
  display: flex;
  align-items: center;
  gap: 6px;
  -webkit-app-region: no-drag;
  flex: 1;
  overflow: hidden;
  cursor: pointer;
  border-radius: 5px;
  padding: 2px 4px;
  margin: -2px -4px;
  transition: background 0.15s;
}

.sidebar-project-title:hover {
  background: var(--c-surface0);
}

.sidebar-project-title svg {
  color: var(--c-yellow, #df8e1d);
  flex-shrink: 0;
}

.sidebar-title {
  -webkit-app-region: no-drag;
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--c-text);
  letter-spacing: 0.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar-title.editable {
  cursor: pointer;
}

.project-name-input {
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--c-text);
  letter-spacing: 0.5px;
  background: var(--c-base);
  border: 1px solid var(--c-blue, #1e66f5);
  border-radius: 4px;
  outline: none;
  padding: 1px 4px;
  font-family: inherit;
  width: 100%;
  min-width: 0;
}

.header-actions {
  -webkit-app-region: no-drag;
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.header-icon-btn {
  -webkit-app-region: no-drag;
  background: none;
  border: none;
  color: var(--c-overlay0);
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.2s, background 0.2s;
}

.header-icon-btn:hover {
  color: var(--c-text);
  background: var(--c-surface0);
}

/* ---- Projects Section ---- */
.projects-section {
  -webkit-app-region: no-drag;
  border-bottom: 1px solid var(--c-surface0);
  padding-bottom: 4px;
}

.new-chat-btn {
  -webkit-app-region: no-drag;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: calc(100% - 16px);
  padding: 8px 12px;
  margin: 8px 8px 4px;
  border-radius: 8px;
  border: 1px dashed var(--c-surface2);
  background: transparent;
  color: var(--c-subtext0);
  font-size: 0.82rem;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}

.new-chat-btn:hover {
  background: var(--c-surface0);
  color: var(--c-text);
  border-color: var(--c-overlay0);
}

.new-chat-btn svg {
  flex-shrink: 0;
  color: var(--c-overlay0);
  transition: color 0.15s;
}

.new-chat-btn:hover svg {
  color: var(--c-blue);
}

.section-header {
  -webkit-app-region: no-drag;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 10px 4px 8px;
  cursor: pointer;
  border-radius: 5px;
  margin: 0 4px;
  transition: background 0.15s;
}

.section-header:hover {
  background: var(--c-surface0);
}

.section-header-left {
  display: flex;
  align-items: center;
  gap: 5px;
}

.collapse-arrow {
  color: var(--c-overlay0);
  transition: transform 0.2s ease;
  flex-shrink: 0;
}

.collapse-arrow.collapsed {
  transform: rotate(-90deg);
}

.section-label {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--c-overlay0);
  text-transform: uppercase;
  letter-spacing: 0.6px;
}

.section-count {
  font-size: 0.7rem;
  color: var(--c-surface2);
  background: var(--c-surface0);
  padding: 1px 6px;
  border-radius: 10px;
}

.section-header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.section-action-btn {
  -webkit-app-region: no-drag;
  background: none;
  border: none;
  color: var(--c-overlay0);
  cursor: pointer;
  padding: 2px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.15s, background 0.15s;
}

.section-action-btn:hover {
  color: var(--c-text);
  background: var(--c-surface0);
}

.new-item-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px 2px 8px;
  margin: 0 4px;
}

.new-item-input {
  flex: 1;
  min-width: 0;
  font-size: 0.78rem;
  font-family: inherit;
  color: var(--c-text);
  background: var(--c-base);
  border: 1px solid var(--c-blue, #1e66f5);
  border-radius: 4px;
  outline: none;
  padding: 2px 6px;
}

.project-list {
  max-height: 260px;
  overflow-y: auto;
  padding: 2px 0;
}

.project-item {
  -webkit-app-region: no-drag;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 12px;
  cursor: pointer;
  border-radius: 6px;
  margin: 1px 6px;
  transition: background 0.15s;
}

.project-item:hover {
  background: var(--c-base);
}

.project-item svg {
  flex-shrink: 0;
  color: var(--c-yellow, #df8e1d);
}

.project-name {
  font-size: 0.82rem;
  color: var(--c-subtext0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.section-empty {
  padding: 8px 12px;
  font-size: 0.75rem;
  color: var(--c-surface2);
}

/* ---- Files Section ---- */
.files-section {
  -webkit-app-region: no-drag;
  border-bottom: 1px solid var(--c-surface0);
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-height: 50%;
}

.file-tree {
  overflow-y: auto;
  padding: 2px 0 4px;
}

/* ---- Conversations Section ---- */
.conversations-section {
  -webkit-app-region: no-drag;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.conversation-list {
  flex: 1;
  overflow-y: auto;
  padding: 2px 0 6px;
}

.conversation-item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 12px;
  cursor: pointer;
  border-radius: 6px;
  margin: 1px 6px;
  transition: background 0.15s;
}

.conversation-item:hover {
  background: var(--c-base);
}

.conversation-item.active {
  background: var(--c-surface0);
}

.conversation-item svg {
  flex-shrink: 0;
  color: var(--c-surface2);
}

.conversation-item.active svg {
  color: var(--c-blue);
}

.conv-title {
  font-size: 0.82rem;
  color: var(--c-subtext0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conversation-item.active .conv-title {
  color: var(--c-text);
}

.empty-hint {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--c-surface2);
  padding: 20px;
}

.empty-hint p {
  margin: 0;
  font-size: 0.82rem;
  text-align: center;
}

.empty-hint-sub {
  font-size: 0.72rem !important;
  color: var(--c-surface1) !important;
}

.running-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--c-green, #40a02b);
  flex-shrink: 0;
  margin-left: auto;
  animation: pulse-dot 1.5s ease-in-out infinite;
}

@keyframes pulse-dot {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

/* ---- Skills Section ---- */
.skills-wrapper {
  position: relative;
  padding: 0 8px;
  margin-bottom: 4px;
}

.skills-btn {
  -webkit-app-region: no-drag;
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 7px 12px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--c-subtext0);
  font-size: 0.82rem;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.skills-btn:hover {
  background: var(--c-surface0);
  color: var(--c-text);
}

.skills-btn svg {
  flex-shrink: 0;
  color: var(--c-yellow, #df8e1d);
}


.ctx-menu {
  position: fixed;
  z-index: 1000;
  background: var(--c-surface-alt);
  border: 1px solid var(--c-surface1);
  border-radius: 8px;
  padding: 4px;
  box-shadow: 0 6px 20px var(--c-shadow-heavy);
  min-width: 120px;
}

.ctx-menu button {
  display: block;
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

.ctx-menu button:hover {
  background: var(--c-surface0);
}
</style>
