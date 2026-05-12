export type TopologyLink = {
  id?: string;
  source: string;
  target: string;
  portA: string;
  portB: string;
  manual?: boolean;
  renamed?: boolean;
};

export type TopologyMode = "ip" | "fc";

export type TopologyLayout = Record<string, { x: number; y: number }>;

export type TopologyZoneLabelOverrides = Record<string, string>;

export type TopologySnapshot = {
  id: string;
  createdAt: string;
  actor: string;
  reason: string;
  branch?: string;
  links: TopologyLink[];
  layout: TopologyLayout;
  layoutScopes?: Record<TopologyMode, Record<string, TopologyLayout>>;
  zoneLabelOverridesScopes?: Record<TopologyMode, Record<string, TopologyZoneLabelOverrides>>;
};
