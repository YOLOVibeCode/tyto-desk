// The fixture panel shows where it is and its size, so the screenshot in test-results/ says which side it opened on.
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
