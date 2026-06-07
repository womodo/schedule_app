"""
Gunicorn 用の WSGI エントリポイント。

起動例:
  gunicorn -c gunicorn.conf.py wsgi:app
  （または）gunicorn -w 2 -b 127.0.0.1:5001 wsgi:app

Nginx を HTTPS 終端のリバースプロキシにし、Gunicorn は 127.0.0.1:5001 で待ち受ける想定。
"""

from werkzeug.middleware.proxy_fix import ProxyFix

from app import app, init_db

# DB 作成＋マイグレーション（起動時に1回）
init_db()

# Nginx からの X-Forwarded-* を信頼し、scheme/host を正しく扱う
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

# 本番は HTTPS（Nginx 終端）前提なので Secure Cookie を有効化
app.config["SESSION_COOKIE_SECURE"] = True

if __name__ == "__main__":
    app.run()
