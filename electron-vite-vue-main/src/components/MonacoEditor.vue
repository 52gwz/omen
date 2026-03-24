<script lang="ts">
const viewModeCache = new Map<string, 'edit' | 'preview' | 'mindmap'>()
</script>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, shallowRef, inject } from 'vue'
import * as monaco from 'monaco-editor'
import { marked } from 'marked'
import MindMapView from './MindMapView.vue'
import SimpleMindMapView from './SimpleMindMapView.vue'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { useTheme } from '../composables/useTheme'
import type { CodeReference } from '../types/workspace'

self.MonacoEnvironment = {
  getWorker(_: string, label: string) {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  },
}

const props = defineProps<{
  filePath: string
}>()

const addCodeReference = inject<(ref: CodeReference) => void>('addCodeReference')
const fileHighlights = inject<Map<string, { ranges: { startLine: number; endLine: number }[]; deletions: { afterLine: number; count: number; lines: string[] }[] }>>('fileHighlights', new Map())

const { theme } = useTheme()
const editorContainer = ref<HTMLDivElement>()
const editor = shallowRef<monaco.editor.IStandaloneCodeEditor>()
const loading = ref(true)
const error = ref('')
const modified = ref(false)
const saving = ref(false)
const diskStale = ref(false)
let resolvedWatchKey = ''
let suppressExternalReloadUntil = 0
let externalReloadTimer: ReturnType<typeof setTimeout> | null = null
let offFileChanged: (() => void) | null = null
const viewMode = ref<'edit' | 'preview' | 'mindmap'>(viewModeCache.get(props.filePath) || 'edit')
const rawContent = ref('')
const showSelectionToolbar = ref(false)
const toolbarPos = ref({ top: 0, left: 0 })
let highlightDecorationIds: string[] = []
let deletionViewZoneIds: string[] = []

const toolbarStyle = computed(() => ({
  top: `${toolbarPos.value.top}px`,
  left: `${toolbarPos.value.left}px`,
}))

function addSelectionToChat() {
  if (!editor.value || !addCodeReference) return
  const selection = editor.value.getSelection()
  if (!selection || selection.isEmpty()) return
  const model = editor.value.getModel()
  const selectedText = model?.getValueInRange(selection)
  if (!selectedText) return
  addCodeReference({
    filePath: props.filePath,
    text: selectedText,
    startLine: selection.startLineNumber,
    endLine: selection.endLineNumber,
    language: getLang(props.filePath),
  })
  showSelectionToolbar.value = false
}

function updateToolbarPosition() {
  if (!editor.value) return
  const selection = editor.value.getSelection()
  if (!selection || selection.isEmpty()) {
    showSelectionToolbar.value = false
    return
  }
  const endPos = selection.getEndPosition()
  const visiblePos = editor.value.getScrolledVisiblePosition(endPos)
  if (!visiblePos) {
    showSelectionToolbar.value = false
    return
  }
  toolbarPos.value = {
    top: visiblePos.top + visiblePos.height + 6,
    left: Math.max(8, visiblePos.left),
  }
  showSelectionToolbar.value = true
}

const isMarkdown = computed(() => {
  const ext = props.filePath.split('.').pop()?.toLowerCase()
  return ext === 'md' || ext === 'markdown'
})

const isJson = computed(() => {
  const ext = props.filePath.split('.').pop()?.toLowerCase()
  return ext === 'json'
})

const renderedHtml = computed(() => {
  if (!isMarkdown.value || viewMode.value !== 'preview') return ''
  return marked.parse(rawContent.value, { async: false }) as string
})

function switchMode(mode: 'edit' | 'preview' | 'mindmap') {
  if (viewMode.value === mode) return
  if (viewMode.value === 'edit' && editor.value) {
    rawContent.value = editor.value.getValue()
  }
  viewMode.value = mode
  if (mode === 'edit') {
    if (editor.value) {
      const model = editor.value.getModel()
      if (model && model.getValue() !== rawContent.value) {
        model.setValue(rawContent.value)
      }
    }
    requestAnimationFrame(() => editor.value?.layout())
  }
}

function onMindMapContentUpdate(newContent: string) {
  rawContent.value = newContent
  modified.value = true
}

const EXT_LANG_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  json: 'json', html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  vue: 'html', svelte: 'html', md: 'markdown', py: 'python', rb: 'ruby',
  rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', xml: 'xml', svg: 'xml',
  sql: 'sql', graphql: 'graphql', dockerfile: 'dockerfile',
  makefile: 'makefile', lua: 'lua', php: 'php', r: 'r',
}

