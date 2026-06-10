/* app.js — UI とアプリの起動制御。 */

const state = {
  user: null,
  users: {},               // id -> user
  year: 0,
  month: 0,                // 0-11
  events: [],
  editingId: null,
  view: "month",           // 'month' | 'list'
  listMode: "month",       // 一覧の表示単位: 'day' | 'month' | 'range'
  listDay: "",             // 日単位表示の対象日 (YYYY-MM-DD)
  rangeFrom: "",
  rangeTo: "",
  search: "",
  hiddenUsers: new Set(),  // 表示を消している人の id
  tags: [],                // タグマスタ [{id,name,color}]
};

const WD = ["日", "月", "火", "水", "木", "金", "土"];
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, "0");
const todayStr = () => isoDate(new Date());
function isoDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function startDate(ev) { return (ev.start || "").slice(0, 10); }
function endDate(ev) { return (ev.end || ev.start || "").slice(0, 10) || startDate(ev); }
function monthRange(y, m) {
  return [`${y}-${pad(m + 1)}-01`, isoDate(new Date(y, m + 1, 0))];
}
function fmtDay(ds) {
  const d = new Date(ds + "T00:00");
  return `${d.getMonth() + 1}月${d.getDate()}日(${WD[d.getDay()]})`;
}
// ヘッダー用の日ラベル（年付きのフル表示）
function dayLabel(ds) {
  const d = new Date(ds + "T00:00");
  return `${d.getFullYear()}年${fmtDay(ds)}`;
}
function uuid() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
}

// 左右スワイプ検出（縦スクロールとは干渉しない）。dir: 左=+1 / 右=-1
function bindSwipe(el, onSwipe) {
  let x0 = null, y0 = 0, t0 = 0;
  el.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) { x0 = null; return; }
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
    t0 = Date.now();
  }, { passive: true });
  el.addEventListener("touchend", (e) => {
    if (x0 === null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0;
    x0 = null;
    // 速さ・距離・横方向が十分なときだけスワイプとみなす
    if (Date.now() - t0 > 600) return;
    if (Math.abs(dx) < 60) return;
    if (Math.abs(dx) < Math.abs(dy) * 1.5) return;
    onSwipe(dx < 0 ? 1 : -1);
  }, { passive: true });
}

// ===========================================================================
// 起動
// ===========================================================================
async function start() {
  cleanupServiceWorker();
  Sync.onChange(updateSyncStatus);
  Sync.start();

  const now = new Date();
  state.year = now.getFullYear();
  state.month = now.getMonth();
  state.listDay = todayStr();

  bindUI();

  state.user = await DB.getMeta("currentUser");
  const cachedUsers = (await DB.getMeta("users")) || [];
  cachedUsers.forEach((u) => (state.users[u.id] = u));
  state.tags = (await DB.getMeta("tags")) || [];

  if (state.user) {
    state.users[state.user.id] = state.user;
    showApp();
    await loadEvents();
    Sync.run().then(afterSync).catch(() => {});
  } else {
    try {
      const { user } = await API.me();
      await onLoggedIn(user);
    } catch (e) {
      showLogin();
    }
  }
}

// Service Worker は廃止。過去に登録された SW を解除し、PWAキャッシュを削除する。
function cleanupServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .getRegistrations()
      .then((regs) => regs.forEach((r) => r.unregister()))
      .catch(() => {});
  }
  if (self.caches && caches.keys) {
    caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
  }
}

// ===========================================================================
// 認証フロー
// ===========================================================================
function showLogin() {
  $("login-screen").hidden = false;
  $("app-screen").hidden = true;
  $("admin-screen").hidden = true;
}
function showApp() {
  $("login-screen").hidden = true;
  $("admin-screen").hidden = true;
  $("app-screen").hidden = false;
  if (state.user) {
    $("menu-user").textContent =
      state.user.display_name + (state.user.is_admin ? "（管理者）" : "");
    $("menu-admin").hidden = !state.user.is_admin;
  }
  render();
}

async function onLoggedIn(user) {
  state.user = user;
  state.users[user.id] = user;
  await DB.setMeta("currentUser", user);
  showApp();
  await loadEvents();
  Sync.run().then(afterSync).catch(() => {});
}

async function afterSync(res) {
  if (!res) return;
  (res.users || []).forEach((u) => (state.users[u.id] = u));
  if (res.tags) state.tags = res.tags;
  await loadEvents();
}

// ===========================================================================
// データ
// ===========================================================================
async function loadEvents() {
  state.events = await DB.getAllEvents();
  render();
}

function eventColor(ev) {
  if (ev.color) return ev.color;
  const owner = state.users[ev.owner_id];
  return (owner && owner.color) || "#2563eb";
}

