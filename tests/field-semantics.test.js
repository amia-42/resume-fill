const test = require("node:test");
const assert = require("node:assert/strict");

const semantics = require("../shared/field-semantics.js");

test("inferSectionFromTexts recognizes education sections", () => {
  const section = semantics.inferSectionFromTexts([
    "教育经历",
    "学校名称",
    "学历类型",
    "实验室",
  ]);

  assert.equal(section.key, "education");
  assert.equal(section.label, "教育经历");
  assert.match(section.evidence, /学历类型|实验室|学校名称/);
});

test("inferSectionFromTexts prefers internship over generic work for intern labels", () => {
  const section = semantics.inferSectionFromTexts([
    "实习经历",
    "公司名称",
    "职位名称",
    "后端开发实习生",
  ]);

  assert.equal(section.key, "internship");
  assert.equal(section.label, "实习经历");
});

test("inferSectionFromTexts recognizes campus sections", () => {
  const section = semantics.inferSectionFromTexts([
    "校园经历",
    "学生组织",
    "社团",
    "技术负责人",
  ]);

  assert.equal(section.key, "campus");
  assert.equal(section.label, "校园经历");
});

test("specific family group wins over generic name, phone, and position labels", () => {
  const section = semantics.inferSectionFromTexts([
    "家庭情况",
    "姓名",
    "关系",
    "职位",
    "电话",
  ]);

  assert.equal(section.key, "family");
  assert.equal(section.label, "家庭情况");
  assert.match(section.evidence, /家庭情况/);
});

test("emergency contact is exposed as a concrete page group", () => {
  const group = semantics.inferGroupFromTexts([
    "紧急联系人",
    "姓名",
    "与本人关系",
    "联系电话",
  ]);

  assert.equal(group.key, "emergencyContact");
  assert.equal(group.label, "紧急联系人");
});

test("generic labels do not invent a field group", () => {
  const group = semantics.inferGroupFromTexts(["姓名", "电话", "职位"]);
  assert.equal(group.key, "");
  assert.equal(group.label, "");
});

test("a generic contact heading does not become an emergency group", () => {
  const section = semantics.inferSectionFromTexts(["联系人信息", "姓名", "电话"]);
  assert.equal(section.key, "personal");
});
