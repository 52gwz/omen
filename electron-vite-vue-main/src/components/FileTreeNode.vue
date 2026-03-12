<script setup lang="ts">
import { inject, ref, onMounted, onUnmounted } from 'vue'

defineProps<{
  entries: FileEntry[]
  depth?: number
}>()

const expandedDirs = inject<Set<string>>('fileTree:expandedDirs')!
const dirChildren = inject<Record<string, FileEntry[]>>('fileTree:dirChildren')!
const toggleDir = inject<(path: string) => void>('fileTree:toggleDir')!
const openFile = inject<(path: string) => void>('fileTree:openFile')!
const previewHtmlFile = inject<(path: string) => void>('fileTree:previewHtml')!

const ctxMenu = ref<{ visible: boolean; x: number; y: number; path: string; name: string; isDirectory: boolean }>({
  visible: false, x: 0, y: 0, path: '', name: '', isDirectory: false,
})

function onFileContext(e: MouseEvent, entry: FileEntry) {
  e.preventDefault()
  e.stopPropagation()
  ctxMenu.value = {
    visible: true,
    x: e.clientX,
    y: e.clientY,
    path: entry.path,
    name: entry.name,
    isDirectory: entry.isDirectory,
  }
}

function closeCtxMenu() {
  ctxMenu.value.visible = false
}

function showInFolder() {
  window.fsApi.showInFolder(ctxMenu.value.path)
  closeCtxMenu()
}

function isHtmlFile(filePath: string) {
  const lower = filePath.toLowerCase()
  return lower.endsWith('.html') || lower.endsWith('.htm')
}

function previewHtml() {
  previewHtmlFile(ctxMenu.value.path)
  closeCtxMenu()
}

async function deletePath() {
  const { path, name, isDirectory } = ctxMenu.value
  const confirmed = window.confirm(`确认将${isDirectory ? '文件夹' : '文件'}“${name}”移到回收站？`)
  if (!confirmed) return

  const { error } = await window.fsApi.deletePath(path)
  closeCtxMenu()

  if (error) {
    window.alert(`删除失败：${error}`)
  }
}

onMounted(() => document.addEventListener('click', closeCtxMenu))
onUnmounted(() => document.removeEventListener('click', closeCtxMenu))
</script>

<template>
  <template v-for="entry in entries" :key="entry.path">
    <div
      class="file-item"
      :class="{ 'is-dir': entry.isDirectory }"
      :style="{ paddingLeft: 8 + (depth || 0) * 14 + 'px' }"
      @click="entry.isDirectory ? toggleDir(entry.path) : openFile(entry.path)"
      @contextmenu="onFileContext($event, entry)"
    >
      <template v-if="entry.isDirectory">
        <svg
          class="collapse-arrow tree-arrow"
          :class="{ collapsed: !expandedDirs.has(entry.path) }"
          width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
        <svg class="file-icon dir-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      </template>
      <template v-else>
        <span class="tree-indent"></span>
        <svg class="file-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      </template>
      <span class="file-name">{{ entry.name }}</span>
    </div>

    <FileTreeNode
      v-if="entry.isDirectory && expandedDirs.has(entry.path) && dirChildren[entry.path]"
      :entries="dirChildren[entry.path]"
      :depth="(depth || 0) + 1"
    />
  </template>

  <Teleport to="body">
    <div
      v-if="ctxMenu.visible"
      class="file-ctx-menu"
      :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
    >
      <button v-if="isHtmlFile(ctxMenu.path)" @click="previewHtml">预览</button>
      <button class="danger" @click="deletePath">删除{{ ctxMenu.isDirectory ? '文件夹' : '文件' }}</button>
      <button @click="showInFolder">在文件管理器中显示</button>
    </div>
  </Teleport>
</template>

<style scoped>
.file-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px 3px 8px;
  cursor: pointer;
  border-radius: 5px;
  margin: 0 4px;
  font-size: 0.78rem;
  color: var(--c-subtext0);
  transition: background 0.12s;
  white-space: nowrap;
  overflow: hidden;
}

.file-item:hover {
  background: var(--c-base);
}

.tree-arrow {
  flex-shrink: 0;
  color: var(--c-overlay0);
  transition: transform 0.2s ease;
}

.tree-arrow.collapsed {
  transform: rotate(-90deg);
}

.tree-indent {
  width: 10px;
  flex-shrink: 0;
}

.file-icon {
  flex-shrink: 0;
  color: var(--c-surface2);
}

.dir-icon {
  color: var(--c-yellow, #df8e1d);
}

.file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-ctx-menu {
  position: fixed;
  z-index: 1000;
  background: var(--c-surface-alt);
  border: 1px solid var(--c-surface1);
  border-radius: 8px;
  padding: 4px;
  box-shadow: 0 6px 20px var(--c-shadow-heavy);
  min-width: 140px;
}

.file-ctx-menu button {
  display: block;
  width: 100%;
  padding: 7px 12px;
  background: none;
  border: none;
  color: var(--c-text);
  font-size: 0.82rem;
  text-align: left;
  cursor: pointer;
  border-radius: 5px;
  font-family: inherit;
  transition: background 0.12s;
}

.file-ctx-menu button:hover {
  background: var(--c-surface0);
}

.file-ctx-menu button.danger {
  color: var(--c-red, #d20f39);
}
</style>
