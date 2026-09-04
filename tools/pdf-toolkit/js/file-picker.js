const FilePicker = (function () {
  let uid = 0;

  function acceptAttr(kind) {
    if (kind === "pdf") return "application/pdf";
    if (kind === "image") return "image/png,image/jpeg,image/webp";
    return undefined;
  }

  function emptyMessage(kind) {
    if (kind === "pdf") return "В пуле нет PDF-файлов — добавьте их через панель «Файлы» вверху или кнопкой ниже.";
    if (kind === "image") return "В пуле нет изображений — добавьте их через панель «Файлы» вверху или кнопкой ниже.";
    return "В пуле нет подходящих файлов.";
  }

  /**
   * Mounts a picker that lets a tool reuse files from the shared Pool
   * instead of requiring a fresh upload every time.
   * opts: { accept: 'pdf'|'image', multi: boolean, onChange(selectedEntries) }
   */
  function mount(container, opts) {
    const kind = opts.accept || "pdf";
    const multi = !!opts.multi;
    const name = "picker-" + ++uid;
    let selected = new Set();
    let knownIds = new Set();
    let firstRender = true;
    let unsubscribe = null;

    function currentItems() {
      return Pool.list(kind);
    }

    function emitChange() {
      const items = currentItems();
      const result = items.filter((e) => selected.has(e.id));
      if (opts.onChange) opts.onChange(result);
    }

    function reconcileSelection(items) {
      const ids = items.map((e) => e.id);
      const idSet = new Set(ids);
      const newIds = ids.filter((id) => !knownIds.has(id));

      // Drop selections for files removed from the pool.
      selected.forEach((id) => {
        if (!idSet.has(id)) selected.delete(id);
      });

      // Multi-select pickers are purely opt-in — never auto-checked, not even
      // on first mount, so a batch tool never silently pulls in unrelated
      // pool files the user added for something else.
      if (multi) {
        // no auto-selection
      } else if (firstRender) {
        if (ids.length) selected = new Set([ids[ids.length - 1]]);
      } else if (opts.autoSwitch !== false) {
        if (newIds.length) {
          selected = new Set([newIds[newIds.length - 1]]);
        } else if (selected.size === 0 && ids.length) {
          selected = new Set([ids[ids.length - 1]]);
        }
      }

      firstRender = false;
      knownIds = idSet;
    }

    function render() {
      const items = currentItems();
      reconcileSelection(items);
      container.innerHTML = "";

      if (items.length === 0) {
        const empty = document.createElement("div");
        empty.className = "picker-empty";
        empty.textContent = emptyMessage(kind);
        container.appendChild(empty);
      } else {
        const list = document.createElement("div");
        list.className = "picker-list";
        items.forEach((entry) => {
          const row = document.createElement("label");
          row.className = "picker-row" + (selected.has(entry.id) ? " selected" : "");

          const input = document.createElement("input");
          input.type = multi ? "checkbox" : "radio";
          if (!multi) input.name = name;
          input.checked = selected.has(entry.id);
          input.addEventListener("change", () => {
            if (multi) {
              if (input.checked) selected.add(entry.id);
              else selected.delete(entry.id);
            } else {
              selected = new Set([entry.id]);
            }
            render();
            emitChange();
          });

          const info = document.createElement("span");
          info.className = "picker-row-info";
          const rowName = document.createElement("span");
          rowName.className = "picker-row-name";
          rowName.textContent = entry.name;
          const rowMeta = document.createElement("span");
          rowMeta.className = "picker-row-meta";
          rowMeta.textContent = Utils.formatBytes(entry.size) + (entry.pageCount != null ? ` · ${entry.pageCount} стр.` : "");
          info.append(rowName, rowMeta);

          row.append(input, info);
          list.appendChild(row);
        });
        container.appendChild(list);
      }

      const addRow = document.createElement("div");
      addRow.className = "picker-add-row";
      const addLabel = document.createElement("span");
      addLabel.textContent = "+ Добавить " + (kind === "image" ? "изображения" : "PDF") + " (или перетащите сюда)";
      const addInput = document.createElement("input");
      addInput.type = "file";
      addInput.multiple = true;
      addInput.hidden = true;
      const accept = acceptAttr(kind);
      if (accept) addInput.accept = accept;
      addRow.append(addLabel, addInput);
      container.appendChild(addRow);
      Utils.wireDropzone(addRow, addInput, (files) => Pool.addFiles(files));

      emitChange();
    }

    unsubscribe = Pool.subscribe(render);

    return {
      getSelected: () => currentItems().filter((e) => selected.has(e.id)),
      selectOnly: (ids) => {
        selected = new Set(ids);
        render();
      },
      destroy: () => {
        if (unsubscribe) unsubscribe();
      },
    };
  }

  return { mount };
})();
