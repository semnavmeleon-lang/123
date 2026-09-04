window.Tools = window.Tools || {};
Tools.protect = (function () {
  let currentFile = null;
  let currentBytes = null;

  async function loadFile(file, els) {
    currentFile = file;
    Utils.setStatus(els.status, "Загрузка...", "info");
    try {
      currentBytes = await Utils.readFileAsArrayBuffer(file);
      els.options.hidden = false;
      els.run.disabled = false;
      Utils.setStatus(els.status, `Загружено: ${file.name}`, "success");
    } catch (err) {
      console.error(err);
      Utils.setStatus(els.status, "Ошибка чтения файла: " + err.message, "error");
      els.run.disabled = true;
    }
  }

  function init() {
    const els = {
      dropzone: document.querySelector("#panel-protect .dropzone"),
      input: document.getElementById("protect-input"),
      options: document.getElementById("protect-options"),
      userPass: document.getElementById("protect-user-pass"),
      ownerPass: document.getElementById("protect-owner-pass"),
      allowPrint: document.getElementById("protect-allow-print"),
      allowCopy: document.getElementById("protect-allow-copy"),
      allowModify: document.getElementById("protect-allow-modify"),
      run: document.getElementById("protect-run"),
      status: document.getElementById("protect-status"),
    };

    Utils.wireDropzone(els.dropzone, els.input, (files) => {
      if (files[0]) loadFile(files[0], els);
    });

    els.run.addEventListener("click", async () => {
      const userPassword = els.userPass.value;
      if (!userPassword) {
        Utils.setStatus(els.status, "Введите пароль для открытия документа.", "error");
        return;
      }
      els.run.disabled = true;
      Utils.setStatus(els.status, "Шифрование...", "info");
      try {
        const pdfDoc = await Utils.loadPdfLibDocument(currentBytes);
        encryptPdfDocument(pdfDoc, {
          userPassword,
          ownerPassword: els.ownerPass.value,
          permissions: {
            print: els.allowPrint.checked,
            copy: els.allowCopy.checked,
            modify: els.allowModify.checked,
          },
        });
        const bytes = await pdfDoc.save({ useObjectStreams: false, updateFieldAppearances: false });
        Utils.downloadBlob(
          new Blob([bytes], { type: "application/pdf" }),
          Utils.triggerDownloadName(currentFile.name, "_protected", "pdf")
        );
        Utils.setStatus(els.status, "Готово. Файл защищён паролем.", "success");
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
