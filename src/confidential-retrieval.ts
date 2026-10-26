import { ProtocolError } from "./errors.js";
import { createHash } from "node:crypto";
import { defaultGuard, guarded, HandleStore } from "./guarded.js";
import { ToolRegistry, type ToolDefinition } from "./tools.js";
import type { Effect, GuardedValue, PrivateHandle } from "./types.js";

export interface ConfidentialDocument {
  id: string;
  path: string;
  content: string;
  metadata?: Record<string, string>;
}

export interface Intent {
  terms: string[];
  fileType?: string;
}

export interface TrustedIntentInterpreter {
  interpret(description: string): Promise<Intent> | Intent;
}

export interface TrustedEmbedder {
  readonly dimensions: number;
  embed(text: string): Promise<readonly number[]> | readonly number[];
}

export interface PresentedFile {
  documentId: string;
  path: string;
}

export interface ConfidentialRetrievalOptions {
  scope: string;
  documents: readonly ConfidentialDocument[];
  embedder: TrustedEmbedder;
  intentInterpreter: TrustedIntentInterpreter;
  present(file: PresentedFile): Promise<void> | void;
  maxCandidates?: number;
}

interface IndexedDocument { document: ConfidentialDocument; vector: readonly number[] }
interface SearchState { candidates: string[] }

const searchEffect: Effect[] = [];
const presentEffect: Effect[] = [{ type: "present", resource: "local-file", reversible: false }];

/**
 * Trusted side of the confidential-file benchmark. Raw documents, paths, scores,
 * and vectors remain in this object and never become tool results.
 */
export class ConfidentialRetrievalService {
  readonly tools = new ToolRegistry();
  readonly #handles: HandleStore;
  readonly #byId = new Map<string, ConfidentialDocument>();
  #index: IndexedDocument[] = [];

  private constructor(readonly options: ConfidentialRetrievalOptions) {
    this.#handles = new HandleStore(options.scope);
    for (const document of options.documents) {
      if (this.#byId.has(document.id)) throw new ProtocolError(`DUPLICATE_DOCUMENT_ID:${document.id}`);
      this.#byId.set(document.id, document);
    }
    this.tools.register(this.searchTool()).register(this.presentTool());
  }

  static async create(options: ConfidentialRetrievalOptions): Promise<ConfidentialRetrievalService> {
    const service = new ConfidentialRetrievalService(options);
    service.#index = await Promise.all(options.documents.map(async document => ({
      document,
      vector: await options.embedder.embed(indexableText(document))
    })));
    return service;
  }

  private searchTool(): ToolDefinition {
    return {
      name: "confidential.search",
      aliases: ["find confidential file", "semantic file search"],
      capability: "tool:confidential.search",
      effects: searchEffect,
      inputSchema: {
        type: "object", required: ["description"], additionalProperties: false,
        properties: { description: { type: "string" } }
      },
      execute: async args => {
        const description = requireString(args.description, "DESCRIPTION_REQUIRED");
        const intent = await this.options.intentInterpreter.interpret(description);
        const query = [intent.terms.join(" "), intent.fileType ?? ""].join(" ").trim();
        const vector = await this.options.embedder.embed(query);
        const limit = Math.max(1, this.options.maxCandidates ?? 5);
        const candidates = this.#index
          .map(entry => ({ id: entry.document.id, score: cosine(vector, entry.vector) }))
          .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
          .slice(0, limit)
          .map(match => match.id);
        const state = guarded<SearchState>({ candidates }, {
          ...defaultGuard(this.options.scope, "secret"),
          provenance: ["trusted:semantic-index"],
          permittedOperations: ["present-best-match"],
          correlation: "session"
        });
        return this.#handles.create(state, "confidential-search");
      }
    };
  }

  private presentTool(): ToolDefinition {
    return {
      name: "confidential.present-best",
      aliases: ["open best confidential match"],
      capability: "tool:confidential.present",
      effects: presentEffect,
      execute: async args => {
        const handle = requireHandle(args.search, "confidential-search");
        const state = this.#handles.resolve(handle).value as SearchState;
        const document = state.candidates[0] ? this.#byId.get(state.candidates[0]) : undefined;
        if (!document) throw new ProtocolError("NO_MATCH");
        await this.options.present({ documentId: document.id, path: document.path });
        return guarded({ status: "presented_to_authorized_user" }, {
          ...defaultGuard(this.options.scope, "public"),
          provenance: ["trusted:local-presenter"],
          disclosures: ["operation-status"],
          permittedDestinations: ["local", "remote"]
        });
      }
    };
  }
}

/** A deterministic offline stand-in for a pinned, trusted embedding model. */
export class HashingEmbedder implements TrustedEmbedder {
  constructor(readonly dimensions = 256) {
    if (!Number.isInteger(dimensions) || dimensions < 8) throw new ProtocolError("INVALID_EMBEDDING_DIMENSIONS");
  }
  embed(text: string): readonly number[] {
    const vector = Array<number>(this.dimensions).fill(0);
    for (const token of tokenize(text)) {
      const digest = createHash("sha256").update(token).digest();
      const index = digest.readUInt32BE(0) % this.dimensions;
      vector[index] = (vector[index] ?? 0) + (digest[4]! & 1 ? 1 : -1);
    }
    return vector;
  }
}

/** Local deterministic intent parsing; replaceable by an audited local model. */
export class LocalIntentInterpreter implements TrustedIntentInterpreter {
  interpret(description: string): Intent {
    const extension = description.toLowerCase().match(/\b(pdf|docx?|xlsx?|pptx?|txt|md)\b/)?.[1];
    return { terms: tokenize(description), fileType: extension };
  }
}

function indexableText(document: ConfidentialDocument): string {
  return [document.path, document.content, ...Object.values(document.metadata ?? {})].join(" ");
}
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g)?.filter(token => token.length > 1) ?? [];
}
function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0; let leftNorm = 0; let rightNorm = 0;
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const a = left[i] ?? 0; const b = right[i] ?? 0;
    dot += a * b; leftNorm += a * a; rightNorm += b * b;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}
function requireString(value: GuardedValue | undefined, code: string): string {
  if (typeof value?.value !== "string" || !value.value.trim()) throw new ProtocolError(code);
  return value.value;
}
function requireHandle(value: GuardedValue | undefined, type: string): PrivateHandle {
  if (!value?.handle || value.handle.type !== type) throw new ProtocolError("INVALID_SEARCH_HANDLE");
  return value.handle;
}
