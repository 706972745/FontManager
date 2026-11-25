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
  caretHeightFor,
  caretTopFor,
  charLengthAt,
  coveredIndexFor,
} from "./blinkCaret";

/**
 * 自绘闪烁块状光标（2026-11-13 用户点名，同日按实机反馈重做为「蓝块包字 + 白字」）。
 *
 * Windows 11 的「文本光标指示器」是 OS 级覆盖层，应用侧去不掉、也改不成闪烁；
 * 原生细光标又满足不了诉求，所以自绘老终端那种**块状光标**：
 * - 蓝色块的宽度 = 光标**前面**那个字符的宽度（中文全宽、拉丁窄宽，天然自适应）
 *   + 左右各 BLOCK_PAD；**高度 = 字号 + 2px，垂直居中**（2026-11-15 用户参考截图，
 *   36px 输入框里只占 15px 高）。高度绝不跟着输入框变，见 blinkCaret.ts::caretHeightFor；
 *   样式在 ./blinkCaret.css，主程序与插件中心面板共用同一份；
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

export type BlinkCaretInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "ref"> & {
  /** 附加到 wrapper（`<span class="blink-caret-field">`）上的类名。
   *  窄输入框（端口号 / 字符筛选 / 标签输入）要在 wrapper 上写 `flex: 0 0 <宽度>`，
   *  而 className 是透传给 input 的，两者不能共用同一个属性。 */
  fieldClassName?: string;
};

/** 蓝块比被覆盖字符左右各多出的内边距（px）——「清晰度优先于严丝合缝」。 */
const BLOCK_PAD = 4;

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
    const { type, fieldClassName, ...rest } = props;
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

      // ── 纵向几何（两边共用）──
      // 块高只跟字号走；top 让它在输入框里垂直居中。白字形是绝对定位在**块内部**的，
      // 所以下面算 glyph.top 时要减掉 blockTop，否则块一居中，白字就会整体下移。
      const fontSize = Number.parseFloat(cs.fontSize) || 13;
      const caretH = caretHeightFor(fontSize);
      const blockTop = input.offsetTop + caretTopFor(input.clientHeight, caretH);
      caret.style.height = `${caretH}px`;
      caret.style.top = `${blockTop}px`;

      // ── 横向几何：让浏览器自己排，再读字符的真实矩形 ──
      // 旧做法是「镜像测宽 + 手算居中偏移 + 减 scrollLeft」。字体回退（emoji、缺字回退到
      // 另一个字体）、或输入框有自己的 text-align 时，推算和真实排版会差好几像素，
      // 表现就是蓝块只盖住半个字、另半个露在块外（用户 2026-11-25 报的「位置错位」）。
      // 现在把镜像做成**输入框内容盒的复制品**（宽 / 内边距 / 对齐 / 字体全同），
      // 居中和滚动都由浏览器算，我们只读被覆盖字符那个 span 的 rect —— 不再有任何推算。
      const borderL = Number.parseFloat(cs.borderLeftWidth) || 0;
      const borderR = Number.parseFloat(cs.borderRightWidth) || 0;
      const borderT = Number.parseFloat(cs.borderTopWidth) || 0;
      const borderB = Number.parseFloat(cs.borderBottomWidth) || 0;
      const padL = Number.parseFloat(cs.paddingLeft) || 0;
      const padR = Number.parseFloat(cs.paddingRight) || 0;
      mirror.style.boxSizing = "border-box";
      mirror.style.width = `${input.offsetWidth}px`;
      mirror.style.left = `${input.offsetLeft}px`;
      mirror.style.top = `${input.offsetTop}px`;
      // 镜像不带边框，用内边距把边框那几像素补回来 —— 内容盒与 input 严丝合缝
      mirror.style.padding = `${borderT}px ${padR + borderR}px ${borderB}px ${padL + borderL}px`;
      mirror.style.textAlign = cs.textAlign;
      mirror.style.overflow = "hidden";
      syncFont(mirror, cs);

      const covered = coveredIndexFor(value, sel);

      // ── 空输入：0.55em 空块贴在文本起始位置（居中输入框就是正中）──
      if (covered < 0) {
        const probe = document.createElement("span");
        mirror.textContent = "";
        mirror.appendChild(probe);
        const probeRect = probe.getBoundingClientRect();
        const mirrorRect = mirror.getBoundingClientRect();
        caret.style.left = `${input.offsetLeft + Math.max(0, probeRect.left - mirrorRect.left)}px`;
        caret.style.width = "";
        caret.classList.add("blink-caret-empty");
        if (glyph) glyph.textContent = "";
        return;
      }
      caret.classList.remove("blink-caret-empty");

      const charLen = charLengthAt(value, covered);
      const char = value.slice(covered, covered + charLen);
      const charSpan = document.createElement("span");
      charSpan.textContent = char;
      mirror.textContent = "";
      mirror.append(value.slice(0, covered), charSpan, value.slice(covered + charLen));
      // 输入框已经横向滚出时，镜像跟着滚同样的量，字的位置才对得上
      mirror.scrollLeft = input.scrollLeft;

      const mirrorRect = mirror.getBoundingClientRect();
      const charRect = charSpan.getBoundingClientRect();
      const charLeft = charRect.left - mirrorRect.left;

      // 「清晰度优先于严丝合缝」（用户 2026-11-13）：块比字符左右各宽 4px，白字四周留蓝边
      caret.style.left = `${input.offsetLeft + charLeft - BLOCK_PAD}px`;
      caret.style.width = `${charRect.width + BLOCK_PAD * 2}px`;

      // ── 白字形：蓝块内叠同字符白字，横向固定在块的内边距上（= 字符原位）──
      if (glyph) {
        glyph.textContent = char;
        syncFont(glyph, cs);
        glyph.style.left = `${BLOCK_PAD}px`;
        // 垂直对齐：input 把单行文本在内容区里垂直居中，白字形复刻同一几何 ——
        // top = 内容区顶 + (内容高 − 行高)/2；line-height 是 normal 时令行高=内容高，
        // 居中结果相同。
        const padT = Number.parseFloat(cs.paddingTop) || 0;
        const padB = Number.parseFloat(cs.paddingBottom) || 0;
        const contentH = Math.max(0, input.clientHeight - padT - padB);
        const contentTop = input.offsetTop + borderT + padT;
        const lh = Number.parseFloat(cs.lineHeight);
        if (Number.isFinite(lh) && lh > 0) {
          glyph.style.lineHeight = `${lh}px`;
          glyph.style.top = `${contentTop + Math.max(0, (contentH - lh) / 2) - blockTop}px`;
        } else {
          glyph.style.lineHeight = `${contentH}px`;
          glyph.style.top = `${contentTop - blockTop}px`;
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
        className={
          "blink-caret-field" +
          (fieldClassName ? ` ${fieldClassName}` : "") +
          (composing ? " is-composing" : "")
        }
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
