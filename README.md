# みんなの予定表（ラズパイ自宅サーバー版）

家族・チームで共有するカレンダーアプリです。Raspberry Pi を Web/DB サーバーにして、
スマホ（Android / iPhone）・タブレット・PC のブラウザからアクセスします。
**PWA（Service Worker）** によりオフラインでも閲覧・編集ができ、ネットに戻ると自動同期します。

- バックエンド: **Python + Flask**
- DB: **SQLite**（ファイル1つ。バックアップが簡単）
- フロント: **PWA**（バニラJS・IndexedDB・Service Worker）
- 認証: **ユーザーごとのログイン**（色分け表示）

---

## ⚠️ はじめに：この構成の動作範囲（重要）

このアプリは **インターネットには公開しません**。Service Worker は「サーバーを外部公開する仕組み」
ではなく「アプリと予定データを端末内にキャッシュする仕組み」です。したがって動作は次のとおり：

| 状況 | 閲覧 | 追加・編集（自端末） | 他の人へ反映 |
|------|:----:|:------:|:------:|
| 自宅Wi-Fi内 | ✅ | ✅ | ✅ 即時 |
| 外出中（自宅ネット外） | ✅（最後に見た内容） | ✅（端末に保存・キューに蓄積） | ⏳ **自宅に戻った時に自動同期** |

> 外出先でも「即・全員に反映」したい場合は、末尾の「**外出先からもリアルタイム同期したい場合**」を参照
> （Cloudflare Tunnel / Tailscale を足すだけ。アプリ側の変更は不要）。

### もう一つの必須事項：HTTPS
Service Worker は **HTTPS（または localhost）でしか動きません**。`http://192.168.x.x` では登録されません。
そのため LAN 内でも **自己署名証明書で HTTPS 化**します（下記手順）。

---

## 1. ラズパイ側のセットアップ

### 1-1. ファイルを配置
このフォルダ一式をラズパイの `~/schedule_app` などに置きます（scp や git で転送）。

