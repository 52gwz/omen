<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { marked } from 'marked'

const props = defineProps<{
  name: string
  arguments: string
  status: 'streaming' | 'pending' | 'confirmed' | 'rejected' | 'running' | 'completed' | 'error'
  result?: string
  streamOutput?: string
}>()

const emit = defineEmits<{
  confirm: []
  reject: []
  kill: []
}>()

const expanded = ref(
  (props.name === 'write_file' || props.name === 'edit_file')
  && props.status !== 'streaming' && props.status !== 'pending'
)
const userToggled = ref(false)
const elapsedSeconds = ref(0)
let elapsedTimer: ReturnType<typeof setInterval> | null = null

function startTimer() {
  stopTimer()
  elapsedSeconds.value = 0
  userToggled.value = false
  elapsedTimer = setInterval(() => {
    elapsedSeconds.value++
    if (elapsedSeconds.value >= 1 && !expanded.value && !userToggled.value) {
      expanded.value = true
    }
  }, 1000)
}

function stopTimer() {
  if (elapsedTimer) {
    clearInterval(elapsedTimer)
    elapsedTimer = null
  }
}

const elapsedDisplay = computed(() => {
  const s = elapsedSeconds.value
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m${s % 60}s`
})

watch(() => props.status, (s, prev) => {
  if (prev === 'streaming' && s !== 'streaming') {
    expanded.value = true
  }
  if (s === 'running') startTimer()
  if (s === 'completed' || s === 'error' || s === 'rejected') stopTimer()
}, { immediate: true })

onUnmounted(stopTimer)

// Shell-picker keyboard navigation
const pickerSelected = ref<'confirm' | 'reject'>('confirm')

function onPickerKey(e: KeyboardEvent) {
  if (props.status !== 'pending') return
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    pickerSelected.value = pickerSelected.value === 'confirm' ? 'reject' : 'confirm'
  } else if (e.key === 'Enter') {
    e.preventDefault()
    pickerSelected.value === 'confirm' ? emit('confirm') : emit('reject')
  }
}

watch(() => props.status, (s) => {
  if (s === 'pending') pickerSelected.value = 'confirm'
})

onMounted(() => window.addEventListener('keydown', onPickerKey))
onUnmounted(() => window.removeEventListener('keydown', onPickerKey))

const toolLabel: Record<string, string> = {
  exec_command: '执行命令',
  read_file: '读取文件',
  write_file: '写入文件',
  list_directory: '列出目录',
  grep_search: '搜索内容',
  edit_file: '编辑文件',
}

const displayName = computed(() => toolLabel[props.name] || props.name)

const argSummary = computed(() => {
  try {
    const obj = JSON.parse(props.arguments)
    if (props.name === 'exec_command' && obj.command) return obj.command
    if (props.name === 'read_file' && obj.path) return obj.path
    if (props.name === 'write_file' && obj.path) return obj.path
    if (props.name === 'edit_file' && obj.path) return obj.path
    if (props.name === 'list_directory') return obj.path || '.'
    if (props.name === 'grep_search' && obj.pattern) return obj.pattern
    const first = Object.values(obj)[0]
    return typeof first === 'string' ? first : JSON.stringify(first)
  } catch {
    const pathMatch = props.arguments.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    if (pathMatch) return pathMatch[1]
    const cmdMatch = props.arguments.match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    if (cmdMatch) return cmdMatch[1]
    return ''
  }
})

const parsedArgs = computed(() => {
  try {
    const obj = JSON.parse(props.arguments)
    return Object.entries(obj)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join('\n')
  } catch {
    return props.arguments
  }
})

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?(?:\x07|\x1b\\)/g, '')
}

function processCarriageReturns(text: string): string {
  return stripAnsi(text).split('\n').map(line => {
    if (!line.includes('\r')) return line
    const parts = line.split('\r')
    let result = ''
    for (const part of parts) {
      if (!part) continue
      if (part.length >= result.length) {
        result = part
      } else {
        result = part + result.slice(part.length)
      }
    }
    return result
  }).join('\n')
}

const displayResult = computed(() => {
  if (!props.result) return ''
  return processCarriageReturns(props.result)
})

const displayStreamOutput = computed(() => {
  if (!props.streamOutput) return ''
  return processCarriageReturns(props.streamOutput)
})

const streamOutputEl = ref<HTMLElement>()

watch(() => props.streamOutput, () => {
  nextTick(() => {
    if (streamOutputEl.value) {
      streamOutputEl.value.scrollTop = streamOutputEl.value.scrollHeight
    }
  })
})

const statusIcon = computed(() => {
  switch (props.status) {
    case 'streaming': return 'streaming'
    case 'pending': return 'pending'
    case 'running': return 'running'
    case 'completed': return 'completed'
    case 'rejected': return 'rejected'
    case 'error': return 'error'
    default: return 'completed'
  }
})

function renderMarkdown(raw: string): string {
  return marked.parse(raw, { async: false, breaks: true, gfm: true }) as string
}

const isExecCommand = computed(() => props.name === 'exec_command')
const isFileGenTool = computed(() => props.name === 'write_file' || props.name === 'edit_file')

function unescapePartialJson(s: string): string {
  let trimmed = s
  if (trimmed.endsWith('\\')) trimmed = trimmed.slice(0, -1)
  try {
    return JSON.parse('"' + trimmed + '"')
  } catch {
    return trimmed
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
}

const fileInfo = computed(() => {
  if (!isFileGenTool.value) return null
  const contentKey = props.name === 'edit_file' ? 'new_string' : 'content'
  try {
    const obj = JSON.parse(props.arguments)
    return { path: obj.path || null, content: obj[contentKey] ?? null }
  } catch {
    const args = props.arguments
    const pathMatch = args.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    const filePath = pathMatch ? pathMatch[1] : null
    const keyRegex = new RegExp(`"${contentKey}"\\s*:\\s*"`)
    const match = keyRegex.exec(args)
    if (!match) return { path: filePath, content: null }
    const rawContent = args.slice(match.index + match[0].length)
    return { path: filePath, content: unescapePartialJson(rawContent) }
  }
})

