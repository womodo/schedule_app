"""
予定表アプリ サーバー (Flask)

役割:
  1. PWA（web/ 配下）の配信
  2. 認証付き REST API（ログイン / 同期）
  3. SQLite による予定データの保存

起動:
  python app.py                # http://0.0.0.0:8000  （※Service Worker は動きません＝開発用）
  python app.py --ssl          # https://0.0.0.0:8443 （certs/ に証明書があれば使用）

ユーザー追加は manage.py を使ってください。
"""

import argparse
import base64
import csv
import hashlib
import hmac
import io
import json
import os
import re
import sqlite3
import time
import urllib.request
import uuid
from functools import wraps

from flask import Flask, Response, g, jsonify, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

from line_parse import parse_text

# ---- パス設定 -------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.normpath(os.path.join(BASE_DIR, "..", "web"))
DB_PATH = os.environ.get("SCHEDULE_DB", os.path.join(BASE_DIR, "schedule.db"))
SCHEMA_PATH = os.path.join(BASE_DIR, "schema.sql")
SECRET_PATH = os.path.join(BASE_DIR, "secret.key")
CERT_DIR = os.path.join(BASE_DIR, "certs")


def now_ms() -> int:
    return int(time.time() * 1000)


# ---- 永続的な SECRET_KEY（再起動してもセッション維持）---------------------
def load_secret_key() -> bytes:
    if os.path.exists(SECRET_PATH):
        with open(SECRET_PATH, "rb") as f:
            return f.read()
    key = os.urandom(32)
    with open(SECRET_PATH, "wb") as f:
        f.write(key)
    try:
        os.chmod(SECRET_PATH, 0o600)
    except OSError:
        pass  # Windows では無視
    return key


# ---- DB ヘルパ ------------------------------------------------------------
def get_db() -> sqlite3.Connection:
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH, timeout=10)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
        g.db.execute("PRAGMA busy_timeout = 5000")  # 複数ワーカー時のロック待ち
    return g.db


def init_db() -> None:
    con = sqlite3.connect(DB_PATH)
    with open(SCHEMA_PATH, "r", encoding="utf-8") as f:
        con.executescript(f.read())
    # --- マイグレーション（既存DBに不足カラムを追加）---
    ev_cols = [r[1] for r in con.execute("PRAGMA table_info(events)").fetchall()]
    if "tags" not in ev_cols:
        con.execute("ALTER TABLE events ADD COLUMN tags TEXT NOT NULL DEFAULT ''")
    if "participants" not in ev_cols:
        con.execute("ALTER TABLE events ADD COLUMN participants TEXT NOT NULL DEFAULT ''")
    if "private" not in ev_cols:
        con.execute("ALTER TABLE events ADD COLUMN private INTEGER NOT NULL DEFAULT 0")
    user_cols = [r[1] for r in con.execute("PRAGMA table_info(users)").fetchall()]
    if "is_admin" not in user_cols:
        con.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0")
    if "line_user_id" not in user_cols:
        con.execute("ALTER TABLE users ADD COLUMN line_user_id TEXT")
    # 既存イベントで使われているタグをマスタへバックフィル
    seen = {r[0] for r in con.execute("SELECT name FROM tags").fetchall()}
    for (tagstr,) in con.execute("SELECT tags FROM events").fetchall():
        for t in (tagstr or "").split(","):
            t = t.strip()
            if t and t not in seen:
                seen.add(t)
                con.execute(
                    "INSERT INTO tags (id, name, color, created_at) VALUES (?, ?, ?, ?)",
                    (str(uuid.uuid4()), t, "#64748b", now_ms()),
                )
    con.commit()
    con.close()


# タグは内部的にはカンマ区切りで保存（タグ自体に空白は含めない）
def tags_to_list(s):
    return [t for t in (s or "").split(",") if t]


def normalize_tags(value):
    """list / 文字列どちらも受け取り、重複を除いたタグの list を返す。
    文字列はスペース（全角・半角）/ カンマ / 読点で分割する。"""
    if isinstance(value, str):
        value = re.split(r"[\s,、，　]+", value)
    if not value:
        return []
    seen, out = set(), []
    for t in value:
        t = (t or "").strip()
        if t and t.lower() not in seen:
            seen.add(t.lower())
            out.append(t)
    return out


