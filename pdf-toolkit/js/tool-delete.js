window.Tools = window.Tools || {};
Tools.delete = (function () {
  let currentFile = null;
  let currentBytes = null;
  let cards = [];

  function addCheckbox(card) {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = false;
    checkbox.addEventListener("change", () => {
      card.wrapper.classList.toggle("marked-remove", checkbox.checked);
    });
    card.wrapper.insertBefore(checkbox, card.wrapper.firstChild);
    card.checkbox = checkbox;
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
      dropzone: document.querySelector("#panel-delete .dropzone"),
      input: document.getElementById("delete-input"),
      thumbs: document.getElementById("delete-thumbs"),
      options: document.getElementById("delete-options"),
      run: document.getElementById("delete-run"),
      status: document.getElementById("delete-status"),
      rangeInput: document.getElementById("delete-range"),
      applyRange: document.getElementById("delete-apply-range"),
      selectNone: document.getElementById("delete-select-none"),
    };

    Utils.wireDropzone(els.dropzone, els.input, (files) => {
      if (files[0]) loadFile(files[0], els);
    });

    els.applyRange.addEventListener("click", () => {
      try {
        const indices = new Set(Utils.parsePageRanges(els.rangeInput.value, cards.length));
        cards.forEach((c) => {
          c.checkbox.checked = indices.has(c.index);
          c.wrapper.classList.toggle("marked-remove", c.checkbox.checked);
        });
        Utils.setStatus(els.status, "", "");
      } catch (err) {
        Utils.setStatus(els.status, "Ошибка: " + err.message, "error");
      }
    });

    els.selectNone.addEventListener("click", () => {
      cards.forEach((c) => {
        c.checkbox.checked = false;
        c.wrapper.classList.remove("marked-remove");
      });
    });

    els.run.addEventListener("click", async () => {
      const toRemove = new Set(cards.filter((c) => c.checkbox.checked).map((c) => c.index));
      const keep = cards.map((c) => c.index).filter((i) => !toRemove.has(i));
      if (keep.length === 0) {
        Utils.setStatus(els.status, "Нельзя удалить все страницы документа.", "error");
        return;
      }
      if (toRemove.size === 0) {
        Utils.setStatus(els.status, "Отметьте страницы для удаления.", "error");
        return;
      }
      els.run.disabled = true;
      Utils.setStatus(els.status, "Сохранение...", "info");
      try {
        const donor = await Utils.loadPdfLibDocument(currentBytes);
        const out = await PDFLib.PDFDocument.create();
        const pages = await out.copyPages(donor, keep);
        pages.forEach((p) => out.addPage(p));
        const bytes = await out.save();
        Utils.downloadBlob(
          new Blob([bytes], { type: "application/pdf" }),
          Utils.triggerDownloadName(currentFile.name, "_edited", "pdf")
        );
        Utils.setStatus(els.status, `Готово: удалено страниц — ${toRemove.size}.`, "success");
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