function getLang(fp: string): string {
  const name = fp.split('/').pop()?.toLowerCase() || ''
  if (name === 'dockerfile') return 'dockerfile'
  if (name === 'makefile') return 'makefile'
  const ext = name.split('.').pop() || ''
  return EXT_LANG_MAP[ext] || 'plaintext'
}

monaco.editor.defineTheme('dot-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#181818',
  },
})

function getMonacoTheme(t: string) {
  return t === 'dark' ? 'dot-dark' : 'vs'
}

async function loadFile(opts?: { silent?: boolean }) {
  const silent = opts?.silent ?? false
  if (!silent) loading.value = true
  error.value = ''
  if (!silent) modified.value = false

  const result = await window.fsApi.readFile(props.filePath)
  loading.value = false

  if (result.error) {
    error.value = result.error
    return
  }

  rawContent.value = result.content
  diskStale.value = false
  if (editor.value) {
    const model = editor.value.getModel()
    if (model) {
      model.setValue(result.content)
      monaco.editor.setModelLanguage(model, getLang(props.filePath))
    }
    modified.value = false
    updateHighlightDecorations()
  }
}

async function saveFile() {
  if (saving.value) return
  saving.value = true
  const content = viewMode.value === 'edit' && editor.value
    ? editor.value.getValue()
    : rawContent.value
  const result = await window.fsApi.writeFile(props.filePath, content)
  saving.value = false
  if (result.error) {
    error.value = result.error
  } else {
    modified.value = false
    diskStale.value = false
    suppressExternalReloadUntil = Date.now() + 600
  }
}

function clearExternalReloadTimer() {
  if (externalReloadTimer) {
    clearTimeout(externalReloadTimer)
    externalReloadTimer = null
  }
}

function scheduleExternalReload() {
  clearExternalReloadTimer()
  externalReloadTimer = setTimeout(() => {
    externalReloadTimer = null
    if (Date.now() < suppressExternalReloadUntil) return
    if (modified.value) {
      diskStale.value = true
      return
    }
    void loadFile({ silent: true })
  }, 200)
}

async function reloadFromDisk() {
  diskStale.value = false
  await loadFile()
}

function dismissDiskStale() {
  diskStale.value = false
}

watch(viewMode, (mode) => {
  viewModeCache.set(props.filePath, mode)
})

watch(() => props.filePath, async (newPath, oldPath) => {
  viewMode.value = viewModeCache.get(newPath) || 'edit'
  clearExternalReloadTimer()
  if (oldPath) await window.fsApi.unwatchFile(oldPath)
  const wr = await window.fsApi.watchFile(newPath)
  resolvedWatchKey = 'resolvedPath' in wr ? wr.resolvedPath : ''
  await loadFile()
})

watch(theme, (t) => {
  monaco.editor.setTheme(getMonacoTheme(t))
})

onMounted(() => {
  document.addEventListener('keydown', handleGlobalKeydown)
  if (!editorContainer.value) return

  editor.value = monaco.editor.create(editorContainer.value, {
    value: '',
    language: 'plaintext',
    theme: getMonacoTheme(theme.value),
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    lineHeight: 20,
    padding: { top: 8 },
    scrollBeyondLastLine: false,
    wordWrap: 'on',
    renderLineHighlight: 'line',
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on',
    bracketPairColorization: { enabled: true },
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, 'Courier New', monospace",
    fontLigatures: true,
  })

  editor.value.onDidChangeModelContent(() => {
    modified.value = true
    if (isMarkdown.value || isJson.value) rawContent.value = editor.value!.getValue()
  })

  editor.value.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    saveFile()
  })

  offFileChanged = window.fsApi.onFileChanged((data) => {
    if (data.filePath !== resolvedWatchKey) return
    scheduleExternalReload()
  })

  void (async () => {
    const wr = await window.fsApi.watchFile(props.filePath)
    if ('resolvedPath' in wr) resolvedWatchKey = wr.resolvedPath
    else resolvedWatchKey = ''
    await loadFile()
  })()

  editor.value.addAction({
    id: 'add-to-chat-reference',
    label: '引用到对话',
    contextMenuGroupId: '9_cutcopypaste',
    contextMenuOrder: 99,
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyL],
    precondition: 'editorHasSelection',
    run: (ed) => {
      const selection = ed.getSelection()
      if (!selection) return
      const model = ed.getModel()
      const selectedText = model?.getValueInRange(selection)
      if (!selectedText || !addCodeReference) return
      addCodeReference({
        filePath: props.filePath,
        text: selectedText,
        startLine: selection.startLineNumber,
        endLine: selection.endLineNumber,
        language: getLang(props.filePath),
      })
    },
  })
})