def normalize_ids(value):
    """参加者（ユーザーID または 自由入力の名前）を重複なしの list にする。
    内部保存はカンマ区切りのため、値に含まれるカンマは除去する。"""
    if isinstance(value, str):
        value = value.split(",")
    if not value:
        return []
    seen, out = set(), []
    for v in value:
        v = (v or "").replace(",", "").strip()
        if v and v not in seen:
            seen.add(v)
            out.append(v)
    return out


def register_tags(db, names):
    """イベントに付いた未知のタグをマスタへ自動登録（インライン作成対応）。"""
    for n in names:
        n = n.strip()
        if not n:
            continue
        exists = db.execute("SELECT 1 FROM tags WHERE name = ?", (n,)).fetchone()
        if not exists:
            db.execute(
                "INSERT INTO tags (id, name, color, created_at) VALUES (?, ?, ?, ?)",
                (str(uuid.uuid4()), n, "#64748b", now_ms()),
            )


# ---- Flask アプリ ---------------------------------------------------------
app = Flask(__name__, static_folder=None)
app.config.update(
    SECRET_KEY=load_secret_key(),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    # LAN内では http の場合もあるため Secure は強制しない（HTTPS運用なら True 推奨）
    SESSION_COOKIE_SECURE=False,
    PERMANENT_SESSION_LIFETIME=60 * 60 * 24 * 90,  # 90日
    JSON_AS_ASCII=False,
)


@app.teardown_appcontext
def close_db(exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if "user_id" not in session:
            return jsonify({"error": "unauthorized"}), 401
        return f(*args, **kwargs)

    return wrapper


def current_user():
    uid = session.get("user_id")
    if not uid:
        return None
    return get_db().execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()


def admin_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        u = current_user()
        if u is None:
            return jsonify({"error": "unauthorized"}), 401
        if not u["is_admin"]:
            return jsonify({"error": "forbidden"}), 403
        return f(*args, **kwargs)

    return wrapper


def user_public(row) -> dict:
    return {
        "id": row["id"],
        "username": row["username"],
        "display_name": row["display_name"],
        "color": row["color"],
        "is_admin": bool(row["is_admin"]),
    }


def tag_public(row) -> dict:
    return {"id": row["id"], "name": row["name"], "color": row["color"]}


def all_tags(db):
    rows = db.execute("SELECT * FROM tags ORDER BY name").fetchall()
    return [tag_public(r) for r in rows]


def event_public(row) -> dict:
    return {
        "id": row["id"],
        "title": row["title"],
        "description": row["description"],
        "location": row["location"],
        "start": row["start"],
        "end": row["end"],
        "all_day": bool(row["all_day"]),
        "tags": tags_to_list(row["tags"]),
        "participants": tags_to_list(row["participants"]),
        "private": bool(row["private"]),
        "color": row["color"],
        "owner_id": row["owner_id"],
        "updated_at": row["updated_at"],
        "deleted": bool(row["deleted"]),
    }


# ===========================================================================
# 認証 API
# ===========================================================================
@app.post("/api/login")
def login():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    row = get_db().execute(
        "SELECT * FROM users WHERE username = ?", (username,)
    ).fetchone()
    if row is None or not check_password_hash(row["password_hash"], password):
        return jsonify({"error": "invalid_credentials"}), 401
    session.permanent = True
    session["user_id"] = row["id"]
    return jsonify({"user": user_public(row)})


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.get("/api/me")
def me():
    user = current_user()
    if user is None:
        return jsonify({"error": "unauthorized"}), 401
    return jsonify({"user": user_public(user)})


@app.get("/api/users")
@login_required
def users():
    rows = get_db().execute("SELECT * FROM users ORDER BY display_name").fetchall()
    return jsonify({"users": [user_public(r) for r in rows]})


@app.get("/api/tags")
@login_required
def get_tags():
    return jsonify({"tags": all_tags(get_db())})


# ===========================================================================
# 管理 API（管理者のみ）— ユーザー管理 / タグ管理
# ===========================================================================
@app.get("/api/admin/users")
@admin_required
def admin_list_users():
    rows = get_db().execute("SELECT * FROM users ORDER BY display_name").fetchall()
    return jsonify({"users": [user_public(r) for r in rows]})


@app.post("/api/admin/users")
@admin_required
def admin_create_user():
    db = get_db()
    d = request.get_json(silent=True) or {}
    username = (d.get("username") or "").strip()
    password = d.get("password") or ""
    if not username or not password:
        return jsonify({"error": "username_password_required"}), 400
    try:
        db.execute(
            "INSERT INTO users (id, username, password_hash, display_name, color, is_admin, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                str(uuid.uuid4()),
                username,
                generate_password_hash(password),
                (d.get("display_name") or username).strip(),
                d.get("color") or "#3b82f6",
                1 if d.get("is_admin") else 0,
                now_ms(),
            ),
        )
        db.commit()
    except sqlite3.IntegrityError:
        return jsonify({"error": "username_taken"}), 409
    return jsonify({"ok": True})


