const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadComboboxHelpers() {
  const source = fs.readFileSync(
    path.join(__dirname, "../content.js"),
    "utf8"
  );
  const start = source.indexOf("  function hasCustomDropdownClassHint(el) {");
  const end = source.indexOf("  function scanFields(", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const snippet = `
    const CUSTOM_DROPDOWN_CONTROL_SELECTOR = '[role="combobox"],[aria-haspopup="listbox"]';
    ${source.slice(start, end)}
    module.exports = {
      isCustomDropdownElement,
      buildCustomDropdownRuntime,
      getCustomDropdownAdapter,
    };
  `;
  const context = {
    module: { exports: {} },
    exports: {},
    document: {},
  };
  vm.createContext(context);
  vm.runInContext(snippet, context);
  return context.module.exports;
}

function createElement({ tagName = "INPUT", className = "", attrs = {}, readOnly = false } = {}) {
  return {
    tagName,
    className,
    readOnly,
    parentElement: null,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name);
    },
    closest(selector) {
      if (selector.includes('[role="combobox"]') && attrs.role === "combobox") {
        return this;
      }
      if (selector.includes('[aria-haspopup="listbox"]') && attrs["aria-haspopup"] === "listbox") {
        return this;
      }
      return null;
    },
    querySelector() {
      return null;
    },
  };
}

test("custom combobox semantics are detected separately from native text fields", () => {
  const helpers = loadComboboxHelpers();

  assert.equal(
    helpers.isCustomDropdownElement(
      createElement({ attrs: { role: "combobox", "aria-expanded": "false" } }),
      { label: "最高学历" }
    ),
    true
  );

  assert.equal(
    helpers.isCustomDropdownElement(
      createElement({ className: "sd-Input-input-10L0t sd-Select-container-1Eq4x" }),
      { label: "最高学历" }
    ),
    true
  );
});

test("readonly date fields are not mistaken for class-based custom dropdowns", () => {
  const helpers = loadComboboxHelpers();

  assert.equal(
    helpers.isCustomDropdownElement(
      createElement({ className: "date-picker-input", readOnly: true }),
      { label: "出生日期" }
    ),
    false
  );
});

test("custom dropdown runtime keeps the trigger and selected control", () => {
  const helpers = loadComboboxHelpers();
  const input = createElement({ attrs: { role: "combobox" } });
  const runtime = helpers.buildCustomDropdownRuntime("f_1", input, {
    label: "最高学历",
    context: "个人信息",
    nearbyLabels: [],
  });

  assert.equal(runtime.kind, "combobox");
  assert.equal(runtime.el, input);
  assert.equal(runtime.trigger, input);
});

test("supports the sd dropdown option classes used by school selectors", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../content.js"),
    "utf8"
  );

  assert.match(source, /Select-common-item/);
  assert.match(source, /class\*="dropdown"/);
});

test("identifies common custom dropdown adapters", () => {
  const helpers = loadComboboxHelpers();

  assert.equal(
    helpers.getCustomDropdownAdapter(
      createElement({ className: "el-select el-select--default" })
    ),
    "element"
  );
  assert.equal(
    helpers.getCustomDropdownAdapter(
      createElement({ className: "layui-form-select" })
    ),
    "layui"
  );
  assert.equal(
    helpers.getCustomDropdownAdapter(
      createElement({ className: "chosen-container chosen-container-single" })
    ),
    "chosen"
  );
  assert.equal(
    helpers.getCustomDropdownAdapter(
      createElement({ className: "select2-selection select2-selection--single" })
    ),
    "select2"
  );
  assert.equal(
    helpers.getCustomDropdownAdapter(
      createElement({ className: "ant-select ant-select-single" })
    ),
    "ant"
  );
  assert.equal(
    helpers.getCustomDropdownAdapter(
      createElement({ className: "ivu-select ivu-select-single" })
    ),
    "ivu"
  );
  assert.equal(
    helpers.getCustomDropdownAdapter(
      createElement({ attrs: { "aria-controls": "city-list" }, readOnly: true })
    ),
    "readonly-popup"
  );
  assert.equal(
    helpers.isCustomDropdownElement(
      createElement({ className: "el-select el-select--default" }),
      { label: "最高学历" }
    ),
    true
  );
  assert.equal(
    helpers.isCustomDropdownElement(
      createElement({ className: "selectBox" }),
      { label: "工作城市" }
    ),
    true
  );
});
