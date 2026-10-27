/**
 * 右键菜单的实际渲染尺寸（逻辑像素）。
 *
 * 速览界面是个窄窗口，必须保证右键菜单能被完整放下，所以速览窗口的最小尺寸
 * 由菜单尺寸推导：宽度 ≥ 菜单宽 × 1.5，高度 ≥ 菜单高。
 * 菜单项数量随上下文变化（是否收藏、是否多选、是否有 Adobe 连接等），
 * 所以由 MenuPanel 每次渲染后用 offsetWidth/offsetHeight 回填实测值，
 * 首次打开前用 CSS 里的 min-width 与保守高度兜底。
 */

/** 兜底值：#ctx-menu 的 min-width 与典型高度（约 9 项 + 标题 + 分隔符） */
const FALLBACK_WIDTH = 240;
const FALLBACK_HEIGHT = 360;

let measured = { width: 0, height: 0 };

type Listener = (size: { width: number; height: number }) => void;
const listeners = new Set<Listener>();

/** 菜单渲染完成后回填实测尺寸；订阅者（速览界面）据此校准窗口最小尺寸 */
export function recordContextMenuSize(width: number, height: number) {
  if (width <= 0 || height <= 0) return;
  if (measured.width === width && measured.height === height) return;
  measured = { width, height };
  listeners.forEach((fn) => fn(measured));
}

export function contextMenuSize(): { width: number; height: number } {
  return {
    width: measured.width || FALLBACK_WIDTH,
    height: measured.height || FALLBACK_HEIGHT,
  };
}

export function subscribeContextMenuSize(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
