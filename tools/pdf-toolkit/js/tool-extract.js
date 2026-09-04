window.Tools = window.Tools || {};
Tools.extract = (function () {
  let currentFile = null;
  let currentBytes = null;
  let cards = [];

  function addCheckbox(card) {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.addEventListener("change", () => {
      card.wrapper.classList.toggle("selected", checkbox.checked);
    });
    card.wrapper.insertBefore(checkbox, card.wrapper.firstChild);
    card.checkbox = checkbox;
    card.wrapper.classList.add("selected");
  }

  async function loadFile(file, els) {
    currentFile = file;
    Utils.setStatus(els.status, "Загрузка...", "info");
    try {
      currentBytes = await Utils.readFileAsArrayBuffer(file);
      const pdfjsDoc = await Utils.loadPdfJsDocument(currentBytes);
      cards = await Thumbnails.render(els.thumbs, pdfjsDoc, {
        targetWidth: 120,
        onCardBuilt: addCheckbox,
      });
      els.options.hidden = false;
      els.run.disabled = false;
      Utils.setStatus(els.status, `Загружено: ${file.name} (${cards.length} стр.)`, "success");
    } catch (err) {
      console.error(err);
      Utils.setStatus(els.status, "Ошибка чтения PDF: " + err.message, "error");
      els.run.disabled = true;
    }
  }

  function init() {
    const els = {
      panel: document.getElementById("panel-extract"),
      dropzone: document.querySelector("#panel-extract .dropzone"),
      input: document.getElementById("extract-input"),
      thumbs: document.getElementById("extract-thumbs"),
      options: document.getElementById("extract-options"),
      run: document.getElementById("extract-run"),
      status: document.getElementById("extract-status"),
      rangeInput: document.getElementById("extract-range"),
      applyRange: document.getElementById("extract-apply-range"),
      selectAll: document.getElementById("extract-select-all"),
      selectNone: document.getElementById("extract-select-none"),
    };

    Utils.wireDropzone(els.dropzone, els.input, (files) => {
      if (files[0]) loadFile(files[0], els);
    });

    els.applyRange.addEventListener("click", () => {
      try {
        const indices = new Set(Utils.parsePageRanges(els.rangeInput.value, cards.length));
        cards.forEach((c) => {
          c.checkbox.checked = indices.has(c.index);
          c.wrapper.classList.toggle("selected", c.checkbox.checked);
        });
        Utils.setStatus(els.status, "", "");
      } catch (err) {
        Utils.setStatus(els.status, "Ошибка: " + err.message, "error");
      }
    });

    els.selectAll.addEventListener("click", () => {
      cards.forEach((c) => {
        c.checkbox.checked = true;
        c.wrapper.classList.add("selected");
      });
    });

    els.selectNone.addEventListener("click", () => {
      cards.forEach((c) => {
        c.checkbox.checked = false;
        c.wrapper.classList.remove("selected");
      });
    });

    els.run.addEventListener("click", async () => {
      const selected = cards.filter((c) => c.checkbox.checked).map((c) => c.index);
      if (selected.length === 0) {
        Utils.setStatus(els.status, "Выберите хотя бы одну страницу.", "error");
        return;
      }
      els.run.disabled = true;
      Utils.setStatus(els.status, "Сохранение...", "info");
      try {
        const donor = await Utils.loadPdfLibDocument(currentBytes);
        const out = await PDFLib.PDFDocument.create();
        const pages = await out.copyPages(donor, selected);
        pages.forEach((p) => out.addPage(p));
        const bytes = await out.save();
        Utils.downloadBlob(
          new Blob([bytes], { type: "application/pdf" }),
          Utils.triggerDownloadName(currentFile.name, "_extracted", "pdf")
        );
        Utils.setStatus(els.status, `Готово: сохранено страниц — ${selected.length}.`, "success");
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
