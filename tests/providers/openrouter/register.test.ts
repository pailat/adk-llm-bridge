import {
  _resetOpenRouterRegistration,
  isOpenRouterRegistered,
  registerOpenRouter,
} from "../../../src/providers/openrouter";
import { describeProviderRegistration } from "../../helpers/provider-test-helpers";

describeProviderRegistration({
  name: "OpenRouter",
  configKey: "openrouter",
  register: registerOpenRouter,
  isRegistered: isOpenRouterRegistered,
  reset: _resetOpenRouterRegistration,
  configProps: [
    ["baseURL", "https://custom.openrouter.com/v1"],
    ["apiKey", "my-openrouter-key"],
    ["siteUrl", "https://myapp.com"],
    ["appName", "My App"],
  ],
});
