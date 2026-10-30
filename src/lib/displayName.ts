import { activeLocale, useT } from "./i18n";
import { displayFamilyName } from "./fontNames";
import type { Family } from "../state/fontStore";

/**
 * 组件里用：拿到「按当前界面语言取显示名」的函数。
 *
 * 单独放一个文件是为了让 `fontNames.ts` 保持零运行时依赖：
 * 单元测试直接 import 它，node 解析不了无扩展名的 `./i18n` 导入。
 * 这里订阅 i18n 变更，切换语言后列表会立即重渲染。
 */
export function useDisplayName(): (family: Family) => string {
  useT();
  return (family: Family) => displayFamilyName(family, activeLocale());
}
