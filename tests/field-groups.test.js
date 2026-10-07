const test = require("node:test");
const assert = require("node:assert/strict");

const { enrichFields } = require("../shared/field-groups.js");

class Node {
  constructor(tagName, textContent = "", attrs = {}) {
    this.tagName = tagName.toUpperCase();
    this._text = textContent;
    this.attrs = { ...attrs };
    this.children = [];
    this.parentElement = null;
  }

  append(...items) {
    for (const item of items) {
      item.parentElement = this;
      this.children.push(item);
    }
    return this;
  }

  get textContent() {
    return [this._text, ...this.children.map((item) => item.textContent)]
      .filter(Boolean)
      .join(" ");
  }

  get className() {
    return this.attrs.class || "";
  }

  get previousElementSibling() {
    const siblings = this.parentElement?.children || [];
    const index = siblings.indexOf(this);
    return index > 0 ? siblings[index - 1] : null;
  }

  get nextElementSibling() {
    const siblings = this.parentElement?.children || [];
    const index = siblings.indexOf(this);
    return index >= 0 ? siblings[index + 1] || null : null;
  }

  getAttribute(name) {
    return this.attrs[name] ?? null;
  }

  matches(selector) {
    return selector.split(",").some((part) => {
      const value = part.trim();
      if (!value) return false;
      const tag = value.match(/^[a-z0-9-]+/i)?.[0];
      if (tag && this.tagName.toLowerCase() !== tag.toLowerCase()) return false;
      const role = value.match(/\[role\s*=\s*["']?([^\]"']+)/i)?.[1];
      if (role && this.getAttribute("role") !== role) return false;
      const aria = value.match(/\[aria-label(?:ledby)?\]/i);
      if (aria && !this.getAttribute("aria-label") && !this.getAttribute("aria-labelledby")) return false;
      const classLike = value.match(/\[class\*=["']?([^\]"']+)/i)?.[1];
      if (classLike && !this.className.includes(classLike)) return false;
      return true;
    });
  }

  contains(node) {
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }

  querySelectorAll(selector) {
    const result = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (current.matches(selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  cloneNode(deep = false) {
    const copy = new Node(this.tagName, this._text, this.attrs);
    if (deep) copy.append(...this.children.map((child) => child.cloneNode(true)));
    return copy;
  }
}

function input(label) {
  return new Node("input", "", { "aria-label": label });
}

function fieldsFor(nodes, sectionLabel = "") {
  return nodes.map((element, index) => ({
    fieldId: `f_${index + 1}`,
    kind: "text",
    label: element.getAttribute("aria-label"),
    sectionLabel,
  }));
}

function runtimeFor(nodes) {
  return nodes.map((el, index) => ({ fieldId: `f_${index + 1}`, kind: "text", el }));
}

test("keeps applicant name separate from family member fields", () => {
  const root = new Node("main");
  const applicant = input("姓名");
  const family = new Node("fieldset").append(
    new Node("legend", "家庭情况"),
    input("姓名"),
    input("关系"),
    input("职位")
  );
  root.append(applicant, family);
  const nodes = [applicant, ...family.children.slice(1)];
  const result = enrichFields(fieldsFor(nodes), runtimeFor(nodes));
  const familyFields = result.fields.filter((field) => field.groupLabel === "家庭情况");

  assert.equal(familyFields.length, 3);
  assert.equal(result.fields[0].groupId, undefined);
  assert.deepEqual(familyFields.map((field) => field.groupFieldLabels), [
    ["姓名", "关系", "职位"],
    ["姓名", "关系", "职位"],
    ["姓名", "关系", "职位"],
  ]);
});

test("assigns separate indexes to repeated member rows under one group", () => {
  const section = new Node("section").append(new Node("h2", "家庭情况"));
  const row1 = new Node("div", "", { class: "family-row" }).append(input("姓名"), input("关系"));
  const row2 = new Node("div", "", { class: "family-row" }).append(input("姓名"), input("关系"));
  section.append(row1, row2);
  const nodes = [...row1.children, ...row2.children];
  const fields = nodes.map((element, index) => ({
    fieldId: `f_${index + 1}`,
    kind: "text",
    label: element.getAttribute("aria-label"),
  }));
  const result = enrichFields(fields, runtimeFor(nodes));

  assert.deepEqual(result.fields.map((field) => field.groupIndex), [1, 1, 2, 2]);
  assert.equal(new Set(result.fields.map((field) => field.groupId)).size, 2);
  assert.ok(result.fields.every((field) => field.groupLabel === "家庭情况"));
  assert.ok(result.groups.some((group) => group.label === "家庭情况"));
});

test("retains group context when a selected subset omits the outer heading", () => {
  const section = new Node("section").append(new Node("h2", "家庭情况"));
  const row = new Node("div", "", { class: "family-row" }).append(input("姓名"), input("关系"), input("职位"));
  section.append(row);
  const selected = [row.children[1], row.children[2]];
  const fields = fieldsFor(selected);
  const result = enrichFields(fields, runtimeFor(selected));

  assert.ok(result.fields.every((field) => field.groupLabel === "家庭情况"));
  assert.deepEqual(result.groups[0].fieldIds, ["f_1", "f_2"]);
});

test("uses labels from an untitled multi-field row as group member clues", () => {
  const row = new Node("div", "", { class: "contact-row" }).append(input("姓名"), input("电话"));
  const nodes = [...row.children];
  const result = enrichFields(fieldsFor(nodes, "联系方式"), runtimeFor(nodes));

  assert.equal(result.fields[0].groupId, result.fields[1].groupId);
  assert.deepEqual(result.fields[0].groupFieldLabels, ["姓名", "电话"]);
});

test("uses a table caption and row index for repeated table records", () => {
  const table = new Node("table").append(new Node("caption", "家庭成员"));
  const body = new Node("tbody");
  const row = new Node("tr").append(
    new Node("td", "姓名").append(input("姓名")),
    new Node("td", "关系").append(input("关系"))
  );
  body.append(row);
  table.append(body);
  const nodes = row.children.flatMap((cell) => cell.children);
  const result = enrichFields(fieldsFor(nodes), runtimeFor(nodes));

  assert.ok(result.fields.every((field) => field.groupLabel === "家庭成员"));
  assert.ok(result.fields.every((field) => field.groupIndex === 1));
});
