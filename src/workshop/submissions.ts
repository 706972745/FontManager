/**
 * 「我已经提交、但还没落地」的两类动作 —— **跨弹窗存活**。
 *
 * - `uploads`：已经开了 PR、等维护者合并。合并前插件中心里根本看不到这个插件。
 * - `takedowns`：已经提交下架，等仓库 Action 执行和清单重算。
 *
 * 为什么必须落盘（不是组件内 state）：
 * 上传弹窗每次打开都是**重新挂载**，state 一关就没。2026-11-26 用户反馈的两条
 * 「重新打开上传窗口」问题都出在这儿 ——
 * ① 提交完关掉再开，等待审批的提示没了，用户以为没上架成功；
 * ② 下架后关掉再开，灰条消失、按钮又变回可点，用户以为没下架成功。
 *
 * 存在 localStorage + 模块级缓存：面板窗口不关（失焦只是隐藏）时 origin 不变，
 * 状态就一直在。面板窗口本身关了再开是新端口、origin 会变，这一类跨重启的记录
 * 只能靠主程序的 prefs —— 不在这条链路的必需项里，这里先保证「同一窗口内不再失忆」。
 */

const KEY = "fontmanager.workshop.submissions.v1";

/** 下架通常几十秒生效；超过半小时还挂着，说明这次没成功，标记该丢了 */
const TAKEDOWN_TTL_MS = 30 * 60_000;
/** 上传：PR 可能挂几天没人合并。记录留 14 天，期间重开窗口都能看到进度 */
const UPLOAD_TTL_MS = 14 * 24 * 3600_000;

/** PR 的三种结局：还在等合并 / 已合并 / 被关掉（不合并） */
export type UploadState = "pending" | "merged" | "closed";

export interface UploadRecord {
  /** 目录名（`<id>__<作者>`）——和 registry 的目录口径一致，跨账户也认得出 */
  dir: string;
  id: string;
  name: string;
  version: string;
  prNumber: number;
  prUrl: string;
  /** 提交时间（毫秒），用来显示「什么时候提交的」并做过期清理 */
  at: number;
  state: UploadState;
  /** 最近一次问过 GitHub 的时间 —— 只是记录，界面上不显示 */
  checkedAt?: number;
}

export interface TakedownRecord {
  dir: string;
  id: string;
  name: string;
  at: number;
  /** `direct` = 维护者直推 main（即时生效）；`issue` = 作者开 [takedown] issue */
  mode: "direct" | "issue";
  issueNumber?: number;
  issueUrl?: string;
  /**
   * 目录探测确认「仓库里已经没了」的时间。
   *
   * 有它就能把标签从「已下架（待生效）」换成「已下架」—— 清单（index.json）还要
   * 等聚合脚本重算，标签如果一直写「待生效」，用户会以为下架没成功。
   */
  goneAt?: number;
  /**
   * 用户在界面里点过「清除这条」。
   *
   * 记录**不能删**：清单没重算之前，条目还在 `entries` 里，删了记录那一行就会
   * 变回「下架」按钮（用户以为没下架成功，还会重复提交）。所以只打一个隐藏标记 ——
   * 列表不再占位置，插件在中心里也仍然隐藏，等清单更新后记录自然收工。
   */
  hidden?: boolean;
}

export interface SubmissionStore {
  uploads: UploadRecord[];
  takedowns: TakedownRecord[];
}

const EMPTY: SubmissionStore = { uploads: [], takedowns: [] };

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // 隐私模式 / 配额异常：当没有持久化，本次仍用内存
    return null;
  }
}

let memory: SubmissionStore | null = null;

function isUpload(v: unknown): v is UploadRecord {
  const r = v as UploadRecord | null;
  return (
    !!r &&
    typeof r.dir === "string" &&
    r.dir.length > 0 &&
    typeof r.id === "string" &&
    typeof r.prNumber === "number" &&
    typeof r.prUrl === "string" &&
    typeof r.at === "number"
  );
}

function isTakedown(v: unknown): v is TakedownRecord {
  const r = v as TakedownRecord | null;
  return (
    !!r &&
    typeof r.dir === "string" &&
    r.dir.length > 0 &&
    typeof r.id === "string" &&
    typeof r.at === "number"
  );
}

