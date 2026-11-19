# all2uri

all2uri 是一款 Windows 桌面工具，可把订阅、本地配置和分享链接转换为节点 URI，并在表格中查看、筛选、测试和导出。

## 功能

### 输入与转换

- 输入框可混合填写多个 HTTP/HTTPS 订阅地址、本地节点 URI 和配置文本。
- 支持粘贴剪贴板、选择单个文本文件、拖入多个文件，以及从二维码图片、摄像头或全屏截图读取内容。
- 远程订阅支持自动识别或自定义 User-Agent；自动模式会在响应被拒绝或内容无法识别时尝试常见客户端标识。
- 支持 Base64 订阅、Clash/mihomo YAML、sing-box/Xray JSON 与 YAML、节点 URI、Markdown 链接和混合内容。多服务器、多用户配置会按节点拆分。
- 支持 TLS/Reality/ECH、WebSocket、gRPC、HTTPUpgrade、HTTP/2 等字段及 Shadowsocks 插件等参数的转换；能否保留取决于目标 URI 格式。
- 所有成功解析为 `ProxyNode` 的节点都会列出，状态标为完整、有损、配置无效或暂不支持编码；有损字段和编码诊断可通过状态提示查看。

节点 URI 转换支持：

| 协议 | 输出 URI | sing-box 代理连接测试 |
| --- | --- | --- |
| SOCKS、SOCKS5 | `socks5://` | 支持 |
| SOCKS4 | `socks4://` | 支持 |
| SOCKS4a | `socks4a://` | 支持 |
| Shadowsocks | `ss://` | 支持 |
| VMess | `vmess://` | 支持 |
| VLESS | `vless://` | 支持 |
| Trojan | `trojan://` | 支持 |
| Hysteria 2 | `hysteria2://`（接受 `hy2://` 输入） | 支持 |
| TUIC | `tuic://` | 支持 |
| AnyTLS | `anytls://` | 支持 |
| NaiveProxy | `naive+https://` | 不支持 |
| WireGuard | `wireguard://` | 支持（sing-box endpoint） |
| MASQUE | `masque://` | 不支持 |

HTTP/HTTPS 只作为远程订阅地址处理，不会转换成 HTTP 代理 URI。Xray JSON 的 `shadowsocks` 映射为 `ss`；Xray Hysteria 仅识别 version 2。列表以解析器成功创建 `ProxyNode` 为边界：SSR、Snell、Hysteria 1、Juicity、Mieru、ShadowTLS 等未接入协议，以及无法识别的 URI scheme，不会创建节点行，会在解析诊断中报告或跳过。

上表中的 URI 转换支持与节点测试支持是两项能力。TCPing 需要有效服务器地址和端口，入口检测需要有效服务器地址；204 URL、带宽、出口检测和解锁测试需要可用的 sing-box 配置。不满足某项条件的节点会标记为“不具备条件”，不会计入网络测试失败。NaiveProxy 与 MASQUE 可以转换 URI，但当前不能通过 sing-box 执行这些代理连接测试。

### 测试、地区与维护

- 六项节点测试：TCPing、204 URL、带宽、入口 IP、出口 IP，以及流媒体与 AI 服务解锁。入口/出口检测可识别 Cloudflare、CloudFront、Fastly 和 Gcore 网段。
- 204 URL、带宽、出口检测和解锁测试通过随应用打包的 sing-box 运行；测试设置可调整地址、超时、并发、DNS/IP 来源及解锁服务。
- 入口地区按节点名称、本地 GeoIP、远程 API 的顺序识别；出口地区支持本地 GeoIP 和远程 API。两侧并发默认 8，可分别设置 GeoIP 数据库。
- 输出表格可显示或隐藏列、拖动列宽、自动适配当前结果，并按协议和地区筛选。复制和导出使用当前筛选结果。
- 清洗是手动操作：删除当前筛选结果中的测试不合格节点，或删除重复节点并保留每组第一条。转换过程不会自动去重；两项清洗都适用于列表中的全部节点，包括无 URI 节点。
- 测试不合格按测试失败、TCPing/204 延迟超过阈值或带宽低于阈值判断；未测试、不具备对应测试条件的节点，以及只因单项解锁未通过的节点不会删除。默认阈值为 TCPing 1000 ms、204 URL 1000 ms、带宽 1 Mbps。
- 批量重命名可组合地区、入口/出口、TCPing、204、速度、解锁摘要及原名称等字段。
- 复制和 `.txt` 导出只包含当前筛选结果中有 URI 的节点；`.xlsx` 和 `.png` 会包含全部当前筛选节点及转换状态。列表、节点数量和可导出 URI 数量分别统计。
- 可导出当前筛选范围内的有损转换 JSON 日志，包含未编码字段、完整节点配置、转换后的 URI 及来源位置；日志保留凭据和地址，便于排查转换问题。

## 输入与资源上限

- 单批本地输入、解码后的内容和远程订阅内容合计最多 64 MiB；本地文件须为 UTF-8 文本。
- Base64 递归展开最多 16 层；预处理最多 10,000 个片段和 100,000 个节点。
- 文本、Excel 和 PNG 导出各自最多 64 MiB；二维码图片导入最多 64 MiB。

## 远程订阅与数据处理

- 订阅请求由 Rust 原生层发起，不受 WebView CORS 限制。默认启用远程订阅拉取，默认 User-Agent 为自动识别。
- 界面默认超时 10 秒、最大重定向 5 次；并发可按固定数量或百分比设置，默认按远程请求数量的 10% 向上取整（至少 1 个），实际不会超过本次请求数。超时可设为 1 秒以上，重定向可设为 0 次以上。
- 连接超时为 10 秒。TLS 证书验证选项名为“跳过证书验证”，当前界面默认勾选；取消勾选后会校验证书。
- 订阅 URL 和每一跳的重定向目标只限制为 HTTP/HTTPS。请求不会默认阻止本机、局域网或其他特殊用途地址；每次连接仍会解析并固定该跳的地址。请只导入可信的订阅地址。
- 本地配置在本机解析。远程地区 API 使用 `ipwho.is` 查询公开节点 IP，不会查询本机、局域网等特殊地址；关闭“远程 API”可避免发送节点 IP。
- 节点测试会按类型直接连接节点端口、解析入口 IP，或通过 sing-box 节点代理连接测试目标。订阅地址历史不会保存；用户主动拉取订阅时，订阅服务器会收到请求地址和 User-Agent。
- 订阅 URL 中的用户名和密码用于 HTTP Basic Auth；跨源重定向不会转发这组认证信息。凭据会从显示地址中移除。

## 构建与测试

环境要求：

- Windows 10/11、WebView2 Runtime
- Node.js 20.19+ 或 22.12+
- Rust stable 和 Windows 构建工具链

安装依赖、构建前端或构建 Windows NSIS 安装包：

```powershell
npm install
npm run build
npm run tauri:build
```

安装包输出到 `src-tauri/target/release/bundle/nsis/`。运行测试：

```powershell
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

## 技术栈

Tauri 2、Rust/reqwest、TypeScript、Vite、Web Worker、`yaml` 和 ExcelJS。解析与转换在 Web Worker 中执行；订阅请求、节点测试和本地文件操作通过 Tauri 命令处理。
