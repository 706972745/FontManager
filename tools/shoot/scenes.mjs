/**
 * README 场景表：一张图 = 一个场景。
 *
 * 每个场景的 `run` 只做「把界面切到该拍的状态」，出图与落盘由 shoot-readme.mjs 负责。
 * 所有定位都用 **DOM 选择器 / 属性**，不写死屏幕坐标 —— 这一个约束是整份工具的核心：
 * 历史上用 `SetCursorPos` + 坐标点击拍出来的图，鼠标停在卡片上会留下悬停高亮假象，
 * 而且窗口被抢焦点后坐标系整体偏移，图里点错东西的概率极高。
 *
 * 可复用的稳定抓手（都在源码里核对过）：
 *   `[data-family="…"]`        卡片 / 列表行 / 样张块（FamilyCard、FontList、SpecimenView）
 *   `[data-nav-kind="…"]`      侧栏导航行（Sidebar 的 NavRow）
 *   `.view-toggle [role=tab]`  视图切换（顺序固定 grid / list / specimen，见 TopBar 的 VIEW_MODES）
 *   `[data-tour="quickbar"]`   标题栏「速览」入口
 *   `[data-tour="settings"]`   标题栏「设置」入口
 *   `[data-hint="hint.backFull"]` 速览里「返回完整界面」
 *   `[data-hint="side.pluginCenter"]` 标题栏「插件中心」（未装面板时**不渲染**）
 *   `.ctx-menu` / `.ctx-search`     右键菜单 / 菜单里的打字即搜输入框
 *   `.palette-panel` / `.shortcuts-panel` / `.settings-panel` / `.detail`  各弹层
 *
 * 这些属性是「给测试和导览用的钩子」，属于源码里的既定契约；真改了名字，
 * 场景会**大声失败**（打印缺了哪个选择器），而不是悄悄拍一张错图。
 */
import { MOD } from "./cdp.mjs";
import { setTimeout as delay } from "node:timers/promises";

/** 主窗口的固定视口。与 `_tauri.local.json` 的 1280×820 一致。 */
export const MAIN_VIEWPORT = { width: 1280, height: 820 };

/**
 * 截图优先选用的字族（README 的图要有像样的中英混排预览）。
 * 都没有就退回「当前渲染出来的第 3 张卡片」——不写死任何具体字体名。
 */
export const FAMILY_PREFERS = [
  "Source Han Sans",
  "思源黑体",
  "Noto Sans SC",
  "Noto Sans CJK",
  "Microsoft YaHei",
  "微软雅黑",
  "HarmonyOS Sans",
  "PingFang",
  "Inter",
  "Segoe UI",
];

/**
 * 场景表。
 * 字段：
 *   name        命令行 `--only` 用的名字，也是日志里的标识
 *   out         输出文件名（仓库根目录同名旧图会被它覆盖）
 *   title       汇总表里的中文说明
 *   viewport    "main" = 固定 1280×820；"native" = 清掉覆盖、按窗口真实尺寸抓
 *   run(ctx)    切界面
 *   crop        （可选）截图后裁剪：返回 {x,y,width,height}（CSS px）或 {selector,pad}
 *   capture     （可选）"workshop" 表示抓的是插件中心那个**独立窗口**的 target
 *   skip        有值表示这张图不重拍，值就是原因
 */
