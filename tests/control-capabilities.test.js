const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const capabilities = require("../shared/control-capabilities.js");

test("control capability catalogue exposes supported and non-adaptable controls", () => {
  assert.equal(capabilities.isSupported("text"), true);
  assert.equal(capabilities.isSupported("dropdown"), true);
  for (const frameworkKind of ["el-select", "ant-select", "layui-form-select", "chosen", "select2", "selectBox"]) {
    assert.equal(capabilities.normalizeKind(frameworkKind), "combobox");
  }
  assert.equal(capabilities.normalizeKind("radio"), "radio_group");

  const file = capabilities.get("file");
  assert.equal(file.supported, false);
  assert.equal(file.adaptable, false);
});

test("adaptive fill UI and prompts are wired into the extension", () => {
  const popup = fs.readFileSync(path.join(__dirname, "../popup.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "../popup.html"), "utf8");
  const background = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8");
  const content = fs.readFileSync(path.join(__dirname, "../content.js"), "utf8");

  assert.match(html, /id="startAdaptiveFillBtn"/);
  assert.match(html, /id="startAdaptivePageFillBtn"/);
  assert.match(html, /id="overwriteExistingToggle"/);
  assert.match(html, /id="dangerModeToggle"/);
  assert.match(popup, /adaptiveSelection/);
  assert.match(popup, /adaptivePage/);
  assert.match(popup, /adaptive: actionConfig\.adaptive/);
  assert.match(popup, /dangerMode: dangerModeToggle/);
  assert.match(background, /adaptive_fill/);
  assert.match(background, /control_adapter/);
  assert.match(background, /dangerous_fill_adapter/);
  assert.match(content, /sourceSnippet/);
  assert.match(content, /tryAdaptiveControlAdapter/);
  assert.match(content, /tryDangerousScriptAdapter/);
});

test("learned control adapters persist and remain distinct from built-ins", async () => {
  const store = { values: {}, async get(key) { return { [key]: this.values[key] }; }, async set(next) { Object.assign(this.values, next); } };
  const kind = "custom_test_control";
  const registered = capabilities.registerSupported(kind, {
    label: "测试控件",
    inputTypes: ["role=test"],
    adapterKind: "native_value",
  }, store);

  assert.equal(registered.kind, kind);
  assert.equal(capabilities.getAdapterStrategy("text"), "");
  assert.equal(capabilities.getAdapterStrategy(kind), "native_value");

  await new Promise((resolve) => setTimeout(resolve, 0));
  await capabilities.refresh(store);
  assert.equal(capabilities.get(kind).supported, true);
  assert.equal(capabilities.get(kind).strategy, "native_value");
});
