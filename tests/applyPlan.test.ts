import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APPLY_CHUNK,
  dropRedundantCopies,
  planBatches,
  reverseBatches,
  runBatches,
  type ApplyBatch,
} from "../src/lib/applyPlan.ts";
import type { FontFace } from "../src/lib/ipc.ts";

function face(over: Partial<FontFace>): FontFace {
  return {
    id: over.path ?? "",
    path: "",
    previewPath: null,
    faceIndex: 0,
    family: "Inter",
    style: "Regular",
    postscriptName: "Inter-Regular",
    foundry: null,
    license: null,
    licenseUrl: null,
    copyright: null,
    format: "ttf",
    isVariable: false,
    axes: [],
    weight: 400,
    italic: false,
    monospaced: false,
    classification: "sans",
    scripts: [],
    features: [],
    glyphCount: 0,
    fileSize: 0,
    source: "managed",
    deactivatable: true,
    active: false,
    ...over,
  } as FontFace;
}

// ---- 批次编排 ----

test("planBatches：先停用后启用，按 chunk 切片", () => {
  const off = ["a", "b", "c"];
  const on = ["d", "e", "f"];
  const batches = planBatches(off, on, 2);
  assert.deepEqual(
    batches.map((b) => [b.active, b.paths]),
    [
      [false, ["a", "b"]],
      [false, ["c"]],
      [true, ["d", "e"]],
      [true, ["f"]],
    ],
  );
});

test("planBatches：默认 chunk 是 10", () => {
  assert.equal(APPLY_CHUNK, 10);
  const batches = planBatches([], Array.from({ length: 25 }, (_, i) => `p${i}`));
  assert.equal(batches.length, 3);
  assert.deepEqual(batches.map((b) => b.paths.length), [10, 10, 5]);
});

test("planBatches：空输入不产生批次", () => {
  assert.deepEqual(planBatches([], []), []);
});

test("reverseBatches：顺序反转且动作取反（撤销靠它）", () => {
  const applied: ApplyBatch[] = [
    { paths: ["a"], active: false },
    { paths: ["b"], active: true },
  ];
  assert.deepEqual(reverseBatches(applied), [
    { paths: ["b"], active: false },
    { paths: ["a"], active: true },
  ]);
});

// ---- 重复副本 ----

test("dropRedundantCopies：同一字面已有副本启用时不重复启用", () => {
  const managed = face({ path: "E:/lib/inter.ttf", postscriptName: "Inter-Regular" });
  const system = face({ path: "C:/Windows/Fonts/inter.ttf", postscriptName: "Inter-Regular" });
  const faces = new Map([
    [managed.path, managed],
    [system.path, system],
  ]);
  const activeKeys = new Set(["ps:inter-regular"]);
  const keyOf = (f: FontFace) => `ps:${(f.postscriptName ?? "").toLowerCase()}`;
  const r = dropRedundantCopies([managed.path, system.path], faces, activeKeys, keyOf);
  assert.equal(r.keep.length, 0);
  assert.equal(r.skipped, 2);
});

test("dropRedundantCopies：没有启用副本时全部保留", () => {
  const f = face({ path: "E:/lib/inter.ttf", postscriptName: "Inter-Regular" });
  const keyOf = (x: FontFace) => `ps:${(x.postscriptName ?? "").toLowerCase()}`;
  const r = dropRedundantCopies([f.path], new Map([[f.path, f]]), new Set(), keyOf);
  assert.deepEqual(r.keep, [f.path]);
  assert.equal(r.skipped, 0);
});

test("dropRedundantCopies：不同字面互不影响", () => {
  const a = face({ path: "a.ttf", postscriptName: "A-Regular" });
  const b = face({ path: "b.ttf", postscriptName: "B-Regular" });
  const faces = new Map([
    [a.path, a],
    [b.path, b],
  ]);
  const keyOf = (f: FontFace) => `ps:${(f.postscriptName ?? "").toLowerCase()}`;
  const r = dropRedundantCopies([a.path, b.path], faces, new Set(["ps:a-regular"]), keyOf);
  assert.deepEqual(r.keep, ["b.ttf"]);
  assert.equal(r.skipped, 1);
});

// ---- 执行器：三个出口都必须落盘 ----

function recorder(failAt?: number) {
  const calls: { batch: ApplyBatch; noSave: boolean }[] = [];
  const progress: number[] = [];
  const state = { flushes: 0 };
  return {
    calls,
    progress,
    state,
    opts(batches: ApplyBatch[], extra: Partial<Parameters<typeof runBatches>[0]> = {}) {
      return {
        batches,
        apply: async (batch: ApplyBatch, noSave: boolean) => {
          calls.push({ batch, noSave });
          if (failAt !== undefined && calls.length === failAt) throw new Error("boom");
        },
        flush: async () => {
          state.flushes++;
        },
        onProgress: (done: number) => progress.push(done),
        yieldToUi: async () => {},
        ...extra,
      };
    },
  };
}

test("runBatches：只有最后一批落盘，其余跳过", async () => {
  const rec = recorder();
  const batches = planBatches([], ["a", "b", "c"], 1);
  const out = await runBatches(rec.opts(batches));
  assert.equal(out.status, "done");
  assert.equal(out.done, 3);
  assert.deepEqual(rec.calls.map((c) => c.noSave), [true, true, false]);
  assert.equal(rec.state.flushes, 0, "正常走完靠最后一批落盘，不需要额外 flush");
  assert.deepEqual(rec.progress, [1, 2, 3]);
});

test("runBatches：中途取消 → 停止并补一次落盘", async () => {
  const rec = recorder();
  let checks = 0;
  const batches = planBatches([], ["a", "b", "c", "d"], 1);
  const out = await runBatches(rec.opts(batches, { isCancelled: () => checks++ >= 2 }));
  assert.equal(out.status, "cancelled");
  assert.equal(out.done, 2, "取消后不该继续跑后面的批次");
  assert.equal(rec.calls.length, 2);
  assert.equal(rec.state.flushes, 1, "取消必须补落盘，否则内存改了磁盘还是旧的");
});

test("runBatches：某批抛错 → 返回 failed 且补一次落盘", async () => {
  const rec = recorder(2);
  const batches = planBatches([], ["a", "b", "c"], 1);
  const out = await runBatches(rec.opts(batches));
  assert.equal(out.status, "failed");
  assert.equal(out.done, 1);
  assert.equal(rec.state.flushes, 1, "失败也要落盘，否则状态对不上");
  assert.match(String(out.error), /boom/);
});

test("runBatches：第一批就取消，不做任何启停但补落盘", async () => {
  const rec = recorder();
  const batches = planBatches([], ["a"], 1);
  const out = await runBatches(rec.opts(batches, { isCancelled: () => true }));
  assert.equal(out.status, "cancelled");
  assert.equal(rec.calls.length, 0);
  assert.equal(rec.state.flushes, 1);
});
