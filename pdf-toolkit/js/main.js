(function () {
  const navItems = Array.from(document.querySelectorAll(".nav-item"));
  const panels = Array.from(document.querySelectorAll(".panel"));

  function showTool(name) {
    let found = false;
    panels.forEach((p) => {
      const match = p.id === "panel-" + name;
      p.hidden = !match;
      if (match) found = true;
    });
    navItems.forEach((btn) => btn.classList.toggle("active", btn.dataset.tool === name));
    if (found) {
      location.hash = name;
      document.getElementById("content").scrollTop = 0;
    }
    return found;
  }

  navItems.forEach((btn) => {
    btn.addEventListener("click", () => showTool(btn.dataset.tool));
  });

  // Initialize every tool module once at startup.
  Object.keys(window.Tools || {}).forEach((name) => {
    try {
      window.Tools[name].init();
    } catch (e) {
      console.error("Failed to init tool", name, e);
    }
  });

  const initial = (location.hash || "").replace("#", "");
  if (!initial || !showTool(initial)) {
    showTool("merge");
  }

  window.addEventListener("hashchange", () => {
    const name = (location.hash || "").replace("#", "");
    if (name) showTool(name);
  });
})();
