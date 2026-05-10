/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */
import { createProviderClass, createProviderFactory } from "../../core/create-provider.js";
import { createRegisterFunction } from "../../core/create-register.js";
import { XAI_DEFINITION } from "./definition.js";

export { XAI_DEFINITION } from "./definition.js";

export const XAILlm = createProviderClass(XAI_DEFINITION);
export const XAI = createProviderFactory(XAI_DEFINITION);

const reg = createRegisterFunction(XAI_DEFINITION, XAILlm);
export const registerXAI = reg.register;
export const isXAIRegistered = reg.isRegistered;
export const _resetXAIRegistration = reg._reset;
