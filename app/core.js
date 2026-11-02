// サブスク棚卸し 無料スキャン: コアロジック（ブラウザ内で完結し、明細は外部送信しない）
// CLI版（src/detect.ts, src/cancel.ts）と同じ判定ルールの移植。

const FIXED_PATTERNS = /賃料|家賃|SUICA|PASMO|チャージ|電気|ガス|水道|保険|税金|ローン|NHK/;
const REVIEW_PATTERNS = /AMAZON\.CO\.JP|楽天市場|YAHOO|ヤフーショッピング|メルカリ/;

const MERCHANT_ALIASES = [
  [/ANTHROPIC|CLAUDE/, "ANTHROPIC"],
  [/AMAZON DOWNLOADS/, "AMAZON DOWNLOADS"],
  [/NETFLIX|ネットフリックス/, "NETFLIX"],
  [/ポンタパス/, "ポンタパス"],
  [/J:COM|JCOM|ジェイコム/, "J:COM"],
  [/RIVE/, "RIVE INC"],
  [/SPOTIFY/, "SPOTIFY"],
];

export function normalizeMerchant(description) {
  let s = String(description).toUpperCase().replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  s = s.replace(/^VISA(国内|海外)利用\s*(VS)?\s*/, "");
  s = s.replace(/利用国[A-Z]{0,2}/g, " ");
  s = s.replace(/[（(][^）)]*(?:[）)]|$)/g, " ");
  s = s.replace(/\d{4}[-/]\d{1,2}([-/]\d{1,2})?/g, " ").replace(/[^A-Z0-9ァ-ヶ一-龠 ]/g, " ").replace(/\s+/g, " ").trim();
  for (const [re, key] of MERCHANT_ALIASES) if (re.test(s)) return key;
  return s;
}

export function classifyKind(displayName) {
  const upper = String(displayName).toUpperCase();
  if (FIXED_PATTERNS.test(upper)) return "fixed";
  if (REVIEW_PATTERNS.test(upper)) return "review";
  return "subscription";
}

