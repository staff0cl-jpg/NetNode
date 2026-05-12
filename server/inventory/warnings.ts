const parseNumberEnv = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const INVENTORY_WARNING_RULES = {
  cpuHighThreshold: parseNumberEnv(process.env.WARNING_CPU_HIGH_THRESHOLD, 85),
  trunkDownWarnCount: parseNumberEnv(process.env.WARNING_TRUNK_DOWN_COUNT, 1),
  cpuWarnScore: 40,
  trunkWarnScore: 30,
  offlineCriticalScore: 100,
};

export type InventoryWarningAssessment = {
  severity: "none" | "warning" | "critical";
  score: number;
  reasons: string[];
  reasonDetails: InventoryWarningReasonDetail[];
};

export type InventoryWarningReasonCode = "device_unreachable" | "high_cpu_load" | "down_trunk_ports";

export type InventoryWarningReasonDetail = {
  code: InventoryWarningReasonCode;
  params?: Record<string, number | string>;
};

export function evaluateInventoryWarnings(input: {
  isReachable: boolean;
  cpuLoad: number | null;
  trunkDownCount: number;
}): InventoryWarningAssessment {
  if (!input.isReachable) {
    return {
      severity: "critical",
      score: INVENTORY_WARNING_RULES.offlineCriticalScore,
      reasons: ["device_unreachable"],
      reasonDetails: [{ code: "device_unreachable" }],
    };
  }

  const reasons: string[] = [];
  const reasonDetails: InventoryWarningReasonDetail[] = [];
  let score = 0;

  if (Number.isFinite(input.cpuLoad) && Number(input.cpuLoad) >= INVENTORY_WARNING_RULES.cpuHighThreshold) {
    const roundedCpuLoad = Math.round(Number(input.cpuLoad));
    score += INVENTORY_WARNING_RULES.cpuWarnScore;
    reasons.push("high_cpu_load");
    reasonDetails.push({
      code: "high_cpu_load",
      params: {
        cpuLoad: roundedCpuLoad,
        threshold: INVENTORY_WARNING_RULES.cpuHighThreshold,
      },
    });
  }

  if (input.trunkDownCount >= INVENTORY_WARNING_RULES.trunkDownWarnCount) {
    score += INVENTORY_WARNING_RULES.trunkWarnScore;
    reasons.push("down_trunk_ports");
    reasonDetails.push({
      code: "down_trunk_ports",
      params: {
        count: input.trunkDownCount,
      },
    });
  }

  if (!reasons.length) {
    return {
      severity: "none",
      score: 0,
      reasons: [],
      reasonDetails: [],
    };
  }

  return {
    severity: "warning",
    score: Math.min(99, score),
    reasons,
    reasonDetails,
  };
}