@app.put("/api/admin/users/<uid>")
@admin_required
def admin_update_user(uid):
    db = get_db()
    d = request.get_json(silent=True) or {}
    row = db.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
    if row is None:
        return jsonify({"error": "not_found"}), 404
    # 最後の管理者を降格させない
    if row["is_admin"] and not d.get("is_admin"):
        admins = db.execute("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1").fetchone()["n"]
        if admins <= 1:
            return jsonify({"error": "last_admin"}), 400
    db.execute(
        "UPDATE users SET display_name = ?, color = ?, is_admin = ? WHERE id = ?",
        (
            (d.get("display_name") or row["display_name"]).strip(),
            d.get("color") or row["color"],
            1 if d.get("is_admin") else 0,
            uid,
        ),
    )
    if d.get("password"):
        db.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (generate_password_hash(d["password"]), uid),
        )
    db.commit()
    return jsonify({"ok": True})


@app.delete("/api/admin/users/<uid>")
@admin_required
def admin_delete_user(uid):
    db = get_db()
    if uid == session["user_id"]:
        return jsonify({"error": "cannot_delete_self"}), 400
    row = db.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
    if row is None:
        return jsonify({"error": "not_found"}), 404
    db.execute("DELETE FROM users WHERE id = ?", (uid,))
    db.commit()
    return jsonify({"ok": True})


