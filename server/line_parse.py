"""
LINE のメッセージ文から予定（イベント）を解析する簡易パーサー。

対応例:
  明日 15:00 歯医者
  6/10 9時 会議 ＠渋谷 #仕事
  6月10日 終日 運動会
  来週月曜 10時半 打合せ
  2026/12/24 18:00〜21:00 パーティー

戻り値: {title, start, end, all_day, location, tags} または None（日付が読めない場合）
"""

import re
from datetime import date, timedelta

# 全角→半角（数字・コロン・スラッシュ・スペース）
_ZEN = str.maketrans("０１２３４５６７８９：／　", "0123456789:/ ")
_WD = {"月": 0, "火": 1, "水": 2, "木": 3, "金": 4, "土": 5, "日": 6}
# 時刻: (午前/午後)? H (:MM | 時(半|MM分)?)   ※ 単独の数字は時刻扱いしない
_TIME = re.compile(r"(午前|午後)?\s*(\d{1,2})(?::(\d{2})|時(半|(\d{1,2})分)?)")


def _hhmm(m):
    ampm, h = m.group(1), int(m.group(2))
    if m.group(3) is not None:
        mi = int(m.group(3))
    elif m.group(4) == "半":
        mi = 30
    elif m.group(5):
        mi = int(m.group(5))
    else:
        mi = 0
    if ampm == "午後" and h < 12:
        h += 12
    if ampm == "午前" and h == 12:
        h = 0
    if h > 23 or mi > 59:
        return None
    return f"{h:02d}:{mi:02d}"


def parse_text(text, today=None):
    if today is None:
        today = date.today()
    s = (text or "").translate(_ZEN).strip()
    if not s:
        return None

    # 場所（場所:〜 / ＠〜 / @〜）
    location = ""
    m = re.search(r"(?:場所[:：]\s*|[@＠])(\S+)", s)
    if m:
        location = m.group(1)
        s = s[: m.start()] + " " + s[m.end():]

    # タグ（#〜）
    tags = re.findall(r"#(\S+)", s)
    if tags:
        s = re.sub(r"#\S+", " ", s)

    # 終日マーカー
    s = re.sub(r"終日|全日", " ", s)

    # 日付
    d = None

    def cut(a, b):
        nonlocal s
        s = s[:a] + " " + s[b:]

    if "今日" in s:
        d = today
        s = s.replace("今日", " ", 1)
    elif re.search(r"明後日|あさって", s):
        d = today + timedelta(days=2)
        s = re.sub(r"明後日|あさって", " ", s, count=1)
    elif re.search(r"明日|あした|あす", s):
        d = today + timedelta(days=1)
        s = re.sub(r"明日|あした|あす", " ", s, count=1)
    else:
        m = re.search(r"(\d{4})[/-](\d{1,2})[/-](\d{1,2})", s)
        if m:
            try:
                d = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            except ValueError:
                d = None
            cut(m.start(), m.end())
        else:
            m = re.search(r"(\d{1,2})\s*[/月]\s*(\d{1,2})\s*日?", s)
            if m:
                try:
                    d = date(today.year, int(m.group(1)), int(m.group(2)))
                    if d < today:  # 年省略で過去日なら翌年扱い
                        d = date(today.year + 1, int(m.group(1)), int(m.group(2)))
                except ValueError:
                    d = None
                cut(m.start(), m.end())
            else:
                m = re.search(r"(来週)?\s*([月火水木金土日])曜日?", s)
                if m:
                    delta = (_WD[m.group(2)] - today.weekday()) % 7
                    if delta == 0:
                        delta = 7  # 同じ曜日なら次回
                    if m.group(1):
                        delta += 7  # 来週
                    d = today + timedelta(days=delta)
                    cut(m.start(), m.end())

    if d is None:
        return None

    # 時刻（最大2つ：開始・終了）
    times = []
    for tm in _TIME.finditer(s):
        hhmm = _hhmm(tm)
        if hhmm:
            times.append((tm.start(), tm.end(), hhmm))
    for a, b, _ in sorted(times, key=lambda x: -x[0]):
        s = s[:a] + " " + s[b:]

    all_day = len(times) == 0
    start_t = times[0][2] if times else None
    end_t = times[1][2] if len(times) > 1 else None

    title = re.sub(r"\s+", " ", s).strip(" 　-–—:〜～~")
    if not title:
        title = "予定"

    iso = d.isoformat()
    if all_day:
        start, end = iso, None
    else:
        start = f"{iso}T{start_t}"
        end = f"{iso}T{end_t}" if end_t else None

    return {
        "title": title,
        "start": start,
        "end": end,
        "all_day": all_day,
        "location": location,
        "tags": tags,
    }
