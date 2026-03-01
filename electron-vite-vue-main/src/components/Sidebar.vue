<script setup lang="ts">
import { ref, reactive, onMounted, computed, onUnmounted } from 'vue'
import { useTheme } from '../composables/useTheme'

interface SidebarProject {
  id: string
  path: string
  name: string
  expanded: boolean
  conversations: ConversationMeta[]
}

const emit = defineEmits<{
  selectConversation: [projectId: string, convId: string, projectPath: string]
  noSelection: []
}>()

const { theme, toggleTheme } = useTheme()

const projects = reactive<SidebarProject[]>([])
const activeConvId = ref('')
const dragOver = ref(false)
const contextMenu = ref<{ visible: boolean; x: number; y: number; type: 'project' | 'conversation'; targetId: string }>({
  visible: false, x: 0, y: 0, type: 'project', targetId: '',
})

async function loadProjects() {
  const list = await window.projectApi.list()
  projects.length = 0
  for (const p of list) {
    const convs = await window.conversationApi.list(p.id)
    projects.push({ ...p, expanded: true, conversations: convs })
  }
}

async function addProjectByDialog() {
  const dir = await window.dialogApi.selectDirectory()
  if (!dir) return
  await addProjectByPath(dir)
}

async function addProjectByPath(folderPath: string) {
  const existing = projects.find((p) => p.path === folderPath)
  if (existing) {
    existing.expanded = true
    return
  }
  const p = await window.projectApi.add(folderPath)
  if (!p) return
  projects.push({ ...p, expanded: true, conversations: [] })
}

async function removeProject(projectId: string) {
  await window.projectApi.remove(projectId)
  const idx = projects.findIndex((p) => p.id === projectId)
  if (idx >= 0) {
    const removed = projects.splice(idx, 1)[0]
    if (removed.conversations.some((c) => c.id === activeConvId.value)) {
      activeConvId.value = ''
      emit('noSelection')
    }
  }
}

async function createConversation(project: SidebarProject) {
  const meta = await window.conversationApi.create(project.id, '新对话')
  project.conversations.unshift(meta)
  project.expanded = true
  selectConv(project, meta.id)
}

async function deleteConversation(project: SidebarProject, convId: string) {
  await window.conversationApi.delete(convId)
  const idx = project.conversations.findIndex((c) => c.id === convId)
  if (idx >= 0) project.conversations.splice(idx, 1)
  if (activeConvId.value === convId) {
    activeConvId.value = ''
    emit('noSelection')
  }
}

function selectConv(project: SidebarProject, convId: string) {
  activeConvId.value = convId
  emit('selectConversation', project.id, convId, project.path)
}

function toggleProject(project: SidebarProject) {
  project.expanded = !project.expanded
}

// ---- Drag & Drop ----

function onDragOver(e: DragEvent) {
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'link'
  dragOver.value = true
}

function onDragLeave() {
  dragOver.value = false
}

async function onDrop(e: DragEvent) {
  e.preventDefault()
  dragOver.value = false
  const files = e.dataTransfer?.files
  if (!files?.length) return
  for (let i = 0; i < files.length; i++) {
    const file = files[i] as any
    const filePath: string = file.path
    if (!filePath) continue
    const isDir = await window.projectApi.checkPath(filePath)
    if (isDir) await addProjectByPath(filePath)
  }
}

// ---- Context Menu ----

function onProjectContext(e: MouseEvent, projectId: string) {
  e.preventDefault()
  contextMenu.value = { visible: true, x: e.clientX, y: e.clientY, type: 'project', targetId: projectId }
}

function onConvContext(e: MouseEvent, convId: string) {
  e.preventDefault()
  contextMenu.value = { visible: true, x: e.clientX, y: e.clientY, type: 'conversation', targetId: convId }
}

function closeContextMenu() {
  contextMenu.value.visible = false
}

async function handleContextAction(action: string) {
  const { type, targetId } = contextMenu.value
  closeContextMenu()
  if (type === 'project' && action === 'remove') {
    await removeProject(targetId)
  } else if (type === 'conversation' && action === 'delete') {
    for (const p of projects) {
      if (p.conversations.some((c) => c.id === targetId)) {
        await deleteConversation(p, targetId)
        break
      }
    }
  }
}

onMounted(() => {
  loadProjects()
  document.addEventListener('click', closeContextMenu)
})

onUnmounted(() => {
  document.removeEventListener('click', closeContextMenu)
})

defineExpose({ loadProjects })
</script>

