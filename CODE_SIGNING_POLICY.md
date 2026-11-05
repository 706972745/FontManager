# 代码签名策略（Code Signing Policy）

**当前状态：通过 [SignPath Foundation](https://signpath.org) 免费 OV 代码签名。**

## 我们用什么签名

FontManager 是个人维护的免费开源项目（GPL-3.0，公开仓库）。本项目通过
[SignPath Foundation](https://signpath.org) 的免费开源计划获得代码签名：

- 证书级别为 **OV（组织验证）**，由 SignPath Foundation 签发，私钥托管在其 HSM 上，
  签名在 CI（GitHub Actions）中自动完成，私钥永不离开 HSM；
- 这是该免费计划的固有形式——**安装包数字签名的发布者显示为「SignPath Foundation」**，
  而非项目或个人。它表示「该二进制确实从本项目公开仓库构建」，不验证个人身份；
- 支持签名的产物：`*.exe`（NSIS 安装包）与 `*.msi`（MSI 安装包）。

## 这对用户意味着什么

- 下载 / 安装时**不再出现「未知发布者」警告**，浏览器与 Windows 的智能应用控制（SAC）
  能据此验证发布者，安装体验更顺；
- 安装包属性里的「数字签名」标签页可见 **SignPath Foundation** 的签名与时间戳；
- 发布流程一旦未配置签名密钥（例如本地手工发版、或 Secrets 缺失），会自动退回
  「未签名 + SHA-256」模式，正文会明确标注——详见每个 Release 的说明。

## 如何确认下载的文件是完整的

无论是否签名，每个 Release 的说明里都附有两个安装包的 **SHA-256**。下载后自行核对：

```powershell
Get-FileHash .\FontManager_<version>_x64-setup.exe -Algorithm SHA256
```

输出与 Release 页面上的值一致，说明文件在传输过程中没有被篡改或截断。

## 哪些产物可以信任

只从本仓库的 [Releases](../../releases) 页面下载。任何第三方转载、网盘分享、
「绿色版」「破解版」都不在本项目控制范围内。

## 技术实现（维护者）

- 签名在 `.github/workflows/release.yml` 的「代码签名（SignPath Foundation）」步骤完成，
  通过 `Submit-SigningRequest`（PowerShell `SignPath` 模块）提交未签名制品并写回；
- 该步骤受 GitHub Secrets 保护，**仅当 `SIGNPATH_TOKEN` 配置后才执行**，否则跳过；
- 需要在仓库 Secrets 中配置四项：
  - `SIGNPATH_ORGANIZATION_ID` —— SignPath 组织 ID
  - `SIGNPATH_PROJECT_SLUG` —— 项目 slug
  - `SIGNPATH_SIGNING_POLICY` —— 签名策略名（如 `release-signing`）
  - `SIGNPATH_TOKEN` —— CI 用户令牌
- 申请入口：https://signpath.org → Apply for Free Code Signing。
  申请通过后 SignPath 会下发上述 org / slug / policy 与令牌，填入 Secrets 即可生效。
