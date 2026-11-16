# FontManager 设计统一规范

> 面向接手这个项目的同事：这份文档只回答一个问题 —— **「这个界面里，什么该跟什么一致，值是多少，代码写在哪」。**
>
> 它不重复描述功能（看 `FontManager-项目说明.md`），也不替代视觉稿（看 `docs/UI设计交付规格书.md`）。
> 它记的是**踩过坑之后定下来的硬约定**：每一条都配了代码位置和「为什么」，
> 因为下一代接手的人最容易犯的错不是不会写，而是不知道这里已经有结论了，于是一模一样的问题再修一遍。

**最后对齐版本**：2.3.0（2026-11-16）

---

## 0. 五分钟版

| 你在改什么 | 必须先读 |
|---|---|
| 侧栏里的任何一行、任何面板 | §2 行契约、§3 选中与悬停、§4 停靠面板 |
| 新加一个可滚动的容器 | §5 滚动条 |
| 新加一个输入框 / 搜索框 | §6 搜索框与光标 |
| 新加一个标签或图标 | §7 圆点语义 |
| 新加右键菜单项 | §8 菜单 |
| 设置面板加设置项 | §9 设置面板 |
| 用颜色 / 字号 / 时长 | §1 设计令牌 |

三条最容易违反的：

1. **不要引入新的字号**（§2.1）。字阶只有 9 / 11 / 13，多一档视觉上立刻能看出来。
2. **不要给滚动容器单独写滚动条样式**（§5）。全局一条规则统一管，个别覆盖就是「有的地方粗、有的地方细」的来源。
3. **不要用 `:hover` 控制面板展开/收起**（§4.4）。必须走 `lib/dockHover.ts`，否则两个面板会互相把对方推走。

---

## 1. 设计令牌

### 1.1 颜色

所有颜色走三层，**任何地方都不许出现裸的 `#RRGGBB`**（三处例外见 1.3）：

```
--qb-*     （底层原色，:root 与 :root[data-theme="light"] 各一套）  app.css:6168 / 6181
   ↓
--ui-*     （语义令牌，UI 只认这一层）                              app.css:7834
   ↓
组件样式
```

| 令牌 | 暗色 | 亮色 | 用途 |
|---|---|---|---|
| `--ui-bg` | `#111110` | `#fafaf8` | 窗口 / 主区 / 侧栏底色 |
| `--ui-fg` | `#f2f2ef` | `#141412` | 主文字、选中行文字 |
| `--ui-fg-2` | `#9a9a94` | `#6b6b66` | 次级文字（未选中的侧栏行） |
| `--ui-fg-3` | `#666660` | `#9b9b95` | 三级文字、计数、图标默认 |
| `--ui-line` | `#2a2a27` | `#e2e2dd` | 发丝线（1px 分隔线） |
| `--ui-hover` | `#1c1c1a` | `#f1f1ed` | **悬停底 + 选中底** |
| `--ui-accent` | `#5b8cff` | `#1b4fe0` | **唯一强调色**：选中竖线、焦点环 |
| `--ui-menu` | `#1c1c1a` | `#ffffff` | 菜单底 |

```css
/* app.css:7834 */
:root {
  --ui-bg: var(--qb-bg);
  --ui-fg: var(--qb-fg);
  --ui-fg-2: var(--qb-fg-2);
  --ui-fg-3: var(--qb-fg-3);
  --ui-line: var(--qb-hair);
  --ui-hover: var(--qb-hover);
  --ui-accent: var(--qb-accent);
}
```

**为什么强调「单一强调色」**：这个界面刻意没有红色 / 绿色语义色，只有「当前行」用蓝色标。
一旦有人加一个「成功绿」，整套就散了 —— 用户会开始问「这个绿是什么意思」。

### 1.2 字号

```css
/* design/tokens.css:64 */
--fs-9: 9px;   --fs-10: 10px;  --fs-11: 11px;  --fs-13: 13px;
--fs-14: 14px; --fs-16: 16px;  --fs-20: 20px;  --fs-28: 28px;
--fs-40: 40px; --fs-56: 56px;
```

**新增代码只允许用这三个档**，分配如下（偏离这张表就是「字号不一致」的来源）：

| 档位 | 用途 | 典型 |
|---|---|---|
| `--fs-9` | 分区小标题（全大写、加宽字距） | `.tag-ns-row`、`.tag-subheading` |
| `--fs-11` | **主体**：所有行名、行尾计数、面板标题、按钮、输入框、说明文字 | `.nav-row`、`.tag-row`、`.tag-dock-head` |
| `--fs-13` | 面板大标题、导航项 | `.set-nav-row`、`.set-head-title` |
| `--fs-16` 及以上 | 标题 / 数字艺术 | 卡片族名、About |

