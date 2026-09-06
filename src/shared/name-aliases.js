(function attachNameAliases(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.STVAINameAliases = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createNameAliasesApi() {
  "use strict";

  const LOCAL_ALIASES = Object.freeze({
    "五条悟": "Gojo Satoru",
    "虎杖悠仁": "Itadori Yuji",
    "漩涡鸣人": "Uzumaki Naruto",
    "宇智波佐助": "Uchiha Sasuke",
    "宇智波带土": "Uchiha Obito",
    "蒙奇D路飞": "Monkey D. Luffy",
    "哆啦A梦": "Doraemon",
    "怪盗基德": "Kaito Kid",
    "工藤新一": "Kudo Shinichi"
  });

  function exactGuideValue(guide, source) {
    let found = "";
    for (const rawLine of String(guide || "").split(/\r?\n/)) {
      let line = rawLine.trim();
      if (line.startsWith("$")) line = line.slice(1).trim();
      const separator = line.indexOf("=");
      if (separator < 1) continue;
      if (line.slice(0, separator).trim() === source) found = line.slice(separator + 1).trim();
    }
    return found;
  }

  function lookup(source, guide) {
    const key = String(source || "").trim();
    return exactGuideValue(guide, key) || LOCAL_ALIASES[key] || "";
  }

  return Object.freeze({ LOCAL_ALIASES, exactGuideValue, lookup });
});
