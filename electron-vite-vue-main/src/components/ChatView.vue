<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, nextTick, computed, watch } from 'vue'
import { marked } from 'marked'
import ToolCallCard from './ToolCallCard.vue'

marked.setOptions({
  breaks: true,
  gfm: true,
})

const props = defineProps<{
  conversationId: string
}>()

const emit = defineEmits<{
  streamingChange: [streaming: boolean]
}>()

interface ToolCallInfo {
  id: string
  name: string
  arguments: string
  status: 'pending' | 'confirmed' | 'rejected' | 'running' | 'completed' | 'error'
  result?: string
  screenshot?: string
  streamOutput?: string
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  reasoningExpanded?: boolean
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
const errorMsg = ref('')
const chatMode = ref<ChatMode>('agent')
const modeDropdownOpen = ref(false)

const messagesContainer = ref<HTMLElement>()
const inputEl = ref<HTMLTextAreaElement>()
const modeDropdownRef = ref<HTMLElement>()

let currentRequestId = ''
let saveTimer: ReturnType<typeof setTimeout> | null = null

const canSend = computed(() => inputText.value.trim() && !isStreaming.value && !!currentModel.value)

const agentCwd = ref('~')

async function loadConfig() {
  try {
    const config = await window.aiChat.getConfig()
    currentModel.value = config.defaultModel || ''
  } catch {}
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
    messages.push({ role: m.role as 'user' | 'assistant', content: m.content })
  }
  scrollToBottom(true)
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const toSave = messages.map((m) => ({ role: m.role, content: m.content }))
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

  const historyMessages = messages.slice(0, -1).map((m) => ({
    role: m.role,
    content: m.content,
  }))

  window.aiChat.startStream({ requestId, model: currentModel.value, messages: historyMessages })

  const assistantIdx = messages.length - 1

  const offReasoning = window.aiChat.onStreamReasoning(({ requestId: rid, delta }) => {
    if (rid !== requestId) return
    messages[assistantIdx].reasoning = (messages[assistantIdx].reasoning || '') + delta
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

  const historyMessages = messages.slice(0, -1).map((m) => ({
    role: m.role,
    content: m.content,
  }))

  window.agentChat.start({ requestId, model: currentModel.value, messages: historyMessages, cwd: agentCwd.value })

  const offReasoning = window.agentChat.onStreamReasoning(({ requestId: rid, delta }) => {
    if (rid !== requestId) return
    const msg = getLastAssistant()
    if (msg) {
      msg.reasoning = (msg.reasoning || '') + delta
      scrollToBottom()
    }
  })

  const offChunk = window.agentChat.onStreamChunk(({ requestId: rid, delta }) => {
    if (rid !== requestId) return
    const msg = getLastAssistant()
    if (msg) {
      msg.content += delta
      scrollToBottom()
    }
  })

  const offToolPending = window.agentChat.onToolPending(({ requestId: rid, toolCallId, name, arguments: args, autoApprove }) => {
    if (rid !== requestId) return
    const msg = getLastAssistant()
    if (msg) {
      if (!msg.toolCalls) msg.toolCalls = []
      msg.toolCalls.push({ id: toolCallId, name, arguments: args, status: autoApprove ? 'running' : 'pending' })
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

  const offToolResult = window.agentChat.onToolResult(({ requestId: rid, toolCallId, result, rejected, screenshot }) => {
    if (rid !== requestId) return
    const msg = getLastAssistant()
    const tc = msg?.toolCalls?.find((t) => t.id === toolCallId)
    if (tc) {
      tc.status = rejected ? 'rejected' : 'completed'
      tc.result = result
      tc.streamOutput = undefined
      if (screenshot) tc.screenshot = screenshot
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
  if (!text || isStreaming.value) return

  errorMsg.value = ''

  // Auto-rename conversation with first user message
  const isFirstMessage = messages.length === 0
  messages.push({ role: 'user', content: text })
  if (isFirstMessage && props.conversationId) {
    const title = text.length > 30 ? text.slice(0, 30) + '...' : text
    window.conversationApi.rename(props.conversationId, title)
  }

  inputText.value = ''
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
  inputEl.value?.focus()
}

function handleClickOutside(e: MouseEvent) {
  if (modeDropdownRef.value && !modeDropdownRef.value.contains(e.target as Node)) {
    modeDropdownOpen.value = false
  }
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
  loadMessages()
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

defineExpose({ loadConfig })
</script>

<template>
  <div class="chat-container">
    <!-- 顶栏 -->
    <div class="chat-topbar">
      <span class="current-model">{{ currentModel || '未配置模型' }}</span>
      <button v-if="chatMode === 'agent'" class="cwd-btn" :title="agentCwd" @click="changeCwd">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        {{ cwdDisplay }}
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
          <!-- Reasoning -->
          <div v-if="msg.reasoning" class="chat-reasoning">
            <button class="reasoning-toggle" @click="msg.reasoningExpanded = !msg.reasoningExpanded">
              显示思路
              <svg
                class="reasoning-chevron"
                :class="{ expanded: msg.reasoningExpanded }"
                width="14" height="14" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" stroke-width="2.5"
                stroke-linecap="round" stroke-linejoin="round"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            <div v-if="msg.reasoningExpanded" class="reasoning-panel">
              <div class="reasoning-content" v-html="renderReasoning(msg.reasoning)"></div>
            </div>
          </div>

          <!-- Text content (before tool calls) -->
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
              :screenshot="tc.screenshot"
              :stream-output="tc.streamOutput"
              @confirm="confirmTool(tc.id)"
              @reject="rejectTool(tc.id)"
            />
          </template>

          <!-- Streaming cursor -->
          <span v-if="msg.role === 'assistant' && isStreaming && i === messages.length - 1 && !msg.toolCalls?.some(t => t.status === 'pending')" class="cursor-blink">▍</span>
        </div>
      </div>
    </div>

    <!-- 错误提示 -->
    <div v-if="errorMsg" class="error-bar">
      {{ errorMsg }}
      <button @click="errorMsg = ''">✕</button>
    </div>

    <!-- 输入区 -->
    <div class="input-area">
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
        <textarea
          ref="inputEl"
          v-model="inputText"
          class="chat-input"
          rows="1"
          :placeholder="chatMode === 'agent' ? 'Agent 模式：描述任务...' : '输入消息... (Shift+Enter 换行)'"
          @keydown="handleKeydown"
          @input="autoResize"
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
  </div>
</template>

<style scoped>
.chat-container {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--c-base);
  color: var(--c-text);
}

.chat-topbar {
  display: flex;
  align-items: center;
  padding: 12px 56px 12px 16px;
  border-bottom: 1px solid var(--c-surface0);
  gap: 8px;
  min-height: 46px;
  -webkit-app-region: drag;
}

.current-model {
  -webkit-app-region: no-drag;
  font-size: 0.82rem;
  color: var(--c-overlay1);
  user-select: none;
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
  padding: 16px 16px 80px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--c-overlay0);
  font-size: 1.1rem;
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

.message-bubble {
  max-width: 75%;
  padding: 10px 14px;
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
}

.assistant .message-bubble {
  background: var(--c-surface0);
  color: var(--c-text);
  border-bottom-left-radius: 4px;
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
  margin-bottom: 10px;
}

.reasoning-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  color: var(--c-overlay1);
  font-size: 0.82rem;
  cursor: pointer;
  padding: 0;
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

.reasoning-panel {
  margin-top: 8px;
  padding: 14px 16px;
  background: var(--c-surface-alt);
  border-radius: 10px;
  border-left: 3px solid var(--c-surface2);
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
</style>
