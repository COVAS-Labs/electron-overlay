const params = new URLSearchParams(location.search);
const initialModel = JSON.parse(params.get("model") ?? "{}");
const pointerProbe = document.querySelector("#pointer-probe");

const elements = {
  title: document.querySelector("#title"),
  subtitle: document.querySelector("#subtitle"),
  status: document.querySelector("#status"),
  verification: document.querySelector("#verification"),
  trace: document.querySelector("#trace"),
  facts: document.querySelector("#facts"),
  expectation: document.querySelector("#expectation"),
  scenario: document.querySelector("#scenario")
};

function render(model) {
  const role = model.role ?? "info";
  const scenario = model.scenario ?? "unknown";
  const result = model.result ?? "wait";
  document.body.className = `role-${role}`;
  document.body.dataset.scenario = scenario;
  document.body.dataset.pointerProbe = String(Boolean(model.pointerProbe));
  document.documentElement.dataset.demoReady = result === "pass" || result === "unsupported"
    ? "true"
    : "false";
  document.title = model.windowTitle ?? `electron-overlay demo | ${scenario}`;

  elements.title.textContent = model.title ?? scenario;
  elements.subtitle.textContent = model.subtitle ?? "";
  elements.status.textContent = result.toUpperCase();
  elements.verification.dataset.verification = result;
  elements.expectation.textContent = model.expectation ?? "No assertion supplied";
  elements.scenario.textContent = `DEMO / ${scenario.toUpperCase()}`;

  elements.trace.replaceChildren(...(model.trace ?? []).map((entry, index) => {
    const item = document.createElement("li");
    const number = document.createElement("span");
    const value = document.createElement("code");
    number.textContent = String(index + 1).padStart(2, "0");
    value.textContent = entry;
    item.append(number, value);
    return item;
  }));

  elements.facts.replaceChildren(...Object.entries(model.facts ?? {}).map(([label, value]) => {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = String(value);
    row.append(term, description);
    return row;
  }));
}

globalThis.demoSetModel = render;
pointerProbe.addEventListener("pointerdown", () => {
  pointerProbe.dataset.pointerState = "received";
  pointerProbe.textContent = "POINTER PROBE / RECEIVED";
  const recipient = document.body.classList.contains("role-overlay") ? "overlay" : "reference";
  document.title = `electron-overlay demo ${recipient} | ${document.body.dataset.scenario} | pointer received`;
});
render(initialModel);
