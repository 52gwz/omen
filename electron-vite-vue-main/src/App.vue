<script setup lang="ts">
import { ref } from 'vue'
import ChatView from './components/ChatView.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import Sidebar from './components/Sidebar.vue'

const showSettings = ref(false)
const chatRef = ref<InstanceType<typeof ChatView>>()

const activeProjectId = ref('')
const activeConvId = ref('')
const activeProjectPath = ref('')

function onSettingsClose() {
  showSettings.value = false
  chatRef.value?.loadConfig()
}

function onSelectConversation(projectId: string, convId: string, projectPath: string) {
  activeProjectId.value = projectId
  activeConvId.value = convId
  activeProjectPath.value = projectPath
}

function onNoSelection() {
  activeProjectId.value = ''
  activeConvId.value = ''
  activeProjectPath.value = ''
}
</script>

<template>
  <div class="app-root">
    <Sidebar
      @select-conversation="onSelectConversation"
      @no-selection="onNoSelection"
    />

    <div class="main-area">
      <ChatView
        v-if="activeConvId"
        ref="chatRef"
        :key="activeConvId"
        :conversation-id="activeConvId"
        :project-path="activeProjectPath"
      />

      <div v-else class="no-conv-placeholder">
        <p>选择或创建一个对话</p>
      </div>

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

.no-conv-placeholder {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--c-base);
  color: var(--c-surface2);
  font-size: 1rem;
  -webkit-app-region: drag;
}

.no-conv-placeholder p {
  -webkit-app-region: no-drag;
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