// ---- 予定バーの濃淡（終日=濃い目／それ以外=薄目） ----
function hexToRgb(hex) {
  const h = String(hex || "").replace("#", "");
  const v = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(v, 16);
  if (v.length !== 6 || !Number.isFinite(n)) return [37, 99, 235]; // 既定 #2563eb
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mixRgb(a, b, t) {
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
}
function rgbCss(c) { return `rgb(${c[0]}, ${c[1]}, ${c[2]})`; }

// 終日: 元の色そのまま＝濃い目（白文字）。それ以外: 白寄りに薄めて同系の濃い文字。
function eventBarStyle(ev) {
  const base = hexToRgb(eventColor(ev));
  if (ev.all_day) {
    return { background: rgbCss(base), color: "#fff", accent: "" };
  }
  return {
    background: rgbCss(mixRgb(base, [255, 255, 255], 0.72)),
    color: rgbCss(mixRgb(base, [0, 0, 0], 0.35)),
    accent: rgbCss(base),
  };
}

function tagColor(name) {
  const t = state.tags.find((x) => x.name === name);
  return (t && t.color) || "#64748b";
}

// マスタ + 実際に使われているタグをマージした候補一覧
function allTagOptions() {
  const map = new Map();
  state.tags.forEach((t) => map.set(t.name, t.color));
  state.events.forEach((ev) => (ev.tags || []).forEach((n) => { if (!map.has(n)) map.set(n, "#64748b"); }));
  return [...map.entries()].map(([name, color]) => ({ name, color })).sort((a, b) =>
    a.name.localeCompare(b.name, "ja")
  );
}

// 検索 + 人フィルタを適用した予定
function visibleEvents() {
  const q = state.search.trim().toLowerCase();
  return state.events.filter((ev) => {
    if (state.hiddenUsers.has(ev.owner_id)) return false;
    if (q) {
      const tags = (ev.tags || []).join(" ");
      const hay = `${ev.title} ${ev.description || ""} ${ev.location || ""} ${tags}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// 指定日(YYYY-MM-DD)にかかる予定
function eventsOnDay(dateStr, list) {
  return list.filter((ev) => {
    const s = (ev.start || "").slice(0, 10);
    const e = (ev.end || ev.start || "").slice(0, 10);
    return s <= dateStr && dateStr <= (e || s);
  });
}

// ===========================================================================
// 描画ディスパッチ
// ===========================================================================
function render() {
  const isList = state.view === "list";
  const dayMode = isList && state.listMode === "day";
  const rangeMode = isList && state.listMode === "range";
  $("view-month").classList.toggle("active", !isList);
  $("view-list").classList.toggle("active", isList);

  // ‹ › 今日 ナビ：月表示・一覧(月)は月送り、一覧(日)は日送り、期間は非表示
  const showNav = !rangeMode;
  $("prev-month").style.display = showNav ? "" : "none";
  $("next-month").style.display = showNav ? "" : "none";
  $("today-btn").style.display = showNav ? "" : "none";
  $("month-label").textContent = rangeMode
    ? "期間で表示"
    : dayMode
    ? dayLabel(state.listDay)
    : `${state.year}年${state.month + 1}月`;

  $("list-controls").hidden = !isList;
  $("lmode-day").classList.toggle("active", state.listMode === "day");
  $("lmode-month").classList.toggle("active", state.listMode === "month");
  $("lmode-range").classList.toggle("active", state.listMode === "range");
  $("range-inputs").hidden = !rangeMode;

  $("weekday-row").hidden = isList;
  $("calendar").hidden = isList;
  $("list-view").hidden = !isList;

  renderPeopleFilter();
  if (isList) renderList();
  else renderMonth();
}

function renderPeopleFilter() {
  const box = $("people-filter");
  box.innerHTML = "";
  const users = Object.values(state.users).sort((a, b) =>
    a.display_name.localeCompare(b.display_name, "ja")
  );
  if (users.length <= 1) return; // 1人だけならフィルタ不要
  users.forEach((u) => {
    const chip = document.createElement("button");
    chip.className = "person-chip" + (state.hiddenUsers.has(u.id) ? " off" : "");
    chip.innerHTML = `<span class="dot" style="background:${u.color}"></span>${u.display_name}`;
    chip.onclick = () => {
      if (state.hiddenUsers.has(u.id)) state.hiddenUsers.delete(u.id);
      else state.hiddenUsers.add(u.id);
      render();
    };
    box.appendChild(chip);
  });
}

// 日付をタップ → その日の予定一覧（日表示）へ切り替え
function openDay(ds) {
  state.view = "list";
  state.listMode = "day";
  state.listDay = ds;
  render();
}

// 新規作成時の既定日（日表示中ならその日、それ以外は今日）
function newEventDate() {
  return state.view === "list" && state.listMode === "day" ? state.listDay : todayStr();
}

// ---- 月表示（複数日予定は連結バーで表示）----
const MAX_LANES = 3; // 1日に表示する最大バー数（超過分は「+N」）

function renderMonth() {
  const cal = $("calendar");
  cal.innerHTML = "";
  const vis = visibleEvents();
  const today = todayStr();

  const first = new Date(state.year, state.month, 1);
  const gridStart = new Date(first);
  gridStart.setDate(1 - first.getDay());

  for (let w = 0; w < 6; w++) {
    const weekStart = new Date(gridStart);
    weekStart.setDate(gridStart.getDate() + w * 7);
    cal.appendChild(renderWeek(weekStart, vis, today));
  }
}

function renderWeek(weekStart, vis, today) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    days.push(d);
  }
  const dates = days.map(isoDate);
  const wStart = dates[0], wEnd = dates[6];

  const week = document.createElement("div");
  week.className = "week";

  // 背景の日セル（日付番号・クリックで追加）
  const overflow = new Array(7).fill(0);
  days.forEach((d, i) => {
    const ds = dates[i];
    const inMonth = d.getMonth() === state.month;
    const dow = d.getDay();
    const holi = Holidays.name(ds);
    const we = dow === 0 || holi ? " sun" : dow === 6 ? " sat" : "";
    const cell = document.createElement("div");
    cell.className = "day" + (inMonth ? "" : " other") + we + (ds === today ? " today" : "");

    const top = document.createElement("div");
    top.className = "day-top";
    const num = document.createElement("div");
    num.className = "num" + we;
    num.textContent = d.getDate();
    top.appendChild(num);
    if (holi) {
      const hl = document.createElement("span");
      hl.className = "holi";
      hl.textContent = holi;
      top.appendChild(hl);
    }
    cell.appendChild(top);
    cell.onclick = () => openDay(ds); // その日の予定一覧（編集）へ
    week.appendChild(cell);
    cell._moreSlot = document.createElement("div");
    cell._moreSlot.className = "more";
    cell.appendChild(cell._moreSlot);
    cell._overflowIndex = i;
    days[i]._cell = cell;
  });

  // この週にかかる予定をセグメント化
  const segs = [];
  for (const ev of vis) {
    const s = startDate(ev), e = endDate(ev);
    if (s > wEnd || e < wStart) continue;
    const sIdx = s <= wStart ? 0 : dates.indexOf(s);
    const eIdx = e >= wEnd ? 6 : dates.indexOf(e);
    segs.push({
      ev, sIdx, eIdx,
      span: eIdx - sIdx,
      contLeft: s < wStart,
      contRight: e > wEnd,
    });
  }
  // 並べ替え: 開始が早い順 → 長い順 → 開始時刻順
  segs.sort((a, b) =>
    a.sIdx - b.sIdx || b.span - a.span || (a.ev.start || "").localeCompare(b.ev.start || "")
  );

  // レーン割り当て（重ならない最初の段に詰める）
  const lanes = [];
  for (const seg of segs) {
    let lane = 0;
    for (;;) {
      const occ = lanes[lane] || (lanes[lane] = []);
      if (occ.every(([a, b]) => seg.eIdx < a || seg.sIdx > b)) {
        occ.push([seg.sIdx, seg.eIdx]);
        seg.lane = lane;
        break;
      }
      lane++;
    }
  }

  const overlay = document.createElement("div");
  overlay.className = "week-events";
  for (const seg of segs) {
    if (seg.lane >= MAX_LANES) {
      for (let c = seg.sIdx; c <= seg.eIdx; c++) overflow[c]++;
      continue;
    }
    const bar = document.createElement("div");
    bar.className = "evbar" +
      (seg.contLeft ? " cont-left" : "") + (seg.contRight ? " cont-right" : "");
    const st = eventBarStyle(seg.ev);
    bar.style.background = st.background;
    bar.style.color = st.color;
    if (st.accent && !seg.contLeft) bar.style.borderLeft = `3px solid ${st.accent}`;
    bar.style.gridColumn = `${seg.sIdx + 1} / ${seg.eIdx + 2}`;
    bar.style.gridRow = String(seg.lane + 1);
    const ev = seg.ev;
    const timed = !ev.all_day && !seg.contLeft && ev.start && ev.start.length > 10;
    bar.textContent =
      (ev.private ? "🔒" : "") + ev.title + (timed ? " " + ev.start.slice(11, 16) : "");
    bar.onclick = (e) => { e.stopPropagation(); openModal(ev); };
    overlay.appendChild(bar);
  }
  week.appendChild(overlay);

  // 超過分の「+N」表示
  overflow.forEach((n, i) => {
    if (n > 0) days[i]._cell._moreSlot.textContent = `+${n}`;
  });

  return week;
}

// ---- 一覧表示（月単位 / 期間単位・過去も閲覧可）----
function renderList() {
  const wrap = $("list-view");
  wrap.innerHTML = "";

  // 表示する期間 [from, to] を決定
  let from, to, emptyMsg;
  if (state.listMode === "day") {
    from = to = state.listDay;
    emptyMsg = "この日に予定はありません";
  } else if (state.listMode === "range") {
    from = state.rangeFrom || "0000-00-00";
    to = state.rangeTo || "9999-99-99";
    emptyMsg = "この期間に予定はありません";
  } else {
    [from, to] = monthRange(state.year, state.month);
    emptyMsg = "この月に予定はありません";
  }

  // 日表示のときは祝日バナーを上部に表示（予定の有無に関わらず）
  const dayMode = state.listMode === "day";
  if (dayMode) {
    const holi = Holidays.name(state.listDay);
    if (holi) {
      const b = document.createElement("div");
      b.className = "holi-banner";
      b.textContent = "🎌 " + holi;
      wrap.appendChild(b);
    }
  }

  // 期間に重なる予定（開始でソート）。検索語があればさらに絞り込み済み。
  let evs = visibleEvents().filter((ev) => startDate(ev) <= to && endDate(ev) >= from);
  evs.sort((a, b) => (a.start || "").localeCompare(b.start || ""));

  if (evs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "list-empty";
    empty.textContent = state.search.trim() ? "該当する予定はありません" : emptyMsg;
    wrap.appendChild(empty);
    return;
  }

  const today = todayStr();
  let lastDate = "";
  evs.forEach((ev) => {
    const ds = (ev.start || "").slice(0, 10);
    if (!dayMode && ds !== lastDate) {
      lastDate = ds;
      const head = document.createElement("div");
      const d = new Date(ds + "T00:00");
      const holi = Holidays.name(ds);
      const we = d.getDay() === 0 || holi ? " we-sun" : d.getDay() === 6 ? " we-sat" : "";
      head.className = "list-date" + we + (ds === today ? " is-today" : "");
      head.textContent =
        `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${WD[d.getDay()]})` +
        (holi ? " ・" + holi : "") + (ds === today ? " ・今日" : "");
      wrap.appendChild(head);
    }
    wrap.appendChild(listItem(ev));
  });
}

function listItem(ev) {
  const item = document.createElement("div");
  item.className = "list-item";

  const bar = document.createElement("div");
  bar.className = "list-bar";
  bar.style.background = eventColor(ev);
  item.appendChild(bar);

  const body = document.createElement("div");
  body.className = "list-body";

  const sd = startDate(ev), ed = endDate(ev);
  const multiDay = sd !== ed;
  const days = multiDay
    ? Math.round((new Date(ed + "T00:00") - new Date(sd + "T00:00")) / 86400000) + 1
    : 1;
  const st = ev.start && ev.start.length > 10 ? ev.start.slice(11, 16) : "";
  const et = ev.end && ev.end.length > 10 ? ev.end.slice(11, 16) : "";

  const time = document.createElement("div");
  time.className = "list-time" + (multiDay ? " is-multiday" : "");
  if (ev.all_day) {
    time.textContent = multiDay ? `終日　${fmtDay(sd)}〜${fmtDay(ed)}` : "終日";
  } else if (multiDay) {
    time.textContent = `${fmtDay(sd)} ${st}`.trim() + "〜" + `${fmtDay(ed)} ${et}`.trim();
  } else {
    time.textContent = st + (et ? "〜" + et : "");
  }
  if (multiDay) {
    const badge = document.createElement("span");
    badge.className = "list-span-badge";
    badge.textContent = days + "日間";
    time.appendChild(badge);
  }
  body.appendChild(time);

  const title = document.createElement("div");
  title.className = "list-title";
  title.textContent = (ev.private ? "🔒 " : "") + ev.title;
  body.appendChild(title);

  const owner = state.users[ev.owner_id];
  const metaParts = [];
  if (ev.location) metaParts.push("📍" + ev.location);
  if (owner) metaParts.push("👤" + owner.display_name);
  if (ev.participants && ev.participants.length) {
    const names = ev.participants.map((v) => (state.users[v] ? state.users[v].display_name : v));
    if (names.length) metaParts.push("👥" + names.join("、"));
  }
  if (metaParts.length) {
    const meta = document.createElement("div");
    meta.className = "list-meta";
    meta.textContent = metaParts.join("　");
    body.appendChild(meta);
  }

  if (ev.tags && ev.tags.length) {
    const row = document.createElement("div");
    row.className = "tag-row";
    ev.tags.forEach((t) => {
      const tag = document.createElement("span");
      tag.className = "tag";
      const c = tagColor(t);
      tag.style.background = c + "22"; // 薄い背景
      tag.style.color = c;
      tag.textContent = "#" + t;
      tag.onclick = (e) => {
        e.stopPropagation();
        $("search-input").value = t;
        state.search = t;
        render();
      };
      row.appendChild(tag);
    });
    body.appendChild(row);
  }

  item.appendChild(body);
  item.onclick = () => openModal(ev);
  return item;
}

// ===========================================================================
// モーダル（追加 / 編集）
// ===========================================================================
function openModal(ev, dateStr) {
  state.editingId = ev ? ev.id : null;
  $("modal-title").textContent = ev ? "予定を編集" : "予定を追加";
  $("ev-delete").hidden = !ev;

  const date = dateStr || (ev && ev.start ? ev.start.slice(0, 10) : todayStr());
  $("ev-title").value = ev ? ev.title : "";
  $("ev-allday").checked = ev ? !!ev.all_day : false;
  const startVal = ev && ev.start ? ev.start.slice(0, 10) : date;
  $("ev-start-date").value = startVal;
  $("ev-start-time").value = ev && ev.start && ev.start.length > 10 ? ev.start.slice(11, 16) : "09:00";
  // 終了日の初期値は開始日と同じ（未設定の予定もブランクにしない）
  $("ev-end-date").value = ev && ev.end ? ev.end.slice(0, 10) : startVal;
  $("ev-end-time").value = ev && ev.end && ev.end.length > 10 ? ev.end.slice(11, 16) : "";
  $("ev-location").value = ev ? ev.location || "" : "";
  TagBox.init(ev && ev.tags ? ev.tags : []);
  PartBox.init(ev && ev.participants ? ev.participants : []);
  $("ev-private").checked = ev ? !!ev.private : false;
  $("ev-desc").value = ev ? ev.description || "" : "";

  const owner = ev && state.users[ev.owner_id];
  $("ev-owner").textContent = owner ? `作成者: ${owner.display_name}` : "";

  toggleTimeInputs();
  $("event-modal").hidden = false;
  if (!ev) $("ev-title").focus();
}

function closeModal() {
  $("event-modal").hidden = true;
  state.editingId = null;
}

function toggleTimeInputs() {
  $("event-form").classList.toggle("allday", $("ev-allday").checked);
}

function composeDateTime(dateId, timeId, allday) {
  const date = $(dateId).value;
  if (!date) return null;
  if (allday) return date;
  const time = $(timeId).value || "00:00";
  return `${date}T${time}`;
}

// ===========================================================================
// タグ コンボボックス（選択 + スペース区切り入力）
// ===========================================================================
const TagBox = {
  selected: [],
  activeIndex: -1,

  init(tags) {
    this.selected = (tags || []).slice();
    this.activeIndex = -1;
    $("tagbox-input").value = "";
    this.renderChips();
    this.closeMenu();
  },

  add(name) {
    name = (name || "").trim();
    if (!name) return;
    if (!this.selected.some((t) => t.toLowerCase() === name.toLowerCase())) {
      this.selected.push(name);
      this.renderChips();
    }
  },
  remove(name) {
    this.selected = this.selected.filter((t) => t !== name);
    this.renderChips();
  },

  renderChips() {
    const box = $("tagbox-chips");
    box.innerHTML = "";
    this.selected.forEach((name) => {
      const chip = document.createElement("span");
      chip.className = "chip-tag";
      chip.style.background = tagColor(name);
      chip.textContent = name;
      const x = document.createElement("button");
      x.type = "button";
      x.textContent = "×";
      x.onclick = () => this.remove(name);
      chip.appendChild(x);
      box.appendChild(chip);
    });
  },

  openMenu(query) {
    const menu = $("tagbox-menu");
    const q = (query || "").trim().toLowerCase();
    const opts = allTagOptions().filter(
      (t) => !this.selected.some((s) => s.toLowerCase() === t.name.toLowerCase()) &&
        (!q || t.name.toLowerCase().includes(q))
    );
    menu.innerHTML = "";
    this.activeIndex = -1;

    opts.forEach((t) => {
      const item = document.createElement("div");
      item.className = "tagopt";
      item.innerHTML = `<span class="dot" style="background:${t.color}"></span>${t.name}`;
      // pointerdown はフォーカス移動より前に発火し、タッチでも確実に拾える
      item.onpointerdown = (e) => { e.preventDefault(); this.add(t.name); this.afterPick(); };
      menu.appendChild(item);
    });

    // 既存に一致しない入力は「新規作成」候補
    const exact = allTagOptions().some((t) => t.name.toLowerCase() === q);
    if (q && !exact) {
      const create = document.createElement("div");
      create.className = "tagopt create";
      create.textContent = `＋「${query.trim()}」を追加`;
      create.onpointerdown = (e) => { e.preventDefault(); this.add(query.trim()); this.afterPick(); };
      menu.appendChild(create);
    }

    menu.hidden = menu.children.length === 0;
  },
  afterPick() {
    $("tagbox-input").value = "";
    this.openMenu("");
    $("tagbox-input").focus();
  },
  closeMenu() {
    $("tagbox-menu").hidden = true;
  },

  // 入力中の未確定テキストも確定して選択タグを返す
  commitAndGet() {
    const input = $("tagbox-input");
    if (input.value.trim()) this.add(input.value.trim());
    input.value = "";
    return this.selected.slice();
  },
};

function bindTagBox() {
  const input = $("tagbox-input");
  input.addEventListener("focus", () => TagBox.openMenu(input.value));
  input.addEventListener("input", () => {
    let v = input.value.replace(/　/g, " "); // 全角スペース→半角
    if (v.includes(" ")) {
      const parts = v.split(" ");
      const last = parts.pop();
      parts.forEach((p) => TagBox.add(p));
      input.value = last;
    } else {
      input.value = v;
    }
    TagBox.openMenu(input.value);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (input.value.trim()) { TagBox.add(input.value.trim()); TagBox.afterPick(); }
    } else if (e.key === "Backspace" && input.value === "" && TagBox.selected.length) {
      TagBox.remove(TagBox.selected[TagBox.selected.length - 1]);
    } else if (e.key === "Escape") {
      TagBox.closeMenu();
    }
  });
  input.addEventListener("blur", () => setTimeout(() => TagBox.closeMenu(), 120));
}

// ===========================================================================
// 参加者 コンボボックス（ユーザー選択 + 自由入力）
//   選択値は「ユーザーID」または「自由入力の名前」が混在する。
// ===========================================================================
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PartBox = {
  selected: [], // user id か 自由入力テキスト

  init(vals) {
    // ユーザーは表示名で、未知のUUID（削除済みユーザー等）は除外、自由入力は保持
    this.selected = (vals || []).filter((v) => state.users[v] || !UUID_RE.test(v));
    $("partbox-input").value = "";
    this.renderChips();
    this.closeMenu();
  },
  // ラベル（ユーザーなら表示名、そうでなければそのまま）
  label(v) {
    return state.users[v] ? state.users[v].display_name : v;
  },
  add(v) {
    v = String(v || "").replace(/,/g, "").trim();
    if (v && !this.selected.includes(v)) { this.selected.push(v); this.renderChips(); }
  },
  remove(v) {
    this.selected = this.selected.filter((x) => x !== v);
    this.renderChips();
  },
  renderChips() {
    const box = $("partbox-chips");
    box.innerHTML = "";
    this.selected.forEach((v) => {
      const u = state.users[v];
      const chip = document.createElement("span");
      chip.className = "chip-tag" + (u ? "" : " free");
      chip.style.background = u ? u.color : "#94a3b8";
      chip.textContent = this.label(v);
      const x = document.createElement("button");
      x.type = "button"; x.textContent = "×";
      x.onclick = () => this.remove(v);
      chip.appendChild(x);
      box.appendChild(chip);
    });
  },
  candidates(query) {
    const q = (query || "").trim().toLowerCase();
    return Object.values(state.users).filter(
      (u) => !this.selected.includes(u.id) && (!q || u.display_name.toLowerCase().includes(q))
    ).sort((a, b) => a.display_name.localeCompare(b.display_name, "ja"));
  },
  openMenu(query) {
    const menu = $("partbox-menu");
    const q = (query || "").trim();
    menu.innerHTML = "";
    // ユーザー候補
    this.candidates(query).forEach((u) => {
      const item = document.createElement("div");
      item.className = "tagopt";
      item.innerHTML = `<span class="dot" style="background:${u.color}"></span>${u.display_name}`;
      item.onpointerdown = (e) => { e.preventDefault(); this.pick(u.id); };
      menu.appendChild(item);
    });
    // 自由入力（ユーザー名と完全一致しない入力は「追加」候補）
    const exact = Object.values(state.users).some(
      (u) => u.display_name.toLowerCase() === q.toLowerCase()
    );
    if (q && !exact && !this.selected.includes(q)) {
      const create = document.createElement("div");
      create.className = "tagopt create";
      create.textContent = `＋「${q}」を追加（ユーザー以外）`;
      create.onpointerdown = (e) => { e.preventDefault(); this.pick(q); };
      menu.appendChild(create);
    }
    menu.hidden = menu.children.length === 0;
  },
  pick(v) {
    this.add(v);
    $("partbox-input").value = "";
    this.openMenu("");
    $("partbox-input").focus();
  },
  closeMenu() { $("partbox-menu").hidden = true; },
  get() { return this.selected.slice(); },
};

function bindPartBox() {
  const input = $("partbox-input");
  input.addEventListener("focus", () => PartBox.openMenu(input.value));
  input.addEventListener("input", () => PartBox.openMenu(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) return;
      // 入力がユーザー名と一致すればそのユーザー、そうでなければ自由入力として追加
      const u = Object.values(state.users).find(
        (x) => x.display_name.toLowerCase() === v.toLowerCase()
      );
      PartBox.pick(u ? u.id : v);
    } else if (e.key === "Backspace" && input.value === "" && PartBox.selected.length) {
      PartBox.remove(PartBox.selected[PartBox.selected.length - 1]);
    } else if (e.key === "Escape") {
      PartBox.closeMenu();
    }
  });
  input.addEventListener("blur", () => setTimeout(() => PartBox.closeMenu(), 120));
}

async function saveEvent(e) {
  e.preventDefault();
  const allday = $("ev-allday").checked;
  const existing = state.editingId
    ? state.events.find((x) => x.id === state.editingId)
    : null;

  const ev = {
    id: state.editingId || uuid(),
    title: $("ev-title").value.trim() || "(無題)",
    description: $("ev-desc").value,
    location: $("ev-location").value,
    tags: TagBox.commitAndGet(),
    participants: PartBox.get(),
    private: $("ev-private").checked,
    start: composeDateTime("ev-start-date", "ev-start-time", allday),
    end: $("ev-end-date").value ? composeDateTime("ev-end-date", "ev-end-time", allday) : null,
    all_day: allday,
    color: existing ? existing.color : null,
    owner_id: existing ? existing.owner_id : state.user.id,
    deleted: false,
  };
  await Sync.saveAndSync(ev);
  closeModal();
  await loadEvents();
}

async function deleteEvent() {
  const ev = state.events.find((x) => x.id === state.editingId);
  if (!ev) return;
  if (!confirm(`「${ev.title}」を削除しますか？`)) return;
  await Sync.saveAndSync({ ...ev, deleted: true });
  closeModal();
  await loadEvents();
}

// ===========================================================================
// 同期ステータス
// ===========================================================================
function updateSyncStatus(status) {
  const pill = $("sync-status");
  if (status === "unauthorized") {
    DB.setMeta("currentUser", null);
    state.user = null;
    showLogin();
    return;
  }
  const map = {
    synced: ["ok", "● 同期済み"],
    syncing: ["syncing", "● 同期中"],
    offline: ["offline", "● オフライン"],
  };
  const [cls, title] = map[status] || ["offline", ""];
  pill.className = "sync-pill " + cls;
  pill.title = title;
  if (status === "synced") loadEvents();
}

// ===========================================================================
// UI バインド
// ===========================================================================
function bindUI() {
  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("login-error").hidden = true;
    try {
      const { user } = await API.login($("login-username").value, $("login-password").value);
      $("login-password").value = "";
      await onLoggedIn(user);
    } catch (err) {
      $("login-error").hidden = false;
    }
  });

  const shiftPeriod = (delta) => {
    if (state.view === "list" && state.listMode === "day") {
      const d = new Date(state.listDay + "T00:00");
      d.setDate(d.getDate() + delta);
      state.listDay = isoDate(d);
    } else {
      state.month += delta;
      if (state.month < 0) { state.month = 11; state.year--; }
      if (state.month > 11) { state.month = 0; state.year++; }
    }
    render();
  };
  $("prev-month").onclick = () => shiftPeriod(-1);
  $("next-month").onclick = () => shiftPeriod(1);
  $("today-btn").onclick = () => {
    const n = new Date();
    state.year = n.getFullYear();
    state.month = n.getMonth();
    state.listDay = todayStr();
    render();
  };

  // 左右スワイプで月（日表示中は日）を移動
  const swipeNav = (dir) => {
    shiftPeriod(dir);
    if (state.view === "month") {
      const c = $("calendar");
      c.classList.remove("anim-next", "anim-prev");
      void c.offsetWidth; // アニメーションを再始動させる
      c.classList.add(dir > 0 ? "anim-next" : "anim-prev");
    }
  };
  bindSwipe($("calendar"), swipeNav);
  bindSwipe($("list-view"), (dir) => { if (state.listMode !== "range") swipeNav(dir); });

  $("view-month").onclick = () => { state.view = "month"; render(); };
  $("view-list").onclick = () => { state.view = "list"; render(); };

  $("lmode-day").onclick = () => { state.listMode = "day"; render(); };
  $("lmode-month").onclick = () => { state.listMode = "month"; render(); };
  $("lmode-range").onclick = () => {
    state.listMode = "range";
    // 初回は当月をデフォルト期間に
    if (!state.rangeFrom || !state.rangeTo) {
      const [f, t] = monthRange(state.year, state.month);
      state.rangeFrom = f; state.rangeTo = t;
      $("range-from").value = f; $("range-to").value = t;
    }
    render();
  };
  $("range-from").addEventListener("change", (e) => { state.rangeFrom = e.target.value; render(); });
  $("range-to").addEventListener("change", (e) => { state.rangeTo = e.target.value; render(); });

  let searchTimer;
  $("search-input").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = e.target.value;
      render();
    }, 150);
  });

  $("add-btn").onclick = () => openModal(null, newEventDate());
  $("ev-cancel").onclick = closeModal;
  $("ev-delete").onclick = deleteEvent;
  $("event-form").addEventListener("submit", saveEvent);
  $("ev-allday").addEventListener("change", toggleTimeInputs);
  // 開始日を変えたとき、終了日が未入力か開始より前なら開始日に合わせる
  $("ev-start-date").addEventListener("change", (e) => {
    const end = $("ev-end-date");
    if (!end.value || end.value < e.target.value) end.value = e.target.value;
  });
  $("event-modal").addEventListener("click", (e) => {
    if (e.target.id === "event-modal") closeModal();
  });

  // メニュー（☰）
  const menu = $("menu-dropdown");
  $("menu-btn").onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !e.target.closest(".menu-wrap")) menu.hidden = true;
  });
  $("menu-admin").onclick = () => { menu.hidden = true; openAdmin(); };
  $("menu-logout").onclick = async () => {
    menu.hidden = true;
    try { await API.logout(); } catch (_) {}
    await DB.setMeta("currentUser", null);
    state.user = null;
    showLogin();
  };

  bindTagBox();
  bindPartBox();
  bindAdmin();
}

// ===========================================================================
// 管理画面（ユーザー / タグ）
// ===========================================================================
function openAdmin() {
  $("app-screen").hidden = true;
  $("admin-screen").hidden = false;
  switchAdminTab("users");
}
function closeAdmin() {
  $("admin-screen").hidden = true;
  showApp();
  Sync.run().then(afterSync).catch(() => {}); // 変更を反映
}

function switchAdminTab(tab) {
  $("atab-users").classList.toggle("active", tab === "users");
  $("atab-tags").classList.toggle("active", tab === "tags");
  $("atab-export").classList.toggle("active", tab === "export");
  $("admin-users").hidden = tab !== "users";
  $("admin-tags").hidden = tab !== "tags";
  $("admin-export").hidden = tab !== "export";
  if (tab === "users") renderAdminUsers();
  else if (tab === "tags") renderAdminTags();
}

async function renderAdminUsers() {
  const wrap = $("admin-users-list");
  wrap.innerHTML = "読み込み中…";
  let users;
  try { users = (await API.adminUsers()).users; }
  catch (e) { wrap.textContent = "取得に失敗しました（権限/通信）。"; return; }
  wrap.innerHTML = "";
  users.forEach((u) => {
    const card = document.createElement("div");
    card.className = "admin-card";

    const color = el("input", { type: "color", value: u.color });
    const name = el("input", { type: "text", value: u.display_name });
    const uname = el("span", { class: "uname", text: "@" + u.username });
    const ckWrap = document.createElement("label");
    ckWrap.className = "ck";
    const ck = el("input", { type: "checkbox" });
    ck.checked = u.is_admin;
    ckWrap.append(ck, document.createTextNode(" 管理者"));

    const save = el("button", { class: "mini", text: "保存" });
    save.onclick = async () => {
      await API.adminUpdateUser(u.id, {
        display_name: name.value, color: color.value, is_admin: ck.checked,
      }).catch((e) => alert("保存に失敗: " + (e.code === 400 ? "最後の管理者は降格できません" : e.message)));
      renderAdminUsers();
    };
    const pw = el("button", { class: "mini", text: "PW変更" });
    pw.onclick = async () => {
      const np = prompt(`${u.display_name} の新しいパスワード`);
      if (np) { await API.adminUpdateUser(u.id, { display_name: name.value, color: color.value, is_admin: ck.checked, password: np }); alert("変更しました"); }
    };
    const del = el("button", { class: "mini danger", text: "削除" });
    del.onclick = async () => {
      if (!confirm(`${u.display_name} を削除しますか？`)) return;
      await API.adminDeleteUser(u.id).catch((e) => alert("削除できません（自分自身は不可）"));
      renderAdminUsers();
    };

    card.append(color, name, uname, ckWrap, el("span", { class: "grow" }), save, pw, del);
    wrap.appendChild(card);
  });
}

async function renderAdminTags() {
  const wrap = $("admin-tags-list");
  wrap.innerHTML = "読み込み中…";
  let tags;
  try { tags = (await API.tags()).tags; }
  catch (e) { wrap.textContent = "取得に失敗しました。"; return; }
  state.tags = tags;
  wrap.innerHTML = "";
  if (!tags.length) wrap.innerHTML = '<p class="list-empty">タグはまだありません</p>';
  tags.forEach((t) => {
    const card = document.createElement("div");
    card.className = "admin-card";
    const color = el("input", { type: "color", value: t.color });
    const name = el("input", { type: "text", value: t.name });
    const save = el("button", { class: "mini", text: "保存" });
    save.onclick = async () => {
      await API.adminUpdateTag(t.id, { name: name.value, color: color.value })
        .catch((e) => alert("保存に失敗（同名タグが存在？）"));
      renderAdminTags();
    };
    const del = el("button", { class: "mini danger", text: "削除" });
    del.onclick = async () => {
      if (!confirm(`タグ「${t.name}」を削除しますか？（予定の付与は残ります）`)) return;
      await API.adminDeleteTag(t.id);
      renderAdminTags();
    };
    card.append(color, name, el("span", { class: "grow" }), save, del);
    wrap.appendChild(card);
  });
}

function bindAdmin() {
  $("admin-back").onclick = closeAdmin;
  $("atab-users").onclick = () => switchAdminTab("users");
  $("atab-tags").onclick = () => switchAdminTab("tags");
  $("atab-export").onclick = () => switchAdminTab("export");
  $("export-csv").onclick = () => {
    const a = document.createElement("a");
    a.href = "/api/admin/events.csv";
    a.click(); // Content-Disposition によりダウンロードされる
  };

  $("nu-add").onclick = async () => {
    const username = $("nu-username").value.trim();
    const password = $("nu-password").value;
    if (!username || !password) { alert("ID と初期パスワードは必須です"); return; }
    try {
      await API.adminCreateUser({
        username, password,
        display_name: $("nu-display").value.trim() || username,
        color: $("nu-color").value,
        is_admin: $("nu-admin").checked,
      });
    } catch (e) { alert(e.code === 409 ? "そのIDは既に使われています" : "作成に失敗しました"); return; }
    ["nu-username", "nu-password", "nu-display"].forEach((id) => ($(id).value = ""));
    $("nu-admin").checked = false;
    renderAdminUsers();
  };

  $("nt-add").onclick = async () => {
    const name = $("nt-name").value.trim();
    if (!name) { alert("タグ名を入力してください"); return; }
    try { await API.adminCreateTag({ name, color: $("nt-color").value }); }
    catch (e) { alert(e.code === 409 ? "そのタグは既に存在します" : "作成に失敗しました"); return; }
    $("nt-name").value = "";
    renderAdminTags();
  };
}

// 小さな DOM 生成ヘルパ
function el(tag, opts = {}) {
  const e = document.createElement(tag);
  if (opts.class) e.className = opts.class;
  if (opts.text) e.textContent = opts.text;
  if (opts.type) e.type = opts.type;
  if (opts.value !== undefined) e.value = opts.value;
  return e;
}

start();
