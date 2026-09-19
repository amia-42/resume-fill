const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function extractFunction(source, signature, nextSignature) {
  const start = source.indexOf(signature);
  const end = source.indexOf(nextSignature);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Failed to locate snippet: ${signature}`);
  }
  return source.slice(start, end);
}

function loadPayloadHelpers() {
  const contentSource = fs.readFileSync(
    path.join(__dirname, "../content.js"),
    "utf8"
  );
  const schemaSource = fs.readFileSync(
    path.join(__dirname, "../shared/resume-schema.js"),
    "utf8"
  );

  const snippet = `
    ${schemaSource}
    const schema = window.ResumeSchema;
    const location = { href: "https://example.com/form" };
    const document = { title: "Example Form" };
    ${extractFunction(
      contentSource,
      "function buildFieldMappingPayload(fields, resumeProfile) {",
      "function normalizeMappings(rawMappings, fields) {"
    )}
    module.exports = {
      schema,
      buildFieldMappingPayload,
    };
  `;

  const context = {
    module: { exports: {} },
    exports: {},
    window: {},
    globalThis: {},
  };
  context.globalThis = context;

  vm.createContext(context);
  vm.runInContext(snippet, context);
  return context.module.exports;
}

test("buildFieldMappingPayload only includes resume fields with values", () => {
  const helpers = loadPayloadHelpers();
  const profile = helpers.schema.createEmptyResumeProfile();
  profile.personal.fullName = "张三";
  profile.personal.email = "zhangsan@example.com";

  const payload = helpers.buildFieldMappingPayload(
    [{ fieldId: "f_1", label: "姓名", kind: "text" }],
    profile
  );
  const paths = JSON.parse(
    JSON.stringify(payload.resumeFields.map((field) => field.path).sort())
  );

  assert.equal(payload.resumeFields.length, 2);
  assert.deepEqual(paths, ["personal.email", "personal.fullName"]);
  assert.ok(payload.resumeFields.every((field) => field.hasValue === true));
});

test("buildFieldMappingPayload exposes section custom fields with user-defined labels", () => {
  const helpers = loadPayloadHelpers();
  const profile = helpers.schema.createEmptyResumeProfile();
  profile.personal.fullName = "张三";
  profile.personal.customFields = [
    { name: "生源地", value: "浙江" },
    { name: "政治面貌", value: "" },
  ];

  const payload = helpers.buildFieldMappingPayload(
    [{ fieldId: "f_1", label: "生源地", kind: "text" }],
    profile
  );

  const customEntry = payload.resumeFields.find(
    (field) => field.path === "personal.customFields.0.value"
  );
  assert.equal(customEntry.label, "生源地");
  assert.equal(customEntry.sectionLabel, "基本信息");
  assert.equal(customEntry.valuePreview, "浙江");
  assert.equal(
    payload.resumeFields.some((field) => field.path === "personal.fullName"),
    true
  );
  assert.equal(
    payload.resumeFields.some(
      (field) => field.path === "personal.customFields.1.value"
    ),
    false
  );
  assert.equal(
    payload.resumeFields.some((field) => field.path.endsWith(".name")),
    false
  );
});
