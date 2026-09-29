import type {
  ResponseInput,
  ResponseInputFile,
} from "openai/resources/responses/responses";
import {
  parseProductGuideRead,
  parseProductGuidesResult,
  type ProductGuideKind,
  type ProductGuide,
} from "../../shared/product-guides";
import {
  parseGuideLibraryCall,
  parseGuideLibraryResult,
  type GuideLibrary,
  type GuideLibraryResult,
} from "../../shared/guide-library";
import {
  readProductGuideFiles,
  type ProductGuideFiles,
} from "../guides/files.server";
import { createGuideContext } from "../guides/context.server";
import type { GuideSession } from "../guides/session.server";
import {
  parseLibraryReadCall,
  MAX_GUIDE_DOCUMENTS,
  type LibraryInventory,
  type LibrarySourceReceipt,
  type BoundLibrarySource,
  type LibraryReadResult,
} from "../guides/library.server";
import type { CachedGuideSource } from "./presentation.server";
import type { BrowserToolOutcome } from "./browser-tools.server";
import type { MeasurementToolResult } from "../../shared/measurements";
import type { ProductConfigurationResult } from "../../shared/product-configuration";
import type { QuestionPart } from "../../shared/questions";

type GuideToolOutcome =
  BrowserToolOutcome | MeasurementToolResult | ProductConfigurationResult;
export const isGuideTool = (name: string) =>
  name === "get_product_guides" ||
  name === "discover_guides" ||
  name === "read_library_guides";

export interface GuideReuse {
  cached?: GuideSession;
  read(context: {
    productPath: string;
    sourceCallId: string;
    sources: ProductGuide[];
    files: ResponseInputFile[];
  }): void;
  clear(): void;
}

export interface LibraryReuse {
  inventory: LibraryInventory[];
  bound?: BoundLibrarySource;
  recall(
    library: GuideLibrary,
  ): { inventory: LibraryInventory; result: GuideLibraryResult } | undefined;
  discover(callId: string, result: GuideLibraryResult): LibraryInventory;
  read(
    call: ReturnType<typeof parseLibraryReadCall>,
    signal: AbortSignal,
    attachedUrls?: ReadonlySet<string>,
  ): Promise<LibraryReadResult>;
  bind(
    source: LibrarySourceReceipt,
    productPath?: string,
  ): Promise<BoundLibrarySource | undefined>;
}

interface GuideTurnOptions {
  execute?: (
    callId: string,
    name: string,
    input: unknown,
  ) => Promise<GuideToolOutcome>;
  signal: AbortSignal;
  storefrontOrigin?: string;
  onGuideReading?: (kinds: ProductGuideKind[] | undefined) => void;
  guideReuse?: GuideReuse;
  libraryReuse?: LibraryReuse;
  resumeQuestion?: QuestionPart;
  trackTool: <T>(name: string, action: () => Promise<T>) => Promise<T>;
}
interface GuideCall {
  call_id: string;
  name: string;
  arguments: string;
}
interface GuideReadOutcome {
  output: unknown;
  stopBatch?: boolean;
  resumeFailure?: string;
}

