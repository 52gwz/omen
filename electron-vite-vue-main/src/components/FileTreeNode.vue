<script setup lang="ts">
import { inject, ref, computed, onMounted, onUnmounted, nextTick, type Ref, type ComputedRef } from 'vue'
import type { FileReference } from '../types/workspace'

const props = defineProps<{
  entries: FileEntry[]
  depth?: number
}>()

const expandedDirs = inject<Set<string>>('fileTree:expandedDirs')!
const dirChildren = inject<Record<string, FileEntry[]>>('fileTree:dirChildren')!
const toggleDir = inject<(path: string) => void>('fileTree:toggleDir')!
const openFile = inject<(path: string) => void>('fileTree:openFile')!
const previewHtmlFile = inject<(path: string) => void>('fileTree:previewHtml')!
const selectedFiles = inject<Set<string>>('fileTree:selectedFiles')!
const toggleSelect = inject<(path: string, entry: FileEntry, e: MouseEvent) => void>('fileTree:toggleSelect')!
const createInDir = inject<(parentDir: string, type: 'file' | 'dir') => void>('fileTree:createInDir')!
const newItemState = inject<Ref<{ parentDir: string; type: 'file' | 'dir'; name: string } | null>>('fileTree:newItemState')!
const confirmNewItem = inject<() => void>('fileTree:confirmNewItem')!
const onNewItemKeydown = inject<(e: KeyboardEvent) => void>('fileTree:onNewItemKeydown')!
const lastClickedPath = inject<Ref<string | null>>('fileTree:lastClickedPath')!
const allEntries = inject<Ref<FileEntry[]>>('fileTree:allEntries')!
const activeEditorPath = inject<ComputedRef<string>>(
  'fileTree:activeEditorPath',
  computed(() => ''),
)
const onFileRenamed = inject<(oldPath: string, newPath: string) => void>('fileTree:onFileRenamed', () => {})
const onFileDeleted = inject<(path: string, isDirectory: boolean) => void>('fileTree:onFileDeleted', () => {})

function normalizeFsPath(p: string) {
  return p.replace(/\\/g, '/')
}

function isOpenInEditor(path: string) {
  const open = activeEditorPath.value
  if (!open) return false
  return normalizeFsPath(path) === normalizeFsPath(open)
}

// ---- Rename state ----
const renameState = ref<{ path: string; name: string } | null>(null)

function startRename(entry: FileEntry) {
  renameState.value = { path: entry.path, name: entry.name }
  nextTick(() => {
    const input = document.querySelector<HTMLInputElement>('.rename-input')
    if (input) {
      input.focus()
      // select name without extension for files
      const dotIdx = entry.name.lastIndexOf('.')
      if (!entry.isDirectory && dotIdx > 0) {
        input.setSelectionRange(0, dotIdx)
      } else {
        input.select()
      }
    }
  })
}

async function confirmRename() {
  const state = renameState.value
  if (!state) return
  const newName = state.name.trim()
  renameState.value = null
  if (!newName || newName === state.path.replace(/.*\//, '')) return
  const result = await window.fsApi.renamePath(state.path, newName)
  if (result.error) window.alert(`重命名失败：${result.error}`)
  else if (result.newPath) onFileRenamed(state.path, result.newPath)
}

function onRenameKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') { e.preventDefault(); confirmRename() }
  else if (e.key === 'Escape') { renameState.value = null }
}

function onFileClick(e: MouseEvent, entry: FileEntry) {
  if (e.shiftKey && lastClickedPath.value) {
    // Shift+click: range select from lastClickedPath to this entry
    const flat = allEntries.value
    const fromIdx = flat.findIndex(f => f.path === lastClickedPath.value)
    const toIdx = flat.findIndex(f => f.path === entry.path)
    if (fromIdx !== -1 && toIdx !== -1) {
      const [lo, hi] = fromIdx < toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx]
      for (let i = lo; i <= hi; i++) selectedFiles.add(flat[i].path)
    }
    return
  }
  if (e.metaKey || e.ctrlKey) {
    toggleSelect(entry.path, entry, e)
  } else {
    lastClickedPath.value = entry.path
    if (entry.isDirectory) toggleDir(entry.path)
    else openFile(entry.path)
  }
}

