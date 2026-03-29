<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { getFileIcon } from '../utils/fileIcons'

const props = defineProps<{
  visible: boolean
  projectPath: string | null
}>()

const emit = defineEmits<{
  close: []
  selectFile: [filePath: string]
}>()

const query = ref('')
const results = ref<{ path: string; name: string; dir: string }[]>([])
const selectedIndex = ref(0)
const loading = ref(false)
const inputRef = ref<HTMLInputElement>()

const displayResults = computed(() => results.value.slice(0, 20))

async function searchFiles() {
  if (!props.projectPath || !query.value.trim()) {
    results.value = []
    return
  }
  
  loading.value = true
  try {
    const items = await window.fsApi.searchFiles(props.projectPath, query.value.trim())
    results.value = items
    selectedIndex.value = 0
  } catch (e) {
    console.error('Search failed:', e)
    results.value = []
  } finally {
    loading.value = false
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    emit('close')
    return
  }
  
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    selectedIndex.value = Math.min(selectedIndex.value + 1, displayResults.value.length - 1)
    return
  }
  
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    selectedIndex.value = Math.max(selectedIndex.value - 1, 0)
    return
  }
  
  if (e.key === 'Enter' && displayResults.value[selectedIndex.value]) {
    e.preventDefault()
    selectFile(displayResults.value[selectedIndex.value].path)
    return
  }
}

function selectFile(filePath: string) {
  emit('selectFile', filePath)
  emit('close')
}

let searchTimer: ReturnType<typeof setTimeout> | null = null

watch(query, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(searchFiles, 150)
})

watch(() => props.visible, async (visible) => {
  if (visible) {
    query.value = ''
    results.value = []
    selectedIndex.value = 0
    await nextTick()
    inputRef.value?.focus()
  }
})

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
  if (searchTimer) clearTimeout(searchTimer)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="visible" class="dialog-overlay" @click.self="emit('close')">
        <div class="dialog-container">
          <div class="dialog-input-wrapper">
            <svg class="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              ref="inputRef"
              v-model="query"
              type="text"
              class="dialog-input"
              placeholder="搜索文件名..."
              @keydown="handleKeydown"
            />
            <span v-if="loading" class="loading-indicator">搜索中...</span>
          </div>
          
          <div v-if="!projectPath" class="dialog-empty">
            请先打开项目
          </div>
          
          <div v-else-if="query && !displayResults.length && !loading" class="dialog-empty">
            未找到匹配文件
          </div>
          
          <ul v-else-if="displayResults.length" class="dialog-results">
            <li
              v-for="(item, idx) in displayResults"
              :key="item.path"
              class="result-item"
              :class="{ selected: idx === selectedIndex }"
              @click="selectFile(item.path)"
              @mouseenter="selectedIndex = idx"
            >
              <img class="file-icon" :src="getFileIcon(item.name)" width="14" height="14" alt="file icon" />
              <span class="file-name">{{ item.name }}</span>
              <span class="file-dir">{{ item.dir }}</span>
            </li>
          </ul>
          
          <div v-else class="dialog-hint">
            输入文件名进行模糊搜索
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: var(--c-overlay-bg);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 15vh;
  z-index: 1000;
}

.dialog-container {
  width: 520px;
  max-width: 90vw;
  background: var(--c-chrome-bg);
  border-radius: 10px;
  box-shadow: 0 8px 32px var(--c-shadow-heavy);
  overflow: hidden;
}

.dialog-input-wrapper {
  display: flex;
  align-items: center;
  padding: 12px 14px;
  border-bottom: 1px solid var(--c-surface0);
  gap: 10px;
}

.search-icon {
  flex-shrink: 0;
  color: var(--c-subtext0);
}

.dialog-input {
  flex: 1;
  border: none;
  background: transparent;
  font-size: 15px;
  color: var(--c-text);
  outline: none;
}

.dialog-input::placeholder {
  color: var(--c-overlay0);
}

.loading-indicator {
  font-size: 12px;
  color: var(--c-subtext0);
}

.dialog-results {
  list-style: none;
  margin: 0;
  padding: 4px 0;
  max-height: 320px;
  overflow-y: auto;
}

.result-item {
  display: flex;
  align-items: center;
  padding: 8px 14px;
  gap: 8px;
  cursor: pointer;
  transition: background 0.1s;
}

.result-item:hover,
.result-item.selected {
  background: var(--c-chrome-hover-bg);
}

.result-item.selected {
  background: var(--c-chrome-selected-bg);
}

.file-icon {
  flex-shrink: 0;
  color: var(--c-subtext0);
}

.file-name {
  color: var(--c-text);
  font-size: 13px;
}

.file-dir {
  color: var(--c-subtext0);
  font-size: 12px;
  margin-left: auto;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dialog-empty,
.dialog-hint {
  padding: 24px 14px;
  text-align: center;
  color: var(--c-subtext0);
  font-size: 13px;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}

.fade-enter-active .dialog-container,
.fade-leave-active .dialog-container {
  transition: transform 0.15s ease, opacity 0.15s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.fade-enter-from .dialog-container,
.fade-leave-to .dialog-container {
  transform: translateY(-10px);
  opacity: 0;
}
</style>
