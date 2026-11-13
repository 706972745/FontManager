import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type MutableRefObject,
} from "react";
import {
  CARET_TYPES,
  charLengthAt,
  coveredCharBox,
  coveredIndexFor,
} from "./blinkCaret";

/**
 * 自绘闪烁块状光标（2026-11-13 用户点名，同日按实机反馈重做为「蓝块包字 + 白字」）。
 *
 * Windows 11 的「文本光标指示器」是 OS 级覆盖层，应用侧去不掉、也改不成闪烁；
 * 原生细光标又满足不了诉求，所以自绘老终端那种**块状光标**：
 * - 蓝色块的宽度 = 光标**前面**那个字符的宽度（中文全宽、拉丁窄宽，天然自适应），
 *   高度撑满输入框；
 * - 块内叠一个**白色**的同字符 span，字体六项 computed style 与 input 完全一致 ——
 *   块左缘对齐字符左缘、宽度等于字符 advance，白字形与底下真实字形天然重合，
 *   视觉上就是那个字「变白」了；
 * - 空输入没有字符可盖：退化为 0.55em 宽的空蓝块（贴在 x=0）；
 * - 闪烁是整个块（含白字）一起闪。
 *
 * 定位用**镜像测宽**：一个 visibility:hidden 的 span 依次渲染
 * `value.slice(0, coveredIndex)`（字符左缘）与被覆盖单字符（字符 advance），
 * 字体逐项复制 input 的 computed style —— 预览框会换 fontFamily，不能靠 className。
 *
 * IME：compositionstart 时藏起自绘光标并恢复原生 caret（中文拼音要原生光标跟随），
 * compositionend 后恢复。没有这条，中文输入时光标会跳到错误位置。
 * 状态切换走 field span 的 `is-composing` class，不走 inline style ——
 * 受控输入每个字符都重渲染，React 会把 inline style 冲掉。
 *
 * readOnly：自绘光标不处理（showCaret 排除了 readOnly），但原生光标靠 app.css 的
 * `.blink-caret-field input[readonly] { caret-color: auto }` 恢复 ——
 * **别删那条规则**，否则未来谁接 readOnly 输入框，焦点进去自绘没有、原生也没有，纯盲。
 *
 * 纯逻辑（coveredIndexFor / coveredCharBox / charLengthAt / CARET_TYPES）在同目录
 * blinkCaret.ts：`node --test` 只做类型剥离、不转 JSX，单测必须 import 那份无 JSX 的模块。
 */

export type BlinkCaretInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "ref">;

/** 镜像 / 白字形共用的字体复制（六项 computed style，缺一不可）。 */
function syncFont(el: HTMLElement, cs: CSSStyleDeclaration): void {
  el.style.fontFamily = cs.fontFamily;
  el.style.fontSize = cs.fontSize;
  el.style.fontWeight = cs.fontWeight;
  el.style.fontStyle = cs.fontStyle;
  el.style.letterSpacing = cs.letterSpacing;
  el.style.textTransform = cs.textTransform;
}

/**
 * 可复用的「蓝块包字 + 白字」闪烁光标输入框。
 *
 * 结构：`<span class="blink-caret-field">`（flex item，接管原 input 在容器里的
 * `flex:1 / width:100%` 位，overflow:hidden 负责裁掉滚出可视区的块）>
 * `<input>`（原 props 全量透传）+ `.blink-caret`（蓝块，内嵌 `.blink-caret-glyph`
 * 白字形）+ `.blink-caret-mirror`（隐藏测宽镜像）。
 *
 * ref 透传到 input（ContextMenu 的 searchRef 要 focus()）。type 不在 CARET_TYPES
 * （text / search / url / tel，见 blinkCaret.ts）里的直接渲染普通 input，不自绘、
 * 也不包 wrapper（password 同样在集合外：镜像 span 会把明文密码塞进 DOM，
 * 见 blinkCaret.ts 的注释）。
 */