function onDragStart(e: DragEvent, entry: FileEntry) {
  if (!e.dataTransfer) return
  // Set internal move data
  const movePaths = selectedFiles.has(entry.path)
    ? Array.from(selectedFiles)
    : [entry.path]
  e.dataTransfer.setData('application/x-file-move', JSON.stringify(movePaths))
  // Also set chat ref data for dropping into chat
  let refs: FileReference[]
  if (selectedFiles.has(entry.path)) {
    refs = Array.from(selectedFiles).map(p => {
      const name = p.replace(/\\/g, '/').split('/').pop() || p
      return { filePath: p, name, isDirectory: false }
    })
  } else {
    refs = [{ filePath: entry.path, name: entry.name, isDirectory: entry.isDirectory }]
  }
  e.dataTransfer.setData('application/x-file-refs', JSON.stringify(refs))
  e.dataTransfer.effectAllowed = 'copyMove'
}

const dropTargetDir = ref<string | null>(null)

function onDirDragOver(e: DragEvent, entry: FileEntry) {
  if (!entry.isDirectory) return
  if (!e.dataTransfer?.types.includes('application/x-file-move')) return
  e.preventDefault()
  e.stopPropagation()
  e.dataTransfer.dropEffect = 'move'
  dropTargetDir.value = entry.path
}

function onDirDragLeave(e: DragEvent, entry: FileEntry) {
  if (dropTargetDir.value === entry.path) {
    dropTargetDir.value = null
  }
}

async function onDirDrop(e: DragEvent, entry: FileEntry) {
  e.preventDefault()
  e.stopPropagation()
  dropTargetDir.value = null
  if (!entry.isDirectory) return
  const moveData = e.dataTransfer?.getData('application/x-file-move')
  if (!moveData) return
  try {
    const paths: string[] = JSON.parse(moveData)
    for (const src of paths) {
      // Don't move into itself or its own parent
      if (src === entry.path) continue
      if (entry.path.startsWith(src + '/')) continue
      const parentDir = src.replace(/\/[^/]+$/, '')
      if (parentDir === entry.path) continue
      const result = await window.fsApi.movePath(src, entry.path)
      if (result.error) {
        window.alert(`移动失败: ${result.error}`)
        break
      } else if (result.newPath) {
        onFileRenamed(src, result.newPath)
      }
    }
  } catch {}
}

const ctxMenu = ref<{ visible: boolean; x: number; y: number; path: string; name: string; isDirectory: boolean }>({
  visible: false, x: 0, y: 0, path: '', name: '', isDirectory: false,
})

function ctxNewFile() {
  const dir = ctxMenu.value.isDirectory ? ctxMenu.value.path : ctxMenu.value.path.replace(/\/[^/]+$/, '')
  closeCtxMenu()
  createInDir(dir, 'file')
}

function ctxNewFolder() {
  const dir = ctxMenu.value.isDirectory ? ctxMenu.value.path : ctxMenu.value.path.replace(/\/[^/]+$/, '')
  closeCtxMenu()
  createInDir(dir, 'dir')
}

function ctxRename() {
  const entry = { path: ctxMenu.value.path, name: ctxMenu.value.name, isDirectory: ctxMenu.value.isDirectory }
  closeCtxMenu()
  startRename(entry as FileEntry)
}

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
  const p = ctxMenu.value.path
  closeCtxMenu()
  window.fsApi.showInFolder(p)
}

function isHtmlFile(filePath: string) {
  const lower = filePath.toLowerCase()
  return lower.endsWith('.html') || lower.endsWith('.htm')
}

function previewHtml() {
  const p = ctxMenu.value.path
  closeCtxMenu()
  previewHtmlFile(p)
}

async function deletePath() {
  const { path, name, isDirectory } = ctxMenu.value
  closeCtxMenu()
  const confirmed = window.confirm(`确认将${isDirectory ? '文件夹' : '文件'}“${name}”移到回收站？`)
  if (!confirmed) return

  const { error } = await window.fsApi.deletePath(path)

  if (error) {
    window.alert(`删除失败：${error}`)
  } else {
    onFileDeleted(path, isDirectory)
  }
}

onMounted(() => document.addEventListener('mousedown', closeCtxMenu))
onUnmounted(() => document.removeEventListener('mousedown', closeCtxMenu))
</script>

