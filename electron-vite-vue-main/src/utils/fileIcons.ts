// VSCode风格文件图标映射
// 图标资源放在 public/icons 目录下，所有图标均来自微软官方vscode-icons扩展

// 特殊文件名映射（优先级高于扩展名）
const specialFileMap: Record<string, string> = {
  'package.json': 'npm',
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'package-lock.json': 'npm',
  'tsconfig.json': 'tsconfig',
  'vite.config.ts': 'vite',
  'vite.config.js': 'vite',
  'webpack.config.js': 'webpack',
  'rollup.config.js': 'rollup',
  '.eslintrc.js': 'eslint',
  '.eslintrc': 'eslint',
  '.prettierrc': 'prettier',
  'prettier.config.js': 'prettier',
  'Dockerfile': 'docker',
  'docker-compose.yml': 'docker',
  '.gitignore': 'git',
  'README.md': 'markdown',
}

// 扩展名图标映射
const extMap: Record<string, string> = {
  'js': 'js',
  'ts': 'typescript',
  'vue': 'vue',
  'html': 'html',
  'css': 'css',
  'scss': 'scss',
  'sass': 'sass',
  'less': 'less',
  'json': 'json',
  'md': 'markdown',
  'py': 'python',
  'java': 'java',
  'go': 'go',
  'php': 'php',
  'rs': 'rust',
  'rb': 'ruby',
  'txt': 'text',
  'xml': 'xml',
  'svg': 'svg',
  'png': 'image',
  'jpg': 'image',
  'jpeg': 'image',
  'gif': 'image',
  'webp': 'image',
  'mp4': 'video',
  'mp3': 'audio',
  'pdf': 'pdf',
  'zip': 'zip',
  'rar': 'zip',
  '7z': 'zip',
  'tar': 'zip',
  'gz': 'zip',
}

// 获取文件图标路径
export function getFileIcon(fileName: string, isDirectory = false, isExpanded = false): string {
  if (isDirectory) {
    return `/icons/default_folder${isExpanded ? '_opened' : ''}.svg`
  }
  
  // 先匹配特殊文件名
  if (specialFileMap[fileName]) {
    return `/icons/file_type_${specialFileMap[fileName]}.svg`
  }
  
  // 匹配扩展名
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  if (ext && extMap[ext]) {
    return `/icons/file_type_${extMap[ext]}.svg`
  }
  
  // 默认文件图标
  return '/icons/default_file.svg'
}
