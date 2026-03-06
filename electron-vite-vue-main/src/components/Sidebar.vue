<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted } from 'vue'
import { useTheme } from '../composables/useTheme'

const props = defineProps<{
  runningConvIds: Set<string>
}>()

const emit = defineEmits<{
  selectConversation: [convId: string]
  noSelection: []
  deleteConversation: [convId: string]
}>()

const { theme, toggleTheme } = useTheme()

const conversations = reactive<ConversationMeta[]>([])
const activeConvId = ref('')
const contextMenu = ref<{ visible: boolean; x: number; y: number; targetId: string }>({
  visible: false, x: 0, y: 0, targetId: '',
})

async function loadConversations() {
  const list = await window.conversationApi.list()
  conversations.length = 0
  conversations.push(...list)
}

async function createConversation() {
  const meta = await window.conversationApi.create('新对话')
  conversations.unshift(meta)
  selectConv(meta.id)
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

function selectConv(convId: string) {
  activeConvId.value = convId
  emit('selectConversation', convId)
}

function onConvContext(e: MouseEvent, convId: string) {
  e.preventDefault()
  contextMenu.value = { visible: true, x: e.clientX, y: e.clientY, targetId: convId }
}

function closeContextMenu() {
  contextMenu.value.visible = false
}

async function handleContextAction(action: string) {
  const { targetId } = contextMenu.value
  closeContextMenu()
  if (action === 'delete') {
    await deleteConversation(targetId)
  }
}

onMounted(() => {
  loadConversations()
  document.addEventListener('click', closeContextMenu)
})

onUnmounted(() => {
  document.removeEventListener('click', closeContextMenu)
})

defineExpose({ loadConversations })
</script>

<template>
  <div class="sidebar">
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
        <button class="header-icon-btn" title="新对话" @click="createConversation">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>
    </div>

    <div class="conversation-list">
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

    <Teleport to="body">
      <div
        v-if="contextMenu.visible"
        class="ctx-menu"
        :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
      >
        <button @click="handleContextAction('delete')">删除对话</button>
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

.conversation-list {
  -webkit-app-region: no-drag;
  flex: 1;
  overflow-y: auto;
  padding: 6px 0;
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
