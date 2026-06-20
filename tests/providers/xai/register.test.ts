import {
  _resetXAIRegistration,
  isXAIRegistered,
  registerXAI,
} from "../../../src/providers/xai/index.js";
import { describeProviderRegistration } from "../../helpers/provider-test-helpers.js";

describeProviderRegistration({
  name: "XAI",
  configKey: "xai",
  register: registerXAI,
  isRegistered: isXAIRegistered,
  reset: _resetXAIRegistration,
  configProps: [["apiKey", "my-xai-key"]],
});
