"""
前日 6:00 に「翌日の予定」を LINE へ通知するスクリプト（予定がある場合のみ送信）。

通知方法: LINE Messaging API（公式アカウント）。
  ※ LINE Notify は 2025/3 で終了したため使用しません。

設定: server/line_config.json（無ければ環境変数）を読みます。
  {
    "channel_access_token": "（Messaging API のチャネルアクセストークン）",
    "to": [],            // 全体送信時の宛先。空 = 友だち全員へブロードキャスト
                         // ["Uxxxx...", "Cxxxx..."] = 指定ユーザー/グループへ送信(multicast)
    "per_user": false    // true = 予定がある人(作成者/参加者)だけに各自の予定を個別送信
  }
  環境変数の場合: LINE_CHANNEL_ACCESS_TOKEN, LINE_TO（カンマ区切り）, LINE_PER_USER（1/true）

モード:
  - 全体（既定）: 翌日の公開予定をまとめて broadcast / multicast。
  - per-user    : 各ユーザーの line_user_id 宛に、その人が作成者または参加者の予定だけを
                  push 送信（予定が無い人には送らない）。本人宛なので非公開予定も含む。
                  各自はトークの「連携 ユーザーID パスワード」で line_user_id を登録しておく。

使い方:
  python notify_line.py                 # 翌日の予定を通知（無ければ何もしない）
  python notify_line.py --dry-run       # 送信せずメッセージを表示（動作確認）
  python notify_line.py --per-user      # 予定がある人にのみ個別送信（設定 per_user より優先）
  python notify_line.py --date 2026-06-07   # 指定日の予定を通知（テスト用）

cron 例（毎朝6:00・JST想定）:
  0 6 * * *  cd /home/pi/apps/schedule/server && .venv/bin/python notify_line.py >> notify.log 2>&1
"""

import argparse
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo("Asia/Tokyo")
except Exception:  # tzdata が無い等の場合はローカル時刻にフォールバック
    TZ = None

from app import DB_PATH

try:  # Windows コンソール等でも絵文字・日本語を表示できるように
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "line_config.json")
WD = ["月", "火", "水", "木", "金", "土", "日"]  # date.weekday(): 月=0 .. 日=6
LINE_API = "https://api.line.me/v2/bot/message/"


# ---- 設定読み込み ---------------------------------------------------------
def load_config():
    cfg = {}
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, encoding="utf-8") as f:
            cfg = json.load(f)
    token = cfg.get("channel_access_token") or os.environ.get("LINE_CHANNEL_ACCESS_TOKEN")
    to = cfg.get("to")
    if to is None:
        env_to = os.environ.get("LINE_TO", "")
        to = [x.strip() for x in env_to.split(",") if x.strip()]
    per_user = cfg.get("per_user")
    if per_user is None:
        per_user = os.environ.get("LINE_PER_USER", "").lower() in ("1", "true", "yes")
    return token, to, bool(per_user)


# ---- 対象日と予定の取得 ---------------------------------------------------
def target_date(arg_date):
    if arg_date:
        return datetime.strptime(arg_date, "%Y-%m-%d").date()
    now = datetime.now(TZ) if TZ else datetime.now()
    return (now + timedelta(days=1)).date()  # 「前日」に実行 → 対象は翌日


def parse_participants(s):
    return [x.strip() for x in (s or "").split(",") if x.strip()]


def fetch_events(ds):
    """指定日に重なる削除済みでない予定（非公開も含む）と、ユーザー一覧を返す。
    非公開の除外は呼び出し側で行う（per-user では本人宛に含めるため）。"""
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    rows = con.execute("SELECT * FROM events WHERE deleted = 0").fetchall()
    user_rows = con.execute(
        "SELECT id, display_name, line_user_id FROM users"
    ).fetchall()
    con.close()

    items = []
    for r in rows:
        s = (r["start"] or "")[:10]
        e = (r["end"] or r["start"] or "")[:10] or s
        if s <= ds <= e:
            items.append(r)

    def sort_key(r):
        timed = not r["all_day"] and r["start"] and len(r["start"]) > 10
        return (0 if not timed else 1, r["start"][11:16] if timed else "")

    items.sort(key=sort_key)
    return items, user_rows


