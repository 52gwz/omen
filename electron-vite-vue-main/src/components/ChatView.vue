<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, nextTick, computed, watch } from 'vue'
import { marked } from 'marked'
import ToolCallCard from './ToolCallCard.vue'

marked.setOptions({
  breaks: true,
  gfm: true,
})

const REASONING_COLLAPSE_DELAY = 300

const props = defineProps<{
  conversationId: string
}>()

const emit = defineEmits<{
  streamingChange: [streaming: boolean]
  titleChange: [title: string]
}>()

interface ToolCallInfo {
  id: string
  name: string
  arguments: string
  status: 'streaming' | 'pending' | 'confirmed' | 'rejected' | 'running' | 'completed' | 'error'
  result?: string
  streamOutput?: string
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  reasoningExpanded?: boolean
  images?: string[]
  toolCalls?: ToolCallInfo[]
}

function renderMarkdown(raw: string): string {
  return marked.parse(raw, { async: false }) as string
}

function renderReasoning(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>')
    .replace(/^/, '<p>')
    .replace(/$/, '</p>')
}

type ChatMode = 'chat' | 'agent'
const modeLabels: Record<ChatMode, string> = { chat: '聊天', agent: 'Agent' }

const messages = reactive<ChatMessage[]>([])
const inputText = ref('')
const isStreaming = ref(false)
const currentModel = ref('')
const activeProviderId = ref('')
const providers = ref<ModelProvider[]>([])
const errorMsg = ref('')
const chatMode = ref<ChatMode>((localStorage.getItem('chatMode') as ChatMode) || 'agent')
const modeDropdownOpen = ref(false)
const modelSelectorOpen = ref(false)
const debugMode = ref(true)
const debugPanelOpen = ref(false)
const debugSelectedMsg = ref<number | null>(null)
const debugCopied = ref(false)

const messagesContainer = ref<HTMLElement>()
const inputEl = ref<HTMLTextAreaElement>()
const modeDropdownRef = ref<HTMLElement>()
const modelSelectorRef = ref<HTMLElement>()
const reasoningContentRefs = new Map<number, HTMLElement>()

const pendingImages = reactive<string[]>([])
const MAX_IMAGE_SIZE = 4 * 1024 * 1024 // 4MB per image after compression

function setReasoningContentRef(el: HTMLElement | null, idx: number) {
  if (el) reasoningContentRefs.set(idx, el)
  else reasoningContentRefs.delete(idx)
}

function scrollReasoningToBottom(idx: number) {
  nextTick(() => {
    const el = reasoningContentRefs.get(idx)
    if (el) el.scrollTop = el.scrollHeight
  })
}

let currentRequestId = ''
let saveTimer: ReturnType<typeof setTimeout> | null = null
let loadMessagesPromise: Promise<void> | null = null

const canSend = computed(() => (inputText.value.trim() || pendingImages.length > 0) && !isStreaming.value && !!currentModel.value)

const agentCwd = ref('~')

const activeProviderName = computed(() => {
  const p = providers.value.find(p => p.id === activeProviderId.value)
  return p?.name || ''
})

function buildApiContent(text: string, images?: string[]): string | MultimodalContent {
  if (!images?.length) return text
  const parts: MultimodalContent = []
  if (text) parts.push({ type: 'text', text })
  for (const img of images) {
    parts.push({ type: 'image_url', image_url: { url: img } })
  }
  return parts
}

function compressImageIfNeeded(dataUrl: string, maxBytes: number): Promise<string> {
  return new Promise((resolve) => {
    if (dataUrl.length * 0.75 <= maxBytes) {
      resolve(dataUrl)
      return
    }
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      let { width, height } = img
      const maxDim = 1600
      if (width > maxDim || height > maxDim) {
        const ratio = Math.min(maxDim / width, maxDim / height)
        width = Math.round(width * ratio)
        height = Math.round(height * ratio)
      }
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0, width, height)
      let quality = 0.85
      let result = canvas.toDataURL('image/jpeg', quality)
      while (result.length * 0.75 > maxBytes && quality > 0.3) {
        quality -= 0.15
        result = canvas.toDataURL('image/jpeg', quality)
      }
      resolve(result)
    }
    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
}

async function addImages(dataUrls: string[]) {
  for (const raw of dataUrls) {
    const compressed = await compressImageIfNeeded(raw, MAX_IMAGE_SIZE)
    pendingImages.push(compressed)
  }
}

function removePendingImage(index: number) {
  pendingImages.splice(index, 1)
}

async function selectImages() {
  const images = await window.dialogApi.selectImages()
  if (images.length) await addImages(images)
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
      reader.onload = async () => {
        if (typeof reader.result === 'string') {
          await addImages([reader.result])
        }
      }
      reader.readAsDataURL(file)
    }
  }
  if (hasImage) e.preventDefault()
}

function handleDrop(e: DragEvent) {
  e.preventDefault()
  const files = e.dataTransfer?.files
  if (!files) return
  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    if (!file.type.startsWith('image/')) continue
    const reader = new FileReader()
    reader.onload = async () => {
      if (typeof reader.result === 'string') {
        await addImages([reader.result])
      }
    }
    reader.readAsDataURL(file)
  }
}

function handleDragOver(e: DragEvent) {
  e.preventDefault()
}