const fileLineCount = computed(() => {
  const content = fileInfo.value?.content
  if (!content) return 0
  return content.split('\n').length
})

const streamingCodeEl = ref<HTMLElement>()

watch(() => props.arguments, () => {
  if (props.status === 'streaming') {
    nextTick(() => {
      if (streamingCodeEl.value) {
        streamingCodeEl.value.scrollTop = streamingCodeEl.value.scrollHeight
      }
    })
  }
})

const execCmd = computed(() => {
  if (!isExecCommand.value) return ''
  try {
    return JSON.parse(props.arguments).command || ''
  } catch {
    return props.arguments
  }
})

const execExitCode = computed(() => {
  if (!props.result) return null
  const m = props.result.match(/\[exit code:\s*(\d+)\]/)
  return m ? Number(m[1]) : null
})

const execOutput = computed(() => {
  if (!props.result) return ''
  const cleaned = props.result
    .replace(/\n?\[exit code:\s*\d+\]\s*$/, '')
    .replace(/\n?\[timeout\].*$/, '')
    .replace(/\n?\[stopped\].*$/, '')
    .trim()
  return processCarriageReturns(cleaned)
})
</script>

<template>
  <div class="tool-line" :class="status">
    <div class="tool-header">
      <div class="tool-summary" @click="status !== 'pending' && (userToggled = true, expanded = !expanded)">
        <span class="tool-name">{{ displayName }}</span>
        <span class="arg-hint">{{ argSummary }}</span>
        <span v-if="elapsedSeconds > 0" class="elapsed-time">(已运行 {{ elapsedDisplay }})</span>
        <svg
          v-if="status !== 'pending'"
          class="chevron"
          :class="{ expanded }"
          width="12" height="12" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2.5"
          stroke-linecap="round" stroke-linejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>
    </div>

    <!-- Pending: shell-style picker -->
    <div v-if="status === 'pending'" class="shell-picker">
      <div
        class="picker-option confirm-option"
        :class="{ selected: pickerSelected === 'confirm' }"
        @click.stop="emit('confirm')"
      >
        <span class="picker-cursor">❯</span>
        <span class="picker-label">确认</span>
      </div>
      <div
        class="picker-option reject-option"
        :class="{ selected: pickerSelected === 'reject' }"
        @click.stop="emit('reject')"
      >
        <span class="picker-cursor">❯</span>
        <span class="picker-label">拒绝</span>
      </div>
    </div>

    <!-- File gen panel: streaming (always visible) -->
    <div v-if="isFileGenTool && status === 'streaming' && fileInfo" class="tool-detail">
      <div class="file-gen-panel">
        <div class="file-gen-header">
          <div class="file-gen-title">
            <svg class="file-gen-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <span class="file-gen-path">{{ fileInfo.path || '...' }}</span>
          </div>
          <span class="file-gen-badge">
            <span class="file-gen-dot"></span>
            {{ fileLineCount }} 行
          </span>
        </div>
        <div ref="streamingCodeEl" class="file-gen-body">
          <pre class="file-gen-code">{{ fileInfo.content || '' }}<span class="cursor-blink">▍</span></pre>
        </div>
      </div>
    </div>

    <!-- File gen panel: non-streaming (expandable) -->
    <Transition name="expand">
    <div v-show="expanded && isFileGenTool && status !== 'streaming'" class="tool-detail">
      <div class="file-gen-panel">
        <div class="file-gen-header">
          <div class="file-gen-title">
            <svg class="file-gen-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <span class="file-gen-path">{{ fileInfo?.path || '' }}</span>
          </div>
          <span class="file-gen-badge">{{ fileLineCount }} 行</span>
        </div>
        <div class="file-gen-body">
          <pre class="file-gen-code">{{ fileInfo?.content || '' }}</pre>
        </div>
        <div v-if="result && (status === 'completed' || status === 'error' || status === 'rejected')" class="file-gen-footer">
          <span class="file-gen-result" :class="result.startsWith('[error]') ? 'result-err' : 'result-ok'">
            {{ result.startsWith('[error]') ? result : '✓ ' + result }}
          </span>
        </div>
      </div>
    </div>
    </Transition>

    <!-- Streaming: other tools -->
    <div v-if="status === 'streaming' && !isFileGenTool" class="tool-detail">
      <div class="tool-args">
        <pre>{{ parsedArgs }}<span class="cursor-blink">▍</span></pre>
      </div>
    </div>

    <!-- exec_command: shell panel -->
    <Transition name="expand">
    <div v-show="expanded && isExecCommand && status !== 'streaming'" class="tool-detail">
      <div class="shell-panel">
        <div class="shell-header">
          <div class="shell-title">
            <svg class="shell-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            <span class="shell-label">shell</span>
          </div>
          <div class="shell-header-right"></div>
        </div>
        <div class="shell-body">
          <pre class="shell-cmd"><span class="shell-prompt">$ </span>{{ execCmd }}</pre>
          <div v-if="status === 'running' && streamOutput" ref="streamOutputEl" class="shell-output streaming">
            <pre>{{ displayStreamOutput }}</pre>
          </div>
          <div v-else-if="status === 'running'" class="shell-output"></div>
          <div v-else-if="result && (status === 'completed' || status === 'error' || status === 'rejected')" class="shell-output">
            <pre v-if="execOutput">{{ execOutput }}</pre>
            <span v-else class="shell-empty">无输出</span>
          </div>
        </div>
        <div v-if="status === 'running' || (execExitCode !== null && (status === 'completed' || status === 'error'))" class="shell-footer">
          <span v-if="execExitCode !== null && (status === 'completed' || status === 'error')"
                class="shell-exit-code" :class="execExitCode === 0 ? 'exit-ok' : 'exit-err'">
            exit {{ execExitCode }}
          </span>
          <button v-if="status === 'running'" class="shell-kill-btn" @click.stop="emit('kill'); expanded = false" title="终止命令">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
              <rect x="3" y="3" width="18" height="18" rx="2" />
            </svg>
            终止
          </button>
        </div>
      </div>
    </div>
    </Transition>

    <!-- Other tools: generic detail -->
    <Transition name="expand">
    <div v-show="expanded && !isExecCommand && !isFileGenTool && status !== 'streaming'" class="tool-detail">
      <div class="tool-args">
        <pre>{{ parsedArgs }}</pre>
      </div>

      <div v-if="status === 'running' && streamOutput" ref="streamOutputEl" class="stream-output-panel">
        <pre class="stream-output-content">{{ displayStreamOutput }}</pre>
      </div>

      <div v-if="result && (status === 'completed' || status === 'error' || status === 'rejected')" class="result-panel">
        <pre class="result-content">{{ displayResult }}</pre>
      </div>
    </div>
    </Transition>
  </div>
