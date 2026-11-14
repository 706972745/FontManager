import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";

/**
 * 启动页（§5.3）：这条进度条只反映**种子集合**的装载进度，不代表全库字体。
 *
 * 分母是「种子的字族数」（几百），不是全库 4214 —— 拿全库当分母的话，进度条爬到
 * 9% 就长时间不动，用户看到的就是「假进度」。种子就绪后主窗口立刻接管，
 * 这一页永久销毁，剩下的字族由主界面底部的细进度条继续报。
 *
 * 这里刻意不引 React（也不引任何字体包）：这一页的全部价值是「100ms 内出首帧」，
 * 给它挂一个框架等于先花掉自己最缺的那部分预算。所以直接操作 DOM。
 *
 * 文案与版本号都在下面本地取（`get_prefs` / `getVersion`），不走自建命令：
 * 启动页能少一条 IPC 就少一条，出问题的面也小一圈。
 */

interface SplashProgress {
  /** 已完成装载的种子**字族**数 */
  done: number;
  /** 种子总**字族**数；0 = 分母还没算出来（不确定态） */
  total: number;
  /** 种子之外还有多少字族要在主界面后台读（副状态那行的数字） */
  rest: number;
  /** 主界面已经接手，可以淡出了 */
  finished: boolean;
}

/** 一套文案 = §6 文案表里的一列。`{i}` / `{n}` 由下面自己替换。 */
interface CopySet {
  loading: string;
  indet: string;
  rest: string;
  opening: string;
}

const COPY_ZH: CopySet = {
  loading: "正在装载字体 · {i} / {n}",
  indet: "正在读取上次启用的字体…",
  rest: "其余 {n} 个字族在主界面后台继续读取",
  opening: "正在打开主界面…",
};

const COPY_EN: CopySet = {
  loading: "Loading fonts · {i} / {n}",
  indet: "Reading your last active fonts…",
  rest: "The other {n} families keep loading in the background",
  opening: "Opening FontManager…",
};

/**
 * 轮询间隔。用轮询而不是事件监听：种子进度是**可重复读的状态**，轮询天然幂等，
 * 「事件在监听注册之前就发完了」这种时序问题在启动路径上几乎必然出现
 * （splash 窗口比主窗口先建，谁先跑起来没有保证）。
 */
const POLL_MS = 100;

/**
 * 读一次 prefs，语言和主题都从这一份里取。
 *
 * 启动页只有几百毫秒，两件小事没有理由打两次 IPC；而且 `get_prefs` 要抢 store 的锁，
 * 启动这一瞬间正是扫描线程拿着锁的时候，能少一次就少一次。
 */
async function readPrefs(): Promise<Record<string, unknown> | null> {
  try {
    return await invoke<Record<string, unknown> | null>("get_prefs");
  } catch {
    // 读不到偏好不是错误：语言退回系统语言、主题退回 @media，启动页一行红字都不写
    return null;
  }
}

/**
 * 用户手动选过的语言。
 *
 * 口径（§6）：只有中文给中文文案，其余 8 种语言一律英文 —— splash 只做了两套。
 * 返回 `null` = prefs 里没有可用的答案（键缺失 / 值是 `"system"` / 读失败），
 * 调用方保持 `navigator.language` 的判断结果。
 */
function prefZh(prefs: Record<string, unknown> | null): boolean | null {
  const pref = prefs?.localePref;
  if (typeof pref === "string" && pref && pref !== "system") {
    return pref.toLowerCase().startsWith("zh");
  }
  return null;
}

/**
 * 跟软件主题（`prefs.themePref`，与 `src/lib/theme.ts` 同一套语义）。
 *
 * `light` / `dark` 才写 `data-theme`；`system`、缺失、读失败一律**不写** ——
 * `splash.html` 里的 `@media (prefers-color-scheme: light)` 自己会给出正确的一套，
 * 而它跟 `theme.ts` 对 `system` 用的是同一条判据。不写属性还有个好处：首帧就已经是
 * 对的，不用等这次 IPC。
 */
function applyTheme(prefs: Record<string, unknown> | null): void {
  const pref = prefs?.themePref;
  if (pref === "light" || pref === "dark") document.documentElement.dataset.theme = pref;
}