function clearDeletionViewZones() {
  if (!editor.value || !deletionViewZoneIds.length) return
  editor.value.changeViewZones(accessor => {
    for (const id of deletionViewZoneIds) {
      accessor.removeZone(id)
    }
  })
  deletionViewZoneIds = []
}

function updateHighlightDecorations() {
  if (!editor.value) return
  const highlight = fileHighlights.get(props.filePath)

  clearDeletionViewZones()

  if (!highlight || (!highlight.ranges.length && !highlight.deletions.length)) {
    highlightDecorationIds = editor.value.deltaDecorations(highlightDecorationIds, [])
    return
  }

  const decorations: monaco.editor.IModelDeltaDecoration[] = []

  for (const r of highlight.ranges) {
    decorations.push({
      range: new monaco.Range(r.startLine, 1, r.endLine, 1),
      options: {
        isWholeLine: true,
        className: 'agent-changed-line',
        overviewRuler: {
          color: 'rgba(64, 160, 43, 0.6)',
          position: monaco.editor.OverviewRulerLane.Left,
        },
        minimap: { color: 'rgba(64, 160, 43, 0.4)', position: monaco.editor.MinimapPosition.Inline },
      },
    })
  }

  for (const d of highlight.deletions) {
    const line = Math.max(1, d.afterLine)
    decorations.push({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        className: 'agent-deleted-line-marker',
        overviewRuler: {
          color: 'rgba(210, 15, 57, 0.6)',
          position: monaco.editor.OverviewRulerLane.Left,
        },
      },
    })
  }

  highlightDecorationIds = editor.value.deltaDecorations(highlightDecorationIds, decorations)

  const ed = editor.value
  ed.changeViewZones(accessor => {
    for (const d of highlight.deletions) {
      if (!d.lines.length) continue
      const domNode = document.createElement('div')
      domNode.className = 'agent-deleted-viewzone'
      for (const lineText of d.lines) {
        const lineEl = document.createElement('div')
        lineEl.className = 'agent-deleted-viewzone-line'
        lineEl.textContent = lineText || ' '
        domNode.appendChild(lineEl)
      }
      const zoneId = accessor.addZone({
        afterLineNumber: d.afterLine,
        heightInLines: d.lines.length,
        domNode,
      })
      deletionViewZoneIds.push(zoneId)
    }
  })
}

watch(
  () => fileHighlights.get(props.filePath),
  () => updateHighlightDecorations(),
  { deep: true },
)

watch(() => props.filePath, () => {
  clearDeletionViewZones()
  highlightDecorationIds = []
  updateHighlightDecorations()
})

function handleGlobalKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 's' && viewMode.value !== 'edit') {
    e.preventDefault()
    saveFile()
  }
}

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleGlobalKeydown)
  clearDeletionViewZones()
  clearExternalReloadTimer()
  if (offFileChanged) {
    offFileChanged()
    offFileChanged = null
  }
  void window.fsApi.unwatchFile(props.filePath)
  editor.value?.dispose()
})
</script>

