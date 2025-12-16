const KEY_NAME = "getsongApiKey";

(async function init() {
  const el = document.getElementById("k");
  const msg = document.getElementById("msg");
  const saved = await chrome.storage.local.get(KEY_NAME);
  el.value = saved[KEY_NAME] || "";
  msg.textContent = saved[KEY_NAME] ? "Key loaded." : "No key saved yet.";
})();

document.getElementById("save").addEventListener("click", async () => {
  const el = document.getElementById("k");
  const msg = document.getElementById("msg");
  const v = (el.value || "").trim();
  await chrome.storage.local.set({ getsongApiKey: v });
  msg.className = v ? "ok" : "hint";
  msg.textContent = v ? "Saved." : "Cleared.";
});