</template>

<style scoped>
.tool-line {
  border-radius: 8px;
  font-size: 0.82rem;
}

.tool-line.pending {
  border: 1px solid var(--c-surface2);
  border-radius: 12px;
  padding: 10px 12px;
}

.tool-header {
  display: flex;
  align-items: center;
  gap: 10px;
  width: fit-content;
  max-width: 100%;
  margin-bottom: 8px;
}

.tool-summary {
  display: flex;
  align-items: baseline;
  gap: 6px;
  cursor: pointer;
  user-select: none;
  min-width: 0;
  transition: color 0.15s;
}

.tool-summary:hover {
  color: var(--c-text);
}

.tool-summary:hover .tool-name {
  color: var(--c-text);
}

.tool-summary:hover .arg-hint {
  color: var(--c-subtext0);
}

.chevron {
  flex-shrink: 0;
  color: var(--c-overlay0);
  opacity: 0;
  transition: transform 0.2s ease, opacity 0.15s;
  align-self: center;
}

.tool-summary:hover .chevron,
.chevron.expanded {
  opacity: 1;
}

.chevron.expanded {
  transform: rotate(180deg);
}

.elapsed-time {
  flex-shrink: 0;
  font-size: 0.72rem;
  color: var(--c-overlay0);
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  white-space: nowrap;
}