**历史遗留、不要照抄**（现有代码里有，但新代码不要用）：

| 值 | 用在哪 | 判断 |
|---|---|---|
| `12px` | `.online-card .card-name`、插件组行的 `.settings-label`、菜单「无匹配」提示 | 卡片名/提示语属于「不是一行文字」的场合，暂留 |
| `14px` | `.settings-label` 默认值（设置卡片里的设置项名称） | 设置页是独立页面、留白大，14px 可接受 |
| `22 / 24px` | `.about-name` | About 页的展示性大标题 |
| `8px` | `.app-badge-wide`、键帽、计数器 | 徽标类，视觉上就是「小方块里的字」 |

改这些之前先想清楚：它们**不是**「行」，所以不受 §2 的行契约约束。
但只要它出现在侧栏 / 面板的列表里，就必须是 11px。

**关键约定：`--fs-11` 是「一行文字」的唯一正确字号。** 不管这行是侧栏导航、标签、分组、还是面板头部，
一律 11px；**主次靠字重与颜色区分，不靠字号**。

```css
/* 侧栏行（app.css:7911 的定版覆盖） */
.nav-row { height: 32px; font-size: 11px; color: var(--ui-fg-2); }

/* 标签行 / 分组行（app.css:10608） */
.tag-row, .tag-group-row {
  height: 25px;
  font-size: var(--fs-11);   /* 必须与 .nav-row 实际生效值一致 */
  font-weight: 500;
}
```

> ⚠️ **`app.css` 里同一个选择器常常定义两次**（一次在 200 行附近的原稿，一次在 7800 行之后的「视觉对齐 R4」追加覆盖段，
> 还有一次在 10400 行之后的 2.3.0 新增段）。**后写的赢**，所以量字号/颜色时用 grep 找出全部定义，取最后那一条。
> `.nav-row` 就是典型：基础段写 `--fs-13`，7913 行覆盖成 `11px`；只按基础段对齐，标签行会大一整档。

### 1.3 三处「刻意不打令牌」的例外

| 令牌 | 值 | 为什么 |
|---|---|---|
| `--caret-blue` | `#4c8dff` / 亮色 `#2f6bdb` | 用户点名要的块状光标蓝，**只给自绘光标用**，不要当强调色 |
| `--expiry-red` | `#e5484d` | 标签到期小字，用户点名要真红，**不要当通用错误色** |
| `--font-pending` | `#e08a72` | 「这段字还不是真字体」的提示色 |

### 1.4 圆角

- 行：**0**（直角）。`.nav-row`、`.tag-row`、`.tag-dock-head` 全是 0。
- 卡片 / 面板 / 菜单：8–10px。
- 胶囊（chip、筛选胶囊）：`999px`。
- 牌坊（快捷栏）：`var(--qb-radius, 8px)` —— **`--qb-radius` 由 JS 按 DPR 算出来写进去，永远不要改成固定值**（改了 1x 屏上圆角会胖一圈）。

### 1.5 动效

```css
/* design/tokens.css:80 */
--t-micro: 100ms;   /* 颜色、透明度、hover */
--t-quick: 180ms;   /* 小位移、图标变形 */
--t-state: 260ms;   /* 状态切换（开关、选中） */
--t-layout: 400ms;  /* 布局尺寸 */
--t-scene: 600ms;   /* 场景级（弹层入场） */
```

系统「减少动效」时这几个令牌全部被改写成 `1ms`（tokens.css:343），**所以写死毫秒数就绕过了无障碍设置**。
唯一允许的例外：停靠面板的 `height 110ms`（§4.3）—— 它不是装饰动效，是「悬停展开」的即时反馈，
用 260ms 会显得拖沓；且它不参与场景动画。

---

## 2. 行契约（Row Contract）

侧栏里所有的「一行」视觉上必须是同一个东西。这是用户反复指出的问题（「标签和分组这个字还是有点大」、
「和下面的视觉上来说还是不对」）。

### 2.1 必守的六个数值

| 属性 | 值 | 说明 |
|---|---|---|
| 高度 | `32px` | 面板头部与侧栏行一致；面板**内部**的标签行是 25px（见 §2.2） |
| 左右内距 | `11px` | padding-left 与 padding-right 都是 11px |
| 图标 | `15px` / `strokeWidth 1.5` | 13px + 1.6 是旧值，和侧栏并排一眼能看出不是一家 |
| 字号 | `--fs-11` | 见 §1.2 |
| 字重 | `500` | 不是 600。600 只在 `--fs-9` 的小标题上用 |
| 圆角 | `0` | 直角 |