async function loadConfig() {
  try {
    const config = await window.aiChat.getConfig()
    providers.value = config.providers || []
    activeProviderId.value = config.activeProviderId || ''
    currentModel.value = config.activeModel || ''

    // Auto-select first available model if nothing active
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
  modelSelectorOpen.value = false
  await window.aiChat.setActive(providerId, model)
}

async function loadCwd() {
  const cwd = await window.conversationApi.getCwd(props.conversationId)
  agentCwd.value = cwd || '~'
}

async function changeCwd() {
  const dir = await window.dialogApi.selectDirectory()
  if (!dir) return
  agentCwd.value = dir
  await window.conversationApi.setCwd(props.conversationId, dir)
}

async function loadMessages() {
  const stored = await window.conversationApi.getMessages(props.conversationId)
  messages.length = 0
  for (const m of stored) {
    const msg: ChatMessage = {
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }
    if (m.reasoning) msg.reasoning = m.reasoning
    if (m.images?.length) msg.images = m.images
    if (m.toolCalls?.length) {
      msg.toolCalls = m.toolCalls.map((tc: any) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
        status: tc.status as ToolCallInfo['status'],
        result: tc.result,
      }))
    }
    messages.push(msg)
  }
  scrollToBottom(true)
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const toSave: StoredMessage[] = messages.map((m) => {
      const stored: StoredMessage = { role: m.role, content: m.content }
      if (m.reasoning) stored.reasoning = m.reasoning
      if (m.images?.length) stored.images = m.images
      if (m.toolCalls?.length) {
        stored.toolCalls = m.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          status: tc.status,
          result: tc.result,
        }))
      }
      return stored
    })
    window.conversationApi.saveMessages(props.conversationId, toSave)
  }, 500)
}

const isNearBottom = ref(true)

function onMessagesScroll() {
  const el = messagesContainer.value
  if (!el) return
  isNearBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80
}

function scrollToBottom(force = false) {
  nextTick(() => {
    if (messagesContainer.value && (force || isNearBottom.value)) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
    }
  })
}

function getLastAssistant(): ChatMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return messages[i]
  }
  return null
}

// ---- Chat mode send ----

function sendChatMessage(text: string) {
  const requestId = crypto.randomUUID()
  currentRequestId = requestId
  messages.push({ role: 'assistant', content: '', reasoning: '' })
  isStreaming.value = true

  const historyMessages: ApiMessage[] = messages.slice(0, -1).map((m) => ({
    role: m.role,
    content: buildApiContent(m.content, m.images),
  }))

  window.aiChat.startStream({ requestId, model: currentModel.value, messages: historyMessages, providerId: activeProviderId.value })

  const assistantIdx = messages.length - 1

  const offReasoning = window.aiChat.onStreamReasoning(({ requestId: rid, delta }) => {
    if (rid !== requestId) return
    messages[assistantIdx].reasoning = (messages[assistantIdx].reasoning || '') + delta
    if (!messages[assistantIdx].reasoningExpanded) messages[assistantIdx].reasoningExpanded = true
    scrollReasoningToBottom(assistantIdx)
    scrollToBottom()
  })

  const offChunk = window.aiChat.onStreamChunk(({ requestId: rid, delta }) => {
    if (rid !== requestId) return
    messages[assistantIdx].content += delta
    scrollToBottom()
  })

  const offDone = window.aiChat.onStreamDone(({ requestId: rid }) => {
    if (rid !== requestId) return
    isStreaming.value = false
    setTimeout(() => { messages[assistantIdx].reasoningExpanded = false }, REASONING_COLLAPSE_DELAY)
    cleanup()
    scheduleSave()
  })

  const offError = window.aiChat.onStreamError(({ requestId: rid, message }) => {
    if (rid !== requestId) return
    errorMsg.value = message
    isStreaming.value = false
    if (!messages[assistantIdx].content) messages.pop()
    cleanup()
  })

  function cleanup() {
    offReasoning()
    offChunk()
    offDone()
    offError()
  }
}

// ---- Agent mode send ----

