window.Tools = window.Tools || {};
Tools.split = (function () {
  let currentFile = null;
  let currentBytes = null;
  let pageCount = 0;

  async function loadFile(file, statusEl, thumbsEl, optionsEl, runBtn) {
    currentFile = file;
    Utils.setStatus(statusEl, "Загрузка...", "info");
    try {
      currentBytes = await Utils.readFileAsArrayBuffer(file);
      const pdfjsDoc = await Utils.loadPdfJsDocument(currentBytes);
      pageCount = pdfjsDoc.numPages;
      await Thumbnails.render(thumbsEl, pdfjsDoc, { targetWidth: 120 });
      optionsEl.hidden = false;
      runBtn.disabled = false;
      Utils.setStatus(statusEl, `Загружено: ${file.name} (${pageCount} стр.)`, "success");
    } catch (err) {
      console.error(err);
      Utils.setStatus(statusEl, "Ошибка чтения PDF: " + err.message, "error");
      runBtn.disabled = true;
    }
  }

  async function splitAllPages(statusEl) {
    const donor = await Utils.loadPdfLibDocument(currentBytes);
    const zip = new JSZip();
    const base = Utils.stripExtension(currentFile.name);
    const pad = String(pageCount).length;
    for (let i = 0; i < pageCount; i++) {
      const out = await PDFLib.PDFDocument.create();
      const [page] = await out.copyPages(donor, [i]);
      out.addPage(page);
      const bytes = await out.save();
      const num = String(i + 1).padStart(pad, "0");
      zip.file(`${base}_${num}.pdf`, bytes);
      Utils.setStatus(statusEl, `Обработка страницы ${i + 1} из ${pageCount}...`, "info");
    }
    const blob = await zip.generateAsync({ type: "blob" });
    Utils.downloadBlob(blob, `${base}_pages.zip`);
  }

  async function splitByRanges(rangesSpec, statusEl) {
    const groups = rangesSpec.split(";").map((s) => s.trim()).filter(Boolean);
    if (groups.length === 0) throw new Error("Укажите хотя бы один диапазон");
    const donor = await Utils.loadPdfLibDocument(currentBytes);
    const base = Utils.stripExtension(currentFile.name);
    const outputs = [];
    for (const group of groups) {
      const indices = Utils.parsePageRanges(group, pageCount);
      const out = await PDFLib.PDFDocument.create();
      const pages = await out.copyPages(donor, indices);
      pages.forEach((p) => out.addPage(p));
      outputs.push({ name: group.replace(/[^\w-]+/g, "_"), bytes: await out.save() });
    }
    if (outputs.length === 1) {
      Utils.downloadBlob(new Blob([outputs[0].bytes], { type: "application/pdf" }), `${base}_${outputs[0].name}.pdf`);
    } else {
      const zip = new JSZip();
      outputs.forEach((o, i) => zip.file(`${base}_part${i + 1}_${o.name}.pdf`, o.bytes));
      const blob = await zip.generateAsync({ type: "blob" });
      Utils.downloadBlob(blob, `${base}_split.zip`);
    }
  }

  function init() {
    const panel = document.getElementById("panel-split");
    const dropzone = panel.querySelector(".dropzone");
    const input = document.getElementById("split-input");
    const thumbsEl = document.getElementById("split-thumbs");
    const optionsEl = document.getElementById("split-options");
    const runBtn = document.getElementById("split-run");
    const statusEl = document.getElementById("split-status");
    const rangesInput = document.getElementById("split-ranges");

    Utils.wireDropzone(dropzone, input, (files) => {
      if (files[0]) loadFile(files[0], statusEl, thumbsEl, optionsEl, runBtn);
    });

    runBtn.addEventListener("click", async () => {
      const mode = panel.querySelector('input[name="split-mode"]:checked').value;
      runBtn.disabled = true;
      try {
        if (mode === "all") {
          await splitAllPages(statusEl);
        } else {
          await splitByRanges(rangesInput.value, statusEl);
        }
        Utils.setStatus(statusEl, "Готово.", "success");
      } catch (err) {
        console.error(err);
        Utils.setStatus(statusEl, "Ошибка: " + err.message, "error");
      } finally {
        runBtn.disabled = false;
      }
    });
  }

  return { init };
})();
