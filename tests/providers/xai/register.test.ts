import {
  _resetXAIRegistration,
  isXAIRegistered,
  registerXAI,
} from "../../../src/providers/xai";
import { describeProviderRegistration } from "../../helpers/provider-test-helpers";

describeProviderRegistration({
  name: "XAI",
  configKey: "xai",
  register: registerXAI,
  isRegistered: isXAIRegistered,
  reset: _resetXAIRegistration,
  configProps: [["apiKey", "my-xai-key"]],
});
