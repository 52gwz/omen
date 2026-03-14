<script setup lang="ts">
import Tribute from 'tributejs'
import { computed, inject, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { CodeReference, MentionTab } from '../types/workspace'

type ChatMode = 'chat' | 'agent'
type ComposerVariant = 'welcome' | 'chat'

const props = withDefaults(defineProps<{
  modelValue: string
  pendingImages: string[]
  providers: ModelProvider[]
  activeProviderId: string
  currentModel: string
  chatMode: ChatMode
  canSend: boolean
  isStreaming?: boolean
  placeholder?: string
  variant?: ComposerVariant
  viewTransitionName?: string
}>(), {
  isStreaming: false,
  placeholder: '',
  variant: 'chat',
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  send: []
  stop: []
  paste: [event: ClipboardEvent]
  selectImages: []
  removeImage: [index: number]
  selectMode: [mode: ChatMode]
  selectProviderModel: [payload: { providerId: string; model: string }]
}>()

const openTabs = inject<Ref<MentionTab[]>>('openTabs', ref([]))
const pendingCodeReferences = inject<CodeReference[]>('pendingCodeReferences', [])
const removeCodeReference = inject<(index: number) => void>('removeCodeReference', () => {})

const editorEl = ref<HTMLDivElement>()
const editorHasContent = ref(false)
const modeDropdownOpen = ref(false)
const modelSelectorOpen = ref(false)
const modeDropdownRef = ref<HTMLElement>()
const modelSelectorRef = ref<HTMLElement>()

function refDisplayName(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').pop() || filePath
}

function refPreview(text: string, maxLines = 4): string {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return text
  return lines.slice(0, maxLines).join('\n') + '\n...'
}

let tribute: Tribute<MentionTab> | null = null
let suppressWatch = false

const modeLabels: Record<ChatMode, string> = {
  chat: '对话',
  agent: 'Agent',
}

const shellStyle = computed(() => (
  props.viewTransitionName ? { viewTransitionName: props.viewTransitionName } : undefined
))

// Serialize contenteditable DOM → raw text with @[label](tabId) tokens
function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || ''
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const el = node as HTMLElement
  if (el.dataset.tabId) {
    // mention chip — reconstruct token
    return `@[${el.dataset.label || ''}](${el.dataset.tabId})`
  }
  if (el.tagName === 'BR') return '\n'
  if (el.tagName === 'DIV') {
    const inner = Array.from(el.childNodes).map(serializeNode).join('')
    return '\n' + inner
  }
  return Array.from(el.childNodes).map(serializeNode).join('')
}

function serializeContent(): string {
  if (!editorEl.value) return ''
  return Array.from(editorEl.value.childNodes).map(serializeNode).join('')
}

function focusInput() {
  editorEl.value?.focus()
}

function handleInput() {
  suppressWatch = true
  const value = serializeContent()
  editorHasContent.value = value !== ''
  emit('update:modelValue', value)
  nextTick(() => { suppressWatch = false })
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    if (tribute?.isActive) return
    if (event.shiftKey || event.isComposing) {
      // Insert real newline via execCommand
      event.preventDefault()
      document.execCommand('insertLineBreak')
      handleInput()
      return
    }
    event.preventDefault()
    emit('send')
  }
}

function handleEditorClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (target.closest('.mention-chip-del')) {
    const chip = target.closest('.mention-chip-input')
    if (chip) {
      chip.remove()
      handleInput()
      focusInput()
    }
    e.preventDefault()
    e.stopPropagation()
  }
}

function handlePaste(e: ClipboardEvent) {
  emit('paste', e)
  if (e.defaultPrevented) return
  // Paste as plain text — strip any HTML from clipboard
  e.preventDefault()
  const text = e.clipboardData?.getData('text/plain')
  if (text) {
    document.execCommand('insertText', false, text)
    handleInput()
  }
}

function handleClickOutside(event: MouseEvent) {
  if (modeDropdownRef.value && !modeDropdownRef.value.contains(event.target as Node)) {
    modeDropdownOpen.value = false
  }
  if (modelSelectorRef.value && !modelSelectorRef.value.contains(event.target as Node)) {
    modelSelectorOpen.value = false
  }
}

function handleSelectMode(mode: ChatMode) {
  modeDropdownOpen.value = false
  emit('selectMode', mode)
  nextTick(() => focusInput())
}

