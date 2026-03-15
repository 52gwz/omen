<script setup lang="ts">
import { ref, reactive, onMounted, computed, watch, inject } from 'vue'
import ChatComposer from './ChatComposer.vue'
import type { FileReference } from '../types/workspace'

const props = defineProps<{
  projectName?: string
}>()

const inputText = ref('')
const currentModel = ref('')
const activeProviderId = ref('')
const providers = ref<ModelProvider[]>([])
const pendingImages = reactive<string[]>([])
const addFileReferences = inject<(refs: FileReference[]) => void>('addFileReferences', () => {})
const pendingFileReferences = inject<FileReference[]>('pendingFileReferences', [])

type ChatMode = 'chat' | 'agent'
const chatMode = ref<ChatMode>((localStorage.getItem('chatMode') as ChatMode) || 'agent')

const canSend = computed(() =>
  (Boolean(inputText.value.trim()) || pendingImages.length > 0 || pendingFileReferences.length > 0) && !!currentModel.value
)

const emit = defineEmits<{
  send: [payload: { text: string; images?: string[]; providerId: string; model: string; mode: ChatMode }]
}>()

async function loadConfig() {
  try {
    const config = await window.aiChat.getConfig()
    providers.value = config.providers || []
    activeProviderId.value = config.activeProviderId || ''
    currentModel.value = config.activeModel || ''

    if (!currentModel.value && providers.value.length) {
      for (const p of providers.value) {
        if (p.models.length) {
          activeProviderId.value = p.id
          currentModel.value = p.models[0]
          await window.aiChat.setActive(p.id, p.models[0])
          break
        }
      }
    }
  } catch {}
}

async function selectProviderModel(providerId: string, model: string) {
  activeProviderId.value = providerId
  currentModel.value = model
  await window.aiChat.setActive(providerId, model)
}

async function selectImages() {
  const images = await window.dialogApi.selectImages()
  if (images.length) pendingImages.push(...images)
}

function removePendingImage(index: number) {
  pendingImages.splice(index, 1)
}


function handlePaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items
  if (!items) return
  let hasImage = false
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.type.startsWith('image/')) {
      hasImage = true
      const file = item.getAsFile()
      if (!file) continue
      const reader = new FileReader()
      reader.onload = () => {
        if (typeof reader.result === 'string') pendingImages.push(reader.result)
      }
      reader.readAsDataURL(file)
    }
  }
  if (hasImage) e.preventDefault()
}

function handleDrop(e: DragEvent) {
  e.preventDefault()
  // Image files only — file references are handled by ChatComposer's input-card
  const files = e.dataTransfer?.files
  if (!files) return
  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    if (!file.type.startsWith('image/')) continue
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') pendingImages.push(reader.result)
    }
    reader.readAsDataURL(file)
  }
}

function handleDragOver(e: DragEvent) {
  e.preventDefault()
}

function submit() {
  const text = inputText.value.trim()
  if (!text && pendingImages.length === 0) return
  if (!currentModel.value) return
  const images = pendingImages.length > 0 ? [...pendingImages] : undefined
  emit('send', { text, images, providerId: activeProviderId.value, model: currentModel.value, mode: chatMode.value })
  inputText.value = ''
  pendingImages.splice(0)
}

function selectMode(mode: ChatMode) {
  chatMode.value = mode
  localStorage.setItem('chatMode', mode)
}

const titleKey = ref(0)
watch(() => props.projectName, () => { titleKey.value++ })

onMounted(() => {
  loadConfig()
})
</script>

