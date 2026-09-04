window.Tools = window.Tools || {};
Tools["extract-text"] = (function () {
  let current = null;
  let pdfjsDoc = null;
  let extractedText = "";

  async function loadCurrent(entry, els) {
    current = entry;
    els.output.value = "";
    els.download.disabled = true;
    if (!entry) {
      els.run.disabled = true;
      return;
    }
    Utils.setStatus(els.status, "Загрузка...", "info");
    try {
      pdfjsDoc = await Pool.getPdfDoc(entry.id);
      els.run.disabled = false;
      Utils.setStatus(els.status, `Загружено: ${entry.name} (${pdfjsDoc.numPages} стр.)`, "success");
    } catch (err) {
      console.error(err);
      Utils.setStatus(els.status, "Ошибка чтения PDF: " + err.message, "error");
      els.run.disabled = true;
    }
  }

  function init() {
    const picker = document.getElementById("exttext-picker");
    const els = {
      run: document.getElementById("exttext-run"),
      download: document.getElementById("exttext-download"),
      output: document.getElementById("exttext-output"),
      status: document.getElementById("exttext-status"),
    };

    FilePicker.mount(picker, {
      accept: "pdf",
      multi: false,
      onChange: (selected) => loadCurrent(selected[0] || null, els),
    });

    els.run.addEventListener("click", async () => {
      els.run.disabled = true;
      els.output.value = "";
      const parts = [];
      try {
        const numPages = pdfjsDoc.numPages;
        for (let i = 1; i <= numPages; i++) {
          Utils.setStatus(els.status, `Извлечение текста: страница ${i} из ${numPages}...`, "info");
          const page = await pdfjsDoc.getPage(i);
          const content = await page.getTextContent();
          const pageText = content.items.map((it) => it.str + (it.hasEOL ? "\n" : " ")).join("");
          parts.push(`----- Страница ${i} -----\n${pageText.trim()}`);
        }
        extractedText = parts.join("\n\n");
        els.output.value = extractedText;
        els.download.disabled = extractedText.length === 0;
        Utils.setStatus(els.status, `Готово: извлечено страниц — ${numPages}.`, "success");
      } catch (err) {
        console.error(err);
        Utils.setStatus(els.status, "Ошибка: " + err.message, "error");
      } finally {
        els.run.disabled = false;
      }
    });

    els.download.addEventListener("click", () => {
      const blob = new Blob([extractedText], { type: "text/plain;charset=utf-8" });
      Utils.downloadBlob(blob, Utils.triggerDownloadName(current.name, "", "txt"));
    });
  }

  return { init };
})();
