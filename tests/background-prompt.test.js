const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("field mapping prompt includes campus recruiting constraints", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../background.js"),
    "utf8"
  );

  assert.match(source, /校招场景优先级/);
  assert.match(source, /internships\.\*/);
  assert.match(source, /campusExperiences\.\*/);
  assert.match(source, /educations\.\*/);
  assert.match(source, /没有实习经历/);
  assert.match(source, /hasValue=true/);
  assert.match(source, /sectionLabel/);
  assert.match(source, /nearbyLabels/);
  assert.match(source, /groupId/);
  assert.match(source, /groupPath/);
  assert.match(source, /groupFieldLabels/);
  assert.match(source, /parentGroupId/);
  assert.match(source, /先根据 field\.groupPath/);
  assert.match(source, /家庭情况/);
  assert.match(source, /personal\.fullName/);
  assert.match(source, /familyMembers\.\*/);
  assert.match(source, /familyMembers\.N/);
  assert.match(source, /同一重复条目/);
});

test("adaptive prompt carries group context and conservative family rules", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../background.js"),
    "utf8"
  );

  assert.match(source, /adaptive_fill/);
  assert.match(source, /groupIndex（从 1 开始/);
  assert.match(source, /groupPath（从外层到当前组/);
  assert.match(source, /groups：与 fields 同级/);
  assert.match(source, /最具体 groupPath \/ groups 组含义/);
  assert.match(source, /职位\/职务\/工作单位不得映射/);
  assert.match(source, /没有明确家庭字段时整组 shouldFill=false/);
});

test("unmapped field recommendation prompt restricts module choices and fallback", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../background.js"),
    "utf8"
  );

  assert.match(source, /unmapped_field_module_recommendation/);
  assert.match(source, /candidateModules/);
  assert.match(source, /fallbackSectionKey/);
  assert.match(source, /fieldName/);
  assert.match(source, /不要返回 JavaScript/);
});