```tsx
// 图标：15 / 1.5
<TagIcon size={15} strokeWidth={1.5} className="tag-dock-icon" />
<FolderOpen size={15} strokeWidth={1.5} className="tag-dock-icon" />
```

### 2.2 为什么面板内部的行是 25px

`.tag-row` 是**面板内部**的密集列表，一行 25px；`.tag-dock-head` 是**侧栏列里的一行**，32px。
两者高度不同是刻意的（面板里要塞十几行），但**字号、字重、图标、圆角必须一致** —— 差这几项才是「不是一家」。

### 2.3 分隔线

| 位置 | 值 |
|---|---|
| 面板上沿（收起） | `1px solid rgba(var(--ink-rgb), 0.05)`（= `.sidebar-footer` 同款） |
| 面板上沿（展开） | `rgba(var(--ink-rgb), 0.12)` |
| 卡片底栏 | `rgba(var(--ink-rgb), 0.07)` |

不要用 `--ui-line`（`#2a2a27`）做侧栏分隔线：它比 5% 白重得多，会显得面板被「框」起来。

---

## 3. 选中与悬停

### 3.1 唯一一套选中态

```css
/* 侧栏行（app.css:7911 定版段） */
.nav-row.nav-active,
.nav-row.nav-active:hover {
  background: var(--ui-hover);
  color: var(--ui-fg);
}
.nav-row.nav-active::before {
  content: "";
  position: absolute;
  left: 0; top: 0;
  width: 2px; height: 32px;
  background: var(--ui-accent);
}
```

标签行、（未来的）任何行都照抄这一套：

```css
/* app.css:10640 */
.tag-row.sel {
  background: var(--ui-hover);
  color: var(--text-primary);
}
.tag-row.sel::before {
  content: "";
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 2px;
  background: var(--ui-accent);
  z-index: 1;
}
```

**四条不许改的细节**：

1. 底色是 `--ui-hover`（浅灰），**不是** `color-mix(--ui-accent N%)`。
   做过一版淡蓝底，用户的原话是「颜色太深了，应该和点击『已启用』这里是一样的」——
   同一个软件里两套选中色，用户一定会发现。
2. 竖线永远是 `--ui-accent`（蓝），**不跟标签自己的颜色走**。
3. 竖线宽 2px，贴左边缘，通高。
4. 悬停与选中**用同一个底色** `--ui-hover`：鼠标停在选中行上不应该变色。

### 3.2 悬停

```css
.nav-row:hover { background: var(--ui-hover); color: var(--ui-fg); }
.tag-row:hover, .tag-group-row:hover { background: var(--ui-hover); color: var(--text-primary); }
.tag-dock-head:hover { background: var(--ui-hover); color: var(--text-primary); }
```

旧代码里的 `var(--e1)` 与 `--ui-hover` 在暗色下几乎一样（`#1a1a18` vs `#1c1c1a`），但亮色下差得明显
（`#f2f2ee` vs `#f1f1ed`）—— **统一用 `--ui-hover`**，不要混。

### 3.3 三态锚点（行首标记）

列表行首的标记只有三种形态，含义固定：

| 形态 | 含义 | 代码 |
|---|---|---|
| 6px 实心点 | 默认 / 手工标签 | `.tag-dot` |
| 6px 虚线空心点 | 自动推导的标签 | `.tag-row.auto .tag-dot` |
| 2×96 蓝线 | 当前选中 | `.tag-row.sel::before` |

### 3.4 键盘可达（新增行必须照做）

列表行不能只有鼠标能点。容器与行各自补语义：

```tsx
// 容器
<div className="tag-dock-scroll" role="listbox" aria-label={t("side.tags")}>
  // 行
  <motion.div
    className="tag-row …"
    role="option"                 {/* 不能用 role="button"，会破坏 listbox 语义 */}
    tabIndex={0}
    aria-selected={activeTag === name}
    onKeyDown={(e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickTag(name); }
      else if (e.key === "F2") { /* 打开编辑卡 / 改名 */ }
    }}
  />
</div>
```

键位约定（与其它列表一致）：`Tab` 进入、`Enter` / `空格` 执行、`F2` 编辑或改名、
`Esc` 关面板。**不要为了键盘可达把行改成 `<button>`** —— 会破坏 `listbox` / `option`
语义，也会把 `motion` 的 `whileTap` 动画挤掉。

