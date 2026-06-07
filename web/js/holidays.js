/* holidays.js — 日本の祝日をクライアント側で計算（オフライン対応・外部API不要）。
   対応: 固定祝日 / ハッピーマンデー / 春分・秋分（2000-2099）/ 振替休日 / 国民の休日。
   ※ 2020・2021 の五輪特例や 2019 以前の一部は対象外（現在〜将来の通常年向け）。 */

const Holidays = (() => {
  const cache = {};
  const p = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;

  // 月 m(1-12) の第 n 月曜
  function nthMonday(y, m, n) {
    const first = new Date(y, m - 1, 1).getDay(); // 0=日
    const date = 1 + ((1 - first + 7) % 7) + (n - 1) * 7;
    return new Date(y, m - 1, date);
  }
  // 春分・秋分の日（1980基準の近似式、2000-2099で有効）
  const vernal = (y) => Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
  const autumn = (y) => Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));

  function build(y) {
    const h = {};
    const set = (m, d, name) => { h[`${y}-${p(m)}-${p(d)}`] = name; };

    set(1, 1, "元日");
    h[iso(nthMonday(y, 1, 2))] = "成人の日";
    set(2, 11, "建国記念の日");
    if (y >= 2020) set(2, 23, "天皇誕生日");
    set(3, vernal(y), "春分の日");
    set(4, 29, "昭和の日");
    set(5, 3, "憲法記念日");
    set(5, 4, "みどりの日");
    set(5, 5, "こどもの日");
    h[iso(nthMonday(y, 7, 3))] = "海の日";
    if (y >= 2016) set(8, 11, "山の日");
    h[iso(nthMonday(y, 9, 3))] = "敬老の日";
    set(9, autumn(y), "秋分の日");
    h[iso(nthMonday(y, 10, 2))] = "スポーツの日";
    set(11, 3, "文化の日");
    set(11, 23, "勤労感謝の日");

    // 国民の休日（前後が祝日の平日）
    for (let m = 1; m <= 12; m++) {
      const dim = new Date(y, m, 0).getDate();
      for (let d = 1; d <= dim; d++) {
        const date = new Date(y, m - 1, d);
        const k = iso(date);
        if (h[k] || date.getDay() === 0) continue;
        const prev = iso(new Date(y, m - 1, d - 1));
        const next = iso(new Date(y, m - 1, d + 1));
        if (h[prev] && h[next]) h[k] = "国民の休日";
      }
    }

    // 振替休日（祝日が日曜なら直後の休日でない日）
    for (const k of Object.keys(h).sort()) {
      const d = new Date(k + "T00:00");
      if (d.getDay() !== 0) continue;
      const nd = new Date(d);
      do { nd.setDate(nd.getDate() + 1); } while (h[iso(nd)]);
      if (nd.getFullYear() === y) h[iso(nd)] = "振替休日";
    }
    return h;
  }

  return {
    forYear(y) { return (cache[y] = cache[y] || build(y)); },
    name(ds) { return this.forYear(+ds.slice(0, 4))[ds] || null; },
  };
})();

window.Holidays = Holidays;