function handleSelectProviderModel(providerId: string, model: string) {
  modelSelectorOpen.value = false
  emit('selectProviderModel', { providerId, model })
  nextTick(() => focusInput())
}

// When parent clears or sets the value programmatically (e.g. after send)
watch(() => props.modelValue, (val) => {
  if (suppressWatch) return
  if (!editorEl.value) return
  const current = serializeContent()
  if (current === val) return
  if (val === '') {
    editorEl.value.innerHTML = ''
    editorHasContent.value = false
  } else {
    editorEl.value.textContent = val
    editorHasContent.value = val !== ''
  }
})

onMounted(() => {
  nextTick(() => {
    if (editorEl.value) {
      tribute = new Tribute<MentionTab>({
        trigger: '@',
        values: (_text, cb) => cb(openTabs.value),
        lookup: 'key',
        fillAttr: 'key',
        requireLeadingSpace: false,
        allowSpaces: false,
        replaceTextSuffix: '\u00a0',
        selectTemplate: (item) => {
          const isFile = item.original.type === 'file'
          const iconSvg = isFile
            ? `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`
            : `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`
          const label = item.original.key
          const tabId = item.original.value
          const delSvg = `<svg class="mention-chip-del-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`
          return `<span class="mention-chip-input" data-tab-id="${tabId}" data-label="${label}" contenteditable="false" title="${tabId.replace('__editor__:', '').replace('__webview__:', '')}"><span class="mention-chip-del" title="移除">${delSvg}</span>${iconSvg}<span class="mention-chip-label">${label}</span></span>`
        },
        menuItemTemplate: (item) => {
          const iconSvg = item.original.type === 'file'
            ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`
            : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`
          const dir = item.original.path ?? ''
          const dirLabel = dir.length > 22 ? `...${dir.slice(-22)}` : dir
          const pathHtml = dirLabel ? `<span class="tribute-item-path">${dirLabel}</span>` : ''
          return `<span class="tribute-item-icon">${iconSvg}</span><span class="tribute-item-label">${item.string}</span>${pathHtml}`
        },
        noMatchTemplate: () => `<li class="tribute-no-match">无匹配标签页</li>`,
        containerClass: 'mention-tribute-container',
        itemClass: 'mention-tribute-item',
        selectClass: 'mention-tribute-item-active',
      })
      tribute.attach(editorEl.value)
      editorEl.value.addEventListener('tribute-replaced', () => {
        handleInput()
        nextTick(() => focusInput())
      })
    }
  })
  document.addEventListener('click', handleClickOutside)
})

onUnmounted(() => {
  if (tribute && editorEl.value) {
    tribute.detach(editorEl.value)
  }
  document.removeEventListener('click', handleClickOutside)
})

defineExpose({
  focusInput,
})
</script>

