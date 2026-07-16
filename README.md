# 人員簽到退系統（Signinsheet）

以「個人手機動態條碼」為核心的簽到／簽退系統：員工在手機上出示每 30 秒更新一次的動態 QR Code，掃描站掃描後即記錄**人員資料、當時地點（站點名稱＋GPS 座標）與時間**。

## 功能

- **📱 個人手機頁**（`/phone.html`）
  - 員工以「工號＋PIN 碼」登入
  - 顯示動態 QR Code：每 30 秒自動更新、60 秒後失效、一次性使用（截圖或轉傳無法重複使用）
  - 可查看自己最近的簽到退記錄
- **📷 掃描站**（`/scanner.html`）
  - 管理員登入後設定站點名稱，開啟相機掃描員工條碼
  - 自動取得掃描站 GPS 座標，連同站點名稱、時間一併寫入記錄
  - 自動判斷簽到／簽退（也可固定為簽到或簽退模式）
- **🗂️ 管理後台**（`/admin.html`）
  - 人員管理：新增、停用／啟用、重設 PIN、查看／解除 LINE 綁定
  - 記錄查詢：依日期區間、姓名／工號篩選，可匯出 CSV（Excel 可直接開啟）
- **💬 LINE 通知**（選用，需設定 LINE 官方帳號）
  - ✅ 上班簽到通知（逾時自動標註遲到）
  - ✅ 下班簽退通知（含當日工時）
  - ✅ 遲到提醒（預設 09:15 提醒尚未簽到者）
  - ✅ 未簽退提醒（預設 18:30 提醒已簽到未簽退者）
  - ✅ 每日出勤統計（預設 19:00 推播給管理員）
  - ✅ 每月出勤報表（每月 1 日推播上月報表給管理員）

## 安裝與啟動

```bash
npm install
npm start
```

預設在 <http://localhost:3000> 啟動。

### 環境變數

| 變數 | 預設值 | 說明 |
|---|---|---|
| `PORT` | `3000` | 服務埠號 |
| `ADMIN_PASSWORD` | `admin123` | 管理員密碼（**正式使用請務必更換**） |
| `DATA_DIR` | `./data` | SQLite 資料庫與簽章金鑰存放目錄 |
| `LINE_CHANNEL_ACCESS_TOKEN` | （空） | LINE Messaging API 的 Channel access token；未設定時通知功能為模擬模式（只寫 log） |
| `LINE_CHANNEL_SECRET` | （空） | LINE Channel secret，用於驗證 webhook 簽章 |
| `LINE_ADMIN_IDS` | （空） | 接收每日統計／每月報表的管理員 LINE User ID，逗號分隔 |
| `TZ_NAME` | `Asia/Taipei` | 排程與統計使用的時區 |
| `WORK_START` | `09:00` | 上班時間（遲到判定基準） |
| `LATE_GRACE_MIN` | `0` | 遲到寬限分鐘數 |
| `LATE_REMIND_TIME` | `09:15` | 遲到（未簽到）提醒時間 |
| `CHECKOUT_REMIND_TIME` | `18:30` | 未簽退提醒時間 |
| `DAILY_SUMMARY_TIME` | `19:00` | 每日統計推播時間 |
| `MONTHLY_REPORT_TIME` | `09:00` | 每月 1 日報表推播時間 |
| `WORKDAYS` | `1,2,3,4,5` | 工作日（1=週一 … 7=週日），提醒與每日統計只在工作日發送 |

## 使用流程

1. 管理員開啟 `/admin.html` 登入，新增人員；系統會產生一組 6 位數初始 PIN（僅顯示一次），轉交給員工本人。
2. 員工用手機開啟 `/phone.html`，以工號＋PIN 登入，畫面即顯示動態 QR Code。
3. 掃描站（平板或另一支手機）開啟 `/scanner.html`，管理員登入、填站點名稱後開始掃描。
4. 掃到條碼後，系統驗證並記錄：人員（工號／姓名／部門）、動作（簽到或簽退）、站點名稱、GPS 座標、時間。
5. 管理後台可隨時查詢記錄並匯出 CSV。

## LINE 通知設定

1. 到 [LINE Developers Console](https://developers.line.biz/console/) 建立 Provider 與 **Messaging API** channel（即 LINE 官方帳號）。
2. 在 channel 設定頁取得 **Channel secret** 與 **Channel access token**，設定到環境變數 `LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`。
3. 將 Webhook URL 設為 `https://你的網域/api/line/webhook` 並啟用 Webhook（LINE 要求必須是 HTTPS）。
4. 員工用 LINE 加官方帳號為好友，傳送訊息「`綁定 工號 PIN碼`」（例：`綁定 A001 123456`）完成綁定，之後即會收到簽到退通知與提醒。
5. 管理員加好友後傳「`id`」取得自己的 LINE User ID，填入 `LINE_ADMIN_IDS`，即可收到每日統計與每月報表。

LINE 指令一覽（直接傳訊息給官方帳號）：

| 指令 | 功能 |
|---|---|
| `綁定 工號 PIN碼` | 綁定本人帳號，開始接收通知 |
| `查詢` | 查看自己今日的簽到退記錄 |
| `解除綁定` | 停止接收通知 |
| `id` | 顯示自己的 LINE User ID（供管理員設定用） |

未設定 LINE 金鑰時，系統照常運作，通知內容只會寫入伺服器 log（模擬模式），方便先行測試。

## 安全設計

- 動態條碼內容為伺服器以 HMAC-SHA256 簽章的 token，含到期時間（60 秒）與一次性 nonce：
  - 過期即失效，無法用截圖長期冒用
  - 每個條碼只能掃描一次，防止重放攻擊
- PIN 碼以 scrypt 加鹽雜湊儲存，不存明碼
- 掃描站 API 需管理員登入，外人無法偽造簽到記錄

## 注意事項

- 瀏覽器的**相機與定位**功能只在 HTTPS 或 `localhost` 下可用。區網部署時建議以反向代理（如 Caddy、nginx）加上 TLS。
- 資料存於 `data/signin.db`（SQLite），備份該目錄即可。

## 技術架構

- 後端：Node.js + Express + better-sqlite3（單一伺服器、免外部資料庫）
- 前端：純 HTML/CSS/JS；掃描使用 [html5-qrcode](https://github.com/mebjas/html5-qrcode)，QR 產生使用 [node-qrcode](https://github.com/soldair/node-qrcode)
