import { useT, type TKey } from "../lib/i18n";
import { hasScriptNote, type ScriptStatus } from "../lib/scriptCoverage";

/**
 * 「这个字重画不出示例文字里的某种文字」的提示。
 *
 * 它顶替的是示例文字本身（不是挂在旁边的小标），所以样式跟「这种格式暂时无法预览」
 * 统一：灰色小字、不加边框（0.9.3-5 用户要求）。文案跟着示例文字的语言走：
 * 输入中文就写「无中文」，输入日文就写「无日文」，缺多种时只显示第一种、
 * 悬停提示说明缺的是哪几种。
 *
 * 两档区别（0.9.3-7）：`missing` 是一个字形都没有，`partial` 是有但明显不全
 * （只做了几百个汉字那种）。后者不能排正文，得说清楚，笼统说「有中文」等于骗人。
 *
 * `hint` 是给「无中文」补的指路信息，例如「中文见 HarmonyOS Sans SC」——
 * 华为鸿蒙这类按语言拆包的字体，基础版确实是纯西文，但用户手里有中文版，
 * 不指出来就会以为软件判错了。
 */
export function ScriptChip({
  status,
  hint,
  className,
}: {
  status: ScriptStatus | null | undefined;
  /** 追加在标注后面的指路文字（调用方负责翻译） */
  hint?: string | null;
  className?: string;
}) {
  const t = useT();
  if (!status || !hasScriptNote(status)) return null;

  const isMissing = status.missing.length > 0;
  const names = [...status.missing, ...status.partial].map((id) => t(`script.${id}` as TKey));
  const label = isMissing
    ? t("card.noScript", { script: names[0] })
    : t("card.partialScript", { script: names[0] });
  const title = isMissing
    ? t("card.noScriptTitle", { script: names.join(" / ") })
    : t("card.partialScriptTitle", { script: names.join(" / ") });

  return (
    <span className={`script-note ${className ?? ""}`.trim()} title={title}>
      {label}
      {hint ? <span className="script-hint">{hint}</span> : null}
    </span>
  );
}
