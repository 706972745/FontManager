// 版本号直接取自 package.json：构建/打包升级版本只要改一处，
// 设置页与「关于」里显示的版本不会再和安装包版本对不上。
import pkg from "../../package.json";

export const APP_VERSION = pkg.version;
export const APP_LICENSE = "GPL-3.0";
