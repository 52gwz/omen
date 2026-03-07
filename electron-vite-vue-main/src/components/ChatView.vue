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
const debugMode = ref(true)
const debugPanelOpen = ref(false)
const debugSelectedMsg = ref<number | null>(null)
const debugCopied = ref(false)

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
    const msg: ChatMessage = {
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }
    if (m.reasoning) msg.reasoning = m.reasoning
    if (m.toolCalls?.length) {
      msg.toolCalls = m.toolCalls.map((tc: any) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
        status: tc.status as ToolCallInfo['status'],
        result: tc.result,
        screenshot: tc.screenshot,
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
      if (m.toolCalls?.length) {
        stored.toolCalls = m.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          status: tc.status,
          result: tc.result,
          screenshot: tc.screenshot,
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
  inputEl.value?.focus()
}

function handleClickOutside(e: MouseEvent) {
  if (modeDropdownRef.value && !modeDropdownRef.value.contains(e.target as Node)) {
    modeDropdownOpen.value = false
  }
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

function loadTestConversation() {
  messages.length = 0

  // 1. 用户简单消息
  messages.push({ role: 'user', content: '你好，帮我介绍一下这个项目' })

  // 2. 助手回复：包含丰富 Markdown
  messages.push({
    role: 'assistant',
    content: `## 项目概述

这是一个基于 **Electron + Vue 3** 的桌面 AI 助手应用，支持多种功能：

### 主要特性

1. **聊天模式** — 普通对话，支持 Markdown 渲染
2. **Agent 模式** — 可调用工具完成编程任务
3. *流式输出* — 实时显示生成内容

### 代码示例

\`\`\`typescript
const app = createApp(App)
app.mount('#app')
\`\`\`

行内代码：使用 \`ref()\` 创建响应式变量。

### 表格

| 功能 | 状态 | 说明 |
|------|------|------|
| 聊天 | 已完成 | 基础对话 |
| Agent | 已完成 | 工具调用 |
| 浏览器 | 开发中 | 自动化 |

> 这是一段引用文字，通常用来强调关键信息。

---

更多信息请参考 [GitHub](https://github.com)。`,
    reasoning: '用户想了解项目，我需要全面介绍项目的功能和技术栈。\n\n**分析要点：**\n\n需要涵盖以下内容：\n1. 技术架构\n2. 核心功能\n3. 使用示例',
    reasoningExpanded: false,
  })

  // 3. 用户追问
  messages.push({ role: 'user', content: '帮我看一下当前目录的文件结构，然后读取 package.json' })

  // 4. 助手回复 + 已完成的工具调用 (exec_command + read_file)
  messages.push({
    role: 'assistant',
    content: '我来查看一下项目结构。',
    toolCalls: [
      {
        id: 'tc-1',
        name: 'exec_command',
        arguments: JSON.stringify({ command: 'ls -la' }),
        status: 'completed',
        result: 'total 48\ndrwxr-xr-x  12 user  staff   384 Mar  7 10:00 .\ndrwxr-xr-x   5 user  staff   160 Mar  6 09:00 ..\n-rw-r--r--   1 user  staff   220 Mar  7 10:00 package.json\n-rw-r--r--   1 user  staff  1200 Mar  6 15:00 tsconfig.json\ndrwxr-xr-x   8 user  staff   256 Mar  7 09:00 src\ndrwxr-xr-x   4 user  staff   128 Mar  6 12:00 electron\n[exit code: 0]',
      },
      {
        id: 'tc-2',
        name: 'read_file',
        arguments: JSON.stringify({ path: 'package.json' }),
        status: 'completed',
        result: '{\n  "name": "dot-app",\n  "version": "0.1.0",\n  "main": "electron/main/index.ts",\n  "scripts": {\n    "dev": "vite",\n    "build": "vue-tsc && vite build"\n  }\n}',
      },
    ],
  })

  // 5. 助手继续解释 (模拟 new turn)
  messages.push({
    role: 'assistant',
    content: '项目结构很清晰，这是一个标准的 Electron + Vue 项目。`package.json` 中定义了基础的 dev 和 build 脚本。',
  })

  // 6. 用户请求写文件
  messages.push({ role: 'user', content: '在 src 目录下创建一个 utils.ts 工具文件' })

  // 7. 助手回复 + 写文件工具（pending 状态，等待确认）
  messages.push({
    role: 'assistant',
    content: '我来创建这个工具文件。',
    toolCalls: [
      {
        id: 'tc-3',
        name: 'write_file',
        arguments: JSON.stringify({
          path: 'src/utils.ts',
          content: 'export function formatDate(d: Date): string {\n  return d.toLocaleDateString()\n}\n\nexport function sleep(ms: number) {\n  return new Promise(r => setTimeout(r, ms))\n}',
        }),
        status: 'pending',
      },
    ],
  })

  // 8. 用户另一个请求
  messages.push({ role: 'user', content: '运行一下测试命令，另外搜索一下代码中的 TODO' })

  // 9. 助手回复 + running 工具 + 已被拒绝的工具 + error 工具
  messages.push({
    role: 'assistant',
    content: '',
    toolCalls: [
      {
        id: 'tc-4',
        name: 'exec_command',
        arguments: JSON.stringify({ command: 'npm test' }),
        status: 'running',
        streamOutput: '> dot-app@0.1.0 test\n> vitest run\n\n RUN  v1.3.0\n\n ✓ src/utils.test.ts (2 tests) 12ms\n   ✓ formatDate returns correct format\n   ✓ sleep waits for specified time\n\n Running remaining tests...',
      },
      {
        id: 'tc-5',
        name: 'grep_search',
        arguments: JSON.stringify({ pattern: 'TODO', path: 'src/' }),
        status: 'rejected',
        result: '用户拒绝了此操作',
      },
      {
        id: 'tc-6',
        name: 'list_directory',
        arguments: JSON.stringify({ path: '/nonexistent' }),
        status: 'error',
        result: 'Error: ENOENT: no such file or directory, scandir \'/nonexistent\'',
      },
    ],
  })

  // 10. 用户发送多行消息
  messages.push({
    role: 'user',
    content: '请帮我：\n1. 修复上面的错误\n2. 重新搜索 TODO\n3. 给项目加个 README',
  })

  // 11. 助手纯文本简短回复
  messages.push({
    role: 'assistant',
    content: '好的，我来逐一处理这些任务。',
  })

  scrollToBottom(true)
}

defineExpose({ loadConfig, loadTestConversation })
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
        <button class="test-conv-btn" @click="loadTestConversation">加载测试对话</button>
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
              @kill="killCommand(tc.id)"
            />
          </template>

          <!-- Streaming cursor -->
          <span v-if="msg.role === 'assistant' && isStreaming && i === messages.length - 1 && !msg.toolCalls?.some(t => t.status === 'pending' || t.status === 'running')" class="cursor-blink">▍</span>
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

.test-conv-btn {
  background: var(--c-surface0);
  border: 1px solid var(--c-surface1);
  border-radius: 8px;
  padding: 6px 16px;
  color: var(--c-overlay1);
  font-size: 0.78rem;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.2s, color 0.2s, border-color 0.2s;
}

.test-conv-btn:hover {
  background: var(--c-surface-hover);
  color: var(--c-subtext1);
  border-color: var(--c-surface2);
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
