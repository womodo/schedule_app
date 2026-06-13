# みんなの予定表（ラズパイ自宅サーバー版 / Tailscale）

家族・チームで共有するカレンダーアプリです。Raspberry Pi を Web/DB サーバーにして、
スマホ（Android / iPhone）・タブレット・PC のブラウザからアクセスします。
**Tailscale（VPN）** で繋ぐので、自宅でも外出先でも同じURLで**本物のサーバーに直結**し、
誰の編集も**即時に全員へ反映**されます。常にサーバーの最新を表示する方針のため、
**Service Worker（オフラインキャッシュ）は使いません**（古いキャッシュが残る問題を避けるため）。

- バックエンド: **Python + Flask**（Gunicorn 127.0.0.1:5001）
- 到達経路 / HTTPS: **Tailscale `serve` → nginx → Gunicorn**（HTTPS は serve が自動発行・外部に晒さない。
  nginx でパス振り分けし、本アプリは **`/schedule`** サブパスで配信）
- DB: **SQLite**（ファイル1つ。バックアップが簡単）
- フロント: **バニラJS + IndexedDB**（表示の高速化＋セッション中の編集キュー）
- 認証: **ユーザーごとのログイン**（色分け表示）

---

## ⚠️ はじめに：この構成の動作範囲

サーバーは **インターネットには公開しません**。代わりに **Tailscale のプライベートネットワーク**
（自分のアカウントに参加した端末だけが入れる VPN）でラズパイに繋ぎます。動作は次のとおり：

| 状況 | 閲覧 | 追加・編集 | 他の人へ反映 |
|------|:----:|:------:|:------:|
| 自宅Wi-Fi内 | ✅ | ✅ | ✅ 即時 |
| 外出中・**Tailscale ON** | ✅ | ✅ | ✅ **即時** |
| 一時的に接続が切れた（アプリは起動中） | 表示中の内容は見える | ✅（端末に保存・キューに蓄積） | ⏳ 接続復帰時に自動同期 |
| アプリを閉じて圏外 / Tailscale OFF | ❌（起動には接続が必要） | ― | ― |

> Tailscale が繋がっていれば外出先でも自宅と全く同じ＝即同期です。Service Worker を廃止したため
> **アプリの起動（初回読み込み）には接続が必要**ですが、起動中に一時的に切れた場合の編集は
> IndexedDB に溜まり、接続が戻ると自動同期します。

### HTTPS について（重要・でも簡単）
Tailscale の `serve` を使うと `https://<ホスト名>.<テイルネット>.ts.net/` という
**正規の有効な証明書付き URL**が自動で用意され、ログインの安全性も確保できます。
証明書の自作（mkcert / 自己署名）も各端末へのルート証明書配布も**一切不要**です。

---

## 1. ラズパイ側のセットアップ

### 1-1. ファイルを配置
このフォルダ一式をラズパイの `~/apps/schedule`（＝`/home/pi/apps/schedule`）に置きます（git clone か scp で転送）。
```bash
mkdir -p ~/apps && git clone https://github.com/womodo/schedule_app.git ~/apps/schedule
```