<template>
  <div class="composer-shell" :class="`variant-${variant}`" :style="shellStyle">
    <div class="input-card">
      <div v-if="pendingImages.length" class="composer-pending-images">
        <div v-for="(img, idx) in pendingImages" :key="idx" class="pending-img-item">
          <img :src="img" class="pending-img-thumb" />
          <button class="pending-img-remove" title="移除" @click="emit('removeImage', idx)">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      <div v-if="pendingCodeReferences.length" class="composer-references">
        <div v-for="(cref, idx) in pendingCodeReferences" :key="idx" class="reference-item">
          <div class="reference-header">
            <svg class="reference-file-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <span class="reference-filename" :title="cref.filePath">{{ refDisplayName(cref.filePath) }}</span>
            <span class="reference-lines">L{{ cref.startLine }}<template v-if="cref.startLine !== cref.endLine">-L{{ cref.endLine }}</template></span>
            <button class="reference-remove" title="移除引用" @click="removeCodeReference(idx)">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <pre class="reference-code">{{ refPreview(cref.text) }}</pre>
        </div>
      </div>

      <div class="composer-editor-wrap" :class="`variant-${variant}`">
        <div
          ref="editorEl"
          class="composer-editor"
          :class="`variant-${variant}`"
          contenteditable="true"
          spellcheck="false"
          @input="handleInput"
          @keydown="handleKeydown"
          @paste="handlePaste"
          @click="handleEditorClick"
        ></div>
        <span v-if="!editorHasContent" class="composer-placeholder">{{ placeholder }}</span>
      </div>

      <div class="card-toolbar">
        <div class="toolbar-left">
          <div ref="modeDropdownRef" class="mode-dropdown">
            <button class="mode-trigger" @click.stop="modeDropdownOpen = !modeDropdownOpen">
              <span class="mode-dot" :class="chatMode"></span>
              {{ modeLabels[chatMode] }}
              <svg
                class="mode-chevron"
                :class="{ open: modeDropdownOpen }"
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            <Transition name="dropdown">
              <div v-if="modeDropdownOpen" class="mode-menu">
                <button
                  v-for="mode in (['chat', 'agent'] as ChatMode[])"
                  :key="mode"
                  class="mode-option"
                  :class="{ active: chatMode === mode }"
                  @click="handleSelectMode(mode)"
                >
                  <span class="mode-dot" :class="mode"></span>
                  <span>{{ modeLabels[mode] }}</span>
                  <svg
                    v-if="chatMode === mode"
                    class="check-icon"
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </button>
              </div>
            </Transition>
          </div>

          <button class="toolbar-icon-btn" title="添加图片" @click="emit('selectImages')">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
          </button>
        </div>

        <div class="toolbar-right">
          <div ref="modelSelectorRef" class="model-selector">
            <button class="model-selector-trigger" @click.stop="modelSelectorOpen = !modelSelectorOpen">
              <span class="model-name">{{ currentModel || '未配置模型' }}</span>
              <svg
                class="selector-chevron"
                :class="{ open: modelSelectorOpen }"
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            <Transition name="dropdown">
              <div v-if="modelSelectorOpen" class="model-dropdown-menu">
                <div v-if="!providers.length" class="model-dropdown-empty">请先在设置中配置供应商</div>
                <template v-else>
                  <div v-for="provider in providers" :key="provider.id" class="model-group">
                    <div class="model-group-title">{{ provider.name || '未命名' }}</div>
                    <button
                      v-for="model in provider.models"
                      :key="`${provider.id}-${model}`"
                      class="model-item"
                      :class="{ active: activeProviderId === provider.id && currentModel === model }"
                      @click="handleSelectProviderModel(provider.id, model)"
                    >
                      <span>{{ model }}</span>
                      <svg
                        v-if="activeProviderId === provider.id && currentModel === model"
                        class="check-icon"
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2.5"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </button>
                    <div v-if="!provider.models.length" class="model-no-models">暂无模型</div>
                  </div>
                </template>
              </div>
            </Transition>
          </div>

          <button
            v-if="isStreaming"
            class="action-circle-btn danger"
            title="终止对话"
            @click="emit('stop')"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
              <rect x="5" y="5" width="14" height="14" rx="2" />
            </svg>
          </button>
          <button
            v-else
            class="action-circle-btn"
            :disabled="!canSend"
            title="发送"
            @click="emit('send')"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="5 12 12 5 19 12" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.composer-shell {
  width: 100%;
}

.input-card {
  width: 100%;
  background: var(--c-mantle);
  border: 1px solid var(--c-surface0);
  border-radius: 16px;
  box-shadow: 0 2px 12px var(--c-shadow);
  display: flex;
  flex-direction: column;
}

.composer-shell.variant-chat .input-card {
  border-radius: 18px;
  box-shadow: 0 8px 30px color-mix(in srgb, var(--c-shadow) 65%, transparent);
}

.composer-pending-images {
  display: flex;
  gap: 8px;
  padding: 14px 20px 0;
  overflow-x: auto;
  flex-wrap: wrap;
}

.pending-img-item {
  position: relative;
  flex-shrink: 0;
}

.pending-img-thumb {
  width: 64px;
  height: 64px;
  object-fit: cover;
  border-radius: 8px;
  border: 1px solid var(--c-surface1);
}

