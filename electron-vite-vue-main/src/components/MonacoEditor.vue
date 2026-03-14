<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, shallowRef, inject } from 'vue'
import * as monaco from 'monaco-editor'
import { marked } from 'marked'
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

const { theme } = useTheme()
const editorContainer = ref<HTMLDivElement>()
const editor = shallowRef<monaco.editor.IStandaloneCodeEditor>()
const loading = ref(true)
const error = ref('')
const modified = ref(false)
const saving = ref(false)
const previewMode = ref(false)
const rawContent = ref('')
const showSelectionToolbar = ref(false)
const toolbarPos = ref({ top: 0, left: 0 })

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

const renderedHtml = computed(() => {
  if (!isMarkdown.value || !previewMode.value) return ''
  return marked.parse(rawContent.value, { async: false }) as string
})

function togglePreview() {
  if (previewMode.value) {
    previewMode.value = false
    requestAnimationFrame(() => editor.value?.layout())
  } else {
    if (editor.value) rawContent.value = editor.value.getValue()
    previewMode.value = true
  }
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

function getMonacoTheme(t: string) {
  return t === 'dark' ? 'vs-dark' : 'vs'
}

async function loadFile() {
  loading.value = true
  error.value = ''
  modified.value = false

  const result = await window.fsApi.readFile(props.filePath)
  loading.value = false

  if (result.error) {
    error.value = result.error
    return
  }

  rawContent.value = result.content
  if (editor.value) {
    const model = editor.value.getModel()
    if (model) {
      model.setValue(result.content)
      monaco.editor.setModelLanguage(model, getLang(props.filePath))
    }
    modified.value = false
  }
}

async function saveFile() {
  if (!editor.value || saving.value) return
  saving.value = true
  const content = editor.value.getValue()
  const result = await window.fsApi.writeFile(props.filePath, content)
  saving.value = false
  if (result.error) {
    error.value = result.error
  } else {
    modified.value = false
  }
}

watch(() => props.filePath, () => {
  previewMode.value = false
  loadFile()
})

watch(theme, (t) => {
  monaco.editor.setTheme(getMonacoTheme(t))
})

onMounted(() => {
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
    if (isMarkdown.value) rawContent.value = editor.value!.getValue()
  })

  editor.value.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    saveFile()
  })

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

  loadFile()
})

onBeforeUnmount(() => {
  editor.value?.dispose()
})
</script>

<template>
  <div class="editor-panel">
    <div class="editor-header">
      <div class="editor-file-info">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
        <span class="editor-filename" :title="filePath">{{ filePath }}</span>
        <span v-if="modified" class="editor-modified-dot" title="未保存"></span>
      </div>
      <div class="editor-actions">
        <div v-if="isMarkdown" class="md-mode-toggle">
          <button
            class="mode-toggle-btn"
            :class="{ active: !previewMode }"
            title="编辑"
            @click="previewMode && togglePreview()"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </button>
          <button
            class="mode-toggle-btn"
            :class="{ active: previewMode }"
            title="预览"
            @click="!previewMode && togglePreview()"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
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
    <div v-if="isMarkdown && previewMode" class="md-preview" v-html="renderedHtml"></div>
    <div v-show="!previewMode" ref="editorContainer" class="editor-container"></div>
  </div>
</template>

<style scoped>
.editor-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: var(--c-base);
}

.editor-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid var(--c-surface0);
  background: var(--c-mantle);
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

.editor-file-info svg {
  flex-shrink: 0;
  color: var(--c-blue);
}

.editor-filename {
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--c-text);
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
  color: var(--c-text);
  scrollbar-width: thin;
  scrollbar-color: var(--c-surface1) transparent;
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
