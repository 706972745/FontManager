import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * 底栏两个组件的**挂载契约**：任何状态下都不许让渲染路径抛异常。
 *
 * 事故（2026-11-19，2.4.4）：为了给底栏套进出动画，把 `ApplyProgress` 里的
 * `if (!apply && !notice) return null` 删掉了，只留下 `{!apply ? notice!.done : …}`。
 * JSX 子节点是**每次渲染都求值**的，冷启动时 apply 与 notice 都是 null → 抛
 * `TypeError: Cannot read properties of null`；项目没有 ErrorBoundary，
 * 整个 React 树被卸载，主窗口永远不调 `splash_done` → 启动页一直停在
 * 「正在读取上次启用的字体…」。用户看到的就是「卡在启动页打不开」。
 *
 * 这条测试扫源码，钉住两件事：
 * ① 不许再有 `xxx!.` 这类非空断言（TS 的 `!` 在运行时不叫，值真为 null 就炸）；
 * ② 两个调用方不许再 `if (!show) return null`（会把 AnimatePresence 连退出动画卸载）。
 * 扫源码而不是跑渲染：单测环境里没有 React DOM，也没有 WebView2。
 */

const read = (p: string) => readFileSync(p, "utf8");

/** 只看代码：注释里会引用反例（`notice!.done`），照样会被正则逮住。 */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

test("ApplyProgress 在 apply / notice 都为空时渲染 null，而不是去读它们的属性", () => {
  const src = code(read("src/components/ApplyProgress.tsx"));

  assert.doesNotMatch(
    src,
    /[A-Za-z_)]!\./,
    "出现非空断言 `x!.` —— 冷启动拿到的就是 null，运行时会抛异常卡死启动页",
  );
  assert.match(
    src,
    /\n\s*\) : null\}/,
    "缺少「两者都为空就渲染 null」的兜底分支（三元必须有第三条路）",
  );
  assert.match(
    src,
    /const note = notice \?\?/,
    "notice 必须先收敛成非空局部变量再进分支，不能在 JSX 里直接用 store 值",
  );
});

test("底栏调用方都不提前 return null（那会把退出动画一起卸载）", () => {
  for (const file of ["src/components/ApplyProgress.tsx", "src/components/LoadProgress.tsx"]) {
    assert.doesNotMatch(
      read(file),
      /if \(![A-Za-z]+\) return null;/,
      `${file} 又提前 return null 了：BottomBar 的退出动画会整段消失`,
    );
  }
});
