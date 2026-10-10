// Keep the plain-JS bridge localizer in sync; parity is covered by tests.
export function localizePromptTheme(value) {
    const theme = String(value ?? "").trim();
    const normalize = (text) => text.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[._-]+/g, " ").replace(/\s*([/+&])\s*/g, " $1 ").replace(/\s+/g, " ").trim();
    const aliases = {
        "full product hero": "完整产品主图", "product hero": "产品主图", "main prompt": "主图提示词",
        "detail image": "详情页图片", "detail prompt": "详情页提示词", "rich content": "富内容",
        "rich prompt": "富内容提示词", "video prompt": "视频提示词",
        "flat lay included contents": "平铺收纳与配件", "cropped functional part": "局部功能特写",
        "cropped storage structure": "收纳结构特写", "hands in use": "手部使用场景",
        "usage sequence": "使用流程", "macro material / finish": "材质与表面细节",
        "scale / dimension visual": "尺寸规格展示", "care / storage": "保养与收纳",
        "overview + contents narrative": "全貌与配件说明", "component selection guide": "配件选择指南",
        "hands in use sequence": "手部使用流程", "checklist / package audit": "清单与包装核对",
        "installation / assembly sequence": "安装与组装流程", "installation / assembly steps": "安装与组装步骤",
        "checklist / use boundary": "使用清单与适用边界", "selection guide narrative": "选购指南",
        "technical macro narrative": "技术细节微距展示", "assembly / structural proof": "组装与结构验证",
        "hands in use narrative": "手部使用演示", "checklist / care storage": "清单与保养收纳",
        "compatibility / selection guide": "兼容性与选购指南", "compatibility / selection": "兼容性与选型",
        "material / finish": "材质与表面细节", "material / surface detail": "材质与表面细节",
        "size / specification": "尺寸与规格", "dimensions / specifications": "尺寸与规格",
        "before / after": "前后对比", "before and after": "前后对比",
        "exploded view": "拆解展示", "cross section": "剖面结构", "cutaway view": "剖面展示",
        "top view": "俯视图", "front view": "正面图", "side view": "侧面图", "rear view": "背面图",
        "back view": "背面图", "three quarter view": "四分之三角度图", "45 degree view": "45度视角",
        "close up": "近距离特写", "extreme close up": "超近距离特写", "macro shot": "微距特写",
        "flat lay": "平铺展示", "white background": "白底展示", "lifestyle scene": "生活场景",
        "in use": "使用中展示", "product in use": "产品使用展示", "step by step": "分步演示",
        "how to use": "使用方法", "package contents": "包装内容", "included accessories": "随附配件",
        "key features": "核心功能", "core features": "核心卖点", "selling points": "产品卖点",
        "benefit demonstration": "优势演示", "function demonstration": "功能演示",
        "scale reference": "尺寸参照", "size comparison": "尺寸对比", "performance comparison": "性能对比",
        "texture detail": "纹理细节", "surface texture": "表面纹理", "material detail": "材质细节",
        "quality proof": "品质验证", "durability test": "耐用性测试", "safety features": "安全设计",
        "care instructions": "保养说明", "storage solution": "收纳方案", "installation guide": "安装指南",
        "assembly guide": "组装指南", "compatibility guide": "兼容性指南", "selection guide": "选购指南",
    };
    const words = {
        installation: "安装", assembly: "组装", sequence: "流程", steps: "步骤", checklist: "清单",
        "use boundary": "适用边界", "care storage": "保养收纳", care: "保养", storage: "收纳",
        "selection guide": "选购指南", selection: "选型", compatibility: "兼容性",
        "technical macro": "技术微距细节", technical: "技术细节", macro: "微距细节",
        "structural proof": "结构验证", structural: "结构", proof: "验证", evidence: "验证依据",
        "hands in use": "手部使用", narrative: "展示说明", demonstration: "演示", guide: "指南",
        product: "产品", overview: "全貌", contents: "内容", accessories: "配件", quantity: "数量",
        material: "材质", finish: "表面处理", texture: "纹理", detail: "细节", details: "细节",
        dimension: "尺寸", dimensions: "尺寸", scale: "比例", specification: "规格", specifications: "规格",
        functional: "功能", function: "功能", features: "功能", package: "包装", audit: "核对",
        performance: "性能", comparison: "对比", benefit: "优势", benefits: "优势", safety: "安全",
        cleaning: "清洁", maintenance: "维护", portable: "便携", portability: "便携性",
        folding: "折叠", folded: "折叠状态", unfolded: "展开状态", adjustment: "调节",
        "/": "与", "+": "与", "&": "与", and: "与", visual: "展示", scene: "场景",
    };
    const normalized = normalize(theme);
    if (aliases[normalized]) return aliases[normalized];
    if (/[\u3400-\u9fff]/.test(theme)) return theme;
    const parts = normalized.split(" ");
    const result = [];
    for (let i = 0; i < parts.length;) {
        let matched = false;
        for (let length = Math.min(4, parts.length - i); length > 0; length--) {
            const phrase = parts.slice(i, i + length).join(" ");
            const translated = aliases[phrase] || words[phrase];
            if (!translated) continue;
            result.push(translated);
            i += length;
            matched = true;
            break;
        }
        if (!matched) return theme;
    }
    return result.join("") || theme;
}
