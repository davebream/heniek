import { describeForgeBackendConformance } from "@heniek/conformance/vitest";
import { createRecordedGitHubForgeHarness } from "./recorded-service.js";

describeForgeBackendConformance(createRecordedGitHubForgeHarness());