function parseLine(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === "," || c === "，") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseCsv(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const delim = lines[0].includes("\t") ? "\t" : ",";
  const split = delim === "\t" ? (l) => l.split("\t").map((s) => s.trim()) : parseLine;
  const header = split(lines[0]);
  const idx = (names) => header.findIndex((h) => names.some((n) => h.includes(n)));
  const di = idx(["date", "日付", "利用日"]);
  const mi = idx(["description", "摘要", "内容", "店舗", "利用先", "加盟店"]);
  const ai = idx(["amount", "金額", "利用金額", "支払金額"]);
  if (di < 0 || mi < 0 || ai < 0) throw new Error("CSVの列を特定できません（日付・摘要・金額の列が必要です）");
  const rows = [];
  for (const line of lines.slice(1)) {
    const cols = split(line);
    const m = (cols[di] ?? "").replace(/\//g, "-").match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!m) continue;
    const amount = Math.abs(Number((cols[ai] ?? "").replace(/[^0-9.-]/g, "")));
    const description = cols[mi] ?? "";
    if (!description || !Number.isFinite(amount) || amount <= 0) continue;
    rows.push({ date: `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`, description, amount });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

// 貼り付け対応: ヘッダーなし明細（家計簿サイトやカード明細ページからのコピペ等）を
// 行ごとに「日付 / 摘要 / 金額（最後の数値）」として読み取るフォールバック。
export function parseStatementText(text) {
  try {
    const r = parseCsv(text);
    if (r.length > 0) return r;
  } catch { /* フォールバックへ */ }
  const rows = [];
  for (const raw of String(text).replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const dm = line.match(/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
    if (!dm) continue;
    const rest = `${line.slice(0, dm.index)} ${line.slice(dm.index + dm[0].length)}`.replace(/\t/g, " ");
    const nums = [...rest.matchAll(/\d[\d,]*\s*(?:円)?/g)]
      .map((m) => ({ v: Math.abs(Number(m[0].replace(/[^0-9]/g, ""))), i: m.index, raw: m[0] }))
      .filter((n) => n.v > 0);
    if (nums.length === 0) continue;
    const amt = nums[nums.length - 1];
    const description = `${rest.slice(0, amt.i)} ${rest.slice(amt.i + amt.raw.length)}`.replace(/[,，]/g, " ").replace(/\s+/g, " ").trim();
    if (!description) continue;
    rows.push({ date: `${dm[1]}-${dm[2].padStart(2, "0")}-${dm[3].padStart(2, "0")}`, description, amount: amt.v });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

const DAY = 86400000;
const addDays = (date, days) => { const d = new Date(`${date}T00:00:00Z`); d.setTime(d.getTime() + days * DAY); return d.toISOString().slice(0, 10); };
const diffDays = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

function detectInCluster(key, cluster) {
  if (cluster.length < 2) return null;
  const sorted = [...cluster].sort((a, b) => a.date.localeCompare(b.date));
  const intervals = [];
  for (let i = 1; i < sorted.length; i++) intervals.push(diffDays(sorted[i - 1].date, sorted[i].date));
  intervals.sort((a, b) => a - b);
  const medianInterval = intervals[Math.floor(intervals.length / 2)];
  const amounts = sorted.map((t) => t.amount);
  const typicalAmount = amounts.slice().sort((a, b) => a - b)[Math.floor(amounts.length / 2)];
  let cycleLabel, perYear;
  if (medianInterval >= 25 && medianInterval <= 35) { cycleLabel = "月額"; perYear = 12; }
  else if (medianInterval >= 330 && medianInterval <= 400) { cycleLabel = "年額"; perYear = 1; }
  else return null;
  const monthlyEquivalent = Math.round((typicalAmount * perYear) / 12);
  const displayName = sorted[sorted.length - 1].description;
  return {
    key, displayName, kind: classifyKind(displayName), count: sorted.length, typicalAmount,
    cycleLabel, monthlyEquivalent, annualEquivalent: monthlyEquivalent * 12,
    cumulative: amounts.reduce((s, n) => s + n, 0),
    firstDate: sorted[0].date, lastDate: sorted[sorted.length - 1].date,
    nextExpectedDate: addDays(sorted[sorted.length - 1].date, medianInterval),
  };
}

export function detectRecurring(txns) {
  const groups = new Map();
  for (const t of txns) {
    const key = normalizeMerchant(t.description);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const results = [];
  for (const [key, arr] of groups) {
    if (arr.length < 2) continue;
    const byAmount = [...arr].sort((a, b) => a.amount - b.amount);
    const clusters = [];
    for (const t of byAmount) {
      const c = clusters.find((cl) => Math.abs(t.amount - cl[0].amount) / cl[0].amount <= 0.05);
      if (c) c.push(t); else clusters.push([t]);
    }
    for (const cluster of clusters) {
      const r = detectInCluster(key, cluster);
      if (r) results.push(r);
    }
  }
  return results.sort((a, b) => b.monthlyEquivalent - a.monthlyEquivalent);
}

const GUIDES = [
  [/NETFLIX|ネットフリックス/, { service: "Netflix", route: "Web直契約", url: "https://www.netflix.com/cancelplan" }],
  [/SPOTIFY/, { service: "Spotify", route: "Web直契約", url: "https://www.spotify.com/account/subscription/" }],
  [/APPLE|APP STORE|ITUNES/, { service: "Apple（App Store課金）", route: "App Store", url: "https://apps.apple.com/account/subscriptions" }],
  [/GOOGLE PLAY/, { service: "Google Play課金", route: "Google Play", url: "https://play.google.com/store/account/subscriptions" }],
  [/AMAZON|アマゾン/, { service: "Amazon（Prime / Kindle Unlimited等）", route: "Amazon", url: "https://www.amazon.co.jp/membership/" }],
  [/CLAUDE|ANTHROPIC/, { service: "Claude（Anthropic）", route: "Web直契約", url: "https://claude.ai/settings/billing" }],
  [/PONTA|ポンタ|AU/, { service: "Pontaパス等（au）", route: "キャリア決済", url: "https://pass.auone.jp/" }],
];

export function findGuide(displayName) {
  const upper = String(displayName).toUpperCase();
  for (const [re, g] of GUIDES) if (re.test(upper)) return g;
  return { service: displayName, route: "不明", url: null };
}

export function summarize(recurring) {
  const subs = recurring.filter((r) => r.kind === "subscription");
  const monthlyTotal = subs.reduce((s, r) => s + r.monthlyEquivalent, 0);
  return {
    subs,
    fixed: recurring.filter((r) => r.kind === "fixed"),
    review: recurring.filter((r) => r.kind === "review"),
    monthlyTotal,
    annualTotal: monthlyTotal * 12,
    cumulativeTotal: subs.reduce((s, r) => s + r.cumulative, 0),
  };
}