### 1-2. Python と依存パッケージ（uv で管理）
Python・仮想環境・依存パッケージは [uv](https://docs.astral.sh/uv/) で管理します。

```bash
# uv をインストール（未導入の場合）
sudo apt update && sudo apt install -y curl
curl -LsSf https://astral.sh/uv/install.sh | sh
source ~/.bashrc                     # PATH を反映（または再ログイン）

cd ~/schedule_app/server
uv python install 3.12               # uv 管理の Python を用意
uv venv --python 3.12                # .venv を作成（uv 管理の Python を使用）
uv pip install -r requirements.txt   # 依存をインストール
```
> `.venv/` は uv が作成するため、後述の systemd / cron の `.venv/bin/...` のパスはそのまま使えます。
> コマンドは `uv run <cmd>`（例: `uv run python manage.py ...`）でも、`.venv` を直接呼んでも実行できます。

### 1-3. ユーザー（家族）を登録
```bash
cd ~/schedule_app/server
# uv run python manage.py adduser <ID> <パスワード> [表示名] [色#RRGGBB]
uv run python manage.py adduser papa  himitsu1 "パパ"   "#3b82f6"
uv run python manage.py adduser mama  himitsu2 "ママ"   "#ef4444"
uv run python manage.py adduser taro  himitsu3 "たろう" "#10b981"

uv run python manage.py listusers          # 確認
uv run python manage.py passwd papa newpass # パスワード変更
```

### 1-4. HTTPS 証明書を用意（Service Worker に必須）

**方法A（推奨）: mkcert で「信頼される」証明書を作る**
警告が出ず、iPhone でも快適です。各端末にルート証明書をインストールします。
```bash
sudo apt install -y libnss3-tools
# mkcert を入手（ARM用バイナリ）
curl -JLO "https://dl.filippo.io/mkcert/latest?for=linux/arm64"
chmod +x mkcert-v*-linux-arm64 && sudo mv mkcert-v*-linux-arm64 /usr/local/bin/mkcert
mkcert -install
mkdir -p ~/schedule_app/server/certs
cd ~/schedule_app/server/certs
# ラズパイのIP（例 192.168.1.20）と .local 名を入れる
mkcert -cert-file cert.pem -key-file key.pem 192.168.1.20 raspberrypi.local localhost
```
作成された `rootCA.pem`（`mkcert -CAROOT` の場所）を各スマホ/PCに配り、
「信頼されたルート証明書」としてインストールします。

**配り方：Nginx で配信すると楽**（B構成を使う場合）
`deploy/nginx-schedule.conf` は `/rootCA.pem` を配信する設定を含んでいます。
公開していいのは `rootCA.pem` だけなので、`certs/` に**それだけ**コピーします
（`rootCA-key.pem`〈秘密鍵〉は絶対に置かない／配信しない）。
```bash
cp "$(mkcert -CAROOT)/rootCA.pem" ~/schedule_app/server/certs/rootCA.pem
```
各端末のブラウザで `https://<ラズパイIP>:8443/rootCA.pem` を開くとダウンロードできます。
（CA未信頼の初回は証明書警告が出ますが、続行してファイルだけ取得すればOK。
AirDrop / USB / scp で直接配ってもかまいません。）

インストール手順：
- iPhone: ダウンロード →「設定 > 一般 > VPNとデバイス管理」でインストール →
  「設定 > 一般 > 情報 > 証明書信頼設定」で **完全に信頼** を有効化
- Android: 設定 > セキュリティ > 証明書をインストール（CA証明書）
- PC(Chrome/Edge): OSの証明書ストアに「信頼されたルート証明機関」として取り込み

**方法B（手早く）: 自己署名でとりあえず動かす**
ブラウザに警告が出ますが「続行」すれば多くの環境で Service Worker は動きます（iPhone は方法A推奨）。
```bash
mkdir -p ~/schedule_app/server/certs && cd ~/schedule_app/server/certs
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 3650 \
  -subj "/CN=schedule" \
  -addext "subjectAltName=IP:192.168.1.20,DNS:raspberrypi.local,DNS:localhost"
```

### 1-5. 起動（動作確認用の簡易サーバー）
```bash
cd ~/schedule_app/server
uv run python app.py --ssl     # https://0.0.0.0:8443 で起動
```
ブラウザで `https://192.168.1.20:8443` を開きログイン。

> `--ssl` を付けず `python app.py` だと HTTP(8000) で起動します。動作確認用で、
> スマホからは Service Worker が無効になります。

---

## 2. 自動起動（systemd でサービス化）

運用方法は2通り。**家庭利用は B（Gunicorn + Nginx）を推奨**します。

### A. 簡易（開発サーバーをそのまま自動起動）
`/etc/systemd/system/schedule_app.service`（パス・ユーザー名は環境に合わせて変更）:
```ini
[Unit]
Description=Schedule App (Flask)
After=network.target

[Service]
User=pi
WorkingDirectory=/home/pi/schedule_app/server
ExecStart=/home/pi/schedule_app/server/.venv/bin/python app.py --ssl
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now schedule_app
journalctl -u schedule_app -f          # ログ確認
```

### B. 本番運用（推奨）：Flask + Gunicorn + Nginx（公開ポート 8443）
**Gunicorn** がアプリを `127.0.0.1:5001`（内部）で動かし、**Nginx** が HTTPS を終端して
リバースプロキシします（Service Worker に必要な HTTPS は Nginx 側で処理）。
公開ポートは **8443** で、ブラウザからは `https://<ラズパイIP>:8443/` でアクセスします。
設定ファイルは `server/` と `deploy/` に同梱済みです。

```
[ブラウザ] ──HTTPS(8443)──> [Nginx] ──HTTP──> [Gunicorn 127.0.0.1:5001] ── Flask/SQLite
```

> **専用ポート 8443 にしている理由**：ラズパイで他のサイトを 80/443 で動かしていても
> 衝突せず共存できます。`deploy/nginx-schedule.conf` は 8443 のみを使い、
> `/etc/nginx/sites-enabled/default` の削除も不要です（他サイトに一切触れません）。
> 80/443 を予定表専用に使ってよい環境なら、`listen 8443 ssl;` を `listen 443 ssl;` に
> 変えれば `https://<IP>/`（ポート指定なし）でアクセスできます。

**1) Gunicorn を入れる**（A をすでに動かしている場合は止める: `sudo systemctl disable --now schedule_app`）
```bash
cd ~/schedule_app/server
uv pip install -r requirements.txt        # gunicorn を含む
uv run gunicorn -c gunicorn.conf.py wsgi:app  # 単体テスト（Ctrl+C で停止）
```
> ポートは `server/gunicorn.conf.py` の `bind = "127.0.0.1:5001"` で指定しています。
> systemd は `.venv/bin/gunicorn` を直接呼ぶため、uv で作った `.venv` のまま動きます。

**2) Gunicorn を systemd 登録**（同梱の `deploy/schedule-gunicorn.service` を使用）
```bash
sudo cp ~/schedule_app/deploy/schedule-gunicorn.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now schedule-gunicorn
journalctl -u schedule-gunicorn -f
```

**3) Nginx を入れて設定**（同梱の `deploy/nginx-schedule.conf` を使用）
```bash
sudo apt install -y nginx
sudo cp ~/schedule_app/deploy/nginx-schedule.conf /etc/nginx/sites-available/schedule
sudo ln -sf /etc/nginx/sites-available/schedule /etc/nginx/sites-enabled/schedule
sudo nginx -t && sudo systemctl reload nginx
sudo ufw allow 8443/tcp                          # ファイアウォールで 8443 を開放
```
> **他サイトと共存する構成なので `default` は削除しません**（8443専用で衝突しないため）。
> 予定表だけを動かすラズパイで 80/443 を使ってよい場合に限り、`nginx-schedule.conf` の
> `listen 8443 ssl;` を `listen 443 ssl;` に変え、`sudo rm -f /etc/nginx/sites-enabled/default`
> で既定サイトを無効化してもOKです（その場合は `ufw allow 443/tcp`）。

