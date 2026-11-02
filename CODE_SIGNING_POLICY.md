# Code Signing Policy

ZFontManager 的 Windows 发行包（NSIS `setup.exe` 与 `.msi`）使用
[SignPath.io](https://signpath.io) 提供的免费代码签名服务，证书由
[SignPath Foundation](https://signpath.org) 签发。

## 哪些产物会被签名

仅限**由本仓库的 GitHub Actions 工作流构建**、并随 GitHub Release 发布的 Windows 安装包：

| 产物 | 来源 |
|---|---|
| `ZFontManager_<version>_x64-setup.exe` | `.github/workflows/release-signed.yml` |
| `ZFontManager_<version>_x64_en-US.msi` | 同上 |

签名请求由 CI 在推送 `v*` tag 时自动发起，并由项目维护者人工确认后执行。

## 不会被签名的情况

- 任何在本仓库之外构建的二进制；
- 任何包含未公开源码或私有依赖的构建；
- 本地开发构建（`npx tauri build` 直接产出的未签名安装包）；
- 第三方基于本项目源码二次分发时自行构建的产物——如需签名，请使用你自己的证书。

## 私钥与证书

签名私钥由 SignPath 托管在符合要求的硬件安全模块（HSM）中，项目维护者
**不持有、也无法导出**私钥。项目侧只持有一个权限受限的 API token，用于提交签名请求。

## 构建与签名的一致性

签名对象是 CI 从本仓库公开源码构建出的产物，构建过程可在
Actions 运行记录中完整复现与审计。签名后的产物哈希会写进对应 Release 的说明，
用户可用 `signtool verify /pa` 或「文件属性 → 数字签名」核对发布者。

## 联系

如对本策略或某个已签名产物有疑问，请在本仓库提 issue。