function sendAgentMessage(text: string) {
  const requestId = crypto.randomUUID()
  currentRequestId = requestId
  messages.push({ role: 'assistant', content: '', reasoning: '', toolCalls: [] })
  isStreaming.value = true

  const historyMessages: ApiMessage[] = messages.slice(0, -1).map((m) => ({
    role: m.role,
    content: buildApiContent(m.content, m.images),
  }))

  window.agentChat.start({ requestId, model: currentModel.value, messages: historyMessages, cwd: agentCwd.value, providerId: activeProviderId.value })

  const offReasoning = window.agentChat.onStreamReasoning(({ requestId: rid, delta }) => {
    if (rid !== requestId) return
    const msg = getLastAssistant()
    if (msg) {
      msg.reasoning = (msg.reasoning || '') + delta
      if (!msg.reasoningExpanded) msg.reasoningExpanded = true
      const idx = messages.lastIndexOf(msg)
      scrollReasoningToBottom(idx)
      scrollToBottom()
    }
  })

  const offChunk = window.agentChat.onStreamChunk(({ requestId: rid, delta }) => {
    if (rid !== requestId) return
    const msg = getLastAssistant()
    if (msg) {
      if (!msg.content && msg.reasoning) setTimeout(() => { msg.reasoningExpanded = false }, REASONING_COLLAPSE_DELAY)
      msg.content += delta
      scrollToBottom()
    }
  })

  const offToolCallStreaming = window.agentChat.onToolCallStreaming(({ requestId: rid, index, id, name, argumentsDelta }) => {
    if (rid !== requestId) return
    const msg = getLastAssistant()
    if (msg) {
      if (msg.reasoning) setTimeout(() => { msg.reasoningExpanded = false }, REASONING_COLLAPSE_DELAY)
      if (!msg.toolCalls) msg.toolCalls = []
      while (msg.toolCalls.length <= index) {
        msg.toolCalls.push({ id: '', name: '', arguments: '', status: 'streaming' })
      }
      const tc = msg.toolCalls[index]
      if (id) tc.id = id
      if (name) tc.name = name
      if (argumentsDelta) tc.arguments += argumentsDelta
      if (tc.status !== 'streaming') tc.status = 'streaming'
      scrollToBottom()
    }
  })

  const offToolPending = window.agentChat.onToolPending(({ requestId: rid, toolCallId, name, arguments: args, autoApprove }) => {
    if (rid !== requestId) return
    const msg = getLastAssistant()
    if (msg) {
      if (msg.reasoning) setTimeout(() => { msg.reasoningExpanded = false }, REASONING_COLLAPSE_DELAY)
      if (!msg.toolCalls) msg.toolCalls = []
      const existing = msg.toolCalls.find(t => t.id === toolCallId && t.status === 'streaming')
      if (existing) {
        existing.name = name
        existing.arguments = args
        existing.status = autoApprove ? 'running' : 'pending'
      } else {
        msg.toolCalls.push({ id: toolCallId, name, arguments: args, status: autoApprove ? 'running' : 'pending' })
      }
      scrollToBottom()
    }
  })

  const offToolRunning = window.agentChat.onToolRunning(({ requestId: rid, toolCallId }) => {
    if (rid !== requestId) return
    const msg = getLastAssistant()
    const tc = msg?.toolCalls?.find((t) => t.id === toolCallId)
    if (tc) {
      tc.status = 'running'
      scrollToBottom()
    }
  })

  const offToolOutputStream = window.agentChat.onToolOutputStream(({ requestId: rid, toolCallId, chunk }) => {
    if (rid !== requestId) return
    const msg = getLastAssistant()
    const tc = msg?.toolCalls?.find((t) => t.id === toolCallId)
    if (tc) {
      tc.streamOutput = (tc.streamOutput || '') + chunk
      scrollToBottom()
    }
  })

  const offToolResult = window.agentChat.onToolResult(({ requestId: rid, toolCallId, result, rejected }) => {
    if (rid !== requestId) return
    const msg = getLastAssistant()
    const tc = msg?.toolCalls?.find((t) => t.id === toolCallId)
    if (tc) {
      tc.status = rejected ? 'rejected' : 'completed'
      tc.result = result
      tc.streamOutput = undefined
      scrollToBottom()
    }
  })

  const offNewTurn = window.agentChat.onNewTurn(({ requestId: rid }) => {
    if (rid !== requestId) return
    messages.push({ role: 'assistant', content: '', reasoning: '', toolCalls: [] })
    scrollToBottom()
  })

  const offDone = window.agentChat.onDone(({ requestId: rid }) => {
    if (rid !== requestId) return
    isStreaming.value = false
    const msg = getLastAssistant()
    if (msg && !msg.content && !msg.toolCalls?.length && !msg.reasoning) {
      messages.pop()
    }
    setTimeout(() => { const lastMsg = getLastAssistant(); if (lastMsg) lastMsg.reasoningExpanded = false }, REASONING_COLLAPSE_DELAY)
    cleanup()
    scheduleSave()
  })

  const offError = window.agentChat.onError(({ requestId: rid, message }) => {
    if (rid !== requestId) return
    errorMsg.value = message
    isStreaming.value = false
    cleanup()
  })

  function cleanup() {
    offReasoning()
    offChunk()
    offToolCallStreaming()
    offToolPending()
    offToolRunning()
    offToolOutputStream()
    offToolResult()
    offNewTurn()
    offDone()
    offError()
  }
}

// ---- Common ----

async function sendMessage() {
  const text = inputText.value.trim()
  if ((!text && pendingImages.length === 0) || isStreaming.value) return

  errorMsg.value = ''

  const images = pendingImages.length > 0 ? [...pendingImages] : undefined

  const isFirstMessage = messages.length === 0
  const msg: ChatMessage = { role: 'user', content: text }
  if (images) msg.images = images
  messages.push(msg)

  if (isFirstMessage && props.conversationId) {
    const title = text
      ? (text.length > 30 ? text.slice(0, 30) + '...' : text)
      : `图片消息 (${images?.length || 0}张)`
    window.conversationApi.rename(props.conversationId, title)
    emit('titleChange', title)
  }

  inputText.value = ''
  pendingImages.splice(0)
  nextTick(() => {
    if (inputEl.value) {
      inputEl.value.style.height = 'auto'
    }
  })
  scrollToBottom(true)
  scheduleSave()

  if (chatMode.value === 'agent') {
    sendAgentMessage(text)
  } else {
    sendChatMessage(text)
  }
}

function stopGeneration() {
  if (!isStreaming.value || !currentRequestId) return
  if (chatMode.value === 'agent') {
    window.agentChat.stop(currentRequestId)
  } else {
    window.aiChat.stopStream(currentRequestId)
  }
}

function confirmTool(toolCallId: string) {
  window.agentChat.confirmTool(currentRequestId, toolCallId)
}

function rejectTool(toolCallId: string) {
  window.agentChat.rejectTool(currentRequestId, toolCallId)
}

function killCommand(toolCallId: string) {
  window.agentChat.killCommand(toolCallId)
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    sendMessage()
  }
}

function autoResize(e: Event) {
  const el = e.target as HTMLTextAreaElement
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 160) + 'px'
}

function selectMode(mode: ChatMode) {
  chatMode.value = mode
  modeDropdownOpen.value = false
  localStorage.setItem('chatMode', mode)
  inputEl.value?.focus()
}