.pending-img-remove {
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

.pending-img-remove:hover {
  background: var(--c-red, #e64553);
  color: #fff;
}

.composer-editor-wrap {
  position: relative;
  width: 100%;
}

.composer-editor-wrap.variant-welcome {
  min-height: 140px;
}

.composer-editor-wrap.variant-chat {
  min-height: 76px;
}

.composer-editor {
  width: 100%;
  background: transparent;
  border: none;
  outline: none;
  color: var(--c-text);
  font-family: inherit;
  box-sizing: border-box;
  word-break: break-word;
  white-space: pre-wrap;
  overflow-wrap: break-word;
}

.composer-editor.variant-welcome {
  min-height: 140px;
  max-height: 240px;
  overflow-y: auto;
  padding: 20px 20px 12px;
  font-size: 0.95rem;
  line-height: 1.6;
}

.composer-editor.variant-chat {
  min-height: 76px;
  max-height: 200px;
  overflow-y: auto;
  padding: 16px 18px 10px;
  font-size: 0.93rem;
  line-height: 1.58;
}

.composer-placeholder {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
  color: var(--c-overlay0);
  font-family: inherit;
  white-space: pre-wrap;
}

.composer-editor-wrap.variant-welcome .composer-placeholder {
  padding: 20px 20px 12px;
  font-size: 0.95rem;
  line-height: 1.6;
}

.composer-editor-wrap.variant-chat .composer-placeholder {
  padding: 16px 18px 10px;
  font-size: 0.93rem;
  line-height: 1.58;
}

.card-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  gap: 8px;
}

.toolbar-left,
.toolbar-right {
  display: flex;
  align-items: center;
  gap: 4px;
}

.toolbar-icon-btn {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  border: 1px solid var(--c-surface0);
  background: var(--c-base);
  color: var(--c-overlay1);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.2s, background 0.2s, border-color 0.2s;
}

.toolbar-icon-btn:hover {
  color: var(--c-text);
  background: var(--c-surface-hover);
  border-color: var(--c-surface1);
}

.model-selector {
  position: relative;
}

.model-selector-trigger {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: none;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 4px 8px;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s, border-color 0.15s;
  user-select: none;
}

.model-selector-trigger:hover {
  background: var(--c-surface0);
  border-color: var(--c-surface1);
}

.model-name {
  font-size: 0.82rem;
  color: var(--c-subtext0);
  white-space: nowrap;
}

.selector-chevron {
  color: var(--c-overlay0);
  transition: transform 0.2s ease;
}

.selector-chevron.open {
  transform: rotate(180deg);
}

.model-dropdown-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  right: 0;
  min-width: 220px;
  max-width: 320px;
  max-height: 320px;
  overflow-y: auto;
  background: var(--c-surface-alt);
  border: 1px solid var(--c-surface1);
  border-radius: 10px;
  padding: 4px;
  box-shadow: 0 8px 24px var(--c-shadow-heavy);
  z-index: 100;
}

.model-dropdown-empty {
  padding: 12px 14px;
  font-size: 0.82rem;
  color: var(--c-overlay0);
  text-align: center;
}

.model-group {
  padding: 2px 0;
}

.model-group + .model-group {
  border-top: 1px solid var(--c-surface0);
  margin-top: 2px;
  padding-top: 4px;
}

