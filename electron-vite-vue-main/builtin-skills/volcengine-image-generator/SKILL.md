---
name: volcengine-image-generator
description: 基于火山引擎豆包文生图模型生成图像。支持 Seedream 4.0/4.5/5.0（方舟API）和通用3.0、即梦3.0/3.1（视觉API），提供成本管理、缓存、批量生成。当用户需要生成图像、AI绘画、文生图、图生图时使用此技能。
---

# 火山引擎图像生成

基于豆包文生图模型的高质量图像生成，支持方舟 API（Seedream 4.0/4.5/5.0）和视觉 API（通用/即梦）。

## ⚠️ 执行流程（必须严格按顺序）

### 第一步：用 Shell 命令检查 API Key 是否已配置

根据用户选择的模型，在终端中执行对应的检查命令。**不要跳过这一步，不要用 Python 检查。**

**方舟 API 模型**（seedream_v40 / seedream_v45 / seedream_v50）：

```bash
echo "ARK_API_KEY=${ARK_API_KEY:-(未设置)}"
cat ~/.volcengine/config.json 2>/dev/null || echo "配置文件不存在"
```

**视觉 API 模型**（general_v30 / jimeng_v30 / jimeng_v31）：

```bash
echo "VOLC_ACCESS_KEY=${VOLC_ACCESS_KEY:-(未设置)}" && echo "VOLC_SECRET_KEY=${VOLC_SECRET_KEY:-(未设置)}"
cat ~/.volcengine/config.json 2>/dev/null || echo "配置文件不存在"
```

### 第二步：如果 Key 缺失，引导用户永久配置

如果上一步检测到 Key 未设置（环境变量和配置文件都没有），**必须先引导用户配置，不要直接执行生成脚本**。

