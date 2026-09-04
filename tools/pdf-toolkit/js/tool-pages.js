window.Tools = window.Tools || {};
Tools.pages = (function () {
  let workingPages = []; // { uid, sourceId, sourcePageIndex, rotation, pdfjsPage }
  let selected = new Set();
  let currentEntryId = null;
  let multiSource = false;
  let uidCounter = 0;
  let loadToken = 0;
  let pickerCtrl = null;
  let insertPickerCtrl = null;
  let els = null;

  function makeUid() {
    return "p" + ++uidCounter;
  }

  async function pagesFromEntry(entry) {
    const pdfjsDoc = await Pool.getPdfDoc(entry.id);
    const pages = [];
    for (let i = 0; i < pdfjsDoc.numPages; i++) {
      const pdfjsPage = await pdfjsDoc.getPage(i + 1);
      pages.push({ uid: makeUid(), sourceId: entry.id, sourcePageIndex: i, rotation: 0, pdfjsPage });
    }
    return pages;
  }

  async function renderCardCanvas(wp, canvas, targetWidth) {
    const baseRotation = wp.pdfjsPage.rotate || 0;
    const totalRotation = (((baseRotation + wp.rotation) % 360) + 360) % 360;
    const probe = wp.pdfjsPage.getViewport({ scale: 1, rotation: totalRotation });
    const scale = targetWidth / probe.width;
    const viewport = wp.pdfjsPage.getViewport({ scale, rotation: totalRotation });
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await wp.pdfjsPage.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  }

  function updateToolbar() {
    const total = workingPages.length;
    const n = selected.size;
    els.selectionInfo.textContent = total === 0 ? "Нет страниц" : `Выбрано ${n} из ${total}`;
    els.toolbar.hidden = total === 0;
    [els.rotateLeft, els.rotateRight, els.deleteBtn, els.extractBtn].forEach((b) => (b.disabled = n === 0));
    els.saveBtn.disabled = total === 0;
    els.resetBtn.disabled = !currentEntryId;
    els.insertBlock.hidden = !currentEntryId;
  }

  function cardLabel(wp, idx) {
    if (multiSource) {
      const entry = Pool.get(wp.sourceId);
      return `${idx + 1} · ${entry ? entry.name : "?"} стр.${wp.sourcePageIndex + 1}`;
    }
    return "Стр. " + (idx + 1);
  }

  async function renderAll(token) {
    multiSource = new Set(workingPages.map((wp) => wp.sourceId)).size > 1;
    els.thumbs.innerHTML = "";
    for (let idx = 0; idx < workingPages.length; idx++) {
      if (token !== undefined && token !== loadToken) return; // superseded by a newer load
      const wp = workingPages[idx];
      const wrapper = buildCard(wp);
      els.thumbs.appendChild(wrapper);
      const canvas = wrapper.querySelector("canvas");
      const label = wrapper.querySelector(".thumb-label");
      label.textContent = cardLabel(wp, idx);
      await renderCardCanvas(wp, canvas, 130);
    }
    if (token !== undefined && token !== loadToken) return;
    updateToolbar();
  }

  function relabelAll() {
    const cards = els.thumbs.querySelectorAll(".thumb-card");
    workingPages.forEach((wp, idx) => {
      const wrapper = cards[idx];
      if (wrapper) wrapper.querySelector(".thumb-label").textContent = cardLabel(wp, idx);
    });
  }

  let draggedUid = null;

  function buildCard(wp) {
    const wrapper = document.createElement("div");
    wrapper.className = "thumb-card page-card";
    wrapper.draggable = true;
    wrapper.dataset.uid = wp.uid;
    wrapper.classList.toggle("selected", selected.has(wp.uid));

    const canvas = document.createElement("canvas");
    wrapper.appendChild(canvas);

    const label = document.createElement("div");
    label.className = "thumb-label";
    wrapper.appendChild(label);

    const controls = document.createElement("div");
    controls.className = "thumb-controls";

    const rotateLeftBtn = document.createElement("button");
    rotateLeftBtn.textContent = "⟲";
    rotateLeftBtn.title = "Повернуть страницу влево";
    rotateLeftBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      rotatePages([wp.uid], -90);
    });

    const rotateRightBtn = document.createElement("button");
    rotateRightBtn.textContent = "⟳";
    rotateRightBtn.title = "Повернуть страницу вправо";
    rotateRightBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      rotatePages([wp.uid], 90);
    });

    const viewBtn = document.createElement("button");
    viewBtn.textContent = "Вид";
    viewBtn.title = "Просмотреть крупнее";
    viewBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const big = document.createElement("canvas");
      await renderCardCanvas(wp, big, 640);
      const idx = workingPages.indexOf(wp);
      Lightbox.open(big, cardLabel(wp, idx));
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "✕";
    deleteBtn.title = "Удалить страницу";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deletePages([wp.uid]);
    });

    controls.append(rotateLeftBtn, rotateRightBtn, viewBtn, deleteBtn);
    wrapper.appendChild(controls);

    wrapper.addEventListener("click", (e) => {
      if (e.target.closest(".thumb-controls")) return;
      if (selected.has(wp.uid)) selected.delete(wp.uid);
      else selected.add(wp.uid);
      wrapper.classList.toggle("selected", selected.has(wp.uid));
      updateToolbar();
    });

    wrapper.addEventListener("dragstart", (e) => {
      draggedUid = wp.uid;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", wp.uid);
    });
    wrapper.addEventListener("dragover", (e) => {
      e.preventDefault();
      wrapper.classList.add("drag-over");
    });
    wrapper.addEventListener("dragleave", () => wrapper.classList.remove("drag-over"));
    wrapper.addEventListener("drop", (e) => {
      e.preventDefault();
      wrapper.classList.remove("drag-over");
      if (!draggedUid || draggedUid === wp.uid) return;
      const fromIdx = workingPages.findIndex((p) => p.uid === draggedUid);
      const toIdx = workingPages.findIndex((p) => p.uid === wp.uid);
      const [moved] = workingPages.splice(fromIdx, 1);
      workingPages.splice(toIdx, 0, moved);
      els.thumbs.insertBefore(
        els.thumbs.querySelector(`[data-uid="${moved.uid}"]`),
        toIdx < els.thumbs.children.length ? els.thumbs.children[toIdx] : null
      );
      relabelAll();
      draggedUid = null;
    });

    return wrapper;
  }

  function rotatePages(uids, delta) {
    const set = new Set(uids);
    workingPages.forEach((wp) => {
      if (!set.has(wp.uid)) return;
      wp.rotation = (((wp.rotation + delta) % 360) + 360) % 360;
      const wrapper = els.thumbs.querySelector(`[data-uid="${wp.uid}"]`);
      if (wrapper) renderCardCanvas(wp, wrapper.querySelector("canvas"), 130);
    });
  }

  function deletePages(uids) {
    const set = new Set(uids);
    workingPages = workingPages.filter((wp) => !set.has(wp.uid));
    uids.forEach((uid) => selected.delete(uid));
    renderAll();
  }

  async function buildPdfFromPages(pages) {
    const donors = new Map();
    const outDoc = await PDFLib.PDFDocument.create();
    for (const wp of pages) {
      let donor = donors.get(wp.sourceId);
      if (!donor) {
        const bytes = await Pool.getBytes(wp.sourceId);
        donor = await Utils.loadPdfLibDocument(bytes);
        donors.set(wp.sourceId, donor);
      }
      const [copied] = await outDoc.copyPages(donor, [wp.sourcePageIndex]);
      if (wp.rotation !== 0) {
        const finalAngle = (((copied.getRotation().angle + wp.rotation) % 360) + 360) % 360;
        copied.setRotation(PDFLib.degrees(finalAngle));
      }
      outDoc.addPage(copied);
    }
    return outDoc.save();
  }

  function baseName() {
    const entry = currentEntryId && Pool.get(currentEntryId);
    return entry ? Utils.stripExtension(entry.name) : "document";
  }

  async function loadEntry(entry) {
    const token = ++loadToken;
    currentEntryId = entry.id;
    selected = new Set();
    Utils.setStatus(els.status, "Загрузка страниц...", "info");
    try {
      const pages = await pagesFromEntry(entry);
      if (token !== loadToken) return; // superseded by a newer selection
      workingPages = pages;
      await renderAll(token);
      if (token !== loadToken) return;
      Utils.setStatus(els.status, `Загружено: ${entry.name} (${workingPages.length} стр.)`, "success");
    } catch (err) {
      if (token !== loadToken) return;
      console.error(err);
      Utils.setStatus(els.status, "Ошибка чтения PDF: " + err.message, "error");
    }
  }

  function clearWorkspace() {
    loadToken++;
    currentEntryId = null;
    workingPages = [];
    selected = new Set();
    els.thumbs.innerHTML = "";
    updateToolbar();
  }

  function closeInsertPanel() {
    if (insertPickerCtrl) {
      insertPickerCtrl.destroy();
      insertPickerCtrl = null;
    }
    els.insertPanel.hidden = true;
  }

  function init() {
    els = {
      picker: document.getElementById("pages-picker"),
      insertBlock: document.getElementById("pages-insert-block"),
      insertToggle: document.getElementById("pages-insert-toggle"),
      insertPanel: document.getElementById("pages-insert-panel"),
      insertPicker: document.getElementById("pages-insert-picker"),
      insertConfirm: document.getElementById("pages-insert-confirm"),
      insertCancel: document.getElementById("pages-insert-cancel"),
      toolbar: document.getElementById("pages-toolbar"),
      selectionInfo: document.getElementById("pages-selection-info"),
      selectAll: document.getElementById("pages-select-all"),
      selectNone: document.getElementById("pages-select-none"),
      rotateLeft: document.getElementById("pages-rotate-left"),
      rotateRight: document.getElementById("pages-rotate-right"),
      deleteBtn: document.getElementById("pages-delete"),
      extractBtn: document.getElementById("pages-extract"),
      thumbs: document.getElementById("pages-thumbs"),
      saveBtn: document.getElementById("pages-save"),
      resetBtn: document.getElementById("pages-reset"),
      status: document.getElementById("pages-status"),
    };

    pickerCtrl = FilePicker.mount(els.picker, {
      accept: "pdf",
      multi: false,
      autoSwitch: false,
      onChange: (sel) => {
        const entry = sel[0] || null;
        if (!entry) {
          clearWorkspace();
          return;
        }
        if (currentEntryId === entry.id) return;
        if (workingPages.length > 0) {
          const ok = confirm(`Открыть «${entry.name}»? Текущие изменения страниц не сохранены и будут потеряны.`);
          if (!ok) {
            pickerCtrl.selectOnly([currentEntryId]);
            return;
          }
        }
        loadEntry(entry);
      },
    });

    els.selectAll.addEventListener("click", () => {
      selected = new Set(workingPages.map((wp) => wp.uid));
      els.thumbs.querySelectorAll(".thumb-card").forEach((c) => c.classList.add("selected"));
      updateToolbar();
    });
    els.selectNone.addEventListener("click", () => {
      selected = new Set();
      els.thumbs.querySelectorAll(".thumb-card").forEach((c) => c.classList.remove("selected"));
      updateToolbar();
    });

    els.rotateLeft.addEventListener("click", () => rotatePages([...selected], -90));
    els.rotateRight.addEventListener("click", () => rotatePages([...selected], 90));
    els.deleteBtn.addEventListener("click", () => deletePages([...selected]));

    els.extractBtn.addEventListener("click", async () => {
      const chosen = workingPages.filter((wp) => selected.has(wp.uid));
      if (!chosen.length) return;
      els.extractBtn.disabled = true;
      Utils.setStatus(els.status, "Извлечение...", "info");
      try {
        const bytes = await buildPdfFromPages(chosen);
        Utils.downloadBlob(new Blob([bytes], { type: "application/pdf" }), `${baseName()}_extracted.pdf`);
        Utils.setStatus(els.status, `Готово: извлечено страниц — ${chosen.length}.`, "success");
      } catch (err) {
        console.error(err);
        Utils.setStatus(els.status, "Ошибка: " + err.message, "error");
      } finally {
        updateToolbar();
      }
    });

    els.saveBtn.addEventListener("click", async () => {
      if (!workingPages.length) return;
      els.saveBtn.disabled = true;
      Utils.setStatus(els.status, "Сохранение...", "info");
      try {
        const bytes = await buildPdfFromPages(workingPages);
        Utils.downloadBlob(new Blob([bytes], { type: "application/pdf" }), `${baseName()}_organized.pdf`);
        Utils.setStatus(els.status, "Готово.", "success");
      } catch (err) {
        console.error(err);
        Utils.setStatus(els.status, "Ошибка: " + err.message, "error");
      } finally {
        els.saveBtn.disabled = false;
      }
    });

    els.resetBtn.addEventListener("click", () => {
      if (!currentEntryId) return;
      if (!confirm("Сбросить все изменения и загрузить файл заново?")) return;
      loadEntry(Pool.get(currentEntryId));
    });

    els.insertToggle.addEventListener("click", () => {
      if (!els.insertPanel.hidden) {
        closeInsertPanel();
        return;
      }
      els.insertPanel.hidden = false;
      insertPickerCtrl = FilePicker.mount(els.insertPicker, { accept: "pdf", multi: false });
    });
    els.insertCancel.addEventListener("click", closeInsertPanel);
    els.insertConfirm.addEventListener("click", async () => {
      if (!insertPickerCtrl) return;
      const chosen = insertPickerCtrl.getSelected()[0];
      if (!chosen) return;
      Utils.setStatus(els.status, "Добавление страниц...", "info");
      try {
        const newPages = await pagesFromEntry(chosen);
        workingPages = workingPages.concat(newPages);
        closeInsertPanel();
        await renderAll();
        Utils.setStatus(els.status, `Добавлено страниц: ${newPages.length} из «${chosen.name}».`, "success");
      } catch (err) {
        console.error(err);
        Utils.setStatus(els.status, "Ошибка: " + err.message, "error");
      }
    });

    updateToolbar();
  }

  return { init };
})();
