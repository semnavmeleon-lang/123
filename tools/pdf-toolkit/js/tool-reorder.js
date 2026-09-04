window.Tools = window.Tools || {};
Tools.reorder = (function () {
  let currentFile = null;
  let currentBytes = null;
  let order = []; // array of card objects, current order
  let containerEl = null;
  let draggedCard = null;

  function updateBadges() {
    order.forEach((card, pos) => {
      card.badge.textContent = "#" + (pos + 1);
      card.upBtn.disabled = pos === 0;
      card.downBtn.disabled = pos === order.length - 1;
    });
  }

  function applyDomOrder() {
    order.forEach((card) => containerEl.appendChild(card.wrapper));
    updateBadges();
  }

  function moveCard(fromPos, toPos) {
    const [card] = order.splice(fromPos, 1);
    order.splice(toPos, 0, card);
    applyDomOrder();
  }

  function addControls(card) {
    const badge = document.createElement("div");
    badge.className = "pos-badge";
    card.wrapper.appendChild(badge);
    card.badge = badge;

    card.wrapper.draggable = true;
    card.wrapper.addEventListener("dragstart", (e) => {
      draggedCard = card;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(card.index));
    });
    card.wrapper.addEventListener("dragover", (e) => {
      e.preventDefault();
      card.wrapper.classList.add("drag-over");
    });
    card.wrapper.addEventListener("dragleave", () => card.wrapper.classList.remove("drag-over"));
    card.wrapper.addEventListener("drop", (e) => {
      e.preventDefault();
      card.wrapper.classList.remove("drag-over");
      if (!draggedCard || draggedCard === card) return;
      const fromPos = order.indexOf(draggedCard);
      const toPos = order.indexOf(card);
      moveCard(fromPos, toPos);
      draggedCard = null;
    });

    const controls = document.createElement("div");
    controls.className = "thumb-controls";
    const upBtn = document.createElement("button");
    upBtn.textContent = "↑";
    upBtn.addEventListener("click", () => {
      const pos = order.indexOf(card);
      if (pos > 0) moveCard(pos, pos - 1);
    });
    const downBtn = document.createElement("button");
    downBtn.textContent = "↓";
    downBtn.addEventListener("click", () => {
      const pos = order.indexOf(card);
      if (pos < order.length - 1) moveCard(pos, pos + 1);
    });
    controls.append(upBtn, downBtn);
    card.wrapper.appendChild(controls);
    card.upBtn = upBtn;
    card.downBtn = downBtn;
  }

  async function loadFile(file, els) {
    currentFile = file;
    Utils.setStatus(els.status, "Загрузка...", "info");
    try {
      currentBytes = await Utils.readFileAsArrayBuffer(file);
      const pdfjsDoc = await Utils.loadPdfJsDocument(currentBytes);
      containerEl = els.thumbs;
      order = await Thumbnails.render(els.thumbs, pdfjsDoc, {
        targetWidth: 120,
        onCardBuilt: addControls,
      });
      updateBadges();
      els.run.disabled = false;
      Utils.setStatus(els.status, `Загружено: ${file.name} (${order.length} стр.). Перетащите страницы для изменения порядка.`, "success");
    } catch (err) {
      console.error(err);
      Utils.setStatus(els.status, "Ошибка чтения PDF: " + err.message, "error");
      els.run.disabled = true;
    }
  }

  function init() {
    const els = {
      dropzone: document.querySelector("#panel-reorder .dropzone"),
      input: document.getElementById("reorder-input"),
      thumbs: document.getElementById("reorder-thumbs"),
      run: document.getElementById("reorder-run"),
      status: document.getElementById("reorder-status"),
    };

    Utils.wireDropzone(els.dropzone, els.input, (files) => {
      if (files[0]) loadFile(files[0], els);
    });

    els.run.addEventListener("click", async () => {
      els.run.disabled = true;
      Utils.setStatus(els.status, "Сохранение...", "info");
      try {
        const donor = await Utils.loadPdfLibDocument(currentBytes);
        const out = await PDFLib.PDFDocument.create();
        const indices = order.map((c) => c.index);
        const pages = await out.copyPages(donor, indices);
        pages.forEach((p) => out.addPage(p));
        const bytes = await out.save();
        Utils.downloadBlob(
          new Blob([bytes], { type: "application/pdf" }),
          Utils.triggerDownloadName(currentFile.name, "_reordered", "pdf")
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