function handleClickOutside(e: MouseEvent) {
  if (modeDropdownRef.value && !modeDropdownRef.value.contains(e.target as Node)) {
    modeDropdownOpen.value = false
  }
  if (modelSelectorRef.value && !modelSelectorRef.value.contains(e.target as Node)) {
    modelSelectorOpen.value = false
  }
}

const imagePreviewUrl = ref<string | null>(null)

function openImagePreview(url: string) {
  imagePreviewUrl.value = url
}

function closeImagePreview() {
  imagePreviewUrl.value = null
}

const debugMessagesJson = computed(() => {
  if (debugSelectedMsg.value !== null) {
    const msg = messages[debugSelectedMsg.value]
    return msg ? JSON.stringify(msg, null, 2) : 'null'
  }
  return JSON.stringify(messages, null, 2)
})

function copyDebugJson() {
  navigator.clipboard.writeText(debugMessagesJson.value).then(() => {
    debugCopied.value = true
    setTimeout(() => { debugCopied.value = false }, 1500)
  })
}

const cwdDisplay = computed(() => {
  const cwd = agentCwd.value
  if (!cwd || cwd === '~') return '~'
  const parts = cwd.split('/')
  return parts.length > 2 ? '.../' + parts.slice(-2).join('/') : cwd
})

watch(isStreaming, (val) => {
  emit('streamingChange', val)
})