function prune(s: SubmissionStore, now = Date.now()): SubmissionStore {
  const uploads = s.uploads.filter((r) => now - r.at < UPLOAD_TTL_MS);
  const takedowns = s.takedowns.filter((r) => now - r.at < TAKEDOWN_TTL_MS);
  if (uploads.length === s.uploads.length && takedowns.length === s.takedowns.length) return s;
  return { uploads, takedowns };
}

/** 读全量记录（同步）。第一次读盘后就一直用内存那份，避免每次渲染都 JSON.parse */
export function readStore(): SubmissionStore {
  if (memory) return memory;
  let parsed: SubmissionStore = EMPTY;
  try {
    const raw = storage()?.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<SubmissionStore>;
      parsed = {
        uploads: Array.isArray(v.uploads) ? v.uploads.filter(isUpload) : [],
        takedowns: Array.isArray(v.takedowns) ? v.takedowns.filter(isTakedown) : [],
      };
    }
  } catch {
    parsed = EMPTY;
  }
  memory = prune(parsed);
  return memory;
}

function commit(next: SubmissionStore): SubmissionStore {
  memory = prune(next);
  try {
    storage()?.setItem(KEY, JSON.stringify(memory));
  } catch {
    // 写不进去只影响「关掉窗口还记不记得」，不影响本次
  }
  return memory;
}

/** 记录一次上传（同一个目录以最新一次为准：重传就是覆盖） */
export function addUploads(rows: Omit<UploadRecord, "at" | "state">[]): SubmissionStore {
  const cur = readStore();
  const at = Date.now();
  const next = [...cur.uploads];
  for (const row of rows) {
    const i = next.findIndex((r) => r.dir === row.dir);
    const rec: UploadRecord = { ...row, at, state: "pending" };
    if (i >= 0) next[i] = rec;
    else next.push(rec);
  }
  return commit({ ...cur, uploads: next });
}

export function patchUpload(dir: string, patch: Partial<UploadRecord>): SubmissionStore {
  const cur = readStore();
  const i = cur.uploads.findIndex((r) => r.dir === dir);
  if (i < 0) return cur;
  const next = [...cur.uploads];
  next[i] = { ...next[i], ...patch };
  return commit({ ...cur, uploads: next });
}

export function dropUpload(dir: string): SubmissionStore {
  const cur = readStore();
  const next = cur.uploads.filter((r) => r.dir !== dir);
  if (next.length === cur.uploads.length) return cur;
  return commit({ ...cur, uploads: next });
}

/** 记录一次下架（同一个目录以最新一次为准：失败后重试就是覆盖） */
export function addTakedown(row: Omit<TakedownRecord, "at">): SubmissionStore {
  const cur = readStore();
  const next = cur.takedowns.filter((r) => r.dir !== row.dir);
  next.push({ ...row, at: Date.now() });
  return commit({ ...cur, takedowns: next });
}

export function patchTakedown(dir: string, patch: Partial<TakedownRecord>): SubmissionStore {
  const cur = readStore();
  const i = cur.takedowns.findIndex((r) => r.dir === dir);
  if (i < 0) return cur;
  const next = [...cur.takedowns];
  next[i] = { ...next[i], ...patch };
  return commit({ ...cur, takedowns: next });
}

export function dropTakedown(dir: string): SubmissionStore {
  const cur = readStore();
  const next = cur.takedowns.filter((r) => r.dir !== dir);
  if (next.length === cur.takedowns.length) return cur;
  return commit({ ...cur, takedowns: next });
}

/** 还在等合并的上传（面板据此决定要不要持续拉清单） */
export function pendingUploads(): UploadRecord[] {
  return readStore().uploads.filter((r) => r.state === "pending");
}

/** 还没落地的动作条数：面板用它决定「要不要每十几秒强拉一次清单」 */
export function pendingCount(): number {
  const s = readStore();
  return s.takedowns.length + s.uploads.filter((r) => r.state === "pending").length;
}

/** 测试用：把内存与盘上的记录都清掉 */
export function resetStore(): void {
  memory = EMPTY;
  try {
    storage()?.removeItem(KEY);
  } catch {
    // 无所谓
  }
}
