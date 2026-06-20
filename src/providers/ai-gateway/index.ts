/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */
import { createProviderClass, createProviderFactory } from "../../core/create-provider.js";
import { createRegisterFunction } from "../../core/create-register.js";
import { AI_GATEWAY_DEFINITION } from "./definition.js";

export { AI_GATEWAY_DEFINITION } from "./definition.js";

export const AIGatewayLlm = createProviderClass(AI_GATEWAY_DEFINITION);
export const AIGateway = createProviderFactory(AI_GATEWAY_DEFINITION);

const reg = createRegisterFunction(AI_GATEWAY_DEFINITION, AIGatewayLlm);
export const registerAIGateway = reg.register;
export const isAIGatewayRegistered = reg.isRegistered;
export const _resetAIGatewayRegistration = reg._reset;