export const BlinkCaretInput = forwardRef<HTMLInputElement, BlinkCaretInputProps>(
  function BlinkCaretInput(props, ref) {
    const { type, ...rest } = props;
    const caretWanted = CARET_TYPES.has(type);

    const inputRef = useRef<HTMLInputElement | null>(null);
    const caretRef = useRef<HTMLSpanElement | null>(null);
    const glyphRef = useRef<HTMLSpanElement | null>(null);
    const mirrorRef = useRef<HTMLSpanElement | null>(null);
    const [focused, setFocused] = useState(false);
    const [composing, setComposing] = useState(false);

    // props.ref 既可能是函数也可能是对象（ContextMenu 传 useRef 的返回值），两种都接
    const setRefs = useCallback(
      (el: HTMLInputElement | null) => {
        inputRef.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref && typeof ref === "object") {
          (ref as MutableRefObject<HTMLInputElement | null>).current = el;
        }
      },
      [ref],
    );

    /** 镜像测宽 + 几何计算，把蓝块摆到被覆盖字符上。值/焦点/滚动/窗口尺寸变化都会触发。 */
    const reposition = useCallback(() => {
      const input = inputRef.current;
      const mirror = mirrorRef.current;
      if (!input || !mirror) return;
      const cs = getComputedStyle(input);
      const caret = caretRef.current;
      if (!caret) return;
      const glyph = glyphRef.current;
      const value = input.value;
      const sel = input.selectionStart ?? value.length;

      // ── 空输入：0.55em 空块贴在 x=0，没有白字形 ──
      if (coveredIndexFor(value, sel) < 0) {
        caret.style.left = `${Number.parseFloat(cs.paddingLeft) || 0}px`;
        caret.style.width = "";
        caret.classList.add("blink-caret-empty");
        if (glyph) glyph.textContent = "";
        mirror.textContent = "";
        return;
      }
      caret.classList.remove("blink-caret-empty");

      // ── 镜像两次测宽：字符左缘、字符 advance ──
      syncFont(mirror, cs);
      const covered = coveredIndexFor(value, sel);
      mirror.textContent = value.slice(0, covered);
      const startWidth = mirror.offsetWidth;
      const charLen = charLengthAt(value, covered);
      mirror.textContent = value.slice(covered, covered + charLen);
      const charWidth = mirror.offsetWidth;

      const padL = Number.parseFloat(cs.paddingLeft) || 0;
      const padR = Number.parseFloat(cs.paddingRight) || 0;
      const contentWidth = Math.max(0, input.clientWidth - padL - padR);
      const box = coveredCharBox(
        value,
        sel,
        startWidth,
        charWidth,
        input.scrollLeft,
        contentWidth,
      );
      caret.style.left = `${padL + box.left}px`;
      caret.style.width = `${box.width}px`;

      // ── 白字形：蓝块内叠同字符白字，贴回字符的真实位置 ──
      if (glyph) {
        glyph.textContent = box.char ?? "";
        if (box.char) {
          syncFont(glyph, cs);
          glyph.style.left = `${box.glyphShift}px`;
          // 垂直对齐：input 把单行文本在内容区里垂直居中，白字形复刻同一几何 ——
          // top = 内容区顶 + (内容高 − 行高)/2；line-height 是 normal 时令行高=内容高，
          // 居中结果相同。
          const padT = Number.parseFloat(cs.paddingTop) || 0;
          const padB = Number.parseFloat(cs.paddingBottom) || 0;
          const borderT = Number.parseFloat(cs.borderTopWidth) || 0;
          const contentH = Math.max(0, input.clientHeight - padT - padB);
          const contentTop = input.offsetTop + borderT + padT;
          const lh = Number.parseFloat(cs.lineHeight);
          if (Number.isFinite(lh) && lh > 0) {
            glyph.style.lineHeight = `${lh}px`;
            glyph.style.top = `${contentTop + Math.max(0, (contentH - lh) / 2)}px`;
          } else {
            glyph.style.lineHeight = `${contentH}px`;
            glyph.style.top = `${contentTop}px`;
          }
        }
      }
    }, []);

    // 受控值被外部改写（清除按钮、选中建议项）时不产生原生 input 事件，每次渲染兜一次底。
    // 依赖数组故意留空：reposition 自己读 DOM，重复执行是幂等的定位计算，代价可忽略。
    useEffect(() => {
      reposition();
    });

    // 焦点内监听重定位事件；窗口缩放也要跟
    useEffect(() => {
      const el = inputRef.current;
      if (!el || !focused) return;
      const onReposition = () => reposition();
      const events = ["input", "select", "click", "keyup", "scroll"] as const;
      for (const ev of events) el.addEventListener(ev, onReposition);
      window.addEventListener("resize", onReposition);
      return () => {
        for (const ev of events) el.removeEventListener(ev, onReposition);
        window.removeEventListener("resize", onReposition);
      };
    }, [focused, reposition]);

    // IME：拼音/注音组合期间显示**原生**光标（跟随输入法），自绘光标藏起。
    // 显隐全靠 field span 上的 is-composing class（CSS 那侧切 caret-color），
    // 不碰 inline style —— 受控输入每个字符都重渲染，inline 会被 React 冲掉。
    useEffect(() => {
      const el = inputRef.current;
      if (!el || !caretWanted) return;
      const onStart = () => {
        setComposing(true);
        reposition();
      };
      const onEnd = () => {
        setComposing(false);
        reposition();
      };
      el.addEventListener("compositionstart", onStart);
      el.addEventListener("compositionend", onEnd);
      return () => {
        el.removeEventListener("compositionstart", onStart);
        el.removeEventListener("compositionend", onEnd);
      };
    }, [caretWanted, reposition]);

    if (!caretWanted) {
      // 防御：range/number/date 等类型没有文本光标，退回普通 input，不包 wrapper
      return <input {...rest} type={type} ref={setRefs} />;
    }

    const showCaret = focused && !composing && !props.readOnly && !props.disabled;

    return (
      <span
        className={"blink-caret-field" + (composing ? " is-composing" : "")}
        data-composing={composing || undefined}
      >
        <input
          {...rest}
          type={type}
          ref={setRefs}
          onFocus={(e) => {
            setFocused(true);
            props.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            props.onBlur?.(e);
          }}
        />
        {showCaret && (
          <span className="blink-caret" ref={caretRef} aria-hidden>
            <span className="blink-caret-glyph" ref={glyphRef} aria-hidden />
          </span>
        )}
        <span className="blink-caret-mirror" ref={mirrorRef} aria-hidden />
      </span>
    );
  },
);