<template>
  <div
    class="sidebar"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- 顶部 -->
    <div class="sidebar-header">
      <span class="sidebar-title">Dot</span>
      <div class="header-actions">
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
        <button class="header-icon-btn" title="添加项目" @click="addProjectByDialog">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>
    </div>

    <!-- 项目列表 -->
    <div class="project-list">
      <div v-for="project in projects" :key="project.id" class="project-group">
        <div
          class="project-header"
          @click="toggleProject(project)"
          @contextmenu="onProjectContext($event, project.id)"
        >
          <svg
            class="expand-icon"
            :class="{ expanded: project.expanded }"
            width="12" height="12" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2.5"
            stroke-linecap="round" stroke-linejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <svg class="folder-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <span class="project-name">{{ project.name }}</span>
          <button class="new-conv-btn" title="新对话" @click.stop="createConversation(project)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>

        <div v-if="project.expanded" class="conversation-list">
          <div
            v-for="conv in project.conversations"
            :key="conv.id"
            class="conversation-item"
            :class="{ active: activeConvId === conv.id }"
            @click="selectConv(project, conv.id)"
            @contextmenu="onConvContext($event, conv.id)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span class="conv-title">{{ conv.title }}</span>
          </div>
          <div v-if="!project.conversations.length" class="no-convs">
            暂无对话
          </div>
        </div>
      </div>
    </div>

    <!-- 拖拽区域提示 -->
    <div v-if="!projects.length" class="drop-hint">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
      <p>拖拽文件夹到此处</p>
      <p class="drop-hint-sub">或点击上方 + 添加项目</p>
    </div>

    <!-- 拖拽悬浮效果 -->
    <div v-if="dragOver" class="drag-overlay">
      <p>释放以添加项目</p>
    </div>

    <!-- 右键菜单 -->
    <Teleport to="body">
      <div
        v-if="contextMenu.visible"
        class="ctx-menu"
        :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
      >
        <button v-if="contextMenu.type === 'project'" @click="handleContextAction('remove')">移除项目</button>
        <button v-if="contextMenu.type === 'conversation'" @click="handleContextAction('delete')">删除对话</button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.sidebar {
  width: 240px;
  min-width: 240px;
  height: 100vh;
  background: var(--c-mantle);
  border-right: 1px solid var(--c-surface0);
  display: flex;
  flex-direction: column;
  position: relative;
  user-select: none;
  -webkit-app-region: drag;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 12px 10px;
  border-bottom: 1px solid var(--c-surface0);
}

.sidebar-title {
  -webkit-app-region: no-drag;
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--c-text);
  letter-spacing: 0.5px;
}

.header-actions {
  -webkit-app-region: no-drag;
  display: flex;
  align-items: center;
  gap: 2px;
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

.project-list {
  -webkit-app-region: no-drag;
  flex: 1;
  overflow-y: auto;
  padding: 6px 0;
}

.project-group {
  margin-bottom: 2px;
}

.project-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  cursor: pointer;
  transition: background 0.15s;
  position: relative;
}

.project-header:hover {
  background: var(--c-base);
}

.expand-icon {
  flex-shrink: 0;
  color: var(--c-surface2);
  transition: transform 0.2s ease;
}

.expand-icon.expanded {
  transform: rotate(90deg);
}

.folder-icon {
  flex-shrink: 0;
  color: var(--c-blue);
}

.project-name {
  flex: 1;
  font-size: 0.82rem;
  color: var(--c-subtext1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.new-conv-btn {
  opacity: 0;
  background: none;
  border: none;
  color: var(--c-overlay0);
  cursor: pointer;
  padding: 2px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  transition: opacity 0.15s, color 0.15s, background 0.15s;
}

.project-header:hover .new-conv-btn {
  opacity: 1;
}

.new-conv-btn:hover {
  color: var(--c-text);
  background: var(--c-surface0);
}

.conversation-list {
  padding-left: 18px;
}

.conversation-item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 10px;
  cursor: pointer;
  border-radius: 6px;
  margin: 1px 6px 1px 0;
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
  font-size: 0.8rem;
  color: var(--c-subtext0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conversation-item.active .conv-title {
  color: var(--c-text);
}

.no-convs {
  padding: 6px 10px;
  font-size: 0.75rem;
  color: var(--c-surface2);
}

.drop-hint {
  -webkit-app-region: no-drag;
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--c-surface2);
  padding: 20px;
}

.drop-hint p {
  margin: 0;
  font-size: 0.82rem;
  text-align: center;
}

.drop-hint-sub {
  font-size: 0.72rem !important;
  color: var(--c-surface1) !important;
}

.drag-overlay {
  position: absolute;
  inset: 0;
  background: var(--c-drag-overlay);
  border: 2px dashed var(--c-blue);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
  pointer-events: none;
}

.drag-overlay p {
  color: var(--c-blue);
  font-size: 0.85rem;
  font-weight: 600;
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