<template>
  <div class="welcome-screen" @drop="handleDrop" @dragover="handleDragOver">
    <div class="welcome-content">
      <div class="dot-pattern" aria-hidden="true">
        <span v-for="n in 120" :key="n" class="dot"></span>
      </div>

      <div class="title-wrapper">
        <Transition name="title-swap" mode="out-in">
          <h1 class="welcome-title" :key="titleKey">
            <template v-if="projectName">
              来吧！开始为 <span class="project-highlight">{{ projectName }}</span> 做点什么
            </template>
            <template v-else>
              Omen Agent, 新时代的工作方式
            </template>
          </h1>
        </Transition>
      </div>

      <ChatComposer
        v-model="inputText"
        variant="welcome"
        :pending-images="pendingImages"
        :providers="providers"
        :active-provider-id="activeProviderId"
        :current-model="currentModel"
        :chat-mode="chatMode"
        :can-send="canSend"
        placeholder="描述你想要完成的任务..."
        @send="submit"
        @paste="handlePaste"
        @select-images="selectImages"
        @remove-image="removePendingImage"
        @select-provider-model="({ providerId, model }) => selectProviderModel(providerId, model)"
        @select-mode="selectMode"
      />
    </div>
  </div>
</template>

<style scoped>
.welcome-screen {
  height: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: var(--c-base);
  -webkit-app-region: drag;
  position: relative;
  overflow: hidden;
}

:root:not([data-theme="dark"]) .welcome-screen {
  background: #ffffff;
}

.welcome-content {
  -webkit-app-region: no-drag;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  max-width: 720px;
  padding: 0 24px 32px;
  position: relative;
}

.dot-pattern {
  position: absolute;
  top: -60px;
  left: 50%;
  transform: translateX(-50%);
  width: 400px;
  height: 80px;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  justify-content: center;
  align-items: center;
  pointer-events: none;
  opacity: 0.35;
}

.dot {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--c-surface2);
}

.title-wrapper {
  width: 100%;
  min-height: 3.2em;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 32px;
}

.welcome-title {
  font-size: 1.75rem;
  font-weight: 700;
  color: var(--c-text);
  text-align: center;
  margin: 0;
  letter-spacing: -0.01em;
  line-height: 1.4;
}

.project-highlight {
  background: linear-gradient(135deg, var(--c-blue, #1e66f5), var(--c-lavender, #7287fd));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

/* Title swap transition */
.title-swap-enter-active {
  animation: title-in 0.4s ease-out;
}

.title-swap-leave-active {
  animation: title-out 0.25s ease-in;
}

@keyframes title-in {
  0% {
    opacity: 0;
    transform: translateY(12px) scale(0.97);
    filter: blur(4px);
  }
  100% {
    opacity: 1;
    transform: translateY(0) scale(1);
    filter: blur(0);
  }
}

@keyframes title-out {
  0% {
    opacity: 1;
    transform: translateY(0) scale(1);
    filter: blur(0);
  }
  100% {
    opacity: 0;
    transform: translateY(-10px) scale(0.97);
    filter: blur(4px);
  }
}

/* Input card */
.input-card {
  width: 100%;
  background: var(--c-mantle);
  border: 1px solid var(--c-surface0);
  border-radius: 16px;
  box-shadow: 0 2px 12px var(--c-shadow);
  display: flex;
  flex-direction: column;
}

/* Pending images */
.welcome-pending-images {
  display: flex;
  gap: 8px;
  padding: 14px 20px 0;
  overflow-x: auto;
  flex-wrap: wrap;
}

.pending-img-item {
  position: relative;
  flex-shrink: 0;
}

.pending-img-thumb {
  width: 64px;
  height: 64px;
  object-fit: cover;
  border-radius: 8px;
  border: 1px solid var(--c-surface1);
}

.pending-img-remove {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--c-surface2);
  border: none;
  color: var(--c-text);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s;
}

.pending-img-remove:hover {
  background: var(--c-red, #e64553);
  color: #fff;
}

.welcome-textarea {
  width: 100%;
  min-height: 140px;
  max-height: 240px;
  padding: 20px 20px 12px;
  background: transparent;
  border: none;
  outline: none;
  resize: none;
  color: var(--c-text);
  font-size: 0.95rem;
  line-height: 1.6;
  font-family: inherit;
}

.welcome-textarea::placeholder {
  color: var(--c-overlay0);
}

/* Card toolbar */
.card-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  gap: 8px;
}

.toolbar-left,
.toolbar-right {
  display: flex;
  align-items: center;
  gap: 4px;
}

.toolbar-icon-btn {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  border: 1px solid var(--c-surface0);
  background: var(--c-base);
  color: var(--c-overlay1);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.2s, background 0.2s, border-color 0.2s;
}

.toolbar-icon-btn:hover {
  color: var(--c-text);
  background: var(--c-surface-hover);
  border-color: var(--c-surface1);
}

/* Model selector */
.welcome-model-selector {
  position: relative;
}

.model-selector-trigger {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: none;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 4px 8px;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s, border-color 0.15s;
  user-select: none;
}

.model-selector-trigger:hover {
  background: var(--c-surface0);
  border-color: var(--c-surface1);
}

.provider-tag {
  font-size: 0.7rem;
  color: var(--c-overlay0);
  padding: 1px 5px;
  background: var(--c-surface0);
  border-radius: 4px;
}

.model-name {
  font-size: 0.82rem;
  color: var(--c-subtext0);
  white-space: nowrap;
}

.selector-chevron {
  color: var(--c-overlay0);
  transition: transform 0.2s ease;
}

.selector-chevron.open {
  transform: rotate(180deg);
}

/* Model dropdown (opens upward) */
.model-dropdown-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  right: 0;
  min-width: 220px;
  max-width: 320px;
  max-height: 320px;
  overflow-y: auto;
  background: var(--c-surface-alt);
  border: 1px solid var(--c-surface1);
  border-radius: 10px;
  padding: 4px;
  box-shadow: 0 8px 24px var(--c-shadow-heavy);
  z-index: 100;
}

.model-dropdown-empty {
  padding: 12px 14px;
  font-size: 0.82rem;
  color: var(--c-overlay0);
  text-align: center;
}

.model-group {
  padding: 2px 0;
}

.model-group + .model-group {
  border-top: 1px solid var(--c-surface0);
  margin-top: 2px;
  padding-top: 4px;
}

.model-group-title {
  padding: 6px 10px 4px;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--c-overlay0);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.model-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  background: none;
  border: none;
  border-radius: 7px;
  color: var(--c-text);
  font-size: 0.84rem;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s;
  text-align: left;
}