告知用户获取 Key 的方式：
- **方舟 API Key**：[火山方舟控制台](https://console.volcengine.com/ark) → API Key 管理 → 创建或复制
- **视觉 API Key**：[火山引擎控制台](https://console.volcengine.com/) → 头像 → 密钥管理

用户提供 Key 后，帮用户写入 shell 配置文件以实现**永久生效**：

```bash
# 方舟 API — 写入 ~/.zshrc（macOS 默认 zsh）
echo 'export ARK_API_KEY="用户提供的key"' >> ~/.zshrc
source ~/.zshrc

# 视觉 API — 写入 ~/.zshrc
echo 'export VOLC_ACCESS_KEY="用户提供的ak"' >> ~/.zshrc
echo 'export VOLC_SECRET_KEY="用户提供的sk"' >> ~/.zshrc
source ~/.zshrc
```

> 如果用户使用 bash，则写入 `~/.bashrc` 或 `~/.bash_profile`。

写入后，再次执行第一步的检查命令，确认 Key 已生效，然后才进入第三步。

### 第三步：执行图像生成

确认 Key 存在后，才执行 Python 脚本生成图像。所有命令需 `cd` 到此 skill 目录下执行：

```bash
# 文生图（默认 Seedream 4.0）
python scripts/generate_image.py --prompt "一只可爱的橘猫在阳光下打盹" --output cat.png

# 使用 Seedream 5.0（最新版本，效果最佳）
python scripts/generate_image.py --prompt "壮丽的日落海边风景" --model seedream_v50 --size 2K --output sunset.png

# 使用 Seedream 4.5
python scripts/generate_image.py --prompt "高清风景画" --model seedream_v45 --size 2K --output landscape.png

# 使用即梦 3.1
python scripts/generate_image.py --prompt "动漫风格少女" --model jimeng_v31 --output anime.png

# 列出所有模型
python scripts/generate_image.py --list-models
```

## 支持的模型

### 方舟 API 模型（推荐）

| 模型名称 | 模型ID | 特点 |
|---------|--------|------|
| `seedream_v40` | doubao-seedream-4-0-250828 | 组图生成、多模态输入、图像编辑 |
| `seedream_v45` | doubao-seedream-4-5-251128 | 效果优秀，支持4K |
| `seedream_v50` | doubao-seedream-5-0-260128 | 最新版本，跨模态理解增强、精准指令遵循、联网检索 |

### 视觉 API 模型

| 模型名称 | req_key | 特点 |
|---------|---------|------|
| `general_v30` | high_aes_general_v30l_zt2i | 高清大图、逼真人像、文字响应 |
| `jimeng_v30` | jimeng_t2i_v30 | 即梦同源、文字排版、层次美感 |
| `jimeng_v31` | jimeng_t2i_v31 | 画面美感升级、风格多样 |

## 使用示例

### 指定尺寸

```bash
python scripts/generate_image.py --prompt "风景照" --ratio 16:9 --output landscape.png
python scripts/generate_image.py --prompt "高清人像" --size 2K --output portrait.png
python scripts/generate_image.py --prompt "产品图" --size 1920x1080 --output product.png
```

### 参考图生图（方舟 API）

```bash
python scripts/generate_image.py --prompt "将这只猫变成水彩画风格" \
  --reference-images https://example.com/cat.jpg \
  --output watercolor_cat.png
```

### 开启文本扩写（视觉 API）

```bash
python scripts/generate_image.py --prompt "咖啡店" --model jimeng_v31 --use-pre-llm --output coffee.png
```

## 成本管理

### 预览模式

先生成低分辨率预览，满意后再生高清：

```bash
python scripts/generate_image.py --prompt "一只可爱的橘猫" --preview
python scripts/generate_image.py --prompt "一只可爱的橘猫" --quality hd
```

### 质量级别

| 级别 | 分辨率 | 适用场景 |
|------|--------|----------|
| `preview` | 512×512 | 快速预览，成本最低 |
| `standard` | 1024×1024 | 标准使用（默认） |
| `hd` | 2048×2048 | 高清输出 |
| `4k` | 4096×4096 | 超高清输出 |

### 缓存与成本估算

```bash
# 缓存默认开启，相同提示词直接返回缓存结果
python scripts/generate_image.py --prompt "一只猫" --no-cache   # 禁用缓存
python scripts/generate_image.py --clear-cache                   # 清理缓存

# 成本估算（不实际生成）
python scripts/generate_image.py --prompt "一只猫" --estimate-cost --quality hd
```

### 风格模板

```bash
python scripts/generate_image.py --prompt "赛博朋克城市夜景" --save-style cyberpunk --model seedream_v45
python scripts/generate_image.py --style cyberpunk --prompt "未来都市" --output city.png
python scripts/generate_image.py --list-styles
python scripts/generate_image.py --delete-style cyberpunk
```

### 批量生成

```bash
python scripts/generate_image.py --batch prompts.txt --output-dir ./output
```

## 参数速查

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--prompt, -p` | 图像描述提示词 | 必填 |
| `--output, -o` | 输出文件路径 | output.png |
| `--model, -m` | 生成模型 | seedream_v40 |
| `--size, -s` | 图像尺寸（1024x1024、2K、4K） | 1024x1024 |
| `--ratio, -r` | 预设比例（1:1、16:9、9:16 等） | - |
| `--seed` | 随机种子 | 随机 |
| `--reference-images` | 参考图片 URL 列表 | - |
| `--watermark` | 添加水印 | False |
| `--use-pre-llm` | 开启文本扩写（视觉 API） | False |
| `--scale` | 文本影响程度 1-10（视觉 API） | 2.5 |
| `--preview` | 预览模式（低分辨率） | False |
| `--quality, -q` | 质量级别：preview/standard/hd/4k | standard |
| `--no-cache` | 禁用缓存 | False |
| `--estimate-cost` | 仅估算成本 | False |
| `--save-style NAME` | 保存风格模板 | - |
| `--style NAME` | 使用风格模板 | - |
| `--batch FILE` | 批量生成提示词文件 | - |
| `--output-dir DIR` | 批量输出目录 | - |

## 预设尺寸

| 比例 | 尺寸 |
|------|------|
| 1:1 | 1024×1024 |
| 4:3 | 1024×768 |
| 16:9 | 1024×576 |
| 9:16 | 576×1024 |
| 21:9 | 1024×439 |
| 2K | 2048×2048 |
| 4K | 4096×4096 |

## 提示词优化

结构化模板：`[主体描述] + [场景环境] + [动作/状态] + [风格修饰] + [技术参数]`

示例：
- **人物肖像**：`一位优雅的女性，半身照，柔和的自然光，电影质感，8k分辨率`
- **产品图**：`一台复古咖啡机，放在木质桌面上，暖色调背景，商业摄影风格`
- **文字渲染**：在 prompt 中用引号包裹文字 → `一张圣诞节海报，上面写着"Merry Christmas"，红色和金色配色`

## 错误处理

| 错误 | 原因 | 解决方案 |
|------|------|----------|
| `InvalidEndpointOrModel.NotFound` | 模型未开通 | 在方舟控制台开通对应模型 |
| `SignatureDoesNotMatch` | 签名错误 | 检查 VOLC_ACCESS_KEY / VOLC_SECRET_KEY |
| `PermissionDenied` | 权限不足 | 检查服务是否开通 |
| `QuotaExceeded` | 配额不足 | 检查账户余额或申请扩容 |

脚本内置指数退避重试（最多3次），遇到超时或 429 限流会自动等待重试。

## 依赖

```bash
pip install requests
```

## 参考文档

- [Seedream 5.0 Lite API 参考](https://www.volcengine.com/docs/82379/1666946)
- [Seedream 5.0 Lite 示例教程](https://www.volcengine.com/docs/82379/1824121)
- [Seedream 4.0 教程](https://www.volcengine.com/docs/82379/1548482)
- [通用3.0 文生图](https://www.volcengine.com/docs/85128/1526761)
- [即梦文生图 3.1](https://www.volcengine.com/docs/85621/1756900)
- [签名机制](https://www.volcengine.com/docs/6461/1277764)
