// Settings: which model writes names, descriptions and answers. Everything stays on this computer.
import { h, api, fill, skeleton, problem } from "./lib.js";

const CHOICES = [
  ["auto", "Auto", "Claude if an API key is set, otherwise Ollama"],
  ["ollama", "Ollama", "A model running on this computer"],
  ["anthropic", "Claude", "Anthropic's API, with your own key"],
  ["none", "None", "Maps and search only, no written answers"],
];
const CLAUDE_NAMES = { "claude-opus-5-5": "Claude Opus 5.5", "claude-sonnet-5-5": "Claude Sonnet 5.5", "claude-haiku-5-5": "Claude Haiku 5.5" };

export async function settings(view, onChange) {
  const root = h("div", { class: "settings" }, skeleton(6));
  fill(view, root);
  let st, health;
  try {
    [st, health] = await Promise.all([api("/settings"), api("/health")]);
  } catch (err) {
    fill(root, problem(err.message, () => settings(view, onChange)));
    return;
  }
  const msg = h("p", { class: "form-msg", role: "status" });
  const say = (text, bad) => { msg.textContent = text; msg.className = "form-msg" + (bad ? " is-error" : ""); };

  const radios = h("div", { class: "choice", role: "radiogroup", "aria-label": "Model" }, CHOICES.map(([value, label, hint]) =>
    h("label", { class: "choice-row" },
      h("input", { type: "radio", name: "provider", value, checked: st.choice === value, onchange: show }),
      h("span", {}, h("b", {}, label), h("span", { class: "choice-hint" }, hint)))));

  const ollamaUrl = h("input", { id: "ollama-url", type: "text", spellcheck: "false", autocomplete: "off", value: st.ollama.url, placeholder: "http://127.0.0.1:11434" });
  const ollamaModel = h("select", { id: "ollama-model" },
    h("option", { value: "" }, "Best installed model"),
    st.ollama.models.map((m) => h("option", { value: m, selected: st.ollama.model === m }, m)));
  const ollamaState = st.ollama.running
    ? `Ollama is running with ${st.ollama.models.length} chat model${st.ollama.models.length === 1 ? "" : "s"}.`
    : `Ollama isn't reachable at ${st.ollama.url}.`;
  const ollamaBox = h("fieldset", { class: "set-box", id: "box-ollama" }, h("legend", {}, "Ollama"),
    h("p", { class: "set-note" }, ollamaState, st.ollama.running && st.ollama.models.length ? "" :
      [" Install it from ", h("a", { href: "https://ollama.com", target: "_blank", rel: "noopener" }, "ollama.com"), ", then run ", h("code", {}, "ollama pull qwen2.5-coder:7b"), "."]),
    h("label", { for: "ollama-url" }, "Address"), ollamaUrl,
    h("label", { for: "ollama-model" }, "Model"), ollamaModel);

  const keyInput = h("input", { id: "claude-key", type: "password", autocomplete: "off", spellcheck: "false",
    placeholder: st.anthropic.key ? `Saved key ${st.anthropic.key_hint}` : "sk-ant-…" });
  const claudeModel = h("select", { id: "claude-model" }, st.anthropic.models.map((m) =>
    h("option", { value: m, selected: st.anthropic.model === m }, CLAUDE_NAMES[m] || m)));
  const keyNote = st.anthropic.key_source === "env" ? "Using ANTHROPIC_API_KEY from the environment this app was started in."
    : st.anthropic.key_source === "saved" ? `A key ending in ${st.anthropic.key_hint.slice(1)} is saved. Leave the field empty to keep it.`
      : "Get a key at console.anthropic.com. Usage is billed to your Anthropic account.";
  const forget = st.anthropic.key_source === "saved" ? h("button", { class: "btn quiet", type: "button", onclick: async () => {
    await save({ anthropic_api_key: "" }, "Saved key removed.");
  } }, "Remove saved key") : null;
  const claudeBox = h("fieldset", { class: "set-box", id: "box-anthropic" }, h("legend", {}, "Claude"),
    h("p", { class: "set-note" }, keyNote),
    h("label", { for: "claude-key" }, "API key"), keyInput,
    h("label", { for: "claude-model" }, "Model"), claudeModel, forget,
    h("p", { class: "set-note" }, "The key is stored only in config.json in your data folder and is sent only to Anthropic."));

  function show() {
    const v = radios.querySelector("input:checked").value;
    ollamaBox.hidden = !(v === "ollama" || v === "auto");
    claudeBox.hidden = !(v === "anthropic" || v === "auto");
  }
  function changes() {
    const out = { provider: radios.querySelector("input:checked").value, ollama_url: ollamaUrl.value.trim(),
      ollama_model: ollamaModel.value, anthropic_model: claudeModel.value };
    if (keyInput.value.trim()) out.anthropic_api_key = keyInput.value.trim();
    return out;
  }
  async function save(body, done) {
    try {
      st = await api("/settings", { method: "PUT", body });
      keyInput.value = "";
      say(done);
      onChange();
      return true;
    } catch (err) {
      say(err.message, true);
      return false;
    }
  }
  const saveBtn = h("button", { class: "btn primary", type: "submit" }, "Save");
  const testBtn = h("button", { class: "btn", type: "button", onclick: async () => {
    testBtn.disabled = true;
    say("Checking the connection…");
    if (await save(changes(), "Checking the connection…")) {
      try {
        const r = await api("/settings/check", { method: "POST" });
        say(r.message, !r.ok);
      } catch (err) {
        say(err.message, true);
      }
    }
    testBtn.disabled = false;
  } }, "Save and test");

  fill(root,
    h("h1", {}, "Settings"),
    h("p", { class: "lead" }, "Repo Atlas runs on your computer. Pick the model that writes names, descriptions and answers. Maps and search work without one."),
    h("form", { class: "set-form", onsubmit: async (e) => { e.preventDefault(); await save(changes(), "Saved. New answers use this model; existing maps keep the names they were made with."); } },
      h("fieldset", { class: "set-box" }, h("legend", {}, "Model"), radios),
      ollamaBox, claudeBox,
      h("div", { class: "set-actions" }, saveBtn, testBtn), msg),
    h("section", { class: "set-facts" },
      h("h2", {}, "On this computer"),
      h("dl", {},
        h("dt", {}, "Search"), h("dd", {}, st.embed_model ? `By meaning, with ${st.embed_model}` : "By names and words. Install an Ollama embedding model (ollama pull nomic-embed-text-v2-moe) to also search by meaning."),
        h("dt", {}, "Data folder"), h("dd", { class: "mono" }, health.data),
        h("dt", {}, "Version"), h("dd", {}, health.version))));
  show();
}