async function main(): Promise<void> {
  const root = document.getElementById("splash");
  const bar = document.getElementById("bar");
  const fill = document.getElementById("fill");
  const status = document.getElementById("status");
  const note = document.getElementById("note");
  const version = document.getElementById("version");
  // 结构对不上就什么都不做：宁可留一屏深色背景，也不要一个半挂的界面
  if (!root || !bar || !fill || !status || !note || !version) return;

  // 系统语言是**同步**拿得到的，先用它出第一帧：等 `get_prefs`（它要抢 store 的锁，
  // 启动这一瞬间正是扫描线程拿着锁的时候）会把最该有字的那 100ms 拖成空白。
  let zh = (navigator.language || "").toLowerCase().startsWith("zh");
  let copy: CopySet = zh ? COPY_ZH : COPY_EN;
  /** 进度只许往前走（§5.3「切确定态后不倒退」）。后端按族推进，理论上单调，
   *  但不确定态 → 确定态、以及两次轮询之间的重排都可能让算出来的百分比回退。 */
  let maxPercent = 0;
  /** 最近一帧的状态：语言晚到时要拿它重画一次，别把已经爬上去的数字丢了 */
  let last: SplashProgress = { done: 0, total: 0, rest: 0, finished: false };
  let stopped = false;
  let timer = 0;

  /** 千分位：中文用空格（1 028），其余用逗号（1,028）—— §6 表格下那条注 */
  const group = (n: number): string => {
    const digits = String(Math.max(0, Math.round(n)));
    return digits.replace(/\B(?=(\d{3})+(?!\d))/g, zh ? " " : ",");
  };

  const interpolate = (template: string, vars: Record<string, string>): string =>
    template.replace(/\{(\w+)\}/g, (whole, key: string) => vars[key] ?? whole);

  const finish = (): void => {
    if (stopped) return;
    stopped = true;
    window.clearTimeout(timer);
    status.textContent = copy.opening;
    root.classList.add("out");
    // 不在这里关窗口：关窗由 Rust 侧 `splash_done` 负责。前端 close 要额外权限，
    // 而且窗口一关 JS 上下文就没了，120ms 的淡出根本放不出来。
  };

  const render = (state: SplashProgress): void => {
    last = state;
    const total = Number.isFinite(state.total) ? Math.max(0, state.total) : 0;
    const done = Number.isFinite(state.done) ? Math.max(0, state.done) : 0;
    if (total > 0) {
      bar.classList.remove("indet");
      const percent = Math.min(100, (Math.min(done, total) / total) * 100);
      maxPercent = Math.max(maxPercent, percent);
      fill.style.width = `${maxPercent}%`;
      status.textContent = interpolate(copy.loading, { i: group(done), n: group(total) });
      // 副状态在装载过程中**一直可见**（参考稿就是这样）：它是常量（全库族数 − 种子族数），
      // 不跟着 done 变，所以不存在「在还在变的数字上再叠一个还在变的数字」的问题。
      // 0 时（算不出来 / 空库）不显示，免得出现「其余 0 个字族…」。
      note.textContent = state.rest > 0 ? interpolate(copy.rest, { n: group(state.rest) }) : "";
      return;
    }
    // 分母未知（台账 / 缓存还没读完）：不确定态，不显示任何百分比
    bar.classList.add("indet");
    status.textContent = copy.indet;
    note.textContent = "";
  };

  const poll = async (): Promise<void> => {
    if (stopped) return;
    let state: SplashProgress | null = null;
    try {
      state = await invoke<SplashProgress>("splash_state");
    } catch {
      // 命令还没注册 / 主线程正忙：下一拍再问。启动页**不写任何错误**
      // （§5.3 边界态：失败也直接进主界面，由主界面按 R-10 给可重试提示）
    }
    if (stopped) return;
    if (state) render(state);
    if (state?.finished) {
      finish();
      return;
    }
    timer = window.setTimeout(() => void poll(), POLL_MS);
  };

  // 第一帧：不确定态 + 系统语言文案，不等任何 IPC
  bar.classList.add("indet");
  fill.style.width = "30%";
  render(last);

  // 版本号与偏好并行补：两件互不依赖的事没理由串行。**只打一次 get_prefs**，
  // 语言和主题各取所需。
  void getVersion()
    .then((v) => {
      if (v) version.textContent = `v ${v}`;
    })
    .catch(() => {
      // 取不到就不显示版本号（比显示一个假版本好）
    });
  void readPrefs().then((prefs) => {
    // 主题先落：它跟文案无关，`stopped` 之后也无所谓（页面正在淡出）
    applyTheme(prefs);
    const decided = prefZh(prefs);
    if (decided === null || decided === zh || stopped) return;
    zh = decided;
    copy = zh ? COPY_ZH : COPY_EN;
    render(last);
  });

  await poll();
}

void main();
