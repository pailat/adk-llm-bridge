/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */
import { createProviderClass, createProviderFactory } from "../../core/create-provider.js";
import { createRegisterFunction } from "../../core/create-register.js";
import { OPENAI_DEFINITION } from "./definition.js";

export { OPENAI_DEFINITION } from "./definition.js";

export const OpenAILlm = createProviderClass(OPENAI_DEFINITION);
export const OpenAI = createProviderFactory(OPENAI_DEFINITION);

const reg = createRegisterFunction(OPENAI_DEFINITION, OpenAILlm);
export const registerOpenAI = reg.register;
export const isOpenAIRegistered = reg.isRegistered;
export const _resetOpenAIRegistration = reg._reset;
