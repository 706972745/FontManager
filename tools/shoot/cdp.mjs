/**
 * 最小 CDP（Chrome DevTools Protocol）客户端 —— **零依赖**。
 *
 * 只为了驱动 FontManager 的 WebView2 做 README 截图：
 *   发现 target（`/json`）→ 连 WebSocket → `Runtime.evaluate` 操作 DOM →
 *   `Input.*` 派发真实输入 → `Page.captureScreenshot` 出图。
 *
 * 依赖的是 Node 22+ 的全局 `fetch` 与全局 `WebSocket`（`node -v` 已确认 v22.22.2）。
 * **不引 `ws`、不动 package.json**：截图工具不该成为应用的依赖负担。
 *
 * 设计要点：
 *   - `Cdp` 只依赖一个极窄的 transport 接口（`send(str)` / `onmessage(fn)` / `close()`），
 *     所以 `--dry-run` 能塞一个内存假 transport 进来，把「请求 id 关联、超时、错误、
 *     事件分发」这些逻辑在不启动应用的前提下跑通（见 shoot-readme.mjs 的 dryRun）。
 *   - 所有「操作界面」的动作都走**真实输入事件**（`Input.dispatchMouseEvent` /
 *     `Input.dispatchKeyEvent`），而不是 `element.click()`：
 *     历史教训是「按屏幕坐标点」会带出悬停高亮假象、窗口被抢焦点后坐标全偏；
 *     反过来 `el.click()` 又不触发 pointer 序列，React 里基于 pointer 的组件（拖动、
 *     抓手条、hover 提示）反应不一致。CDP 的 Input 域是渲染进程内的真实输入，
 *     坐标是 viewport 坐标、与窗口在屏幕上的位置无关 —— 两者的问题都绕开了。
 */
import { setTimeout as delay } from "node:timers/promises";

/** CDP 修饰键位掩码 */
export const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

/**
 * 真实 WebSocket transport。
 * @param {string} url ws://...
 * @param {{timeoutMs?: number}} [opts]
 */
export class WsTransport {
  constructor(ws) {
    this.ws = ws;
    this.onmessage = null;
    this.onclose = null;
    ws.addEventListener("message", (ev) => {
      this.onmessage?.(typeof ev.data === "string" ? ev.data : String(ev.data));
    });
    ws.addEventListener("close", () => this.onclose?.());
  }

