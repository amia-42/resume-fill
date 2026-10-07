(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ResumeFieldGroups = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAX_DEPTH = 9;
  const GROUP_SELECTOR =
    "fieldset,section,article,[role=group],[role=radiogroup],[aria-labelledby],[aria-label]";
  const RECORD_CLASS_RE =
    /(?:^|[-_\s])(item|row|card|entry|record|member|experience|education|project|repeat|list-item)(?:$|[-_\s])/i;
  const HEADING_SELECTOR =
    "legend,h1,h2,h3,h4,h5,h6,[role=heading],[class*=title],[class*=Title],[class*=header],[class*=Header],[class*=section],[class*=Section]";

  function text(value, max = 120) {
    return String(value == null ? "" : value)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);
  }

  function attr(node, name) {
    try {
      return text(node?.getAttribute?.(name) || "");
    } catch (_) {
      return "";
    }
  }

  function parent(node) {
    return node?.parentElement || node?.parentNode || null;
  }

  function children(node) {
    try {
      return Array.from(node?.children || []);
    } catch (_) {
      return [];
    }
  }

  function matches(node, selector) {
    try {
      return Boolean(node?.matches?.(selector));
    } catch (_) {
      return false;
    }
  }

  function descendants(node, selector = "*") {
    try {
      return Array.from(node?.querySelectorAll?.(selector) || []);
    } catch (_) {
      return [];
    }
  }

  function tag(node) {
    return String(node?.tagName || "").toLowerCase();
  }

  function isControl(node) {
    const name = tag(node);
    return ["input", "textarea", "select", "button"].includes(name) ||
      attr(node, "contenteditable") === "true" ||
      attr(node, "contenteditable") === "" ||
      attr(node, "role") === "combobox";
  }

  function controlNodes(node) {
    if (!node) return [];
    const all = [node, ...descendants(node)];
    return all.filter((item) => isControl(item));
  }

  function containsField(node, targetSet) {
    if (!node || !targetSet?.size) return false;
    return Array.from(targetSet).some((target) => target === node || node.contains?.(target));
  }

  function visibleText(node) {
    if (!node) return "";
    const clone = node.cloneNode?.(true);
    if (!clone) return text(node.textContent || "");
    for (const child of descendants(clone, "input,textarea,select,button,option,script,style,noscript")) {
      child.remove?.();
    }
    return text(clone.textContent || "", 160);
  }

  function labelledText(node) {
    const direct = attr(node, "aria-label");
    if (direct) return direct;
    const labelledBy = attr(node, "aria-labelledby");
    if (labelledBy && node.ownerDocument?.getElementById) {
      const labels = labelledBy
        .split(/\s+/)
        .map((id) => node.ownerDocument.getElementById(id))
        .map((item) => visibleText(item))
        .filter(Boolean);
      if (labels.length) return text(labels.join(" / "));
    }
    const legend = children(node).find((child) => tag(child) === "legend");
    return text(visibleText(legend));
  }

  function headingText(node) {
    const labelled = labelledText(node);
    if (labelled) return labelled;
    let heading = children(node).find((child) => matches(child, HEADING_SELECTOR));
    if (!heading) {
      // Many component libraries wrap an h2/legend in a header div. Search
      // one non-group wrapper deep, while avoiding headings nested in a
      // different fieldset/card so an outer page never borrows its title.
      for (const child of children(node)) {
        if (hasExplicitGroupShape(child)) continue;
        const nested = child.querySelector?.(HEADING_SELECTOR);
        if (nested) {
          heading = nested;
          break;
        }
      }
    }
    const headingValue = text(visibleText(heading));
    if (headingValue) return headingValue;
    if (tag(node) === "table") {
      const caption = node.querySelector?.("caption");
      const captionValue = text(visibleText(caption));
      if (captionValue) return captionValue;
    }
    let sibling = node.previousElementSibling;
    for (let i = 0; sibling && i < 3; i += 1) {
      const siblingHeading = sibling.matches?.(HEADING_SELECTOR)
        ? sibling
        : sibling.querySelector?.(HEADING_SELECTOR);
      const value = text(visibleText(siblingHeading));
      if (value) return value;
      sibling = sibling.previousElementSibling;
    }
    return "";
  }

  function ancestors(node) {
    const result = [];
    let current = node;
    for (let depth = 0; current && depth < MAX_DEPTH; depth += 1) {
      result.push(current);
      current = parent(current);
    }
    return result;
  }

  function hasExplicitGroupShape(node) {
    if (tag(node) === "table") return true;
    if (["fieldset", "section", "article"].includes(tag(node))) {
      return true;
    }
    const role = attr(node, "role");
    if (role === "group" || role === "radiogroup") return true;
    // aria-label is common on both containers and controls. Treat it as a
    // group marker only for non-control elements so a field's own label never
    // becomes the label of a one-field group.
    return !isControl(node) && Boolean(attr(node, "aria-label") || attr(node, "aria-labelledby"));
  }

  function isRecordNode(node, targetSet) {
    if (!node || tag(node) === "html" || tag(node) === "body") return false;
    if (tag(node) === "tr") return true;
    const classText = `${attr(node, "class")} ${attr(node, "data-testid")} ${attr(node, "data-field-group")}`;
    if (!RECORD_CLASS_RE.test(classText)) return false;
    return controlNodes(node).filter((item) => targetSet.has(item)).length >= 2;
  }

  function findRecordNode(node, targetSet) {
    for (const candidate of ancestors(node)) {
      if (isRecordNode(candidate, targetSet)) return candidate;
    }
    return null;
  }

  function findGroupNode(node, targetSet, recordNode) {
    const list = ancestors(recordNode || node);
    const start = recordNode ? list.slice(1) : list;
    for (const candidate of start) {
      if (recordNode && tag(recordNode) === "tr" && ["tbody", "thead", "tfoot"].includes(tag(candidate))) {
        continue;
      }
      if (!containsField(candidate, targetSet)) continue;
      const memberCount = controlNodes(candidate).filter((item) => targetSet.has(item)).length;
      // A control's aria-label describes the field itself, so it cannot act
      // as a container heading when deciding whether the control belongs to a
      // group.
      const heading = isControl(candidate) ? "" : headingText(candidate);
      // An explicit fieldset/ARIA/section label remains useful when a
      // selection contains only one member of the group. Untitled generic
      // containers still need at least two selected fields before becoming a
      // group, which avoids grouping an isolated applicant field with a page.
      if (memberCount >= 1 && (heading || hasExplicitGroupShape(candidate))) return candidate;
      if (memberCount < 2) continue;
    }
    return null;
  }

  function nearestContainer(node, targetSet) {
    for (const candidate of ancestors(node)) {
      if (!containsField(candidate, targetSet)) continue;
      const memberCount = controlNodes(candidate).filter((item) => targetSet.has(item)).length;
      if (
        memberCount >= 2 &&
        (headingText(candidate) || hasExplicitGroupShape(candidate) ||
          (!['html', 'body', 'main', 'form'].includes(tag(candidate)) && memberCount <= 24))
      ) return candidate;
    }
    return null;
  }

  function siblingIndex(node, matcher) {
    const owner = parent(node);
    const siblings = children(owner);
    const same = siblings.filter((item) => matcher(item));
    const index = same.indexOf(node);
    return index >= 0 ? index + 1 : 1;
  }

  function groupKind(node, recordNode) {
    if (tag(recordNode) === "tr" || tag(node) === "table") return "table-row";
    if (recordNode) return "record";
    if (tag(node) === "fieldset") return "fieldset";
    if (attr(node, "role") === "group" || attr(node, "role") === "radiogroup") return "aria-group";
    if (tag(node) === "section" || tag(node) === "article") return "section";
    return "container";
  }

  function columnLabel(fieldNode, rowNode) {
    if (!rowNode || tag(rowNode) !== "tr") return "";
    const cell = fieldNode?.closest?.("td,th");
    if (!cell) return "";
    const cells = children(rowNode);
    const index = cells.indexOf(cell);
    const table = rowNode.closest?.("table");
    const headerRow = table?.querySelector?.("thead tr") || table?.querySelector?.("tr");
    const headerCell = children(headerRow)[index];
    return text(visibleText(headerCell));
  }

  function enrichFields(fields, runtimes = []) {
    const source = Array.isArray(fields) ? fields : [];
    const runtimeMap = new Map(
      (Array.isArray(runtimes) ? runtimes : [])
        .map((runtime) => [String(runtime?.fieldId || ""), runtime])
        .filter(([id]) => id)
    );
    const elements = source
      .map((field) => {
        const runtime = runtimeMap.get(String(field?.fieldId || ""));
        const element = runtime?.el || runtime?.options?.[0]?.el || null;
        return { field, runtime, element };
      })
      .filter((item) => item.element);
    const targetSet = new Set(elements.map((item) => item.element));
    const nodeIds = new WeakMap();
    let sequence = 0;
    const idFor = (node) => {
      if (!node || (typeof node !== "object" && typeof node !== "function")) return "";
      if (!nodeIds.has(node)) nodeIds.set(node, `g_${++sequence}`);
      return nodeIds.get(node);
    };
    const specs = new Map();
    const result = source.map((field) => ({ ...field }));

    for (const item of elements) {
      const fieldIndex = source.indexOf(item.field);
      if (fieldIndex < 0) continue;
      const recordNode = findRecordNode(item.element, targetSet);
      const groupNode = findGroupNode(item.element, targetSet, recordNode) ||
        (!recordNode ? nearestContainer(item.element, targetSet) : null);
      if (!groupNode && !recordNode) continue;

      const rootNode = groupNode || recordNode;
      const label = text(headingText(groupNode || recordNode) || item.field?.sectionLabel || "字段组");
      const kind = groupKind(groupNode || recordNode, recordNode);
      const index = recordNode
        ? (tag(recordNode) === "tr"
          ? siblingIndex(recordNode, (candidate) => tag(candidate) === "tr")
          : siblingIndex(recordNode, (candidate) => isRecordNode(candidate, targetSet)))
        : null;
      const parentNode = recordNode && groupNode ? groupNode : null;
      const groupId = `${idFor(groupNode || rootNode)}${recordNode ? `_${index || 1}` : ""}`;
      const parentGroupId = parentNode ? idFor(parentNode) : "";
      const key = groupId;
      if (parentNode && !specs.has(parentGroupId)) {
        const parentFieldIds = elements
          .filter((entry) => parentNode.contains?.(entry.element))
          .map((entry) => String(entry.field?.fieldId || "").trim())
          .filter(Boolean);
        specs.set(parentGroupId, {
          groupId: parentGroupId,
          label: text(headingText(parentNode) || item.field?.sectionLabel || "字段组"),
          parentGroupId: "",
          kind: groupKind(parentNode, null),
          index: null,
          node: parentNode,
          fieldIds: Array.from(new Set(parentFieldIds)),
          fieldLabels: [],
          groupPath: [],
        });
      }
      if (!specs.has(key)) {
        specs.set(key, {
          groupId,
          label,
          parentGroupId,
          kind,
          index,
          node: rootNode,
          fieldIds: [],
          fieldLabels: [],
          groupPath: [],
        });
      }
      const spec = specs.get(key);
      const fieldId = String(item.field?.fieldId || "");
      if (fieldId && !spec.fieldIds.includes(fieldId)) spec.fieldIds.push(fieldId);
      const fieldLabel = text(item.field?.label || columnLabel(item.element, recordNode));
      if (fieldLabel && !spec.fieldLabels.includes(fieldLabel)) spec.fieldLabels.push(fieldLabel);
      const tableLabel = columnLabel(item.element, recordNode);
      if (tableLabel && !result[fieldIndex].tableColumnLabel) result[fieldIndex].tableColumnLabel = tableLabel;
      result[fieldIndex].groupId = groupId;
      result[fieldIndex].groupLabel = label;
      result[fieldIndex].groupIndex = index;
      result[fieldIndex].groupKind = kind;
      result[fieldIndex].parentGroupId = parentGroupId;
    }

    const groups = Array.from(specs.values());
    const byId = new Map(groups.map((group) => [group.groupId, group]));
    for (const group of groups) {
      if (!group.fieldLabels.length) {
        group.fieldLabels = group.fieldIds
          .map((fieldId) => {
            const field = result.find((item) => String(item?.fieldId || "") === fieldId);
            return text(field?.label || field?.tableColumnLabel);
          })
          .filter(Boolean)
          .filter((label, index, values) => values.indexOf(label) === index)
          .slice(0, 30);
      }
      const path = [];
      if (group.parentGroupId && byId.has(group.parentGroupId)) {
        const parentGroup = byId.get(group.parentGroupId);
        path.push({ groupId: parentGroup.groupId, label: parentGroup.label, kind: parentGroup.kind, index: parentGroup.index });
      }
      path.push({ groupId: group.groupId, label: group.label, kind: group.kind, index: group.index });
      group.groupPath = path;
      for (const field of result) {
        if (field.groupId !== group.groupId) continue;
        field.groupPath = path.map((item) => ({ ...item }));
        field.groupFieldLabels = group.fieldLabels.slice(0, 30);
      }
      delete group.node;
    }
    return { fields: result, groups };
  }

  return { enrichFields };
});