証明書のパス（`ssl_certificate*`）は `deploy/nginx-schedule.conf` 内を環境に合わせて確認。
ブラウザで `https://<ラズパイIP>:8443/` を開きます。

---

## 3. スマホ／PCでの使い方（ホーム画面に追加 = アプリ化）

1. ラズパイのアドレス（例 `https://192.168.1.20:8443`）をブラウザで開く
2. ログイン
3. **ホーム画面に追加**してアプリのように使う
   - iPhone(Safari): 共有ボタン →「ホーム画面に追加」
   - Android(Chrome): メニュー →「アプリをインストール」/「ホーム画面に追加」
   - PC(Chrome/Edge): アドレスバーのインストールアイコン

ホーム画面アイコンから起動すると全画面のアプリとして動き、オフラインでも開けます。

> 端末ごとに **一度は自宅Wi-Fiでログイン＆データ取得**しておくと、外出先でもキャッシュから開けます。

---

## 4. バックアップ

予定データは `server/schedule.db` の1ファイルだけ。これを定期コピーすればOK。
```bash
cp ~/schedule_app/server/schedule.db ~/backups/schedule-$(date +%Y%m%d).db
```
cron 例（毎日3時）: `0 3 * * * cp ~/schedule_app/server/schedule.db ~/backups/schedule-$(date +\%Y\%m\%d).db`

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
cd ~/schedule_app/server
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
0 6 * * *  cd /home/pi/schedule_app/server && /home/pi/schedule_app/server/.venv/bin/python notify_line.py >> notify.log 2>&1
```
ラズパイの時刻が日本になっているか確認: `timedatectl`（必要なら `sudo timedatectl set-timezone Asia/Tokyo`）。

> 各自に「自分が参加する予定だけ」を個別配信したい場合は、アプリのユーザーと LINE userId を
> 紐づける拡張が必要です（今回は家族向けに、全員へ当日分をまとめて送る方式）。

---

## 6. LINE から予定を追加する（Webhook・任意）

LINE にメッセージを送ると予定を登録できます（例：「明日 15:00 歯医者」）。

> **⚠️ 外部公開が必要**：通知（送信）と違い、追加（受信）は LINE 側から
> サーバーへ届く **Webhook** を使うため、**公開HTTPS（正規CAの有効な証明書）**が必須です。
> 自己署名証明書は不可。**Cloudflare Tunnel（無料）**での公開を推奨します（→ 7章）。

### 6-1. Webhook URL を公開して設定
1. Cloudflare Tunnel 等で `https://your-domain/` を Nginx(→Gunicorn) に向ける（7章）
2. [LINE Developers](https://developers.line.biz/) のチャネル → 「Messaging API設定」で
   **Webhook URL** に `https://your-domain/api/line/webhook` を設定し、**Webhookの利用をオン**
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

## 7. 外出先からもリアルタイム同期したい場合（任意の拡張）

アプリのコードは変えずに、ラズパイへの到達経路を足すだけです。

- **Tailscale（VPN・最も安全）**: ラズパイと各端末に Tailscale を入れ、VPN内のIPでアクセス。
  外部公開せずどこからでも本物のサーバーに繋がるので、外出先でも即同期。
- **Cloudflare Tunnel（無料・固定IP/ポート開放不要）**: ラズパイに `cloudflared` を入れて
  `https://yourname.example.com` のような固定URLで公開。HTTPSも自動なので、その場合は
  自己署名証明書も不要になります。

どちらを足しても、アプリは同じURL運用に切り替えるだけでそのまま動きます。

---

## 構成ファイル

```
schedule_app/
├── server/
│   ├── app.py            Flask本体（API + PWA配信 + 開発用HTTPS起動）
│   ├── wsgi.py           Gunicorn用WSGIエントリ（init_db + ProxyFix）
│   ├── gunicorn.conf.py  Gunicorn設定（bind=127.0.0.1:5001）
│   ├── manage.py         ユーザー管理CLI（adduser/listusers/passwd/setadmin/deluser）
│   ├── notify_line.py    前日6:00のLINE通知スクリプト（cronで実行）
│   ├── line_parse.py     LINEメッセージ→予定の解析（Webhookで使用）
│   ├── line_config.json  LINE設定（token/secret。自分で作成。gitには含めない）
│   ├── schema.sql        SQLiteスキーマ
│   ├── requirements.txt
│   └── certs/            HTTPS証明書（自分で生成。gitには含めない）
├── deploy/
│   ├── schedule-gunicorn.service  Gunicorn の systemd ユニット
│   └── nginx-schedule.conf        Nginx リバースプロキシ設定（HTTPS終端）
├── web/
│   ├── index.html        画面
│   ├── manifest.json     PWA設定
│   ├── service-worker.js オフラインキャッシュ
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
