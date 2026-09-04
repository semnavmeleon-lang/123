window.Tools = window.Tools || {};
Tools.protect = (function () {
  let selectedEntries = [];

  function init() {
    const picker = document.getElementById("protect-picker");
    const els = {
      options: document.getElementById("protect-options"),
      userPass: document.getElementById("protect-user-pass"),
      ownerPass: document.getElementById("protect-owner-pass"),
      allowPrint: document.getElementById("protect-allow-print"),
      allowCopy: document.getElementById("protect-allow-copy"),
      allowModify: document.getElementById("protect-allow-modify"),
      run: document.getElementById("protect-run"),
      status: document.getElementById("protect-status"),
    };

    FilePicker.mount(picker, {
      accept: "pdf",
      multi: true,
      onChange: (selected) => {
        selectedEntries = selected;
        els.options.hidden = selected.length === 0;
        els.run.disabled = selected.length === 0;
      },
    });

    els.run.addEventListener("click", async () => {
      const userPassword = els.userPass.value;
      if (!userPassword) {
        Utils.setStatus(els.status, "Введите пароль для открытия документа.", "error");
        return;
      }
      if (selectedEntries.length === 0) return;
      els.run.disabled = true;
      Utils.setStatus(els.status, "Шифрование...", "info");
      const permissions = {
        print: els.allowPrint.checked,
        copy: els.allowCopy.checked,
        modify: els.allowModify.checked,
      };
      try {
        const outputs = [];
        for (let i = 0; i < selectedEntries.length; i++) {
          const entry = selectedEntries[i];
          Utils.setStatus(els.status, `Обработка ${i + 1} из ${selectedEntries.length}: ${entry.name}...`, "info");
          const bytes = await Pool.getBytes(entry.id);
          const pdfDoc = await Utils.loadPdfLibDocument(bytes);
          encryptPdfDocument(pdfDoc, { userPassword, ownerPassword: els.ownerPass.value, permissions });
          const outBytes = await pdfDoc.save({ useObjectStreams: false, updateFieldAppearances: false });
          outputs.push({ name: Utils.triggerDownloadName(entry.name, "_protected", "pdf"), bytes: outBytes });
        }
        if (outputs.length === 1) {
          Utils.downloadBlob(new Blob([outputs[0].bytes], { type: "application/pdf" }), outputs[0].name);
        } else {
          const zip = new JSZip();
          outputs.forEach((o) => zip.file(o.name, o.bytes));
          const blob = await zip.generateAsync({ type: "blob" });
          Utils.downloadBlob(blob, "protected.zip");
        }
        Utils.setStatus(els.status, `Готово: защищено файлов — ${outputs.length}.`, "success");
      } catch (err) {
        console.error(err);
        Utils.setStatus(els.status, "Ошибка: " + err.message, "error");
      } finally {
        els.run.disabled = selectedEntries.length === 0;
      }
    });
  }

  return { init };
})();