<template>
  <div class="editor-panel">
    <div v-if="diskStale" class="editor-disk-stale">
      <span>磁盘上的文件已更新</span>
      <button type="button" class="editor-disk-stale-btn" @click="reloadFromDisk">重新加载</button>
      <button type="button" class="editor-disk-stale-dismiss" title="忽略" @click="dismissDiskStale">×</button>
    </div>
    <div class="editor-header">
      <div class="editor-file-info">
        <span class="editor-filename" :title="filePath">{{ filePath }}</span>
        <span v-if="modified" class="editor-modified-dot" title="未保存"></span>
      </div>
      <div class="editor-actions">
        <div v-if="isMarkdown || isJson" class="md-mode-toggle">
          <button
            class="mode-toggle-btn"
            :class="{ active: viewMode === 'edit' }"
            title="编辑"
            @click="switchMode('edit')"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </button>
          <button
            v-if="isMarkdown"
            class="mode-toggle-btn"
            :class="{ active: viewMode === 'preview' }"
            title="预览"
            @click="switchMode('preview')"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
          <button
            class="mode-toggle-btn"
            :class="{ active: viewMode === 'mindmap' }"
            :title="isJson ? '思维导图预览' : '思维导图'"
            @click="switchMode('mindmap')"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="2" />
              <circle cx="4" cy="6" r="1.5" /><circle cx="4" cy="18" r="1.5" />
              <circle cx="20" cy="6" r="1.5" /><circle cx="20" cy="18" r="1.5" />
              <path d="M10.5 10.5L5.5 7" /><path d="M10.5 13.5L5.5 17" />
              <path d="M13.5 10.5L18.5 7" /><path d="M13.5 13.5L18.5 17" />
            </svg>
          </button>
        </div>
        <button
          v-if="modified"
          class="editor-action-btn save-btn"
          title="保存 (⌘S)"
          :disabled="saving"
          @click="saveFile"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
            <polyline points="17 21 17 13 7 13 7 21" />
            <polyline points="7 3 7 8 15 8" />
          </svg>
        </button>
      </div>
    </div>

    <div v-if="loading" class="editor-loading">
      <span>加载中...</span>
    </div>
    <div v-else-if="error" class="editor-error">
      <span>{{ error }}</span>
    </div>
    <div v-if="isMarkdown && viewMode === 'preview' && !loading" class="md-preview" v-html="renderedHtml"></div>
    <MindMapView v-if="isMarkdown && viewMode === 'mindmap' && !loading" :content="rawContent" :theme="theme" />
    <SimpleMindMapView
      v-if="isJson && viewMode === 'mindmap' && !loading"
      :content="rawContent"
      :theme="theme"
      @update:content="onMindMapContentUpdate"
    />
    <div v-show="viewMode === 'edit'" ref="editorContainer" class="editor-container"></div>
  </div>
</template>

<style>
.agent-changed-line {
  background: rgba(64, 160, 43, 0.12) !important;
  border-left: 3px solid rgba(64, 160, 43, 0.6) !important;
}

.agent-deleted-line-marker {
  border-bottom: 2px solid rgba(210, 15, 57, 0.5) !important;
}

.agent-deleted-glyph {
  background: rgba(210, 15, 57, 0.7);
  width: 3px !important;
  margin-left: 3px;
  border-radius: 1px;
}

.agent-deleted-viewzone {
  background: rgba(210, 15, 57, 0.08);
  border-left: 3px solid rgba(210, 15, 57, 0.5);
  padding-left: 8px;
  font-family: var(--vscode-editor-font-family, 'Menlo, Monaco, Courier New, monospace');
  font-size: var(--vscode-editor-font-size, 13px);
  line-height: var(--vscode-editor-line-height, 20px);
}

.agent-deleted-viewzone-line {
  text-decoration: line-through;
  color: rgba(210, 15, 57, 0.55);
  white-space: pre;
  overflow: hidden;
}
</style>

<style scoped>
.editor-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: var(--c-base);
}

.editor-disk-stale {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  font-size: 0.78rem;
  background: color-mix(in srgb, var(--c-yellow, #df8e1d) 16%, var(--c-base));
  color: var(--c-text);
  border-bottom: 1px solid var(--c-surface0);
}

.editor-disk-stale-btn {
  margin-left: auto;
  padding: 3px 10px;
  border-radius: 5px;
  border: 1px solid var(--c-surface0);
  background: var(--c-mantle);
  font-size: 0.75rem;
  cursor: pointer;
  color: var(--c-text);
}

.editor-disk-stale-btn:hover {
  background: var(--c-surface0);
}

.editor-disk-stale-dismiss {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--c-overlay0);
  font-size: 1.1rem;
  line-height: 1;
  cursor: pointer;
}

.editor-disk-stale-dismiss:hover {
  background: var(--c-surface0);
  color: var(--c-text);
}

.editor-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid var(--c-surface0);
  background: var(--c-base);
  gap: 8px;
  min-height: 36px;
}

.editor-file-info {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
}

.editor-filename {
  font-size: 0.8rem;
  font-weight: 500;
  color: #A9A9A9;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.editor-modified-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--c-peach, #fe640b);
  flex-shrink: 0;
}

.editor-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.editor-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--c-overlay0);
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}

.editor-action-btn:hover {
  background: var(--c-surface0);
  color: var(--c-text);
}

.save-btn {
  color: var(--c-green);
}

.save-btn:hover {
  color: var(--c-green);
  background: var(--c-surface0);
}

