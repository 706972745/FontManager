import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { dockKeysFor, splitDockHint } from "../src/lib/dockHint.ts";

/**
 * 折叠提示条的拆分逻辑（待定清单 C4）。
 *
 * 之前 `splitDockHint` 埋在 QuickBar.tsx 里，没法测：9 个语言包里只要有一个把
 * 「·」换成「:」或「,」，右端操作引导会**静默消失** —— 不报错、不崩，只是整句
 * 跑到左边。这条测试遍历全部语言包，把「拆不开」变成红灯。
 */

const here = dirname(fileURLToPath(import.meta.url));
const LOCALES = join(here, "..", "src", "locales");

function localeFiles(): string[] {
  return readdirSync(LOCALES).filter((f) => f.endsWith(".json"));
}

test("每个语言包的折叠提示都能拆成左右两端", () => {
  const files = localeFiles();
  assert.ok(files.length >= 9, `语言包应至少有 9 个，实际 ${files.length}`);

  for (const f of files) {
    const json = JSON.parse(readFileSync(join(LOCALES, f), "utf8")) as Record<string, string>;
    const raw = json["quickbar.collapsedHint"];
    assert.equal(typeof raw, "string", `${f} 缺 quickbar.collapsedHint`);
    assert.ok(raw.includes("{hotkey}"), `${f} 的折叠文案缺 {hotkey} 占位符`);

    const parts = splitDockHint(raw);
    assert.ok(parts.state.length > 0, `${f} 拆不出左端状态`);
    assert.ok(
      (parts.lead + parts.tail).length > 0,
      `${f} 拆不出右端操作引导（分隔符可能被改成了「:」「,」之类）`,
    );
    // 拆完不能丢字：两端拼回去要等于去掉分隔符与占位符的原文
    const joined = (parts.state + parts.lead + parts.tail).replace(/\s+/g, "");
    const expected = raw
      .replace("{hotkey}", "")
      .replace(/[·—]/g, "")
      .replace(/\s+/g, "");
    assert.equal(joined, expected, `${f} 拆分后文字有出入`);
  }
});

test("取不到分隔符时整句退回左端，不丢字", () => {
  const parts = splitDockHint("速览已收起 靠近或按 {hotkey} 展开");
  assert.equal(parts.state, "速览已收起 靠近或按");
  assert.equal(parts.lead, "");
  assert.equal(parts.tail, "展开");
});

test("键帽只在 ≤2 枚时拆；长组合退回纯文本", () => {
  assert.deepEqual(dockKeysFor("Alt + `"), { keys: ["Alt", "`"], plain: "" });
  assert.deepEqual(dockKeysFor("F1"), { keys: ["F1"], plain: "" });
  assert.deepEqual(dockKeysFor("Ctrl + Shift + F1"), {
    keys: [],
    plain: "Ctrl + Shift + F1",
  });
});
