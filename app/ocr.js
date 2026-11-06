// スクリーンショットOCR取り込み（サブポイ無料スキャンの3つ目の導線）
//
// プライバシー設計:
// - 画像・読み取り結果はブラウザ内でのみ処理し、外部に送信しない。
// - OCRエンジン（Tesseract.js）本体・ワーカー・WASMコア・日本語/英語の学習
//   データは app/vendor/tesseract/ に自前ホストし、実行時に外部CDNへ
//   アクセスしない。取得元と内訳は vendor/tesseract/ 内の LICENSE 類を参照。
// - このモジュール自体は app.js から静的に import されるが、重いOCR資産
//   （約17MB）は「スクリーンショット」導線で画像が選ばれたときだけ
//   動的に読み込む。初期表示・CSV・貼り付け導線には影響しない。
//
// フロー:
//   画像（複数可）→ OCR → 既存パーサ parseStatementText で候補行を抽出
//   → 確認・修正画面（編集可能な一覧）→ CSVテキスト化 → 既存 render() へ。

const VENDOR_BASE = new URL("./vendor/tesseract/", import.meta.url).href;
let libPromise = null;

function loadLib() {
  if (!libPromise) {
    libPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = `${VENDOR_BASE}tesseract.min.js`;
      s.onload = () => resolve(window.Tesseract);
      s.onerror = () => reject(new Error("OCRエンジンの読み込みに失敗しました。通信環境を確認して、もう一度お試しください。"));
      document.head.appendChild(s);
    });
  }
  return libPromise;
}

// 小さい画像はOCRの精度が落ちるため、幅1600px未満は白背景で拡大してから読む。
async function prepareImage(file) {
  try {
    const bmp = await createImageBitmap(file);
    const TARGET = 1600;
    if (bmp.width >= TARGET) { bmp.close(); return file; }
    const scale = Math.min(3, TARGET / bmp.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
    return blob || file;
  } catch {
    return file;
  }
}

async function recognizeImages(files, onProgress) {
  const Tesseract = await loadLib();
  const worker = await Tesseract.createWorker(["jpn", "eng"], Tesseract.OEM.LSTM_ONLY, {
    workerPath: `${VENDOR_BASE}worker.min.js`,
    corePath: `${VENDOR_BASE}core`,
    langPath: `${VENDOR_BASE}lang`,
    logger: (m) => {
      if (m.status === "recognizing text") onProgress(m.progress);
    },
  });
  try {
    let text = "";
    for (let i = 0; i < files.length; i++) {
      onProgress(0, i, files.length);
      const { data } = await worker.recognize(await prepareImage(files[i]));
      text += `${data.text}\n`;
    }
    return text;
  } finally {
    await worker.terminate();
  }
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function setupOcr({ parseStatementText, render }) {
  const input = document.getElementById("ocrFile");
  const drop = document.getElementById("ocrDrop");
  const status = document.getElementById("ocrStatus");
  const review = document.getElementById("ocrReview");
  const rowsEl = document.getElementById("ocrRows");
  const errEl = document.getElementById("ocrErr");
  if (!input || !drop || !status || !review || !rowsEl) return;

  const setStatus = (html) => {
    status.innerHTML = html;
    status.classList.toggle("on", Boolean(html));
  };

  function rowHtml(r) {
    return `<div class="ocr-row">
<input type="date" class="ocr-date" value="${esc(r.date)}" aria-label="日付">
<input type="text" class="ocr-desc" value="${esc(r.description)}" placeholder="利用先・摘要" aria-label="摘要">
<input type="number" class="ocr-amt" value="${esc(r.amount)}" min="0" step="1" inputmode="numeric" aria-label="金額">
<button type="button" class="ocr-del" aria-label="この行を削除">削除</button>
</div>`;
  }

  function addRow(r) {
    const div = document.createElement("div");
    div.innerHTML = rowHtml(r);
    const row = div.firstElementChild;
    row.querySelector(".ocr-del").addEventListener("click", () => row.remove());
    rowsEl.appendChild(row);
  }

  function collectRows() {
    const rows = [];
    for (const row of rowsEl.querySelectorAll(".ocr-row")) {
      const date = row.querySelector(".ocr-date").value.trim();
      const description = row.querySelector(".ocr-desc").value.trim();
      const amount = Number(row.querySelector(".ocr-amt").value);
      if (!date && !description && !amount) continue; // 完全な空行はスキップ
      rows.push({ date, description, amount, row });
    }
    return rows;
  }

  function showReview(rows, rawText) {
    rowsEl.innerHTML = "";
    errEl.hidden = true;
    for (const r of rows) addRow(r);
    review.hidden = false;
    review.dataset.raw = rawText;
    review.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  document.getElementById("ocrAddRow").addEventListener("click", () => {
    addRow({ date: "", description: "", amount: "" });
  });

  document.getElementById("ocrCancel").addEventListener("click", () => {
    review.hidden = true;
    setStatus("");
  });

  document.getElementById("ocrConfirm").addEventListener("click", () => {
    const rows = collectRows();
    const bad = rows.filter((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !r.description || !Number.isFinite(r.amount) || r.amount <= 0);
    if (rows.length === 0 || bad.length > 0) {
      for (const r of rows) r.row.classList.toggle("bad", bad.includes(r));
      errEl.textContent = rows.length === 0
        ? "明細の行がありません。行を追加するか、画像を選び直してください。"
        : "日付・摘要・金額がそろっていない行があります（赤枠）。直してからもう一度押してください。";
      errEl.hidden = false;
      return;
    }
    errEl.hidden = true;
    const csvEscape = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const text = ["date,description,amount", ...rows.map((r) => `${r.date},${csvEscape(r.description)},${r.amount}`)].join("\n");
    review.hidden = true;
    setStatus("");
    render(text);
    document.getElementById("result").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  async function handleFiles(files) {
    const images = [...files].filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) {
      setStatus("画像ファイルが選ばれていません。PNG / JPEG などのスクリーンショットを選んでください。");
      return;
    }
    input.disabled = true;
    review.hidden = true;
    try {
      setStatus("読み取りエンジンを準備しています…（初回は少し時間がかかります）");
      const text = await recognizeImages(images, (progress, i, n) => {
        if (i !== undefined) setStatus(`画像 ${i + 1} / ${n} を読み取り中…`);
        else if (typeof progress === "number") setStatus(`読み取り中… ${Math.round(progress * 100)}%`);
      });
      const rows = parseStatementText(text);
      if (rows.length === 0) {
        // 候補行が取れなかった場合は、読み取った文章を貼り付け欄へ渡して手直しできるようにする
        const paste = document.getElementById("paste");
        if (paste && text.trim()) paste.value = text.trim();
        setStatus("明細の行を読み取れませんでした。読み取った文章を「貼り付けるだけでもOK」の欄に入れたので、形式を直して解析できます。画像が小さい・暗い場合は、より大きくはっきりしたスクリーンショットでお試しください。");
        return;
      }
      setStatus(`読み取りが完了しました（${rows.length}件）。下の確認画面で内容を確かめてください。`);
      showReview(rows, text);
    } catch (e) {
      setStatus(`読み取りに失敗しました。${esc(e.message || "")} 明細ファイルや貼り付けでも取り込めます。`);
    } finally {
      input.disabled = false;
      input.value = "";
    }
  }

  input.addEventListener("change", (ev) => handleFiles(ev.target.files));
  drop.addEventListener("dragover", (ev) => { ev.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (ev) => {
    ev.preventDefault();
    drop.classList.remove("over");
    handleFiles(ev.dataTransfer.files);
  });
}
