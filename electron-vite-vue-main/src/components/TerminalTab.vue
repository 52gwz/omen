<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{
  terminalId: string
  cwd?: string
  active?: boolean
  dragActive?: boolean
}>()

const terminalEl = ref<HTMLElement | null>(null)
const currentCwd = ref('')
const exited = ref(false)
const startError = ref('')

type TerminalSession = {
  id: string
  xterm: Terminal
  fitAddon: FitAddon
  hostEl: HTMLDivElement
  cwd: string
  exited: boolean
  startError: string
  started: boolean
  cleanup: Array<() => void>
}

const terminalSessions = new Map<string, TerminalSession>()

function createTerminalSession(id: string): TerminalSession {
  const xterm = new Terminal({
    cursorBlink: true,
    // Keep CJK fonts strictly monospaced; proportional fonts cause large spacing in terminals.
    fontFamily: '"Sarasa Mono SC", "Noto Sans Mono CJK SC", "Source Han Mono SC", "SF Mono", "Menlo", "Consolas", "Monaco", monospace',
    fontSize: 13,
    lineHeight: 1.25,
    scrollback: 5000,
    theme: {
      background: '#111318',
    },
  })
  const fitAddon = new FitAddon()
  xterm.loadAddon(fitAddon)

  const hostEl = document.createElement('div')
  hostEl.className = 'terminal-host'
  xterm.open(hostEl)

  const session: TerminalSession = {
    id,
    xterm,
    fitAddon,
    hostEl,
    cwd: '',
    exited: false,
    startError: '',
    started: false,
    cleanup: [],
  }

  const offData = window.terminalApi.onData((data) => {
    if (data.id === id) {
      session.xterm.write(data.chunk)
    }
  })

  const offExit = window.terminalApi.onExit((data) => {
    if (data.id !== id) return
    session.exited = true
    session.xterm.writeln(`\r\n[process exited: ${data.exitCode}]`)
    if (!document.body.contains(session.hostEl)) {
      session.xterm.dispose()
      terminalSessions.delete(id)
    }
  })

  session.xterm.onData((data) => {
    void window.terminalApi.write(id, data)
  })

  session.cleanup.push(offData, offExit)
  terminalSessions.set(id, session)
  return session
}

function getTerminalSession(id: string) {
  return terminalSessions.get(id) || createTerminalSession(id)
}

const session = getTerminalSession(props.terminalId)
let resizeObserver: ResizeObserver | null = null

function syncSessionState() {
  currentCwd.value = session.cwd
  exited.value = session.exited
  startError.value = session.startError
}

function focusTerminal() {
  if (!props.active) return
  session.xterm.focus()
}

function safeFit() {
  if (!terminalEl.value || !props.active) return
  if (terminalEl.value.clientWidth <= 0 || terminalEl.value.clientHeight <= 0) return
  session.fitAddon.fit()
  void window.terminalApi.resize(props.terminalId, session.xterm.cols, session.xterm.rows)
}

async function startSession() {
  if (session.started) {
    syncSessionState()
    return
  }
  try {
    const result = await window.terminalApi.start({
      id: props.terminalId,
      cwd: props.cwd,
      cols: session.xterm.cols,
      rows: session.xterm.rows,
    })
    session.cwd = result.cwd
    session.startError = ''
    session.started = true
    if (result.history) {
      session.xterm.reset()
      session.xterm.write(result.history)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    session.startError = message
    session.xterm.writeln(`\r\n[terminal start failed] ${message}`)
  }
  syncSessionState()
}

onMounted(async () => {
  if (!terminalEl.value) return
  terminalEl.value.addEventListener('mousedown', focusTerminal)
  terminalEl.value.appendChild(session.hostEl)
  syncSessionState()

  await nextTick()
  safeFit()
  focusTerminal()
  await startSession()

  resizeObserver = new ResizeObserver(() => safeFit())
  resizeObserver.observe(terminalEl.value)
})

watch(() => props.active, (active) => {
  if (active) {
    nextTick(() => {
      safeFit()
      focusTerminal()
    })
  }
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  terminalEl.value?.removeEventListener('mousedown', focusTerminal)
  session.hostEl.remove()
  if (session.exited) {
    session.cleanup.forEach(fn => fn())
    session.xterm.dispose()
    terminalSessions.delete(props.terminalId)
  }
})
</script>

<template>
  <div class="terminal-tab">
    <div
      ref="terminalEl"
      class="terminal-surface"
      :class="{ 'no-pointer': dragActive }"
    />
    <div v-if="startError" class="terminal-error-banner">{{ startError }}</div>
    <div v-if="dragActive" class="terminal-shield"></div>
  </div>
</template>

<style scoped>
.terminal-tab {
  position: relative;
  width: 100%;
  height: 100%;
  background: #111318;
}

.terminal-surface {
  width: 100%;
  height: 100%;
  padding: 8px;
}

.terminal-surface:deep(.terminal-host) {
  width: 100%;
  height: 100%;
}

.terminal-surface:deep(.xterm) {
  height: 100%;
}

.terminal-surface:deep(.xterm-viewport) {
  overflow-y: auto;
}

.terminal-surface.no-pointer {
  pointer-events: none;
}

.terminal-error-banner {
  position: absolute;
  left: 12px;
  right: 12px;
  top: 12px;
  z-index: 5;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(127, 29, 29, 0.92);
  color: #fecaca;
  font-size: 12px;
  line-height: 1.4;
}

.terminal-shield {
  position: absolute;
  inset: 0;
  z-index: 10;
}
</style>
