window.Tools = window.Tools || {};
Tools.split = (function () {
  let current = null; // pool entry
  let pageCount = 0;

  async function loadCurrent(entry, els) {
    current = entry;
    if (!entry) {
      els.options.hidden = true;
      els.run.disabled = true;
      Thumbnails.clear(els.thumbs);
      return;
    }
    Utils.setStatus(els.status, "Загрузка...", "info");
    try {
      const pdfjsDoc = await Pool.getPdfDoc(entry.id);
      pageCount = pdfjsDoc.numPages;
      await Thumbnails.render(els.thumbs, pdfjsDoc, { targetWidth: 120 });
      els.options.hidden = false;
      els.run.disabled = false;
      Utils.setStatus(els.status, `Загружено: ${entry.name} (${pageCount} стр.)`, "success");
    } catch (err) {
      console.error(err);
      Utils.setStatus(els.status, "Ошибка чтения PDF: " + err.message, "error");
      els.run.disabled = true;
    }
  }

  async function splitAllPages(statusEl) {
    const bytes = await Pool.getBytes(current.id);
    const donor = await Utils.loadPdfLibDocument(bytes);
    const zip = new JSZip();
    const base = Utils.stripExtension(current.name);
    const pad = String(pageCount).length;
    for (let i = 0; i < pageCount; i++) {
      const out = await PDFLib.PDFDocument.create();
      const [page] = await out.copyPages(donor, [i]);
      out.addPage(page);
      const outBytes = await out.save();
      const num = String(i + 1).padStart(pad, "0");
      zip.file(`${base}_${num}.pdf`, outBytes);
      Utils.setStatus(statusEl, `Обработка страницы ${i + 1} из ${pageCount}...`, "info");
    }
    const blob = await zip.generateAsync({ type: "blob" });
    Utils.downloadBlob(blob, `${base}_pages.zip`);
  }

  async function splitByRanges(rangesSpec, statusEl) {
    const groups = rangesSpec.split(";").map((s) => s.trim()).filter(Boolean);
    if (groups.length === 0) throw new Error("Укажите хотя бы один диапазон");
    const bytes = await Pool.getBytes(current.id);
    const donor = await Utils.loadPdfLibDocument(bytes);
    const base = Utils.stripExtension(current.name);
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
    const picker = document.getElementById("split-picker");
    const els = {
      thumbs: document.getElementById("split-thumbs"),
      options: document.getElementById("split-options"),
      run: document.getElementById("split-run"),
      status: document.getElementById("split-status"),
      rangesInput: document.getElementById("split-ranges"),
    };

    FilePicker.mount(picker, {
      accept: "pdf",
      multi: false,
      onChange: (selected) => loadCurrent(selected[0] || null, els),
    });

    els.run.addEventListener("click", async () => {
      const mode = document.querySelector('input[name="split-mode"]:checked').value;
      els.run.disabled = true;
      try {
        if (mode === "all") {
          await splitAllPages(els.status);
        } else {
          await splitByRanges(els.rangesInput.value, els.status);
        }
        Utils.setStatus(els.status, "Готово.", "success");
      } catch (err) {
        console.error(err);
        Utils.setStatus(els.status, "Ошибка: " + err.message, "error");
      } finally {
        els.run.disabled = false;
      }
    });
  }

  return { init };
})();
