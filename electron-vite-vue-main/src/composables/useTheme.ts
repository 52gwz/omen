import { ref } from 'vue'

export type Theme = 'light' | 'dark'

const theme = ref<Theme>((localStorage.getItem('omen-theme') as Theme) || 'light')

function apply(t: Theme) {
  document.documentElement.setAttribute('data-theme', t)
  localStorage.setItem('omen-theme', t)
}

apply(theme.value)

export function useTheme() {
  function toggleTheme() {
    theme.value = theme.value === 'light' ? 'dark' : 'light'
    apply(theme.value)
  }

  return { theme, toggleTheme }
}