---

## 4. 停靠面板（Dock）

侧栏底部有两个同壳面板：**分组**（`Sidebar.tsx` 内联）与**标签**（`TagDock.tsx`）。
它们共用 `.tag-dock` 一整套类，只在内容上不同。

### 4.1 结构（顺序很关键）

```tsx
<div className={`tag-dock ${open ? "open" : ""}`}>
  <div className="tag-dock-body">   {/* order: 1 —— 在上方长高 */}
    …过滤框 / 工具行 / 列表…
  </div>
  <div className="tag-dock-head">   {/* order: 2 —— 钉在底栏上方 */}
    <Icon /> 标签 <span className="tag-dock-count">12</span> <Caret />
  </div>
</div>
```

**为什么头部要 `order: 2` 放到 DOM 末尾**：面板夹在「可滚动的目录树」和「底栏」之间。
高度一变，容器顶边就跟着上移；头部如果在顶上，悬停展开的瞬间它会从指针底下逃走，
用户点下去落到的是刚冒出来的第一行标签 → 误筛选。

把头部钉在底栏上方后：内容块在**上面**变高、头部一动不动，它才敢当点击目标。

```css
.tag-dock {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  height: 32px;            /* 收起态 = 只有头部 */
  min-height: 0;
  overflow: hidden;
  margin-top: 4px;
  border-top: 1px solid rgba(var(--ink-rgb), 0.05);
  transition: height 110ms ease;
}
.tag-dock-body { order: 1; flex: 1 1 auto; min-height: 0; display: none; }
.tag-dock-head { order: 2; flex: 0 0 32px; }
```

**收起时 `.tag-dock-body` 必须 `display: none`**：只留 32px 的话，露出来的是内容区的**顶部**
（过滤框 + 按钮），而不是用户要找的那一行「标签」。这一条漏掉过一次，表现是「收起后出现一个莫名其妙的搜索框」。

### 4.2 展开高度必须两边同值

```css
.tag-dock.open  { height: min(300px, 42vh); }
.coll-dock.open { height: min(300px, 42vh); }   /* 必须同值 */
/* 两个同时展开时各让一步 */
.tag-dock.open.half,
.coll-dock.open.half { height: min(220px, 30vh); }
```

高度不同的话，从一个面板移到另一个时面板高度一变，指针就被甩出面板 —— 表现是「分组根本展不开」。

`.half` 由 `lib/dockOpen.ts` 的全局状态挂上（两个面板各自上报「我开着」，读对面的值）。
**不能用 CSS `:has`**：两个面板是兄弟节点，靠后那个没有「后面的兄弟」可选，只能单向生效。

同时开两个是真实场景（一边看标签一边拖进分组），别指望用户自己收一个：
两个 300px 加起来 600，目录树被压到接近零、底栏被挤出 `.app-frame`（它是 `overflow: hidden`）。

### 4.3 四种「临时钉住」

`open = pinned || selectedHold || hoverActive || focusHold || menuHold || edit !== null`

| 状态 | 何时为真 | 何时解除 |
|---|---|---|
| `pinned` | 用户点「固定」 | 再点一次；写进 localStorage |
| `selectedHold` | 当前导航就是本面板的项（`nav.kind === "tag"` / `"collection"`） | 切到别的导航，自然解除 |
| `hoverActive` | 指针在面板上（走 `lib/dockHover.ts` 的全局单值） | 离开 200ms |
| `focusHold` | 过滤框有焦点 | blur |
| `menuHold` | 右键菜单开着 | 菜单关闭（`useContextMenuOpen()` 变 false） |

界面上「已固定」按钮显示的是 `pinned || selectedHold` 的合并状态；此时点头部 = **取消该选中**，
否则 `pinned` 本来就是 `false`，用户点了没反应。

### 4.4 悬停互斥：不要用 `:hover`

```ts
// src/lib/dockHover.ts —— 两个面板共用一个「当前悬停哪个」的单值
```

```ts
// 面板里
const [hoverActive, setHoverActive] = useState(false);
useEffect(() => subscribeDock(DOCK_ID, setHoverActive), []);
```

**原因**：两个面板上下相邻。各自 `:hover` 时，从标签移到分组会让标签**先**收起（释放两百多像素），
整个下方内容跟着位移，指针当场脱靶，分组还没展开就被甩开 —— 表现就是「移到分组会直接收起来，而不展开分组」。