<template>
  <template v-for="entry in entries" :key="entry.path">
    <div
      class="file-item"
      :class="{
        'is-dir': entry.isDirectory,
        selected: selectedFiles.has(entry.path),
        'editor-open': !entry.isDirectory && isOpenInEditor(entry.path),
        'drop-target': dropTargetDir === entry.path,
      }"
      :style="{ paddingLeft: 8 + (depth || 0) * 14 + 'px' }"
      draggable="true"
      @click="onFileClick($event, entry)"
      @contextmenu="onFileContext($event, entry)"
      @dragstart="onDragStart($event, entry)"
      @dragover="onDirDragOver($event, entry)"
      @dragleave="onDirDragLeave($event, entry)"
      @drop="onDirDrop($event, entry)"
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
      <span v-if="renameState?.path === entry.path" class="rename-input-wrap" @click.stop>
        <input
          v-model="renameState.name"
          class="rename-input"
          @keydown="onRenameKeydown"
          @blur="confirmRename"
        />
      </span>
      <span v-else class="file-name">{{ entry.name }}</span>
    </div>

    <template v-if="entry.isDirectory && expandedDirs.has(entry.path)">
      <div v-if="newItemState && newItemState.parentDir === entry.path" class="new-item-row" :style="{ paddingLeft: 8 + ((depth || 0) + 1) * 14 + 'px' }">
        <svg v-if="newItemState.type === 'dir'" class="file-icon dir-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        <svg v-else class="file-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
        <input
          v-model="newItemState.name"
          class="new-item-input"
          :placeholder="newItemState.type === 'file' ? '文件名' : '文件夹名'"
          :ref="(el: any) => { if (el) nextTick(() => el.focus()) }"
          @keydown="onNewItemKeydown"
          @blur="confirmNewItem"
        />
      </div>
      <FileTreeNode
        v-if="dirChildren[entry.path]"
        :entries="dirChildren[entry.path]"
        :depth="(depth || 0) + 1"
      />
    </template>
  </template>

  <Teleport to="body">
    <div
      v-if="ctxMenu.visible"
      class="file-ctx-menu"
      :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
      @mousedown.stop
    >
      <button @click="ctxNewFile">新建文件</button>
      <button @click="ctxNewFolder">新建文件夹</button>
      <div class="ctx-divider"></div>
      <button @click="ctxRename">重命名</button>
      <button @click="showInFolder">在文件管理器中显示</button>
      <button v-if="isHtmlFile(ctxMenu.path)" @click="previewHtml">在浏览器中打开</button>
      <div class="ctx-divider"></div>
      <button class="danger" @click="deletePath">删除{{ ctxMenu.isDirectory ? '文件夹' : '文件' }}</button>
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
  background: var(--c-chrome-hover-bg);
}

.file-item.selected {
  background: var(--c-chrome-selected-bg);
  color: var(--c-text);
}

.file-item.selected .file-icon {
  color: var(--c-blue);
}

.file-item.selected .dir-icon {
  color: var(--c-yellow, #df8e1d);
}

/* 与主区域文件 tab 对应：当前正在编辑的文件 */
.file-item.editor-open:not(.selected) {
  background: var(--c-chrome-selected-bg);
  color: var(--c-text);
}

.file-item.editor-open:not(.selected) .file-icon {
  color: var(--c-green, #40a02b);
}

.file-item.drop-target {
  background: color-mix(in srgb, var(--c-blue) 21%, var(--c-chrome-bg));
  outline: 1px dashed var(--c-blue);
  outline-offset: -1px;
  border-radius: 5px;
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
  background: var(--c-chrome-hover-bg);
}

.file-ctx-menu button.danger {
  color: var(--c-red, #d20f39);
}

.ctx-divider {
  height: 1px;
  background: var(--c-surface1);
  margin: 3px 6px;
}

.new-item-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px 2px 8px;
  margin: 0 4px;
}

.new-item-input {
  flex: 1;
  min-width: 0;
  font-size: 0.78rem;
  font-family: inherit;
  color: var(--c-text);
  background: var(--c-base);
  border: 1px solid var(--c-blue, #1e66f5);
  border-radius: 4px;
  outline: none;
  padding: 2px 6px;
}

.rename-input-wrap {
  flex: 1;
  min-width: 0;
  display: flex;
}

.rename-input {
  flex: 1;
  min-width: 0;
  font-size: 0.78rem;
  font-family: inherit;
  color: var(--c-text);
  background: var(--c-base);
  border: 1px solid var(--c-blue, #1e66f5);
  border-radius: 4px;
  outline: none;
  padding: 2px 6px;
}
</style>
