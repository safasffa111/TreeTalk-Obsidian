import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cases = JSON.parse(fs.readFileSync(path.join(root, "benchmarks/pi-progressive-cases.json"), "utf8"));
const resultPath = process.argv[2];
if (resultPath === undefined) {
  throw new Error("Usage: node scripts/summarize-pi-progressive-benchmark.mjs <measured-results.json>");
}
const measured = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), resultPath), "utf8"));
if (!Array.isArray(measured)) throw new TypeError("Measured benchmark results must be a JSON array");

const caseById = new Map(cases.map((entry) => [entry.id, entry]));
const variants = new Map();
const seen = new Set();
for (const [index, entry] of measured.entries()) {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new TypeError(`Result ${String(index)} must be an object`);
  }
  if (typeof entry.caseId !== "string" || !caseById.has(entry.caseId)) {
    throw new Error(`Result ${String(index)} has an unknown or missing caseId`);
  }
  if (typeof entry.variant !== "string" || entry.variant.trim().length === 0) {
    throw new Error(`Result ${String(index)} has a missing variant`);
  }
  const key = `${entry.variant}:${entry.caseId}`;
  if (seen.has(key)) throw new Error(`Duplicate measured result: ${key}`);
  seen.add(key);
  const list = variants.get(entry.variant) ?? [];
  list.push({ ...entry, category: caseById.get(entry.caseId).category });
  variants.set(entry.variant, list);
}
for (const [variant, entries] of variants) {
  const ids = new Set(entries.map((entry) => entry.caseId));
  const missing = cases.filter((entry) => !ids.has(entry.id)).map((entry) => entry.id);
  if (missing.length > 0) {
    throw new Error(`${variant} is missing ${String(missing.length)} benchmark cases: ${missing.slice(0, 5).join(", ")}`);
  }
}

const numeric = [
  "modelCalls", "promptTokens", "completionTokens", "reasoningTokens",
  "cacheHitTokens", "cacheMissTokens", "firstTokenMs", "totalLatencyMs",
  "qualityScore"
];
function average(entries, key) {
  const values = entries.map((entry) => entry[key]).filter((value) => typeof value === "number" && Number.isFinite(value));
  return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;
}
function fmt(value, digits = 0) {
  return value === undefined ? "—" : value.toLocaleString("zh-CN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
function row(label, entries) {
  const relatedUse = entries.filter((entry) => entry.relatedNotesUsed === true).length / entries.length * 100;
  const limits = entries.filter((entry) => entry.expansionLimitReached === true).length / entries.length * 100;
  return `| ${label} | ${fmt(average(entries,"modelCalls"),2)} | ${fmt(average(entries,"promptTokens"))} | ${fmt(average(entries,"completionTokens"))} | ${fmt(average(entries,"reasoningTokens"))} | ${fmt(average(entries,"cacheHitTokens"))} | ${fmt(average(entries,"firstTokenMs"))} | ${fmt(average(entries,"totalLatencyMs"))} | ${fmt(relatedUse,1)}% | ${fmt(limits,1)}% | ${fmt(average(entries,"qualityScore"),2)} |`;
}

const lines = [
  "# Pi Progressive Benchmark Summary",
  "",
  "本报告只汇总传入的测量数据，不会调用任何模型。带 `fixture: true` 的数据仅用于验证脚本。",
  "",
  "| 变体 / 分类 | 调用数 | 输入 Token | 输出 Token | 推理 Token | 缓存命中 | 首 Token ms | 总耗时 ms | 关联笔记使用 | 达到扩展上限 | 质量分 |",
  "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"
];
for (const [variant, entries] of [...variants.entries()].sort(([a],[b]) => a.localeCompare(b))) {
  lines.push(row(`**${variant} · 总体**`, entries));
  const categories = [...new Set(entries.map((entry) => entry.category))].sort();
  for (const category of categories) {
    lines.push(row(`${variant} · ${category}`, entries.filter((entry) => entry.category === category)));
  }
}
const startFinal = [...variants.entries()].map(([variant, entries]) => ({
  variant,
  averageStart: average(entries, "startLevel"),
  averageFinal: average(entries, "finalLevel")
}));
lines.push("", "## 层级", "", "| 变体 | 平均起点 | 平均终点 |", "|---|---:|---:|");
for (const entry of startFinal) lines.push(`| ${entry.variant} | ${fmt(entry.averageStart,2)} | ${fmt(entry.averageFinal,2)} |`);
console.log(lines.join("\n"));
