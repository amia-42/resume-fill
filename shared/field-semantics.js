(function (root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.ResumeFieldSemantics = api;
})(
  typeof globalThis !== "undefined" ? globalThis : this,
  function () {
    "use strict";

    const SECTION_RULES = [
      // These page-only groups intentionally do not imply a matching resume
      // schema section.  A concrete group title must win over generic labels
      // such as “姓名” and “电话”, otherwise family rows are often mapped to
      // the applicant's own contact details.
      {
        key: "family",
        label: "家庭情况",
        keywords: [
          "家庭情况",
          "家庭成员",
          "家庭信息",
          "家庭关系",
          "家属信息",
          "家庭主要成员",
          "直系亲属",
          "父母信息",
          "亲属信息",
        ],
        priority: 40,
      },
      {
        key: "emergencyContact",
        label: "紧急联系人",
        keywords: [
          "紧急联系人",
          "紧急联络人",
          "应急联系人",
          "紧急联系信息",
        ],
        priority: 38,
      },
      {
        key: "personal",
        label: "基本信息",
        keywords: ["基本信息", "个人信息", "联系方式", "姓名", "邮箱", "手机", "电话", "证件"],
        priority: 0,
      },
      {
        key: "education",
        label: "教育经历",
        keywords: [
          "教育经历",
          "学校名称",
          "学校",
          "学历类型",
          "培养方式",
          "学历",
          "学位",
          "学院",
          "专业",
          "实验室",
          "领域方向",
          "导师",
          "学号",
          "班级",
          "学制",
          "毕业",
          "论文",
          "gpa",
        ],
        priority: 0,
      },
      {
        key: "internship",
        label: "实习经历",
        keywords: [
          "实习经历",
          "实习",
          "实习公司",
          "实习岗位",
          "实习部门",
          "实习城市",
          "实习生",
        ],
        priority: 0,
      },
      {
        key: "work",
        label: "工作经历",
        keywords: [
          "工作经历",
          "工作",
          "公司名称",
          "职位名称",
          "所属部门",
          "工作职责",
          "工作成绩",
        ],
        priority: 0,
      },
      {
        key: "project",
        label: "项目经历",
        keywords: ["项目经历", "项目名称", "项目角色", "项目链接", "项目说明", "项目亮点", "项目描述"],
        priority: 0,
      },
      {
        key: "campus",
        label: "校园经历",
        keywords: [
          "校园经历",
          "学生组织",
          "社团",
          "班干部",
          "校园活动",
          "志愿服务",
          "科研助理",
          "组织名称",
        ],
        priority: 0,
      },
      {
        key: "certificate",
        label: "证书与认证",
        keywords: ["证书", "认证", "发证", "等级考试", "资格证"],
        priority: 0,
      },
      {
        key: "language",
        label: "语言能力",
        keywords: ["语言能力", "语言", "外语", "雅思", "托福", "cet", "四六级"],
        priority: 0,
      },
    ];

    function normalizeSemanticText(text) {
      return String(text || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "")
        .replace(/[()（）[\]【】{}<>]/g, "")
        .replace(/[.,，/\\\-_:：;+*"'`“”‘’]/g, "");
    }

    function inferSectionFromTexts(texts) {
      const list = Array.isArray(texts) ? texts.filter(Boolean) : [];
      if (list.length === 0) {
        return {
          key: "",
          label: "",
          evidence: "",
          score: 0,
        };
      }

      let best = {
        key: "",
        label: "",
        evidence: "",
        score: 0,
      };

      for (const rule of SECTION_RULES) {
        let score = 0;
        const matched = [];

        for (const text of list) {
          const normalizedText = normalizeSemanticText(text);
          if (!normalizedText) continue;

          for (const keyword of rule.keywords) {
            const normalizedKeyword = normalizeSemanticText(keyword);
            if (!normalizedKeyword || !normalizedText.includes(normalizedKeyword)) {
              continue;
            }

            score += normalizedText === normalizedKeyword ? 8 : 4;
            matched.push(keyword);
          }
        }

        if (rule.key === "internship" && matched.some((item) => String(item).includes("实习"))) {
          score += 6;
        }

        if (rule.key === "campus" && matched.some((item) => /学生组织|社团|志愿服务|科研助理/.test(item))) {
          score += 5;
        }

        // A specific group heading (family/emergency contact) outranks a
        // generic field label even when the latter appears more often in the
        // nearby text.  The small tie-breaker keeps unrelated page headings
        // from becoming a section by themselves.
        if (score <= 0) continue;
        const weightedScore = score + (rule.priority || 0);
        if (weightedScore > best.score) {
          best = {
            key: rule.key,
            label: rule.label,
            evidence: Array.from(new Set(matched)).slice(0, 3).join(" / "),
            score: weightedScore,
          };
        }
      }

      if (best.score < 4) {
        return {
          key: "",
          label: "",
          evidence: "",
          score: 0,
        };
      }

      return best;
    }

    // Infer only a concrete, page-level field group.  Generic labels such as
    // “姓名” and “电话” intentionally return no group: callers can still use
    // inferSectionFromTexts for their broad section hint, while a group title
    // (or a strong family/emergency marker) remains the source of truth for
    // repeated rows.
    function inferGroupFromTexts(texts) {
      const list = Array.isArray(texts) ? texts.filter(Boolean) : [];
      const normalized = list.map(normalizeSemanticText).filter(Boolean);
      if (normalized.length === 0) {
        return { key: "", label: "", evidence: "", score: 0 };
      }

      const groupRules = [
        {
          key: "family",
          label: "家庭情况",
          keywords: [
            "家庭情况",
            "家庭成员",
            "家庭信息",
            "家庭关系",
            "家庭主要成员",
            "直系亲属",
            "父母信息",
            "亲属信息",
          ],
        },
        {
          key: "emergencyContact",
          label: "紧急联系人",
          keywords: ["紧急联系人", "紧急联络人", "应急联系人", "紧急联系信息"],
        },
      ];

      let best = { key: "", label: "", evidence: "", score: 0 };
      for (const rule of groupRules) {
        let score = 0;
        const matched = [];
        for (const value of normalized) {
          for (const keyword of rule.keywords) {
            const normalizedKeyword = normalizeSemanticText(keyword);
            if (!normalizedKeyword || !value.includes(normalizedKeyword)) continue;
            score += value === normalizedKeyword ? 8 : 4;
            matched.push(keyword);
          }
        }
        if (score > best.score) {
          best = {
            key: rule.key,
            label: rule.label,
            evidence: Array.from(new Set(matched)).slice(0, 3).join(" / "),
            score,
          };
        }
      }
      return best.score >= 4 ? best : { key: "", label: "", evidence: "", score: 0 };
    }

    return {
      inferSectionFromTexts,
      inferGroupFromTexts,
      normalizeSemanticText,
    };
  }
);
