"""
Gunicorn 用の WSGI エントリポイント。

起動例:
  gunicorn -c gunicorn.conf.py wsgi:app
  （または）gunicorn -w 2 -b 127.0.0.1:5001 wsgi:app

構成: Tailscale serve(HTTPS終端) → nginx:80 → Gunicorn 127.0.0.1:5001。
nginx は `location /schedule/ { proxy_pass http://127.0.0.1:5001/; }` で /schedule を
剥がして転送するため、Flask 側のルートは `/`・`/api/*` のままで動く（deploy/nginx-schedule.conf）。
"""

from werkzeug.middleware.proxy_fix import ProxyFix

from app import app, init_db

# DB 作成＋マイグレーション（起動時に1回）
init_db()

# nginx からの X-Forwarded-* を信頼し、scheme/host を正しく扱う
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

# 本番は HTTPS（Tailscale serve 終端）前提なので Secure Cookie を有効化
app.config["SESSION_COOKIE_SECURE"] = True

# Cookie を /schedule に限定し、同一ホストの他アプリ(study/wbgt/stats)と共有しない。
# ブラウザは /schedule/ 配下にいるため、この path 制約でも問題なく送出される。
app.config["SESSION_COOKIE_PATH"] = "/schedule"

if __name__ == "__main__":
    app.run()
