<script setup lang="ts">
import { inject } from 'vue'

defineProps<{
  entries: FileEntry[]
  depth?: number
}>()

const expandedDirs = inject<Set<string>>('fileTree:expandedDirs')!
const dirChildren = inject<Record<string, FileEntry[]>>('fileTree:dirChildren')!
const toggleDir = inject<(path: string) => void>('fileTree:toggleDir')!
</script>

<template>
  <template v-for="entry in entries" :key="entry.path">
    <div
      class="file-item"
      :class="{ 'is-dir': entry.isDirectory }"
      :style="{ paddingLeft: 8 + (depth || 0) * 14 + 'px' }"
      @click="entry.isDirectory && toggleDir(entry.path)"
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
</template>

<style scoped>
.file-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px 3px 8px;
  cursor: default;
  border-radius: 5px;
  margin: 0 4px;
  font-size: 0.78rem;
  color: var(--c-subtext0);
  transition: background 0.12s;
  white-space: nowrap;
  overflow: hidden;
}

.file-item.is-dir {
  cursor: pointer;
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
</style>
