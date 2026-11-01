import { parseCsv, detectRecurring, summarize, findGuide } from "./core.js";

const yen = (n) => `¥${n.toLocaleString("ja-JP")}`;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const SAMPLE = `date,description,amount
2025-12-05,NETFLIX,1190
2025-12-15,PONTAパス,548
2025-12-20,AMAZON DOWNLOADS,980
2025-12-25,SPOTIFY,980
2026-01-05,NETFLIX,1190
2026-01-15,PONTAパス,548
2026-01-20,AMAZON DOWNLOADS,980
2026-01-25,SPOTIFY,980
2026-02-05,NETFLIX,1190
2026-02-15,PONTAパス,548
2026-02-20,AMAZON DOWNLOADS,980
2026-02-25,SPOTIFY,980
2026-03-05,NETFLIX,1190
2026-03-15,PONTAパス,548
2026-03-20,AMAZON DOWNLOADS,980
2026-03-25,SPOTIFY,980
2026-05-10,スーパーマーケット,8420
2025-06-10,AMAZON PRIME,5900
2026-06-10,AMAZON PRIME,5900`;

function render(text) {
  const result = document.getElementById("result");
  const after = document.getElementById("after");
  let txns;
  try {
    txns = parseCsv(text);
  } catch (e) {
    result.innerHTML = `<p class="err">${esc(e.message)}</p>`;
    after.hidden = true;
    return;
  }
  if (txns.length === 0) {
    result.innerHTML = `<p class="err">取引を読み取れませんでした。CSVの形式（日付・摘要・金額の列）を確認してください。</p>`;
    after.hidden = true;
    return;
  }
  const s = summarize(detectRecurring(txns));
  const cards = s.subs.map((r) => {
    const g = findGuide(r.displayName);
    return `<div class="card"><h3>${esc(r.displayName)}</h3>
<p class="amt">${yen(r.monthlyEquivalent)}<span>/月換算（${r.cycleLabel} ${yen(r.typicalAmount)}）</span></p>
<p>累計 ${yen(r.cumulative)}（${r.count}回） / 初回 ${r.firstDate} / 次回予定 ${r.nextExpectedDate}</p>
<p>解約すると今後12ヶ月で <strong>${yen(r.annualEquivalent)}</strong> の削減見込み</p>
<p class="route">課金経路: ${esc(g.route)}</p>
${g.url ? `<p><a href="${esc(g.url)}" target="_blank" rel="noopener">解約ページを開く（${esc(g.service)}）</a></p>` : ""}</div>`;
  }).join("\n");
  const fixedList = s.fixed.length ? `<h2>固定費（サブスク対象外）</h2><ul>${s.fixed.map((r) => `<li>${esc(r.displayName)}: 月額換算 ${yen(r.monthlyEquivalent)} / 累計 ${yen(r.cumulative)}（${r.count}回）</li>`).join("")}</ul>` : "";
  const reviewList = s.review.length ? `<h2>要確認（買い物の可能性があるもの）</h2><p class="note">合計には含めていません。</p><ul>${s.review.map((r) => `<li>${esc(r.displayName)}: ${yen(r.typicalAmount)} × ${r.count}回 / 累計 ${yen(r.cumulative)}</li>`).join("")}</ul>` : "";
  result.innerHTML = `
<h2>スキャン結果</h2>
<p>対象明細 ${txns.length}件 / 検出された定期課金 ${s.subs.length}件</p>
<div class="summary">
<div class="box"><div class="k">今月のサブスク合計（月額換算）</div><div class="v">${yen(s.monthlyTotal)}</div></div>
<div class="box"><div class="k">年換算</div><div class="v">${yen(s.annualTotal)}</div></div>
<div class="box"><div class="k">推定累計支払額（明細の範囲内）</div><div class="v">${yen(s.cumulativeTotal)}</div></div>
<div class="box"><div class="k">このまま続けると今後12ヶ月</div><div class="v">${yen(s.annualTotal)}</div></div>
</div>
<div class="cards">${cards}</div>
${fixedList}
${reviewList}
<p class="note">検出は明細の表記と周期からの推定です。実際の契約内容と異なる場合があります。解約の確定操作は、契約者本人が事業者の定める方法で行ってください。</p>`;
  after.hidden = false;
}

document.getElementById("file").addEventListener("change", async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  const buf = await f.arrayBuffer();
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder("shift_jis").decode(buf);
  }
  render(text);
});

document.getElementById("sample").addEventListener("click", (ev) => {
  ev.preventDefault();
  render(SAMPLE);
});