  static async connect(url, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 8000;
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`WebSocket 连接超时（${timeoutMs}ms）：${url}`));
      }, timeoutMs);
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error(`WebSocket 连接失败：${url}`));
        },
        { once: true },
      );
    });
    return new WsTransport(ws);
  }

  send(str) {
    this.ws.send(str);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 内存 transport（只给 --dry-run 用）：按方法名回放预置结果，
 * 顺序故意打乱一部分，用来验证「响应按 id 关联」而不是「按到达顺序匹配」。
 */
export class MockTransport {
  /**
   * @param {(method: string, params: any) => any} handler 返回结果对象；
   *        抛错则模拟 CDP error 响应
   */
  constructor(handler) {
    this.handler = handler;
    this.onmessage = null;
    this.onclose = null;
    this.closed = false;
    this.calls = [];
  }

  send(str) {
    const msg = JSON.parse(str);
    this.calls.push(msg.method);
    let payload;
    try {
      payload = { id: msg.id, result: this.handler(msg.method, msg.params ?? {}) ?? {} };
    } catch (err) {
      payload = { id: msg.id, error: { code: -32000, message: String(err?.message ?? err) } };
    }
    // 故意异步两跳，模拟真实网络往返
    setTimeout(() => {
      if (!this.closed) this.onmessage?.(JSON.stringify(payload));
    }, 0);
  }

  close() {
    this.closed = true;
    this.onclose?.();
  }
}

/** 一条 CDP 连接 */
export class Cdp {
  /**
   * @param {WsTransport|MockTransport} transport
   * @param {string} [label] 日志里用的名字
   */
  constructor(transport, label = "cdp") {
    this.transport = transport;
    this.label = label;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    transport.onmessage = (raw) => this.#onMessage(raw);
    transport.onclose = () => this.#onClose();
  }

  #onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(new Error(`${entry.method} 失败：${msg.error.message ?? JSON.stringify(msg.error)}`));
      } else {
        entry.resolve(msg.result ?? {});
      }
      return;
    }
    if (msg.method) {
      const hs = this.listeners.get(msg.method);
      if (hs) for (const h of [...hs]) h(msg.params ?? {});
    }
  }

  #onClose() {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`${entry.method} 未完成：连接已关闭`));
    }
    this.pending.clear();
  }

  /** 订阅事件 */
  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
    return () => this.listeners.get(method)?.delete(handler);
  }

  /**
   * 发一条命令并等响应。
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {{timeoutMs?: number}} [opts]
   */
  async send(method, params = {}, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 20000;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.transport.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async enable() {
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    return this;
  }

  // ---------------------------------------------------------------- Runtime

  /**
   * 在页面里求值，返回 JS 值（走 returnByValue）。
   * 页面内抛异常直接转成 Node 侧异常，并带上页面栈 —— 静默的 undefined 最难查。
   * @param {string} expression
   * @param {{timeoutMs?: number}} [opts]
   */
  async evaluate(expression, opts = {}) {
    const res = await this.send(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      },
      opts,
    );
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      const text = d.exception?.description ?? d.text ?? "未知页面异常";
      throw new Error(`页面内求值异常：${text}`);
    }
    return res.result?.value;
  }

  // -------------------------------------------------------------- Viewport

  /**
   * 固定布局视口。14 张图尺寸必须一致，就靠它。
   * @param {{width:number,height:number,deviceScaleFactor?:number}} spec
   */
  async setViewport(spec) {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width: Math.round(spec.width),
      height: Math.round(spec.height),
      deviceScaleFactor: spec.deviceScaleFactor ?? 1,
      mobile: false,
      screenWidth: Math.round(spec.width),
      screenHeight: Math.round(spec.height),
    });
  }

  async clearViewport() {
    await this.send("Emulation.clearDeviceMetricsOverride");
  }

  /**
   * 等页面真的画完：两帧 rAF + 一小段静置。
   * 只等 rAF 不够 —— 字体加载完成的后续 layout、motion 的入场动画都在下一帧之后。
   * @param {{frames?: number, settleMs?: number}} [opts]
   */
  async waitFrames(opts = {}) {
    const frames = opts.frames ?? 2;
    const settleMs = opts.settleMs ?? 160;
    await this.evaluate(
      `new Promise((resolve) => {
         let n = ${frames};
         const tick = () => (--n <= 0 ? resolve(true) : requestAnimationFrame(tick));
         requestAnimationFrame(tick);
       })`,
    ).catch(() => {
      /* 页面正在导航时求值会失败，交给后面的静置兜住 */
    });
    if (settleMs > 0) await delay(settleMs);
  }

  // --------------------------------------------------------------- 元素查询

  /** @param {string} selector 是否存在 */
  async exists(selector) {
    return (await this.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)) === true;
  }

  /** @param {string} selector 匹配数量 */
  async count(selector) {
    return Number(await this.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`)) || 0;
  }

  /** @param {string} selector 文本内容（去首尾空白） */
  async text(selector) {
    return await this.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.textContent.trim() : null; })()`,
    );
  }

  /** @param {string} selector 元素 rect（viewport 坐标，CSS px） */
  async rect(selector) {
    return await this.evaluate(
      `(() => {
         const el = document.querySelector(${JSON.stringify(selector)});
         if (!el) return null;
         const r = el.getBoundingClientRect();
         return { x: r.left, y: r.top, width: r.width, height: r.height };
       })()`,
    );
  }

  /**
   * 轮询等待元素出现。
   * @param {string} selector
   * @param {{timeoutMs?: number, intervalMs?: number, what?: string}} [opts]
   */
  async waitFor(selector, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 15000;
    const intervalMs = opts.intervalMs ?? 100;
    const t0 = Date.now();
    let lastErr = null;
    while (Date.now() - t0 < timeoutMs) {
      try {
        if (await this.exists(selector)) return true;
      } catch (err) {
        lastErr = err; // 页面正在导航 / 重挂载：继续等
      }
      await delay(intervalMs);
    }
    throw new Error(
      `等待元素超时（${timeoutMs}ms）：${opts.what ?? selector}${lastErr ? `；最后一次错误：${lastErr.message}` : ""}`,
    );
  }

  /** 轮询等待元素消失 */
  async waitForGone(selector, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 8000;
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        if (!(await this.exists(selector))) return true;
      } catch {
        return true; // 页面没了 = 元素自然也 gone
      }
      await delay(100);
    }
    return false;
  }

  /** 轮询等待表达式为真 */
  async waitUntil(expression, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 15000;
    const what = opts.what ?? expression;
    const t0 = Date.now();
    let lastErr = null;
    while (Date.now() - t0 < timeoutMs) {
      try {
        if (await this.evaluate(expression)) return true;
      } catch (err) {
        lastErr = err;
      }
      await delay(120);
    }
    throw new Error(`等待条件超时（${timeoutMs}ms）：${what}${lastErr ? `；最后一次错误：${lastErr.message}` : ""}`);
  }

  // ------------------------------------------------------------------ 输入

  /**
   * 把鼠标移到某个坐标（viewport 坐标）。
   * 触发真实的 pointerover/mouseover —— README 里的悬停提示、hover 高亮都靠它。
   */
  async moveMouse(x, y) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  }

  /**
   * 在元素上按下并松开左键（真实输入序列：move → press → release）。
   * @param {string} selector
   * @param {{offsetX?: number, offsetY?: number, button?: "left"|"right", clickCount?: number, what?: string}} [opts]
   */
  async click(selector, opts = {}) {
    const rect = await this.rect(selector);
    if (!rect) throw new Error(`找不到要点击的元素：${opts.what ?? selector}`);
    const x = rect.x + (opts.offsetX ?? rect.width / 2);
    const y = rect.y + (opts.offsetY ?? rect.height / 2);
    if (x < 0 || y < 0 || x > 10000 || y > 10000) {
      throw new Error(`点击坐标异常（${Math.round(x)},${Math.round(y)}）：${opts.what ?? selector}`);
    }
    await this.clickAt(x, y, opts);
    return { x, y };
  }

  /** 按坐标点击 */
  async clickAt(x, y, opts = {}) {
    const button = opts.button ?? "left";
    const clickCount = opts.clickCount ?? 1;
    await this.moveMouse(x, y);
    await delay(24);
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      buttons: button === "right" ? 2 : 1,
      clickCount,
    });
    await delay(16);
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      buttons: 0,
      clickCount,
    });
  }

  /** 右键（上下文菜单） */
  async rightClick(selector, opts = {}) {
    return await this.click(selector, { ...opts, button: "right" });
  }

  /** 悬停在元素中心 */
  async hover(selector, opts = {}) {
    const rect = await this.rect(selector);
    if (!rect) throw new Error(`找不到要悬停的元素：${opts.what ?? selector}`);
    await this.moveMouse(rect.x + (opts.offsetX ?? rect.width / 2), rect.y + (opts.offsetY ?? rect.height / 2));
  }

  /**
   * 按一个键（可选修饰键）。key 用 DOM 的 `KeyboardEvent.key` 语义：
   * `"Enter"` / `"Escape"` / `"Tab"` / `"?"` / `"k"`。
   * @param {string} key
   * @param {{modifiers?: number, text?: string}} [opts]
   */
  async pressKey(key, opts = {}) {
    const modifiers = opts.modifiers ?? 0;
    const { keyCode, text } = describeKey(key, modifiers, opts.text);
    await this.send("Input.dispatchKeyEvent", {
      type: text ? "keyDown" : "rawKeyDown",
      modifiers,
      key,
      text,
      unmodifiedText: text,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    });
    await delay(12);
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers,
      key,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    });
  }

  /**
   * 逐字符键入（走真实键盘事件，粘贴不触发 keydown，会漏掉「打字即搜」这类逻辑）。
   * 非 ASCII（中文）用 char 事件送，`key` 直接填字符本身。
   * @param {string} text
   * @param {{delayMs?: number}} [opts]
   */
  async typeText(text, opts = {}) {
    const delayMs = opts.delayMs ?? 18;
    for (const ch of text) {
      const code = ch.codePointAt(0) ?? 0;
      const ascii = code < 128;
      await this.send("Input.dispatchKeyEvent", {
        type: ascii ? "keyDown" : "char",
        key: ch,
        text: ch,
        unmodifiedText: ch,
        windowsVirtualKeyCode: ascii ? code : 0,
        nativeVirtualKeyCode: ascii ? code : 0,
      });
      await delay(delayMs);
      await this.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: ch,
        windowsVirtualKeyCode: ascii ? code : 0,
        nativeVirtualKeyCode: ascii ? code : 0,
      });
      await delay(delayMs);
    }
  }

  /**
   * 直接把值写进受控输入框（React 兼容写法）。
   *
   * 为什么需要它：搜中文时用 `typeText` 要依赖 IME 语义，WebView2 里 char 事件的
   * `key` 不一定是完整汉字，「打字即搜」只在 `key.length === 1` 时才触发。这里用
   * 原生 setter 改 value 再派发 input 事件，React 的 onChange 照样会收到。
   * @param {string} selector
   * @param {string} value
   */
  async setInputValue(selector, value) {
    const ok = await this.evaluate(
      `(() => {
         const el = document.querySelector(${JSON.stringify(selector)});
         if (!el) return false;
         const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
         const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
         setter.call(el, ${JSON.stringify(value)});
         el.dispatchEvent(new Event("input", { bubbles: true }));
         el.dispatchEvent(new Event("change", { bubbles: true }));
         return true;
       })()`,
    );
    if (!ok) throw new Error(`找不到输入框：${selector}`);
  }

  /**
   * 滚动某个滚动容器，使目标元素落在容器顶部附近。
   * 不用 `scrollIntoView`：它会把**所有**祖先滚动容器一起滚（主列表也跟着动）。
   * @param {string} containerSelector
   * @param {string} targetSelector
   * @param {{alignTop?: number}} [opts]
   */
  async scrollChildIntoView(containerSelector, targetSelector, opts = {}) {
    const pad = opts.alignTop ?? 12;
    const ok = await this.evaluate(
      `(() => {
         const box = document.querySelector(${JSON.stringify(containerSelector)});
         const target = document.querySelector(${JSON.stringify(targetSelector)});
         if (!box || !target) return false;
         const delta = target.getBoundingClientRect().top - box.getBoundingClientRect().top - ${pad};
         box.scrollTop = box.scrollTop + delta;
         return true;
       })()`,
    );
    if (!ok) throw new Error(`滚动失败：${containerSelector} ← ${targetSelector}`);
  }

  /** 把某个滚动容器滚到顶 */
  async scrollToTop(containerSelector) {
    await this.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(containerSelector)}); if (el) el.scrollTop = 0; return true; })()`,
    );
  }

  // ---------------------------------------------------------------- 截图

  /**
   * 整视口截图，返回 PNG Buffer。
   * `captureBeyondViewport: false` 保证只拿 viewport 一块 —— 不含系统边框/桌面，
   * 也不含滚动区域之外的内容。
   * @param {{format?: "png"|"jpeg", quality?: number, timeoutMs?: number}} [opts]
   * @returns {Promise<Buffer>}
   */
  async capture(opts = {}) {
    const res = await this.send(
      "Page.captureScreenshot",
      {
        format: opts.format ?? "png",
        quality: opts.format === "jpeg" ? (opts.quality ?? 92) : undefined,
        fromSurface: true,
        captureBeyondViewport: false,
        optimizeForSpeed: false,
      },
      { timeoutMs: opts.timeoutMs ?? 30000 },
    );
    if (!res?.data) throw new Error("Page.captureScreenshot 没有返回数据");
    return Buffer.from(res.data, "base64");
  }

  close() {
    this.transport.close();
  }
}

/** `KeyboardEvent.key` → CDP 需要的虚拟键码 + text */
function describeKey(key, modifiers, forcedText) {
  const shift = (modifiers & MOD.shift) !== 0;
  switch (key) {
    case "Enter":
      return { keyCode: 13, text: "\r" };
    case "Tab":
      return { keyCode: 9, text: undefined };
    case "Escape":
      return { keyCode: 27, text: undefined };
    case "Backspace":
      return { keyCode: 8, text: undefined };
    case " ":
      return { keyCode: 32, text: " " };
    case "?":
      return { keyCode: 191, text: "?" };
    case "/":
      return { keyCode: 191, text: "/" };
    case "`":
      return { keyCode: 192, text: "`" };
    default: {
      if (key.length === 1) {
        const code = key.toUpperCase().charCodeAt(0);
        const text = forcedText ?? (shift ? key.toUpperCase() : key);
        return { keyCode: code, text };
      }
      return { keyCode: 0, text: forcedText };
    }
  }
}

