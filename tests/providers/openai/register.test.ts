import {
  _resetOpenAIRegistration,
  isOpenAIRegistered,
  registerOpenAI,
} from "../../../src/providers/openai/index.js";
import { describeProviderRegistration } from "../../helpers/provider-test-helpers.js";

describeProviderRegistration({
  name: "OpenAI",
  configKey: "openai",
  register: registerOpenAI,
  isRegistered: isOpenAIRegistered,
  reset: _resetOpenAIRegistration,
  configProps: [
    ["apiKey", "my-openai-key"],
    ["organization", "org-xxx"],
    ["project", "proj-xxx"],
  ],
});