改成全局单值后，指针进入分组立刻把状态切过去，标签**同一帧**开始收起，两个动画并行，净位移只剩高度差。
CSS 侧因此**删掉了所有 `:hover` 展开规则**，只认 `.open`。

### 4.5 面板里的搜索框

过滤框在标签数量 > 8 时才出现（`total > 8`），避免小库时多一行噪音。
输入框必须用 `BlinkCaretInput`（§6），并且 `onFocus/onBlur` 挂 `focusHold`。

---

## 5. 滚动条

**全局只有一处定义，任何容器都不许单独覆盖。**

```css
/* app.css:7890 */
*::-webkit-scrollbar { width: 10px; height: 10px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb {
  background: var(--ui-fg-3);
  background-clip: padding-box;
  border: 4.5px solid transparent;   /* 槽位 10px，视觉 1px 发丝线 */
  border-radius: 999px;
  min-height: 36px;
}
/* 三种触发变粗（视觉 6px，抓得住）：靠近 / 指针压上 / 拖动 */
.scroll-hot::-webkit-scrollbar-thumb,
*::-webkit-scrollbar-thumb:hover,
*::-webkit-scrollbar-thumb:active {
  border-width: 2px;
  background-color: color-mix(in srgb, var(--ui-fg) 40%, transparent);
}
```

### 5.1 两个坑

1. **`scrollbar-width` 和 `::-webkit-scrollbar` 不能同时声明**。Chromium 里只要写了 `scrollbar-width`
   （哪怕 `thin`），整套 `::-webkit-scrollbar` 规则会被**整体禁用**。菜单里曾经这样，结果菜单滚动条
   和其它地方长得不一样。要自定义就只用 webkit 那套。
2. **`.scroll-hot` 必须挂在滚动容器自己身上**。`::-webkit-scrollbar` 只认宿主元素的类，挂在父级无效。
   目前由 `App.tsx` 的全局指针监听统一挂（指针进某容器右缘 14px 内就加）。

### 5.2 唯一的例外：侧栏目录树隐藏滚动条

```css
/* app.css:238 —— 侧栏只有 236px，一条 8px 的条常驻会吃掉文字宽度 */
.sidebar-scroll { scrollbar-width: none; -ms-overflow-style: none; }
.sidebar-scroll::-webkit-scrollbar { width: 0; height: 0; }
```

**只是不画出来，仍然可以滚**（滚轮 / 触控板 / 键盘翻页都不受影响）。
不要把这个套路推广到其它容器 —— 主区、详情面板、设置面板都需要可见的滚动条。

---

## 6. 搜索框与光标

### 6.1 所有输入框都走 `BlinkCaretInput`

```tsx
import { BlinkCaretInput } from "../design/primitives/BlinkCaretInput";

<BlinkCaretInput
  value={q}
  onChange={(e) => setQ(e.target.value)}   // ⚠️ 回调参数是事件，不是字符串
  placeholder={t("tag.filterPlaceholder")}
  aria-label={t("tag.filterPlaceholder")}
  fieldClassName="tag-dock-search"          // 挂在外层 .blink-caret-field 上
  spellCheck={false}
/>
```

**不要用裸 `<input>`**：Windows 11 的「文本光标指示器」是 OS 级覆盖层，应用侧改不掉也改不闪；
只有自绘才能得到「蓝块包字 + 白字」的块状光标（`design/primitives/blinkCaret.css`）。

### 6.2 三个不许动的细节

```css
.blink-caret-field input { caret-color: transparent; }          /* 藏掉原生细光标 */
.blink-caret-field.is-composing input { caret-color: auto; }    /* 中文输入时还回去 */
.blink-caret {
  border-radius: 3px;
  background: var(--caret-blue, var(--ws-accent, #4c8dff));
}
```

1. **高度只跟字号走，绝不撑满输入框**（`caretHeightFor(fontSize)`）。旧实现 `top:0;bottom:0`
   会跟着 32/36px 输入框一起变大，看着是一大坨。
2. **IME 组合期间必须把光标还给系统**，否则拼音候选窗的光标位置会和自绘蓝块打架。
3. 这个 CSS 是**主程序与插件中心共用**的一份（`blinkCaret.css`），改一处两边同时生效；
   不要把它挪回 `app.css`，插件面板是独立 vite 入口，不加载 `app.css`。

### 6.3 输入框盒模型

| 场景 | 高度 | 字号 | 圆角 | 边框 |
|---|---|---|---|---|
| 面板内过滤框 | 24px | 11px | 5px | `1px solid var(--ui-line)` |
| 设置 / 顶栏搜索 | 28–30px | 11px | 6px | 同上 |