.model-group-title {
  padding: 6px 10px 4px;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--c-overlay0);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.model-item {
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

.model-item:hover {
  background: var(--c-surface-hover);
}

.model-item.active {
  background: var(--c-surface0);
  color: var(--c-blue);
}

.model-no-models {
  padding: 6px 10px;
  font-size: 0.78rem;
  color: var(--c-overlay0);
  font-style: italic;
}

.mode-dropdown {
  position: relative;
}

.mode-trigger {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: none;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 4px 10px;
  height: 34px;
  color: var(--c-subtext0);
  font-size: 0.82rem;
  cursor: pointer;
  font-family: inherit;
  white-space: nowrap;
  transition: background 0.2s, border-color 0.2s;
  user-select: none;
}

.mode-trigger:hover {
  background: var(--c-surface0);
  border-color: var(--c-surface1);
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
  color: var(--c-overlay0);
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

.action-circle-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: var(--c-surface0);
  color: var(--c-subtext0);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-left: 2px;
  transition: background 0.2s, color 0.2s, opacity 0.2s;
}

.action-circle-btn:hover:not(:disabled) {
  background: var(--c-surface1);
  color: var(--c-text);
}

.action-circle-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.action-circle-btn.danger {
  background: color-mix(in srgb, var(--c-red, #e64553) 16%, var(--c-surface0));
  color: var(--c-red, #e64553);
}

.action-circle-btn.danger:hover {
  background: color-mix(in srgb, var(--c-red, #e64553) 22%, var(--c-surface1));
  color: #fff;
}

.composer-references {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 16px 0;
}

.reference-item {
  background: var(--c-surface0);
  border: 1px solid var(--c-surface1);
  border-radius: 8px;
  overflow: hidden;
}

.reference-header {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 8px;
  background: color-mix(in srgb, var(--c-surface1) 50%, transparent);
}

.reference-file-icon {
  flex-shrink: 0;
  color: var(--c-green, #40a02b);
}

.reference-filename {
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--c-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.reference-lines {
  font-size: 0.7rem;
  color: var(--c-overlay0);
  font-family: 'SF Mono', 'Fira Code', monospace;
  white-space: nowrap;
  flex-shrink: 0;
}

.reference-remove {
  margin-left: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  border: none;
  background: transparent;
  color: var(--c-overlay0);
  cursor: pointer;
  flex-shrink: 0;
  transition: color 0.15s, background 0.15s;
}

.reference-remove:hover {
  background: var(--c-surface1);
  color: var(--c-red, #e64553);
}

.reference-code {
  margin: 0;
  padding: 6px 10px;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--c-subtext0);
  white-space: pre;
  overflow-x: auto;
  max-height: 80px;
  scrollbar-width: thin;
  scrollbar-color: var(--c-surface1) transparent;
}

.reference-code::-webkit-scrollbar {
  height: 4px;
}

.reference-code::-webkit-scrollbar-thumb {
  background: var(--c-surface1);
  border-radius: 2px;
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
</style>

<style>
.mention-tribute-container {
  position: absolute;
  background: var(--c-surface-alt, #1e1e2e);
  border: 1px solid var(--c-surface1, #313244);
  border-radius: 10px;
  padding: 4px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  z-index: 9999;
  min-width: 200px;
  max-width: 340px;
  max-height: 260px;
  overflow-y: auto;
}

.mention-tribute-container ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

.mention-tribute-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 7px;
  cursor: pointer;
  color: var(--c-text, #cdd6f4);
  font-size: 0.84rem;
  font-family: inherit;
  transition: background 0.12s;
}

.mention-tribute-item:hover {
  background: var(--c-surface-hover, #313244);
}

.mention-tribute-item-active,
.mention-tribute-item-active:hover {
  background: var(--c-surface0, #313244);
  color: var(--c-blue, #89b4fa);
}

.tribute-item-icon {
  flex-shrink: 0;
  color: var(--c-overlay1, #7f849c);
  display: flex;
  align-items: center;
}

.mention-tribute-item-active .tribute-item-icon {
  color: var(--c-blue, #89b4fa);
}

.tribute-item-label {
  flex: 1;
  min-width: 0;
}

.tribute-item-label span {
  font-weight: 500;
}

.tribute-item-path {
  flex-shrink: 0;
  font-size: 0.75rem;
  color: var(--c-overlay0, #6c7086);
  font-family: 'SF Mono', 'Fira Code', monospace;
  margin-left: 8px;
  white-space: nowrap;
}

.mention-tribute-item-active .tribute-item-path {
  color: var(--c-blue, #89b4fa);
  opacity: 0.7;
}

.tribute-no-match {
  padding: 8px 10px;
  font-size: 0.82rem;
  color: var(--c-overlay0, #6c7086);
  font-style: italic;
  text-align: center;
}

/* Mention chip inside the contenteditable input — must be global (Tribute inserts without scoped attr) */
.mention-chip-input {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px 2px 5px;
  background: var(--c-blue, #1e66f5);
  border-radius: 5px;
  color: #fff;
  font-size: 0.84em;
  font-weight: 500;
  line-height: 1.5;
  cursor: default;
  user-select: none;
  vertical-align: middle;
  max-width: 220px;
  opacity: 0.9;
  transition: opacity 0.15s, background 0.15s;
}

.mention-chip-input:hover {
  opacity: 1;
  background: color-mix(in srgb, var(--c-blue, #1e66f5) 82%, #fff);
}

.mention-chip-input svg {
  flex-shrink: 0;
  opacity: 0.85;
}

.mention-chip-input .mention-chip-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
}

.mention-chip-del {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  cursor: pointer;
  flex-shrink: 0;
  opacity: 0.7;
  transition: opacity 0.15s;
}

.mention-chip-del:hover {
  opacity: 1;
}
</style>
