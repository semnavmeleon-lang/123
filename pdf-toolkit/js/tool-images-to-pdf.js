window.Tools = window.Tools || {};
Tools["images-to-pdf"] = (function () {
  let items = []; // { file, objectUrl, wrapper }
  let draggedItem = null;
  let containerEl = null;

  const PAGE_SIZES = {
    a4: [595.28, 841.89],
    letter: [612, 792],
  };

  function applyDomOrder() {
    items.forEach((item) => containerEl.appendChild(item.wrapper));
  }

  function moveItem(fromPos, toPos) {
    const [item] = items.splice(fromPos, 1);
    items.splice(toPos, 0, item);
    applyDomOrder();
  }

  function buildCard(item) {
    const wrapper = document.createElement("div");
    wrapper.className = "thumb-card";
    wrapper.draggable = true;

    const img = document.createElement("img");
    img.src = item.objectUrl;
    img.style.maxHeight = "150px";
    wrapper.appendChild(img);

    const label = document.createElement("div");
    label.className = "thumb-label";
    label.textContent = item.file.name;
    wrapper.appendChild(label);

    const controls = document.createElement("div");
    controls.className = "thumb-controls";
    const removeBtn = document.createElement("button");
    removeBtn.textContent = "✕ Убрать";
    removeBtn.addEventListener("click", () => {
      items = items.filter((it) => it !== item);
      wrapper.remove();
      onListChanged();
    });
    controls.appendChild(removeBtn);
    wrapper.appendChild(controls);

    wrapper.addEventListener("dragstart", (e) => {
      draggedItem = item;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", item.file.name);
    });
    wrapper.addEventListener("dragover", (e) => {
      e.preventDefault();
      wrapper.classList.add("drag-over");
    });
    wrapper.addEventListener("dragleave", () => wrapper.classList.remove("drag-over"));
    wrapper.addEventListener("drop", (e) => {
      e.preventDefault();
      wrapper.classList.remove("drag-over");
      if (!draggedItem || draggedItem === item) return;
      moveItem(items.indexOf(draggedItem), items.indexOf(item));
      draggedItem = null;
    });

    item.wrapper = wrapper;
    return wrapper;
  }

  let onListChangedCb = () => {};
  function onListChanged() {
    onListChangedCb();
  }

  async function toPngBytes(file) {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
  }

  async function embedImage(pdfDoc, file) {
    const type = file.type;
    if (type === "image/jpeg" || type === "image/jpg") {
      const bytes = new Uint8Array(await file.arrayBuffer());
      return pdfDoc.embedJpg(bytes);
    }
    if (type === "image/png") {
      const bytes = new Uint8Array(await file.arrayBuffer());
      return pdfDoc.embedPng(bytes);
    }
    // Fallback (e.g. WebP, GIF, BMP): re-encode as PNG via canvas.
    const pngBytes = await toPngBytes(file);
    return pdfDoc.embedPng(pngBytes);
  }

  function init() {
    const els = {
      dropzone: document.querySelector("#panel-images-to-pdf .dropzone"),
      input: document.getElementById("img2pdf-input"),
      thumbs: document.getElementById("img2pdf-thumbs"),
      options: document.getElementById("img2pdf-options"),
      pageSize: document.getElementById("img2pdf-pagesize"),
      run: document.getElementById("img2pdf-run"),
      status: document.getElementById("img2pdf-status"),
    };
    containerEl = els.thumbs;
    onListChangedCb = () => {
      const has = items.length > 0;
      els.options.hidden = !has;
      els.run.disabled = !has;
    };

    Utils.wireDropzone(els.dropzone, els.input, (files) => {
      const imgFiles = files.filter((f) => f.type.startsWith("image/"));
      if (imgFiles.length === 0) {
        Utils.setStatus(els.status, "Выберите файлы изображений (JPG, PNG, WebP).", "error");
        return;
      }
      for (const file of imgFiles) {
        const item = { file, objectUrl: URL.createObjectURL(file) };
        items.push(item);
        els.thumbs.appendChild(buildCard(item));
      }
      Utils.setStatus(els.status, "", "");
      onListChanged();
    });

    els.run.addEventListener("click", async () => {
      els.run.disabled = true;
      Utils.setStatus(els.status, "Создание PDF...", "info");
      try {
        const pdfDoc = await PDFLib.PDFDocument.create();
        const pageSizeMode = els.pageSize.value;
        for (const item of items) {
          const embedded = await embedImage(pdfDoc, item.file);
          if (pageSizeMode === "fit") {
            const page = pdfDoc.addPage([embedded.width, embedded.height]);
            page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
          } else {
            const [pw, ph] = PAGE_SIZES[pageSizeMode];
            const page = pdfDoc.addPage([pw, ph]);
            const scale = Math.min(pw / embedded.width, ph / embedded.height);
            const w = embedded.width * scale;
            const h = embedded.height * scale;
            page.drawImage(embedded, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
          }
        }
        const bytes = await pdfDoc.save();
        Utils.downloadBlob(new Blob([bytes], { type: "application/pdf" }), "images.pdf");
        Utils.setStatus(els.status, `Готово: создан PDF из ${items.length} изображений.`, "success");
      } catch (err) {
        console.error(err);
        Utils.setStatus(els.status, "Ошибка: " + err.message, "error");
      } finally {
        els.run.disabled = items.length === 0;
      }
    });
  }

  return { init };
})();
