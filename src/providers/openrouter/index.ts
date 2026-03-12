/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */
import { createProviderClass, createProviderFactory } from "../../core/create-provider";
import { createRegisterFunction } from "../../core/create-register";
import { OPENROUTER_DEFINITION } from "./definition";

export { OPENROUTER_DEFINITION } from "./definition";

export const OpenRouterLlm = createProviderClass(OPENROUTER_DEFINITION);
export const OpenRouter = createProviderFactory(OPENROUTER_DEFINITION);

const reg = createRegisterFunction(OPENROUTER_DEFINITION, OpenRouterLlm);
export const registerOpenRouter = reg.register;
export const isOpenRouterRegistered = reg.isRegistered;
export const _resetOpenRouterRegistration = reg._reset;
