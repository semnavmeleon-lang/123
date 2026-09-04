const Lightbox = (function () {
  let overlay = null;
  let contentEl = null;

  function ensure() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.className = "lightbox-overlay";
    overlay.hidden = true;

    const box = document.createElement("div");
    box.className = "lightbox-box";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "lightbox-close";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", close);

    contentEl = document.createElement("div");
    contentEl.className = "lightbox-content";

    box.append(closeBtn, contentEl);
    overlay.appendChild(box);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !overlay.hidden) close();
    });
    document.body.appendChild(overlay);
  }

  function open(node, caption) {
    ensure();
    contentEl.innerHTML = "";
    contentEl.appendChild(node);
    if (caption) {
      const cap = document.createElement("div");
      cap.className = "lightbox-caption";
      cap.textContent = caption;
      contentEl.appendChild(cap);
    }
    overlay.hidden = false;
  }

  function close() {
    if (overlay) overlay.hidden = true;
  }

  return { open, close };
})();