/**
 * 列出 CDP 端点上的所有 target。
 * @param {number} port
 * @param {{timeoutMs?: number}} [opts]
 */
export async function listTargets(port = 9223, opts = {}) {
  const url = `http://127.0.0.1:${port}/json`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 4000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
    const list = await res.json();
    if (!Array.isArray(list)) throw new Error(`GET ${url} 返回的不是数组`);
    return list;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 等 CDP 端点起来（应用刚启动时 9223 还没监听）。
 * @param {number} port
 * @param {{timeoutMs?: number, what?: string}} [opts]
 */
export async function waitForDevtools(port = 9223, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60000;
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const list = await listTargets(port, { timeoutMs: 2000 });
      const pages = list.filter((t) => t.type === "page");
      if (pages.length > 0) return list;
    } catch (err) {
      lastErr = err;
    }
    await delay(400);
  }
  throw new Error(
    `等待 CDP 端口 ${port} 超时（${timeoutMs}ms）${lastErr ? `；最后一次错误：${lastErr.message}` : ""}`,
  );
}

/**
 * 连上某个 target。
 * @param {{port?: number, match?: (t: any) => boolean, label?: string, timeoutMs?: number}} opts
 * @returns {Promise<Cdp>}
 */
export async function attach(opts = {}) {
  const port = opts.port ?? 9223;
  const match =
    opts.match ??
    ((t) => t.type === "page" && !/workshop/i.test(t.url ?? ""));
  const list = await waitForDevtools(port, { timeoutMs: opts.timeoutMs ?? 30000 });
  const target = list.find(match);
  if (!target) {
    throw new Error(
      `没有匹配的 target；现有：${list.map((t) => `${t.type}:${t.url}`).join(" | ")}`,
    );
  }
  if (!target.webSocketDebuggerUrl) {
    throw new Error(`target 没有 webSocketDebuggerUrl：${JSON.stringify(target)}`);
  }
  const transport = await WsTransport.connect(target.webSocketDebuggerUrl);
  const cdp = new Cdp(transport, opts.label ?? target.title ?? "page");
  await cdp.enable();
  return cdp;
}
