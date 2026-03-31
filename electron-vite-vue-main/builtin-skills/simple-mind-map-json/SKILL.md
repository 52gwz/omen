---
name: simple-mind-map-json
description: 思维导图 JSON 文件的创建与编辑规范。当需要新建或修改 `.json` 思维导图文件时，必须遵循此 skill 以生成符合校验规则的数据结构。触发关键词：思维导图、脑图、mind map、mindmap。
---

# SimpleMindMap JSON 创建与编辑规范

## 概述

在编辑器中，`.json` 文件可切换到思维导图预览模式，底层使用 [simple-mind-map](https://github.com/wanglin2/mind-map) 库渲染。

## 校验规则

编辑器通过 `parseMindMapData()` 校验 JSON，必须满足：

1. 文件内容是**合法 JSON**（双引号、无尾逗号、UTF-8）
2. 根对象包含 **`data`** 属性，且 **`data.text` 为字符串**
3. 子节点放在 **`children`** 数组中，每项递归遵循同样结构

## 节点结构

每个节点的标准形态：

```json
{
  "data": {
    "text": "节点标题"
  },
  "children": []
}
```

### `data` 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `text` | string | **是** | 节点显示文案 |
| `note` | string | 否 | 备注内容 |
| `hyperlink` | string | 否 | 链接 URL |
| `hyperlinkTitle` | string | 否 | 链接标题 |
| `image` | string | 否 | 图片 URL |
| `imageSize` | object | 否 | `{ "width": number, "height": number }` |
| `icon` | string[] | 否 | 图标列表 |
| `tag` | string[] | 否 | 标签列表 |
| `expand` | boolean | 否 | 子节点是否展开，省略即默认展开 |
| `richText` | boolean | 否 | 是否富文本 HTML，默认 false |

**禁止手动填写的字段**（运行时库自动生成，保存时编辑器会剥离）：
- `uid` — 库自动分配
- `isActive` — 选中态
- `smmVersion` — 版本标记

## 完整示例

### 最小可用文件

```json
{
  "data": {
    "text": "项目规划"
  },
  "children": [
    {
      "data": { "text": "第一阶段" },
      "children": []
    },
    {
      "data": { "text": "第二阶段" },
      "children": []
    }
  ]
}
```

### 带备注和链接的文件

```json
{
  "data": {
    "text": "技术选型"
  },
  "children": [
    {
      "data": {
        "text": "前端框架",
        "note": "综合考虑生态和性能"
      },
      "children": [
        {
          "data": {
            "text": "Vue 3",
            "hyperlink": "https://vuejs.org",
            "hyperlinkTitle": "Vue.js 官网",
            "tag": ["推荐"]
          },
          "children": []
        },
        {
          "data": { "text": "React" },
          "children": []
        }
      ]
    },
    {
      "data": { "text": "后端" },
      "children": [
        {
          "data": { "text": "Node.js" },
          "children": []
        }
      ]
    }
  ]
}
```

## Agent 操作规范

### 新建思维导图

1. 创建 `.json` 文件
2. 写入符合上述结构的 JSON，根节点必须有 `data.text`
3. 每个节点都显式包含 `children`（即使为空数组），保证结构一致性
4. 使用 2 空格缩进、格式化输出

### 编辑已有思维导图

1. **先读取文件**，获取当前完整 JSON
2. 解析为对象后修改节点树
3. 写回时**保留原有未修改节点的所有字段**，只改动目标部分
4. 不要添加 `uid`、`isActive`、`smmVersion` 等运行时字段

### 常见错误（必须避免）

| 错误 | 正确做法 |
|------|----------|
| 省略 `data` 直接写 `{ "text": "xxx" }` | 始终用 `{ "data": { "text": "xxx" }, "children": [] }` |
| `children` 写成 `null` 或省略 | 写成空数组 `[]` |
| 使用单引号 | 必须用双引号（标准 JSON） |
| 末尾多余逗号 | 严格 JSON，无尾逗号 |
| 写入 `uid` 或 `isActive` | 不写，让库运行时自动生成 |
| 把 Markdown 标题层级当思维导图格式 | `.json` 用本 skill 的树形结构，`.md` 用 markmap |

### 内容组织建议

- 根节点文案作为主题标题，简明扼要
- 第一层子节点作为主要分支（3-7 个为佳）
- 叶子节点文案保持精炼，长文本放 `note` 字段
- 层级不宜超过 4-5 层，过深时考虑拆分为多张脑图

## 与 Markdown 思维导图对比

| 项 | JSON（本 skill） | Markdown（markmap） |
|----|------------------|---------------------|
| 扩展名 | `.json` | `.md` |
| 内容 | 树形 JSON 对象 | Markdown 标题与列表 |
| 预览组件 | `SimpleMindMapView` | `MindMapView` |
| 可交互编辑 | 支持（拖拽、增删节点） | 只读预览 |
| 适用场景 | 需要交互式编辑的脑图 | 从已有文档快速生成预览 |
