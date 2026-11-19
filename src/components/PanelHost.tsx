/**
 * 面板宿主：在主窗口里用「设置同款遮罩层 + iframe」承载两类面板。
 *
 * 2026-11-19 用户口径：
 * 1. 插件中心**不再新开窗口** —— 直接在软件窗口里打开，尺寸和位置与设置面板一致；
 * 2. 点多次只显示一个（已打开就只唤出，不重建）；
 * 3. 同一份遮罩层也**开放给插件**做自己的设置界面（插件侧协议不变，照旧发 open-url）。
 *
 * 为什么用 iframe 而不是把面板代码并进主包：
 * - 插件中心面板是**可独立更新**的产物（`workshop.html` + assets，从 release 拉），
 *   并进主包就失去「面板单独发版」的能力；
 * - 插件自己的设置页本来就是各自起的本地 HTTP 服务，iframe 是唯一不用给它们写宿主桥的方式；
 * - 面板/插件页的请求全是相对路径 `/api/*`，在 iframe 里同源，不需要 postMessage 转发。
 *
 * 单例语义（对应「一个插件只能有一个设置界面」）：
 * - 插件中心重复点入口 → 只取一次地址，iframe 不重建；
 * - 同一个插件重复发 open-url → 状态不变，不重建；
 * - 不同插件请求 → **替换**当前内容（不是再叠一层），所以永远最多一个面板遮罩。
 */
import { listen } from "@tauri-apps/api/event";
import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "../design/primitives/Toast";
import { springSoft, scrimFade } from "../design/springs";
import { activeLocale, useT } from "../lib/i18n";
import { ipc } from "../lib/ipc";

/** 打开插件中心的全局事件名（标题栏 / 设置页都只 dispatch，不自己开窗） */
export const OPEN_WORKSHOP_EVENT = "open-workshop-center";

type PanelState =
  | { kind: "workshop"; title: string; src: string }
  | { kind: "plugin"; pid: string; title: string; src: string };

/** 后端 `plugin-panel:open` 的载荷（见 plugins.rs 的 open-url 分支） */
interface PluginPanelPayload {
  pid: string;
  url: string;
  title: string;
}

export function PanelHost() {
  const t = useT();
  const [panel, setPanel] = useState<PanelState | null>(null);

  const close = useCallback(() => setPanel(null), []);

  const openWorkshop = useCallback(async () => {
    try {
      const src = await ipc.workshopPanelUrl(activeLocale());
      setPanel((cur) => {
        // 已开且地址没变 → 返回同一个对象，React 不会重渲染、iframe 不重载。
        // 这就是「点多次只显示一个」：不是把窗口再开一次，而是这个已经有了。
        if (cur?.kind === "workshop" && cur.src === src) return cur;
        return { kind: "workshop", title: t("side.pluginCenter"), src };
      });
    } catch (err) {
      toast.error(t("toast.pluginCenterOpenFailed"), String(err));
    }
  }, [t]);

  // ① 插件中心入口
  useEffect(() => {
    const onOpen = () => void openWorkshop();
    window.addEventListener(OPEN_WORKSHOP_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_WORKSHOP_EVENT, onOpen);
  }, [openWorkshop]);

  // ② 插件自己的设置界面（主程序转发插件的 open-url）
  useEffect(() => {
    let alive = true;
    const un = listen<PluginPanelPayload>("plugin-panel:open", (e) => {
      if (!alive) return;
      const { pid, url, title } = e.payload ?? { pid: "", url: "", title: "" };
      if (!url || !pid) return;
      setPanel((cur) => {
        // 同一插件、同一地址 → 幂等（插件的 settings 钩子可能被反复点）
        if (cur?.kind === "plugin" && cur.pid === pid && cur.src === url) return cur;
        // 换插件 → 替换内容，绝不叠第二层遮罩
        return { kind: "plugin", pid, title: title || pid, src: url };
      });
    });
    return () => {
      alive = false;
      // listen 是异步的：组件卸载时可能还没拿到 unlisten
      void un.then((off) => off()).catch(() => {});
    };
  }, []);

  // ③ Esc 关闭（焦点在 iframe 里时收不到，属于已知限制：点遮罩或右上角 X 都能关）
  useEffect(() => {
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setPanel(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [panel]);

  return (
    <AnimatePresence>
      {panel && (
        <motion.div
          className="compare-backdrop settings-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={scrimFade}
          onClick={close}
        >
          <motion.div
            className="settings-panel panel-embed"
            role="dialog"
            aria-label={panel.title}
            initial={{ y: 32, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 20, opacity: 0 }}
            transition={springSoft}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="panel-embed-head">
              <span className="panel-embed-title">{panel.title}</span>
              <button
                className="set-close"
                aria-label={t("settings.close")}
                title={t("settings.close")}
                onClick={close}
              >
                <X size={15} strokeWidth={1.5} />
              </button>
            </header>
            <iframe
              /* key 用地址：面板换成另一个插件/新地址时强制重建，避免旧页面的
                 定时器与轮询继续跑 */
              key={panel.src}
              className="panel-embed-frame"
              src={panel.src}
              title={panel.title}
              /* 面板要能复制设备码 / 导出路径（GitHub 登录那一步会 writeText） */
              allow="clipboard-write; clipboard-read"
            />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