底色一律 `var(--e1)`，不要用 `--ui-panel`。

### 6.4 一个必须知道的坑：中文输入会让面板收起

中文输入法候选窗是**独立窗口**，一出现 WebView 就判定指针离开面板，`:hover` 断掉 → 面板收。
这就是为什么过滤框必须有 `focusHold`（§4.3）。任何新加的浮层输入框都要照做。

---

## 7. 圆点语义

```css
.tag-dot {
  flex-shrink: 0;
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--tc, currentColor);     /* --tc 由 .tag-c-* 提供 */
}
.tag-row.auto .tag-dot,
.tag-c-auto .tag-dot {
  background: transparent;
  border: 1px dashed currentColor;         /* 自动标签 = 空心虚线 */
}
```

| 类型 | 外观 | 含义 |
|---|---|---|
| 手工标签 | **实心**，用自己的颜色 | 你自己打的 |
| 自动标签 | **空心虚线**，灰 | 软件按元数据推的 |
| 选中（无配色 / 自动） | 实心，`--ui-accent` | 当前正在筛 |

> ⚠️ **坑**：`.tag-row.auto .tag-dot` 这条规则曾经从 2.3.0 起一直没生效 ——
> 样式写好了，但渲染行的时候**从来没给自动标签挂 `auto` 类**。表现是「自动标签画成和手工标签一样的实心灰点」，
> 用户以为改错了地方。加新的行状态类时，务必回头确认**渲染端真的挂了**这个类。

> ⚠️ **坑 2（CSS 顺序）**：`.tag-row.sel .tag-dot { background: var(--tc) }` 与
> `.tag-row.auto .tag-dot { background: transparent }` **特异度相同**，后者写在后面 → 选中的自动标签圆点会变透明，
> 等于消失。修复方式是在文件更后面补一条更高特异度的 `.tag-row.auto.sel .tag-dot`。
> **这就是本文件里同一选择器分散在三处的代价**：加规则前先 grep 一遍所有同名规则。

### 7.1 十个语义色

只存**键**，不存色值（`tagMeta[tag].color = "blue"`，不是 `"#3b82f6"`）：

```
none gray red orange amber green teal blue indigo violet pink
```

对应 `.tag-c-*` 只设 `--tc`，深浅主题各自映射。好处：换主题时标签颜色自动跟着走，
且导出的 `curation.json` 里不会有硬编码色值。

---

## 8. 菜单

### 8.1 层级

```
.ctx-menu         z-index: 81   一级菜单
.ctx-submenu-panel z-index: 82  二级菜单（可滚动）
```

### 8.2 限高

```css
.ctx-menu         { max-height: calc(100vh - 16px); overflow-y: auto; }
.ctx-submenu-panel{ max-height: min(300px, 56vh);    overflow-y: auto; }
```

二级菜单必须有独立限高：标签子菜单可能有几十项，不限高会一路顶到窗口底部。
300px 是「一次能看到 10 项左右」的经验值，与筛选菜单里的子菜单对齐。

### 8.3 图标列

菜单项有图标时，**同一级的各项都要有图标**，否则没图标那几项文字会左移，网格对不齐。

```tsx
// TopBar.tsx —— 筛选菜单里三个子菜单各有自己的图标
<Sparkles size={11} />  // 自动标签
<Tag size={11} />       // 手工标签
<FolderOpen size={11} /> // 分组
<Camera size={11} />     // 快照
```

### 8.4 菜单项文案

- 动作类：动词开头，「只看『X』」/「取消这个筛选」/「编辑标签」。
- 危险类：`danger: true`，排在分隔线之后，永远最后。
- 不要放「导出字体清单」这类**分组级**的导出入口 —— 分组只允许通过**快照**导出（用户 2026-11-16 明确要求）。

---

## 9. 设置面板

### 9.1 结构

```
.settings-panel  grid: 196px | 1fr
├─ .set-nav         左导航（标题 + 搜索框 + 6 页 + 二级结果）
└─ .set-main
   ├─ .set-head     标题 + 关闭
   ├─ .set-body     滚动区，内含 6 个 .set-group
   └─ .set-foot     即时生效说明 + 完成
```

### 9.2 尺寸必须写死

```css
.settings-panel {
  width: min(900px, 96vw);
  height: min(760px, 94vh);       /* 不是只有 max-height */
  max-height: min(760px, 94vh);
}
```

