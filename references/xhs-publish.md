# 小红书创作平台 · 推送与排错

> 实测环境：creator.xiaohongshu.com 发布页，macOS + Chrome 调试实例（1512 宽窗口）。

## 一、主流程（本仓库 xhs_push_direct.mjs 的路径）

```
导航发布页 → 切「上传图文」tab → 注入图片 → 填标题 → 填正文 → 点底部按钮 → 内容落入草稿箱
```

**定位**：把内容「填好、存进草稿箱」；**发布动作由人工在 App / 网页上完成**。

### 技术要点

| 步骤 | 做法 | 为什么 |
|---|---|---|
| 注入图片 | base64 → `File` 对象 → `DataTransfer.items.add` → `input.upload-input.files = dt.files` → 派发 `change` | 不用拖拽、不用原生文件框；后台标签也稳定 |
| 图片就绪计数 | 读页面文本 `图片编辑 n/m` | 比数 `img` 元素可靠 |
| 标题 | 原生 setter：`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, text)` + `input` 事件 | 受控组件，直接 `el.value=` 不触发框架更新 |
| 正文 | `.tiptap.ProseMirror`，**逐行** `execCommand('insertText')` + 行间 `execCommand('insertParagraph')` | 一次性塞多行会被吞段落 |
| 内容区就绪判据 | `input.upload-input` 存在、`.tiptap.ProseMirror` 存在 | 用于 waitFor 轮询 |

## 二、「发布」按钮的真相（全托管场景才需要）

> ⚠️ 本仓库的定位是**推草稿、不发布**。以下技法是为「你确实需要自动化点发布」的进阶场景准备的
> （例如你自己搭的全自动流程）——按下发布键之前，请自行确认内容与合规。

**核心事实**：发布页的「发布」按钮是 **`<xhs-publish-btn>` 自定义元素内闭包 Shadow DOM 的 sub-button**：

- `el.shadowRoot` → null（不可访问）
- `el.innerHTML` → 空
- `el.querySelectorAll('button')` → 0 个
- 任何文字匹配 / JS `.click()` / 代理点击 → 全部无效或假阳性

### 唯一可靠的解法：marker + 真实鼠标（trusted hit-testing）

闭包 shadow DOM 不影响浏览器渲染和命中测试——**真实鼠标事件**（`Input.dispatchMouseEvent`）
能穿透到 shadow 里的按钮触发其 handler。难点是把坐标对准看不见的按钮：

1. 取 host 位置：`document.querySelector('xhs-publish-btn').getBoundingClientRect()`
2. 算「发布」按钮中心（实测常量）：
   ```js
   var cx = r.left + r.width * 0.59;
   var cy = r.top  + r.height * 0.5;
   ```
3. 放一个 `pointer-events:none` 的透明 marker 占住该坐标（z-index 最高）
4. 对 marker 坐标发真实鼠标事件（`mousePressed` + `mouseReleased`）→ 事件穿透到 shadow 按钮
5. 安全校验：点击前 `elementFromPoint(cx, cy)` 确认目标不是侧边栏 `.publish-video`（改版可能偏移）
6. 验证：URL 跳到 `/publish/success`，页面出现「发布成功 5 秒后返回」

**改版后重新校准**：放一个可见 marker（`border:3px solid red`）→ 截图 → 肉眼核对是否盖住按钮 → 调 x_offset。

### ground truth（发布是否真成功）

- 脚本自报「OK」不算数——白名单：① URL 离开编辑页到 `/publish/success` ② 次日后台数据里出现该标题
- 教训：只收到「clicked」字符串就返回成功的脚本，可能全是假阳性

## 三、风控与拟人化（务必保持）

- **单篇单发**，不要并发多 tab
- 填标签/字段之间留 ~1s 间隔
- **异常熔断**：找不到按钮 / 弹验证码 → 立即停手、记日志，不硬刚
- 不自动化「发布」以外的互动行为（点赞/关注等），本仓库不做

## 四、失败排查清单

1. **CDP 在否？** `node scripts/cdp.mjs list` 看标签
2. **登录在否？** 页面 `document.title` 是否含「创作服务平台」
3. **表单填进去了？** `document.querySelector('.tiptap.ProseMirror').textContent.length`
4. **host 在否？** `document.querySelector('xhs-publish-btn')` 应非 null（全托管场景）
5. **marker 精准吗？** 放可见 marker 截图肉眼核对（改版后坐标常量会偏移）
6. **截图辅助**：`node scripts/cdp.mjs shot /tmp/xhs.png` 存本地对比

## 五、素材命名约定（xhs_push_direct.mjs 读取）

```
内容目录/
├── 封面-主.png      ← 可选；存在则排在图序第一位（小红书封面）
├── img/            ← 内页图，按文件名排序（01-xxx.png, 02-xxx.png ...）
├── 标题.txt         ← 第一行即标题（--title 可覆盖）
└── 文案.txt         ← 正文
```
