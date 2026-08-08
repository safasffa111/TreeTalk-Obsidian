export type PiAnswerEnvelopeMode =
  | "final"
  | "need_more_context"
  | "legacy";

export interface PiAnswerEnvelopeResult {
  mode: PiAnswerEnvelopeMode;
  text: string;
}

const FINAL_MARKER = "TT_MODE: FINAL";
const NEED_MORE_MARKER = "TT_MODE: NEED_MORE_CONTEXT";

/**
 * Holds back only the first protocol line. Once FINAL is known, subsequent
 * prose is released immediately; NEED_MORE_CONTEXT payloads are never exposed.
 */
export class PiAnswerStreamDecoder {
  private undecided = "";
  private body = "";
  private currentMode: PiAnswerEnvelopeMode | undefined;

  get mode(): PiAnswerEnvelopeMode | undefined {
    return this.currentMode;
  }

  push(chunk: string): string[] {
    if (chunk.length === 0) return [];
    if (this.currentMode === "final") {
      this.body += chunk;
      return [chunk];
    }
    if (this.currentMode === "need_more_context") {
      this.body += chunk;
      return [];
    }
    if (this.currentMode === "legacy") {
      this.body += chunk;
      return [];
    }

    this.undecided += chunk;
    const newline = this.undecided.indexOf("\n");
    if (newline < 0) return [];
    const firstLine = this.undecided.slice(0, newline).trim();
    const remainder = this.undecided.slice(newline + 1);
    this.undecided = "";
    if (firstLine === FINAL_MARKER) {
      this.currentMode = "final";
      this.body = remainder;
      return remainder.length === 0 ? [] : [remainder];
    }
    if (firstLine === NEED_MORE_MARKER) {
      this.currentMode = "need_more_context";
      this.body = remainder;
      return [];
    }
    this.currentMode = "legacy";
    this.body = `${firstLine}${remainder.length === 0 ? "" : `\n${remainder}`}`;
    return [];
  }

  finish(): PiAnswerEnvelopeResult {
    if (this.currentMode === undefined) {
      const text = this.undecided;
      this.undecided = "";
      if (text.trim() === FINAL_MARKER) {
        this.currentMode = "final";
        this.body = "";
      } else if (text.trim() === NEED_MORE_MARKER) {
        this.currentMode = "need_more_context";
        this.body = "";
      } else {
        this.currentMode = "legacy";
        this.body = text;
      }
    }
    return { mode: this.currentMode, text: this.body };
  }
}

export function parsePiAnswerEnvelope(text: string): PiAnswerEnvelopeResult {
  const decoder = new PiAnswerStreamDecoder();
  decoder.push(text);
  return decoder.finish();
}