### 1-2. Python と依存パッケージ（uv で管理）
Python・仮想環境・依存パッケージは [uv](https://docs.astral.sh/uv/) で管理します。

```bash
# uv をインストール（未導入の場合）
sudo apt update && sudo apt install -y curl
curl -LsSf https://astral.sh/uv/install.sh | sh
source ~/.bashrc                     # PATH を反映（または再ログイン）

cd ~/apps/schedule/server
uv python install 3.12               # uv 管理の Python を用意
uv venv --python 3.12                # .venv を作成（uv 管理の Python を使用）
uv pip install -r requirements.txt   # 依存をインストール（gunicorn を含む）
```
> `.venv/` は uv が作成するため、後述の systemd / cron の `.venv/bin/...` のパスはそのまま使えます。

### 1-3. ユーザー（家族）を登録
```bash
cd ~/apps/schedule/server
# uv run python manage.py adduser <ID> <パスワード> [表示名] [色#RRGGBB]
uv run python manage.py adduser papa  himitsu1 "パパ"   "#3b82f6"
uv run python manage.py adduser mama  himitsu2 "ママ"   "#ef4444"
uv run python manage.py adduser taro  himitsu3 "たろう" "#10b981"

uv run python manage.py listusers          # 確認
uv run python manage.py passwd papa newpass # パスワード変更
```

### 1-4. Tailscale を入れる
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up                    # 表示されるURLをブラウザで開き、自分のアカウントで認証
tailscale status                     # このラズパイの Tailscale 名 / IP を確認
```
- 無料プラン（Personal）で家族の端末は十分まかなえます。
- 管理コンソール [https://login.tailscale.com/admin/dns](https://login.tailscale.com/admin/dns) で
  **MagicDNS** を ON、**HTTPS Certificates（Enable HTTPS）** を ON にしておきます
  （`serve` が正規証明書を発行するために必要）。

> このラズパイのフル DNS 名は `<ホスト名>.<テイルネット名>.ts.net`（例 `raspi3.tailXXXX.ts.net`）。
> `tailscale serve status`（2-3）に表示される URL の末尾に `/schedule/` を付けたものがアクセス先になります。

---

## 2. アプリを動かす（Gunicorn + nginx + tailscale serve）

ラズパイ1台で複数アプリ（study / schedule / wbgt / stats など）を **1つの ts.net URL** から
パスで振り分けるため、**nginx を前段**に置きます。schedule は **`/schedule`** サブパスで配信します。

```
[各端末のブラウザ] ──Tailscale(HTTPS/443・正規証明書)──> [ラズパイ tailscale serve]
                                                          └─> [nginx :80]
                                                               ├─ /study    → Gunicorn :5000
                                                               ├─ /schedule → Gunicorn :5001 ── Flask/SQLite
                                                               ├─ /wbgt     → PHP-FPM
                                                               └─ /stats    → PHP-FPM
```
Gunicorn はループバック（127.0.0.1:5001）だけで待ち受け、外には一切晒しません。
Tailscale の `serve` が VPN 内に対してのみ HTTPS を終端して **nginx:80** へ転送し、
nginx がパスでアプリを振り分けます。HTTPS は Tailscale 層が担うので nginx は HTTP（:80）で十分です。

### 2-1. Gunicorn を systemd 登録（自動起動）
同梱の `deploy/schedule-gunicorn.service` を使います（パス・ユーザー名は環境に合わせて確認）。
```bash
cd ~/apps/schedule/server
uv run gunicorn -c gunicorn.conf.py wsgi:app   # まず手動テスト（Ctrl+C で停止）

sudo cp ~/apps/schedule/deploy/schedule-gunicorn.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now schedule-gunicorn
journalctl -u schedule-gunicorn -f             # ログ確認
```
> ポートは `server/gunicorn.conf.py` の `bind = "127.0.0.1:5001"` で指定。
> systemd は `.venv/bin/gunicorn` を直接呼ぶため、uv で作った `.venv` のまま動きます。

> **⚠️ 移設時の注意**: アプリの置き場所を変えた／このユニットを更新したときは、必ず
> `sudo cp .../deploy/schedule-gunicorn.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl restart schedule-gunicorn`
> を実行してください。これを忘れると Gunicorn が**旧 `WorkingDirectory` の古い静的ファイルを配信し続け**、
> 新しい画面に切り替わりません（CSS/JS が古いまま等の原因No.1）。

### 2-2. nginx で /schedule に振り分け
nginx をパス振り分けの前段にします。**Raspberry Pi OS 標準の `default` サイト**（`listen 80 default_server`）の
`server { ... }` の中に `/schedule` の location を**追記**するのが手早く確実です（専用ファイルを別に作って
`location` を `server` の外に置くと無効になり 404 になります）。
```bash
sudo apt install -y nginx
sudo nano /etc/nginx/sites-available/default
```
`server_name _;` の行のすぐ下に、同梱 `deploy/nginx-schedule.conf` の中身（下記）を貼り付けます：
```nginx
        # --- 予定表アプリ: /schedule を Gunicorn(:5001) へ ---
        location = /schedule { return 301 /schedule/; }   # 末尾スラッシュを強制（相対パス配信の前提）
        location /schedule/ {
                proxy_pass http://127.0.0.1:5001/;        # 末尾の "/" が /schedule を剥がして Flask に渡す
                proxy_set_header Host              $host;
                proxy_set_header X-Real-IP         $remote_addr;
                proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
                proxy_set_header X-Forwarded-Proto https;  # 体感は https（Secure Cookie 用）
                proxy_read_timeout 60s;
        }
```
反映：
```bash
sudo nginx -t                       # 設定の文法チェック（syntax is ok / test is successful）
sudo systemctl reload nginx
curl -i http://127.0.0.1/schedule/  # 200 + HTML が返れば成功
```
- **proxy_pass 末尾の `/`** が `/schedule` を取り除いてから Flask へ渡すため、アプリ側のルート定義は無改修で動きます。
- フロントは相対パス配信なので、末尾スラッシュ無しの `/schedule` は `/schedule/` へ301します。
- 同じ Pi の `/wbgt` `/stats`（PHP）は同じ `default` サイトの php-fpm 設定で配信され、`/study` 等を足すときも
  この server ブロックに `location` を並べるだけです（他アプリの location 例は `deploy/nginx-schedule.conf` 冒頭コメント参照）。

### 2-3. tailscale serve で公開（VPN内のみ・HTTPS）
```bash
sudo tailscale serve --bg 80          # https://<host>.ts.net/ → nginx(127.0.0.1:80) を常駐で転送
sudo tailscale serve status           # 公開URLと転送先を確認
```
- `--bg` で tailscaled に常駐登録されるため、**再起動後も自動で復活**します（serve 用の systemd 登録は不要）。
- 解除したいときは `sudo tailscale serve --https=443 off`。

ブラウザで `https://<ホスト名>.<テイルネット名>.ts.net/schedule/` を開いてログインできれば完了です。

> **ファイアウォール**: Tailscale 経由なので、ルーターのポート開放は不要。ufw を使っていても
> `tailscale0` インターフェイス経由のため通常そのまま通ります（必要なら `sudo ufw allow in on tailscale0`）。

---

## 3. スマホ／PCでの使い方（Tailscale 参加 → ホーム画面に追加）

各端末を**同じ Tailscale アカウント**に参加させてから、ブラウザでアプリを開きます。

1. **Tailscale アプリを入れて同じアカウントでログイン**
   - iPhone / Android: App Store / Google Play で「Tailscale」を入れてサインイン
   - PC(Windows/Mac): [tailscale.com/download](https://tailscale.com/download) からインストール
2. ブラウザで `https://<ホスト名>.<テイルネット名>.ts.net/schedule/` を開く → アプリにログイン
3. **ホーム画面に追加**してアプリのように使う
   - iPhone(Safari): 共有ボタン →「ホーム画面に追加」
   - Android(Chrome): メニュー →「アプリをインストール」/「ホーム画面に追加」
   - PC(Chrome/Edge): アドレスバーのインストールアイコン

ホーム画面アイコンから起動すると全画面のアプリとして動き、Tailscale が繋がっていれば即同期します。

> Service Worker は廃止したため、**起動（初回読み込み）には接続が必要**です。Tailscale は
> バックグラウンドで繋がりっぱなしにできるので、普段は意識せず使えます。起動後に一時的に
> 切れても、その間の編集は端末に溜まり接続復帰時に同期されます。

---

## 4. バックアップ

予定データは `server/schedule.db` の1ファイルだけ。これを定期コピーすればOK。
```bash
cp ~/apps/schedule/server/schedule.db ~/backups/schedule-$(date +%Y%m%d).db
```
cron 例（毎日3時）: `0 3 * * * cp ~/apps/schedule/server/schedule.db ~/backups/schedule-$(date +\%Y\%m\%d).db`

---

## 5. LINE通知（前日6:00に「翌日の予定」を送る）

毎朝6:00に、**翌日の予定があるときだけ** LINE へ通知します（`server/notify_line.py`）。
非公開・削除済みの予定は通知に含めません。

> ※ LINE Notify は 2025/3 で終了したため、**LINE Messaging API（公式アカウント）**を使います。

### 5-1. LINE公式アカウント（Messaging API）を用意
1. [LINE Developers](https://developers.line.biz/) でログイン → プロバイダー作成
2. **Messaging API チャネル**を作成（＝LINE公式アカウントができる）
3. チャネルの「Messaging API設定」で **チャネルアクセストークン（long-lived）**を発行してコピー
4. 通知を受け取る家族は、その公式アカウントを **友だち追加**
   - 全員に送るなら友だち追加だけでOK（ブロードキャスト）
   - 特定の人/グループだけに送るなら、その `userId` / `groupId` が必要

### 5-2. 設定ファイルを作成
`server/line_config.json`（雛形は `line_config.json.example`）:
```json
{
  "channel_access_token": "発行したトークン",
  "to": []
}
```
- `"to": []` … 友だち**全員へブロードキャスト**（おすすめ・簡単）
- `"to": ["Uxxxx...", "Cxxxx..."]` … 指定ユーザー/グループへ送信（multicast）

### 5-3. 動作確認
```bash
cd ~/apps/schedule/server
uv run python notify_line.py --date 2026-06-07 --dry-run   # 送信せず内容を表示
uv run python notify_line.py --dry-run                     # 翌日分を表示
uv run python notify_line.py                               # 実際に送信（予定が無ければ何もしない）
```
送信例:
```
📅 明日 ○月○日(○) の予定

・09:00 ○○〜10:00（場所） [作成者]
・終日 △△ [作成者]
```

### 5-4. 毎朝6:00に自動実行（cron）
```bash
crontab -e
```
を開き、次の行を追加（パスは環境に合わせて）。タイムゾーンは日本（JST）想定:
```cron
0 6 * * *  cd /home/pi/apps/schedule/server && /home/pi/apps/schedule/server/.venv/bin/python notify_line.py >> notify.log 2>&1
```
ラズパイの時刻が日本になっているか確認: `timedatectl`（必要なら `sudo timedatectl set-timezone Asia/Tokyo`）。

### 5-5. 予定がある人にだけ個別送信する（per-user モード・任意）

全員へまとめて送る代わりに、**各自が作成者または参加者になっている翌日予定だけ**を、その人の
LINE に個別 push 送信できます（予定が無い人には送りません）。本人宛なので**非公開予定も含めて**通知します。

1. 各自が一度、公式アカウントのトークで **アカウント連携**しておく（→ 6-3。`連携 ユーザーID パスワード`）。
   これで `users.line_user_id` が登録され、個別送信の宛先になります。
2. `server/line_config.json` に `"per_user": true` を足す（または cron で `--per-user` を付ける）:
   ```json
   {
     "channel_access_token": "（チャネルアクセストークン）",
     "to": [],
     "per_user": true
   }
   ```
3. 動作確認・cron 例:
   ```bash
   uv run python notify_line.py --per-user --dry-run    # 誰に何が送られるか表示
   # cron（毎朝6:00）
   0 6 * * *  cd /home/pi/apps/schedule/server && /home/pi/apps/schedule/server/.venv/bin/python notify_line.py >> notify.log 2>&1
   ```
   > `--per-user` は `line_config.json` の `per_user` より優先されます。`per_user: true` にしてあれば
   > cron 側はオプション無しでOKです。連携していない人には届きません（その人の分は送られません）。

---

## 6. LINE から予定を追加する（Webhook・任意）

LINE にメッセージを送ると予定を登録できます（例：「明日 15:00 歯医者」）。

> **⚠️ ここだけは公開が必要**：通知（送信）と違い、追加（受信）は LINE のサーバーから
> こちらへ届く **Webhook** なので、Tailscale（プライベート）の中だけでは受け取れません。
> **公開HTTPS（正規CAの有効な証明書）**が必要です。次のどちらかで公開します。

**方法A: Tailscale Funnel（追加ツール不要）**
`serve` を「VPN内のみ」から「インターネット公開」に切り替える機能です。アプリ全体を公開
したくないので、**Webhook のパスだけ**を Funnel で出します。
```bash
sudo tailscale funnel --bg --set-path /api/line/webhook http://127.0.0.1:5001/api/line/webhook
sudo tailscale funnel status
```
公開URLは `https://<ホスト名>.<テイルネット名>.ts.net/api/line/webhook` になります。
（管理コンソールで Funnel の利用許可が必要な場合があります。）

> このパスは Funnel から **Gunicorn(:5001) へ直接**転送され、nginx や `/schedule` の振り分けを通りません。
> そのため公開 URL は `/schedule` を含まない `.../api/line/webhook` のままで、サブパス化の影響を受けません。
> 通常利用（`/schedule/`）の serve とは別パスなので両者は共存できます。

**方法B: Cloudflare Tunnel（無料・独自ドメイン可）**
ラズパイに `cloudflared` を入れ、`https://your-domain/` を 127.0.0.1:5001 に向けます。

### 6-1. Webhook URL を設定
1. 上記AまたはBで Webhook を公開
2. [LINE Developers](https://developers.line.biz/) のチャネル → 「Messaging API設定」で
   **Webhook URL** に公開した `.../api/line/webhook` を設定し、**Webhookの利用をオン**
3. 「検証」ボタンで疎通確認（成功＝200が返る）
4. **応答メッセージ（自動応答）はオフ**にしておくと邪魔になりません

### 6-2. 設定ファイルにシークレットを追加
`server/line_config.json` に **channel_secret**（署名検証用）を追加します。返信には
通知と同じ **channel_access_token** を使います。
```json
{
  "channel_access_token": "（チャネルアクセストークン）",
  "channel_secret": "（チャネルシークレット）",
  "to": []
}
```
> `channel_secret` を設定すると、LINE からのリクエストを署名検証します（推奨）。

### 6-3. LINE とアカウントを連携（各自1回）
公式アカウントのトークに、次の形式で送信します（アプリのログインID・パスワード）:
```
連携 papa himitsu1
```
成功すると、その LINE アカウントが papa として登録され、以降の予定はその人が作成者になります。

### 6-4. 予定の追加（メッセージ例）
```
明日 15:00 歯医者
6/10 9時 会議 ＠渋谷 #仕事
6月10日 終日 運動会
来週月曜 10時半 打合せ
12/24 18:00〜21:00 パーティー
```
- 日付：今日 / 明日 / 明後日 / 6月10日 / 6/10 / 2026/12/24 / 来週月曜 など
- 時刻：`15:00` `9時` `10時半` `午後3時`（省略すると終日）。`〜` で終了時刻も指定可
- 場所：`＠渋谷` または `場所:渋谷`／タグ：`#仕事`
- 「ヘルプ」と送ると使い方を返信します

登録されると「✅ 追加しました 6月8日(月) 15:00 歯医者」のように返信されます。

> 非公開・参加者の指定は LINE からは未対応です（アプリ画面で編集してください）。

---

## 補足：Tailscale を使わずローカルだけで試す（開発用）

ラズパイ上やPCで手早く動作確認したいときは、開発サーバーをそのまま起動できます。
```bash
cd ~/apps/schedule/server
uv run python app.py            # http://127.0.0.1:8000（localhost なので Service Worker も可）
```
スマホ等の別端末から HTTPS で使う本番アクセスは、上記の **Tailscale serve** が前提です。

---

## 構成ファイル

```
apps/schedule/        # 配置先（git の clone 先）
├── server/
│   ├── app.py            Flask本体（API + PWA配信 + 開発用起動）
│   ├── wsgi.py           Gunicorn用WSGIエントリ（init_db + ProxyFix）
│   ├── gunicorn.conf.py  Gunicorn設定（bind=127.0.0.1:5001）
│   ├── manage.py         ユーザー管理CLI（adduser/listusers/passwd/setadmin/deluser）
│   ├── notify_line.py    前日6:00のLINE通知スクリプト（cronで実行）
│   ├── line_parse.py     LINEメッセージ→予定の解析（Webhookで使用）
│   ├── line_config.json  LINE設定（token/secret。自分で作成。gitには含めない）
│   ├── schema.sql        SQLiteスキーマ
│   └── requirements.txt
├── deploy/
│   ├── schedule-gunicorn.service  Gunicorn の systemd ユニット
│   └── nginx-schedule.conf        nginx の location 断片（/schedule を :5001 へ転送）
├── web/
│   ├── index.html        画面
│   ├── manifest.json     PWA設定
│   ├── service-worker.js 撤去用（旧SWを解除しキャッシュ削除。SWは廃止）
│   ├── css/style.css
│   ├── js/db.js          IndexedDB（オフライン保存）
│   ├── js/api.js         サーバーAPIラッパー
│   ├── js/sync.js        同期エンジン（Last-Write-Wins）
│   ├── js/app.js         UI・カレンダー描画
│   └── icons/icon.svg
└── README.md
```

## 同期のしくみ（技術メモ）

- 予定は **UUID** を持ち、クライアントでも生成できる（オフライン作成可）。
- 各予定に `updated_at`(epoch ms) と `deleted` フラグ。削除は論理削除で同期。
- クライアントは未同期の変更を `_dirty` で保持し、オンライン時に `/api/sync` へ push、
  同時に `since` 以降の更新を pull して IndexedDB にマージ。
- 競合は **updated_at による Last-Write-Wins**（サーバー・クライアント両方で判定）。
- 端末間の時計ズレが大きいと LWW の判定に影響します（家庭利用では実用上問題なし）。
```