.editor-container {
  flex: 1;
  min-height: 0;
}

.editor-loading,
.editor-error {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.85rem;
  color: var(--c-overlay0);
}

.editor-error {
  color: var(--c-red);
}

.md-mode-toggle {
  display: flex;
  align-items: center;
  background: var(--c-surface0);
  border-radius: 6px;
  padding: 2px;
  gap: 1px;
  margin-right: 4px;
}

.mode-toggle-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 22px;
  border-radius: 4px;
  border: none;
  background: transparent;
  color: var(--c-overlay0);
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}

.mode-toggle-btn:hover {
  color: var(--c-text);
}

.mode-toggle-btn.active {
  background: var(--c-mantle);
  color: var(--c-blue);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}

.md-preview {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 24px 32px;
  font-size: 0.9rem;
  line-height: 1.7;
  background: var(--c-base);
  color: var(--c-text);
  scrollbar-width: thin;
  scrollbar-color: var(--c-scrollbar) transparent;
}

.md-preview::-webkit-scrollbar {
  width: 6px;
}

.md-preview::-webkit-scrollbar-thumb {
  background: var(--c-surface1);
  border-radius: 3px;
}

.md-preview :deep(h1) {
  font-size: 1.8em;
  font-weight: 700;
  margin: 0 0 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--c-surface0);
  color: var(--c-text);
}

.md-preview :deep(h2) {
  font-size: 1.4em;
  font-weight: 600;
  margin: 24px 0 12px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--c-surface0);
  color: var(--c-text);
}

.md-preview :deep(h3) {
  font-size: 1.15em;
  font-weight: 600;
  margin: 20px 0 8px;
  color: var(--c-text);
}

.md-preview :deep(h4),
.md-preview :deep(h5),
.md-preview :deep(h6) {
  font-size: 1em;
  font-weight: 600;
  margin: 16px 0 6px;
  color: var(--c-subtext0);
}

.md-preview :deep(p) {
  margin: 0 0 12px;
}

.md-preview :deep(a) {
  color: var(--c-blue);
  text-decoration: none;
}

.md-preview :deep(a:hover) {
  text-decoration: underline;
}

.md-preview :deep(strong) {
  font-weight: 600;
  color: var(--c-text);
}

.md-preview :deep(code) {
  font-family: 'SF Mono', 'Fira Code', Menlo, Monaco, monospace;
  font-size: 0.88em;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--c-surface0);
  color: var(--c-peach, #fe640b);
}

.md-preview :deep(pre) {
  margin: 0 0 16px;
  padding: 14px 16px;
  border-radius: 8px;
  background: var(--c-mantle);
  overflow-x: auto;
  border: 1px solid var(--c-surface0);
}

.md-preview :deep(pre code) {
  padding: 0;
  background: none;
  color: var(--c-text);
  font-size: 0.85em;
  line-height: 1.6;
}

.md-preview :deep(blockquote) {
  margin: 0 0 16px;
  padding: 8px 16px;
  border-left: 3px solid var(--c-blue);
  background: color-mix(in srgb, var(--c-surface0) 50%, transparent);
  border-radius: 0 6px 6px 0;
  color: var(--c-subtext0);
}

.md-preview :deep(blockquote p:last-child) {
  margin-bottom: 0;
}

.md-preview :deep(ul),
.md-preview :deep(ol) {
  margin: 0 0 12px;
  padding-left: 24px;
}

.md-preview :deep(li) {
  margin: 4px 0;
}

.md-preview :deep(li > ul),
.md-preview :deep(li > ol) {
  margin-bottom: 0;
}

.md-preview :deep(hr) {
  margin: 24px 0;
  border: none;
  border-top: 1px solid var(--c-surface0);
}

.md-preview :deep(table) {
  width: 100%;
  margin: 0 0 16px;
  border-collapse: collapse;
  font-size: 0.88em;
}

.md-preview :deep(th),
.md-preview :deep(td) {
  padding: 8px 12px;
  border: 1px solid var(--c-surface0);
  text-align: left;
}

.md-preview :deep(th) {
  background: var(--c-mantle);
  font-weight: 600;
}

.md-preview :deep(tr:nth-child(even)) {
  background: color-mix(in srgb, var(--c-surface0) 30%, transparent);
}

.md-preview :deep(img) {
  max-width: 100%;
  border-radius: 8px;
  margin: 8px 0;
}

.md-preview :deep(input[type="checkbox"]) {
  margin-right: 6px;
}
</style>
