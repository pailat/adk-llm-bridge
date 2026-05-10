/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type { CredentialRequest, ExternalAgentCredential } from "./schema";

export interface ExternalAgentCredentialProvider {
  getCredential(request: CredentialRequest): Promise<ExternalAgentCredential | undefined>;
}

export class NoopCredentialProvider implements ExternalAgentCredentialProvider {
  async getCredential(): Promise<ExternalAgentCredential | undefined> {
    return undefined;
  }
}
