window.addEventListener("message", function onMessage(e) {
    if (e.source !== window.parent || !e.data || e.data.type !== "html-preview-render") return;
    window.removeEventListener("message", onMessage);
    document.open();
    document.write(e.data.html);
    document.close();
});
