import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  QUICKBAR_ANIM_LEAD_MS,
  QUICKBAR_ANIM_MS,
  STANDARD_EASE_CONTROL_POINTS,
  createSerialQueue,
  leadNormalized,
  standardEase,
} from "../src/lib/quickbarAnim.ts";
import { DEFAULT_HOTKEY, matchesHotkey, normalizeHotkey } from "../src/lib/hotkey.ts";

/**
 * 这三个用例对应交接文档 §5.5 要求的「纯逻辑测试」：
 * 1) 展开方向的 LEAD 归一化不再在收尾跳一下；
 * 2) 热键连按会排队执行、且按最新状态合并；
 * 3) 快捷键匹配 / 规范化只认自己那一组键。
 *
 * 后面 6 个用例是 2026-11-28 「速览展开/收起不流畅」那张卡
 * （`docs/agents/cards/2026-11-28-quickbar-anim-easing.md`）加的，
 * 锁的是三件事：曲线换成 `cubic-bezier(0.4,0,0.2,1)`、时长 200→280、
 * LEAD 由「压缩」改成「相位延迟」。它们量的都是**会挂的东西**（峰值位移、起步速度、
 * 与设计令牌的一致性），不是覆盖率。
 */

test("LEAD 归一化在结尾精确到 1，起点之前为 0", () => {
  const D = 200;
  const L = 45;

  // 起点：还没轮到这个方向动
  assert.equal(leadNormalized(0, D, L), 0);
  assert.equal(leadNormalized(L / D / 2, D, L), 0);
  // 终点：必须精确到 1，否则收尾会补一帧、看起来跳一下（旧实现 t - L/D 只到 0.775）
  assert.equal(leadNormalized(1, D, L), 1);
  // 归一化之后，越接近结尾越接近 1（旧实现在 0.99 处还差 ~3%）
  assert.ok(leadNormalized(0.995, D, L) > 0.99);
  assert.ok(leadNormalized(0.99, D, L) < leadNormalized(0.995, D, L));
  // 极短时长（「减少动效」里 duration 可能小于 LEAD）不能除零 / 出 NaN
  assert.equal(leadNormalized(1, 10, 45), 1);
  assert.ok(Number.isFinite(leadNormalized(0.5, 10, 45)));
});

test("热键 toggle 串行执行，连按按最新状态收尾", () => {
  const queue = createSerialQueue();
  const log: string[] = [];
  let running = 0;
  let docked = false;

  const toggle = () =>
    queue.run(async () => {
      running++;
      // 同时只允许一个在跑
      assert.equal(running, 1);
      // 模拟「执行时才读状态」：这里改的是真实状态，而不是提交时快照
      docked = !docked;
      log.push("start");
      await new Promise((r) => setTimeout(r, 5));
      log.push("end");
      running--;
    });

  // 连按三下（相当于用户狂按热键）：每一拍都必须落地，不能有一下被静默丢掉
  void toggle();
  void toggle();
  const last = toggle();

  assert.equal(queue.pending, 3);
  return last.then(() => {
    assert.deepEqual(log, ["start", "end", "start", "end", "start", "end"]);
    assert.equal(queue.pending, 0);
    // 三下 = 收 → 展 → 收
    assert.equal(docked, true);
  });
});

test("快捷键匹配只认自己那一组键，脏数据退回默认", () => {
  const ev = (over: Partial<KeyboardEvent>) =>
    ({ keyCode: 192, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...over }) as KeyboardEvent;

  assert.equal(matchesHotkey(ev({ altKey: true }), DEFAULT_HOTKEY), true);
  // 少了 Alt / 换成 Ctrl / 多按了 Shift，都不算命中（否则会在别的软件里抢键）
  assert.equal(matchesHotkey(ev({}), DEFAULT_HOTKEY), false);
  assert.equal(matchesHotkey(ev({ ctrlKey: true }), DEFAULT_HOTKEY), false);
  assert.equal(matchesHotkey(ev({ altKey: true, shiftKey: true }), DEFAULT_HOTKEY), false);
  assert.equal(matchesHotkey(ev({ altKey: true, keyCode: 191 }), DEFAULT_HOTKEY), false);

  // 偏好里的脏数据（缺 vk / 类型不对 / null）一律退回默认，不能让设置页一存就崩
  assert.deepEqual(normalizeHotkey(null), DEFAULT_HOTKEY);
  assert.deepEqual(normalizeHotkey({ vk: "192" }), DEFAULT_HOTKEY);
  const custom = normalizeHotkey({ vk: 81, ctrl: true, alt: true, label: "Ctrl + Alt + Q" });
  assert.equal(custom.vk, 81);
  assert.equal(custom.shift, false);
  assert.equal(custom.label, "Ctrl + Alt + Q");
});

