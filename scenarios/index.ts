import type { Scenario } from "../src/core/types.js";
import { argumentScopingScenarios } from "./argument-scoping.js";
import { basicsScenarios } from "./basics.js";

export const allScenarios: Scenario[] = [...basicsScenarios, ...argumentScopingScenarios];