.model-item:hover {
  background: var(--c-surface-hover);
}

.model-item.active {
  background: var(--c-surface0);
  color: var(--c-blue);
}

.model-no-models {
  padding: 6px 10px;
  font-size: 0.78rem;
  color: var(--c-overlay0);
  font-style: italic;
}

.check-icon {
  margin-left: auto;
  color: var(--c-blue);
}

.send-circle-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: var(--c-surface0);
  color: var(--c-subtext0);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-left: 2px;
  transition: background 0.2s, color 0.2s, opacity 0.2s;
}

.send-circle-btn:hover:not(:disabled) {
  background: var(--c-surface1);
  color: var(--c-text);
}

.send-circle-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* -- Mode dropdown -- */
.welcome-mode-dropdown {
  position: relative;
}

.mode-trigger {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: none;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 4px 10px;
  height: 34px;
  color: var(--c-subtext0);
  font-size: 0.82rem;
  cursor: pointer;
  font-family: inherit;
  white-space: nowrap;
  transition: background 0.2s, border-color 0.2s;
  user-select: none;
}

.mode-trigger:hover {
  background: var(--c-surface0);
  border-color: var(--c-surface1);
}

.mode-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.mode-dot.chat {
  background: var(--c-blue);
}

.mode-dot.agent {
  background: var(--c-green);
}

.mode-chevron {
  color: var(--c-overlay0);
  transition: transform 0.2s ease;
}

.mode-chevron.open {
  transform: rotate(180deg);
}

.mode-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  min-width: 140px;
  background: var(--c-surface-alt);
  border: 1px solid var(--c-surface1);
  border-radius: 10px;
  padding: 4px;
  box-shadow: 0 8px 24px var(--c-shadow-heavy);
  z-index: 100;
}

.mode-option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  background: none;
  border: none;
  border-radius: 7px;
  color: var(--c-text);
  font-size: 0.85rem;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s;
}

.mode-option:hover {
  background: var(--c-surface-hover);
}

.mode-option.active {
  background: var(--c-surface0);
}

.check-icon {
  margin-left: auto;
  color: var(--c-blue);
}

/* Dropdown transition */
.dropdown-enter-active,
.dropdown-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