export const SCENES = [
  {
    name: "main",
    out: "main.png",
    title: "主界面·卡片视图（选中一个字族）",
    viewport: "main",
    async run(ctx) {
      const fam = await ctx.pickFamily();
      await ctx.selectFamily(fam, { offsetX: 46, offsetY: 46 });
      await ctx.cdp.waitFor(".detail", { what: "详情面板" });
      await ctx.cdp.waitFrames({ settleMs: 420 });
      return { note: `选中「${fam}」` };
    },
  },
  {
    name: "view-list",
    out: "view-list.png",
    title: "列表视图",
    viewport: "main",
    async run(ctx) {
      await ctx.setViewMode(1);
      await ctx.cdp.waitFor(".list-scroll", { what: "列表容器" });
      const fam = await ctx.pickFamily();
      await ctx.selectFamily(fam, { offsetX: 120, offsetY: 18 });
      await ctx.cdp.waitFrames({ settleMs: 360 });
      return { note: `列表视图，选中「${fam}」` };
    },
  },
  {
    name: "view-specimen",
    out: "view-specimen.png",
    title: "样张视图",
    viewport: "main",
    async run(ctx) {
      await ctx.setViewMode(2);
      await ctx.cdp.waitFor(".specimen-head", { what: "样张视图" });
      // 样张视图里详情面板是收起的（App.tsx 的 viewMode !== "specimen"），先清掉选中
      await ctx.cdp.pressKey("Escape");
      await ctx.cdp.waitFrames({ settleMs: 420 });
      return { note: "样张墙" };
    },
  },
  {
    name: "detail",
    out: "detail.png",
    title: "详情面板展开（多字号样张 + 元数据）",
    viewport: "main",
    async run(ctx) {
      await ctx.setViewMode(0);
      const fam = await ctx.pickFamily({ offset: 1 });
      await ctx.selectFamily(fam, { offsetX: 40, offsetY: 40 });
      await ctx.cdp.waitFor(".detail", { what: "详情面板" });
      // 详情面板里手动滚到元数据段（不是整页 scrollIntoView，避免主列表跟着动）
      try {
        await ctx.cdp.scrollChildIntoView(".detail-inner", ".detail-meta", { alignTop: 8 });
      } catch {
        await ctx.warn("详情面板里没找到 .detail-meta，保持顶部");
      }
      await ctx.cdp.waitFrames({ settleMs: 420 });
      return { note: `详情面板，字体「${fam}」` };
    },
  },
  {
    name: "online",
    out: "online.png",
    title: "在线字体面板",
    viewport: "main",
    async run(ctx) {
      await ctx.clickNav("online");
      await ctx.cdp.waitFor(".online-view", { what: "在线面板" });
      // 在线目录是联网拉的：等卡片出现，超时也不报错（拍「加载中/空」也是一种真实状态）
      try {
        await ctx.cdp.waitUntil(
          `document.querySelectorAll('.online-card, .online-family, .online-row').length > 0`,
          { timeoutMs: 20000, what: "在线字体卡片" },
        );
      } catch {
        await ctx.warn("在线目录 20s 内没有出卡片（可能断网 / 限流），按当前状态拍");
      }
      await ctx.cdp.waitFrames({ settleMs: 600 });
      return {};
    },
  },
  {
    name: "trash",
    out: "trash.png",
    title: "回收站视图",
    viewport: "main",
    async run(ctx) {
      await ctx.clickNav("trash");
      // 空回收站**渲染的是 .empty-state，不是 .trash-view**（TrashView.tsx 提前 return）。
      // 干净数据根必然是空态，只等 .trash-view 会白等 15 秒。
      await ctx.cdp.waitUntil(
        `!!document.querySelector('.trash-view') || !!document.querySelector('.empty-state')`,
        { timeoutMs: 15000, what: "回收站视图（列表或空态）" },
      );
      await ctx.cdp.waitFrames({ settleMs: 400 });
      const rows = await ctx.cdp.count(".trash-row");
      return { note: rows > 0 ? `回收站 ${rows} 条` : "回收站空态" };
    },
  },
  {
    name: "base",
    out: "base.png",
    title: "首屏（默认界面，未选中任何字族）",
    viewport: "main",
    async run(ctx) {
      await ctx.setViewMode(0);
      await ctx.cdp.pressKey("Escape"); // 清掉选中 → 详情面板收起
      await ctx.cdp.waitForGone(".detail", { timeoutMs: 3000 });
      await ctx.cdp.scrollToTop(".grid-scroll");
      await ctx.cdp.waitFrames({ settleMs: 420 });
      const n = await ctx.cdp.count("[data-family]");
      return { note: `默认首屏，可见卡片 ${n} 张` };
    },
  },
  {
    name: "palette",
    out: "palette.png",
    title: "命令面板（Ctrl+K）",
    viewport: "main",
    async run(ctx) {
      const fam = await ctx.pickFamily();
      await ctx.cdp.pressKey("k", { modifiers: MOD.ctrl });
      await ctx.cdp.waitFor(".palette-panel", { what: "命令面板" });
      await ctx.cdp.waitFrames({ frames: 2, settleMs: 220 });
      // 输入两个字（中文用 setInputValue：char 事件里的 key 不保证是完整汉字）
      const q = fam.slice(0, 2);
      await ctx.cdp.setInputValue(".palette-panel input", q);
      await ctx.cdp.waitFrames({ settleMs: 260 });
      return { note: `查询「${q}」` };
    },
  },
  {
    name: "contextmenu",
    out: "contextmenu.png",
    title: "卡片右键菜单 + 菜单内打字搜索",
    viewport: "main",
    async run(ctx) {
      const fam = await ctx.pickFamily();
      await ctx.selectFamily(fam, { offsetX: 46, offsetY: 46 });
      await ctx.cdp.waitFrames({ frames: 2, settleMs: 260 });
      await ctx.cdp.rightClick(`[data-family=${JSON.stringify(fam)}]`, { offsetX: 46, offsetY: 46 });
      await ctx.cdp.waitFor(".ctx-menu", { what: "右键菜单" });
      await ctx.cdp.waitFrames({ frames: 2, settleMs: 200 });
      // 打一个 ASCII 字母进入「打字即搜」，再把真正的查询词写进搜索框
      await ctx.cdp.pressKey("s");
      await ctx.cdp.waitFor(".ctx-search", { what: "菜单里的搜索框" });
      const q = fam.slice(0, 2);
      await ctx.cdp.setInputValue(".ctx-search", q);
      await ctx.cdp.waitFrames({ settleMs: 300 });
      const hits = await ctx.cdp.count(".ctx-hit");
      return { note: `查询「${q}」，命中 ${hits} 条` };
    },
  },
  {
    name: "shortcuts",
    out: "shortcuts.png",
    title: "快捷键面板（?）",
    viewport: "main",
    async run(ctx) {
      await ctx.cdp.pressKey("?");
      await ctx.cdp.waitFor(".shortcuts-panel", { what: "快捷键面板" });
      await ctx.cdp.waitFrames({ settleMs: 420 });
      return {};
    },
  },
  {
    name: "settings",
    out: "settings.png",
    title: "设置面板首页",
    viewport: "main",
    async run(ctx) {
      await ctx.openSettings();
      await ctx.cdp.scrollToTop(".settings-scroll");
      await ctx.cdp.waitFrames({ settleMs: 460 });
      return {};
    },
  },
  {
    name: "libraries",
    out: "libraries.png",
    title: "设置 → 字体库文件夹（局部裁剪）",
    viewport: "main",
    async run(ctx) {
      await ctx.openSettings();
      const ok = await ctx.markLibrarySection();
      if (!ok) throw new Error("设置面板里没有找到「字体库文件夹」这一段（标签文案变了？）");
      await ctx.cdp.scrollChildIntoView(".settings-scroll", "#zfm-crop-anchor", { alignTop: 8 });
      await ctx.cdp.waitFrames({ settleMs: 400 });
      return { cropSelector: "#zfm-crop-anchor", cropPad: 10 };
    },
  },
  {
    name: "quickbar",
    out: "quickbar.png",
    title: "速览面板（Alt+` 收成贴顶一条后再展开）",
    // 速览是另一个窗口尺寸（收成细线 → 展开成面板），必须按真实视口抓
    viewport: "native",
    async run(ctx) {
      await ctx.cdp.click('[data-tour="quickbar"]', { what: "标题栏速览按钮" });
      await ctx.cdp.waitFor(".qb-frame", { what: "速览窗口内容" });
      await ctx.cdp.waitUntil(
        `(() => { const el = document.querySelector('.qb-frame'); return !!el && el.dataset.dockPhase === 'hint'; })()`,
        { timeoutMs: 8000, what: "速览进入收起态（data-dock-phase=hint）" },
      ).catch(() => ctx.warn("没等到 hint 阶段，直接尝试展开"));
      // 把指针挪到抓手条上：revealed 由 pointerenter 驱动，opacity 才会从 0 到 1
      await ctx.cdp.hover(".qb-dockbar", { what: "速览收起态操作条" }).catch(() => {});
      await delay(120);
      await ctx.cdp.click(".qb-dockbar", { what: "速览收起态操作条" }).catch(() => {});
      // 键盘 Enter 也通（.qb-dockbar 的 onKeyDown → expandQuickbarPanel）
      await ctx.cdp.pressKey("Enter");
      await ctx.cdp.waitUntil(
        `(() => { const el = document.querySelector('.qb-frame'); return !!el && !el.dataset.dockPhase; })()`,
        { timeoutMs: 10000, what: "速览展开（data-dock-phase 消失）" },
      );
      await ctx.cdp.waitFor(".qb-content", { what: "速览面板内容" });
      await ctx.cdp.hover(".qb-head", { what: "速览顶栏" }).catch(() => {});
      await ctx.cdp.waitFrames({ frames: 3, settleMs: 700 });
      const vp = await ctx.cdp.evaluate(`({ w: innerWidth, h: innerHeight })`);
      return { note: `速览视口 ${vp.w}×${vp.h}` };
    },
  },
  {
    name: "workshop",
    out: "workshop.png",
    title: "插件中心面板（独立窗口）",
    viewport: "native",
    capture: "workshop",
    async run(ctx) {
      const panel = await ctx.openWorkshop();
      try {
        await panel.waitFor(".ws-app, .ws-root, main", { timeoutMs: 15000, what: "插件中心 DOM" });
        await panel.waitFor(".ws-upload-btn", { timeoutMs: 15000, what: "插件中心上传按钮" });
      } catch (err) {
        await ctx.warn(`插件中心面板结构没认出来：${err.message}`);
      }
      await panel.waitFrames({ frames: 3, settleMs: 900 });
      const vp = await panel.evaluate(`({ w: innerWidth, h: innerHeight })`);
      return { note: `面板视口 ${vp.w}×${vp.h}` };
    },
  },
  {
    name: "workshop-upload",
    out: "workshop-upload.png",
    title: "插件中心 → 上传插件弹窗",
    viewport: "native",
    capture: "workshop",
    async run(ctx) {
      const panel = await ctx.openWorkshop();
      await panel.waitFor(".ws-upload-btn", { timeoutMs: 15000, what: "插件中心上传按钮" });
      await panel.waitFrames({ frames: 2, settleMs: 400 });
      await panel.click(".ws-upload-btn", { what: "上传插件按钮" });
      await panel.waitFor(".ws-upload", { timeoutMs: 10000, what: "上传弹窗" });
      await panel.waitFrames({ frames: 2, settleMs: 460 });
      return {};
    },
  },
  {
    // 2026-11-15 光标改造后的**视觉验收图**：聚焦顶栏搜索框、敲几个字，
    // 让闪烁的蓝块盖住最后一个字符。这张不进 README，只给用户确认「比字大一点」的观感。
    name: "caret",
    out: "caret.png",
    title: "输入光标特写（蓝块包字，高度只比字大一点）",
    viewport: "main",
    async run(ctx) {
      await ctx.cdp.click("#global-search", { what: "顶栏搜索框" });
      await ctx.cdp.setInputValue("#global-search", "Hello");
      // 光标 1.1s 一闪（55% 亮 / 45% 灭），抓拍很可能正好落在「灭」的那半拍；
      // 验收图要稳，就临时把动画钉成常亮。只影响这次截图进程，不写回源码。
      await ctx.cdp.evaluate(`(() => {
        let s = document.getElementById('qa-caret-freeze');
        if (!s) { s = document.createElement('style'); s.id = 'qa-caret-freeze'; document.head.appendChild(s); }
        s.textContent = '.blink-caret{animation:none!important;opacity:1!important}';
        return true;
      })()`);
      await ctx.cdp.waitFrames({ frames: 3, settleMs: 420 });
      const box = await ctx.cdp.evaluate(
        `(() => {
           const c = document.querySelector('.blink-caret');
           if (!c) return null;
           const r = c.getBoundingClientRect();
           const i = document.querySelector('#global-search').getBoundingClientRect();
           return { caretH: Math.round(r.height), caretW: Math.round(r.width),
                    inputH: Math.round(i.height), top: Math.round(r.top - i.top) };
         })()`,
      );
      return {
        note: box
          ? `蓝块 ${box.caretW}×${box.caretH}px / 输入框高 ${box.inputH}px / 距顶 ${box.top}px（应为 15~17px 高且垂直居中）`
          : "⚠ 没渲染出 .blink-caret（输入框没拿到焦点？）",
      };
    },
  },
  {
    name: "icons-overview",
    out: "icons-overview.png",
    title: "图标总览（沿用旧图）",
    viewport: "main",
    skip: "图标设计稿（1280×572），与运行时 UI 无关，不重拍",
  },
  {
    // 2.6.0 关于页赞助区：点侧栏「关于」→ 滚到底 → 拍「现在还早，刚好；」整块。
    // 这是 owner 验收版式用的图，不进 README。
    name: "about",
    out: "about.png",
    title: "关于页·赞助区（标题 / 三段正文 / 声明 / 两张二维码）",
    viewport: "main",
    async run(ctx) {
      await ctx.clickNav("about");
      await ctx.cdp.waitFor(".about-sponsor", { what: "关于页赞助区" });
      await ctx.cdp.evaluate(
        `(() => {
           const el = document.querySelector('.about-sponsor');
           if (el) el.scrollIntoView({ block: 'center' });
           return true;
         })()`,
      );
      await ctx.cdp.waitFrames({ frames: 2, settleMs: 420 });
      return { note: "滚到赞助区" };
    },
  },
];

/** 按名字找场景（支持逗号分隔的 --only） */
export function pickScenes(only) {
  if (!only || only.trim() === "" || only.trim() === "all") return SCENES;
  const want = only
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const missing = want.filter((n) => !SCENES.some((s) => s.name === n));
  if (missing.length > 0) {
    throw new Error(
      `未知场景：${missing.join(", ")}；可用：${SCENES.map((s) => s.name).join(", ")}`,
    );
  }
  return SCENES.filter((s) => want.includes(s.name));
}
