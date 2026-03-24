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
    <div class="welcome-main">
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
              你可以在下方开启对话，或者拖入项目到这里
            </template>
          </h1>
        </Transition>
      </div>
    </div>

    <div class="welcome-input-area">
      <div class="welcome-input-container">
        <ChatComposer
          v-model="inputText"
          variant="chat"
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
  </div>
</template>

<style scoped>
.welcome-screen {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--c-base);
  -webkit-app-region: drag;
  position: relative;
  overflow: hidden;
}

:root:not([data-theme="dark"]) .welcome-screen {
  background: #ffffff;
}

.welcome-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  max-width: 720px;
  padding: 0 24px;
  margin: 0 auto;
  position: relative;
  -webkit-app-region: no-drag;
}

.welcome-input-area {
  padding: 12px 16px;
  -webkit-app-region: no-drag;
}

:root:not([data-theme="dark"]) .welcome-input-area {
  background: #ffffff;
}

.welcome-input-container {
  width: 100%;
  /* Size and width consistent with ChatView's input area if it has any max-width */
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
  color: var(--c-text-primary);
  text-align: center;
  margin: 0;
  letter-spacing: -0.01em;
  line-height: 1.4;
}

:root[data-theme="dark"] .welcome-title {
  color: #ffffff;
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
</style>
