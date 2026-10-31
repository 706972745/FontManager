import type { AdobeApp } from "../lib/ipc";

/**
 * 「在 … 中应用」前面的字母徽标：Ps / Ai / CDR。
 *
 * 这三项原来共用同一个 PenTool 图标，右键菜单里三行长得一模一样，
 * 只能靠右边的文字分辨（用户 2026-10-31 反馈「看不出区别」）。
 * 改成带边框的小方块 + 各家缩写，一眼就能对上是哪个软件。
 */
const LABEL: Record<AdobeApp, string> = {
  photoshop: "Ps",
  illustrator: "Ai",
  coreldraw: "CDR",
};

export function AppBadge({ app }: { app: AdobeApp }) {
  const text = LABEL[app] ?? app.slice(0, 2).toUpperCase();
  return (
    <span className={`app-badge${text.length > 2 ? " app-badge-wide" : ""}`} aria-hidden>
      {text}
    </span>
  );
}
