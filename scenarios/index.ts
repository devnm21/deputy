import type { Scenario } from "../src/core/types.js";
import { argumentScopingScenarios } from "./argument-scoping.js";
import { basicsScenarios } from "./basics.js";
import { delegationScenarios } from "./delegation.js";
import { escalationScenarios } from "./escalation.js";
import { parallelSiblingScenarios } from "./parallel-siblings.js";
import { policyAttachmentScenarios } from "./policy-attachment.js";

export const allScenarios: Scenario[] = [
	...basicsScenarios,
	...argumentScopingScenarios,
	...delegationScenarios,
	...escalationScenarios,
	...parallelSiblingScenarios,
	...policyAttachmentScenarios,
];