只有 `max-height` 时，内容少的页（通用）比内容多的页（数据 / 外观）矮一大截，**切页时整个面板会跳一下**。
用户原话：「设置要固定尺寸，而不是点击一下尺寸就变一下」。超出部分由 `.set-body` 内部滚动消化。

### 9.3 加一个新设置项

```tsx
<div className="set-group" data-section="general" hidden={!show("general")}>
  <section className="settings-section">
    <div className="detail-heading">{t("settings.xxx")}</div>
    <div className="settings-row">
      <div className="settings-label">
        {t("settings.yyy")}
        <SettingHint text={t("settings.yyySub")} />
      </div>
      {/* 控件 */}
    </div>
  </section>
</div>
```

三条硬约定：

1. **必须放进对应的 `.set-group`**，并带 `data-section`。`hidden` 只影响显示，元素仍在 DOM 里 ——
   §9.4 的二级搜索靠 `data-section` 把命中的行归回它那一页。
2. **文案一律走 `t()`，并且 `.settings-label` 里写的就是用户看到的字**。二级搜索直接读这个 DOM 文本，
   写死中文或拆到别处，搜索就会漏。
3. **不要放假按钮**。FontManager 所有设置都是即时生效，底栏只写「所有改动即时生效，不需要点保存」+「完成」。
   加一个「保存」按钮，用户会以为不点就丢。

### 9.4 二级搜索

```tsx
// SettingsOverlay.tsx:896
useEffect(() => {
  const root = bodyRef.current;
  const out = [];
  for (const group of root.querySelectorAll(".set-group[data-section]")) {
    for (const row of group.querySelectorAll(".settings-row")) {
      const label = row.querySelector(".settings-label")?.textContent ?? "";
      if (label.toLowerCase().includes(needle)) out.push({ section: group.dataset.section, label });
    }
  }
  setRowHits(out.slice(0, 24));
}, [needle, openState, section]);
```

**为什么不建索引表**：设置项是近千行内联 JSX，索引表等于把界面文案再抄一遍，改一处忘一处就会
「搜得到、点进去没有」。扫 DOM 天然同步。

点结果后 `jumpToRow()`：切页 → 等 60ms（切页是 state 更新，要等一帧才量得到新坐标）→
`scrollIntoView({block:"center"})` → 加 `.set-row-flash` 1.1s 后移除。
**高亮是临时的，不要做成选中态** —— 设置项没有「选中」这回事。

---

## 10. 空状态与文案

| 位置 | 规则 |
|---|---|
| 空列表 | 一句怎么办（「选中字体后按 T 打标签」），不是一句陈述（「暂无数据」） |
| 加载中 | 有进度数字就显示数字，没有就只显示「正在…」 |
| 出错 | 说清哪个动作失败 + 原因，不要只说「操作失败」 |
| 数字 | 一律 `font-variant-numeric: tabular-nums`，右对齐 |

```css
.tag-row-count, .tag-dock-count, .coll-no {
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1;
}
```

> `.tabular` 这个类在 `tokens.css` 里有定义，但它**靠调用点记得写**。哪一行忘了，那一列数字就错开半格宽，
> 用户看到的是「右边这列数字粗细不齐」。所以属性要直接落到数字元素上，不要只靠类名。

### 10.1 加文案 = 加九份

界面语言共九种：`zh-CN` / `zh-TW` / `en` / `de` / `es` / `fr` / `ja` / `pt-BR` / `ru`。
**新增一个 key 就要同时进九份**，`node check-locales.mjs` 会把覆盖率打出来（缺键只报不拦，
但会一路回落英文 —— 用户看到的是半截英文界面）。

- **复数**按各语言自己的规则：日语 / 中文只有 `_other`，德语是 `_one|_other`，
  俄语是 `_one|_few|_many|_other`，西/法/葡还有 `_many`。
- **动态拼的 key 检查不出来**：`t(\`tag.ns.${ns}\`)` 这种，脚本只看到 `tag.ns.` 前缀，
  少一个命名空间不会报错，界面上直接显示 `tag.ns.style`。加这类 key 后手动数一遍。
- 翻译时沿用各语言已有的术语（繁中「字型 / 外掛 / 分組」，日「ライブラリ / タグ / コレクション」，
  德「Bibliothek / Tags / Sammlungen」，法「Bibliothèque / Étiquettes / Collections」，
  西「Biblioteca / Etiquetas / Colecciones」，葡「Biblioteca / Etiquetas / Coleções」，
  俄「Библиотека / Теги / Коллекции」）。
- `_重复字体` 这个文件夹名出现在提示文案里时**保持简体原样**，它是磁盘上的真名。