onMounted(() => {
  loadConfig()
  loadCwd()
  loadMessagesPromise = loadMessages()
  inputEl.value?.focus()
  document.addEventListener('click', handleClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
  if (isStreaming.value && currentRequestId) {
    if (chatMode.value === 'agent') {
      window.agentChat.stop(currentRequestId)
    } else {
      window.aiChat.stopStream(currentRequestId)
    }
  }
})

async function sendWithContent(text: string, images?: string[], providerId?: string, model?: string, mode?: ChatMode) {
  if (loadMessagesPromise) await loadMessagesPromise
  if (providerId) activeProviderId.value = providerId
  if (model) currentModel.value = model
  if (mode) chatMode.value = mode
  if (images?.length) await addImages(images)
  inputText.value = text
  await nextTick()
  sendMessage()
}

defineExpose({ loadConfig, sendWithContent })
</script>

<template>
  <div class="chat-container">
    <!-- 顶栏 -->
    <div class="chat-topbar">
      <div ref="modelSelectorRef" class="model-selector">
        <button class="model-selector-btn" @click.stop="modelSelectorOpen = !modelSelectorOpen">
          <span v-if="activeProviderName" class="model-provider-label">{{ activeProviderName }}</span>
          <span class="model-name-label">{{ currentModel || '未配置模型' }}</span>
          <svg
            class="model-selector-chevron"
            :class="{ open: modelSelectorOpen }"
            width="11" height="11" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2.5"
            stroke-linecap="round" stroke-linejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        <Transition name="dropdown">
          <div v-if="modelSelectorOpen" class="model-selector-menu">
            <div v-if="!providers.length" class="model-selector-empty">请先在设置中配置供应商</div>
            <template v-else>
              <div v-for="p in providers" :key="p.id" class="model-selector-group">
                <div class="model-selector-group-title">{{ p.name || '未命名' }}</div>
                <button
                  v-for="m in p.models"
                  :key="`${p.id}-${m}`"
                  class="model-selector-item"
                  :class="{ active: activeProviderId === p.id && currentModel === m }"
                  @click="selectProviderModel(p.id, m)"
                >
                  <span>{{ m }}</span>
                  <svg v-if="activeProviderId === p.id && currentModel === m" class="check-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </button>
                <div v-if="!p.models.length" class="model-selector-no-models">暂无模型</div>
              </div>
            </template>
          </div>
        </Transition>
      </div>
      <button v-if="chatMode === 'agent'" class="cwd-btn" :title="agentCwd" @click="changeCwd">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        {{ cwdDisplay }}
      </button>
      <button v-if="debugMode" class="debug-topbar-btn" @click="debugPanelOpen = !debugPanelOpen; debugSelectedMsg = null">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2a4 4 0 0 0-4 4v2H6a2 2 0 0 0-2 2v1h4" /><path d="M18 8h-2V6a4 4 0 0 0-4-4" /><path d="M20 10a2 2 0 0 0-2-2h-2" /><rect x="6" y="10" width="12" height="10" rx="3" /><path d="M2 14h4" /><path d="M18 14h4" /><path d="M2 18h4" /><path d="M18 18h4" /><line x1="12" y1="10" x2="12" y2="20" />
        </svg>
        Debug
      </button>
    </div>

    <!-- 消息列表 -->
    <div ref="messagesContainer" class="messages-area" @scroll="onMessagesScroll">
      <div v-if="!messages.length" class="empty-state">
        <p>{{ chatMode === 'agent' ? '描述你的编程任务' : '开始对话吧' }}</p>
      </div>

      <div
        v-for="(msg, i) in messages"
        :key="i"
        class="message-row"
        :class="msg.role"
      >
        <!-- Thinking indicator (outside bubble, no background) -->
        <div
          v-if="msg.role === 'assistant' && isStreaming && i === messages.length - 1 && !msg.content && !msg.reasoning && !msg.toolCalls?.length"
          class="thinking-indicator"
        >
          <span class="thinking-text">正在思考</span>
          <span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span>
        </div>

        <div v-else class="message-bubble" :class="{ 'agent-bubble': chatMode === 'agent' && msg.role === 'assistant' }">
          <button
            v-if="debugMode"
            class="debug-msg-badge"
            :title="`查看消息 #${i} 原始数据`"
            @click.stop="debugSelectedMsg = debugSelectedMsg === i ? null : i; debugPanelOpen = true"
          >{{ i }}</button>
          <!-- Reasoning -->
          <div v-if="msg.reasoning" class="chat-reasoning">
            <button class="reasoning-toggle" @click="msg.reasoningExpanded = !msg.reasoningExpanded">
              显示思路
              <svg
                class="reasoning-chevron"
                :class="{ expanded: msg.reasoningExpanded }"
                width="12" height="12" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" stroke-width="2.5"
                stroke-linecap="round" stroke-linejoin="round"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            <div class="reasoning-collapse" :class="{ expanded: msg.reasoningExpanded }">
              <div class="reasoning-panel">
                <div
                  :ref="(el) => setReasoningContentRef(el as HTMLElement | null, i)"
                  class="reasoning-content"
                  v-html="renderReasoning(msg.reasoning)"
                ></div>
              </div>
            </div>
          </div>

          <!-- Images in user message -->
          <div v-if="msg.images?.length" class="message-images">
            <img
              v-for="(img, imgIdx) in msg.images"
              :key="imgIdx"
              :src="img"
              class="message-image"
              @click="openImagePreview(img)"
            />
          </div>

          <!-- Text content -->
          <div v-if="msg.content && msg.role === 'user'" class="message-content">{{ msg.content }}</div>
          <div v-if="msg.content && msg.role === 'assistant'" class="message-content markdown-body" v-html="renderMarkdown(msg.content)"></div>

          <!-- Tool calls (agent mode) -->
          <template v-if="msg.toolCalls?.length">
            <ToolCallCard
              v-for="tc in msg.toolCalls"
              :key="tc.id"
              :name="tc.name"
              :arguments="tc.arguments"
              :status="tc.status"
              :result="tc.result"
              :stream-output="tc.streamOutput"
              @confirm="confirmTool(tc.id)"
              @reject="rejectTool(tc.id)"
              @kill="killCommand(tc.id)"
            />
          </template>

          <!-- Streaming cursor -->
          <span v-if="msg.role === 'assistant' && isStreaming && i === messages.length - 1 && !msg.toolCalls?.some(t => t.status === 'streaming' || t.status === 'pending' || t.status === 'running')" class="cursor-blink">▍</span>
        </div>
      </div>
    </div>

    <!-- 错误提示 -->
    <div v-if="errorMsg" class="error-bar">
      {{ errorMsg }}
      <button @click="errorMsg = ''">✕</button>
    </div>

    <!-- 输入区 -->
    <div class="input-area" @drop="handleDrop" @dragover="handleDragOver">
      <!-- Pending images preview -->
      <div v-if="pendingImages.length" class="pending-images">
        <div v-for="(img, idx) in pendingImages" :key="idx" class="pending-image-item">
          <img :src="img" class="pending-image-thumb" />
          <button class="pending-image-remove" @click="removePendingImage(idx)" title="移除">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>
      <div class="input-row">
        <div ref="modeDropdownRef" class="mode-dropdown">
          <button class="mode-trigger" @click.stop="modeDropdownOpen = !modeDropdownOpen">
            <span class="mode-dot" :class="chatMode"></span>
            {{ modeLabels[chatMode] }}
            <svg
              class="mode-chevron"
              :class="{ open: modeDropdownOpen }"
              width="12" height="12" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" stroke-width="2.5"
              stroke-linecap="round" stroke-linejoin="round"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          <Transition name="dropdown">
            <div v-if="modeDropdownOpen" class="mode-menu">
              <button
                v-for="m in (['chat', 'agent'] as ChatMode[])"
                :key="m"
                class="mode-option"
                :class="{ active: chatMode === m }"
                @click="selectMode(m)"
              >
                <span class="mode-dot" :class="m"></span>
                <span>{{ modeLabels[m] }}</span>
                <svg v-if="chatMode === m" class="check-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </button>
            </div>
          </Transition>
        </div>
        <button class="image-upload-btn" @click="selectImages" title="添加图片">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
        </button>
        <textarea
          ref="inputEl"
          v-model="inputText"
          class="chat-input"
          rows="1"
          :placeholder="chatMode === 'agent' ? 'Agent 模式：描述任务...' : '输入消息... (Shift+Enter 换行)'"
          @keydown="handleKeydown"
          @input="autoResize"
          @paste="handlePaste"
        />
        <button v-if="isStreaming" class="stop-btn" @click="stopGeneration" title="终止对话">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <rect x="4" y="4" width="16" height="16" rx="2" />
          </svg>
        </button>
        <button v-else class="send-btn" :disabled="!canSend" @click="sendMessage">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Image Preview Overlay -->
    <Transition name="dropdown">
      <div v-if="imagePreviewUrl" class="image-preview-overlay" @click="closeImagePreview">
        <img :src="imagePreviewUrl" class="image-preview-full" @click.stop />
        <button class="image-preview-close" @click="closeImagePreview">✕</button>
      </div>
    </Transition>

    <!-- Debug Panel -->
    <Transition name="debug-slide">
      <div v-if="debugMode && debugPanelOpen" class="debug-panel">
        <div class="debug-panel-header">
          <span class="debug-panel-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2a4 4 0 0 0-4 4v2H6a2 2 0 0 0-2 2v1h4" /><path d="M18 8h-2V6a4 4 0 0 0-4-4" /><path d="M20 10a2 2 0 0 0-2-2h-2" /><rect x="6" y="10" width="12" height="10" rx="3" /><line x1="12" y1="10" x2="12" y2="20" />
            </svg>
            {{ debugSelectedMsg !== null ? `消息 #${debugSelectedMsg}` : `全部消息 (${messages.length})` }}
          </span>
          <div class="debug-panel-actions">
            <button class="debug-action-btn" @click="copyDebugJson" :title="debugCopied ? '已复制' : '复制 JSON'">
              <svg v-if="!debugCopied" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
              <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
            </button>
            <button v-if="debugSelectedMsg !== null" class="debug-action-btn" @click="debugSelectedMsg = null" title="查看全部">全部</button>
            <button class="debug-action-btn" @click="debugPanelOpen = false" title="关闭">✕</button>
          </div>
        </div>
        <div class="debug-panel-body">
          <pre class="debug-json">{{ debugMessagesJson }}</pre>
        </div>
        <div class="debug-panel-footer">
          <span>Raw Messages</span>
          <span>{{ messages.length }} 条消息</span>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.chat-container {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--c-base);
  color: var(--c-text);
}