@app.post("/api/admin/tags")
@admin_required
def admin_create_tag():
    db = get_db()
    d = request.get_json(silent=True) or {}
    name = (d.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name_required"}), 400
    try:
        db.execute(
            "INSERT INTO tags (id, name, color, created_at) VALUES (?, ?, ?, ?)",
            (str(uuid.uuid4()), name, d.get("color") or "#64748b", now_ms()),
        )
        db.commit()
    except sqlite3.IntegrityError:
        return jsonify({"error": "tag_exists"}), 409
    return jsonify({"ok": True})


@app.put("/api/admin/tags/<tid>")
@admin_required
def admin_update_tag(tid):
    db = get_db()
    d = request.get_json(silent=True) or {}
    row = db.execute("SELECT * FROM tags WHERE id = ?", (tid,)).fetchone()
    if row is None:
        return jsonify({"error": "not_found"}), 404
    new_name = (d.get("name") or row["name"]).strip()
    new_color = d.get("color") or row["color"]
    old_name = row["name"]
    try:
        db.execute("UPDATE tags SET name = ?, color = ? WHERE id = ?", (new_name, new_color, tid))
    except sqlite3.IntegrityError:
        return jsonify({"error": "tag_exists"}), 409
    # リネーム時は既存の予定のタグも書き換える（同期で各端末へ反映）
    if new_name != old_name:
        for ev in db.execute("SELECT id, tags FROM events").fetchall():
            lst = tags_to_list(ev["tags"])
            if old_name in lst:
                lst = list(dict.fromkeys(new_name if t == old_name else t for t in lst))
                db.execute(
                    "UPDATE events SET tags = ?, updated_at = ? WHERE id = ?",
                    (",".join(lst), now_ms(), ev["id"]),
                )
    db.commit()
    return jsonify({"ok": True})


@app.delete("/api/admin/tags/<tid>")
@admin_required
def admin_delete_tag(tid):
    db = get_db()
    db.execute("DELETE FROM tags WHERE id = ?", (tid,))
    db.commit()
    return jsonify({"ok": True})


@app.get("/api/admin/events.csv")
@admin_required
def admin_events_csv():
    db = get_db()
    names = {u["id"]: u["display_name"] for u in db.execute("SELECT id, display_name FROM users")}
    rows = db.execute(
        "SELECT * FROM events WHERE deleted = 0 ORDER BY start"
    ).fetchall()

    buf = io.StringIO()
    buf.write("﻿")  # Excel 用 BOM（UTF-8）
    w = csv.writer(buf)
    w.writerow(["開始", "終了", "終日", "タイトル", "場所", "タグ", "参加者", "公開設定", "作成者", "メモ"])
    for r in rows:
        participants = " ".join(
            names.get(pid, pid) for pid in tags_to_list(r["participants"])
        )
        w.writerow([
            r["start"] or "",
            r["end"] or "",
            "○" if r["all_day"] else "",
            r["title"],
            r["location"] or "",
            " ".join(tags_to_list(r["tags"])),
            participants,
            "非公開" if r["private"] else "公開",
            names.get(r["owner_id"], ""),
            (r["description"] or "").replace("\r\n", "\n"),
        ])

    fname = f"schedule_{time.strftime('%Y%m%d')}.csv"
    return Response(
        buf.getvalue(),
        mimetype="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


# ===========================================================================
# LINE から予定を追加する Webhook
#   ※ LINE が外部から到達できる公開HTTPS（有効なCA証明書）が必要。
#     例: Cloudflare Tunnel で /api/line/webhook を公開し、LINE の Webhook URL に設定。
# ===========================================================================
LINE_CONFIG_PATH = os.path.join(BASE_DIR, "line_config.json")
LINE_REPLY_URL = "https://api.line.me/v2/bot/message/reply"
LINE_HELP = (
    "予定の追加例:\n"
    "・明日 15:00 歯医者\n"
    "・6/10 9時 会議 ＠渋谷 #仕事\n"
    "・6月10日 終日 運動会\n"
    "・来週月曜 10時半 打合せ\n"
    "・12/24 18:00〜21:00 パーティー\n\n"
    "場所は ＠ か「場所:」、タグは #、で指定できます。"
)


def load_line_config():
    cfg = {}
    if os.path.exists(LINE_CONFIG_PATH):
        try:
            with open(LINE_CONFIG_PATH, encoding="utf-8") as f:
                cfg = json.load(f)
        except Exception:
            cfg = {}
    token = cfg.get("channel_access_token") or os.environ.get("LINE_CHANNEL_ACCESS_TOKEN")
    secret = cfg.get("channel_secret") or os.environ.get("LINE_CHANNEL_SECRET")
    return token, secret


def line_reply(token, reply_token, text):
    if not token or not reply_token:
        return
    req = urllib.request.Request(
        LINE_REPLY_URL,
        data=json.dumps({"replyToken": reply_token, "messages": [{"type": "text", "text": text}]}).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=5)
    except Exception as e:  # 返信失敗はログのみ（Webhook自体は200を返す）
        app.logger.warning("LINE reply failed: %s", e)


def _fmt_when(p):
    from datetime import date as _date

    ds = p["start"][:10]
    y, m, dd = (int(x) for x in ds.split("-"))
    wd = ["月", "火", "水", "木", "金", "土", "日"][_date(y, m, dd).weekday()]
    base = f"{m}月{dd}日({wd})"
    if p["all_day"]:
        return base + " 終日"
    t = p["start"][11:16]
    if p.get("end"):
        t += "〜" + p["end"][11:16]
    return base + " " + t


def _handle_line_event(ev, token):
    if ev.get("type") != "message" or ev.get("message", {}).get("type") != "text":
        return
    reply_token = ev.get("replyToken")
    text = (ev["message"]["text"] or "").strip()
    user_id = (ev.get("source") or {}).get("userId")
    db = get_db()

    urow = None
    if user_id:
        urow = db.execute("SELECT * FROM users WHERE line_user_id = ?", (user_id,)).fetchone()

    norm = text.replace("　", " ")
    low = norm.lower()

    # ヘルプ
    if norm in ("ヘルプ", "使い方", "？", "?") or low == "help":
        line_reply(token, reply_token, LINE_HELP)
        return

    # アカウント連携: 「連携 ユーザーID パスワード」
    if norm.startswith("連携") or low.startswith("link"):
        parts = norm.split()
        if len(parts) >= 3:
            u = db.execute("SELECT * FROM users WHERE username = ?", (parts[1],)).fetchone()
            if u and check_password_hash(u["password_hash"], parts[2]):
                db.execute("UPDATE users SET line_user_id = ? WHERE id = ?", (user_id, u["id"]))
                db.commit()
                line_reply(token, reply_token, f"✅ 連携しました（{u['display_name']}）。\n\n" + LINE_HELP)
            else:
                line_reply(token, reply_token, "❌ ユーザーIDかパスワードが違います。")
        else:
            line_reply(token, reply_token, "連携の形式:\n連携 ユーザーID パスワード")
        return

    # 未連携
    if urow is None:
        line_reply(token, reply_token, "未連携です。最初に次の形式で連携してください:\n連携 ユーザーID パスワード")
        return

    # 予定として解析して登録
    p = parse_text(text)
    if not p:
        line_reply(token, reply_token, "予定を読み取れませんでした。\n\n" + LINE_HELP)
        return

    tag_list = normalize_tags(p["tags"])
    register_tags(db, tag_list)
    db.execute(
        "INSERT INTO events (id, title, description, location, start, end, all_day,"
        " tags, participants, private, color, owner_id, updated_at, deleted)"
        " VALUES (?, ?, '', ?, ?, ?, ?, ?, '', 0, NULL, ?, ?, 0)",
        (
            str(uuid.uuid4()),
            p["title"],
            p["location"],
            p["start"],
            p["end"],
            1 if p["all_day"] else 0,
            ",".join(tag_list),
            urow["id"],
            now_ms(),
        ),
    )
    db.commit()

    msg = f"✅ 追加しました\n{_fmt_when(p)} {p['title']}"
    if p["location"]:
        msg += f"\n📍{p['location']}"
    if tag_list:
        msg += "\n#" + " #".join(tag_list)
    line_reply(token, reply_token, msg)


@app.post("/api/line/webhook")
def line_webhook():
    token, secret = load_line_config()
    body = request.get_data()
    # 署名検証（channel_secret 設定時）
    if secret:
        mac = base64.b64encode(
            hmac.new(secret.encode("utf-8"), body, hashlib.sha256).digest()
        ).decode()
        if not hmac.compare_digest(mac, request.headers.get("X-Line-Signature", "")):
            return "bad signature", 400
    try:
        data = json.loads(body or b"{}")
    except Exception:
        data = {}
    for ev in data.get("events", []):
        try:
            _handle_line_event(ev, token)
        except Exception as e:
            app.logger.warning("LINE event error: %s", e)
    return "OK", 200  # LINE には常に200を返す


# ===========================================================================
# 同期 API（オフライン対応の心臓部）
#   - クライアントは溜まった変更(changes)を push し、
#   - since 以降にサーバー側で更新された予定を pull する。
#   - 競合は updated_at による Last-Write-Wins。
# ===========================================================================
@app.post("/api/sync")
@login_required
def sync():
    db = get_db()
    me_id = session["user_id"]
    data = request.get_json(silent=True) or {}
    since = int(data.get("since") or 0)
    changes = data.get("changes") or []

    applied = []
    for ev in changes:
        ev_id = ev.get("id") or str(uuid.uuid4())
        incoming_ts = int(ev.get("updated_at") or now_ms())
        existing = db.execute("SELECT * FROM events WHERE id = ?", (ev_id,)).fetchone()

        # Last-Write-Wins: サーバー側が新しければスキップ
        if existing is not None and existing["updated_at"] > incoming_ts:
            continue

        owner_id = existing["owner_id"] if existing is not None else me_id
        tag_list = normalize_tags(ev.get("tags"))
        part_list = normalize_ids(ev.get("participants"))
        if not ev.get("deleted"):
            register_tags(db, tag_list)  # 新しいタグはマスタへ自動登録
        db.execute(
            """
            INSERT INTO events
                (id, title, description, location, start, end, all_day,
                 tags, participants, private, color, owner_id, updated_at, deleted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                title=excluded.title, description=excluded.description,
                location=excluded.location, start=excluded.start, end=excluded.end,
                all_day=excluded.all_day, tags=excluded.tags,
                participants=excluded.participants, private=excluded.private,
                color=excluded.color, updated_at=excluded.updated_at, deleted=excluded.deleted
            """,
            (
                ev_id,
                (ev.get("title") or "").strip() or "(無題)",
                ev.get("description") or "",
                ev.get("location") or "",
                ev.get("start") or "",
                ev.get("end"),
                1 if ev.get("all_day") else 0,
                ",".join(tag_list),
                ",".join(part_list),
                1 if ev.get("private") else 0,
                ev.get("color"),
                owner_id,
                incoming_ts,
                1 if ev.get("deleted") else 0,
            ),
        )
        applied.append(ev_id)

    db.commit()

    # pull: since 以降に更新された予定を返す。
    #   非公開(private)の予定は「作成者 or 参加者」だけに本体を返し、
    #   それ以外の人には削除マーカー（tombstone）を返してキャッシュから消させる。
    rows = db.execute(
        "SELECT * FROM events WHERE updated_at > ? ORDER BY updated_at", (since,)
    ).fetchall()
    events_out = []
    for r in rows:
        if r["private"] and r["owner_id"] != me_id and me_id not in tags_to_list(r["participants"]):
            events_out.append({"id": r["id"], "deleted": True, "updated_at": r["updated_at"]})
        else:
            events_out.append(event_public(r))

    user_rows = db.execute("SELECT * FROM users").fetchall()

    return jsonify(
        {
            "events": events_out,
            "users": [user_public(r) for r in user_rows],
            "tags": all_tags(db),
            "applied": applied,
            "server_time": now_ms(),
        }
    )


# ===========================================================================
# PWA / 静的ファイル配信
# ===========================================================================
@app.get("/")
def index():
    return send_from_directory(WEB_DIR, "index.html")


@app.get("/service-worker.js")
def service_worker():
    # SW をルートスコープで配信（アプリ全体を制御させるため）
    resp = send_from_directory(WEB_DIR, "service-worker.js")
    resp.headers["Service-Worker-Allowed"] = "/"
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/manifest.json")
def manifest():
    return send_from_directory(WEB_DIR, "manifest.json")


@app.get("/<path:filename>")
def static_files(filename):
    # /api/* は上の専用ルートが優先されるため、ここには来ない
    return send_from_directory(WEB_DIR, filename)


# ===========================================================================
# 起動
# ===========================================================================
def build_ssl_context(use_ssl: bool):
    cert = os.path.join(CERT_DIR, "cert.pem")
    key = os.path.join(CERT_DIR, "key.pem")
    if use_ssl and os.path.exists(cert) and os.path.exists(key):
        return (cert, key)
    if use_ssl:
        print("[!] certs/cert.pem, certs/key.pem が見つかりません。adhoc 証明書を使います。")
        return "adhoc"  # pyopenssl が必要。無ければ下で例外 → HTTP にフォールバック
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int)
    parser.add_argument("--ssl", action="store_true", help="HTTPS で起動（Service Worker に必須）")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    init_db()

    ssl_ctx = build_ssl_context(args.ssl)
    port = args.port or (8443 if ssl_ctx else 8000)
    scheme = "https" if ssl_ctx else "http"
    print(f"[*] 予定表アプリ起動: {scheme}://{args.host}:{port}  (DB: {DB_PATH})")
    if not ssl_ctx:
        print("[!] HTTP モードです。スマホ等から Service Worker を使うには --ssl で HTTPS 化してください。")

    try:
        app.run(host=args.host, port=port, debug=args.debug, ssl_context=ssl_ctx)
    except Exception as e:
        if ssl_ctx == "adhoc":
            print(f"[!] adhoc 証明書に失敗（pyopenssl 未導入）: {e}\n    HTTP で再起動します。")
            app.run(host=args.host, port=args.port or 8000, debug=args.debug)
        else:
            raise


if __name__ == "__main__":
    main()