/** One model turn's guide originals, cached receipts and measurement authority. */
export function createGuideTurn({
  execute,
  signal,
  storefrontOrigin,
  onGuideReading,
  guideReuse,
  libraryReuse,
  resumeQuestion,
  trackTool,
}: GuideTurnOptions) {
  const availableGuides = new Map<
    string,
    { sourceCallId: string; kinds: ProductGuideKind[] }
  >();
  let measurementProductPath: string | undefined;
  // Original files stay server-side; a verified product session can reuse them.
  const attachedGuideUrls = new Set<string>();
  const documents = new Map<
    string,
    { source: ProductGuide; file: ResponseInputFile }
  >();
  let documentProductPath: string | undefined;
  let guideContext: ReturnType<typeof createGuideContext> | undefined;
  const libraryInputs = new Map<string, ResponseInput[number]>();
  const libraryInventory = [...(libraryReuse?.inventory ?? [])];
  let libraryBound = libraryReuse?.bound;
  let librarySource = libraryBound?.source;
  let cachedGuideSource: CachedGuideSource | undefined;
  let guideResponsePending = false;
  const finishGuideReading = () => {
    if (!guideResponsePending) return;
    guideResponsePending = false;
    onGuideReading?.(undefined);
  };
  let cached = guideReuse?.cached;
  if (
    execute &&
    cached &&
    cached.origin === storefrontOrigin &&
    cached.expiresAt > Date.now()
  ) {
    measurementProductPath = cached.productPath;
    cachedGuideSource = {
      sourceCallId: cached.sourceCallId,
      sourceAssistantId: cached.sourceAssistantId,
      productPath: cached.productPath,
      expiresAt: cached.expiresAt,
      kinds: [...cached.kinds],
    };
    availableGuides.set(cached.productPath, {
      sourceCallId: cached.sourceCallId,
      kinds: [...cached.kinds],
    });
    // Retain prior-read authority, but only an explicit read attaches PDF bytes.
  } else cached = undefined;

  const context = (): ResponseInput => {
    const libraryDocuments: ResponseInput = [];
    const libraryReferences: ResponseInput = [];
    // Selection order must not change an otherwise identical document prefix.
    for (const [url, item] of [...libraryInputs].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )) {
      const content =
        "content" in item && Array.isArray(item.content) ? item.content : [];
      const file = content.find((part) => part.type === "input_file");
      const alreadyAttached =
        guideContext &&
        file?.type === "input_file" &&
        [...documents.values()].some(
          (document) =>
            document.source.url === url &&
            document.file.file_data === file.file_data,
        );
      if (alreadyAttached) {
        // Keep the library's untrusted reference and separate verified binding,
        // without charging for an identical original already in the PDP prefix.
        libraryReferences.push({
          role: "user",
          content: content.filter((part) => part.type === "input_text"),
        });
      } else libraryDocuments.push(item);
    }

    return [
      ...(guideContext?.input ?? []),
      ...libraryDocuments,
      ...libraryReferences,
      {
        role: "developer",
        content:
          "Verified guide bindings: " +
          JSON.stringify({
            ...(libraryBound
              ? {
                  library: {
                    productPath: libraryBound.productPath,
                    ...libraryBound.source,
                  },
                }
              : {}),
            ...(guideContext
              ? {
                  attachedProductGuides: {
                    productPath: guideContext.productPath,
                    guides: [...documents.values()].map(({ source }) => source),
                  },
                }
              : {}),
            ...(cached
              ? {
                  priorProductRead: {
                    productPath: cached.productPath,
                    kinds: cached.kinds,
                  },
                }
              : {}),
          }),
      },
      ...(libraryInventory.length
        ? [
            {
              role: "user" as const,
              content:
                "Store guide library: " +
                JSON.stringify(
                  libraryInventory.map(
                    ({
                      discoveryId,
                      library,
                      pagePath,
                      title,
                      sections,
                      guides,
                    }) => ({
                      discoveryId,
                      library,
                      pagePath,
                      title,
                      sections,
                      guides,
                    }),
                  ),
                ),
            },
          ]
        : []),
    ];
  };
  const invalidateForNavigation = () => {
    measurementProductPath = undefined;
    libraryBound = undefined;
    librarySource = undefined;
    libraryInputs.clear();
    cachedGuideSource = undefined;
    cached = undefined;
    guideReuse?.clear();
    guideContext = undefined;
    documents.clear();
    documentProductPath = undefined;
  };
  const beforeOperation = () => {
    guideResponsePending = false;
    onGuideReading?.(undefined);
  };
  const questionSource = async (
    productPath?: string,
  ): Promise<{ sourceCallId?: string; librarySource?: BoundLibrarySource }> => {
    if (!productPath) return {};
    const source = availableGuides.get(productPath);
    if (librarySource && libraryReuse)
      libraryBound = await libraryReuse.bind(librarySource, productPath);
    if (
      (!source ||
        !source.kinds.includes("measuring") ||
        productPath !== measurementProductPath) &&
      libraryBound?.productPath !== productPath
    )
      throw new Error(
        "This measurement has no verified measuring guide. Ask a safe clarification instead, without measuring instructions.",
      );
    return libraryBound?.productPath === productPath
      ? {
          sourceCallId: libraryBound.source.sourceCallId,
          librarySource: libraryBound,
        }
      : source
        ? { sourceCallId: source.sourceCallId }
        : {};
  };
  const read = async (call: GuideCall): Promise<GuideReadOutcome> => {
    if (
      resumeQuestion?.measurement &&
      call.name === "get_product_guides" &&
      parseProductGuideRead(JSON.parse(call.arguments)).productPath !==
        resumeQuestion.measurement.productPath
    )
      throw new Error("The saved measurement belongs to another product.");
    if (call.name === "read_library_guides") {
      if (!libraryReuse) throw new Error("Library reading is unavailable.");
      let output: unknown;
      try {
        const selection = parseLibraryReadCall(JSON.parse(call.arguments));
        if (selection.refresh) {
          libraryInputs.clear();
          librarySource = undefined;
          libraryBound = undefined;
        }
        onGuideReading?.(["measuring"]);
        const read = await trackTool("read_library_guides", () =>
          libraryReuse.read(selection, signal, attachedGuideUrls),
        );
        signal.throwIfAborted();
        if (read.status !== "ready") {
          onGuideReading?.(undefined);
          output = {
            ...read,
            instruction:
              "No selected original was read. Use supported library text or explain the actual remaining limitation; do not invent steps.",
          };
        } else if (
          new Set([
            ...attachedGuideUrls,
            ...read.guides.map((guide) => guide.url),
          ]).size > MAX_GUIDE_DOCUMENTS
        ) {
          onGuideReading?.(undefined);
          output = {
            error:
              "The three-original-document limit for this reply was reached. Use already-read evidence or ask a relevant clarification; do not claim these files were read.",
          };
        } else {
          read.guides.forEach((guide, index) => {
            attachedGuideUrls.add(guide.url);
            libraryInputs.set(guide.url, read.input[index]);
          });
          librarySource = read.source;
          libraryBound = await libraryReuse.bind(read.source);
          guideResponsePending = true;
          output = {
            status: "ready",
            guides: read.guides,
            unavailable: read.unavailable,
            originalsAttached: true,
          };
        }
      } catch {
        signal.throwIfAborted();
        onGuideReading?.(undefined);
        output = {
          error:
            "The selected library guides could not be read. Select IDs from a current discovery; never invent URLs or measurement instructions.",
        };
      }
      return { output };
    }
    if (!execute) throw new Error("Guide reading is unavailable.");
    let outcome: GuideToolOutcome;
    let requestedGuides: ReturnType<typeof parseProductGuideRead> | undefined;
    let cachedRead: GuideSession | undefined;
    let recalledLibrary: ReturnType<LibraryReuse["recall"]>;
    let priorRead: GuideSession | undefined;
    let unavailableGuides:
      { kind: ProductGuideKind; reason: string }[] | undefined;
    try {
      const value: unknown = JSON.parse(call.arguments);
      let argumentsValue: unknown;
      if (call.name === "get_product_guides") {
        requestedGuides = parseProductGuideRead(value);
        argumentsValue = { productPath: requestedGuides.productPath };
        availableGuides.delete(requestedGuides.productPath);
      } else if (call.name === "discover_guides") {
        const selection = parseGuideLibraryCall(value);
        argumentsValue = selection;
        recalledLibrary = libraryReuse?.recall(selection.library);
      } else throw new Error("Unknown guide tool.");
      signal.throwIfAborted();
      beforeOperation();
      if (recalledLibrary) outcome = recalledLibrary.result;
      else if (
        requestedGuides &&
        !requestedGuides.refresh &&
        cached &&
        cached.expiresAt > Date.now() &&
        cached.productPath === requestedGuides.productPath &&
        requestedGuides.kinds.every((kind) => cached!.kinds.includes(kind))
      ) {
        cachedRead = cached;
        outcome = {
          status: "found",
          productPath: cached.productPath,
          guides: cached.sources,
        };
      } else {
        if (call.name === "get_product_guides") {
          priorRead = cached;
          cached = undefined;
        }
        outcome = await trackTool(call.name, () =>
          execute(call.call_id, call.name, argumentsValue),
        );
      }
      signal.throwIfAborted();
    } catch {
      signal.throwIfAborted();
      outcome = {
        error:
          call.name === "get_product_guides"
            ? "The product's current guide links could not be verified. Do not invent a guide URL, display unavailable guides or claim its PDF instructions were read."
            : "The store lookup could not be completed. Do not claim product availability or invent the missing details.",
      };
    }
    if (
      call.name === "discover_guides" &&
      !("error" in outcome) &&
      libraryReuse &&
      storefrontOrigin
    ) {
      const result = parseGuideLibraryResult(outcome, storefrontOrigin);
      const inventory =
        recalledLibrary?.inventory ??
        libraryReuse.discover(call.call_id, result);
      const old = libraryInventory.findIndex(
        (entry) => entry.library === result.library,
      );
      if (old >= 0) {
        libraryInventory.splice(old, 1);
        // A fresh discovery supersedes its old links and in-turn originals.
        if (!recalledLibrary) libraryInputs.clear();
      }
      libraryInventory.push(inventory);
      // Recalling written sections must not replace selected PDF provenance
      // from this same discovery with a weaker HTML-only source receipt.
      if (
        !recalledLibrary ||
        librarySource?.sourceCallId !== inventory.source.sourceCallId
      ) {
        librarySource = result.sections.some((section) => section.text.trim())
          ? inventory.source
          : undefined;
        libraryBound = librarySource
          ? await libraryReuse.bind(librarySource)
          : undefined;
      }
      return {
        output: {
          ...result,
          discoveryId: inventory.discoveryId,
          originalsAttached: false,
        },
      };
    }

    if (call.name === "get_product_guides") {
      let guides;
      try {
        guides =
          storefrontOrigin && requestedGuides && "guides" in outcome
            ? parseProductGuidesResult(outcome, storefrontOrigin)
            : undefined;
        if (guides?.productPath !== requestedGuides?.productPath)
          guides = undefined;
      } catch {
        guides = undefined;
      }
      const selected =
        guides?.guides.filter((guide) =>
          requestedGuides!.kinds.includes(guide.kind),
        ) ?? [];
      const newUrls = selected
        .map((guide) => guide.url)
        .filter((url) => !attachedGuideUrls.has(url));
      if (guides)
        onGuideReading?.(
          selected.length ? selected.map(({ kind }) => kind) : undefined,
        );
      const read:
        ProductGuideFiles | { status: "unavailable"; reason: string } =
        guides &&
        storefrontOrigin &&
        new Set([...attachedGuideUrls, ...newUrls]).size <= MAX_GUIDE_DOCUMENTS
          ? cachedRead
            ? {
                status: "ready" as const,
                sources: selected,
                files: selected.map(
                  (source) =>
                    cachedRead!.files[
                      cachedRead!.sources.findIndex(
                        ({ kind }) => kind === source.kind,
                      )
                    ],
                ),
              }
            : await trackTool("get_product_guides", () =>
                readProductGuideFiles(
                  {
                    ...guides,
                    status: selected.length ? "found" : "unavailable",
                    guides: selected,
                  },
                  storefrontOrigin,
                  signal,
                  { refresh: requestedGuides!.refresh },
                ),
              )
          : {
              status: "unavailable" as const,
              reason: !storefrontOrigin
                ? "missing_origin"
                : guides
                  ? "document_limit"
                  : "lookup_failed",
            };
      signal.throwIfAborted();
      if (read.status !== "ready") {
        guideReuse?.clear();
        cached = undefined;
        cachedGuideSource = undefined;
        measurementProductPath = undefined;
        guideContext = undefined;
        documents.clear();
        documentProductPath = undefined;
        onGuideReading?.(undefined);
        console.warn("[Roman] Product guides could not be read.", {
          reason: read.reason,
        });
        return {
          output: {
            documentStatus: "unavailable",
            reason: read.reason,
            instruction: resumeQuestion
              ? "The saved measuring question cannot be grounded from these sources. Explain that limitation without substituting a new question or unsupported instructions."
              : "These PDP documents were not read. Try discover_guides for the relevant store library before giving up. Use only matching verified evidence; do not invent steps or repeat the failed lookup.",
          },
          stopBatch: true,
          ...(resumeQuestion
            ? {
                resumeFailure:
                  "The saved measuring step could not be verified from its guide, so I cannot safely repeat those instructions.",
              }
            : {}),
        };
      }
      unavailableGuides = [
        ...(read.unavailable ?? []),
        ...(requestedGuides?.kinds
          .filter((kind) => !selected.some((guide) => guide.kind === kind))
          .map((kind) => ({ kind, reason: "no_guides" })) ?? []),
      ];
      guideResponsePending = true;
      onGuideReading?.(read.sources.map(({ kind }) => kind));
      if (unavailableGuides?.length)
        console.warn("[Roman] Some product guides could not be read.", {
          guides: unavailableGuides,
        });
      if (guides && storefrontOrigin) {
        if (documentProductPath !== guides.productPath) documents.clear();
        documentProductPath = guides.productPath;
        // A refreshed page binding invalidates replaced or removed references.
        for (const [kind, document] of documents)
          if (
            !guides.guides.some(
              (guide) =>
                guide.kind === kind && guide.url === document.source.url,
            ) ||
            (requestedGuides!.kinds.includes(document.source.kind) &&
              !read.sources.some((source) => source.kind === kind))
          )
            documents.delete(kind);
        for (let index = 0; index < read.sources.length; index++) {
          const source = read.sources[index];
          documents.set(source.kind, { source, file: read.files[index] });
          attachedGuideUrls.add(source.url);
        }
        guideContext = createGuideContext(
          {
            status: "ready",
            sources: [...documents.values()].map(({ source }) => source),
            files: [...documents.values()].map(({ file }) => file),
          },
          storefrontOrigin,
          guides.productPath,
        );
        outcome = { ...guides, guides: read.sources };
        measurementProductPath = guides.productPath;
        // Attachment is demand-driven; preserve other prior originals in the
        // server cache only when this discovery confirms their exact binding.
        const reusable = new Map(documents);
        if (
          priorRead?.productPath === guides.productPath &&
          priorRead.expiresAt > Date.now()
        )
          for (let index = 0; index < priorRead.sources.length; index++) {
            const source = priorRead.sources[index];
            if (
              !reusable.has(source.kind) &&
              guides.guides.some(
                (guide) =>
                  guide.kind === source.kind && guide.url === source.url,
              ) &&
              (!requestedGuides!.kinds.includes(source.kind) ||
                read.sources.some(({ kind }) => kind === source.kind))
            )
              reusable.set(source.kind, {
                source,
                file: priorRead.files[index],
              });
          }
        availableGuides.set(guides.productPath, {
          sourceCallId: cachedRead?.sourceCallId ?? call.call_id,
          kinds:
            cachedRead?.kinds ??
            [...reusable.values()].map(({ source }) => source.kind),
        });
        if (!cachedRead)
          guideReuse?.read({
            productPath: guides.productPath,
            sourceCallId: call.call_id,
            sources: [...reusable.values()].map(({ source }) => source),
            files: [...reusable.values()].map(({ file }) => file),
          });
      }
    }

    return {
      output:
        call.name === "get_product_guides"
          ? {
              ...outcome,
              documentStatus: unavailableGuides?.length ? "partial" : "ready",
              ...(unavailableGuides?.length ? { unavailableGuides } : {}),
              originalsAttached: true,
            }
          : outcome,
    };
  };
  return {
    context,
    read,
    questionSource,
    invalidateForNavigation,
    beforeOperation,
    finishReading: finishGuideReading,
    cachedSource: () => cachedGuideSource,
  };
}