.chat-topbar {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--c-surface0);
  gap: 8px;
  min-height: 46px;
  -webkit-app-region: drag;
}

/* -- Model Selector -- */
.model-selector {
  -webkit-app-region: no-drag;
  position: relative;
}

.model-selector-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: none;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 3px 8px;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s, border-color 0.15s;
  user-select: none;
}

.model-selector-btn:hover {
  background: var(--c-surface0);
  border-color: var(--c-surface1);
}

.model-provider-label {
  font-size: 0.72rem;
  color: var(--c-overlay0);
  padding: 1px 6px;
  background: var(--c-surface0);
  border-radius: 4px;
}

.model-name-label {
  font-size: 0.82rem;
  color: var(--c-overlay1);
}

.model-selector-chevron {
  color: var(--c-overlay0);
  transition: transform 0.2s ease;
}

.model-selector-chevron.open {
  transform: rotate(180deg);
}

.model-selector-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  min-width: 220px;
  max-width: 320px;
  max-height: 360px;
  overflow-y: auto;
  background: var(--c-surface-alt);
  border: 1px solid var(--c-surface1);
  border-radius: 10px;
  padding: 4px;
  box-shadow: 0 8px 24px var(--c-shadow-heavy);
  z-index: 100;
}

.model-selector-empty {
  padding: 12px 14px;
  font-size: 0.82rem;
  color: var(--c-overlay0);
  text-align: center;
}

.model-selector-group {
  padding: 2px 0;
}

.model-selector-group + .model-selector-group {
  border-top: 1px solid var(--c-surface0);
  margin-top: 2px;
  padding-top: 4px;
}

.model-selector-group-title {
  padding: 6px 10px 4px;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--c-overlay0);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.model-selector-item {
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

.model-selector-item:hover {
  background: var(--c-surface-hover);
}

.model-selector-item.active {
  background: var(--c-surface0);
  color: var(--c-blue);
}

.model-selector-no-models {
  padding: 6px 10px;
  font-size: 0.78rem;
  color: var(--c-overlay0);
  font-style: italic;
}

.cwd-btn {
  -webkit-app-region: no-drag;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  margin-right: 4px;
  color: var(--c-surface2);
  font-size: 0.75rem;
  white-space: nowrap;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  background: none;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 3px 8px;
  cursor: pointer;
  font-family: inherit;
  transition: color 0.2s, background 0.2s, border-color 0.2s;
}

.cwd-btn:hover {
  color: var(--c-subtext1);
  background: var(--c-surface0);
  border-color: var(--c-surface1);
}

.messages-area {
  flex: 1;
  overflow-y: auto;
  scrollbar-gutter: stable;
  padding: 16px 16px 80px;
  display: flex;
  flex-direction: column;
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--c-overlay0);
  font-size: 1.1rem;
  gap: 16px;
}

.message-row {
  display: flex;
}

.message-row.user {
  justify-content: flex-end;
}

.message-row.assistant {
  justify-content: flex-start;
}

.message-row + .message-row {
  margin-top: 4px;
}

.message-row.assistant + .message-row.user,
.message-row.user + .message-row.assistant {
  margin-top: 50px;
}

.message-row.assistant + .message-row.assistant {
  margin-top: 0;
}

.message-bubble {
  max-width: 75%;
  border-radius: 12px;
  line-height: 1.6;
  font-size: 0.92rem;
  word-break: break-word;
}

.user .message-bubble {
  white-space: pre-wrap;
}

.message-bubble.agent-bubble {
  max-width: 88%;
}

.user .message-bubble {
  background: var(--c-user-bubble-bg);
  color: var(--c-user-bubble-text);
  border-bottom-right-radius: 4px;
  padding: 10px 14px;
}

.assistant .message-bubble {
  background: transparent;
  color: var(--c-text);
  border-bottom-left-radius: 4px;
  padding-top: 0;
  padding-bottom: 0;
}

/* Markdown rendered content */
.markdown-body {
  line-height: 1.7;
}

.markdown-body :deep(p) {
  margin: 0 0 0.8em;
}

.markdown-body :deep(p:last-child) {
  margin-bottom: 0;
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4) {
  margin: 1em 0 0.5em;
  font-weight: 600;
  color: var(--c-text);
  line-height: 1.35;
}

.markdown-body :deep(h1) { font-size: 1.3em; }
.markdown-body :deep(h2) { font-size: 1.15em; }
.markdown-body :deep(h3) { font-size: 1.05em; }
.markdown-body :deep(h4) { font-size: 1em; }

.markdown-body :deep(h1:first-child),
.markdown-body :deep(h2:first-child),
.markdown-body :deep(h3:first-child) {
  margin-top: 0;
}

.markdown-body :deep(strong) {
  font-weight: 600;
  color: var(--c-text);
}

