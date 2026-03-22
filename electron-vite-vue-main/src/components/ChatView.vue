<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, nextTick, computed, watch, inject, toRef, type Ref } from 'vue'
import { marked } from 'marked'
import ChatComposer from './ChatComposer.vue'
import ToolCallCard from './ToolCallCard.vue'
import type { CodeReference, FileReference } from '../types/workspace'

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

interface PlanStep {
  step: string
  status: 'pending' | 'in_progress' | 'completed'
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  reasoningExpanded?: boolean
  images?: string[]
  toolCalls?: ToolCallInfo[]
  planSteps?: PlanStep[]
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

const globalConvState = inject<Record<string, any>>('globalConvState')!

function ensureConvState() {
  if (!globalConvState[props.conversationId]) {
    globalConvState[props.conversationId] = {
      messages: [],
      currentRequestId: '',
      isStreaming: false,
      streamChatMode: undefined as ChatMode | undefined,
    }
  }
  return globalConvState[props.conversationId]
}

const convState = ensureConvState()
const messages: ChatMessage[] = convState.messages
const isStreaming = toRef(convState, 'isStreaming')
const inputText = ref('')
const currentModel = ref('')
const activeProviderId = ref('')
const providers = ref<ModelProvider[]>([])
const errorMsg = ref('')
const chatMode = ref<ChatMode>((localStorage.getItem('chatMode') as ChatMode) || 'agent')

const messagesContainer = ref<HTMLElement>()
const composerRef = ref<InstanceType<typeof ChatComposer>>()
const editComposerRef = ref<InstanceType<typeof ChatComposer>>()
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

let saveTimer: ReturnType<typeof setTimeout> | null = null
let loadMessagesPromise: Promise<void> | null = null

const canSend = computed(() => (Boolean(inputText.value.trim()) || pendingImages.length > 0 || pendingCodeReferences.length > 0 || pendingFileReferences.length > 0) && !isStreaming.value && !!currentModel.value)

const openTabById = inject<(tabId: string) => void>('openTabById', () => {})

interface MentionTab {
  key: string
  value: string
  type: 'file' | 'webview'
  currentUrl?: string
}

const openTabs = inject<Ref<MentionTab[]>>('openTabs', ref([]))
const appActiveConvId = inject<Ref<string>>('appActiveConvId', ref(''))
const activeTabConvIds = inject<Ref<Set<string>>>('activeTabConvIds', ref(new Set()))
const webviewCurrentUrls = inject<Record<string, string>>('webviewCurrentUrls', {})
const pendingCodeReferences = inject<CodeReference[]>('pendingCodeReferences', [])
const clearCodeReferences = inject<() => void>('clearCodeReferences', () => {})
const pendingFileReferences = inject<FileReference[]>('pendingFileReferences', [])
const addFileReferences = inject<(refs: FileReference[]) => void>('addFileReferences', () => {})
const clearFileReferences = inject<() => void>('clearFileReferences', () => {})

function toRelativePath(cwd: string, filePath: string): string {
  const base = cwd.endsWith('/') ? cwd : cwd + '/'
  return filePath.startsWith(base) ? filePath.slice(base.length) : filePath
}

function tabLabel(t: MentionTab, cwd?: string): string {
  if (t.type === 'file') {
    const abs = t.value.slice('__editor__:'.length)
    return cwd ? toRelativePath(cwd, abs) : abs
  }
  const fp = t.value.slice('__webview__:'.length)
  const url = t.currentUrl ?? fp
  if (url.startsWith('file://')) {
    const decoded = decodeURIComponent(url.replace(/^file:\/\//, ''))
    const rel = cwd ? toRelativePath(cwd, decoded) : decoded
    return `${rel}（浏览器）`
  }
  return url
}

function buildTabContext(cwd?: string): string | null {
  const tabs = openTabs.value
  if (!tabs.length) return null

  const visibleIds = activeTabConvIds.value
  const viewing: string[] = []
  const background: string[] = []

  for (const t of tabs) {
    const label = tabLabel(t, cwd)
    if (visibleIds.has(t.value)) {
      viewing.push(label)
    } else {
      background.push(label)
    }
  }

  const lines: string[] = []
  if (viewing.length) lines.push(`正在查看：${viewing.join('、')}`)
  if (background.length) lines.push(`后台标签：${background.join('、')}`)

  return lines.length ? lines.join('\n') : null
}

function renderUserContent(content: string): string {
  const escaped = content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
  return escaped.replace(/@\[([^\]]+)\]\(([^)]+)\)/g, (_, label, tabId) => {
    const safeTabId = tabId.replace(/"/g, '&quot;')
    const isFile = tabId.startsWith('__editor__:')
    const iconSvg = isFile
      ? `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`
      : `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`
    return `<span class="mention-chip" data-tab-id="${safeTabId}" title="${safeTabId.replace('__editor__:', '').replace('__webview__:', '')}">${iconSvg}<span class="mention-chip-label">${label}</span></span>`
  })
}

function handleMentionClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  const chip = target.closest('.mention-chip') as HTMLElement | null
  if (chip?.dataset.tabId) {
    openTabById(chip.dataset.tabId)
  }
}

function formatCodeReferences(refs: CodeReference[]): string {
  return refs.map((r) => {
    const name = r.filePath.replace(/\\/g, '/').split('/').pop() || r.filePath
    const lineRange = r.startLine === r.endLine ? `L${r.startLine}` : `L${r.startLine}-L${r.endLine}`
    return `[引用: ${name} (${lineRange})]\n\`\`\`${r.language}\n${r.text}\n\`\`\``
  }).join('\n\n')
}

function formatFileReferences(refs: FileReference[]): string {
  return refs.map((r) => `[文件: ${r.filePath}]`).join('\n')
}

const agentCwd = ref('~')

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
  // Image files only — file references are handled by ChatComposer's input-card
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
  if (messages.length > 0) {
    scrollToBottom(true)
    return
  }
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
    if ((m as any).planSteps?.length) {
      msg.planSteps = (m as any).planSteps
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
      if (m.planSteps?.length) {
        (stored as any).planSteps = m.planSteps
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
  convState.currentRequestId = requestId
  convState.streamChatMode = 'chat'
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
  convState.currentRequestId = requestId
  convState.streamChatMode = 'agent'
  messages.push({ role: 'assistant', content: '', reasoning: '', toolCalls: [] })
  isStreaming.value = true

  const historyMessages: ApiMessage[] = messages.slice(0, -1).map((m) => ({
    role: m.role,
    content: buildApiContent(m.content, m.images),
  }))

  window.agentChat.start({ requestId, model: currentModel.value, messages: historyMessages, cwd: agentCwd.value, providerId: activeProviderId.value, tabContext: buildTabContext(agentCwd.value) ?? undefined })

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

  const offPlanUpdate = window.agentChat.onPlanUpdate(({ requestId: rid, plan }) => {
    if (rid !== requestId) return
    const msg = getLastAssistant()
    if (msg) {
      msg.planSteps = plan.map(p => ({ step: p.step, status: p.status as PlanStep['status'] }))
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
    if (msg && !msg.content && !msg.toolCalls?.length && !msg.reasoning && !msg.planSteps?.length) {
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
    offPlanUpdate()
    offNewTurn()
    offDone()
    offError()
  }
}

// ---- Common ----

async function sendMessage() {
  const text = inputText.value.trim()
  const refs = [...pendingCodeReferences]
  const fileRefs = [...pendingFileReferences]
  if ((!text && pendingImages.length === 0 && !refs.length && !fileRefs.length) || isStreaming.value) return

  errorMsg.value = ''

  const images = pendingImages.length > 0 ? [...pendingImages] : undefined
  const refsText = refs.length ? formatCodeReferences(refs) : ''
  const fileRefsText = fileRefs.length ? formatFileReferences(fileRefs) : ''
  const contextParts = [refsText, fileRefsText].filter(Boolean).join('\n\n')
  const fullText = contextParts ? (text ? `${contextParts}\n\n${text}` : contextParts) : text

  const isFirstMessage = messages.length === 0
  const msg: ChatMessage = { role: 'user', content: fullText }
  if (images) msg.images = images
  messages.push(msg)

  if (isFirstMessage && props.conversationId) {
    const title = text
      ? (text.length > 30 ? text.slice(0, 30) + '...' : text)
      : refs.length
        ? `引用: ${refs[0].filePath.split('/').pop()}`
        : fileRefs.length
          ? `文件: ${fileRefs[0].name}`
          : `图片消息 (${images?.length || 0}张)`
    window.conversationApi.rename(props.conversationId, title)
    emit('titleChange', title)
  }

  inputText.value = ''
  pendingImages.splice(0)
  clearCodeReferences()
  clearFileReferences()
  scrollToBottom(true)
  scheduleSave()

  if (chatMode.value === 'agent') {
    sendAgentMessage(fullText)
  } else {
    sendChatMessage(fullText)
  }
}

function stopGeneration() {
  const rid = convState.currentRequestId
  if (!isStreaming.value || !rid) return
  const mode = convState.streamChatMode || chatMode.value
  if (mode === 'agent') {
    window.agentChat.stop(rid)
  } else {
    window.aiChat.stopStream(rid)
  }
}

function confirmTool(toolCallId: string) {
  window.agentChat.confirmTool(convState.currentRequestId, toolCallId)
}

function rejectTool(toolCallId: string) {
  window.agentChat.rejectTool(convState.currentRequestId, toolCallId)
}

function killCommand(toolCallId: string) {
  window.agentChat.killCommand(toolCallId)
}

const copiedMsgIndex = ref<number | null>(null)

function copyMessage(msg: ChatMessage) {
  const text = msg.content || ''
  navigator.clipboard.writeText(text).then(() => {
    const idx = messages.indexOf(msg)
    copiedMsgIndex.value = idx
    setTimeout(() => { copiedMsgIndex.value = null }, 1500)
  })
}

const editingIndex = ref<number | null>(null)
const editingContent = ref('')

function editMessage(index: number) {
  const msg = messages[index]
  if (!msg) return
  editingIndex.value = index
  editingContent.value = msg.content
  nextTick(() => {
    editComposerRef.value?.focusInput()
  })
}

function confirmEdit() {
  const idx = editingIndex.value
  if (idx === null) return
  const text = editingContent.value.trim()
  if (!text) { cancelEdit(); return }

  const msg = messages[idx]
  messages.splice(idx + 1)
  msg.content = text
  if (msg.images) delete (msg as any).images
  scheduleSave()
  editingIndex.value = null

  if (msg.role === 'user') {
    scrollToBottom(true)
    if (chatMode.value === 'agent') {
      sendAgentMessage(text)
    } else {
      sendChatMessage(text)
    }
  }
}

function cancelEdit() {
  editingIndex.value = null
}

// 点击外部区域退出编辑
function handleClickOutsideEdit(e: MouseEvent) {
  if (editingIndex.value === null) return
  const editEl = document.querySelector('.edit-inline')
  if (editEl && !editEl.contains(e.target as Node)) {
    cancelEdit()
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutsideEdit)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutsideEdit)
})

function selectMode(mode: ChatMode) {
  chatMode.value = mode
  localStorage.setItem('chatMode', mode)
  nextTick(() => composerRef.value?.focusInput())
}

const imagePreviewUrl = ref<string | null>(null)

function openImagePreview(url: string) {
  imagePreviewUrl.value = url
}

function closeImagePreview() {
  imagePreviewUrl.value = null
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

watch(
  () => {
    const last = messages[messages.length - 1]
    return last?.content?.length
  },
  () => {
    if (isStreaming.value) scrollToBottom()
  }
)

onMounted(() => {
  loadConfig()
  loadCwd()
  loadMessagesPromise = loadMessages()
  nextTick(() => composerRef.value?.focusInput())
  emit('streamingChange', isStreaming.value)
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

        <div v-else class="message-bubble" :class="{ 'agent-bubble': chatMode === 'agent' && msg.role === 'assistant', 'editing': editingIndex === i }">
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
          <div v-if="msg.images?.length && editingIndex !== i" class="message-images">
            <img
              v-for="(img, imgIdx) in msg.images"
              :key="imgIdx"
              :src="img"
              class="message-image"
              @click="openImagePreview(img)"
            />
          </div>

          <!-- Inline editing -->
          <div v-if="editingIndex === i" class="edit-inline" @click.stop>
            <ChatComposer
              ref="editComposerRef"
              v-model="editingContent"
              variant="chat"
              :pending-images="[]"
              :providers="providers"
              :active-provider-id="activeProviderId"
              :current-model="currentModel"
              :chat-mode="chatMode"
              :can-send="!!editingContent.trim()"
              placeholder="编辑消息..."
              @send="confirmEdit"
              @select-provider-model="({ providerId, model }) => selectProviderModel(providerId, model)"
              @select-mode="selectMode"
            />
          </div>

          <!-- Text content -->
          <template v-else>
            <div
              v-if="msg.content && msg.role === 'user'"
              class="message-content user-message-content"
              v-html="renderUserContent(msg.content)"
              @click="handleMentionClick"
            ></div>
            <div v-if="msg.content && msg.role === 'assistant'" class="message-content markdown-body" v-html="renderMarkdown(msg.content)"></div>
          </template>

          <!-- Plan checklist -->
          <div v-if="msg.planSteps?.length" class="plan-card">
            <div class="plan-header">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 11l3 3L22 4"/>
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
              </svg>
              <span>任务计划</span>
              <span class="plan-progress">{{ msg.planSteps.filter(s => s.status === 'completed').length }}/{{ msg.planSteps.length }}</span>
            </div>
            <ul class="plan-steps">
              <li v-for="(step, si) in msg.planSteps" :key="si" class="plan-step" :class="'plan-step--' + step.status">
                <span class="plan-step-icon">
                  <svg v-if="step.status === 'completed'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  <span v-else-if="step.status === 'in_progress'" class="plan-spinner"></span>
                  <span v-else class="plan-circle"></span>
                </span>
                <span class="plan-step-text">{{ step.step }}</span>
              </li>
            </ul>
          </div>

          <!-- Tool calls (agent mode) -->
          <template v-if="msg.toolCalls?.length">
            <ToolCallCard
              v-for="tc in msg.toolCalls.filter(t => t.name !== 'update_plan')"
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

          <!-- Hover action buttons（仅用户消息可复制 / 编辑） -->
          <div class="msg-actions" v-if="msg.role === 'user' && (!isStreaming || i !== messages.length - 1)">
            <button class="msg-action-btn" :class="{ copied: copiedMsgIndex === i }" title="复制" @click.stop="copyMessage(msg)">
              <svg v-if="copiedMsgIndex !== i" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
              <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </button>
            <button v-if="editingIndex === i" class="msg-action-btn" title="取消编辑" @click.stop="cancelEdit">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
            <button v-else class="msg-action-btn" title="编辑（回滚到此消息）" @click.stop="editMessage(i)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </button>
          </div>
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
      <button v-if="chatMode === 'agent'" class="cwd-btn" :title="agentCwd" @click="changeCwd">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        {{ cwdDisplay }}
      </button>
      <ChatComposer
        ref="composerRef"
        v-model="inputText"
        variant="chat"
        :pending-images="pendingImages"
        :providers="providers"
        :active-provider-id="activeProviderId"
        :current-model="currentModel"
        :chat-mode="chatMode"
        :can-send="canSend"
        :is-streaming="isStreaming"
        :placeholder="chatMode === 'agent' ? 'Agent 模式：描述任务...' : '输入消息... (Shift+Enter 换行)'"
        @send="sendMessage"
        @stop="stopGeneration"
        @paste="handlePaste"
        @select-images="selectImages"
        @remove-image="removePendingImage"
        @select-provider-model="({ providerId, model }) => selectProviderModel(providerId, model)"
        @select-mode="selectMode"
      />
    </div>

    <!-- Image Preview Overlay -->
    <Transition name="dropdown">
      <div v-if="imagePreviewUrl" class="image-preview-overlay" @click="closeImagePreview">
        <img :src="imagePreviewUrl" class="image-preview-full" @click.stop />
        <button class="image-preview-close" @click="closeImagePreview">✕</button>
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

:root:not([data-theme="dark"]) .chat-container {
  background: #ffffff;
}



.cwd-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--c-surface2);
  font-size: 0.75rem;
  white-space: nowrap;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  background: none;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 3px 8px;
  margin-bottom: 4px;
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
  position: relative;
}

.message-row:hover {
  z-index: 5;
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

.user-message-content {
  word-break: break-word;
  white-space: normal;
  line-height: 1.6;
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
  padding: 10px 0 10px 14px;
  border-left: 3px solid color-mix(in srgb, var(--c-surface2) 38%, var(--c-base) 62%);
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

.message-bubble {
  position: relative;
}

/* Inline editing */
.edit-inline {
  width: 100%;
}

.message-bubble.editing {
  max-width: 100%;
  background: transparent;
  padding: 0;
}

/* Hover action buttons */
.msg-actions {
  position: absolute;
  bottom: 0;
  right: 4px;
  display: flex;
  gap: 2px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s;
  z-index: 6;
  transform: translateY(100%);
  padding-top: 8px;
}

.message-bubble:hover .msg-actions,
.msg-actions:hover,
.message-bubble.editing .msg-actions {
  opacity: 1;
  pointer-events: auto;
}

.assistant .msg-actions {
  right: auto;
  left: 4px;
}

.msg-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--c-surface1);
  background: var(--c-base);
  color: var(--c-subtext0);
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
  padding: 0;
}

.msg-action-btn:hover {
  background: var(--c-surface-hover, var(--c-surface0));
  color: var(--c-text);
  border-color: var(--c-surface-hover, var(--c-overlay0));
}

.msg-action-btn.copied {
  color: var(--c-green, #40a02b);
  border-color: var(--c-green, #40a02b);
}


/* Plan card */
.plan-card {
  margin: 8px 0;
  border: 1px solid var(--c-surface2);
  border-radius: 8px;
  background: var(--c-mantle);
  overflow: hidden;
}

.plan-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--c-subtext0);
  border-bottom: 1px solid var(--c-surface0);
}

.plan-header svg {
  color: var(--c-blue);
  flex-shrink: 0;
}

.plan-progress {
  margin-left: auto;
  font-size: 11px;
  font-weight: 500;
  color: var(--c-overlay0);
}

.plan-steps {
  list-style: none;
  margin: 0;
  padding: 6px 0;
}

.plan-step {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 5px 12px;
  font-size: 13px;
  color: var(--c-overlay0);
  transition: color 0.2s;
}

.plan-step--completed {
  color: var(--c-overlay0);
}

.plan-step--completed .plan-step-text {
  text-decoration: line-through;
  text-decoration-color: var(--c-surface2);
}

.plan-step--in_progress {
  color: var(--c-text);
}

.plan-step-icon {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 1px;
}

.plan-step--completed .plan-step-icon svg {
  color: var(--c-green);
}

.plan-circle {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1.5px solid var(--c-surface2);
}

.plan-spinner {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid var(--c-surface1);
  border-top-color: var(--c-blue);
  animation: plan-spin 0.8s linear infinite;
}

@keyframes plan-spin {
  to { transform: rotate(360deg); }
}

.plan-step-text {
  line-height: 1.4;
}
</style>

