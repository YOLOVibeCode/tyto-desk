// The fixture panel prints the side Chrome reports (chrome.sidePanel.getLayout(), which reads back the pref the test
// seeded) and its size. Where the panel is actually drawn is in extension-screen.png, the whole Xvfb screen, which the
// test checks by the panel's #111 background.
const status = document.getElementById("status");
let side = "?";
const show = () => {
  status.textContent = `Desk live fixture panel: ${side}, ${innerWidth}×${innerHeight}`;
};
addEventListener("resize", show);
chrome.sidePanel.getLayout().then((layout) => {
  side = layout.side;
  show();
});
