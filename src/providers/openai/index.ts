/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */
import { createProviderClass, createProviderFactory } from "../../core/create-provider";
import { createRegisterFunction } from "../../core/create-register";
import { OPENAI_DEFINITION } from "./definition";

export { OPENAI_DEFINITION } from "./definition";

export const OpenAILlm = createProviderClass(OPENAI_DEFINITION);
export const OpenAI = createProviderFactory(OPENAI_DEFINITION);

const reg = createRegisterFunction(OPENAI_DEFINITION, OpenAILlm);
export const registerOpenAI = reg.register;
export const isOpenAIRegistered = reg.isRegistered;
export const _resetOpenAIRegistration = reg._reset;
