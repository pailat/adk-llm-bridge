import {
  _resetAnthropicRegistration,
  isAnthropicRegistered,
  registerAnthropic,
} from "../../../src/providers/anthropic";
import { describeProviderRegistration } from "../../helpers/provider-test-helpers";

describeProviderRegistration({
  name: "Anthropic",
  configKey: "anthropic",
  register: registerAnthropic,
  isRegistered: isAnthropicRegistered,
  reset: _resetAnthropicRegistration,
  configProps: [
    ["apiKey", "my-anthropic-key"],
    ["maxTokens", 8192],
  ],
});
