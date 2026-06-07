"""
管理用CLI（ユーザー追加・一覧・パスワード変更）

使い方:
  python manage.py initdb
  python manage.py adduser <username> <password> [表示名] [色#RRGGBB]
  python manage.py listusers
  python manage.py passwd <username> <new_password>
  python manage.py setadmin <username> [0|1]      # 管理者フラグ設定（既定1）
  python manage.py deluser <username>

※ 最初に作成したユーザーは自動的に管理者になります。
"""

import sqlite3
import sys
import time
import uuid

from werkzeug.security import generate_password_hash

from app import DB_PATH, init_db as _init_db

PALETTE = ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#14b8a6"]


def con():
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    return c


def initdb():
    _init_db()  # スキーマ作成＋マイグレーション
    print(f"[*] DB 初期化完了: {DB_PATH}")


def adduser(username, password, display_name=None, color=None):
    initdb()
    c = con()
    count = c.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]
    color = color or PALETTE[count % len(PALETTE)]
    is_admin = 1 if count == 0 else 0  # 最初のユーザーは管理者
    try:
        c.execute(
            "INSERT INTO users (id, username, password_hash, display_name, color, is_admin, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                str(uuid.uuid4()),
                username,
                generate_password_hash(password),
                display_name or username,
                color,
                is_admin,
                int(time.time() * 1000),
            ),
        )
        c.commit()
        admin_note = "（管理者）" if is_admin else ""
        print(f"[*] ユーザー作成: {username} (表示名={display_name or username}, 色={color}){admin_note}")
    except sqlite3.IntegrityError:
        print(f"[!] ユーザー '{username}' は既に存在します。")
    c.close()


def setadmin(username, flag="1"):
    c = con()
    cur = c.execute(
        "UPDATE users SET is_admin = ? WHERE username = ?",
        (1 if str(flag) not in ("0", "false", "False") else 0, username),
    )
    c.commit()
    print("[*] 設定しました。" if cur.rowcount else f"[!] '{username}' が見つかりません。")
    c.close()


def listusers():
    c = con()
    rows = c.execute(
        "SELECT username, display_name, color, is_admin FROM users ORDER BY display_name"
    ).fetchall()
    if not rows:
        print("(ユーザーなし)")
    for r in rows:
        adm = "[管理者]" if r["is_admin"] else ""
        print(f"  {r['username']:<15} {r['display_name']:<15} {r['color']} {adm}")
    c.close()


def passwd(username, new_password):
    c = con()
    cur = c.execute(
        "UPDATE users SET password_hash = ? WHERE username = ?",
        (generate_password_hash(new_password), username),
    )
    c.commit()
    print("[*] 変更しました。" if cur.rowcount else f"[!] '{username}' が見つかりません。")
    c.close()


def deluser(username):
    c = con()
    cur = c.execute("DELETE FROM users WHERE username = ?", (username,))
    c.commit()
    print("[*] 削除しました。" if cur.rowcount else f"[!] '{username}' が見つかりません。")
    c.close()


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(0)
    cmd, rest = args[0], args[1:]
    funcs = {
        "initdb": initdb,
        "adduser": adduser,
        "listusers": listusers,
        "passwd": passwd,
        "setadmin": setadmin,
        "deluser": deluser,
    }
    if cmd not in funcs:
        print(__doc__)
        sys.exit(1)
    try:
        funcs[cmd](*rest)
    except TypeError:
        print("[!] 引数が不正です。\n" + __doc__)
        sys.exit(1)
