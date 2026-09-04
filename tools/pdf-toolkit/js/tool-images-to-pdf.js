window.Tools = window.Tools || {};
Tools["images-to-pdf"] = (function () {
  let order = []; // pool entries, in page order
  let draggedItem = null;
  let containerEl = null;
  const objectUrls = new Map();

  const PAGE_SIZES = {
    a4: [595.28, 841.89],
    letter: [612, 792],
  };

  function objectUrlFor(entry) {
    if (!objectUrls.has(entry.id)) objectUrls.set(entry.id, URL.createObjectURL(entry.file));
    return objectUrls.get(entry.id);
  }

  function syncOrder(selectedEntries) {
    const selectedIds = new Set(selectedEntries.map((e) => e.id));
    order = order.filter((e) => selectedIds.has(e.id));
    const known = new Set(order.map((e) => e.id));
    selectedEntries.forEach((e) => {
      if (!known.has(e.id)) order.push(e);
    });
  }

  function applyDomOrder() {
    order.forEach((entry) => containerEl.appendChild(entry._wrapper));
  }

  function moveItem(fromPos, toPos) {
    const [entry] = order.splice(fromPos, 1);
    order.splice(toPos, 0, entry);
    applyDomOrder();
  }

  function buildCard(entry) {
    const wrapper = document.createElement("div");
    wrapper.className = "thumb-card";
    wrapper.draggable = true;

    const img = document.createElement("img");
    img.src = objectUrlFor(entry);
    img.style.maxHeight = "150px";
    wrapper.appendChild(img);

    const label = document.createElement("div");
    label.className = "thumb-label";
    label.textContent = entry.name;
    wrapper.appendChild(label);

    wrapper.addEventListener("dragstart", (e) => {
      draggedItem = entry;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", entry.name);
    });
    wrapper.addEventListener("dragover", (e) => {
      e.preventDefault();
      wrapper.classList.add("drag-over");
    });
    wrapper.addEventListener("dragleave", () => wrapper.classList.remove("drag-over"));
    wrapper.addEventListener("drop", (e) => {
      e.preventDefault();
      wrapper.classList.remove("drag-over");
      if (!draggedItem || draggedItem === entry) return;
      moveItem(order.indexOf(draggedItem), order.indexOf(entry));
      draggedItem = null;
    });

    entry._wrapper = wrapper;
    return wrapper;
  }

  function renderThumbs() {
    containerEl.innerHTML = "";
    order.forEach((entry) => containerEl.appendChild(buildCard(entry)));
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
      return pdfDoc.embedJpg(new Uint8Array(await file.arrayBuffer()));
    }
    if (type === "image/png") {
      return pdfDoc.embedPng(new Uint8Array(await file.arrayBuffer()));
    }
    return pdfDoc.embedPng(await toPngBytes(file));
  }

  function init() {
    const picker = document.getElementById("img2pdf-picker");
    containerEl = document.getElementById("img2pdf-thumbs");
    const options = document.getElementById("img2pdf-options");
    const pageSize = document.getElementById("img2pdf-pagesize");
    const runBtn = document.getElementById("img2pdf-run");
    const statusEl = document.getElementById("img2pdf-status");

    FilePicker.mount(picker, {
      accept: "image",
      multi: true,
      onChange: (selected) => {
        syncOrder(selected);
        renderThumbs();
        const has = order.length > 0;
        options.hidden = !has;
        runBtn.disabled = !has;
      },
    });

    runBtn.addEventListener("click", async () => {
      runBtn.disabled = true;
      Utils.setStatus(statusEl, "Создание PDF...", "info");
      try {
        const pdfDoc = await PDFLib.PDFDocument.create();
        const pageSizeMode = pageSize.value;
        for (const entry of order) {
          const embedded = await embedImage(pdfDoc, entry.file);
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
        Utils.setStatus(statusEl, `Готово: создан PDF из ${order.length} изображений.`, "success");
      } catch (err) {
        console.error(err);
        Utils.setStatus(statusEl, "Ошибка: " + err.message, "error");
      } finally {
        runBtn.disabled = order.length === 0;
      }
    });
  }

  return { init };
})();
