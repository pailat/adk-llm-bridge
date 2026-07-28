/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

export type {
  DurableWorkspaceLease,
  FileSystemWorkspaceAdapterOptions,
  OfflineWorkspaceTombstoneCollectionOptions,
  OfflineWorkspaceTombstoneCollectionResult,
} from "./file-system-workspace-adapter.js";
export {
  collectFileSystemWorkspaceTombstonesOffline,
  FileSystemWorkspaceAdapter,
} from "./file-system-workspace-adapter.js";
export type { InMemoryWorkspaceAdapterOptions } from "./in-memory-workspace-adapter.js";
export { InMemoryWorkspaceAdapter } from "./in-memory-workspace-adapter.js";
export type {
  WorkflowWorkspaceConfig,
  WorkspaceAcquireOptions,
  WorkspaceAdapter,
  WorkspaceLease,
  WorkspaceLeaseConflict,
  WorkspaceLeaseLossReason,
  WorkspaceLeaseRequest,
  WorkspacePathOverlap,
} from "./workspace-adapter.js";
export {
  findWorkspacePathOverlaps,
  normalizeWorkspaceLeaseRequest,
  normalizeWorkspacePath,
  workspacePathsOverlap,
} from "./workspace-adapter.js";
