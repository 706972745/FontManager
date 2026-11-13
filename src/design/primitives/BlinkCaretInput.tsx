import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type MutableRefObject,
} from "react";
import { CARET_TYPES, computeCaretX, sliceToCaret } from "./blinkCaret";

/**
 * 自绘闪烁块状光标（2026-11-13 用户点名要的「蓝色粗块光标」，但要闪烁）。
 *
 * Windows 11 的「文本光标指示器」是 OS 级覆盖层，应用侧去不掉、也改不成闪烁；
 * 原生细光标又满足不了「看得见的块状」这个诉求，所以自绘：
 * 原生 caret 设为 transparent，输入框上叠一条 2px 的蓝竖条跟着选择点走。
 *
 * 定位用**镜像测宽**：一个 visibility:hidden 的 span 渲染 `value.slice(0, selectionStart)`
 * （字体从 input 的 computed style 逐项复制 —— 预览框会换 fontFamily，不能靠 className），
 * 光标 x = 镜像宽 − input.scrollLeft，再夹进内容区宽度内。
 *
 * IME：compositionstart 时藏起自绘光标并恢复原生 caret（中文拼音要原生光标跟随），
 * compositionend 后恢复。没有这条，中文输入时光标会跳到错误位置。
 * 状态切换走 field span 的 `is-composing` class，不走 inline style ——
 * 受控输入每个字符都重渲染，React 会把 inline style 冲掉。
 *
 * 纯逻辑（sliceToCaret / computeCaretX / CARET_TYPES）在同目录 blinkCaret.ts：
 * `node --test` 只做类型剥离、不转 JSX，单测必须 import 那份无 JSX 的模块。
 */

export type BlinkCaretInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "ref">;

/**
 * 可复用的「块状闪烁光标」输入框。
 *
 * 结构：`<span class="blink-caret-field">`（flex item，接管原 input 在容器里的
 * `flex:1 / width:100%` 位）> `<input>`（原 props 全量透传）+ `.blink-caret`（2px 竖条）
 * + `.blink-caret-mirror`（隐藏测宽镜像）。
 *
 * ref 透传到 input（ContextMenu 的 searchRef 要 focus()）。type 非 text/search/url/
 * tel/password 时直接渲染普通 input，不自绘、也不包 wrapper。
 */
export const BlinkCaretInput = forwardRef<HTMLInputElement, BlinkCaretInputProps>(
  function BlinkCaretInput(props, ref) {
    const { type, ...rest } = props;
    const caretWanted = CARET_TYPES.has(type);

    const inputRef = useRef<HTMLInputElement | null>(null);
    const caretRef = useRef<HTMLSpanElement | null>(null);
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

    /** 镜像测宽 + 夹取，把光标竖条摆到当前选择点。值/焦点/滚动/窗口尺寸变化都会触发。 */
    const reposition = useCallback(() => {
      const input = inputRef.current;
      const mirror = mirrorRef.current;
      if (!input || !mirror) return;
      // 镜像字体逐项复制 computed style：预览框的 fontFamily 是运行时换的（sampleFont），
      // 靠 className 复制抄不到。visibility:hidden 不影响 offsetWidth。
      const cs = getComputedStyle(input);
      const ms = mirror.style;
      ms.fontFamily = cs.fontFamily;
      ms.fontSize = cs.fontSize;
      ms.fontWeight = cs.fontWeight;
      ms.fontStyle = cs.fontStyle;
      ms.letterSpacing = cs.letterSpacing;
      ms.textTransform = cs.textTransform;
      mirror.textContent = sliceToCaret(
        input.value,
        input.selectionStart ?? input.value.length,
      );
      const caret = caretRef.current;
      if (!caret) return;
      const padL = Number.parseFloat(cs.paddingLeft) || 0;
      const padR = Number.parseFloat(cs.paddingRight) || 0;
      const contentWidth = Math.max(0, input.clientWidth - padL - padR);
      const x = computeCaretX(
        input.value,
        input.selectionStart ?? 0,
        mirror.offsetWidth,
        input.scrollLeft,
        contentWidth,
      );
      caret.style.left = `${padL + x}px`;
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
        {showCaret && <span className="blink-caret" ref={caretRef} aria-hidden />}
        <span className="blink-caret-mirror" ref={mirrorRef} aria-hidden />
      </span>
    );
  },
);
