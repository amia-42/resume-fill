(function initResumeControlCapabilities(root) {
  "use strict";

  const descriptors = [
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
        "element-select",
        "element-plus-select",
        "layui-form-select",
        "chosen",
        "select2",
        "ant-select",
        "ivu-select",
        "select-box",
        "selectbox",
        "select_box",
        "drop-menu",
      ],
    },
    { kind: "readonly_date", label: "只读日期 / 日期面板", inputTypes: ["readonly-date", "date-picker"] },
    { kind: "radio_group", label: "单选组", inputTypes: ["radio"] },
    { kind: "checkbox_group", label: "多选组", inputTypes: ["checkbox"] },
    { kind: "contenteditable", label: "可编辑区域", inputTypes: ["contenteditable"] },
    { kind: "file", label: "文件上传（暂不自动填写）", inputTypes: ["file"], supported: false, adaptable: false },
  ];

  const STORAGE_KEY = "resumeControlCapabilitiesV1";
  const registered = new Map();
  const byKind = new Map(
    descriptors.map((item) => [
      item.kind,
      Object.freeze({ ...item, inputTypes: Object.freeze([...item.inputTypes]) }),
    ])
  );

  function cloneDescriptor(item) {
    return { ...item, inputTypes: [...(item.inputTypes || [])] };
  }

  function getStorage(storageOverride) {
    return storageOverride || root.chrome?.storage?.local || null;
  }

  async function refresh(storageOverride) {
    const storage = getStorage(storageOverride);
    if (!storage?.get) return getAll();
    try {
      const data = await storage.get(STORAGE_KEY);
      registered.clear();
      for (const item of Array.isArray(data?.[STORAGE_KEY]) ? data[STORAGE_KEY] : []) {
        const normalized = normalizeRegistered(item);
        if (normalized) registered.set(normalized.kind, normalized);
      }
    } catch (_) {
      // Built-in capabilities remain available when storage is inaccessible.
    }
    return getAll();
  }

  async function register(kind, metadata = {}, storageOverride) {
    const normalizedKind = normalizeKind(kind);
    if (
      !normalizedKind ||
      normalizedKind === "unknown" ||
      normalizedKind === "file" ||
      byKind.has(normalizedKind)
    ) {
      return false;
    }
    const descriptor = normalizeRegistered({
      ...metadata,
      kind: normalizedKind,
      supported: true,
      adaptable: true,
      registeredAt: Date.now(),
    });
    if (!descriptor) return false;
    registered.set(normalizedKind, descriptor);
    const storage = getStorage(storageOverride);
    if (storage?.set) {
      try {
        await storage.set({
          [STORAGE_KEY]: Array.from(registered.values()).map(cloneDescriptor),
        });
      } catch (_) {
        // Keep the in-memory registration for this page if persistence fails.
      }
    }
    return true;
  }

  function registerSupported(kind, metadata = {}, storageOverride) {
    const normalizedKind = normalizeKind(kind);
    if (
      !normalizedKind ||
      normalizedKind === "unknown" ||
      normalizedKind === "file" ||
      byKind.has(normalizedKind)
    ) {
      return null;
    }
    const descriptor = normalizeRegistered({
      ...metadata,
      kind: normalizedKind,
      strategy: metadata.adapterKind || metadata.strategy || "native_value",
      supported: true,
      adaptable: true,
      registeredAt: Date.now(),
    });
    if (!descriptor) return null;
    registered.set(normalizedKind, descriptor);
    const storage = getStorage(storageOverride);
    if (storage?.set) {
      Promise.resolve(storage.set({
        [STORAGE_KEY]: Array.from(registered.values()).map(cloneDescriptor),
      })).catch(() => {});
    }
    return cloneDescriptor(descriptor);
  }

  function normalizeRegistered(item) {
    const kind = normalizeKind(item?.kind);
    if (!kind || kind === "unknown" || kind === "file" || byKind.has(kind)) return null;
    const inputTypes = Array.isArray(item?.inputTypes)
      ? item.inputTypes.map((value) => String(value).slice(0, 80)).slice(0, 12)
      : [];
    return {
      kind,
      label: String(item?.label || kind).slice(0, 80),
      inputTypes: inputTypes.length ? inputTypes : [kind],
      supported: true,
      adaptable: true,
      strategy: normalizeKind(item?.strategy || "native_value"),
      registeredAt: Number(item?.registeredAt || Date.now()),
    };
  }

  function getAll() {
    return [
      ...descriptors.map(cloneDescriptor),
      ...Array.from(registered.values()).map(cloneDescriptor),
    ];
  }

  function get(kind) {
    const normalized = normalizeKind(kind);
    return byKind.get(normalized) || registered.get(normalized) || null;
  }

  function getStrategy(kind) {
    const descriptor = get(kind);
    return normalizeKind(descriptor?.strategy || descriptor?.kind || "");
  }

  // Built-in controls already have deterministic implementations. Only return
  // a strategy here when the control was learned and persisted at runtime;
  // callers can then distinguish a learned adapter from the built-in kind.
  function getAdapterStrategy(kind) {
    const normalized = normalizeKind(kind);
    const descriptor = registered.get(normalized);
    return normalizeKind(descriptor?.strategy || "");
  }

  function isSupported(kind) {
    const descriptor = get(kind);
    return Boolean(descriptor && descriptor.supported !== false);
  }

  function normalizeKind(kind) {
    const value = String(kind || "").trim().toLowerCase();
    const aliases = {
      input: "text",
      textinput: "text",
      "text-input": "text",
      dropdown: "select",
      combobox: "combobox",
      autocomplete: "combobox",
      radio: "radio_group",
      checkbox: "checkbox_group",
      editable: "contenteditable",
      "content-editable": "contenteditable",
      "readonly-date": "readonly_date",
      "date-picker": "readonly_date",
      "el-select": "combobox",
      "element-select": "combobox",
      "element-plus-select": "combobox",
      "layui-form-select": "combobox",
      chosen: "combobox",
      "chosen-container": "combobox",
      select2: "combobox",
      "select2-container": "combobox",
      "ant-select": "combobox",
      "ivu-select": "combobox",
      "select-box": "combobox",
      selectbox: "combobox",
      select_box: "combobox",
      "drop-menu": "combobox",
      dropmenu: "combobox",
      drop_menu: "combobox",
    };
    return aliases[value] || value;
  }

  const api = Object.freeze({
    STORAGE_KEY,
    storageKey: STORAGE_KEY,
    getAll,
    get,
    getStrategy,
    getAdapterStrategy,
    isSupported,
    normalizeKind,
    refresh,
    loadPersisted: refresh,
    register,
    registerSupported,
  });
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ResumeControlCapabilities = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
