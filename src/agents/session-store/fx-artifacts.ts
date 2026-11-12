import type { BaseArtifactService } from "@google/adk";
import {
  type FxSessionBundle,
  type FxSessionStore,
  type FxSessionStoreFactory,
  isFxSessionBundle,
  isFxSessionId,
} from "../driver/fx-session.js";

/** Options of {@link fxArtifactSessionStore}. */
export interface FxArtifactSessionStoreOptions {
  /**
   * Use this service instead of `context.artifactService`. The scope (app,
   * user, session) comes from `context.session`.
   */
  artifactService?: BaseArtifactService;
  /**
   * Largest bundle, in UTF-8 bytes of its JSON text. A bigger one is not
   * stored (the save rejects) so a session with large blobs cannot fill the
   * artifact service silently.
   *
   * @defaultValue 67108864 (64 MiB)
   */
  maxBytes?: number;
}

const FORMAT = "fx-session.v1";
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/** The two artifact-service calls the store uses. */
interface ArtifactCalls {
  saveArtifact(request: {
    filename: string;
    artifact: { text: string };
    customMetadata?: Record<string, string | number>;
  }): Promise<unknown>;
  loadArtifact(request: {
    filename: string;
  }): Promise<{ text?: string } | undefined>;
}

function filenameOf(id: string): string {
  if (!isFxSessionId(id)) {
    throw new Error(
      "fxArtifactSessionStore: the fx session id must be 1 to 128 letters, digits, _ or -.",
    );
  }
  return `${FORMAT}.${id}.json`;
}

/**
 * Creates a session store factory that keeps fx session directories in the
 * artifact service of the ADK session, one artifact per fx session.
 *
 * @remarks
 * Each save writes a new artifact version with the whole directory (log,
 * blobs and lock file) as JSON; a load reads the latest version. Artifact
 * services differ in how they price versions, so a long session with large
 * blobs grows by its size on each turn; `maxBytes` bounds one version.
 *
 * @param options - Artifact service override and size limit.
 * @returns The factory. It throws when the run has no artifact service.
 * @throws Error when `maxBytes` is not a positive integer.
 *
 * @experimental
 */
export function fxArtifactSessionStore(
  options: FxArtifactSessionStoreOptions = {},
): FxSessionStoreFactory {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error(
      "fxArtifactSessionStore: maxBytes must be a positive integer.",
    );
  }
  return ({ context }) => {
    let service: ArtifactCalls | undefined;
    if (options.artifactService !== undefined) {
      const scope = {
        appName: context.session.appName,
        userId: context.session.userId,
        sessionId: context.session.id,
      };
      const base = options.artifactService;
      service = {
        saveArtifact: (request) => base.saveArtifact({ ...scope, ...request }),
        loadArtifact: (request) => base.loadArtifact({ ...scope, ...request }),
      };
    } else {
      service = context.artifactService as ArtifactCalls | undefined;
    }
    if (service === undefined) {
      throw new Error(
        "fxArtifactSessionStore needs an artifact service: pass one to the Runner or to fxArtifactSessionStore({ artifactService })",
      );
    }
    return artifactStore(service, maxBytes);
  };
}

function artifactStore(
  service: ArtifactCalls,
  maxBytes: number,
): FxSessionStore {
  return {
    async save(id: string, bundle: FxSessionBundle): Promise<void> {
      const filename = filenameOf(id);
      const text = JSON.stringify(bundle);
      const size = Buffer.byteLength(text, "utf8");
      if (size > maxBytes) {
        throw new Error(
          `fxArtifactSessionStore: the fx session is ${size} bytes, over maxBytes (${maxBytes}); it was not stored.`,
        );
      }
      await service.saveArtifact({
        filename,
        artifact: { text },
        customMetadata: {
          format: FORMAT,
          sessionId: id,
          files: bundle.files.length,
          mtime: Date.now(),
        },
      });
    },
    async load(id: string): Promise<FxSessionBundle | undefined> {
      const filename = filenameOf(id);
      const part = await service.loadArtifact({ filename });
      if (part === undefined || part === null) return undefined;
      let parsed: unknown;
      try {
        parsed = typeof part.text === "string" ? JSON.parse(part.text) : null;
      } catch {
        parsed = null;
      }
      if (!isFxSessionBundle(parsed)) {
        throw new Error(
          `fxArtifactSessionStore: ${filename} is not an fx session bundle.`,
        );
      }
      return parsed;
    },
  };
}
