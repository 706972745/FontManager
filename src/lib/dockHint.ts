/**
 * 速览折叠提示条（QB-C）的文案拆分。
 *
 * 原文是一整句「状态 · 操作」，设计上要拆成左右两端：左「速览已收起」用主文字色
 * 11px Medium，右「靠近或按 Alt + ` 展开」用次文字色 9px，中间那个「·」改成留白。
 * 拆分完全基于文案本身（各语言用「·」或「—」当分隔符），不写死任何语言的词，
 * 9 个语言包共用一套逻辑；热键本身从 {hotkey} 占位处让位，由调用方播成键帽。
 *
 * 取不到分隔符时（理论上不会有）整句退回左端，不丢字、不改词序。
 *
 * ⚠️ 单独放一个文件是为了能测（待定清单 C4）：QuickBar.tsx 引了一堆 React / Tauri
 * 依赖，node --test 直接 import 它会炸；这里的两个函数是纯字符串处理，零依赖。
 */

export interface DockHintParts {
  /** 左端：状态（「速览已收起」） */
  state: string;
  /** 分隔符之后、热键之前的引导语（「靠近或按」） */
  lead: string;
  /** 热键之后的尾句（「展开」） */
  tail: string;
}

export function splitDockHint(raw: string): DockHintParts {
  const at = raw.indexOf("{hotkey}");
  const head = at >= 0 ? raw.slice(0, at) : raw;
  const tail = at >= 0 ? raw.slice(at + "{hotkey}".length) : "";
  const m = head.match(/^(.*?)\s+[·—]\s+(.*)$/);
  return {
    state: (m ? m[1] : head).trim(),
    lead: (m ? m[2] : "").trim(),
    tail: tail.trim(),
  };
}

/**
 * 热键拆键帽（待定清单 B2）。
 *
 * 默认 `Alt + \`` 拆成两枚；用户如果把快捷键录成 `Ctrl + Shift + F1`，硬画成
 * 三枚键帽 + 两个「+」会把提示带右端挤爆（498 宽勉强，再窄就撞）。
 * 超过两枚时退回纯文本：语义一点不丢，只是不再画框。
 */
export function dockKeysFor(label: string): { keys: string[]; plain: string } {
  const parts = label.split(/\s*\+\s*/).filter(Boolean);
  return parts.length <= 2 ? { keys: parts, plain: "" } : { keys: [], plain: label };
}
