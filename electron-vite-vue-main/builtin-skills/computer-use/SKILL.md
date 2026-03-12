---
name: computer-use
description: macOS 桌面自动化技能。用于截屏查看屏幕内容、控制鼠标和键盘、管理窗口和应用程序。触发场景包括"截个屏"、"点击屏幕上的某个按钮"、"打开某个应用"、"移动窗口"、"输入文字"、"查看屏幕上显示了什么"，以及任何需要与桌面 GUI 交互的任务。
---

# macOS 桌面自动化 (Computer Use)

通过 macOS 内置命令行工具和 cliclick 实现桌面级自动化控制，包括截屏、鼠标键盘操作和窗口管理。

## 前提条件

### cliclick（鼠标键盘控制）

```bash
brew install cliclick
```

> 如果 cliclick 未安装，鼠标/键盘操作将不可用，但截屏和 AppleScript 功能仍可正常使用。

### 辅助功能权限

首次使用时 macOS 会弹窗要求授予终端应用「辅助功能」权限：
**系统设置 → 隐私与安全性 → 辅助功能** → 添加终端应用（Terminal / iTerm / Omen）。

## 核心工作流

桌面自动化遵循「观察 → 行动 → 验证」循环：

1. **截屏**：`screencapture` 获取当前屏幕状态
2. **定位**：分析截图确定目标元素位置
3. **操作**：用 `cliclick` 执行点击/输入，或用 `osascript` 执行 UI 操作
4. **验证**：再次截屏确认操作结果

```bash
# 1. 截屏查看当前状态
screencapture -x /tmp/screen.png

# 2. 根据截图分析，点击目标位置
cliclick c:500,300

# 3. 输入文字
cliclick t:"Hello World"

# 4. 再次截屏验证结果
screencapture -x /tmp/screen_after.png
```

## 截屏命令

```bash
# 全屏截图（无快门声）
screencapture -x /tmp/screen.png

# 指定区域截图 (x,y,width,height)
screencapture -x -R 0,0,800,600 /tmp/region.png

# 指定窗口截图（交互式选择）
screencapture -x -w /tmp/window.png

# 延时截图（3秒后）
screencapture -x -T 3 /tmp/delayed.png

# 截图到剪贴板
screencapture -x -c

# 多显示器 - 每个显示器单独截图
screencapture -x /tmp/display1.png /tmp/display2.png

# 获取屏幕分辨率
system_profiler SPDisplaysDataType | grep Resolution
```

## 鼠标控制 (cliclick)

```bash
# 点击指定坐标
cliclick c:500,300           # 左键单击
cliclick dc:500,300          # 左键双击
cliclick tc:500,300          # 左键三击
cliclick rc:500,300          # 右键单击

# 移动鼠标（不点击）
cliclick m:500,300

# 拖拽
cliclick dd:100,200 du:300,400   # 从(100,200)拖到(300,400)

# 获取当前鼠标位置
cliclick p

# 相对坐标移动（相对当前位置）
cliclick m:+50,+30           # 向右50、向下30

# 组合操作
cliclick c:500,300 w:500 t:"search text"   # 点击 → 等待500ms → 输入文字
```

## 键盘控制 (cliclick)

```bash
# 输入文字
cliclick t:"Hello World"

# 按键（特殊键）
cliclick kp:return            # 回车
cliclick kp:tab               # Tab
cliclick kp:delete            # 删除
cliclick kp:escape            # Esc
cliclick kp:space             # 空格
cliclick kp:arrow-up          # 方向键 ↑
cliclick kp:arrow-down        # 方向键 ↓
cliclick kp:arrow-left        # 方向键 ←
cliclick kp:arrow-right       # 方向键 →
cliclick kp:page-up           # Page Up
cliclick kp:page-down         # Page Down
cliclick kp:home              # Home
cliclick kp:end               # End
cliclick kp:f1                # F1 (f1-f12)

# 修饰键 + 按键
cliclick kd:cmd t:"a"  ku:cmd          # Cmd+A（全选）
cliclick kd:cmd t:"c"  ku:cmd          # Cmd+C（复制）
cliclick kd:cmd t:"v"  ku:cmd          # Cmd+V（粘贴）
cliclick kd:cmd t:"z"  ku:cmd          # Cmd+Z（撤销）
cliclick kd:cmd t:"s"  ku:cmd          # Cmd+S（保存）
cliclick kd:cmd t:"w"  ku:cmd          # Cmd+W（关闭窗口）
cliclick kd:cmd t:"q"  ku:cmd          # Cmd+Q（退出应用）
cliclick kd:cmd,shift t:"3" ku:cmd,shift  # Cmd+Shift+3（系统截图）

# 等待（毫秒）
cliclick w:1000              # 等待1秒
```

修饰键标识：`cmd` `alt`（Option）`ctrl` `shift` `fn`

