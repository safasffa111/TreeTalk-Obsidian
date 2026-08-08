import { estimateTextTokens } from "../../../domain/context-engine";

const MAXIMUM_SOURCE_CHARACTERS = 2_000_000;
const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain"]);

export interface WebPageResponse {
  status: number;
  text: string;
  contentType?: string;
}

export interface ExtractReadableWebTextInput {
  text: string;
  contentType?: string;
  maximumTokens: number;
}

export interface ExtractedWebText {
  content: string;
  estimatedTokens: number;
}

function parseIpv4(hostname: string): number[] | undefined {
  const parts = hostname.split(".");
  if (parts.length !== 4) return undefined;
  const values = parts.map((part) => Number(part));
  if (
    values.some(
      (value, index) =>
        !Number.isInteger(value) ||
        value < 0 ||
        value > 255 ||
        String(value) !== parts[index]
    )
  ) {
    return undefined;
  }
  return values;
}

function isBlockedIpv4(parts: number[]): boolean {
  const [a = 0, b = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isBlockedIpv6(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/u.test(normalized) ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.")
  );
}

export function assertSafeWebUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("网页结果 URL 无效");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new TypeError("网页结果 URL 使用了不安全协议");
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new TypeError("网页结果 URL 包含不安全凭据");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  const ipv4 = parseIpv4(hostname);
  if (
    hostname.length === 0 ||
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    (ipv4 !== undefined && isBlockedIpv4(ipv4)) ||
    (hostname.includes(":") && isBlockedIpv6(hostname))
  ) {
    throw new TypeError("网页结果 URL 指向不安全的本地或私有地址");
  }
  parsed.hash = "";
  return parsed;
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "…",
    laquo: "«",
    ldquo: "“",
    lsquo: "‘",
    lt: "<",
    nbsp: " ",
    quot: '"',
    raquo: "»",
    rdquo: "”",
    rsquo: "’"
  };
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|([a-z][a-z0-9]+));/giu,
    (match, decimal: string | undefined, hexadecimal: string | undefined, name: string | undefined) => {
      if (decimal !== undefined) {
        const codePoint = Number(decimal);
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
      }
      if (hexadecimal !== undefined) {
        const codePoint = Number.parseInt(hexadecimal, 16);
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
      }
      return name === undefined ? match : (named[name.toLowerCase()] ?? match);
    }
  );
}

function firstContainer(html: string, tag: "article" | "main" | "body"): string | undefined {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "iu").exec(html);
  return match?.[1];
}

function htmlToReadableText(value: string): string {
  const withoutComments = value.replace(/<!--[\s\S]*?-->/gu, " ");
  const withoutNoise = withoutComments.replace(
    /<(script|style|noscript|svg|canvas|iframe|object|embed|template|nav|header|footer|form|dialog|aside)\b[^>]*>[\s\S]*?<\/\1>/giu,
    "\n"
  );
  const selected =
    firstContainer(withoutNoise, "article") ??
    firstContainer(withoutNoise, "main") ??
    firstContainer(withoutNoise, "body") ??
    withoutNoise;
  const withStructure = selected
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<li\b[^>]*>/giu, "\n- ")
    .replace(/<\/(p|div|section|article|main|h[1-6]|li|tr|blockquote|pre)>/giu, "\n")
    .replace(/<[^>]+>/gu, " ");
  return decodeHtmlEntities(withStructure)
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t\f\v ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function clipToTokenBudget(content: string, maximumTokens: number): ExtractedWebText {
  const budget = Math.max(1, Math.trunc(maximumTokens));
  const measured = estimateTextTokens(content);
  if (measured <= budget) return { content, estimatedTokens: measured };

  const suffix = "\n\n…（网页正文已按证据预算截断）";
  let low = 0;
  let high = content.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${content.slice(0, middle).trim()}${suffix}`;
    if (estimateTextTokens(candidate) <= budget) low = middle;
    else high = middle - 1;
  }
  const clipped = `${content.slice(0, Math.max(1, low)).trim()}${suffix}`;
  return {
    content: clipped,
    estimatedTokens: Math.min(budget, estimateTextTokens(clipped))
  };
}

export function extractReadableWebText(
  input: ExtractReadableWebTextInput
): ExtractedWebText {
  const contentType = input.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  const source = input.text.slice(0, MAXIMUM_SOURCE_CHARACTERS);
  const looksLikeHtml = /^\s*(?:<!doctype\s+html|<html|<body|<main|<article)/iu.test(source);
  let readable: string;
  if (
    contentType === undefined ||
    contentType.length === 0 ||
    contentType === "text/html" ||
    contentType === "application/xhtml+xml" ||
    looksLikeHtml
  ) {
    readable = htmlToReadableText(source);
  } else if (
    contentType.startsWith("text/") ||
    contentType === "application/json" ||
    contentType === "application/ld+json"
  ) {
    readable = source
      .replace(/\r\n?/gu, "\n")
      .replace(/[\t\f\v ]+/gu, " ")
      .replace(/\n{3,}/gu, "\n\n")
      .trim();
  } else {
    throw new Error(`不支持读取该网页内容类型：${contentType}`);
  }
  if (readable.length === 0) {
    throw new Error("网页没有可读取的正文内容");
  }
  return clipToTokenBudget(readable, input.maximumTokens);
}