/* ─── 下面是 2026-11-28 曲线 / 时长 / 相位三处修正的护栏 ─────────────────── */

test("standardEase 端点精确，脏输入不返回 NaN", () => {
  // 端点必须精确：收尾差一点点，最后一帧会「补一下」，看起来就是跳一下
  assert.equal(standardEase(0), 0);
  assert.equal(standardEase(1), 1);
  // 非有限 / 越界：调用点在 rAF 里，返回 NaN 会让 setSize 收到 NaN 尺寸、窗口卡死
  assert.equal(standardEase(NaN), 0);
  assert.equal(standardEase(-0.5), 0);
  assert.equal(standardEase(1.5), 1);
  // 定义域内严格落在 (0,1)
  for (const x of [0.001, 0.25, 0.5, 0.75, 0.999]) {
    const y = standardEase(x);
    assert.ok(y > 0 && y < 1, `x=${x} 得到 ${y}`);
  }
});

test("standardEase 起步极慢（本卡的核心性质：不再「第一帧即峰值」）", () => {
  // 老曲线 1-(1-t)^3 在 t=0 处导数 = 3，第一帧就吃掉总行程的 23%
  const oldCurve = (t: number) => 1 - Math.pow(1 - t, 3);
  assert.ok(standardEase(0.05) < 0.02, `实测 ${standardEase(0.05)}`);
  assert.ok(oldCurve(0.05) > 0.14, `老曲线实测 ${oldCurve(0.05)}`);
  // 同一起点差 20 倍以上：这就是「猛地一冲」消失的直接原因
  assert.ok(oldCurve(0.05) / standardEase(0.05) > 20);
});

test("standardEase 单调不减，峰值斜率 < 3.1（步长 1e-3 有限差分）", () => {
  const STEPS = 1000;
  const H = 1 / STEPS;
  let prev = standardEase(0);
  let maxSlope = 0;
  for (let i = 0; i <= STEPS; i++) {
    const x = i * H;
    const y = standardEase(x);
    assert.ok(y >= prev, `x=${x.toFixed(3)} 处回退了（${prev} → ${y}）`);
    prev = y;
    if (i < STEPS) maxSlope = Math.max(maxSlope, (standardEase(x + H) - y) / H);
  }
  // 实测峰值斜率 2.735，出现在 x≈0.30（中段最快）；老曲线是 3.0 且出现在 x=0。
  assert.ok(maxSlope < 3.1, `峰值斜率 ${maxSlope}`);
  assert.ok(maxSlope > 2.5, `峰值斜率 ${maxSlope} —— 太小说明曲线被削平了`);
});

test("曲线与设计令牌 --ease-std 逐位一致（JS 副本不许与 tokens.css 漂移）", () => {
  const css = readFileSync("src/design/tokens.css", "utf8");
  const matched = /--ease-std:\s*cubic-bezier\(([^)]+)\)/.exec(css);
  assert.ok(matched, "tokens.css 里找不到 --ease-std: cubic-bezier(...)");
  const points = matched[1].split(",").map((piece) => Number(piece.trim()));
  assert.equal(points.length, 4);
  // 逐个数比：曲线副本放在 lib/quickbarAnim.ts（springs.ts 是 LB-07 承重墙，
  // 走 fast 不能碰），所以这份副本的正确性只能靠这条断言守着
  assert.deepEqual(points, [...STANDARD_EASE_CONTROL_POINTS]);
  // 顺带钉住「设计语言只有三条曲线」里 standard 那一条的身份
  assert.deepEqual([...STANDARD_EASE_CONTROL_POINTS], [0.4, 0, 0.2, 1]);
});