---

## 11. 踩过的坑（按时间倒序，每条都能省你半天）

| 现象 | 真因 | 修法 |
|---|---|---|
| 标签行大面积字号偏大 | `.nav-row` 基础段 `--fs-13`，末尾被覆盖成 `11px` | 量字号时 grep 全部同名规则，取最后一条 |
| 自动标签圆点不空心 | 样式写好了，渲染端没挂 `auto` 类 | 加状态类后回渲染端确认 |
| 选中的自动标签圆点消失 | `.tag-row.sel .tag-dot` 与 `.tag-row.auto .tag-dot` 特异度相同、后者在后 | 补更高特异度的 `.tag-row.auto.sel .tag-dot` |
| 移到分组时面板收起而不是展开 | 两个面板各自 `:hover`，一个收起把另一个推走 | `lib/dockHover.ts` 全局单值 + CSS 只认 `.open` |
| 中文输入时面板收起 | 输入法候选窗是独立窗口，触发 `mouseleave` | 过滤框 `focusHold` |
| 右键菜单「没有了」 | 面板先收起 → 行从渲染树消失 → `contextmenu` 到不了行上 | `onMouseDown` 判 `e.button === 2` 就 `setMenuHold(true)`，不能等 `onContextMenu` |
| 菜单滚动条和别处不一样 | 声明了 `scrollbar-width: thin`，整套 webkit 规则被禁用 | 删掉 `scrollbar-width`，只留 webkit |
| 设置面板切页会跳尺寸 | 只有 `max-height` | 加 `height` 固定值 |
| 数字一列看着粗细不齐 | 数字 10px、文字 11px，缩放后笔画发虚 | 同字号 11px，主次只靠颜色 |
| 界面显示 `tag.ns.style` 原始键名 | key 是动态拼的（`tag.ns.${ns}`），`check-locales.mjs` 查不出来 | 补全所有 `tag.ns.*` 九个命名空间 |
| 打了白屏包 | `dist` 被清了一半（缺 `index.html`），Tauri 资源嵌入缓存没失效 | 确认 `dist/index.html` 存在；删 `rust-target/release/build/fontmanager-*` + `touch lib.rs` 重编 |

---

## 12. 提 PR 前自检清单

- [ ] 新加的颜色都走 `--ui-*` / `--qb-*`，没有裸 `#RRGGBB`（三处例外除外）
- [ ] 新加的文字用 `--fs-9 / 11 / 13`，没有引入 12px / 15px
- [ ] 新的「一行」是 32px 高、11px 字号、500 字重、15px 图标、直角
- [ ] 新的选中态是 `--ui-hover` 底 + 2px `--ui-accent` 左竖线
- [ ] 新的滚动容器没有单独写滚动条样式
- [ ] 新的输入框用的是 `BlinkCaretInput`，`onChange` 收事件
- [ ] 新的浮层输入框挂了 `focusHold`（防中文输入收起）
- [ ] 新的右键菜单项同级都有图标；危险项在最后
- [ ] 新的设置项在 `.set-group[data-section]` 里，`.settings-label` 写的是用户看到的字
- [ ] `npx tsc --noEmit` / `npm test` / `node check-locales.mjs` 全绿
- [ ] 深色 + 亮色两个主题都看一眼（`--ui-hover` 在亮色下才看得出差异）

---

## 13. 相关文件索引

| 文件 | 管什么 |
|---|---|
| `src/app.css` | 全部样式。**改之前先看 §1.2 的「同一选择器多处定义」警告** |
| `src/design/tokens.css` | 底层令牌：字号、动效、光标色、阴影 |
| `src/design/primitives/BlinkCaretInput.tsx` | 自绘光标输入框 |
| `src/design/primitives/blinkCaret.css` | 光标样式（主程序 + 插件面板共用） |
| `src/design/primitives/ContextMenu.tsx` | 右键菜单、二级菜单、`useContextMenuOpen()` |
| `src/components/Sidebar.tsx` | 侧栏 + 分组停靠面板 |
| `src/components/TagDock.tsx` | 标签停靠面板 + 编辑卡 |
| `src/components/SettingsOverlay.tsx` | 设置面板（左导航 + 卡片 + 二级搜索） |
| `src/lib/dockHover.ts` | 两个面板的悬停互斥 |
| `src/lib/libraryData.ts` | 整理数据的导出 / 导入 / 作用域裁剪 |
| `docs/UI设计交付规格书.md` | 视觉稿的原始规格（历史版，本文档与之冲突时以本文档为准） |
