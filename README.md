# MiMoCode ↔ ChatGPT Bridge

本機 Bridge，讓 MiMoCode 完成一個 coding turn 後，把結果交給 ChatGPT 或 OpenAI 審查，並在需要時把下一步指令送回**同一個 MiMoCode session**。

它提供三條 review 路徑：

1. **ChatGPT Web + MCP**：ChatGPT 透過 HTTPS MCP endpoint 讀取 completion，並呼叫受限制的 write tool 回傳指令。
2. **ChatGPT desktop handoff（實驗性）**：Bridge 喚起桌面客戶端，要求內建瀏覽器打開一個 localhost、單一 completion 專用的審查頁；頁面可以批准、要求修改、標記 needs-user 或停止循環。
3. **OpenAI Responses API**：不依賴 ChatGPT UI，執行可控的全自動 review loop。

> 目前官方 custom MCP app 主要在 ChatGPT Web 使用；桌面客戶端沒有公開 API，可讓外部程式直接向既有 chat 注入訊息並可靠讀回結果。因此桌面模式是受控的 UI handoff，不是官方 desktop MCP transport。需要無人值守時使用 `REVIEW_MODE=api`。

```text
MiMoCode session.status = idle
          │
          ▼
.opencode/plugins/chatgpt-bridge.ts
          │ authenticated webhook
          ▼
Local Bridge ─── SQLite + Git evidence + audit
    │
    ├── HTTPS MCP ─────────────► ChatGPT Web
    │                              │
    │◄── bounded write tool ───────┘
    │
    ├── localhost review page ──► ChatGPT desktop built-in browser
    │                              │
    │◄── approve / instruction ────┘
    │
    └── OpenAI Responses API ───► automatic reviewer
```

## Implemented MVP

- 監聽 MiMoCode `session.status` 進入 `idle`。
- 幂等保存 completion event，避免同一 assistant message 重複觸發。
- 保存 assistant report、branch、HEAD、working/staged/untracked diff、最新 commit patch、remote 與測試結果。
- 在持久化及輸出前遞迴遮罩常見 API key、GitHub token、Bearer token、密碼與 secret。
- SQLite completion lifecycle、parent/child iteration chain 與 audit log。
- 每條 chain 的最大迭代限制，避免無限修改循環。
- Stateful Streamable HTTP MCP server。
- macOS / Windows ChatGPT desktop clipboard handoff。
- 每個 completion 獨立的 localhost review capability URL；不暴露 MCP master token。
- OpenAI Responses API structured-output reviewer。
- Bridge 重啟後恢復尚未處理的 completion。
- Webhook 立即回覆 `202`，review orchestration 在背景執行，避免 MiMoCode timeout 重送。

## MCP tools

| Tool | 用途 |
|---|---|
| `bridge_status` | 檢查 Bridge 狀態與 review mode |
| `list_mimo_completions` | 列出最近 completion；預設不包含大型 diff |
| `get_mimo_completion` | 讀取 report、Git evidence 與可選 audit trail |
| `send_instruction_to_mimo` | 把一次後續實作指令送回 completion 綁定的 session |
| `mark_mimo_completion_reviewed` | 記錄 `approved` 或 `needs_user` |
| `stop_mimo_loop` | 因 credentials、風險、阻塞或產品決策停止循環 |

MCP 不提供任意 shell、任意檔案讀取，也不能指定任意 MiMoCode session ID。所有 write action 都必須引用已保存的 completion。

## Requirements

- Node.js **22.5+**
- Git
- MiMoCode / MiMoCode server 在本機運行
- ChatGPT desktop，僅 `REVIEW_MODE=desktop` 或 `hybrid` 的 handoff 需要
- `cloudflared` 或其他 HTTPS tunnel，僅 ChatGPT Web MCP 需要
- OpenAI API key，僅 `REVIEW_MODE=api` 或 `hybrid` 需要

桌面 handoff 支援：

- macOS：ChatGPT app、AppleScript、Accessibility permission
- Windows：ChatGPT app、PowerShell、WScript keyboard automation

Linux 可以運行 Bridge、MCP 與 API reviewer，但目前不會自動控制 ChatGPT desktop。

## Quick start

### 1. 安裝

```bash
npm install
npm run setup
```

`npm run setup` 會從 `.env.example` 建立 `.env`，並生成兩個不同的 256-bit token。

預設是安全的 store-only 模式：

```env
REVIEW_MODE=none
CHATGPT_DESKTOP_ENABLED=false
```

### 2. 選擇 review mode

#### A. ChatGPT Web + MCP

```env
REVIEW_MODE=none
CHATGPT_DESKTOP_ENABLED=false
MIMO_ALLOWED_ROOTS=/absolute/path/to/your/projects
```

Bridge 保存 completion；你在 ChatGPT Web 透過 MiMo Bridge app 讀取及處理。

#### B. ChatGPT desktop handoff（實驗性）

```env
REVIEW_MODE=desktop
CHATGPT_DESKTOP_ENABLED=true
BRIDGE_REVIEW_BASE_URL=http://127.0.0.1:8787
MIMO_ALLOWED_ROOTS=/absolute/path/to/your/projects
```

Bridge 會貼入一段 prompt，要求 ChatGPT desktop 的內建瀏覽器打開：

```text
http://127.0.0.1:8787/review/<per-completion-token>
```

該頁只接受 localhost Host/Origin，token 只對一個 completion 有效，且頁面上的 action 綁定原 MiMoCode session。ChatGPT 仍可能要求瀏覽器或寫入確認；不同 desktop mode 的可用性可能不同。

#### C. 完全自動 API mode

```env
REVIEW_MODE=api
OPENAI_API_KEY=your-key
OPENAI_MODEL=gpt-5
MIMO_ALLOWED_ROOTS=/absolute/path/to/your/projects
```