test("LEAD 是相位延迟：滞后轨晚 L 起跑、跑满同样 D（内容不再被压缩）", () => {
  const D = 200;
  const L = 45;
  const total = D + L;
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

  // 逐点对照定义式 pLag = clamp((t·(D+L) - L) / D)
  for (const t of [0, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 1]) {
    const expected = clamp01((t * total - L) / D);
    assert.ok(
      Math.abs(leadNormalized(t, D, L) - expected) < 1e-12,
      `t=${t}：${leadNormalized(t, D, L)} ≠ ${expected}`,
    );
  }

  // 起跑点：t = L/(D+L) 之前恒 0（相位延迟的定义 —— 滞后轨还没开始）
  assert.equal(leadNormalized(L / total, D, L), 0);
  assert.equal(leadNormalized(L / total / 2, D, L), 0);

  // 跑满点：t = 1。这正是「内容不被压缩」的证据 ——
  // 以前把 LEAD 当重映射用 `(t·D-L)/(D-L)`，滞后轨同样在 t=1 到 1，
  // 但它是把 D 压成 D-L 跑完的；而老老实现 `t - L/D` 到 0.775 就撞顶再补一帧。
  assert.equal(leadNormalized(1, D, L), 1);

  // 窗口轨到位（领先轨 = 1）时，内容轨才走到 (D-L)/D = 0.775 —— 内容还要继续跑完
  // 剩下的 L/D = 22.5% 行程。这就是相位延迟与压缩的分界线。
  // ⚠️ 任务卡 §2③ 第 5 条把这里写成「t=D/(D+L) 处 pLag 恰为 1」，那是笔误：
  //    相位延迟下 pLag=1 只出现在 t=1；t=D/(D+L) 处是 (D-L)/D。断言照定义式写，
  //    不照卡写（卡上那句自相矛盾，见本轮报告）。
  const atWindowArrival = leadNormalized(D / total, D, L);
  assert.ok(Math.abs(atWindowArrival - (D - L) / D) < 1e-12, `实测 ${atWindowArrival}`);
  assert.ok(atWindowArrival < 1);
  assert.ok(Math.abs(1 - atWindowArrival - L / D) < 1e-12);
});

/** 一帧的高度序列（任务卡 §1 的口径）：Δ=980 逻辑 px、60fps、t = k·16.67/totalMs */
const FRAME_MS = 16.67;
const DELTA_PX = 980;

interface Frame {
  win: number;
  content: number;
}

/** 一条时间轴的定义（新旧实现只在这几个数上不同） */
interface Timeline {
  /** 单条轨的时长（毫秒） */
  durationMs: number;
  /** 滞后轨晚起跑的时间（毫秒） */
  leadMs: number;
  /**
   * 时间轴总长（毫秒）——**必须显式给**，不能由 durationMs+leadMs 推：
   * 旧实现把 LEAD 当「重映射」用，它的 `t` 分母是 durationMs（200），
   * 不是 durationMs + leadMs（245）。早先这里写死 `totalMs = D + L`，
   * 反证分支算出来的旧内容峰值是 207.0 而不是 264.4（模型没复刻旧代码，见 QA P2-5）。
   */
  totalMs: number;
  shrinking: boolean;
  ease: (x: number) => number;
  lagOf: (t: number) => number;
}

/**
 * 按 animateHeight 的时间轴算逐帧高度（不取整：取整只是每帧 ≤1px 的量化噪声，
 * 这里量的是曲线与时间轴的形状）。
 */
function frameHeights(tl: Timeline): Frame[] {
  const { durationMs, totalMs, shrinking, ease, lagOf } = tl;
  // 收起的起点是 Δ、终点是 0 —— 方向只影响 from/to，不影响进度映射，
  // 所以「进度更大 = 更矮」在收起方向是相反号；漏掉这一步会把圆角不变量判反。
  const from = shrinking ? DELTA_PX : 0;
  const to = shrinking ? 0 : DELTA_PX;
  const heightOf = (p: number) => from + (to - from) * ease(p);
  const frames: Frame[] = [];
  for (let k = 0; ; k++) {
    const elapsed = k * FRAME_MS;
    const t = Math.min(1, elapsed / totalMs);
    const pLead = Math.min(1, (t * totalMs) / durationMs);
    const pLag = lagOf(t);
    // 圆角不变量：展开时窗口领先、收起时内容领先 —— 窗口高度恒 ≥ 内容高度
    const tw = shrinking ? pLag : pLead;
    const tf = shrinking ? pLead : pLag;
    frames.push({ win: heightOf(tw), content: heightOf(tf) });
    if (elapsed >= totalMs) break;
  }
  return frames;
}

/** 单帧最大位移（两条轨分别取） */
function peakStep(frames: Frame[]): Frame {
  let win = 0;
  let content = 0;
  for (let i = 1; i < frames.length; i++) {
    win = Math.max(win, Math.abs(frames[i].win - frames[i - 1].win));
    content = Math.max(content, Math.abs(frames[i].content - frames[i - 1].content));
  }
  return { win, content };
}

