(function attachTtsPronunciation(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.STVAITTSPronunciation = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createTtsPronunciationApi() {
  "use strict";

  const DEFAULT_GUIDE = [
    "vi=di", "streamer=sờ trim mơ",
    "AI=ây ai", "CEO=xi i ô", "IT=ai ti", "IP=ai pi",
    "API=ây pi ai", "URL=iu a eo", "USB=iu ét bi", "PC=pi xi",
    "kg=ki lô gam", "km=ki lô mét", "cm=xen ti mét",
    "GB=ghi ga bai", "MB=mê ga bai", "GHz=ghi ga héc", "°C=độ xê"
  ].join("\n");
  const MIGRATION_GUIDE = DEFAULT_GUIDE.split("\n").slice(2).join("\n");
  const DEFAULTS_VERSION = 1;
  const SILENT_VALUE = "[bỏ qua]";
  const MAX_GUIDE_LENGTH = 20_000;
  const MAX_RULES = 200;
  const MAX_SOURCE_LENGTH = 100;
  const MAX_SPOKEN_LENGTH = 200;
  const WORD_CHARACTER = "\\p{L}\\p{M}\\p{N}_";
  const DECIMAL_PATTERN = /(?<![\p{L}\p{M}\p{N}_.,])(\d+)([.,])(\d+)(?![\p{L}\p{M}\p{N}_]|[.,]\d)/gu;
  const FRACTION_PATTERN = /(?<![\p{L}\p{M}\p{N}_/])(\d+)\/(\d+)(?![\p{L}\p{M}\p{N}_/])/gu;
  const DATE_WITH_YEAR_PATTERN = /(?<![\p{L}\p{M}\p{N}_/])(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?![\p{L}\p{M}\p{N}_/])/gu;
  const PADDED_DATE_PATTERN = /(?<![\p{L}\p{M}\p{N}_/])(\d{1,2})\/(\d{1,2})(?![\p{L}\p{M}\p{N}_/])/gu;
  const UNIT_SOURCES = new Set(["kg", "km", "cm", "GB", "MB", "GHz", "°C"]);
  const DIGIT_WORDS = Object.freeze(["không", "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín"]);

  function normalizePart(value) {
    return String(value || "").trim().normalize("NFC");
  }

  function normalizedSource(value) {
    return normalizePart(value).replace(/\s+/gu, " ");
  }

  function isExactCaseSource(value) {
    const letters = normalizedSource(value).match(/[A-Za-z]/gu) || [];
    return letters.length >= 2 && letters.every(letter => letter === letter.toUpperCase());
  }

  function foldedKey(value) {
    return normalizedSource(value).toLocaleLowerCase("vi");
  }

  function ruleKey(value) {
    const source = normalizedSource(value);
    const exact = isExactCaseSource(source);
    return `${exact ? "exact" : "folded"}:${exact ? source : source.toLocaleLowerCase("vi")}`;
  }

  function normalizeSpoken(value) {
    const spoken = normalizePart(value);
    return foldedKey(spoken) === foldedKey(SILENT_VALUE) ? SILENT_VALUE : spoken;
  }

  function isValidRule(source, spoken) {
    return Boolean(source && spoken
      && source.length <= MAX_SOURCE_LENGTH
      && spoken.length <= MAX_SPOKEN_LENGTH
      && !/[=\r\n]/u.test(source)
      && !/[\r\n]/u.test(spoken));
  }

  function parseGuide(input) {
    if (typeof input !== "string" || input.length > MAX_GUIDE_LENGTH) return [];
    const mappings = new Map();
    for (const line of input.split(/\r?\n/u)) {
      const separator = line.indexOf("=");
      if (separator < 0) continue;
      const source = normalizePart(line.slice(0, separator));
      const spoken = normalizeSpoken(line.slice(separator + 1));
      if (!isValidRule(source, spoken)) continue;
      const key = ruleKey(source);
      if (mappings.has(key)) mappings.delete(key);
      mappings.set(key, { source, spoken });
    }
    return Array.from(mappings.values()).slice(-MAX_RULES)
      .sort((left, right) => right.source.length - left.source.length);
  }

  function sanitizeRules(value, { strict = false } = {}) {
    if (!Array.isArray(value) || value.length > MAX_RULES) {
      if (strict) throw new Error("Danh sách phát âm không hợp lệ.");
      return [];
    }
    const rules = [];
    for (const candidate of value) {
      const exactShape = candidate && typeof candidate === "object" && !Array.isArray(candidate)
        && Object.keys(candidate).every(key => key === "source" || key === "spoken")
        && typeof candidate.source === "string" && typeof candidate.spoken === "string";
      const source = exactShape ? normalizePart(candidate.source) : "";
      const spoken = exactShape ? normalizeSpoken(candidate.spoken) : "";
      if (!exactShape || !isValidRule(source, spoken)) {
        if (strict) throw new Error("Quy tắc phát âm không hợp lệ.");
        continue;
      }
      rules.push({ source, spoken });
    }
    return parseGuide(rules.map(rule => `${rule.source}=${rule.spoken}`).join("\n"));
  }

  function escapePattern(value) {
    return value.split(/\s+/u).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  }

  function decimalMatches(input) {
    const matches = [];
    for (const match of String(input ?? "").matchAll(DECIMAL_PATTERN)) {
      const integer = match[1];
      const fraction = match[3];
      if (fraction.length === 3 && !/^0+$/u.test(integer)) continue;
      matches.push({ start: match.index, end: match.index + match[0].length });
    }
    return matches;
  }

  function normalizeDecimals(input) {
    return String(input ?? "").replace(
      DECIMAL_PATTERN,
      (match, integer, separator, fraction) => {
        if (fraction.length === 3 && !/^0+$/u.test(integer)) return match;
        const spokenFraction = Array.from(fraction, digit => DIGIT_WORDS[Number(digit)]).join(" ");
        return `${integer} ${separator === "." ? "chấm" : "phẩy"} ${spokenFraction}`;
      }
    );
  }

  function isPaddedNumber(value) {
    return value.length > 1 && value.startsWith("0");
  }

  function isSpokenFraction(numerator, denominator) {
    return !isPaddedNumber(numerator)
      && !isPaddedNumber(denominator)
      && !/^0+$/u.test(denominator);
  }

  function fractionMatches(input) {
    const matches = [];
    for (const match of String(input ?? "").matchAll(FRACTION_PATTERN)) {
      if (!isSpokenFraction(match[1], match[2])) continue;
      matches.push({ start: match.index, end: match.index + match[0].length });
    }
    return matches;
  }

  function normalizeFractions(input) {
    return String(input ?? "").replace(
      FRACTION_PATTERN,
      (match, numerator, denominator) => isSpokenFraction(numerator, denominator)
        ? `${numerator} phần ${denominator}`
        : match
    );
  }

  function isValidDate(day, month) {
    const dayNumber = Number(day);
    const monthNumber = Number(month);
    return dayNumber >= 1 && dayNumber <= 31 && monthNumber >= 1 && monthNumber <= 12;
  }

  function hasDateWordPrefix(text, offset) {
    return /(?:^|[^\p{L}\p{M}])ngày\s*$/iu.test(text.slice(0, offset));
  }

  function spokenDate(day, month, year, includeDateWord) {
    const prefix = includeDateWord ? "ngày " : "";
    const yearPart = year ? ` năm ${Number(year)}` : "";
    return `${prefix}${Number(day)} tháng ${Number(month)}${yearPart}`;
  }

  function dateMatches(input) {
    const text = String(input ?? "");
    const matches = [];
    for (const match of text.matchAll(DATE_WITH_YEAR_PATTERN)) {
      if (!isValidDate(match[1], match[2])) continue;
      matches.push({ start: match.index, end: match.index + match[0].length });
    }
    for (const match of text.matchAll(PADDED_DATE_PATTERN)) {
      if (!isValidDate(match[1], match[2])) continue;
      if (!isPaddedNumber(match[1]) && !isPaddedNumber(match[2])) continue;
      matches.push({ start: match.index, end: match.index + match[0].length });
    }
    return matches;
  }

  function normalizeDates(input) {
    const withYears = String(input ?? "").replace(
      DATE_WITH_YEAR_PATTERN,
      (match, day, month, year, offset, text) => isValidDate(day, month)
        ? spokenDate(day, month, year, !hasDateWordPrefix(text, offset))
        : match
    );
    return withYears.replace(
      PADDED_DATE_PATTERN,
      (match, day, month, offset, text) => isValidDate(day, month)
        && (isPaddedNumber(day) || isPaddedNumber(month))
        ? spokenDate(day, month, "", !hasDateWordPrefix(text, offset))
        : match
    );
  }

  function normalizeAutomaticNumbers(input) {
    return normalizeFractions(normalizeDecimals(normalizeDates(input)));
  }

  function hasNumericUnitPrefix(text, offset) {
    return /(?:^|[^\p{L}\p{M}\p{N}_])\d+(?:[.,]\d+)*\s*$/u.test(text.slice(0, offset));
  }

  function migrateGuide(input, version) {
    const guide = typeof input === "string" ? input.slice(0, MAX_GUIDE_LENGTH) : "";
    if (Number(version) >= DEFAULTS_VERSION) {
      return { guide, version: DEFAULTS_VERSION, changed: false };
    }
    const existing = new Set(parseGuide(guide).map(rule => ruleKey(rule.source)));
    const additions = parseGuide(MIGRATION_GUIDE)
      .filter(rule => !existing.has(ruleKey(rule.source)))
      .map(rule => `${rule.source}=${rule.spoken}`);
    const available = MAX_GUIDE_LENGTH - guide.length - (guide ? 1 : 0);
    const accepted = [];
    let used = 0;
    for (const addition of additions) {
      const extra = addition.length + (accepted.length ? 1 : 0);
      if (used + extra > available) continue;
      accepted.push(addition);
      used += extra;
    }
    const migrated = [...accepted, guide].filter(Boolean).join("\n");
    return { guide: migrated, version: DEFAULTS_VERSION, changed: true };
  }

  function createReplacer(value) {
    const rules = sanitizeRules(value);
    if (!rules.length) return normalizeAutomaticNumbers;
    const rulesByFoldedSource = new Map();
    for (const rule of rules) {
      const key = foldedKey(rule.source);
      const candidates = rulesByFoldedSource.get(key) || [];
      candidates.push(rule);
      rulesByFoldedSource.set(key, candidates);
    }
    const alternatives = rules.map(rule => escapePattern(rule.source)).join("|");
    const matcher = new RegExp(`(${alternatives})`, "giu");
    const wordCharacter = new RegExp(`[${WORD_CHARACTER}]`, "u");
    return input => {
      const original = String(input ?? "");
      const decimals = decimalMatches(original);
      const fractions = fractionMatches(original);
      const dates = dateMatches(original);
      const replaced = original.replace(matcher, (match, source, offset, text) => {
        const candidates = rulesByFoldedSource.get(foldedKey(source)) || [];
        const exact = candidates.find(rule => isExactCaseSource(rule.source)
          && normalizedSource(rule.source) === normalizedSource(source));
        const rule = exact || candidates.find(candidate => !isExactCaseSource(candidate.source));
        if (!rule) return match;
        if (decimals.some(decimal => offset < decimal.end && offset + match.length > decimal.start)) return match;
        if (fractions.some(fraction => offset < fraction.end && offset + match.length > fraction.start)) return match;
        if (dates.some(date => offset < date.end && offset + match.length > date.start)) return match;
        const characters = Array.from(source);
        const before = Array.from(text.slice(0, offset)).at(-1) || "";
        const after = Array.from(text.slice(offset + match.length))[0] || "";
        if (UNIT_SOURCES.has(rule.source)) {
          if (!hasNumericUnitPrefix(text, offset) || wordCharacter.test(after)) return match;
          if (rule.spoken === SILENT_VALUE) return "";
          return `${/\s$/u.test(text.slice(0, offset)) ? "" : " "}${rule.spoken}`;
        }
        const containsWordCharacter = characters.some(character => wordCharacter.test(character));
        if (containsWordCharacter && (wordCharacter.test(before) || wordCharacter.test(after))) return match;
        return rule.spoken === SILENT_VALUE ? "" : rule.spoken;
      });
      return normalizeAutomaticNumbers(replaced);
    };
  }

  function applyToText(input, value) {
    return createReplacer(value)(input);
  }

  return Object.freeze({
    DEFAULT_GUIDE,
    DEFAULTS_VERSION,
    SILENT_VALUE,
    MAX_GUIDE_LENGTH,
    MAX_RULES,
    MAX_SOURCE_LENGTH,
    MAX_SPOKEN_LENGTH,
    parseGuide,
    sanitizeRules,
    migrateGuide,
    createReplacer,
    applyToText
  });
});