## 窗口与应用管理 (osascript)

### 打开 / 切换应用

```bash
# 打开应用
open -a "Safari"
open -a "Finder"
open -a "Terminal"

# 用默认应用打开文件
open /path/to/file.pdf
open https://example.com      # 用默认浏览器打开

# 激活（前台显示）指定应用
osascript -e 'tell application "Safari" to activate'
```

### 窗口信息

```bash
# 获取前台应用名称
osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'

# 获取窗口位置和大小
osascript -e 'tell application "System Events" to tell process "Safari" to get {position, size} of window 1'

# 列出所有窗口标题
osascript -e 'tell application "System Events" to get name of every window of every application process whose visible is true'
```

### 窗口操作

```bash
# 移动窗口
osascript -e 'tell application "System Events" to tell process "Safari" to set position of window 1 to {0, 0}'

# 调整窗口大小
osascript -e 'tell application "System Events" to tell process "Safari" to set size of window 1 to {1200, 800}'

# 最小化 / 关闭窗口
osascript -e 'tell application "Safari" to set miniaturized of window 1 to true'
osascript -e 'tell application "Safari" to close window 1'
```

### UI 元素交互 (AppleScript)

```bash
# 点击菜单项
osascript -e '
tell application "System Events"
  tell process "Safari"
    click menu item "New Window" of menu "File" of menu bar 1
  end tell
end tell'

# 点击按钮
osascript -e '
tell application "System Events"
  tell process "Safari"
    click button 1 of toolbar 1 of window 1
  end tell
end tell'

# 列出 UI 元素（调试用）
osascript -e '
tell application "System Events"
  tell process "Finder"
    get entire contents of window 1
  end tell
end tell'
```

## 剪贴板操作

```bash
# 读取剪贴板文本
pbpaste

# 写入文本到剪贴板
echo "Hello" | pbcopy

# 复制文件路径到剪贴板
echo "/path/to/file" | pbcopy
```

## 系统对话框与通知

```bash
# 显示对话框
osascript -e 'display dialog "操作完成" with title "提示"'

# 显示通知
osascript -e 'display notification "任务完成" with title "Omen"'

# 选择文件对话框
osascript -e 'choose file with prompt "请选择文件"'

# 选择文件夹对话框
osascript -e 'choose folder with prompt "请选择文件夹"'
```

## 常用场景

### 截屏并分析屏幕内容

```bash
screencapture -x /tmp/screen.png
# 然后用 read_file 读取截图交给视觉模型分析
```

### 自动填写表单

```bash
# 点击输入框 → 清空 → 输入内容 → Tab到下一个字段
cliclick c:400,300 w:200
cliclick kd:cmd t:"a" ku:cmd
cliclick t:"username"
cliclick kp:tab
cliclick t:"password"
cliclick kp:return
```

### 应用间切换操作

```bash
# 从当前应用复制内容到另一个应用
cliclick kd:cmd t:"a" ku:cmd     # 全选
cliclick kd:cmd t:"c" ku:cmd     # 复制
osascript -e 'tell application "TextEdit" to activate'
cliclick w:500
cliclick kd:cmd t:"v" ku:cmd     # 粘贴
```

### 自动化 Finder 操作

```bash
# 打开指定文件夹
open ~/Desktop

# 用 Finder 显示文件
open -R /path/to/file.txt

# 创建新 Finder 窗口并导航
osascript -e '
tell application "Finder"
  make new Finder window
  set target of Finder window 1 to folder "Desktop" of home
  activate
end tell'
```

### 获取系统信息

```bash
# 电量
pmset -g batt

# 音量
osascript -e 'output volume of (get volume settings)'

# 亮度
brightness -l 2>/dev/null || echo "需安装: brew install brightness"

# Wi-Fi 名称
networksetup -getairportnetwork en0

# 当前 macOS 版本
sw_vers
```

## 安全注意事项

- **截屏可能捕获敏感信息**：截图前提醒用户关闭含有密码、私钥等内容的窗口。
- **鼠标键盘操作不可逆**：执行点击、输入前说明将要做什么，等待用户确认。
- **避免操作系统关键设置**：不要自动修改安全偏好、磁盘加密等设置。
- **坐标精度**：不同分辨率和缩放比例下坐标可能不同，操作前先截屏确认。
- 建议在执行任何有副作用的桌面操作前，先截屏展示当前状态并向用户描述你将要执行的操作。

## 调试技巧

```bash
# 实时显示鼠标坐标（按 Ctrl+C 停止）
cliclick p && sleep 1 && cliclick p

# 验证 cliclick 是否安装
which cliclick || echo "未安装，请运行: brew install cliclick"

# 验证辅助功能权限
osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'
# 如果报错说明权限未授予

# 查看屏幕分辨率和缩放
system_profiler SPDisplaysDataType | grep -E "Resolution|Retina"
```