test("帧位移护栏：Δ=980 / 60fps 下两条轨单帧峰值都 ≤ 170 逻辑 px", () => {
  // ⚠️ 时长与 LEAD **必须从 src import**，不许在这里写 280 / 45：
  // 抄字面量的话，这道护栏量的是「抄进来的那个数」而不是产品在用的那个 ——
  // 把 `QUICKBAR_ANIM_MS` 改回 200，测试照样全绿，而产品会退化成内容轨 276.2 px/帧
  // （比改前 264.4 还差）。这正是本卡 §1 反复强调「曲线与时长必须成对」的机械保险。
  const D = QUICKBAR_ANIM_MS;
  const L = QUICKBAR_ANIM_LEAD_MS;
  const totalMs = D + L; // 与 animateHeight 的 step 里同一行
  for (const shrinking of [false, true]) {
    const label = shrinking ? "收起" : "展开";
    const frames = frameHeights({
      durationMs: D,
      leadMs: L,
      totalMs,
      shrinking,
      ease: standardEase,
      lagOf: (t) => leadNormalized(t, D, L),
    });
    const peak = peakStep(frames);
    // 实测窗口轨 153.7 / 内容轨 155.4（60fps 逐帧差分）；
    // 任务卡 §1 的 159.5 是「峰值斜率 2.7347 × Δ × 16.67/280」的上界估计，
    // 两者差 3.6%（窗口轨）/ 2.6%（内容轨），且都在安全方向。
    assert.ok(peak.win <= 170, `${label}窗口轨单帧峰值 ${peak.win.toFixed(1)}px`);
    assert.ok(peak.content <= 170, `${label}内容轨单帧峰值 ${peak.content.toFixed(1)}px`);
    // 圆角不变量：任何一帧窗口都不比内容矮（否则窗口底边会裁出直角）
    for (const frame of frames) {
      assert.ok(frame.win >= frame.content - 1e-9);
    }
    // 最后一帧必须真的到位（否则收尾会补一帧，看起来跳一下）
    const landing = shrinking ? 0 : DELTA_PX;
    const last = frames[frames.length - 1];
    assert.ok(Math.abs(last.win - landing) < 1e-9, `${label}窗口落点 ${last.win}`);
    assert.ok(Math.abs(last.content - landing) < 1e-9, `${label}内容落点 ${last.content}`);
  }

  /*
   * 反证：把同一口径套回旧参数（200ms + `1-(1-t)^3` + 把 LEAD 当压缩用）。
   * 这一支必须**复刻旧实现**才有意义，所以 totalMs 显式给 200 —— 旧代码的 `t` 是
   * `elapsed/duration`，LEAD 只参与重映射、不参与总时长。
   * 两个数要与卡 §1 表格的 225.2 / 264.4 对得上（±0.5），对不上就说明模型跑偏、
   * 这条「旧参数必然超标」的反证是假的。
   */
  const OLD_MS = 200;
  const OLD_LEAD = 45;
  const oldEase = (t: number) => 1 - Math.pow(1 - t, 3);
  const oldLag = (t: number) => Math.max(0, Math.min(1, (t * OLD_MS - OLD_LEAD) / (OLD_MS - OLD_LEAD)));
  for (const shrinking of [false, true]) {
    const peak = peakStep(
      frameHeights({
        durationMs: OLD_MS,
        leadMs: OLD_LEAD,
        totalMs: OLD_MS,
        shrinking,
        ease: oldEase,
        lagOf: oldLag,
      }),
    );
    const worst = Math.max(peak.win, peak.content);
    assert.ok(worst > 220, `旧参数单帧峰值只有 ${worst.toFixed(1)}px —— 护栏没在量真东西`);
    // 旧实现是「窗口领先」的对照：展开 225.2/264.4，收起镜像过来
    const expectWin = shrinking ? 264.4 : 225.2;
    const expectContent = shrinking ? 225.2 : 264.4;
    assert.ok(Math.abs(peak.win - expectWin) < 0.5, `旧实现窗口轨应 ≈${expectWin}，实得 ${peak.win.toFixed(1)}`);
    assert.ok(
      Math.abs(peak.content - expectContent) < 0.5,
      `旧实现内容轨应 ≈${expectContent}，实得 ${peak.content.toFixed(1)}`,
    );
  }
});
