<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, shallowRef } from 'vue'
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { useTheme } from '../composables/useTheme'

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

const emit = defineEmits<{
  close: []
}>()

const { theme } = useTheme()
const editorContainer = ref<HTMLDivElement>()
const editor = shallowRef<monaco.editor.IStandaloneCodeEditor>()
const loading = ref(true)
const error = ref('')
const modified = ref(false)
const saving = ref(false)

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
  })

  editor.value.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    saveFile()
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
        <button class="editor-action-btn close-btn" title="关闭编辑器" @click="emit('close')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
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
    <div ref="editorContainer" class="editor-container"></div>
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
</style>