def build_message(date_obj, items, users):
    header = f"📅 明日 {date_obj.month}月{date_obj.day}日({WD[date_obj.weekday()]}) の予定\n"
    lines = []
    for r in items:
        timed = not r["all_day"] and r["start"] and len(r["start"]) > 10
        when = r["start"][11:16] if timed else "終日"
        line = f"・{when} {r['title']}"
        if r["end"] and len(r["end"]) > 10 and timed:
            line += f"〜{r['end'][11:16]}"
        if r["location"]:
            line += f"（{r['location']}）"
        owner = users.get(r["owner_id"])
        if owner:
            line += f" [{owner}]"
        lines.append(line)
    return header + "\n" + "\n".join(lines)


# ---- LINE 送信 ------------------------------------------------------------
def line_post(path, token, payload):
    req = urllib.request.Request(
        LINE_API + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as res:
            return res.status, res.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def send(token, to, text):
    messages = [{"type": "text", "text": text}]
    if to:  # 指定宛先 → multicast（最大500件）
        return line_post("multicast", token, {"to": to, "messages": messages})
    # 宛先未指定 → 友だち全員へブロードキャスト
    return line_post("broadcast", token, {"messages": messages})


def send_per_user(token, d, items, user_rows, name_map, dry_run):
    """各ユーザーに、その人が作成者または参加者の予定だけを push 送信。
    予定が無い人には送らない。非公開予定も本人宛なので含む。"""
    linked = [u for u in user_rows if (u["line_user_id"] or "").strip()]
    targets = 0
    sent = 0
    for u in linked:
        uid = u["id"]
        mine = [
            r for r in items
            if r["owner_id"] == uid or uid in parse_participants(r["participants"])
        ]
        if not mine:
            continue
        targets += 1
        text = build_message(d, mine, name_map)
        if dry_run:
            print(f"---- {u['display_name']} ({u['line_user_id']}) ----")
            print(text)
            print()
            continue
        status, body = line_post(
            "push", token,
            {"to": u["line_user_id"], "messages": [{"type": "text", "text": text}]},
        )
        ok = status == 200
        print(f"  -> {u['display_name']} status={status} {'OK' if ok else body}")
        if ok:
            sent += 1
    return targets, sent


# ---- メイン ---------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", help="対象日 YYYY-MM-DD（省略時は翌日）")
    ap.add_argument("--dry-run", action="store_true", help="送信せず表示のみ")
    ap.add_argument("--per-user", action="store_true",
                    help="予定がある人(作成者/参加者)にのみ各自の予定を個別送信")
    args = ap.parse_args()

    token, to, cfg_per_user = load_config()
    per_user = args.per_user or cfg_per_user

    d = target_date(args.date)
    ds = d.isoformat()
    items, user_rows = fetch_events(ds)
    name_map = {u["id"]: u["display_name"] for u in user_rows}
    now = datetime.now()

    if per_user:
        if not args.dry_run and not token:
            print("[!] channel_access_token が未設定です（line_config.json か LINE_CHANNEL_ACCESS_TOKEN）。")
            sys.exit(1)
        targets, sent = send_per_user(token, d, items, user_rows, name_map, args.dry_run)
        if args.dry_run:
            print(f"[dry-run] {ds} per-user 対象 {targets} 人")
            return
        print(f"[{now:%Y-%m-%d %H:%M}] {ds} per-user 送信: 対象{targets}人 成功{sent}人")
        if targets and sent < targets:
            sys.exit(1)
        return

    # ---- 全体モード（既定）: 公開予定のみをまとめて送信 ----
    pub = [r for r in items if not r["private"]]
    if not pub:
        print(f"[{now:%Y-%m-%d %H:%M}] {ds} の予定なし → 通知しません")
        return

    text = build_message(d, pub, name_map)

    if args.dry_run:
        print("---- 送信内容（dry-run）----")
        print(text)
        return

    if not token:
        print("[!] channel_access_token が未設定です（line_config.json か LINE_CHANNEL_ACCESS_TOKEN）。")
        sys.exit(1)

    status, body = send(token, to, text)
    ok = status == 200
    print(f"[{now:%Y-%m-%d %H:%M}] {ds} {len(pub)}件 送信 status={status} {'OK' if ok else body}")
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
