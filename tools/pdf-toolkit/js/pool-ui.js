(function () {
  function formatEntry(entry) {
    const parts = [Utils.formatBytes(entry.size)];
    if (entry.kind === "pdf") parts.push(entry.pageCount != null ? `${entry.pageCount} стр.` : "читаю…");
    return parts.join(" · ");
  }

  function init() {
    const bar = document.querySelector(".pool-bar");
    const listEl = document.getElementById("pool-bar-list");
    const countEl = document.getElementById("pool-count");
    const input = document.getElementById("pool-file-input");
    if (!listEl || !input) return;

    input.addEventListener("change", () => {
      if (input.files && input.files.length) Pool.addFiles(input.files);
      input.value = "";
    });

    // Whole bar accepts drag & drop (but not click, so chip buttons stay clickable).
    ["dragenter", "dragover"].forEach((evt) =>
      bar.addEventListener(evt, (e) => {
        e.preventDefault();
        bar.classList.add("dragover");
      })
    );
    ["dragleave", "dragend", "drop"].forEach((evt) =>
      bar.addEventListener(evt, (e) => {
        e.preventDefault();
        bar.classList.remove("dragover");
      })
    );
    bar.addEventListener("drop", (e) => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) Pool.addFiles(files);
    });

    Pool.subscribe((entries) => {
      countEl.textContent = entries.length ? `(${entries.length})` : "";
      listEl.innerHTML = "";
      if (entries.length === 0) {
        const empty = document.createElement("span");
        empty.className = "pool-bar-empty";
        empty.textContent = "Пока пусто — добавьте PDF или изображения, они станут доступны во всех инструментах.";
        listEl.appendChild(empty);
        return;
      }
      entries.forEach((entry) => {
        const chip = document.createElement("span");
        chip.className = "pool-chip";

        const badge = document.createElement("span");
        badge.className = "pool-chip-badge " + entry.kind;
        badge.textContent = entry.kind === "pdf" ? "PDF" : entry.kind === "image" ? "IMG" : "FILE";

        const name = document.createElement("span");
        name.className = "pool-chip-name";
        name.textContent = entry.name;
        name.title = entry.name;

        const meta = document.createElement("span");
        meta.className = "pool-chip-meta";
        meta.textContent = formatEntry(entry);

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "pool-chip-remove";
        removeBtn.textContent = "×";
        removeBtn.title = "Убрать из пула";
        removeBtn.addEventListener("click", () => Pool.remove(entry.id));

        chip.append(badge, name, meta, removeBtn);
        listEl.appendChild(chip);

        if (entry.kind === "pdf" && entry.pageCount == null) {
          Pool.getPdfDoc(entry.id).catch(() => {});
        }
      });
    });
  }

  init();
})();