.markdown-body :deep(em) {
  font-style: italic;
  color: var(--c-subtext1);
}

.markdown-body :deep(code) {
  background: var(--c-surface-alt);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  font-size: 0.85em;
  color: var(--c-code-inline);
}

.markdown-body :deep(pre) {
  background: var(--c-surface-alt);
  border-radius: 8px;
  padding: 12px 14px;
  margin: 0.6em 0;
  overflow-x: auto;
}

.markdown-body :deep(pre code) {
  background: none;
  padding: 0;
  border-radius: 0;
  color: var(--c-text);
  font-size: 0.84em;
  line-height: 1.6;
}

.markdown-body :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 0.6em 0;
  font-size: 0.88em;
}

.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid var(--c-surface1);
  padding: 6px 12px;
  text-align: left;
}

.markdown-body :deep(th) {
  background: var(--c-surface-alt);
  font-weight: 600;
  color: var(--c-text);
}

.markdown-body :deep(tr:nth-child(even)) {
  background: var(--c-drag-overlay);
}

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: 0.4em 0;
  padding-left: 1.6em;
}

.markdown-body :deep(li) {
  margin: 0.2em 0;
}

.markdown-body :deep(li > p) {
  margin: 0;
}

.markdown-body :deep(blockquote) {
  border-left: 3px solid var(--c-surface2);
  margin: 0.6em 0;
  padding: 4px 14px;
  color: var(--c-subtext0);
}

.markdown-body :deep(blockquote p) {
  margin: 0;
}

.markdown-body :deep(hr) {
  border: none;
  border-top: 1px solid var(--c-surface1);
  margin: 1em 0;
}

.markdown-body :deep(a) {
  color: var(--c-blue);
  text-decoration: none;
}

.markdown-body :deep(a:hover) {
  text-decoration: underline;
}

.markdown-body :deep(img) {
  max-width: 100%;
  border-radius: 8px;
}

.chat-reasoning {
  display: flex;
  flex-direction: column;
  margin-bottom: 8px;
}

.assistant .message-content {
  margin-bottom: 8px;
}

.assistant .message-bubble > :last-child {
  margin-bottom: 0;
}

.reasoning-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  color: var(--c-overlay1);
  font-size: 0.82rem;
  line-height: 1.6;
  cursor: pointer;
  padding: 0;
  width: fit-content;
  user-select: none;
  font-family: inherit;
  transition: color 0.2s;
}

.reasoning-toggle:hover {
  color: var(--c-subtext1);
}

.reasoning-chevron {
  transition: transform 0.25s ease;
}

.reasoning-chevron.expanded {
  transform: rotate(180deg);
}

.reasoning-collapse {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.3s ease-out;
}

.reasoning-collapse.expanded {
  grid-template-rows: 1fr;
}

.reasoning-panel {
  overflow: hidden;
  min-height: 0;
}

.reasoning-panel > .reasoning-content {
  margin-top: 8px;
  padding: 14px 16px;
  background: var(--c-surface-alt);
}

.reasoning-content {
  font-size: 0.84rem;
  line-height: 1.75;
  color: var(--c-subtext0);
  font-style: italic;
  max-height: 320px;
  overflow-y: auto;
}

.reasoning-content :deep(p) {
  margin: 0 0 10px;
}

.reasoning-content :deep(p:last-child) {
  margin-bottom: 0;
}

.reasoning-content :deep(strong) {
  font-style: normal;
  color: var(--c-text);
  font-weight: 600;
  display: block;
  margin-bottom: 2px;
}

.thinking-indicator {
  display: inline-flex;
  align-items: baseline;
  gap: 0;
  padding: 4px 2px;
}

.thinking-text {
  font-size: 0.85rem;
  color: var(--c-overlay0);
  animation: thinking-pulse 2s ease-in-out infinite;
}

.thinking-dots {
  display: inline-flex;
  gap: 0;
}

.thinking-dots span {
  font-size: 0.85rem;
  color: var(--c-overlay0);
  animation: thinking-pulse 2s ease-in-out infinite;
}

@keyframes thinking-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

.cursor-blink {
  animation: blink 1s step-end infinite;
}

@keyframes blink {
  50% { opacity: 0; }
}

.error-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  background: var(--c-error-bar-bg);
  color: var(--c-error-bar-text);
  font-size: 0.85rem;
}

.error-bar button {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 1rem;
  padding: 0 4px;
}

.input-area {
  padding: 12px 16px;
  border-top: 1px solid var(--c-surface0);
}

.input-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

/* -- Mode dropdown -- */
.mode-dropdown {
  position: relative;
  flex-shrink: 0;
}

.mode-trigger {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: var(--c-surface0);
  border: 1px solid var(--c-surface1);
  border-radius: 10px;
  padding: 0 12px;
  height: 40px;
  color: var(--c-subtext1);
  font-size: 0.82rem;
  cursor: pointer;
  font-family: inherit;
  white-space: nowrap;
  transition: background 0.2s, border-color 0.2s;
  user-select: none;
}

