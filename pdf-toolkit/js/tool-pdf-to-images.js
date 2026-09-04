window.Tools = window.Tools || {};
Tools["pdf-to-images"] = (function () {
  let currentFile = null;
  let pdfjsDoc = null;

  async function loadFile(file, els) {
    currentFile = file;
    Utils.setStatus(els.status, "Загрузка...", "info");
    try {
      const bytes = await Utils.readFileAsArrayBuffer(file);
      pdfjsDoc = await Utils.loadPdfJsDocument(bytes);
      await Thumbnails.render(els.thumbs, pdfjsDoc, { targetWidth: 120 });
      els.options.hidden = false;
      els.run.disabled = false;
      Utils.setStatus(els.status, `Загружено: ${file.name} (${pdfjsDoc.numPages} стр.)`, "success");
    } catch (err) {
      console.error(err);
      Utils.setStatus(els.status, "Ошибка чтения PDF: " + err.message, "error");
      els.run.disabled = true;
    }
  }

  function canvasToBlob(canvas, mime, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
  }

  async function init() {
    const els = {
      dropzone: document.querySelector("#panel-pdf-to-images .dropzone"),
      input: document.getElementById("pdf2img-input"),
      thumbs: document.getElementById("pdf2img-thumbs"),
      options: document.getElementById("pdf2img-options"),
      format: document.getElementById("pdf2img-format"),
      scale: document.getElementById("pdf2img-scale"),
      run: document.getElementById("pdf2img-run"),
      status: document.getElementById("pdf2img-status"),
    };

    Utils.wireDropzone(els.dropzone, els.input, (files) => {
      if (files[0]) loadFile(files[0], els);
    });

    els.run.addEventListener("click", async () => {
      els.run.disabled = true;
      const format = els.format.value;
      const mime = format === "png" ? "image/png" : "image/jpeg";
      const ext = format === "png" ? "png" : "jpg";
      const scale = parseFloat(els.scale.value);
      const base = Utils.stripExtension(currentFile.name);
      try {
        const numPages = pdfjsDoc.numPages;
        const blobs = [];
        for (let i = 1; i <= numPages; i++) {
          Utils.setStatus(els.status, `Рендеринг страницы ${i} из ${numPages}...`, "info");
          const page = await pdfjsDoc.getPage(i);
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          const ctx = canvas.getContext("2d");
          if (format === "jpeg") {
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
          }
          await page.render({ canvasContext: ctx, viewport }).promise;
          const blob = await canvasToBlob(canvas, mime, 0.92);
          blobs.push(blob);
        }
        const pad = String(numPages).length;
        if (numPages === 1) {
          Utils.downloadBlob(blobs[0], `${base}.${ext}`);
        } else {
          const zip = new JSZip();
          blobs.forEach((blob, i) => zip.file(`${base}_${String(i + 1).padStart(pad, "0")}.${ext}`, blob));
          const zipBlob = await zip.generateAsync({ type: "blob" });
          Utils.downloadBlob(zipBlob, `${base}_images.zip`);
        }
        Utils.setStatus(els.status, `Готово: экспортировано страниц — ${numPages}.`, "success");
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
