// Content script: scan fields -> AI mapping to resume paths -> deterministic local fill.
(function () {
  "use strict";

  if (window.__AI_RESUME_AUTOFILL_LOADED__) return;
  window.__AI_RESUME_AUTOFILL_LOADED__ = true;

  const schema = window.ResumeSchema;
  if (!schema) {
    console.error("[简历填表助手] Resume schema not found");
    return;
  }

  const diagnostics = window.ResumeDiagnostics;
  if (!diagnostics) {
    console.error("[简历填表助手] Resume diagnostics not found");
    return;
  }

  const fieldText = window.ResumeFieldText;
  if (!fieldText) {
    console.error("[简历填表助手] Resume field text helpers not found");
    return;
  }

  const fieldSemantics = window.ResumeFieldSemantics;
  if (!fieldSemantics) {
    console.error("[简历填表助手] Resume field semantics helpers not found");
    return;
  }

  const fillRuntime = window.ResumeFillRuntime;
  if (!fillRuntime) {
    console.error("[简历填表助手] Resume fill runtime helpers not found");
    return;
  }

  const contentBridge = window.ResumeContentBridge;
  if (!contentBridge) {
    console.error("[简历填表助手] Resume content bridge not found");
    return;
  }

  const aiClient = window.ResumeAiClient;
  if (!aiClient) {
    console.error("[简历填表助手] Resume AI client not found");
    return;
  }

  // This catalogue is also rendered in settings. Keep a fallback so an older
  // injected page can still use ordinary filling after an extension reload.
  const controlCapabilities = window.ResumeControlCapabilities || {
    getAll: () => [
      { kind: "text", label: "文本输入", inputTypes: ["text", "email", "tel", "url", "number", "date", "month", "time", "datetime-local"] },
      { kind: "textarea", label: "多行文本", inputTypes: ["textarea"] },
      { kind: "select", label: "原生下拉框", inputTypes: ["select"] },
      {
        kind: "combobox",
        label: "自定义下拉框（北森 / 前程无忧 / 国聘等）",
        inputTypes: [
          "combobox",
          "role=combobox",
          "aria-haspopup=listbox",
          "el-select",
          "layui-form-select",
          "chosen",
          "select2",
          "ant-select",
          "ivu-select",
          "select-box",
          "drop-menu",
        ],
      },
      { kind: "readonly_date", label: "只读日期 / 日期面板", inputTypes: ["readonly-date", "date-picker"] },
      { kind: "radio_group", label: "单选组", inputTypes: ["radio"] },
      { kind: "checkbox_group", label: "多选组", inputTypes: ["checkbox"] },
      { kind: "contenteditable", label: "可编辑区域", inputTypes: ["contenteditable"] },
      { kind: "file", label: "文件上传（暂不自动填写）", inputTypes: ["file"], supported: false },
    ],
    isSupported: (kind) => !["file", "", "unknown"].includes(String(kind || "")),
    normalizeKind: (kind) => String(kind || "").trim().toLowerCase(),
  };

  // Field groups are page-structure metadata. Keep a graceful fallback so a
  // page that still has an older injected script can continue to fill fields;
  // the current injector loads shared/field-groups.js before this file.
  const fieldGroups = window.ResumeFieldGroups || {
    enrichFields(fields) {
      return { fields: Array.isArray(fields) ? fields : [], groups: [] };
    },
  };

  const EXT_TAG = "[简历填表助手]";
  const MAPPING_CACHE_KEY = "fieldMappingCacheV3";
  const CONTROL_SELECTOR =
    'input, textarea, select, button, option, svg, path, style, script, noscript, [contenteditable="true"], [contenteditable=""], [aria-hidden="true"]';
  const LABEL_LIKE_SELECTOR =
    '[class*="label"],[class*="Label"],[class*="title"],[class*="Title"],[class*="name"],[class*="Name"],[class*="caption"],[class*="Caption"],[class*="header"],[class*="Header"],label,legend,dt,th';
  const HEADING_LIKE_SELECTOR =
    'h1,h2,h3,h4,h5,h6,[role="heading"],[class*="section"],[class*="Section"],[class*="header"],[class*="Header"],[class*="title"],[class*="Title"],legend';
  const STRUCTURAL_CONTAINER_SELECTOR =
    '[class*="form"],[class*="Form"],[class*="field"],[class*="Field"],[class*="item"],[class*="Item"],[class*="row"],[class*="Row"],[class*="group"],[class*="Group"],[class*="cell"],[class*="Cell"],fieldset,section,article,tr,li,td,th,dl';
  const CUSTOM_DROPDOWN_CONTROL_SELECTOR =
    '[role="combobox"],[aria-haspopup="listbox"]';
  // Many UI libraries hide the native <select> and expose a visible wrapper
  // or readonly input instead. Include those hosts in the scan so the
  // wrapper can be filled through its popup options.
  const CUSTOM_DROPDOWN_HOST_SELECTOR = [
    CUSTOM_DROPDOWN_CONTROL_SELECTOR,
    '.el-select,.el-cascader,.el-tree-select,.el-autocomplete,.ant-select,.ant-cascader,.ant-tree-select,.ivu-select',
    '.layui-form-select,.layui-select',
    '.chosen-container,.chosen-single,.chosen-choices',
    '.select2-container,.select2-selection',
    '[class*="select-box"],[class*="select_box"],[class*="selectbox"],[class*="selectBox"],[class*="SelectBox"],[class*="drop-menu"],[class*="drop_menu"],[class*="dropmenu"],[class*="DropMenu"],[class*="bootstrap-select"],[class*="bs-select"]',
    '[class*="dropdown-select"],[class*="DropdownSelect"]',
    'input[readonly][aria-controls],input[readonly][aria-owns]',
    'input[aria-expanded][aria-controls],input[aria-expanded][aria-owns]',
    '[aria-expanded][aria-controls],[aria-expanded][aria-owns]',
    '[aria-autocomplete="list"],[aria-autocomplete="both"]',
  ].join(',');
  const CUSTOM_DROPDOWN_OPTION_SELECTOR =
    '[role="option"],li,dd[lay-value],[class*="option"],[class*="Option"],[class*="dropdown__item"],[class*="DropdownItem"],[class*="menu-item"],[class*="MenuItem"],[class*="Select-common-item"],[class*="select-common-item"],[class*="Menu-container"],[class*="Menu-content-item"],[class*="active-result"],[class*="cascader-node"],[class*="tree-treenode"],[class*="tree-node"],[class*="ivu-select-item"],[class*="ant-select-item-option"],[class*="select2-results__option"],[data-value],[data-option-value],[data-option-array-index],[data-select2-id]';
  const SELECTION_OVERLAY_ID = "ai-resume-fill-selection-overlay";
  const SELECTION_BOX_ID = "ai-resume-fill-selection-box";
  const SELECTION_HINT_ID = "ai-resume-fill-selection-hint";
  const MIN_SELECTION_SIZE = 12;
  const DEEP_SCAN_MAX_ROUNDS = 5;
  const DEEP_SCAN_INITIAL_DELAY = 250;
  const DEEP_SCAN_POLL_TIMEOUT = 1200;
  const DEEP_SCAN_MAX_CLICKS = 20;
  const DEEP_SCAN_EXPAND_KEYWORDS = [
    "展开",
    "展开全部",
    "查看更多",
    "查看全部",
    "showmore",
    "viewmore",
    "expand",
  ];
  const DEEP_SCAN_MORE_KEYWORDS = ["更多", "more"];
  const DEEP_SCAN_EXCLUDE_KEYWORDS = [
    "添加",
    "新增",
    "增加",
    "新建",
    "删除",
    "提交",
    "保存",
    "返回",
    "取消",
    "关闭",
    "add",
    "new",
    "plus",
    "delete",
    "submit",
    "save",
    "back",
    "cancel",
    "close",
  ];
  const DEEP_SCAN_SECTION_MAP = [
    { patterns: ["教育", "学校", "专业", "学历", "学位", "毕业"], sectionKey: "educations" },
    { patterns: ["实习"], sectionKey: "internships" },
    { patterns: ["工作", "公司", "职位", "任职", "职业"], sectionKey: "workExperiences" },
    { patterns: ["项目", "产品"], sectionKey: "projects" },
    { patterns: ["证书", "认证", "资格", "等级"], sectionKey: "certificates" },
    { patterns: ["语言", "外语", "雅思", "托福", "cet"], sectionKey: "languages" },
    { patterns: ["校园", "学生", "社团", "社会", "志愿", "科研", "组织"], sectionKey: "campusExperiences" },
    { patterns: ["技能", "特长", "编程", "工具"], sectionKey: "skills" },
    { patterns: ["偏好", "期望", "求职", "目标", "薪资"], sectionKey: "jobPreferences" },
    { patterns: ["联系方式", "地址", "电话"], sectionKey: "contactAndLocation" },
    { patterns: ["证件", "身份", "护照", "户口"], sectionKey: "identityAndAuthorization" },
    { patterns: ["补充", "其他", "备注", "说明"], sectionKey: "additional" },
  ];

  const fieldRuntimeMap = new Map();
  const radioScopeIds = new WeakMap();
  let radioScopeSequence = 0;

  let lastFieldCount = 0;
  let lastMappedCount = 0;
  let lastFilledCount = 0;
  let isWorking = false;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const action = message?.action;

    if (action === "ping") {
      sendResponse({
        success: true,
        version: contentBridge.CONTENT_SCRIPT_VERSION,
        capabilities: {
          fullDiagnostics: true,
        },
      });
      return;
    }

    if (action === "getStatus") {
      sendResponse({
        success: true,
        fieldCount: lastFieldCount,
        mappedCount: lastMappedCount,
        filledCount: lastFilledCount,
      });
      return;
    }

    if (action === "startFill") {
      handleStartFill(message.modelId, message.resumeProfile, {
        fillMode: message.fillMode,
        scope: message.scope,
        adaptive: message.adaptive === true,
        adaptiveScope: message.adaptiveScope,
        overwriteExisting: message.overwriteExisting,
        // Preserve an omitted value so older popups can still use the
        // persisted setting. An explicit false always disables the fallback.
        dangerMode: typeof message.dangerMode === "boolean"
          ? message.dangerMode
          : typeof message.dangerousMode === "boolean"
            ? message.dangerousMode
            : undefined,
      })
        .then((result) => sendResponse(result))
        .catch((error) =>
          sendResponse({ success: false, message: error?.message || String(error) })
        );
      return true;
    }
  });

  async function handleStartFill(modelId, resumeProfile, request = {}) {
    if (isWorking) {
      return { success: false, message: "正在执行中，请稍后再试" };
    }

    isWorking = true;

    try {
      if (!resumeProfile || typeof resumeProfile !== "object") {
        throw new Error("标准简历为空：请先在侧边栏填写或导入标准简历");
      }

      // Load successful adapter registrations before building the AI payload.
      // This keeps the page-side capability list in sync with the settings UI.
      await controlCapabilities.loadPersisted?.();

      const adaptive = request?.adaptive === true || request?.fillMode === "adaptive";
      const dangerMode = await resolveDangerMode(request);
      // Adaptive filling has two explicit scopes. The overwrite choice is
      // independent so users can run either scope incrementally or replace
      // values deliberately.
      const scope = adaptive
        ? request?.adaptiveScope === "page" || request?.scope === "page"
          ? "page"
          : "selection"
        : request?.scope === "selection"
          ? "selection"
          : "page";
      const overwriteExisting = request?.overwriteExisting !== false;
      const fillMode = request?.fillMode === "incremental"
        ? "incremental"
        : adaptive
          ? overwriteExisting ? "overwrite" : "incremental"
          : "overwrite";
      let selectionRect = null;

      if (scope === "selection") {
        sendLog("info", "已进入选区模式：请在页面上拖拽框选要填写的区域。");
        selectionRect = await requestSelectionRect();
        if (!selectionRect) {
          return {
            success: false,
            canceled: true,
            message: "已取消选区填入",
          };
        }
        sendLog(
          "info",
          `选区已确认：left=${Math.round(selectionRect.left)} top=${Math.round(
            selectionRect.top
          )} width=${Math.round(selectionRect.width)} height=${Math.round(selectionRect.height)}`
        );
      }

      if (scope === "page") {
        sendLog("info", "正在探索页面上的可展开区块...");
        await triggerExpandableSections(resumeProfile);
      }

      sendLog(
        "info",
        scope === "selection" ? "开始扫描选区内表单字段..." : "开始扫描当前页面表单字段..."
      );
      const rawScan = scanFields({
        scope,
        selectionRect,
        // Adaptive page mode intentionally considers every document control,
        // while the legacy page mapper keeps its likely-form-root heuristic.
        fullPage: adaptive && scope === "page",
      });
      let groupedScan;
      try {
        groupedScan = fieldGroups.enrichFields?.(
          rawScan.fields,
          rawScan.runtime
        ) || { fields: rawScan.fields, groups: [] };
      } catch (error) {
        sendLog("warning", `字段组识别失败，将继续使用未分组字段：${error?.message || String(error)}`);
        groupedScan = { fields: rawScan.fields, groups: [] };
      }
      const groupedFields = Array.isArray(groupedScan.fields)
        ? groupedScan.fields
        : rawScan.fields;
      const groupedGroups = Array.isArray(groupedScan.groups)
        ? groupedScan.groups
        : [];
      // The payload builders intentionally keep their historical two-argument
      // signatures for test and integration compatibility. A non-enumerable
      // side channel carries the structural groups without leaking DOM data.
      try {
        Object.defineProperty(groupedFields, "__groups", {
          value: groupedGroups,
          configurable: true,
        });
      } catch (_) {
        // Frozen arrays are still usable; fields retain their group metadata.
      }
      const scan = {
        ...rawScan,
        fields: groupedFields,
        groups: groupedGroups,
      };

      lastFieldCount = scan.fields.length;
      lastMappedCount = 0;
      lastFilledCount = 0;

      fieldRuntimeMap.clear();
      for (const runtime of scan.runtime) {
        fieldRuntimeMap.set(runtime.fieldId, runtime);
      }

      for (const field of scan.fields) {
        sendLog("info", diagnostics.formatFieldSummary(field));
      }

      sendStats(lastFieldCount, 0, 0);

      if (lastFieldCount === 0) {
        return {
          success: false,
          message:
            scope === "selection"
              ? "选区内未识别到可填写字段，请重新框选后再试"
              : "未识别到可填写字段，请确认当前页面包含表单",
        };
      }

      const cacheSignature = createMappingCacheSignature(scan.fields);
      const cacheKey = createMappingCacheKeyFromSignature(
        cacheSignature,
        buildCustomFieldsCacheSalt(resumeProfile)
      );
      let mappings = null;
      let cacheHit = false;
      let adaptiveDecisions = new Map();

      if (adaptive) {
        sendLog(
          "info",
          `自适应${scope === "selection" ? "选区" : "整页"}模式：正在读取控件源码并让 AI 决定填入策略...`
        );
        const promptPayload = buildAdaptiveFillPayload(scan.fields, resumeProfile, {
          scope,
          overwriteExisting,
          groups: scan.groups,
        });
        const aiText = await aiClient.callAI(
          modelId,
          JSON.stringify(promptPayload),
          "adaptive_fill"
        );
        const parsed = parseJsonFromAiText(aiText);
        const normalized = normalizeAdaptiveDecisions(
          parsed?.decisions,
          scan.fields,
          resumeProfile
        );
        adaptiveDecisions = new Map(normalized.map((item) => [item.fieldId, item]));
        mappings = normalized
          .filter((item) => item.shouldFill && item.resumePath)
          .map((item) => ({
            fieldId: item.fieldId,
            resumePath: item.resumePath,
            reason: item.reason,
            transform: item.transform,
          }));
        sendLog("success", `自适应决策已生成：允许填入 ${mappings.length}/${scan.fields.length} 个字段。`);
      } else {
        const cacheLookup = await loadMappingCacheEntry(cacheKey, {
          host: location.host,
          path: location.pathname,
          signature: cacheSignature,
        });
        const cachedEntry = cacheLookup.entry;
        if (cachedEntry?.mappings?.length) {
          mappings = normalizeMappings(cachedEntry.mappings, scan.fields, resumeProfile);
          cacheHit = true;
          sendLog("info", "已命中本地字段映射缓存，跳过模型调用。");
        } else {
          sendLog("info", `[缓存] 未命中 reason="${cacheLookup.reason || "未知原因"}"`);
          sendLog(
            "info",
            `已识别 ${lastFieldCount} 个字段，正在调用 AI 建立字段映射...`
          );

          const promptPayload = buildFieldMappingPayload(scan.fields, resumeProfile);
          const aiText = await aiClient.callAI(
            modelId,
            JSON.stringify(promptPayload),
            "field_mapping"
          );
          const parsed = parseJsonFromAiText(aiText);
          mappings = normalizeMappings(parsed?.mappings, scan.fields, resumeProfile);

          await saveMappingCacheEntry(cacheKey, {
            updatedAt: Date.now(),
            mappings,
            host: location.host,
            path: location.pathname,
            signature: cacheSignature,
          });

          sendLog("success", "字段映射已生成，并已写入本地缓存。");
        }
      }

      const mappingById = new Map();
      for (const mapping of mappings || []) {
        if (!mapping?.fieldId) continue;
        mappingById.set(String(mapping.fieldId), mapping);
      }

      for (const field of scan.fields) {
        const mapping = mappingById.get(field.fieldId) || {
          fieldId: field.fieldId,
          resumePath: "",
          reason: "未返回映射结果",
          transform: { type: "none" },
        };
        const level = mapping.resumePath ? "info" : "warning";
        sendLog(
          level,
          diagnostics.formatMappingSummary(field, mapping, {
            source: cacheHit ? "cache" : "ai",
          })
        );
      }

      lastMappedCount = Array.from(mappingById.values()).filter((item) =>
        Boolean(String(item.resumePath || "").trim())
      ).length;

      sendStats(lastFieldCount, lastMappedCount, 0);
      sendLog(
        "info",
        fillMode === "incremental"
          ? "开始根据映射结果执行增量填充..."
          : "开始根据映射结果执行本地填充..."
      );

      let filledCount = 0;

      for (const field of scan.fields) {
        const mapping = mappingById.get(field.fieldId);
        const adaptiveDecision = adaptiveDecisions.get(field.fieldId);
        if (adaptive && adaptiveDecision && !adaptiveDecision.shouldFill) {
          sendLog(
            "warning",
            diagnostics.formatSkipSummary(
              field,
              mapping,
              adaptiveDecision.reason || "AI 判断当前字段不应填入",
              "",
              ""
            )
          );
          continue;
        }
        if (!mapping?.resumePath) {
          sendLog(
            "warning",
            diagnostics.formatSkipSummary(
              field,
              mapping,
              "AI 未匹配到可用的标准简历字段",
              "",
              ""
            )
          );
          continue;
        }

        const runtime = fieldRuntimeMap.get(field.fieldId);
        if (fillMode === "incremental" && hasExistingFieldValue(runtime)) {
          sendLog(
            "warning",
            diagnostics.formatSkipSummary(
              field,
              mapping,
              "字段已有内容，增量模式下不覆盖",
              "",
              ""
            )
          );
          continue;
        }

        const rawValue = schema.getValueByPath(resumeProfile, mapping.resumePath);
        const finalValue = deriveFillValue(rawValue, mapping.transform, runtime);

        sendLog(
          "info",
          diagnostics.formatValueSummary(field, mapping, rawValue, finalValue)
        );

        if (!hasMeaningfulFillValue(finalValue)) {
          sendLog(
            "warning",
            diagnostics.formatSkipSummary(
              field,
              mapping,
              "标准简历中没有可填写的值，或转换后为空",
              rawValue,
              finalValue
            )
          );
          continue;
        }

        const learnedAdapter = adaptive
          ? controlCapabilities.getAdapterStrategy?.(
              adaptiveDecision?.controlType || runtime?.kind
            )
          : "";
        // Keep a strict attempt count. The first attempt reuses a learned
        // adapter when one exists; otherwise it uses the deterministic local
        // filler. A fresh AI adapter is requested only after that attempt
        // fails, and dangerous scripts are considered only after two failures.
        let fillAttempts = 0;
        let fillResult;
        if (learnedAdapter && learnedAdapter !== "unsupported") {
          fillAttempts += 1;
          fillResult = await executeAdaptiveAdapter(runtime, finalValue, learnedAdapter);
        } else {
          fillAttempts += 1;
          fillResult = await fillOne(runtime, finalValue, {
            overwrite: fillMode !== "incremental",
          });
        }

        if (!fillResult.filled && (adaptive || dangerMode)) {
          fillAttempts += 1;
          fillResult = await tryAdaptiveControlAdapter({
            modelId,
            field,
            runtime,
            value: finalValue,
            decision: adaptiveDecision,
          });
        }

        if (!fillResult.filled && dangerMode && fillAttempts >= 2) {
          fillResult = await tryDangerousScriptAdapter({
            modelId,
            field,
            runtime,
            value: finalValue,
            decision: adaptiveDecision,
            dangerMode,
          });
        }
        sendLog(
          fillResult.filled ? "success" : "warning",
          diagnostics.formatFillSummary({
            field,
            mapping,
            rawValue,
            finalValue,
            fillResult,
          })
        );
        if (fillResult.filled) {
          filledCount += 1;
        }
      }

      lastFilledCount = filledCount;
      sendStats(lastFieldCount, lastMappedCount, lastFilledCount);
      const unmappedFields = buildUnmappedFieldList(
        scan.fields,
        mappingById,
        adaptiveDecisions
      );
      sendLog(
        "success",
        `填充完成：映射 ${lastMappedCount}/${lastFieldCount} 个字段，成功填充 ${lastFilledCount} 个。${unmappedFields.length ? `仍有 ${unmappedFields.length} 个字段未映射，可在侧边栏选择加入标准简历。` : "请检查后手动提交。"}`
      );

      return {
        success: true,
        fieldCount: lastFieldCount,
        mappedCount: lastMappedCount,
        filledCount: lastFilledCount,
        cacheHit,
        unmappedFields,
      };
    } finally {
      isWorking = false;
    }
  }

  // The popup normally passes the current value explicitly. Reading the
  // setting here as a compatibility fallback keeps the dangerous path gated
  // when an older popup is still open after an extension reload.
  async function resolveDangerMode(request) {
    if (typeof request?.dangerMode === "boolean") {
      return request.dangerMode;
    }

    try {
      const data = await chrome.storage.local.get([
        "dangerMode",
        "dangerousMode",
        "fillOptionsV1",
      ]);
      return data?.dangerMode === true ||
        data?.dangerousMode === true ||
        data?.fillOptionsV1?.dangerMode === true;
    } catch (_) {
      return false;
    }
  }

  function normalizeDeepScanText(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/[＊*]+$/g, "")
      .trim();
  }

  function getDeepScanText(el) {
    return normalizeDeepScanText(
      [
        el?.textContent,
        el?.getAttribute?.("aria-label"),
        el?.getAttribute?.("title"),
      ]
        .filter(Boolean)
        .join(" ")
    );
  }

  function getDeepScanTargetElements(el) {
    const targets = [];
    const targetIds = [
      el?.getAttribute?.("aria-controls"),
      el?.getAttribute?.("data-target"),
      el?.getAttribute?.("data-toggle-target"),
    ]
      .filter(Boolean)
      .flatMap((value) => String(value).split(/\s+/));

    for (const targetId of targetIds) {
      const normalizedTargetId = targetId.startsWith("#")
        ? targetId.slice(1)
        : targetId;
      const target = el?.ownerDocument?.getElementById?.(normalizedTargetId);
      if (target) targets.push(target);
    }

    const href = el?.getAttribute?.("href") || "";
    if (href.startsWith("#")) {
      const target = el?.ownerDocument?.getElementById?.(href.slice(1));
      if (target) targets.push(target);
    }

    return targets;
  }

  function hasHiddenDeepScanTarget(el) {
    return getDeepScanTargetElements(el).some((target) => {
      if (target.hidden || target.getAttribute?.("aria-hidden") === "true") {
        return true;
      }
      return !isVisible(target);
    });
  }

  function isDeepScanExpandTrigger(el) {
    if (!el) return false;
    const tagName = String(el.tagName || "").toLowerCase();
    const role = String(el.getAttribute?.("role") || "").toLowerCase();
    if (tagName !== "button" && tagName !== "a" && role !== "button") {
      return false;
    }
    if (el.disabled || el.getAttribute?.("aria-disabled") === "true") {
      return false;
    }
    if (String(el.getAttribute?.("type") || "").toLowerCase() === "submit") {
      return false;
    }
    if (el.getAttribute?.("aria-haspopup")) return false;
    if (el.getAttribute?.("aria-expanded") === "true") return false;

    const text = getDeepScanText(el);
    if (!text || DEEP_SCAN_EXCLUDE_KEYWORDS.some((keyword) => text.includes(keyword))) {
      return false;
    }

    const className = normalizeDeepScanText(el.className || "");
    const hasExplicitExpandText = DEEP_SCAN_EXPAND_KEYWORDS.some((keyword) =>
      text.includes(keyword)
    );
    const hasCollapsedState =
      el.getAttribute?.("aria-expanded") === "false" ||
      el.getAttribute?.("data-expanded") === "false" ||
      hasHiddenDeepScanTarget(el);
    const hasExpandClass = /(^|[-_])expand(?:ed|able)?([_-]|$)/.test(className);
    const hasMoreText = DEEP_SCAN_MORE_KEYWORDS.some((keyword) => text.includes(keyword));

    if (hasExplicitExpandText) return true;
    if (hasExpandClass && hasCollapsedState) return true;
    return hasMoreText && hasCollapsedState;
  }

  function hasSectionContent(profile, sectionKey) {
    const section = profile?.[sectionKey];
    if (!section) return false;
    if (Array.isArray(section)) {
      return section.some((item) =>
        item && typeof item === "object"
          ? Object.values(item).some((value) => String(value || "").trim())
          : Boolean(String(item || "").trim())
      );
    }
    if (typeof section === "object") {
      return Object.values(section).some((value) => String(value || "").trim());
    }
    return Boolean(String(section).trim());
  }

  function deepScanButtonMatchesProfile(el, resumeProfile) {
    if (!resumeProfile) return true;
    const text = getDeepScanText(el);
    const matchedSections = DEEP_SCAN_SECTION_MAP.filter((entry) =>
      entry.patterns.some((pattern) => text.includes(normalizeDeepScanText(pattern)))
    );
    if (matchedSections.length === 0) return true;
    return matchedSections.some((entry) => hasSectionContent(resumeProfile, entry.sectionKey));
  }

  function findDeepScanButtons(clickedElements, resumeProfile) {
    const selectors = [
      'button:not([type="submit"])',
      '[role="button"]',
      'a[class*="expand"], a[class*="Expand"]',
      'a[class*="more"], a[class*="More"]',
    ];
    return Array.from(document.querySelectorAll(selectors.join(","))).filter((el) => {
      if (!isVisible(el) || clickedElements.has(el)) return false;
      return isDeepScanExpandTrigger(el) && deepScanButtonMatchesProfile(el, resumeProfile);
    });
  }

  async function waitForNewFields(startCount) {
    if (countControls(document) > startCount) return true;

    return new Promise((resolve) => {
      let settled = false;
      let initialTimer = null;
      let timeoutTimer = null;
      const observer =
        typeof MutationObserver === "function"
          ? new MutationObserver(check)
          : null;

      function finish(found) {
        if (settled) return;
        settled = true;
        if (initialTimer) clearTimeout(initialTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        observer?.disconnect();
        resolve(found);
      }

      function check() {
        if (countControls(document) > startCount) {
          finish(true);
        }
      }

      observer?.observe(document.body || document.documentElement || document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "hidden", "style", "aria-hidden"],
      });
      initialTimer = setTimeout(check, DEEP_SCAN_INITIAL_DELAY);
      timeoutTimer = setTimeout(() => finish(false), DEEP_SCAN_POLL_TIMEOUT);
    });
  }

  async function triggerExpandableSections(resumeProfile) {
    const clickedElements = new WeakSet();
    let totalClicked = 0;

    for (
      let round = 0;
      round < DEEP_SCAN_MAX_ROUNDS && totalClicked < DEEP_SCAN_MAX_CLICKS;
      round += 1
    ) {
      const buttons = findDeepScanButtons(clickedElements, resumeProfile);
      if (buttons.length === 0) break;

      sendLog("info", `深度扫描第 ${round + 1} 轮：发现 ${buttons.length} 个可展开区块`);

      for (const button of buttons.slice(0, DEEP_SCAN_MAX_CLICKS - totalClicked)) {
        const startCount = countControls(document);
        scrollIntoView(button);
        clickLikeUser(button);
        clickedElements.add(button);
        totalClicked += 1;

        if (await waitForNewFields(startCount)) {
          sendLog("info", `已触发第 ${totalClicked} 个展开按钮，检测到新字段`);
        }
      }
    }

    if (totalClicked > 0) {
      sendLog("success", `深度扫描完成：共触发 ${totalClicked} 个展开按钮`);
    }
    return totalClicked;
  }

  function buildUnmappedFieldList(fields, mappingById, adaptiveDecisions) {
    return (Array.isArray(fields) ? fields : [])
      .filter((field) => {
        const mapping = mappingById?.get?.(String(field?.fieldId || ""));
        return !mapping?.resumePath;
      })
      .map((field) => {
        const decision = adaptiveDecisions?.get?.(String(field?.fieldId || ""));
        return {
          fieldId: String(field?.fieldId || ""),
          label: String(field?.label || "").slice(0, 160),
          kind: String(field?.kind || "unknown").slice(0, 40),
          inputType: String(field?.inputType || "").slice(0, 40),
          placeholder: String(field?.placeholder || "").slice(0, 160),
          sectionKey: String(field?.sectionKey || "").slice(0, 80),
          sectionLabel: String(field?.sectionLabel || "").slice(0, 120),
          context: String(field?.context || "").slice(0, 240),
          nearbyLabels: Array.isArray(field?.nearbyLabels)
            ? field.nearbyLabels.map((item) => String(item || "").slice(0, 120)).slice(0, 8)
            : [],
          options: Array.isArray(field?.options)
            ? field.options.map((item) => String(item || "").slice(0, 100)).slice(0, 20)
            : [],
          groupId: String(field?.groupId || "").slice(0, 100),
          groupLabel: String(field?.groupLabel || "").slice(0, 120),
          groupIndex: normalizeGroupIndex(field?.groupIndex),
          groupPath: Array.isArray(field?.groupPath)
            ? field.groupPath.slice(0, 6).map((item) => ({
                groupId: String(item?.groupId || "").slice(0, 100),
                label: String(item?.label || "").slice(0, 120),
                kind: String(item?.kind || "").slice(0, 40),
                index: normalizeGroupIndex(item?.index),
              }))
            : [],
          groupFieldLabels: Array.isArray(field?.groupFieldLabels)
            ? field.groupFieldLabels.map((item) => String(item || "").slice(0, 120)).slice(0, 30)
            : [],
          reason: String(decision?.reason || "未匹配到标准简历字段").slice(0, 240),
        };
      })
      .filter((field) => field.fieldId);
  }

  function normalizeGroupIndex(value) {
    if (value == null || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function buildFieldGroupPayload(fields, groups = null) {
    const fieldList = Array.isArray(fields) ? fields : [];
    const validFieldIds = new Set(
      fieldList.map((field) => String(field?.fieldId || "").trim()).filter(Boolean)
    );
    const rawGroups = Array.isArray(groups)
      ? groups
      : Array.isArray(fields?.__groups)
        ? fields.__groups
        : [];
    const sanitizedGroups = rawGroups
      .map((group) => {
        const fieldIds = Array.isArray(group?.fieldIds)
          ? group.fieldIds
              .map((id) => String(id || "").trim())
              .filter((id) => validFieldIds.has(id))
          : [];
        if (!fieldIds.length) return null;
        const groupPath = Array.isArray(group?.groupPath)
          ? group.groupPath
              .map((item) => ({
                groupId: String(item?.groupId || "").slice(0, 100),
                label: String(item?.label || "").slice(0, 120),
                kind: String(item?.kind || "").slice(0, 40),
                index: normalizeGroupIndex(item?.index),
              }))
              .filter((item) => item.groupId || item.label)
              .slice(0, 6)
          : [];
        return {
          groupId: String(group?.groupId || "").slice(0, 100),
          label: String(group?.label || "").slice(0, 120),
          parentGroupId: String(group?.parentGroupId || "").slice(0, 100),
          kind: String(group?.kind || "").slice(0, 40),
          index: normalizeGroupIndex(group?.index),
          fieldIds,
          fieldLabels: Array.isArray(group?.fieldLabels)
            ? group.fieldLabels.map((label) => String(label || "").slice(0, 120)).filter(Boolean).slice(0, 30)
            : [],
          groupPath,
        };
      })
      .filter(Boolean);

    if (sanitizedGroups.length) return sanitizedGroups;

    // Older group detectors may only annotate each field. Reconstruct a
    // compact group list so the model still receives a coherent group view.
    const byGroup = new Map();
    for (const field of fieldList) {
      const groupId = String(field?.groupId || "").trim();
      if (!groupId) continue;
      if (!byGroup.has(groupId)) {
        byGroup.set(groupId, {
          groupId,
          label: String(field?.groupLabel || "").slice(0, 120),
          parentGroupId: String(field?.parentGroupId || "").slice(0, 100),
          kind: String(field?.groupKind || "").slice(0, 40),
          index: normalizeGroupIndex(field?.groupIndex),
          fieldIds: [],
          fieldLabels: [],
          groupPath: Array.isArray(field?.groupPath) ? field.groupPath.slice(0, 6) : [],
        });
      }
      const group = byGroup.get(groupId);
      const fieldId = String(field?.fieldId || "").trim();
      if (fieldId && !group.fieldIds.includes(fieldId)) group.fieldIds.push(fieldId);
      const fieldLabel = String(field?.label || field?.tableColumnLabel || "").trim();
      if (fieldLabel && !group.fieldLabels.includes(fieldLabel)) group.fieldLabels.push(fieldLabel);
    }
    return Array.from(byGroup.values());
  }

  function buildFieldMappingPayload(fields, resumeProfile) {
    const resumeFields = schema
      .getCatalogWithValues(resumeProfile)
      .filter((field) => field.hasValue)
      .map((field) => ({
        path: field.path,
        label: field.label,
        sectionLabel: field.sectionLabel,
        itemLabel: field.itemLabel || "",
        input: field.input,
        hasValue: field.hasValue,
        valuePreview: field.valuePreview,
        options: field.options || [],
      }));

    return {
      url: sanitizePageUrl(location.href),
      title: String(document.title || "").slice(0, 120),
      allowedTransforms: [
        { type: "none" },
        { type: "date_part", part: "year|month|day" },
        { type: "phone_part", part: "countryCode|nationalNumber" },
        { type: "boolean_choice", trueValue: "text", falseValue: "text" },
        { type: "join", separator: ", " },
      ],
      fields,
      // `typeof` keeps this helper compatible with the small isolated payload
      // harness used by older integrations, where only this function is
      // extracted without the surrounding group helper.
      groups:
        typeof buildFieldGroupPayload === "function"
          ? buildFieldGroupPayload(fields)
          : [],
      resumeFields,
    };
  }

  function buildAdaptiveFillPayload(fields, resumeProfile, options = {}) {
    const resumeFields = schema
      .getCatalogWithValues(resumeProfile)
      .filter((field) => field.hasValue)
      .map((field) => ({
        path: field.path,
        label: field.label,
        sectionLabel: field.sectionLabel,
        itemLabel: field.itemLabel || "",
        input: field.input,
        hasValue: field.hasValue,
        valuePreview: field.valuePreview,
        options: field.options || [],
      }));

    const fieldsWithSource = fields.map((field) => {
      const runtime = fieldRuntimeMap.get(field.fieldId);
      return {
        ...field,
        runtimeKind: runtime?.kind || field.kind || "unknown",
        runtimeInputType: runtime?.inputType || field.inputType || "",
        alreadyFilled: hasExistingFieldValue(runtime),
        sourceSnippet: buildAdaptiveSourceSnippet(runtime),
      };
    });

    const allCapabilities = controlCapabilities.getAll();
    return {
      mode: "adaptive_fill",
      scope: options.scope === "page" ? "page" : "selection",
      overwriteExisting: options.overwriteExisting === true,
      url: sanitizePageUrl(location.href),
      title: String(document.title || "").slice(0, 120),
      supportedControlTypes: allCapabilities
        .filter((item) => item.supported !== false)
        .map((item) => ({ kind: item.kind, label: item.label, inputTypes: item.inputTypes })),
      unsupportedControlTypes: allCapabilities
        .filter((item) => item.supported === false)
        .map((item) => ({ kind: item.kind, label: item.label, inputTypes: item.inputTypes })),
      allowedTransforms: [
        { type: "none" },
        { type: "date_part", part: "year|month|day" },
        { type: "phone_part", part: "countryCode|nationalNumber" },
        { type: "boolean_choice", trueValue: "text", falseValue: "text" },
        { type: "join", separator: ", " },
      ],
      fields: fieldsWithSource,
      groups: buildFieldGroupPayload(fieldsWithSource, options.groups),
      resumeFields,
    };
  }

  function buildAdaptiveSourceSnippet(runtime) {
    if (!runtime) return "";

    const nodes = [];
    const addNode = (node) => {
      if (!node || nodes.includes(node)) return;
      nodes.push(node);
    };

    addNode(runtime.el);
    addNode(runtime.trigger);
    addNode(runtime.root);
    if (runtime.el) addNode(getStructuralContainer(runtime.el));
    for (const option of runtime.options || []) addNode(option?.el);
    // Dropdown libraries commonly render their list in a body-level portal;
    // include the nearby visible popup so an adaptive retry can identify the
    // real option nodes and their data/value attributes.
    for (const popup of getCustomDropdownPopupRoots(runtime)) addNode(popup);

    return nodes
      .map((node) => sanitizeAdaptiveDomNode(node))
      .filter(Boolean)
      .join("\n")
      .slice(0, 7000);
  }

  function sanitizeAdaptiveDomNode(node) {
    if (!node) return "";

    try {
      const clone = node.cloneNode?.(true);
      if (!clone) return "";

      for (const removable of clone.querySelectorAll?.("script,style,noscript,iframe") || []) {
        removable.remove();
      }

      const sensitiveAttribute = /^(?:value|checked|selected)$/i;
      const sensitiveName = /(token|secret|password|api[-_]?key|authorization)/i;
      const elements = [clone, ...(clone.querySelectorAll?.("*") || [])];
      for (const element of elements) {
        for (const attribute of Array.from(element.attributes || [])) {
          if (sensitiveAttribute.test(attribute.name) || sensitiveName.test(attribute.name)) {
            element.removeAttribute(attribute.name);
          }
        }
      }

      return String(clone.outerHTML || "").slice(0, 3500);
    } catch (_) {
      return "";
    }
  }

  function normalizeAdaptiveDecisions(rawDecisions, fields) {
    const resumeProfile = arguments[2];
    const validFieldIds = new Set(fields.map((field) => String(field.fieldId)));
    const validResumePaths = new Set(
      schema.getFieldCatalog({ mode: "profile", profile: resumeProfile }).map((field) => field.path)
    );
    const normalized = [];

    for (const item of Array.isArray(rawDecisions) ? rawDecisions : []) {
      const fieldId = String(item?.fieldId || "").trim();
      if (!fieldId || !validFieldIds.has(fieldId)) continue;

      const field = fields.find((entry) => String(entry.fieldId) === fieldId);
      const requestedKind = item?.controlType || item?.strategy || field?.kind || "unknown";
      const controlType = controlCapabilities.normalizeKind(requestedKind) || "unknown";
      const strategy = controlCapabilities.normalizeKind(item?.strategy || controlType) || controlType;
      const shouldFill = item?.shouldFill === true || /^(true|yes|1)$/i.test(String(item?.shouldFill || ""));
      const resumePath = String(item?.resumePath || "").trim();

      normalized.push({
        fieldId,
        shouldFill,
        resumePath: resumePath && validResumePaths.has(resumePath) ? resumePath : "",
        reason: String(item?.reason || "").trim().slice(0, 240),
        controlType,
        strategy,
        transform: normalizeTransform(item?.transform),
      });
    }

    return normalized;
  }

  function isAdaptiveStrategyCompatible(strategy, runtime) {
    const strategyKind = controlCapabilities.normalizeKind(strategy || "");
    const runtimeKind = controlCapabilities.normalizeKind(runtime?.kind || "");
    if (!strategyKind || !runtimeKind) return false;
    if (strategyKind === runtimeKind) return true;
    if (strategyKind === "text" && ["text", "textarea"].includes(runtimeKind)) return true;
    if (strategyKind === "textarea" && runtimeKind === "text") return true;
    if (strategyKind === "readonly_date" && runtimeKind === "text") return true;
    return false;
  }

  async function tryAdaptiveControlAdapter({ modelId, field, runtime, value, decision }) {
    try {
      sendLog("info", `字段 ${field.fieldId} 常规填充失败，正在请求 AI 适配控件...`);
      const payload = {
        mode: "control_adapter",
        field: {
          ...field,
          sourceSnippet: buildAdaptiveSourceSnippet(runtime),
        },
        runtime: {
          kind: runtime?.kind || "unknown",
          adapter: getCustomDropdownAdapter(runtime?.el || runtime?.root),
          inputType: runtime?.inputType || "",
          readOnly: Boolean(runtime?.readOnly),
          label: runtime?.label || field?.label || "",
          placeholder: runtime?.placeholder || field?.placeholder || "",
          context: runtime?.context || field?.context || "",
        },
        currentDecision: decision || null,
        valueType: Array.isArray(value) ? "array" : "text",
        supportedControlTypes: controlCapabilities
          .getAll()
          .filter((item) => item.supported !== false)
          .map((item) => item.kind),
      };

      const aiText = await aiClient.callAI(
        modelId,
        JSON.stringify(payload),
        "control_adapter"
      );
      const parsed = parseJsonFromAiText(aiText);
      const adapterType = controlCapabilities.normalizeKind(parsed?.adapter?.type || "");
      if (!adapterType || adapterType === "unsupported") {
        return { filled: false, message: "AI 未给出安全的控件适配策略" };
      }

      const result = await executeAdaptiveAdapter(runtime, value, adapterType);
      if (result.filled) {
        // A successful strategy becomes a learned capability for this
        // control shape. It is persisted through the shared catalogue so the
        // next adaptive run can advertise it to the model and settings UI.
        const registered = controlCapabilities.registerSupported?.(
          decision?.controlType || runtime?.kind,
          {
            label: field?.label || runtime?.label || decision?.controlType || runtime?.kind,
            inputTypes: runtime?.inputType ? [runtime.inputType] : [],
            adapterKind: adapterType,
          }
        );
        if (registered) {
          sendLog("info", `控件类型 ${registered.kind} 已注册为受支持（${adapterType}）`);
        }
        return {
          ...result,
          message: `已使用 AI 适配策略 ${adapterType}${registered ? "并注册控件类型" : ""}`,
        };
      }
      return result;
    } catch (error) {
      return { filled: false, message: `AI 控件适配失败：${error?.message || String(error)}` };
    }
  }

  /**
   * Last-resort adapter used only when the user explicitly enables danger
   * mode. The model receives no execution privileges during analysis; it can
   * return a script, but this function validates and runs it only after two
   * failed fill attempts. The script is scoped to the current element via a
   * short-lived data attribute and never receives extension APIs or storage.
   */
  async function tryDangerousScriptAdapter({
    modelId,
    field,
    runtime,
    value,
    decision,
    dangerMode,
  }) {
    if (dangerMode !== true) {
      return { filled: false, message: "危险模式未开启" };
    }
    if (!runtime || runtime.kind === "file") {
      return { filled: false, message: "文件上传字段不允许危险模式脚本" };
    }

    try {
      sendLog("warning", `字段 ${field.fieldId} 已连续两次填充失败，危险模式请求 AI 脚本适配...`);
      const payload = {
        mode: "dangerous_fill_adapter",
        field: {
          ...field,
          sourceSnippet: buildAdaptiveSourceSnippet(runtime),
        },
        runtime: {
          kind: runtime?.kind || "unknown",
          adapter: getCustomDropdownAdapter(runtime?.el || runtime?.root),
          inputType: runtime?.inputType || "",
          readOnly: Boolean(runtime?.readOnly),
          label: runtime?.label || field?.label || "",
          placeholder: runtime?.placeholder || field?.placeholder || "",
          context: runtime?.context || field?.context || "",
        },
        currentDecision: decision || null,
        // The value is required for strategy design, but the page script gets
        // it through a JSON literal rather than extension globals.
        value,
      };
      const aiText = await aiClient.callAI(
        modelId,
        JSON.stringify(payload),
        "dangerous_fill_adapter"
      );
      const parsed = parseJsonFromAiText(aiText);
      const adapter = parsed?.adapter || {};
      const adapterType = String(adapter.type || "").trim().toLowerCase();
      if (adapterType !== "script") {
        return { filled: false, message: "AI 未返回危险模式脚本策略" };
      }

      const script = String(adapter.script || "").trim();
      const validation = validateDangerousFillScript(script);
      if (!validation.ok) {
        return { filled: false, message: `危险模式脚本已拦截：${validation.reason}` };
      }

      const result = await executeDangerousFillScript(runtime, value, script);
      if (!result.filled) return result;

      // Keep a successful control shape visible in the shared capability
      // catalogue. We intentionally do not persist the arbitrary script; a
      // later run still has to pass the normal two-failure gate before asking
      // the model for a fresh script.
      const registered = controlCapabilities.registerSupported?.(
        decision?.controlType || runtime?.kind,
        {
          label: field?.label || runtime?.label || decision?.controlType || runtime?.kind,
          inputTypes: runtime?.inputType ? [runtime.inputType] : [],
        }
      );
      if (registered) {
        sendLog("info", `危险模式成功：控件类型 ${registered.kind} 已注册为受支持`);
      }
      return {
        ...result,
        message: `已使用危险模式 AI 脚本适配控件${registered ? "并注册控件类型" : ""}`,
      };
    } catch (error) {
      return {
        filled: false,
        message: `危险模式脚本适配失败：${error?.message || String(error)}`,
      };
    }
  }

  function validateDangerousFillScript(script) {
    if (!script) return { ok: false, reason: "脚本为空" };
    if (script.length > 4000) return { ok: false, reason: "脚本超过 4000 个字符" };

    // Keep the script useful for custom controls while blocking page-wide
    // traversal, data exfiltration, extension APIs and destructive actions.
    const forbidden = [
      /\beval\s*\(/i,
      /\bFunction\s*\(/i,
      /\bimport\s*\(/i,
      /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/i,
      /\b(?:chrome|browser)\s*\./i,
      /\b(?:localStorage|sessionStorage|indexedDB|document\.cookie)\b/i,
      /\bdocument\s*\.\s*(?:querySelector|querySelectorAll|getElementById|getElementsBy)/i,
      /\b(?:querySelector(?:All)?|getElementById|getElementsBy(?:TagName|ClassName|Name)?)\s*\(/i,
      /\b(?:window|globalThis|self)\s*\./i,
      /\b(?:window|globalThis|self)\b/i,
      /\b(?:ownerDocument|defaultView|parentNode|parentElement|children|firstChild|lastChild|nextSibling|previousSibling|form)\b/i,
      /\b(?:submit|requestSubmit)\s*\(/i,
      /\b(?:alert|confirm|prompt)\s*\(/i,
      /\b(?:location|history|navigator)\b/i,
      /\bdocument\s*\.\s*(?:body|head|documentElement|forms|links|images|scripts|styleSheets|all|activeElement)\b/i,
      /<\s*\/?\s*script\b|javascript\s*:/i,
      /\b(?:setTimeout|setInterval)\s*\(/i,
      /\bwhile\s*\(|for\s*\([^;]*;[^;]*;[^)]*\)/i,
      /(?:constructor|prototype|__proto__)\b/i,
    ];
    const blocked = forbidden.find((pattern) => pattern.test(script));
    return blocked
      ? { ok: false, reason: "脚本包含受限制的 API 或页面遍历操作" }
      : { ok: true };
  }

  async function executeDangerousFillScript(runtime, value, script) {
    const el = runtime?.el;
    if (!el || runtime?.kind === "file") {
      return { filled: false, message: "当前控件无法执行危险模式脚本" };
    }

    const before = getDangerousRuntimeFingerprint(runtime);
    const token = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const targetAttribute = "data-ai-resume-danger-target";
    const doneAttribute = "data-ai-resume-danger-done";
    const escapedToken = token.replace(/[^a-z0-9_-]/gi, "");
    const valueLiteral = JSON.stringify(value);
    const runtimeLiteral = JSON.stringify({
      kind: runtime?.kind || "unknown",
      inputType: runtime?.inputType || "",
      label: runtime?.label || "",
      placeholder: runtime?.placeholder || "",
    });

    el.setAttribute(targetAttribute, escapedToken);
    document.documentElement.setAttribute(doneAttribute, "pending");

    // Append into the page world so frameworks that observe native DOM
    // setters/events can process the same operation as an inline script.
    const scriptEl = document.createElement("script");
    scriptEl.textContent = [
      "(async function(){",
      "try {",
      `const el = document.querySelector('[${targetAttribute}="${escapedToken}"]');`,
      `const value = ${valueLiteral};`,
      `const runtime = ${runtimeLiteral};`,
      "if (!el) throw new Error('目标控件不存在');",
      script,
      // Flush one microtask so framework updates scheduled by the script are
      // observed before the content-side verification runs.
      "await Promise.resolve();",
      `document.documentElement.setAttribute('${doneAttribute}', 'ok');`,
      "} catch (error) {",
      `document.documentElement.setAttribute('${doneAttribute}', 'error');`,
      "}",
      "})();",
    ].join("\n");

    try {
      (document.head || document.documentElement).appendChild(scriptEl);
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline) {
        const state = document.documentElement.getAttribute(doneAttribute);
        if (state === "ok" || state === "error") break;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    } finally {
      scriptEl.remove();
      el.removeAttribute(targetAttribute);
      document.documentElement.removeAttribute(doneAttribute);
    }

    const after = getDangerousRuntimeFingerprint(runtime);
    const expected = prepareTextValueForRuntime(runtime, value);
    const changed = Boolean(after) && after !== before;
    const matched = expected && String(after).includes(String(expected));
    return changed || matched
      ? { filled: true }
      : { filled: false, message: "危险模式脚本执行后校验仍未通过" };
  }

  function getDangerousRuntimeFingerprint(runtime) {
    if (!runtime) return "";
    if (runtime.kind === "checkbox_group" || runtime.kind === "radio_group") {
      return (runtime.options || [])
        .filter((option) => option?.el?.checked)
        .map((option) => String(option.label || option.value || "").trim())
        .join("|");
    }
    if (runtime.kind === "select") {
      return String(runtime.el?.value || runtime.el?.selectedOptions?.[0]?.textContent || "").trim();
    }
    if (runtime.kind === "combobox") {
      return getCustomDropdownCommittedTexts(runtime).join("|");
    }
    if (runtime.kind === "contenteditable") {
      return String(runtime.el?.textContent || "").trim();
    }
    return String(runtime.el?.value || runtime.el?.textContent || "").trim();
  }

  async function executeAdaptiveAdapter(runtime, value, adapterType) {
    if (!runtime || runtime.kind === "file") {
      return { filled: false, message: "当前控件不能安全适配" };
    }

    if (["text", "textarea", "native_value"].includes(adapterType)) {
      const desired = prepareTextValueForRuntime(runtime, value);
      if (!desired) return { filled: false, message: "适配值为空" };
      const ok = await setValueWithEvents(runtime.el, desired, runtime);
      return ok ? { filled: true } : { filled: false, message: "适配写入未通过校验" };
    }

    if (adapterType === "select") {
      const ok = await selectByText(runtime.el, value);
      return ok ? { filled: true } : { filled: false, message: "适配下拉选择失败" };
    }

    if (adapterType === "combobox") {
      const ok = await selectCustomDropdownOption(runtime, value);
      return ok ? { filled: true } : { filled: false, message: "适配自定义下拉失败" };
    }

    if (adapterType === "contenteditable") {
      const desired = prepareTextValueForRuntime(runtime, value);
      if (!desired) return { filled: false, message: "适配值为空" };
      runtime.el.focus?.();
      runtime.el.textContent = desired;
      runtime.el.dispatchEvent(new Event("input", { bubbles: true }));
      runtime.el.dispatchEvent(new Event("change", { bubbles: true }));
      return { filled: true };
    }

    if (adapterType === "radio_group" || adapterType === "checkbox_group") {
      return fillOne(
        { ...runtime, kind: adapterType },
        value,
        { overwrite: false }
      );
    }

    return { filled: false, message: `不允许执行适配策略 ${adapterType}` };
  }

  function sanitizePageUrl(value) {
    const rawUrl = String(value || "");
    if (typeof URL !== "function") {
      return rawUrl.split(/[?#]/, 1)[0];
    }

    try {
      const url = new URL(rawUrl);
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch (_) {
      return rawUrl.split(/[?#]/, 1)[0];
    }
  }

  function normalizeMappings(rawMappings, fields) {
    const resumeProfile = arguments[2];
    const validFieldIds = new Set(fields.map((field) => String(field.fieldId)));
    const validResumePaths = new Set(
      schema.getFieldCatalog({ mode: "profile", profile: resumeProfile }).map((field) => field.path)
    );
    const normalized = [];

    for (const item of Array.isArray(rawMappings) ? rawMappings : []) {
      const fieldId = String(item?.fieldId || "").trim();
      if (!fieldId || !validFieldIds.has(fieldId)) continue;

      const resumePath = String(item?.resumePath || "").trim();
      normalized.push({
        fieldId,
        resumePath: resumePath && validResumePaths.has(resumePath) ? resumePath : "",
        reason: String(item?.reason || "").trim().slice(0, 240),
        transform: normalizeTransform(item?.transform),
      });
    }

    return normalized;
  }

  function normalizeTransform(transform) {
    if (!transform || typeof transform !== "object") {
      return { type: "none" };
    }

    const type = String(transform.type || "none").trim();

    if (type === "date_part") {
      const part = ["year", "month", "day"].includes(transform.part)
        ? transform.part
        : "year";
      return { type, part };
    }

    if (type === "phone_part") {
      const part =
        transform.part === "countryCode" ? "countryCode" : "nationalNumber";
      return { type, part };
    }

    if (type === "boolean_choice") {
      return {
        type,
        trueValue: String(transform.trueValue ?? "Yes"),
        falseValue: String(transform.falseValue ?? "No"),
      };
    }

    if (type === "join") {
      return {
        type,
        separator: String(transform.separator || ", "),
      };
    }

    return { type: "none" };
  }

  function deriveFillValue(rawValue, transform, runtime) {
    if (!hasSourceValue(rawValue)) {
      return "";
    }

    const normalizedTransform = normalizeTransform(transform);

    if (normalizedTransform.type === "date_part") {
      return getDatePart(rawValue, normalizedTransform.part);
    }

    if (normalizedTransform.type === "phone_part") {
      return getPhonePart(rawValue, normalizedTransform.part);
    }

    if (normalizedTransform.type === "boolean_choice") {
      return isAffirmative(rawValue)
        ? normalizedTransform.trueValue
        : normalizedTransform.falseValue;
    }

    if (normalizedTransform.type === "join") {
      return joinValue(rawValue, normalizedTransform.separator);
    }

    if (runtime?.kind === "checkbox_group") {
      return normalizeCheckboxCandidates(rawValue);
    }

    return rawValue;
  }

  function hasSourceValue(value) {
    if (Array.isArray(value)) {
      return value.some((item) => String(item || "").trim());
    }

    return String(value ?? "").trim().length > 0;
  }

  function normalizeCheckboxCandidates(value) {
    if (Array.isArray(value)) {
      return value.map((item) => String(item || "").trim()).filter(Boolean);
    }

    const text = String(value || "").trim();
    if (!text) return [];

    return text
      .split(/[\n,，;/]/g)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function hasMeaningfulFillValue(value) {
    if (Array.isArray(value)) {
      return value.some((item) => String(item || "").trim());
    }

    return String(value ?? "").trim().length > 0;
  }

  function getDatePart(value, part) {
    const text = String(value || "").trim();
    if (!text) return "";

    const match = text.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
    if (!match) return "";

    if (part === "year") return match[1] || "";
    if (part === "month") return match[2] ? match[2].padStart(2, "0") : "";
    return match[3] ? match[3].padStart(2, "0") : "";
  }

  function getPhonePart(value, part) {
    const text = String(value || "").trim();
    if (!text) return "";

    if (part === "countryCode") {
      const match = text.match(/^\+?\d{1,4}/);
      return match ? match[0] : "";
    }

    return text.replace(/^\+?\d{1,4}[\s-]*/, "").trim();
  }

  function joinValue(value, separator) {
    if (Array.isArray(value)) {
      return value.map((item) => String(item || "").trim()).filter(Boolean).join(separator);
    }

    return String(value || "").trim();
  }

  async function requestSelectionRect() {
    cleanupSelectionOverlay();

    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.id = SELECTION_OVERLAY_ID;
      overlay.className = "ai-resume-selection-overlay";

      const box = document.createElement("div");
      box.id = SELECTION_BOX_ID;
      box.className = "ai-resume-selection-box";
      box.hidden = true;

      const hint = document.createElement("div");
      hint.id = SELECTION_HINT_ID;
      hint.className = "ai-resume-selection-hint";
      hint.textContent = "拖拽框选要填写的区域，按 Esc 取消";

      overlay.appendChild(box);
      overlay.appendChild(hint);
      document.documentElement.appendChild(overlay);

      let startPoint = null;
      let isDragging = false;

      const cleanup = () => {
        window.removeEventListener("keydown", onKeyDown, true);
        overlay.removeEventListener("pointerdown", onPointerDown, true);
        overlay.removeEventListener("pointermove", onPointerMove, true);
        overlay.removeEventListener("pointerup", onPointerUp, true);
        overlay.removeEventListener("pointercancel", onPointerCancel, true);
        overlay.remove();
      };

      const finish = (rect) => {
        cleanup();
        resolve(rect);
      };

      const onKeyDown = (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        finish(null);
      };

      const onPointerDown = (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        startPoint = { x: event.clientX, y: event.clientY };
        isDragging = true;
        box.hidden = false;
        updateSelectionBox(box, startPoint, startPoint);
      };

      const onPointerMove = (event) => {
        if (!isDragging || !startPoint) return;
        event.preventDefault();
        updateSelectionBox(box, startPoint, { x: event.clientX, y: event.clientY });
      };

      const onPointerCancel = (event) => {
        event.preventDefault();
        finish(null);
      };

      const onPointerUp = (event) => {
        if (!isDragging || !startPoint) {
          finish(null);
          return;
        }

        event.preventDefault();
        const rect = normalizeSelectionRect(startPoint, {
          x: event.clientX,
          y: event.clientY,
        });
        isDragging = false;
        startPoint = null;

        if (!rect || rect.width < MIN_SELECTION_SIZE || rect.height < MIN_SELECTION_SIZE) {
          finish(null);
          return;
        }

        finish(rect);
      };

      window.addEventListener("keydown", onKeyDown, true);
      overlay.addEventListener("pointerdown", onPointerDown, true);
      overlay.addEventListener("pointermove", onPointerMove, true);
      overlay.addEventListener("pointerup", onPointerUp, true);
      overlay.addEventListener("pointercancel", onPointerCancel, true);
    });
  }

  function cleanupSelectionOverlay() {
    document.getElementById(SELECTION_OVERLAY_ID)?.remove();
  }

  function updateSelectionBox(box, startPoint, endPoint) {
    if (!box) return;
    const rect = normalizeSelectionRect(startPoint, endPoint);
    if (!rect) return;

    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
  }

  function normalizeSelectionRect(startPoint, endPoint) {
    if (!startPoint || !endPoint) return null;
    const left = Math.min(startPoint.x, endPoint.x);
    const top = Math.min(startPoint.y, endPoint.y);
    const right = Math.max(startPoint.x, endPoint.x);
    const bottom = Math.max(startPoint.y, endPoint.y);

    return {
      left,
      top,
      right,
      bottom,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    };
  }

  function hasCustomDropdownClassHint(el) {
    const className = String(el?.className || "");
    const identity = [
      className,
      el?.id,
      el?.getAttribute?.("name"),
      el?.getAttribute?.("data-testid"),
      el?.getAttribute?.("data-test-id"),
      el?.getAttribute?.("data-component"),
      el?.getAttribute?.("data-role"),
    ]
      .filter(Boolean)
      .join(" ");

    return /(^|[\s_-])(select|select2|selectbox|chosen|layui|dropdown|drop[-_]?menu|combobox|autocomplete)([\s_-]|$)/i.test(identity);
  }

  function getCustomDropdownAdapter(el) {
    if (!el) return "generic";

    const nodes = [];
    let current = el;
    for (let depth = 0; current && depth < 6; depth += 1) {
      nodes.push(current);
      current = current.parentElement;
    }

    const identity = nodes
      .flatMap((node) => [
        node?.className,
        node?.id,
        node?.getAttribute?.("data-component"),
        node?.getAttribute?.("data-role"),
      ])
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    if (/\b(?:el-select|el-cascader|el-tree-select|el-autocomplete)\b/.test(identity)) {
      return "element";
    }
    if (/\b(?:ant-select|ant-cascader|ant-tree-select)\b/.test(identity)) {
      return "ant";
    }
    if (/\b(?:ivu-select|i-select)\b/.test(identity)) {
      return "ivu";
    }
    if (/\b(?:layui-form-select|layui-select)\b/.test(identity)) {
      return "layui";
    }
    if (/\b(?:chosen-container|chosen-single|chosen-choices|chosen-drop)\b/.test(identity)) {
      return "chosen";
    }
    if (/\b(?:select2-container|select2-selection|select2-dropdown)\b/.test(identity)) {
      return "select2";
    }

    const role = String(el.getAttribute?.("role") || "").toLowerCase();
    const controls = el.getAttribute?.("aria-controls") || el.getAttribute?.("aria-owns");
    if (el.tagName?.toLowerCase?.() === "input" &&
        (el.readOnly || el.getAttribute?.("aria-readonly") === "true") &&
        controls) {
      return "readonly-popup";
    }
    if (role === "combobox" || controls) {
      return "aria";
    }
    if (/\b(?:select-box|select_box|selectbox|drop-menu|drop_menu|dropmenu|dropdown-select|bootstrap-select|bs-select)\b/.test(identity)) {
      return "generic-menu";
    }
    return "generic";
  }

  function findCustomDropdownRoot(el) {
    if (!el) return null;

    const explicitRoot = el.closest?.(CUSTOM_DROPDOWN_CONTROL_SELECTOR);
    if (explicitRoot) return explicitRoot;

    let current = el;
    let matched = null;
    for (let depth = 0; current && depth < 4; depth += 1) {
      if (hasCustomDropdownClassHint(current)) {
        matched = current;
      }
      current = current.parentElement;
    }

    return matched || el;
  }

  function isCustomDropdownElement(el, semanticMeta = null) {
    if (!el || el.tagName?.toLowerCase?.() === "select") return false;

    const role = String(el.getAttribute?.("role") || "").toLowerCase();
    const popupRole = String(el.getAttribute?.("aria-haspopup") || "").toLowerCase();
    const adapter = getCustomDropdownAdapter(el);
    const controls = [
      el.getAttribute?.("aria-controls"),
      el.getAttribute?.("aria-owns"),
    ]
      .filter(Boolean)
      .flatMap((value) => String(value).split(/\s+/g));
    const hasClassHintOnElement = hasCustomDropdownClassHint(el);
    const hasExplicitSemantics =
      role === "combobox" ||
      popupRole === "listbox" ||
      ["list", "both"].includes(String(el.getAttribute?.("aria-autocomplete") || "").toLowerCase()) ||
      (el.hasAttribute?.("aria-expanded") &&
        controls.length > 0) ||
      // A number of date/address pickers expose a readonly input with an
      // aria-controls hook but omit role=combobox. Treat it as a dropdown only
      // when the referenced panel looks like a listbox/options popup.
      (el.tagName?.toLowerCase?.() === "input" &&
        (el.readOnly || el.getAttribute?.("aria-readonly") === "true") &&
        controls.length > 0 &&
        controls.some((id) => {
          const target = document.getElementById?.(String(id).replace(/^#/, ""));
          if (!target) return false;
          const targetRole = String(target.getAttribute?.("role") || "").toLowerCase();
          return targetRole === "listbox" || Boolean(target.querySelector?.(CUSTOM_DROPDOWN_OPTION_SELECTOR));
        }));

    const root = findCustomDropdownRoot(el);
    const hasClassHint =
      hasClassHintOnElement ||
      (root && root !== el && hasCustomDropdownClassHint(root));
    const semanticText = [
      semanticMeta?.label,
      semanticMeta?.context,
      semanticMeta?.sectionLabel,
      el.getAttribute?.("placeholder"),
      el.getAttribute?.("name"),
      root?.className,
    ]
      .filter(Boolean)
      .join(" ");
    const looksLikeDate = /(日期|出生|年月|入学|毕业|时间|calendar|datepicker|date-picker)/i.test(
      semanticText
    );

    if (
      looksLikeDate &&
      popupRole !== "listbox" &&
      !hasClassHint &&
      !["element", "layui", "chosen", "select2"].includes(adapter)
    ) return false;
    return hasExplicitSemantics || hasClassHint;
  }

  function resolveCustomDropdownControl(el) {
    if (!el) return null;
    if (el.tagName?.toLowerCase?.() === "input") return el;

    const nestedSemantic = el.querySelector?.(
      '[role="combobox"],[aria-haspopup="listbox"],input[aria-controls],input[aria-owns]'
    );
    if (nestedSemantic) return nestedSemantic;

    const nestedInput = el.querySelector?.(
      'input:not([type="hidden"]),[contenteditable="true"],[contenteditable=""]'
    );
    return nestedInput || el;
  }

  function findCustomDropdownTrigger(el) {
    if (!el) return null;

    const adapter = getCustomDropdownAdapter(el);
    const root = findCustomDropdownRoot(el);
    const adapterSelectors = {
      element: '.el-select__wrapper,.el-select .el-input__inner,.el-select__caret,.el-input__inner,.el-autocomplete .el-input__inner',
      ant: '.ant-select-selector,.ant-select-selection-search-input,.ant-select-arrow',
      ivu: '.ivu-select-selection,.ivu-select-input,.ivu-select-arrow',
      layui: '.layui-select-title input,.layui-select-title,.layui-edge',
      chosen: '.chosen-single,.chosen-choices,.chosen-search input',
      select2: '.select2-selection,[role="combobox"]',
      "generic-menu": '[class*="select-box"],[class*="select_box"],[class*="selectbox"],[class*="selectBox"],[class*="drop-menu"],[class*="drop_menu"],[class*="dropmenu"],[class*="dropdown-select"],[class*="bootstrap-select"],[class*="bs-select"]',
    };
    const adapterSelector = adapterSelectors[adapter];
    const adapterTrigger = adapterSelector
      ? root?.querySelector?.(adapterSelector)
      : null;
    if (adapterTrigger) return adapterTrigger;

    const explicitTrigger = el.closest?.(
      'label,[role="combobox"],[aria-haspopup="listbox"],[class*="Select-container"],[class*="select-container"]'
    );
    if (explicitTrigger) return explicitTrigger;

    const nestedTrigger = root?.querySelector?.(
      'label,[role="combobox"],[aria-haspopup="listbox"],[class*="Select-container"],[class*="select-container"],[class*="select-box"],[class*="drop-menu"]'
    );
    return nestedTrigger || root || el;
  }

  function getCustomDropdownOptionLabel(option) {
    if (!option) return "";
    return normalizeText(
      option.getAttribute?.("aria-label") ||
        option.getAttribute?.("data-label") ||
        option.getAttribute?.("data-text") ||
        option.getAttribute?.("data-name") ||
        option.getAttribute?.("title") ||
        option.textContent ||
        option.getAttribute?.("lay-value") ||
        option.getAttribute?.("data-code") ||
        option.getAttribute?.("value") ||
        ""
    );
  }

  function collectDeclaredComboboxOptions(el) {
    const root = findCustomDropdownRoot(el);
    const ids = [
      root?.getAttribute?.("aria-controls"),
      root?.getAttribute?.("aria-owns"),
      el?.getAttribute?.("aria-controls"),
      el?.getAttribute?.("aria-owns"),
    ]
      .filter(Boolean)
      .flatMap((value) => String(value).split(/\s+/g));

    const labels = [];
    for (const id of ids) {
      const target = document.getElementById?.(id.replace(/^#/, ""));
      if (!target) continue;
      for (const option of Array.from(
        target.querySelectorAll?.(CUSTOM_DROPDOWN_OPTION_SELECTOR) || []
      )) {
        const label = getCustomDropdownOptionLabel(option);
        if (label && !labels.includes(label)) labels.push(label);
      }
    }

    return labels.slice(0, 60);
  }

  function buildCustomDropdownRuntime(fieldId, el, semanticMeta) {
    const root = findCustomDropdownRoot(el);
    const trigger = findCustomDropdownTrigger(el);
    return {
      fieldId,
      kind: "combobox",
      el,
      trigger,
      root: root || el,
      label: semanticMeta?.label || "",
      placeholder: el.getAttribute?.("placeholder") || "",
      context: semanticMeta?.context || "",
      nearbyLabels: semanticMeta?.nearbyLabels || [],
    };
  }

  function scanFields({ scope = "page", selectionRect = null } = {}) {
    const fullPage = arguments[0]?.fullPage === true;
    const root = scope === "selection" || fullPage ? document : pickLikelyFormRoot();
    const elements = collectControls(root);

    const fields = [];
    const runtime = [];

    let idSeq = 0;
    const radioGroups = new Map();
    const checkboxGroups = new Map();
    const scannedCustomDropdownRoots = new WeakSet();

    for (const el of elements) {
      if (!isFillableElement(el)) continue;

      const tag = el.tagName.toLowerCase();
      const baseInputType = tag === "input"
        ? String(el.getAttribute("type") || "text").toLowerCase()
        : "";
      const semanticMeta = buildFieldSemanticMeta(el, {
        kind: tag === "textarea" ? "textarea" : tag === "select" ? "select" : "text",
        inputType: baseInputType,
      });
      const commonMeta = {
        required: Boolean(el.required || el.getAttribute("aria-required") === "true"),
        context: semanticMeta.context,
        sectionKey: semanticMeta.sectionKey,
        sectionLabel: semanticMeta.sectionLabel,
        sectionEvidence: semanticMeta.sectionEvidence,
        nearbyLabels: semanticMeta.nearbyLabels,
      };

      if (tag !== "select" && isCustomDropdownElement(el, semanticMeta)) {
        const root = findCustomDropdownRoot(el) || el;
        if (scannedCustomDropdownRoots.has(root)) continue;
        scannedCustomDropdownRoots.add(root);

        const control = resolveCustomDropdownControl(el) || el;
        const fieldId = `f_${++idSeq}`;
        fields.push({
          fieldId,
          kind: "select",
          label: semanticMeta.label,
          name: control.getAttribute?.("name") || el.getAttribute?.("name") || "",
          id: control.id || el.id || "",
          placeholder: control.getAttribute?.("placeholder") || "",
          options: collectDeclaredComboboxOptions(control),
          ...commonMeta,
        });

        runtime.push(buildCustomDropdownRuntime(fieldId, control, semanticMeta));
        continue;
      }

      if (tag === "select") {
        const fieldId = `f_${++idSeq}`;
        const options = Array.from(el.options || [])
          .map((opt) => String(opt.textContent || "").trim())
          .filter(Boolean)
          .slice(0, 60);

        fields.push({
          fieldId,
          kind: "select",
          label: semanticMeta.label,
          name: el.getAttribute("name") || "",
          id: el.id || "",
          placeholder: "",
          options,
          ...commonMeta,
        });

        runtime.push({ fieldId, kind: "select", el });
        continue;
      }

      if (tag === "textarea") {
        const fieldId = `f_${++idSeq}`;
        fields.push({
          fieldId,
          kind: "textarea",
          label: semanticMeta.label,
          name: el.getAttribute("name") || "",
          id: el.id || "",
          placeholder: el.getAttribute("placeholder") || "",
          ...commonMeta,
        });

        runtime.push({ fieldId, kind: "textarea", el });
        continue;
      }

      const isContentEditable =
        el.getAttribute("contenteditable") === "true" ||
        el.getAttribute("contenteditable") === "";
      if (isContentEditable) {
        const fieldId = `f_${++idSeq}`;
        fields.push({
          fieldId,
          kind: "contenteditable",
          label: semanticMeta.label,
          name: el.getAttribute("name") || "",
          id: el.id || "",
          placeholder: el.getAttribute("placeholder") || "",
          ...commonMeta,
        });

        runtime.push({ fieldId, kind: "contenteditable", el });
        continue;
      }

      if (tag !== "input") continue;

      const type = baseInputType;
      if (
        [
          "hidden",
          "password",
          "submit",
          "button",
          "reset",
          "image",
          "range",
          "color",
        ].includes(type)
      ) {
        continue;
      }

      if (type === "file") {
        const fieldId = `f_${++idSeq}`;
        fields.push({
          fieldId,
          kind: "file",
          label: semanticMeta.label,
          name: el.getAttribute("name") || "",
          id: el.id || "",
          placeholder: "",
          inputType: type,
          ...commonMeta,
        });

        runtime.push({ fieldId, kind: "file", inputType: type, el });
        continue;
      }

      if (type === "radio" || type === "checkbox") {
        const name = el.getAttribute("name") || el.id || "";
        const groupScope =
          el.closest?.('form, fieldset, [role="radiogroup"], [role="group"]') ||
          el.parentElement ||
          el;
        const groupKey = `${type}:${getRadioScopeId(groupScope)}:${name || "(no-name)"}`;
        const groupMap = type === "radio" ? radioGroups : checkboxGroups;

        if (!groupMap.has(groupKey)) {
          const groupMeta = buildFieldSemanticMeta(el, {
            kind: type === "radio" ? "radio_group" : "checkbox_group",
            inputType: type,
          });
          groupMap.set(groupKey, {
            type,
            name,
            elements: [],
            label: groupMeta.label || getGroupLabel(el),
            context: groupMeta.context,
            sectionKey: groupMeta.sectionKey,
            sectionLabel: groupMeta.sectionLabel,
            sectionEvidence: groupMeta.sectionEvidence,
            nearbyLabels: groupMeta.nearbyLabels,
          });
        }

        groupMap.get(groupKey).elements.push(el);
        continue;
      }

      const fieldId = `f_${++idSeq}`;
      fields.push({
        fieldId,
        kind: "text",
        inputType: type,
        label: semanticMeta.label,
        name: el.getAttribute("name") || "",
        id: el.id || "",
        placeholder: el.getAttribute("placeholder") || "",
        autocomplete: el.getAttribute("autocomplete") || "",
        ...commonMeta,
      });

      runtime.push(buildTextLikeRuntime(fieldId, el, type, semanticMeta));
    }

    for (const group of radioGroups.values()) {
      const fieldId = `f_${++idSeq}`;
      const options = group.elements
        .map((input) => ({
          label: getOptionLabel(input),
          value: input.value || "",
        }))
        .filter((item) => item.label || item.value)
        .slice(0, 80);

      fields.push({
        fieldId,
        kind: "radio_group",
        label: group.label,
        name: group.name,
        options: options.map((item) => item.label || item.value),
        context: group.context,
        sectionKey: group.sectionKey,
        sectionLabel: group.sectionLabel,
        sectionEvidence: group.sectionEvidence,
        nearbyLabels: group.nearbyLabels,
        required: group.elements.some(
          (input) => input.required || input.getAttribute("aria-required") === "true"
        ),
      });

      runtime.push({
        fieldId,
        kind: "radio_group",
        options: group.elements.map((input) => ({
          el: input,
          label: getOptionLabel(input) || input.value || "",
          value: input.value || "",
        })),
      });
    }

    for (const group of checkboxGroups.values()) {
      const fieldId = `f_${++idSeq}`;
      const options = group.elements
        .map((input) => ({
          label: getOptionLabel(input),
          value: input.value || "",
        }))
        .filter((item) => item.label || item.value)
        .slice(0, 80);

      fields.push({
        fieldId,
        kind: "checkbox_group",
        label: group.label,
        name: group.name,
        options: options.map((item) => item.label || item.value),
        context: group.context,
        sectionKey: group.sectionKey,
        sectionLabel: group.sectionLabel,
        sectionEvidence: group.sectionEvidence,
        nearbyLabels: group.nearbyLabels,
        required: group.elements.some(
          (input) => input.required || input.getAttribute("aria-required") === "true"
        ),
      });

      runtime.push({
        fieldId,
        kind: "checkbox_group",
        options: group.elements.map((input) => ({
          el: input,
          label: getOptionLabel(input) || input.value || "",
          value: input.value || "",
        })),
      });
    }

    if (scope === "selection" && selectionRect) {
      const allowedFieldIds = new Set();

      for (const item of runtime) {
        if (runtimeMatchesSelection(item, selectionRect)) {
          allowedFieldIds.add(item.fieldId);
        }
      }

      return {
        fields: fields.filter((field) => allowedFieldIds.has(field.fieldId)),
        runtime: runtime.filter((item) => allowedFieldIds.has(item.fieldId)),
      };
    }

    return { fields, runtime };
  }

  function getRadioScopeId(element) {
    if (!element || (typeof element !== "object" && typeof element !== "function")) {
      return "global";
    }

    if (!radioScopeIds.has(element)) {
      radioScopeSequence += 1;
      radioScopeIds.set(element, `scope-${radioScopeSequence}`);
    }
    return radioScopeIds.get(element);
  }

  function runtimeMatchesSelection(runtime, selectionRect) {
    const runtimeRect = getRuntimeViewportRect(runtime);
    if (!runtimeRect) return false;
    return rectsIntersect(runtimeRect, selectionRect);
  }

  function getRuntimeViewportRect(runtime) {
    if (!runtime) return null;

    if (runtime.el) {
      return rectFromDomRect(runtime.el.getBoundingClientRect());
    }

    if (Array.isArray(runtime.options) && runtime.options.length > 0) {
      const rects = runtime.options
        .map((option) => rectFromDomRect(option?.el?.getBoundingClientRect?.()))
        .filter(Boolean);
      return mergeRects(rects);
    }

    return null;
  }

  function rectFromDomRect(rect) {
    if (!rect) return null;
    const width = Number(rect.width || 0);
    const height = Number(rect.height || 0);
    if (width <= 0 || height <= 0) return null;

    return {
      left: Number(rect.left || 0),
      top: Number(rect.top || 0),
      right: Number(rect.right || 0),
      bottom: Number(rect.bottom || 0),
      width,
      height,
    };
  }

  function mergeRects(rects) {
    if (!Array.isArray(rects) || rects.length === 0) return null;

    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const right = Math.max(...rects.map((rect) => rect.right));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));

    return {
      left,
      top,
      right,
      bottom,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    };
  }

  function rectsIntersect(leftRect, rightRect) {
    if (!leftRect || !rightRect) return false;
    return !(
      leftRect.right < rightRect.left ||
      leftRect.left > rightRect.right ||
      leftRect.bottom < rightRect.top ||
      leftRect.top > rightRect.bottom
    );
  }

  function pickLikelyFormRoot() {
    const forms = Array.from(document.querySelectorAll("form")).filter((form) =>
      isVisible(form)
    );
    if (forms.length === 0) return document;

    const ranked = forms
      .map((form) => ({ form, count: countControls(form) }))
      .sort((left, right) => right.count - left.count);

    if (ranked[0]?.count >= 2) {
      return ranked[0].form;
    }

    return document;
  }

  function countControls(root) {
    return collectControls(root).length;
  }

  function collectControls(root) {
    const scope = root || document;
    const selectors =
      `input, textarea, select, [contenteditable="true"], [contenteditable=""], ${CUSTOM_DROPDOWN_HOST_SELECTOR}`;

    return Array.from(scope.querySelectorAll(selectors)).filter((el) => isVisible(el));
  }

  function isFillableElement(el) {
    if (!el) return false;
    if (el.disabled) return false;
    if (el.getAttribute("aria-disabled") === "true") return false;
    return true;
  }

  function isVisible(el) {
    try {
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") return false;
      const rects = el.getClientRects();
      return rects && rects.length > 0;
    } catch (_) {
      return false;
    }
  }

  function buildFieldSemanticMeta(el, { kind = "text", inputType = "" } = {}) {
    const primaryCandidates = collectDirectFieldLabelCandidates(el);
    const nearbyLabels = collectNearbyLabelCandidates(el).slice(0, 6);
    const rawLabel = fieldText.selectBestFieldTextCandidate(primaryCandidates);
    const filteredNearbyLabels = nearbyLabels.filter((item) => item !== rawLabel);
    const section = fieldSemantics.inferSectionFromTexts([
      rawLabel,
      ...filteredNearbyLabels,
      ...collectSectionTextCandidates(el),
    ]);

    const label =
      rawLabel ||
      selectFallbackFieldLabel(filteredNearbyLabels, {
        kind,
        inputType,
        sectionLabel: section.label,
      });

    return {
      label,
      context: getFieldContext(el, {
        label,
        nearbyLabels: filteredNearbyLabels,
        sectionLabel: section.label,
      }),
      sectionKey: section.key || "",
      sectionLabel: section.label || "",
      sectionEvidence: section.evidence || "",
      nearbyLabels: filteredNearbyLabels.slice(0, 4),
    };
  }

  function buildTextLikeRuntime(fieldId, el, inputType, semanticMeta) {
    return {
      fieldId,
      kind: "text",
      inputType,
      el,
      readOnly: Boolean(el.readOnly || el.getAttribute("aria-readonly") === "true"),
      label: semanticMeta?.label || "",
      placeholder: el.getAttribute("placeholder") || "",
      context: semanticMeta?.context || "",
      nearbyLabels: semanticMeta?.nearbyLabels || [],
      hasCalendarIcon: Boolean(
        el.closest?.(
          '[class*="picker"],[class*="Picker"],[class*="calendar"],[class*="Calendar"],[class*="date"],[class*="Date"]'
        ) || el.parentElement?.querySelector?.(".mtdicon-calendar-o,[class*='calendar']")
      ),
    };
  }

  function getFieldLabel(el) {
    return buildFieldSemanticMeta(el).label;
  }

  function getFieldContext(el, { label = "", nearbyLabels = [], sectionLabel = "" } = {}) {
    const container = getStructuralContainer(el);
    const text = getRawFieldContext(container, el);
    if (text) {
      return text.length > 160 ? `${text.slice(0, 157)}...` : text;
    }

    const fallbackParts = [];
    pushUniqueMeaningfulText(fallbackParts, sectionLabel);
    for (const item of nearbyLabels) {
      if (item === label) continue;
      pushUniqueMeaningfulText(fallbackParts, item);
    }

    const fallback = fallbackParts.slice(0, 3).join(" / ");
    if (!fallback) return "";
    return fallback.length > 160 ? `${fallback.slice(0, 157)}...` : fallback;
  }

  function getRawFieldContext(container, skipNode) {
    return getNodeTextWithoutControls(container, {
      skipNode,
      maxLength: 240,
    });
  }

  function getGroupLabel(input) {
    const fieldset = input.closest?.("fieldset");
    const legendText = normalizeText(fieldset?.querySelector?.("legend")?.textContent || "");
    if (legendText) return legendText;

    const container =
      input.closest?.(
        '[class*="form"],[class*="Form"],[class*="field"],[class*="Field"],[class*="item"],[class*="Item"],[class*="row"],[class*="Row"]'
      ) || input.parentElement;

    const text = normalizeText(container?.textContent || "");
    return text ? text.slice(0, 80) : "";
  }

  function getOptionLabel(input) {
    const id = input.id;
    if (id) {
      const forLabel = document.querySelector(`label[for="${cssEscape(id)}"]`);
      const labelText = normalizeText(forLabel?.textContent || "");
      if (labelText) return labelText;
    }

    const wrapping = input.closest?.("label");
    const wrappingText = normalizeText(wrapping?.textContent || "");
    if (wrappingText) return wrappingText;

    const siblingCandidates = Array.from(input.parentElement?.children || [])
      .filter((node) => node && node !== input)
      .map((node) => normalizeText(node.textContent || ""))
      .filter((text) => fieldText.isMeaningfulFieldText(text));
    const siblingText = fieldText.selectBestFieldTextCandidate(siblingCandidates);
    if (siblingText) return siblingText;

    return "";
  }

  function normalizeText(text) {
    return fieldText.normalizeFieldText(text);
  }

  function collectDirectFieldLabelCandidates(el) {
    const candidates = [];

    pushUniqueMeaningfulText(candidates, el.getAttribute?.("aria-label"));

    const labelledBy = el.getAttribute?.("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/g)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((node) => normalizeText(node.textContent || ""));

      for (const part of parts) {
        pushUniqueMeaningfulText(candidates, part);
      }
    }

    const id = el.id;
    if (id) {
      const forLabel = document.querySelector(`label[for="${cssEscape(id)}"]`);
      pushUniqueMeaningfulText(candidates, forLabel?.textContent || "");
    }

    const wrapping = el.closest?.("label");
    pushUniqueMeaningfulText(candidates, wrapping?.textContent || "");

    pushUniqueMeaningfulText(candidates, el.getAttribute?.("placeholder") || "");
    pushUniqueMeaningfulText(candidates, el.getAttribute?.("name") || "");

    return candidates;
  }

  function collectNearbyLabelCandidates(el) {
    const candidates = [];
    const containers = collectRelevantContainers(el);

    for (const container of containers) {
      for (const child of Array.from(container.children || [])) {
        if (child === el || child.contains?.(el)) continue;

        pushTextFromNode(candidates, child, { skipNode: el, maxLength: 120 });

        const nestedNodes = child.querySelectorAll?.(LABEL_LIKE_SELECTOR);
        for (const node of nestedNodes || []) {
          pushTextFromNode(candidates, node, { skipNode: el, maxLength: 120 });
        }
      }
    }

    let current = el;
    for (let depth = 0; current && depth < 4; depth += 1) {
      pushTextFromNode(candidates, current.previousElementSibling, {
        skipNode: el,
        maxLength: 120,
      });
      pushTextFromNode(candidates, current.nextElementSibling, {
        skipNode: el,
        maxLength: 120,
      });
      current = current.parentElement;
    }

    return candidates;
  }

  function collectStructuralFieldLabelCandidates(el) {
    return collectNearbyLabelCandidates(el);
  }

  function collectSectionTextCandidates(el) {
    const candidates = [];
    let current = getStructuralContainer(el);
    let depth = 0;

    while (current && depth < 6) {
      const headingNodes = current.querySelectorAll?.(HEADING_LIKE_SELECTOR);
      for (const node of headingNodes || []) {
        if (node === el || node.contains?.(el)) continue;
        pushTextFromNode(candidates, node, { skipNode: el, maxLength: 80 });
      }

      let sibling = current.previousElementSibling;
      let siblingDepth = 0;
      while (sibling && siblingDepth < 3) {
        pushTextFromNode(candidates, sibling, {
          skipNode: el,
          maxLength: 80,
        });
        const nestedNodes = sibling.querySelectorAll?.(`${HEADING_LIKE_SELECTOR},${LABEL_LIKE_SELECTOR}`);
        for (const node of nestedNodes || []) {
          pushTextFromNode(candidates, node, { skipNode: el, maxLength: 80 });
        }
        sibling = sibling.previousElementSibling;
        siblingDepth += 1;
      }

      current = current.parentElement?.closest?.(STRUCTURAL_CONTAINER_SELECTOR) || current.parentElement;
      depth += 1;
    }

    return candidates;
  }

  function selectFallbackFieldLabel(candidates, { kind = "text", inputType = "", sectionLabel = "" } = {}) {
    const filtered = candidates.filter((text) => {
      if (kind === "text" && /^(描述|补充说明|说明|内容|详情)$/.test(text)) {
        return false;
      }
      return true;
    });

    const best = fieldText.selectBestFieldTextCandidate(filtered);
    if (best) return best;

    if (!sectionLabel) return "";
    if (inputType === "url") return `${sectionLabel}链接字段`;
    if (inputType === "date" || inputType === "month") return `${sectionLabel}时间字段`;
    if (kind === "textarea" || kind === "contenteditable") return `${sectionLabel}描述字段`;
    return `${sectionLabel}字段`;
  }

  function pushTextFromNode(list, node, { skipNode = null, maxLength = 120 } = {}) {
    pushUniqueMeaningfulText(
      list,
      getNodeTextWithoutControls(node, {
        skipNode,
        maxLength,
      })
    );
  }

  function pushUniqueMeaningfulText(list, value) {
    const text = normalizeText(value || "");
    if (!fieldText.isMeaningfulFieldText(text)) return;
    if (Array.isArray(list) && !list.includes(text)) {
      list.push(text);
    }
  }

  function collectRelevantContainers(el) {
    const containers = [];
    let current = el.parentElement;

    while (current && containers.length < 4) {
      if (current.matches?.(STRUCTURAL_CONTAINER_SELECTOR)) {
        containers.push(current);
      }
      current = current.parentElement;
    }

    if (containers.length === 0 && el.parentElement) {
      containers.push(el.parentElement);
    }

    return containers;
  }

  function getStructuralContainer(el) {
    return collectRelevantContainers(el)[0] || el.parentElement;
  }

  function getNodeTextWithoutControls(node, { skipNode = null, maxLength = 200 } = {}) {
    if (!node) return "";

    try {
      const clone = node.cloneNode(true);
      const selectors = [CONTROL_SELECTOR];

      if (skipNode?.id) {
        selectors.push(`#${cssEscape(skipNode.id)}`);
      }

      for (const child of clone.querySelectorAll(selectors.join(","))) {
        child.remove();
      }

      const text = normalizeText(clone.textContent || "");
      if (!fieldText.isMeaningfulFieldText(text)) {
        return "";
      }

      return maxLength && text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
    } catch (_) {
      return "";
    }
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }

    return String(value).replace(/["\\]/g, "\\$&");
  }

  function hasExistingFieldValue(runtime) {
    if (!runtime) return false;

    if (runtime.kind === "checkbox_group" || runtime.kind === "radio_group") {
      return (runtime.options || []).some((option) => Boolean(option?.el?.checked));
    }

    if (runtime.kind === "select") {
      const selectedIndex = Number(runtime.el?.selectedIndex ?? -1);
      const value = String(runtime.el?.value ?? "").trim();
      if (!value) return selectedIndex > 0;
      return true;
    }

    if (runtime.kind === "combobox") {
      const placeholder = normalizeText(runtime.placeholder || "");
      return getCustomDropdownCommittedTexts(runtime).some((text) => {
        const normalized = normalizeText(text);
        if (!normalized || (placeholder && normalized === placeholder)) return false;
        return !/^(请选择|请选择一项|选择|请选择内容|请输入|select|please select)$/i.test(normalized);
      });
    }

    if (runtime.kind === "contenteditable") {
      return Boolean(String(runtime.el?.textContent || "").trim());
    }

    if (runtime.kind === "file") {
      return Boolean(runtime.el?.files?.length);
    }

    return Boolean(String(runtime.el?.value ?? "").trim());
  }

  async function fillOne(runtime, value, { overwrite = true } = {}) {
    if (!runtime) return { filled: false, message: "字段不存在" };

    if (runtime.kind === "file") {
      return { filled: false, message: "文件上传字段无法自动填写" };
    }

    if (runtime.kind === "checkbox_group") {
      const desired = normalizeCheckboxCandidates(value);
      if (desired.length === 0) {
        return { filled: false, message: "没有可勾选项" };
      }

      let any = false;
      for (const option of runtime.options || []) {
        const shouldCheck = matchesAnyCandidate(option.label || option.value, desired);
        const shouldBeChecked = overwrite
          ? shouldCheck
          : Boolean(option.el?.checked) || shouldCheck;
        const ok = await safeCheck(option.el, shouldBeChecked);
        if (ok && shouldCheck) any = true;
      }

      return any
        ? { filled: true }
        : { filled: false, message: "未找到可匹配的多选项" };
    }

    if (runtime.kind === "radio_group") {
      const best = pickBestOption(runtime.options || [], value);
      if (!best) {
        return { filled: false, message: "未找到可匹配的单选项" };
      }

      const ok = await safeCheck(best.el, true);
      return ok ? { filled: true } : { filled: false, message: "点击单选项失败" };
    }

    if (runtime.kind === "select") {
      const ok = await selectByText(runtime.el, value);
      return ok ? { filled: true } : { filled: false, message: "未找到可匹配的下拉选项" };
    }

    if (runtime.kind === "combobox") {
      const ok = await selectCustomDropdownOption(runtime, value);
      return ok
        ? { filled: true }
        : { filled: false, message: "未找到或未能选中匹配的自定义下拉选项" };
    }

    if (runtime.kind === "contenteditable") {
      const desired = prepareTextValueForRuntime(runtime, value);
      if (!desired) return { filled: false, message: "没有可填写内容" };

      const el = runtime.el;
      scrollIntoView(el);
      el.focus?.();
      el.textContent = desired;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { filled: true };
    }

    const desired = prepareTextValueForRuntime(runtime, value);
    if (!desired) return { filled: false, message: "没有可填写内容" };

    if (fillRuntime.isReadonlyDateLikeRuntime(runtime)) {
      const ok = await fillReadonlyDateRuntime(runtime, desired);
      return ok ? { filled: true } : { filled: false, message: "日期控件写入失败" };
    }

    const ok = await setValueWithEvents(runtime.el, desired, runtime);
    if (ok) {
      return { filled: true };
    }

    for (const fallbackValue of buildTextFallbackValues(runtime, desired)) {
      const fallbackOk = await setValueWithEvents(runtime.el, fallbackValue, runtime);
      if (fallbackOk) {
        return { filled: true, message: `已回退为兼容值 ${fallbackValue}` };
      }
    }

    return { filled: false, message: "写入失败" };
  }

  function prepareTextValueForRuntime(runtime, value) {
    let text = Array.isArray(value)
      ? value.map((item) => String(item || "").trim()).filter(Boolean).join(", ")
      : String(value ?? "").trim();

    if (!text) return "";

    text = fillRuntime.normalizeValueForRuntime(runtime, text);
    if (!text) return "";

    if (runtime?.inputType === "date") {
      if (/^\d{4}-\d{2}$/.test(text)) return `${text}-01`;
      if (/^\d{4}$/.test(text)) return `${text}-01-01`;
      if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
      return "";
    }

    if (runtime?.inputType === "month") {
      if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text.slice(0, 7);
      if (/^\d{4}-\d{2}$/.test(text)) return text;
      if (/^\d{4}$/.test(text)) return `${text}-01`;
      return "";
    }

    return text;
  }

  function buildTextFallbackValues(runtime, desired) {
    const text = String(desired || "").trim();
    if (!text || !isSalaryLikeRuntime(runtime)) {
      return [];
    }

    const fallback = getSalaryFallbackValue(runtime, text);
    if (!fallback || fallback === text) {
      return [];
    }

    return [fallback];
  }

  function isSalaryLikeRuntime(runtime) {
    const text = [
      runtime?.label,
      runtime?.placeholder,
      runtime?.context,
      ...(Array.isArray(runtime?.nearbyLabels) ? runtime.nearbyLabels : []),
    ]
      .map((item) => String(item || ""))
      .join(" ");

    return /(薪资|薪酬|月薪|年薪|salary|compensation)/i.test(text);
  }

  function getSalaryFallbackValue(runtime, value) {
    const parsed = parseSalaryValue(value);
    if (!parsed.monthlyLower) {
      return "";
    }

    const runtimeText = [
      runtime?.label,
      runtime?.placeholder,
      runtime?.context,
      ...(Array.isArray(runtime?.nearbyLabels) ? runtime.nearbyLabels : []),
    ]
      .map((item) => String(item || ""))
      .join(" ");

    if (/年薪|万/.test(runtimeText)) {
      return String(Math.max(1, Math.round((parsed.monthlyLower * 12) / 10000)));
    }

    return String(parsed.monthlyLower);
  }

  function parseSalaryValue(value) {
    const text = String(value || "")
      .replace(/[,\s]/g, "")
      .trim();
    if (!text) {
      return { monthlyLower: 0 };
    }

    const numbers = Array.from(text.matchAll(/\d+(?:\.\d+)?/g)).map((match) =>
      Number(match[0])
    );
    if (numbers.length === 0) {
      return { monthlyLower: 0 };
    }

    let multiplier = 1;
    if (/[kK千]/.test(text)) {
      multiplier = 1000;
    } else if (/[wW万]/.test(text)) {
      multiplier = 10000;
    }

    let monthlyLower = Math.round(numbers[0] * multiplier);
    if (/年/.test(text) && !/月/.test(text)) {
      monthlyLower = Math.round(monthlyLower / 12);
    }

    return { monthlyLower };
  }

  function scrollIntoView(el) {
    if (!el) return;

    try {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch (_) {
      // Ignore.
    }
  }

  async function setValueWithEvents(el, value, runtime = null) {
    if (!el) return false;

    scrollIntoView(el);
    const restoreReadonly =
      runtime?.readOnly || el.readOnly
        ? {
            property: Boolean(el.readOnly),
            attribute: el.hasAttribute("readonly"),
          }
        : null;

    try {
      el.focus?.();
      if (restoreReadonly) {
        el.readOnly = false;
        el.removeAttribute("readonly");
      }
      setNativeValue(el, value);
      el.setAttribute("value", value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.blur?.();
      await sleep(60);
      return fillRuntime.matchesWrittenValue(runtime, el.value, value);
    } catch (error) {
      console.warn(EXT_TAG, "写入失败", error);
      return false;
    } finally {
      if (restoreReadonly) {
        el.readOnly = restoreReadonly.property;
        if (restoreReadonly.attribute) {
          el.setAttribute("readonly", "");
        } else {
          el.removeAttribute("readonly");
        }
      }
    }
  }

  async function fillReadonlyDateRuntime(runtime, desired) {
    logDateFillStep(runtime, "开始", `目标值=${desired}`);

    const directWriteOk = await setValueWithEvents(runtime.el, desired, runtime);
    if (directWriteOk) {
      logDateFillStep(runtime, "直接写入成功");
      return true;
    }

    logDateFillStep(runtime, "直接写入失败", "尝试打开日期面板");

    const trigger = runtime.el.closest?.(".mtd-input-affix-wrapper") || runtime.el;
    clickLikeUser(trigger);
    await sleep(120);

    let panel = findVisibleDatePanel(runtime.el);
    if (!panel) {
      clickLikeUser(runtime.el);
      await sleep(120);
      panel = findVisibleDatePanel(runtime.el);
    }

    if (!panel) {
      logDateFillStep(runtime, "打开面板失败");
      return false;
    }

    const parsed = parseDateParts(desired);
    if (!parsed.year || !parsed.month) {
      logDateFillStep(runtime, "解析目标日期失败", desired);
      return false;
    }

    logDateFillStep(
      runtime,
      "面板已打开",
      `year=${parsed.year} month=${parsed.month} day=${parsed.day || 0}`
    );

    const yearReady = await movePickerToYear(panel, parsed.year);
    if (!yearReady) {
      logDateFillStep(runtime, "年份切换失败", String(parsed.year));
      return false;
    }

    panel = findVisibleDatePanel(runtime.el) || panel;
    const monthLabel = `${Number(parsed.month)}月`;
    if (!(await clickPanelCell(panel, monthLabel))) {
      logDateFillStep(runtime, "月份点击失败", monthLabel);
      return false;
    }

    logDateFillStep(runtime, "月份点击成功", monthLabel);
    await sleep(120);

    if (parsed.day) {
      panel = findVisibleDatePanel(runtime.el) || panel;
      const dayOk = await clickPanelCell(panel, String(Number(parsed.day)));
      if (!dayOk) {
        logDateFillStep(runtime, "日期点击失败", String(Number(parsed.day)));
        return false;
      }
      logDateFillStep(runtime, "日期点击成功", String(Number(parsed.day)));
      await sleep(120);
    }

    const matched = fillRuntime.matchesWrittenValue(runtime, runtime.el.value, desired);
    logDateFillStep(
      runtime,
      matched ? "最终校验成功" : "最终校验失败",
      `当前值=${runtime.el.value || "(empty)"}`
    );
    return matched;
  }

  function logDateFillStep(runtime, step, detail = "") {
    const label = runtime?.label || runtime?.placeholder || "(empty)";
    const message = detail
      ? `[日期] ${runtime?.fieldId || "(no-field-id)"} "${label}" ${step} detail="${detail}"`
      : `[日期] ${runtime?.fieldId || "(no-field-id)"} "${label}" ${step}`;
    sendLog("info", message);
  }

  function findVisibleDatePanel(anchorEl) {
    const candidates = Array.from(
      document.querySelectorAll(
        '[class*="picker"],[class*="Picker"],[class*="calendar"],[class*="Calendar"],[role="dialog"]'
      )
    ).filter((node) => {
      if (node.contains?.(anchorEl)) return false;
      if (!isVisible(node)) return false;
      const text = normalizeText(node.textContent || "");
      return /\d{4}年|1月|2月|3月|4月|5月|6月|7月|8月|9月|10月|11月|12月/.test(text);
    });

    if (candidates.length === 0) return null;
    if (!anchorEl) return candidates[0];

    const anchorRect = anchorEl.getBoundingClientRect();
    return candidates
      .map((node) => {
        const rect = node.getBoundingClientRect();
        const dx = rect.left - anchorRect.left;
        const dy = rect.top - anchorRect.bottom;
        return {
          node,
          distance: Math.abs(dx) + Math.abs(dy),
        };
      })
      .sort((left, right) => left.distance - right.distance)[0]?.node || candidates[0];
  }

  async function movePickerToYear(panel, targetYear) {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const currentYear = getVisiblePickerYear(panel);
      if (!currentYear) return true;
      if (currentYear === targetYear) return true;

      const control = findYearNavigationControl(panel, currentYear, targetYear);
      if (!control) return false;

      clickLikeUser(control);
      await sleep(120);
    }

    return false;
  }

  function getVisiblePickerYear(panel) {
    const nodes = Array.from(panel.querySelectorAll("*"));
    for (const node of nodes) {
      const text = normalizeText(node.textContent || "");
      const match = text.match(/^(\d{4})年$/);
      if (match) {
        return Number(match[1]);
      }
    }
    return 0;
  }

  function findYearNavigationControl(panel, currentYear, targetYear) {
    const buttons = Array.from(
      panel.querySelectorAll(
        'button,[role="button"],[tabindex],[class*="prev"],[class*="next"],[class*="arrow"],[class*="Arrow"]'
      )
    ).filter((node) => isVisible(node));

    if (buttons.length === 0) return null;

    const yearNode = Array.from(panel.querySelectorAll("*")).find((node) =>
      /^\d{4}年$/.test(normalizeText(node.textContent || ""))
    );
    if (!yearNode) {
      return targetYear < currentYear ? buttons[0] : buttons[buttons.length - 1];
    }

    const yearRect = yearNode.getBoundingClientRect();
    const leftButtons = [];
    const rightButtons = [];

    for (const button of buttons) {
      const rect = button.getBoundingClientRect();
      if (rect.right <= yearRect.left) {
        leftButtons.push({ button, rect });
      } else if (rect.left >= yearRect.right) {
        rightButtons.push({ button, rect });
      }
    }

    if (targetYear < currentYear) {
      return leftButtons.sort((a, b) => b.rect.right - a.rect.right)[0]?.button || buttons[0];
    }

    return rightButtons.sort((a, b) => a.rect.left - b.rect.left)[0]?.button || buttons[buttons.length - 1];
  }

  async function clickPanelCell(panel, text) {
    const normalizedTarget = normalizeText(text);
    const candidates = Array.from(
      panel.querySelectorAll(
        'button,[role="button"],td,li,div,span'
      )
    ).filter((node) => {
      if (!isVisible(node)) return false;
      if (node.getAttribute?.("aria-disabled") === "true") return false;
      const className = String(node.className || "");
      if (/disabled/i.test(className)) return false;
      return normalizeText(node.textContent || "") === normalizedTarget;
    });

    if (candidates.length === 0) return false;

    const target = candidates
      .sort((left, right) => {
        const leftArea = left.getBoundingClientRect().width * left.getBoundingClientRect().height;
        const rightArea = right.getBoundingClientRect().width * right.getBoundingClientRect().height;
        return leftArea - rightArea;
      })[0];

    clickLikeUser(target);
    await sleep(80);
    return true;
  }

  function clickLikeUser(el) {
    if (!el) return;
    scrollIntoView(el);
    el.focus?.();
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    if (typeof el.click === "function") {
      el.click();
    }
  }

  function parseDateParts(value) {
    const text = String(value || "").trim();
    const match = text.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
    if (!match) {
      return { year: 0, month: 0, day: 0 };
    }

    return {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3] || 0),
    };
  }

  function setNativeValue(element, value) {
    const tag = element.tagName?.toLowerCase?.() || "";

    if (tag === "input") {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      setter ? setter.call(element, value) : (element.value = value);
      return;
    }

    if (tag === "textarea") {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      setter ? setter.call(element, value) : (element.value = value);
      return;
    }

    if (tag === "select") {
      const setter =
        typeof HTMLSelectElement !== "undefined"
          ? Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set
          : null;
      setter ? setter.call(element, value) : (element.value = value);
      return;
    }

    element.value = value;
  }

  async function selectByText(selectEl, desired) {
    if (!selectEl?.options) return false;

    scrollIntoView(selectEl);
    const options = Array.from(selectEl.options)
      .map((option) => ({
        el: option,
        label: String(option.textContent || "").trim(),
        value: option.value,
      }))
      .filter((option) => option.label || String(option.value ?? "").trim());

    const best = pickBestOption(options, desired);
    if (!best) return false;

    setNativeValue(selectEl, best.value);
    selectEl.dispatchEvent(new Event("input", { bubbles: true }));
    selectEl.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(60);
    return String(selectEl.value ?? "") === String(best.value ?? "");
  }

  function getCustomDropdownCurrentTexts(runtime) {
    const values = [];
    const add = (value) => {
      const text = normalizeText(value);
      if (text && !values.includes(text)) values.push(text);
    };

    const control = runtime?.el;
    const root = runtime?.root || runtime?.trigger || control;
    add(control?.value);
    add(control?.getAttribute?.("aria-valuetext"));
    add(control?.getAttribute?.("data-value"));
    if (control?.tagName?.toLowerCase?.() !== "input") {
      add(control?.textContent);
    }

    if (root && root !== control) {
      const selected = root.querySelector?.(
        '[aria-selected="true"],[class*="selected"],[class*="Selected"],[class*="value"],[class*="Value"],[class*="chosen-single"],[class*="select2-selection__rendered"],[class*="el-select__selected-item"],[class*="layui-select-title"],[class*="ant-select-selection-item"],[class*="ivu-select-selected-value"]'
      );
      add(selected?.textContent);
    }

    return values;
  }

  function getCustomDropdownCommittedTexts(runtime) {
    const values = [];
    const add = (value) => {
      const text = normalizeText(value);
      if (text && !values.includes(text)) values.push(text);
    };

    const control = runtime?.el;
    const root = runtime?.root || runtime?.trigger || control;
    // Element/Ant/Select2 and many domestic recruitment forms keep the
    // committed display value in a normal input or rendered span without an
    // aria-selected marker. Include those values for incremental-fill checks.
    add(control?.value);
    add(control?.getAttribute?.("aria-valuetext"));
    add(control?.getAttribute?.("data-value"));
    if (control?.getAttribute?.("aria-selected") === "true") {
      add(control?.value);
    }

    const selectedNodes = root?.querySelectorAll?.(
      '[aria-selected="true"],[class*="selected"],[class*="Selected"],[class*="active"],[class*="Active"],[class*="display-value"],[class*="Display-value"],[class*="chosen-single"],[class*="select2-selection__rendered"],[class*="el-select__selected-item"],[class*="layui-select-title"],[class*="ant-select-selection-item"],[class*="ivu-select-selected-value"]'
    ) || [];
    for (const node of selectedNodes) {
      add(node.textContent);
    }

    return values;
  }

  function isCustomDropdownMultiSelect(runtime) {
    const control = runtime?.el;
    const root = runtime?.root || runtime?.trigger || control;
    const identity = [
      control?.className,
      root?.className,
      control?.getAttribute?.("aria-multiselectable"),
      root?.getAttribute?.("aria-multiselectable"),
    ]
      .filter(Boolean)
      .join(" ");
    return (
      control?.getAttribute?.("aria-multiselectable") === "true" ||
      root?.getAttribute?.("aria-multiselectable") === "true" ||
      /(?:multiple|multiselect|multi-select|el-select--multiple|ant-select-multiple|chosen-choices)/i.test(identity)
    );
  }

  function isCustomDropdownCascader(runtime) {
    const control = runtime?.el;
    const root = runtime?.root || runtime?.trigger || control;
    const identity = [control?.className, root?.className, control?.id, root?.id]
      .filter(Boolean)
      .join(" ");
    return /(?:cascader|级联|tree-select)/i.test(identity);
  }

  function getCustomDropdownDesiredValues(runtime, desired) {
    const values = Array.isArray(desired)
      ? desired
      : isCustomDropdownCascader(runtime)
        ? String(desired ?? "").split(/[\/>／＞，,、;；]+/g)
        : isCustomDropdownMultiSelect(runtime)
          ? String(desired ?? "").split(/[，,、;；]+/g)
          : [desired];
    return values
      .flatMap((item) => (Array.isArray(item) ? item : [item]))
      .flatMap((item) =>
        isCustomDropdownCascader(runtime)
          ? String(item ?? "").split(/[\/>／＞，,、;；]+/g)
          : [item]
      )
      .map((item) => String(item ?? "").trim())
      .filter(Boolean);
  }

  function getCustomDropdownPopupRoots(runtime) {
    const roots = [];
    const seen = new Set();
    const addRoot = (root) => {
      if (!root || seen.has(root)) return;
      seen.add(root);
      roots.push(root);
    };

    const control = runtime?.el;
    const trigger = runtime?.trigger || control;
    const adapter = getCustomDropdownAdapter(control || trigger);
    const ids = [
      control?.getAttribute?.("aria-controls"),
      control?.getAttribute?.("aria-owns"),
      trigger?.getAttribute?.("aria-controls"),
      trigger?.getAttribute?.("aria-owns"),
    ]
      .filter(Boolean)
      .flatMap((value) => String(value).split(/\s+/g));

    for (const id of ids) {
      addRoot(document.getElementById?.(id.replace(/^#/, "")));
    }

    const root = runtime?.root;
    if (root?.matches?.('[role="listbox"]')) addRoot(root);

    const adapterPopupSelectors = {
      element: '.el-select-dropdown,.el-popper,.el-cascader-panel,.el-tree-select__popper,.el-autocomplete-suggestion',
      ant: '.ant-select-dropdown,.ant-cascader-menus,.ant-tree-select-dropdown',
      ivu: '.ivu-select-dropdown',
      layui: '.layui-anim,.layui-form-select .layui-anim,.layui-select-none',
      chosen: '.chosen-drop,.chosen-results',
      select2: '.select2-dropdown,.select2-results,[id$="-results"]',
      "generic-menu": '[class*="select-box-options"],[class*="drop-menu"],[class*="dropdown-menu"]',
    };
    const adapterPopupSelector = adapterPopupSelectors[adapter];
    if (adapterPopupSelector) {
      for (const node of Array.from(document.querySelectorAll?.(adapterPopupSelector) || [])) {
        if (isVisible(node)) addRoot(node);
      }
      for (const node of Array.from(root?.querySelectorAll?.(adapterPopupSelector) || [])) {
        addRoot(node);
      }
    }

    const candidates = Array.from(
      document.querySelectorAll?.(
        '[role="listbox"],[class*="dropdown"],[class*="Dropdown"],[class*="select-menu"],[class*="SelectMenu"],[class*="menu"],[class*="Menu"],[class*="drop-menu"],[class*="DropMenu"],[class*="drop_menu"],[class*="dropmenu"],[class*="select-box-options"],[class*="select_box"],[class*="selectbox-options"],[class*="chosen-drop"],[class*="select2-results"],[class*="cascader-panel"],[class*="cascader-menus"],[class*="tree-select"],[class*="ant-select-dropdown"],[class*="ivu-select-dropdown"],[class*="autocomplete-suggestion"]'
      ) || []
    ).filter((node) => isVisible(node));

    const triggerRect = trigger?.getBoundingClientRect?.();
    candidates
      .map((node) => {
        const rect = node.getBoundingClientRect?.();
        const distance =
          triggerRect && rect
            ? Math.abs(Number(rect.left || 0) - Number(triggerRect.left || 0)) +
              Math.abs(Number(rect.top || 0) - Number(triggerRect.bottom || 0))
            : Number.MAX_SAFE_INTEGER;
        return { node, distance };
      })
      .sort((left, right) => left.distance - right.distance)
      .slice(0, 8)
      .forEach(({ node }) => addRoot(node));

    if (root && root !== trigger) addRoot(root);
    return roots;
  }

  function collectVisibleCustomDropdownOptions(runtime) {
    const options = [];
    const seenElements = new Set();
    const seenLabels = new Set();

    for (const popupRoot of getCustomDropdownPopupRoots(runtime)) {
      const nodes = [];
      if (popupRoot.matches?.(CUSTOM_DROPDOWN_OPTION_SELECTOR)) {
        nodes.push(popupRoot);
      }
      nodes.push(
        ...Array.from(
          popupRoot.querySelectorAll?.(CUSTOM_DROPDOWN_OPTION_SELECTOR) || []
        )
      );

      for (const node of nodes) {
        if (seenElements.has(node) || !isVisible(node)) continue;
        if (
          node.getAttribute?.("aria-disabled") === "true" ||
          node.getAttribute?.("data-disabled") === "true" ||
          /(^|[\s_-])(?:disabled|is-disabled|layui-disabled)([\s_-]|$)/i.test(String(node.className || ""))
        ) {
          continue;
        }
        const label = getCustomDropdownOptionLabel(node);
        if (!label || seenLabels.has(label)) continue;

        const nodeIsOption = node.matches?.(
          '[role="option"],[class*="option"],[class*="Option"],[class*="active-result"],[class*="cascader-node"],[class*="tree-node"],[class*="select-item"]'
        );
        const nestedOption = !nodeIsOption && node.querySelector?.(
          '[role="option"],[class*="option"],[class*="Option"]'
        );
        if (nestedOption && isVisible(nestedOption)) continue;

        seenElements.add(node);
        seenLabels.add(label);
        const clickTarget =
          node.querySelector?.(
            '[class*="Menu-container"],[class*="menu-container"],[role="option"]'
          ) || node;
        options.push({
          el: node,
          clickTarget,
          label,
          value:
            node.getAttribute?.("data-value") ||
            node.getAttribute?.("data-option-value") ||
            node.getAttribute?.("lay-value") ||
            node.getAttribute?.("data-code") ||
            node.getAttribute?.("data-option-array-index") ||
            node.getAttribute?.("data-select2-id") ||
            node.getAttribute?.("value") ||
            label,
        });
      }
    }

    return options.slice(0, 100);
  }

  async function waitForCustomDropdownOptions(runtime, timeoutMs = 900) {
    const start = Date.now();
    let options = collectVisibleCustomDropdownOptions(runtime);
    while (options.length === 0 && Date.now() - start < timeoutMs) {
      await sleep(60);
      options = collectVisibleCustomDropdownOptions(runtime);
    }
    return options;
  }

  function customDropdownSelectionLooksCommitted(runtime, desired, option) {
    const desiredCandidates = Array.isArray(desired) ? desired : [desired];
    if (getCustomDropdownCurrentTexts(runtime).some((current) =>
      desiredCandidates.some((candidate) => getMatchScore(current, candidate) >= 60)
    )) {
      return true;
    }

    const optionClass = String(option?.el?.className || "");
    if (
      option?.el?.getAttribute?.("aria-selected") === "true" ||
      /(^|[\s_-])(selected|active)([\s_-]|$)/i.test(optionClass)
    ) {
      return true;
    }

    return !isVisible(option?.el);
  }

  function getCustomDropdownOpenTriggers(runtime) {
    const triggers = [];
    const seen = new Set();
    const add = (node) => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      triggers.push(node);
    };

    const control = runtime?.el;
    const root = runtime?.root || findCustomDropdownRoot(control);
    const adapter = getCustomDropdownAdapter(control || runtime?.trigger);
    add(runtime?.trigger);
    add(control);

    const selectors = {
      element: '.el-select__wrapper,.el-select .el-input__inner,.el-select__caret,.el-input__inner,.el-autocomplete .el-input__inner',
      ant: '.ant-select-selector,.ant-select-selection-search-input,.ant-select-arrow',
      ivu: '.ivu-select-selection,.ivu-select-input,.ivu-select-arrow',
      layui: '.layui-select-title input,.layui-select-title,.layui-edge',
      chosen: '.chosen-single,.chosen-choices',
      select2: '.select2-selection,[role="combobox"]',
      "generic-menu": '[class*="select-box"],[class*="select_box"],[class*="selectbox"],[class*="selectBox"],[class*="drop-menu"],[class*="drop_menu"],[class*="dropmenu"],[class*="dropdown-select"],[class*="bootstrap-select"],[class*="bs-select"]',
    };
    const selector = selectors[adapter];
    if (selector) {
      for (const node of Array.from(root?.querySelectorAll?.(selector) || [])) add(node);
    }

    const arrow = root?.querySelector?.(
      '[class*="Select-arrow"],[class*="select-arrow"],[class*="Select-icon"],[class*="select-icon"],[class*="caret"],[class*="arrow"]'
    );
    add(arrow);
    return triggers;
  }

  async function selectCustomDropdownOption(runtime, desired) {
    const values = getCustomDropdownDesiredValues(runtime, desired);
    if (values.length === 0) return false;

    // Single selects should consume one value even if the model returned an
    // array. Multi-select widgets keep the menu open (or can be reopened) so
    // every requested value is selected and verified independently.
    const targets =
      isCustomDropdownMultiSelect(runtime) || isCustomDropdownCascader(runtime)
        ? values
        : values.slice(0, 1);
    let completed = 0;

    for (const text of targets) {
      let options = collectVisibleCustomDropdownOptions(runtime);
      let best = pickBestOption(options, text);

      if (!best) {
        for (const trigger of getCustomDropdownOpenTriggers(runtime)) {
          clickLikeUser(trigger);
          options = await waitForCustomDropdownOptions(runtime, 1400);
          best = pickBestOption(options, text);
          if (best) break;
        }
      }

      if (!best && runtime?.el?.tagName?.toLowerCase?.() === "input" && !runtime.el.readOnly) {
        const previousValue = String(runtime.el.value || "");
        setNativeValue(runtime.el, text);
        runtime.el.dispatchEvent(new Event("input", { bubbles: true }));
        options = await waitForCustomDropdownOptions(runtime, 1400);
        best = pickBestOption(options, text);
        if (!best) {
          setNativeValue(runtime.el, previousValue);
          runtime.el.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }

      if (!best) return completed > 0 && completed === targets.length;

      clickLikeUser(best.clickTarget || best.el);
      // Vue/React controlled inputs and older recruitment widgets sometimes
      // listen on the trigger rather than the option node.
      for (const eventName of ["input", "change"]) {
        try {
          runtime?.el?.dispatchEvent?.(new Event(eventName, { bubbles: true }));
        } catch (_) {
          // A non-DOM test double or a framework host may not expose events.
        }
      }
      await sleep(120);
      let committed = customDropdownSelectionLooksCommitted(runtime, text, best);

      if (!committed && best.clickTarget && best.clickTarget !== best.el) {
        clickLikeUser(best.el);
        await sleep(120);
        committed = customDropdownSelectionLooksCommitted(runtime, text, best);
      }

      if (!committed) {
        try {
          (best.clickTarget || best.el)?.dispatchEvent?.(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
          );
          await sleep(120);
          committed = customDropdownSelectionLooksCommitted(runtime, text, best);
        } catch (_) {
          // KeyboardEvent is unavailable in a few embedded webviews.
        }
      }

      if (!committed) return false;
      try {
        runtime?.el?.dispatchEvent?.(new Event("blur", { bubbles: true }));
      } catch (_) {
        // Ignore hosts that do not expose DOM event constructors.
      }
      completed += 1;
    }

    return completed === targets.length;
  }

  async function safeCheck(inputEl, checked) {
    if (!inputEl) return false;

    try {
      scrollIntoView(inputEl);
      inputEl.focus?.();

      if (typeof inputEl.click === "function") {
        if (Boolean(inputEl.checked) !== Boolean(checked)) {
          inputEl.click();
        }
      } else {
        inputEl.checked = Boolean(checked);
      }

      inputEl.dispatchEvent(new Event("change", { bubbles: true }));
      inputEl.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(30);

      return Boolean(inputEl.checked) === Boolean(checked);
    } catch (_) {
      return false;
    }
  }

  function pickBestOption(options, desired) {
    const candidates = Array.isArray(desired)
      ? desired
      : [desired].filter((item) => item != null && String(item).trim());

    let exact = null;
    let fuzzy = null;

    for (const option of options || []) {
      // Native selects and framework controls frequently expose an opaque
      // value (for example `01`) while displaying a human label (for example
      // `本科`). Match both representations so the AI can return either one.
      const optionTexts = [
        option.label,
        option.value,
        option.text,
        option.code,
        option.id,
      ]
        .map((item) => String(item ?? "").trim())
        .filter(Boolean);
      if (optionTexts.length === 0) continue;

      for (const candidate of candidates) {
        const score = Math.max(
          ...optionTexts.map((optionText) => getMatchScore(optionText, candidate))
        );
        if (score >= 100) {
          exact = option;
          break;
        }

        if (!fuzzy || score > fuzzy.score) {
          fuzzy = { option, score };
        }
      }

      if (exact) break;
    }

    return exact || (fuzzy && fuzzy.score >= 60 ? fuzzy.option : null);
  }

  function matchesAnyCandidate(optionText, candidates) {
    return candidates.some((candidate) => getMatchScore(optionText, candidate) >= 60);
  }

  function getMatchScore(optionText, candidateText) {
    const optionVariants = expandMatchVariants(optionText);
    const candidateVariants = expandMatchVariants(candidateText);
    let bestScore = 0;

    for (const optionVariant of optionVariants) {
      for (const candidateVariant of candidateVariants) {
        if (!optionVariant || !candidateVariant) continue;
        if (optionVariant === candidateVariant) return 100;
        if (optionVariant.includes(candidateVariant) || candidateVariant.includes(optionVariant)) {
          bestScore = Math.max(bestScore, 75);
        }
      }
    }

    return bestScore;
  }

  function expandMatchVariants(value) {
    const text = String(value || "").trim();
    if (!text) return [];

    const normalized = normalizeForMatch(text);
    const variants = new Set([normalized]);

    for (const group of MATCH_ALIAS_GROUPS) {
      if (group.values.includes(normalized)) {
        group.values.forEach((item) => variants.add(item));
      }
    }

    return Array.from(variants);
  }

  function normalizeForMatch(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/['"`’‘”“]/g, "")
      .replace(/[()（）[\]【】{}<>]/g, "")
      .replace(/[.,，/\\\-_:：;+]/g, "");
  }

  function isAffirmative(value) {
    const normalized = normalizeForMatch(value);
    return MATCH_ALIAS_GROUPS.find((group) => group.key === "yes")?.values.includes(
      normalized
    );
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function parseJsonFromAiText(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) throw new Error("AI 返回为空");

    const direct = tryParseJson(trimmed);
    if (direct.ok) return direct.value;

    const noFences = trimmed
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();

    const noFenceParsed = tryParseJson(noFences);
    if (noFenceParsed.ok) return noFenceParsed.value;

    const extracted = extractLikelyJson(noFences);
    const extractedParsed = tryParseJson(extracted);
    if (extractedParsed.ok) return extractedParsed.value;

    throw new Error("无法解析 AI 返回的 JSON");
  }

  function tryParseJson(text) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (_) {
      return { ok: false };
    }
  }

  function extractLikelyJson(text) {
    const firstObj = text.indexOf("{");
    const lastObj = text.lastIndexOf("}");
    const firstArr = text.indexOf("[");
    const lastArr = text.lastIndexOf("]");

    const objCandidate =
      firstObj !== -1 && lastObj !== -1 && lastObj > firstObj
        ? text.slice(firstObj, lastObj + 1)
        : null;
    const arrCandidate =
      firstArr !== -1 && lastArr !== -1 && lastArr > firstArr
        ? text.slice(firstArr, lastArr + 1)
        : null;

    if (objCandidate && arrCandidate) {
      return firstObj < firstArr ? objCandidate : arrCandidate;
    }

    return objCandidate || arrCandidate || text;
  }

  function createMappingCacheSignature(fields) {
    return fields.map((field, index) =>
      createStableCacheFieldSignature(field, index)
    );
  }

  function createMappingCacheKey(fields, extraSalt = "") {
    return createMappingCacheKeyFromSignature(
      createMappingCacheSignature(fields),
      extraSalt
    );
  }

  function createMappingCacheKeyFromSignature(signature, extraSalt = "") {
    const base = `${location.origin}${location.pathname}::${JSON.stringify(signature)}${
      extraSalt ? `::${extraSalt}` : ""
    }`;
    return `${location.host}:${hashString(base)}`;
  }

  function buildCustomFieldsCacheSalt(profile) {
    const parts = [];

    for (const [sectionKey, sectionData] of Object.entries(profile || {})) {
      const rows = sectionData?.customFields;
      if (!Array.isArray(rows)) continue;

      const names = rows
        .map((item) => String(item?.name || "").trim())
        .filter(Boolean);
      if (names.length) {
        parts.push(`${sectionKey}:${names.join("|")}`);
      }
    }

    return parts.length ? `cf:${parts.join(";")}` : "";
  }

  function createStableCacheFieldSignature(field, index = 0) {
    return {
      index,
      kind: field.kind,
      inputType: field.inputType || "",
      required: Boolean(field.required),
      sectionKey: normalizeCacheText(field.sectionKey || ""),
      sectionLabel: normalizeCacheText(field.sectionLabel || ""),
      groupId: normalizeCacheText(field.groupId || ""),
      groupLabel: normalizeCacheText(field.groupLabel || ""),
      groupIndex: Number.isFinite(Number(field.groupIndex)) ? Number(field.groupIndex) : null,
      groupFieldLabels: Array.isArray(field.groupFieldLabels)
        ? field.groupFieldLabels.map((item) => normalizeCacheText(item)).filter(Boolean).slice(0, 12)
        : [],
      groupPath: Array.isArray(field.groupPath)
        ? field.groupPath
            .map((item) => `${normalizeCacheText(item?.label || "")}:${normalizeCacheText(item?.kind || "")}:${item?.index ?? ""}`)
            .filter(Boolean)
            .slice(0, 6)
        : [],
      label: normalizeCacheText(field.label || ""),
      placeholder: normalizeCacheText(field.placeholder || ""),
      name: normalizeCacheText(field.name || ""),
      id: normalizeCacheText(field.id || ""),
      options: Array.isArray(field.options)
        ? field.options.map((item) => normalizeCacheText(item)).filter(Boolean).slice(0, 8)
        : [],
    };
  }

  function normalizeCacheText(value) {
    let text = String(value || "").trim();
    if (!text) return "";

    text = text
      .replace(/\s+/g, " ")
      .replace(/[＊*]+\s*/g, "*")
      .replace(/^(请填写|请选择|请输入|请完整填写)/g, "")
      .replace(/(请填写|请选择|请输入)/g, "")
      .replace(/[*:：]+$/g, "")
      .trim();

    if (!text) return "";

    const starIndex = text.indexOf("*");
    if (starIndex >= 0) {
      text = text.slice(0, starIndex).trim();
    }

    const stablePrefixMatch = text.match(/^([\u4e00-\u9fa5A-Za-z]+(?:名称|时间|日期|学历|学位|专业|部门|职位|城市|邮箱|手机|电话|描述|链接|角色|学校|证书|账号|网址))/);
    if (stablePrefixMatch) {
      return stablePrefixMatch[1];
    }

    if (/^(全灵|实习|本科|硕士|博士|男|女|是|否|\d{4}[-/]\d{2}(?:[-/]\d{2})?)$/.test(text)) {
      return "";
    }

    return text;
  }

  function hashString(text) {
    let hash = 5381;
    for (let index = 0; index < text.length; index += 1) {
      hash = (hash * 33) ^ text.charCodeAt(index);
    }
    return (hash >>> 0).toString(16);
  }

  function describeMappingCacheLookup(cache, cacheKey, meta = {}) {
    const normalizedCache = cache && typeof cache === "object" ? cache : {};
    const keys = Object.keys(normalizedCache);
    const entry = normalizedCache[cacheKey] || null;
    const shortKey = String(cacheKey || "").split(":").pop() || "(empty)";

    if (entry) {
      return {
        entry,
        hit: true,
        reason: `命中 key=${shortKey} total=${keys.length}`,
      };
    }

    if (keys.length === 0) {
      return {
        entry: null,
        hit: false,
        reason: `缓存为空 key=${shortKey}`,
      };
    }

    const samePageEntries = Object.entries(normalizedCache)
      .filter(([, item]) => item?.host === meta.host && item?.path === meta.path)
      .sort((left, right) => Number(right[1]?.updatedAt || 0) - Number(left[1]?.updatedAt || 0));

    if (samePageEntries.length === 0) {
      return {
        entry: null,
        hit: false,
        reason: `缓存中没有当前页面记录 key=${shortKey} total=${keys.length}`,
      };
    }

    const latestSamePage = samePageEntries[0]?.[1] || null;
    const difference = summarizeCacheSignatureDifference(
      meta.signature,
      latestSamePage?.signature
    );

    return {
      entry: null,
      hit: false,
      reason: `同页面已有${samePageEntries.length}条缓存，但当前字段签名已变化 key=${shortKey} ${difference}`,
    };
  }

  function summarizeCacheSignatureDifference(currentSignature, previousSignature) {
    if (!Array.isArray(currentSignature) || currentSignature.length === 0) {
      return "当前扫描签名为空";
    }

    if (!Array.isArray(previousSignature) || previousSignature.length === 0) {
      return "历史缓存缺少签名明细";
    }

    if (currentSignature.length !== previousSignature.length) {
      return `字段数量 ${previousSignature.length} -> ${currentSignature.length}`;
    }

    const diffs = [];
    for (let index = 0; index < currentSignature.length; index += 1) {
      const current = currentSignature[index];
      const previous = previousSignature[index];
      if (JSON.stringify(current) === JSON.stringify(previous)) {
        continue;
      }
      diffs.push(describeCacheFieldDifference(previous, current, index));
    }

    if (diffs.length === 0) {
      return "签名一致，但缓存条目不存在";
    }

    return `差异字段 ${diffs.length} 个，示例：${diffs.slice(0, 3).join("；")}`;
  }

  function describeCacheFieldDifference(previous, current, index) {
    const changes = [];

    if ((previous?.kind || "") !== (current?.kind || "")) {
      changes.push(`kind ${previous?.kind || "(empty)"} -> ${current?.kind || "(empty)"}`);
    }
    if ((previous?.inputType || "") !== (current?.inputType || "")) {
      changes.push(
        `inputType ${previous?.inputType || "(empty)"} -> ${current?.inputType || "(empty)"}`
      );
    }
    if ((previous?.sectionLabel || "") !== (current?.sectionLabel || "")) {
      changes.push(
        `section ${previous?.sectionLabel || "(empty)"} -> ${current?.sectionLabel || "(empty)"}`
      );
    }
    if ((previous?.groupLabel || "") !== (current?.groupLabel || "")) {
      changes.push(`group ${previous?.groupLabel || "(empty)"} -> ${current?.groupLabel || "(empty)"}`);
    }
    if (Number(previous?.groupIndex ?? 0) !== Number(current?.groupIndex ?? 0)) {
      changes.push(`groupIndex ${previous?.groupIndex ?? "(empty)"} -> ${current?.groupIndex ?? "(empty)"}`);
    }
    if ((previous?.label || "") !== (current?.label || "")) {
      changes.push(`label ${previous?.label || "(empty)"} -> ${current?.label || "(empty)"}`);
    }
    if ((previous?.placeholder || "") !== (current?.placeholder || "")) {
      changes.push(
        `placeholder ${previous?.placeholder || "(empty)"} -> ${current?.placeholder || "(empty)"}`
      );
    }
    if ((previous?.name || "") !== (current?.name || "")) {
      changes.push(`name ${previous?.name || "(empty)"} -> ${current?.name || "(empty)"}`);
    }
    if ((previous?.id || "") !== (current?.id || "")) {
      changes.push(`id ${previous?.id || "(empty)"} -> ${current?.id || "(empty)"}`);
    }

    const previousOptions = JSON.stringify(previous?.options || []);
    const currentOptions = JSON.stringify(current?.options || []);
    if (previousOptions !== currentOptions) {
      changes.push(`options ${previousOptions} -> ${currentOptions}`);
    }

    return `#${index + 1} ${changes[0] || "结构变化"}`;
  }

  async function loadMappingCacheEntry(cacheKey, meta = {}) {
    const data = await chrome.storage.local.get([MAPPING_CACHE_KEY]);
    const cache = data[MAPPING_CACHE_KEY];
    return describeMappingCacheLookup(cache, cacheKey, meta);
  }

  async function saveMappingCacheEntry(cacheKey, entry) {
    const data = await chrome.storage.local.get([MAPPING_CACHE_KEY]);
    const cache = data[MAPPING_CACHE_KEY] && typeof data[MAPPING_CACHE_KEY] === "object"
      ? data[MAPPING_CACHE_KEY]
      : {};

    cache[cacheKey] = entry;

    const keys = Object.keys(cache).sort((left, right) => {
      const leftTime = Number(cache[left]?.updatedAt || 0);
      const rightTime = Number(cache[right]?.updatedAt || 0);
      return rightTime - leftTime;
    });

    const nextCache = {};
    keys.slice(0, 50).forEach((key) => {
      nextCache[key] = cache[key];
    });

    await chrome.storage.local.set({ [MAPPING_CACHE_KEY]: nextCache });
  }

  function sendLog(level, text) {
    chrome.runtime.sendMessage({ type: "log", level, text });
  }

  function sendStats(fieldCount, mappedCount, filledCount) {
    chrome.runtime.sendMessage({
      type: "updateStats",
      fieldCount,
      mappedCount,
      filledCount,
    });
  }

  const MATCH_ALIAS_GROUPS = [
    {
      key: "yes",
      values: [
        "yes",
        "y",
        "true",
        "1",
        "是",
        "有",
        "愿意",
        "可以",
        "present",
        "current",
        "currently",
      ],
    },
    {
      key: "no",
      values: ["no", "n", "false", "0", "否", "无", "不愿意", "不可以", "不需要"],
    },
    {
      key: "male",
      values: ["male", "man", "m", "男", "男性"],
    },
    {
      key: "female",
      values: ["female", "woman", "f", "女", "女性"],
    },
    {
      key: "fulltime",
      values: ["fulltime", "full-time", "全职"],
    },
    {
      key: "parttime",
      values: ["parttime", "part-time", "兼职"],
    },
    {
      key: "internship",
      values: ["internship", "intern", "实习"],
    },
    {
      key: "contract",
      values: ["contract", "contractor", "合同"],
    },
    {
      key: "freelance",
      values: ["freelance", "自由职业"],
    },
    {
      key: "bachelor",
      values: ["bachelor", "undergraduate", "本科", "学士", "大学本科"],
    },
    {
      key: "highschool",
      values: ["highschool", "high-school", "高中"],
    },
    {
      key: "associate",
      values: ["associate", "大专", "大学专科"],
    },
    {
      key: "master",
      values: ["master", "masters", "硕士", "硕士研究生"],
    },
    {
      key: "mba",
      values: ["mba"],
    },
    {
      key: "phd",
      values: ["phd", "doctorate", "博士", "博士研究生", "博士后"],
    },
    {
      key: "single",
      values: ["single", "未婚"],
    },
    {
      key: "married",
      values: ["married", "已婚"],
    },
    {
      key: "onsite",
      values: ["onsite", "on-site", "现场办公", "到岗办公"],
    },
    {
      key: "hybrid",
      values: ["hybrid", "混合办公"],
    },
    {
      key: "remote",
      values: ["remote", "远程办公"],
    },
    {
      key: "flexible",
      values: ["flexible", "灵活"],
    },
    {
      key: "graduated",
      values: ["graduated", "已毕业"],
    },
    {
      key: "expected",
      values: ["expected", "预计毕业"],
    },
    {
      key: "enrolled",
      values: ["enrolled", "在读"],
    },
    {
      key: "dropped",
      values: ["dropped", "肄业"],
    },
    {
      key: "idcard",
      values: ["identitycard", "idcard", "身份证"],
    },
    {
      key: "regularfulltime",
      values: [
        "regularfulltime",
        "fulltimedegree",
        "统招",
        "统招全日制",
        "全日制",
        "全国普通高等院校全日制",
      ],
    },
    {
      key: "nonfulltime",
      values: [
        "nonfulltime",
        "parttimedegree",
        "非统招",
        "非全日制",
        "全国普通高等院校非全日制",
      ],
    },
    {
      key: "jointtraining",
      values: ["jointtraining", "jointprogram", "联合培养"],
    },
    {
      key: "commissionedtraining",
      values: ["commissionedtraining", "委托培养"],
    },
    {
      key: "passport",
      values: ["passport", "护照"],
    },
    {
      key: "permit",
      values: ["residencepermit", "permit", "居留许可"],
    },
    {
      key: "native",
      values: ["native", "母语"],
    },
    {
      key: "fluent",
      values: ["fluent", "流利"],
    },
    {
      key: "professional",
      values: ["professional", "business", "工作熟练", "专业"],
    },
    {
      key: "intermediate",
      values: ["intermediate", "中等", "中级"],
    },
    {
      key: "basic",
      values: ["basic", "基础", "初级"],
    },
  ];

  console.log(EXT_TAG, "Content script 已加载");
})();