`hybrid` 會先由 API 執行 review，再向 ChatGPT desktop 發送狀態 handoff。

Windows 多個 root 使用分號：

```env
MIMO_ALLOWED_ROOTS=D:\Projects;C:\Work
```

macOS 多個 root 使用冒號：

```env
MIMO_ALLOWED_ROOTS=/Users/you/Projects:/Users/you/Work
```

### 3. 安裝 MiMoCode plugin

```bash
npm run plugin:install -- /absolute/path/to/project
```

它會建立：

```text
<project>/.opencode/plugins/chatgpt-bridge.ts
```

啟動 MiMoCode 時，必須讓它取得：

```env
MIMO_BRIDGE_URL=http://127.0.0.1:8787
MIMO_BRIDGE_TOKEN=<與 Bridge .env 相同的值>
```

macOS / Linux：

```bash
export MIMO_BRIDGE_URL=http://127.0.0.1:8787
export MIMO_BRIDGE_TOKEN='...'
# 從同一個 shell 啟動 MiMoCode
```

PowerShell：

```powershell
$env:MIMO_BRIDGE_URL = "http://127.0.0.1:8787"
$env:MIMO_BRIDGE_TOKEN = "..."
# 從同一個 PowerShell 啟動 MiMoCode
```

### 4. 啟動 Bridge

```bash
npm start
```

Health check：

```bash
curl http://127.0.0.1:8787/health
```

### 5. ChatGPT Web MCP tunnel

ChatGPT custom MCP app 不能直接連接 localhost。開發時可使用臨時 tunnel：

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

取得例如 `random-name.trycloudflare.com` 後，加入 `.env`：

```env
MCP_ALLOWED_HOSTS=127.0.0.1,localhost,random-name.trycloudflare.com
```

重啟 Bridge。完整 endpoint：

```text
https://random-name.trycloudflare.com/mcp/<MCP_PATH_TOKEN>
```

長期使用建議建立 named Cloudflare Tunnel；`scripts/cloudflared.example.yml` 提供範例。

在支援 custom MCP app 的 ChatGPT Web workspace：

1. 建立名為 **MiMo Bridge** 的 app。
2. MCP endpoint 填入完整 tunnel URL。
3. 若 client 支援自訂 Bearer header，可設定 `MCP_AUTH_TOKEN`；否則使用高熵 path token 作 capability URL。
4. 先測試 `bridge_status` 和 `list_mimo_completions`。

不同 ChatGPT plan/workspace 對 MCP write tools 的支援不同。若只有 read/fetch，使用 desktop review page 或 API mode 完成回傳。

## Desktop handoff behavior

`REVIEW_MODE=desktop` 時，Bridge 會：

1. 保存 completion 和 Git evidence。
2. 暫存原剪貼簿。
3. 喚起 ChatGPT app，可選 companion window。
4. 貼入 localhost review URL 與單一 action policy。
5. 可選擇自動按 Enter。
6. 恢復原剪貼簿。
7. ChatGPT 透過 review page提交 action；Bridge 再寫回 MiMoCode。

設定：

```env
CHATGPT_DESKTOP_ENABLED=true
CHATGPT_DESKTOP_MODE=companion
CHATGPT_AUTO_SUBMIT=true
```

送出前人工檢查：

```env
CHATGPT_AUTO_SUBMIT=false
```

macOS 第一次使用需要在 **System Settings → Privacy & Security → Accessibility** 允許執行 Bridge 的 Terminal/Node 控制鍵盤。

## Completion lifecycle

```text
pending
  ├─► reviewed
  ├─► waiting_user
  ├─► sending_instruction ─► instruction_sent
  └─► stopped

instruction_sent
  └─► MiMoCode completes again
          └─► child completion, iteration + 1
```

當 `iteration >= MAX_AUTO_ITERATIONS`，Bridge 拒絕再送自動指令。

## Commands

```bash
npm start
npm run doctor
npm run plugin:install -- /path/to/project
node src/cli.js trigger <completionID>
node src/cli.js review <completionID>
npm run token
npm run validate
npm run test:coverage
```

`doctor` 檢查 Node.js、SQLite、Git、cloudflared、desktop platform、tokens 與 MiMoCode health endpoint。

## Security model

- Webhook 使用獨立 Bearer token。
- MCP URL 使用獨立高熵 path token，可再加 Bearer token。
- `MCP_ALLOWED_HOSTS` 限制 MCP Host header。
- Desktop review page 使用 per-completion token，只接受 localhost Host/Origin。
- `MIMO_ALLOWED_ROOTS` 透過 canonical path 限制 Git evidence 來源，防止 symlink escape。
- Request body、assistant text 和 diff 都有 byte limit。
- 常見 secrets 在持久化、MCP、API 與 review page輸出前遮罩。
- Instruction claim 使用 SQLite `BEGIN IMMEDIATE` transaction，避免重複送出。
- Review page 和 MCP write tools 都只能操作 completion 已綁定的 session。
- OpenAI API request 設定 `store: false`。

不要把 `.env`、SQLite database、tunnel credentials、完整 MCP URL 或 review URL commit 到 GitHub。

## Development

```bash
npm run check
npm test
npm run test:coverage
npm run validate
```

CI 在 Node.js 22 和 24 執行 syntax check 與 test suite。

## Current non-goals

- 從 ChatGPT 畫面 OCR 或抓取回答。
- 依賴固定座標選擇某個既有 chat。
- 讓 MCP server 主動建立 ChatGPT conversation。
- 執行任意 shell command。
- 自動繞過 ChatGPT、瀏覽器或 MiMoCode 的權限確認。
- 聲稱 desktop handoff 等同官方 desktop MCP 支援。

## License

MIT
