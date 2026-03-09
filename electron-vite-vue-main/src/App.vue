<script setup lang="ts">
import { ref, reactive, nextTick } from 'vue'
import ChatView from './components/ChatView.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import Sidebar from './components/Sidebar.vue'
import WelcomeScreen from './components/WelcomeScreen.vue'

const showSettings = ref(false)
const chatRefs = ref<Record<string, InstanceType<typeof ChatView>>>({})
const sidebarRef = ref<InstanceType<typeof Sidebar>>()

const activeConvId = ref('')
const openedConvIds = ref<string[]>([])
const runningConvIds = reactive(new Set<string>())

// 当前激活的项目（null = 普通对话模式）
const activeProject = ref<ProjectData | null>(null)

function onOpenProject(project: ProjectData) {
  activeProject.value = project
  activeConvId.value = ''
}

function onCloseProject() {
  activeProject.value = null
  activeConvId.value = ''
}

function onSettingsClose() {
  showSettings.value = false
  for (const r of Object.values(chatRefs.value)) {
    r?.loadConfig()
  }
}

function onSelectConversation(convId: string) {
  activeConvId.value = convId
  if (!openedConvIds.value.includes(convId)) {
    openedConvIds.value.push(convId)
  }
}

function onNoSelection() {
  activeConvId.value = ''
}

function onDeleteConversation(convId: string) {
  openedConvIds.value = openedConvIds.value.filter((id) => id !== convId)
  runningConvIds.delete(convId)
  delete chatRefs.value[convId]
  if (activeConvId.value === convId) {
    activeConvId.value = ''
  }
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

async function handleWelcomeSend(payload: { text: string; images?: string[]; providerId: string; model: string }) {
  const meta = await window.conversationApi.create('新对话')
  onSelectConversation(meta.id)
  sidebarRef.value?.loadConversations()
  await nextTick()
  const chatRef = chatRefs.value[meta.id]
  if (chatRef) {
    chatRef.sendWithContent(payload.text, payload.images, payload.providerId, payload.model)
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
      @create-task="onNoSelection"
    />

    <div class="main-area">
      <ChatView
        v-for="convId in openedConvIds"
        v-show="convId === activeConvId"
        :key="convId"
        :ref="(el: any) => setChatRef(convId, el)"
        :conversation-id="convId"
        @streaming-change="(s: boolean) => onStreamingChange(convId, s)"
      />

      <WelcomeScreen v-if="!activeConvId" :project-name="activeProject?.name" @send="handleWelcomeSend" />

      <button class="settings-fab" title="设置" @click="showSettings = true">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
  position: relative;
  min-width: 0;
}

.settings-fab {
  position: fixed;
  top: 7px;
  right: 16px;
  z-index: 50;
  background: var(--c-surface0);
  border: 1px solid var(--c-surface1);
  border-radius: 8px;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--c-subtext0);
  transition: color 0.2s, background 0.2s;
  -webkit-app-region: no-drag;
}

.settings-fab:hover {
  color: var(--c-text);
  background: var(--c-surface1);
}
</style>