.mode-trigger:hover {
  background: var(--c-surface-hover);
  border-color: var(--c-surface2);
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

.dropdown-enter-active,
.dropdown-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

/* -- Image upload button -- */
.image-upload-btn {
  background: var(--c-surface0);
  border: 1px solid var(--c-surface1);
  color: var(--c-overlay0);
  cursor: pointer;
  width: 40px;
  height: 40px;
  min-height: 40px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: color 0.2s, background 0.2s, border-color 0.2s;
}

.image-upload-btn:hover {
  color: var(--c-subtext1);
  background: var(--c-surface-hover);
  border-color: var(--c-surface2);
}

/* -- Pending images preview -- */
.pending-images {
  display: flex;
  gap: 8px;
  padding: 8px 0 4px;
  overflow-x: auto;
  flex-wrap: wrap;
}

.pending-image-item {
  position: relative;
  flex-shrink: 0;
}

.pending-image-thumb {
  width: 64px;
  height: 64px;
  object-fit: cover;
  border-radius: 8px;
  border: 1px solid var(--c-surface1);
}

.pending-image-remove {
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

.pending-image-remove:hover {
  background: var(--c-red, #e64553);
  color: #fff;
}

/* -- Message images -- */
.message-images {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}

.message-image {
  max-width: 200px;
  max-height: 200px;
  border-radius: 8px;
  cursor: pointer;
  object-fit: cover;
  transition: opacity 0.15s;
}

.message-image:hover {
  opacity: 0.85;
}

/* -- Image preview overlay -- */
.image-preview-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 500;
  cursor: pointer;
}

.image-preview-full {
  max-width: 90vw;
  max-height: 90vh;
  border-radius: 8px;
  object-fit: contain;
  cursor: default;
}

.image-preview-close {
  position: absolute;
  top: 16px;
  right: 16px;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.15);
  border: none;
  color: #fff;
  font-size: 1.1rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s;
}

.image-preview-close:hover {
  background: rgba(255, 255, 255, 0.3);
}

/* -- Input & send -- */
.chat-input {
  flex: 1;
  background: var(--c-surface0);
  border: 1px solid var(--c-surface1);
  border-radius: 10px;
  padding: 8px 14px;
  color: var(--c-text);
  font-size: 0.92rem;
  outline: none;
  resize: none;
  line-height: 1.5;
  min-height: 40px;
  max-height: 160px;
  font-family: inherit;
  transition: border-color 0.2s;
  box-sizing: border-box;
}

.chat-input:focus {
  border-color: var(--c-blue);
}

.chat-input::placeholder {
  color: var(--c-overlay0);
}

.send-btn {
  background: var(--c-send-btn-bg);
  color: var(--c-send-btn-text);
  border: none;
  border-radius: 10px;
  width: 40px;
  height: 40px;
  min-height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: opacity 0.2s;
}

.send-btn:hover:not(:disabled) {
  opacity: 0.85;
}

.send-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.stop-btn {
  background: var(--c-red, #e64553);
  color: #fff;
  border: none;
  border-radius: 10px;
  width: 40px;
  height: 40px;
  min-height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: opacity 0.2s, background 0.2s;
}

.stop-btn:hover {
  opacity: 0.85;
}

/* ---- Debug Mode ---- */
.debug-topbar-btn {
  -webkit-app-region: no-drag;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  background: rgba(250, 179, 40, 0.12);
  border: 1px solid rgba(250, 179, 40, 0.3);
  border-radius: 6px;
  padding: 3px 10px;
  color: #fab328;
  font-size: 0.72rem;
  font-weight: 600;
  font-family: 'SF Mono', 'Fira Code', monospace;
  cursor: pointer;
  transition: background 0.2s;
  letter-spacing: 0.02em;
}

.debug-topbar-btn:hover {
  background: rgba(250, 179, 40, 0.2);
}

.message-bubble {
  position: relative;
}

.debug-msg-badge {
  position: absolute;
  top: -8px;
  left: -8px;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  border: none;
  font-size: 0.62rem;
  font-weight: 700;
  font-family: 'SF Mono', 'Fira Code', monospace;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(250, 179, 40, 0.2);
  color: #fab328;
  opacity: 0;
  transition: opacity 0.15s;
  z-index: 5;
}

.message-bubble:hover .debug-msg-badge,
.debug-msg-badge:hover {
  opacity: 1;
}

.user .debug-msg-badge {
  left: auto;
  right: -8px;
}

/* Debug Panel */
.debug-panel {
  position: absolute;
  top: 47px;
  right: 0;
  bottom: 0;
  width: min(420px, 80vw);
  background: var(--c-base);
  border-left: 1px solid var(--c-surface1);
  display: flex;
  flex-direction: column;
  z-index: 200;
  box-shadow: -4px 0 24px var(--c-shadow-heavy, rgba(0,0,0,0.15));
}

.debug-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--c-surface0);
  gap: 8px;
}

.debug-panel-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.82rem;
  font-weight: 600;
  color: #fab328;
}

.debug-panel-actions {
  display: flex;
  gap: 4px;
}

.debug-action-btn {
  background: var(--c-surface0);
  border: 1px solid var(--c-surface1);
  border-radius: 5px;
  padding: 2px 10px;
  color: var(--c-subtext1);
  font-size: 0.75rem;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s;
}

.debug-action-btn:hover {
  background: var(--c-surface-hover);
}

.debug-panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 14px;
}

.debug-json {
  margin: 0;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  font-size: 0.74rem;
  line-height: 1.6;
  color: var(--c-subtext1);
  white-space: pre-wrap;
  word-break: break-all;
  tab-size: 2;
}

.debug-panel-footer {
  display: flex;
  justify-content: space-between;
  padding: 6px 14px;
  border-top: 1px solid var(--c-surface0);
  font-size: 0.68rem;
  color: var(--c-overlay0);
  font-family: 'SF Mono', 'Fira Code', monospace;
}

/* Debug slide transition */
.debug-slide-enter-active,
.debug-slide-leave-active {
  transition: transform 0.25s ease, opacity 0.25s ease;
}

.debug-slide-enter-from,
.debug-slide-leave-to {
  transform: translateX(100%);
  opacity: 0;
}
</style>
