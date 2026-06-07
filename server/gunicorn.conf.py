# Gunicorn 設定（予定表アプリ）
# 起動: .venv/bin/gunicorn -c gunicorn.conf.py wsgi:app

bind = "127.0.0.1:5001"   # Nginx からプロキシされる内部ポート
workers = 2               # ラズパイなら 2 程度で十分（CPUコア数に応じて調整）
threads = 2
timeout = 30

# master で1回だけ app を import（secret.key 生成や init_db の競合を防ぐ）
preload_app = True

# ログは journald に流す（systemd 経由）
accesslog = "-"
errorlog = "-"
loglevel = "info"
