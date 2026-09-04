window.Tools = window.Tools || {};
Tools.metadata = (function () {
  let current = null;
  let pdfDocRef = null;

  function fmtDate(d) {
    try {
      return d ? d.toLocaleString() : null;
    } catch (e) {
      return null;
    }
  }

  async function loadCurrent(entry, els) {
    current = entry;
    if (!entry) {
      els.form.hidden = true;
      els.run.disabled = true;
      return;
    }
    Utils.setStatus(els.status, "Загрузка...", "info");
    try {
      const bytes = await Pool.getBytes(entry.id);
      pdfDocRef = await Utils.loadPdfLibDocument(bytes);
      els.title.value = pdfDocRef.getTitle() || "";
      els.author.value = pdfDocRef.getAuthor() || "";
      els.subject.value = pdfDocRef.getSubject() || "";
      els.keywords.value = pdfDocRef.getKeywords() || "";
      els.creator.value = pdfDocRef.getCreator() || "";
      els.producer.value = pdfDocRef.getProducer() || "";
      const created = fmtDate(pdfDocRef.getCreationDate());
      const modified = fmtDate(pdfDocRef.getModificationDate());
      els.readonly.textContent =
        `Страниц: ${pdfDocRef.getPageCount()}` +
        (created ? ` · Создан: ${created}` : "") +
        (modified ? ` · Изменён: ${modified}` : "");
      els.form.hidden = false;
      els.run.disabled = false;
      Utils.setStatus(els.status, `Загружено: ${entry.name}`, "success");
    } catch (err) {
      console.error(err);
      Utils.setStatus(els.status, "Ошибка чтения PDF: " + err.message, "error");
      els.run.disabled = true;
    }
  }

  function init() {
    const picker = document.getElementById("meta-picker");
    const els = {
      form: document.getElementById("meta-form"),
      title: document.getElementById("meta-title"),
      author: document.getElementById("meta-author"),
      subject: document.getElementById("meta-subject"),
      keywords: document.getElementById("meta-keywords"),
      creator: document.getElementById("meta-creator"),
      producer: document.getElementById("meta-producer"),
      readonly: document.getElementById("meta-readonly"),
      run: document.getElementById("meta-run"),
      status: document.getElementById("meta-status"),
    };

    FilePicker.mount(picker, {
      accept: "pdf",
      multi: false,
      onChange: (selected) => loadCurrent(selected[0] || null, els),
    });

    els.run.addEventListener("click", async () => {
      els.run.disabled = true;
      Utils.setStatus(els.status, "Сохранение...", "info");
      try {
        pdfDocRef.setTitle(els.title.value);
        pdfDocRef.setAuthor(els.author.value);
        pdfDocRef.setSubject(els.subject.value);
        const keywords = els.keywords.value.split(",").map((s) => s.trim()).filter(Boolean);
        pdfDocRef.setKeywords(keywords);
        pdfDocRef.setCreator(els.creator.value);
        pdfDocRef.setProducer(els.producer.value);
        pdfDocRef.setModificationDate(new Date());
        const bytes = await pdfDocRef.save();
        Utils.downloadBlob(
          new Blob([bytes], { type: "application/pdf" }),
          Utils.triggerDownloadName(current.name, "_meta", "pdf")
        );
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