.tool-name {
  flex-shrink: 0;
  font-weight: 600;
  color: var(--c-subtext1);
  white-space: nowrap;
}

.arg-hint {
  color: var(--c-overlay1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  font-size: 0.78rem;
}

.shell-picker {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  font-size: 0.8rem;
}

.picker-option {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 14px;
  border-radius: 999px;
  cursor: pointer;
  user-select: none;
  width: 100%;
  transition: background 0.12s;
}

.picker-cursor {
  font-size: 0.7rem;
  opacity: 0;
  transition: opacity 0.12s;
  color: var(--c-blue);
}

.confirm-option .picker-cursor { color: var(--c-blue); }
.reject-option  .picker-cursor { color: #ff5f57; }

.picker-option.selected,
.picker-option:hover {
  background: var(--c-surface0);
  border-radius: 999px;
}

.picker-option.selected .picker-cursor {
  opacity: 1;
}

.picker-label {
  font-weight: 500;
  color: var(--c-subtext1);
  transition: color 0.12s;
}

.confirm-option.selected .picker-label { color: var(--c-blue); }

.reject-option.selected .picker-label { color: #ff5f57; }


.expand-enter-active,
.expand-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
  transform-origin: top;
  overflow: hidden;
}

.expand-enter-from,
.expand-leave-to {
  opacity: 0;
  transform: scaleY(0.92) translateY(-4px);
}

.expand-enter-to,
.expand-leave-from {
  opacity: 1;
  transform: scaleY(1) translateY(0);
}

.tool-detail {
  padding: 0 0 6px 0;
}

.tool-args {
  background: var(--c-base);
  border-radius: 6px;
  padding: 6px 10px;
  margin-bottom: 4px;
}

.tool-args pre {
  margin: 0;
  font-size: 0.78rem;
  color: var(--c-subtext1);
  white-space: pre-wrap;
  word-break: break-all;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  line-height: 1.5;
}

.stream-output-panel {
  background: var(--c-base);
  border-radius: 6px;
  padding: 6px 10px;
  max-height: 200px;
  overflow-y: auto;
  margin-bottom: 4px;
}

.stream-output-content {
  margin: 0;
  font-size: 0.76rem;
  color: var(--c-subtext0);
  white-space: pre-wrap;
  word-break: break-all;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  line-height: 1.5;
}

.result-panel {
  background: var(--c-base);
  border-radius: 6px;
  padding: 6px 10px;
  max-height: 300px;
  overflow-y: auto;
}

.result-content {
  margin: 0;
  font-size: 0.76rem;
  color: var(--c-subtext0);
  white-space: pre-wrap;
  word-break: break-all;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  line-height: 1.5;
}

/* ---- File Generation Panel ---- */
.file-gen-panel {
  border-radius: 8px;
  overflow: hidden;
  background: #f4f4f5;
  border: 1px solid #e2e2e4;
  width: 580px;
  max-width: 100%;
}

.file-gen-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: #ebebed;
  border-bottom: 1px solid #dddde0;
}

.file-gen-title {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

.file-gen-icon {
  color: #888;
  flex-shrink: 0;
}

.file-gen-path {
  font-size: 0.71rem;
  color: #666;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-gen-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.68rem;
  color: #888;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  white-space: nowrap;
  flex-shrink: 0;
}

.file-gen-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #4caf7d;
  animation: pulse-dot 1.5s ease-in-out infinite;
}

@keyframes pulse-dot {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

.file-gen-body {
  padding: 10px 14px 12px;
  max-height: 350px;
  overflow-y: auto;
}

.file-gen-body::-webkit-scrollbar {
  width: 4px;
}
.file-gen-body::-webkit-scrollbar-track {
  background: transparent;
}
.file-gen-body::-webkit-scrollbar-thumb {
  background: #ccc;
  border-radius: 2px;
}

.file-gen-code {
  margin: 0;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  font-size: 0.78rem;
  color: #2c2c2e;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}

.file-gen-footer {
  display: flex;
  align-items: center;
  padding: 5px 12px 7px;
  background: #ebebed;
  border-top: 1px solid #dddde0;
}

.file-gen-result {
  font-size: 0.7rem;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
}

.file-gen-result.result-ok { color: #1e7e45; }
.file-gen-result.result-err { color: #e05c57; }

:root[data-theme="dark"] .file-gen-footer {
  background: #2a2a2c;
  border-top-color: #3a3a3c;
}

:root[data-theme="dark"] .file-gen-result.result-ok { color: #4caf7d; }
:root[data-theme="dark"] .file-gen-result.result-err { color: #c0534f; }

:root[data-theme="dark"] .file-gen-panel {
  background: #1e1e20;
  border-color: #3a3a3c;
}

:root[data-theme="dark"] .file-gen-header {
  background: #2a2a2c;
  border-bottom-color: #3a3a3c;
}

:root[data-theme="dark"] .file-gen-icon {
  color: #666;
}

:root[data-theme="dark"] .file-gen-path {
  color: #999;
}

:root[data-theme="dark"] .file-gen-badge {
  color: #666;
}

:root[data-theme="dark"] .file-gen-body::-webkit-scrollbar-thumb {
  background: #444;
}

:root[data-theme="dark"] .file-gen-code {
  color: #e0e0e0;
}

/* ---- Shell Panel ---- */
.shell-panel {
  border-radius: 8px;
  overflow: hidden;
  background: #f4f4f5;
  border: 1px solid #e2e2e4;
  width: 580px;
  max-width: 100%;
}

.shell-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: #ebebed;
  border-bottom: 1px solid #dddde0;
}

.shell-title {
  display: flex;
  align-items: center;
  gap: 5px;
}

.shell-icon {
  color: #888;
  flex-shrink: 0;
}

.shell-label {
  font-size: 0.71rem;
  color: #888;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  user-select: none;
  letter-spacing: 0.04em;
  font-weight: 500;
}

.shell-header-right {
  width: 0;
}

.shell-body {
  padding: 10px 14px 12px;
  max-height: 300px;
  overflow-y: auto;
}

.shell-body::-webkit-scrollbar {
  width: 4px;
}
.shell-body::-webkit-scrollbar-track {
  background: transparent;
}
.shell-body::-webkit-scrollbar-thumb {
  background: #ccc;
  border-radius: 2px;
}

.shell-cmd {
  margin: 0;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  font-size: 0.8rem;
  color: #2c2c2e;
  font-weight: 500;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}

.shell-prompt {
  color: #1e7e45;
  font-weight: 600;
}

.shell-output {
  margin-top: 4px;
}

.shell-output pre {
  margin: 0;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  font-size: 0.78rem;
  color: #555;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-all;
}

.shell-output.streaming {
  max-height: 180px;
  overflow-y: auto;
}

.shell-output.streaming::-webkit-scrollbar {
  width: 4px;
}
.shell-output.streaming::-webkit-scrollbar-thumb {
  background: #ccc;
  border-radius: 2px;
}

.shell-empty {
  color: #aaa;
  font-size: 0.78rem;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
}

.shell-cursor {
  color: #1e7e45;
  animation: blink 1s step-end infinite;
}

.shell-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 5px 10px 7px;
  background: #f4f4f5;
  min-height: 28px;
}

.shell-kill-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 9px;
  border-radius: 4px;
  border: 1px solid #e05c57;
  background: transparent;
  color: #e05c57;
  font-size: 0.7rem;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  user-select: none;
}

.shell-kill-btn:hover {
  background: #e05c57;
  color: #fff;
}

.shell-exit-code {
  font-size: 0.7rem;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
}

.shell-exit-code.exit-ok   { color: #1e7e45; }
.shell-exit-code.exit-err  { color: #e05c57; }

:root[data-theme="dark"] .shell-panel {
  background: #1e1e20;
  border-color: #3a3a3c;
}

:root[data-theme="dark"] .shell-header {
  background: #2a2a2c;
  border-bottom-color: #3a3a3c;
}

:root[data-theme="dark"] .shell-icon {
  color: #666;
}

:root[data-theme="dark"] .shell-label {
  color: #666;
}

:root[data-theme="dark"] .shell-body::-webkit-scrollbar-thumb {
  background: #444;
}

:root[data-theme="dark"] .shell-cmd {
  color: #e0e0e0;
}

:root[data-theme="dark"] .shell-prompt {
  color: #4caf7d;
}

:root[data-theme="dark"] .shell-output pre {
  color: #999;
}

:root[data-theme="dark"] .shell-output.streaming::-webkit-scrollbar-thumb {
  background: #444;
}

:root[data-theme="dark"] .shell-empty {
  color: #555;
}

:root[data-theme="dark"] .shell-cursor {
  color: #4caf7d;
}

:root[data-theme="dark"] .shell-footer {
  background: #1e1e20;
}

:root[data-theme="dark"] .shell-kill-btn {
  border-color: #c0534f;
  color: #c0534f;
}

:root[data-theme="dark"] .shell-kill-btn:hover {
  background: #c0534f;
  color: #fff;
}

:root[data-theme="dark"] .shell-exit-code.exit-ok  { color: #4caf7d; }
:root[data-theme="dark"] .shell-exit-code.exit-err { color: #c0534f; }

.cursor-blink {
  animation: blink 1s step-end infinite;
  color: #4caf7d;
}

@keyframes blink {
  50% { opacity: 0; }
}
</style>
