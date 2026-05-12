import snmp from "net-snmp";

export type SnmpProbe = {
  ok: boolean;
  sysName?: string;
  sysDescr?: string;
  sysObjectId?: string;
  uptimeSeconds?: number;
};

/** Live SNMP transport settings + async community resolver (secrets may be sealed). */
export type SnmpLiveContext = {
  port: number;
  retries: number;
  defaultTimeoutMs: number;
  versionLabel: string;
  getCommunities: () => Promise<string[]>;
};

const uptimeOidProfiles: Array<{ oid: string; multiplier: number }> = [
  { oid: "1.3.6.1.2.1.1.3.0", multiplier: 0.01 },
  { oid: "1.3.6.1.2.1.25.1.1.0", multiplier: 0.01 },
];

function parseSnmpTimeTicksSeconds(value: unknown, multiplier = 0.01): number {
  const rawText = String(value ?? "").trim();
  const rawNumber =
    typeof value === "number"
      ? value
      : Number(rawText.match(/\((\d+)\)/)?.[1] ?? rawText.replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(rawNumber) || rawNumber <= 0) return 0;
  return Math.max(0, Math.floor(rawNumber * multiplier));
}

function snmpVersionsFromLabel(versionLabel: string): snmp.Version[] {
  const preferred = versionLabel.includes("v1") ? snmp.Version1 : snmp.Version2c;
  const fallback = preferred === snmp.Version1 ? snmp.Version2c : snmp.Version1;
  return [preferred, fallback];
}

export function getSnmpProbeFor(ctx: SnmpLiveContext, host: string, timeout = ctx.defaultTimeoutMs): Promise<SnmpProbe> {
  return (async () => {
    const communities = await ctx.getCommunities();
    return await new Promise<SnmpProbe>((resolve) => {
      const oids = [
        "1.3.6.1.2.1.1.5.0",
        "1.3.6.1.2.1.1.1.0",
        "1.3.6.1.2.1.1.2.0",
        ...uptimeOidProfiles.map((p) => p.oid),
      ];
      const baseOids = ["1.3.6.1.2.1.1.5.0", "1.3.6.1.2.1.1.1.0", "1.3.6.1.2.1.1.2.0"];
      const versions = snmpVersionsFromLabel(ctx.versionLabel);
      let idx = 0;
      let versionIdx = 0;
      const fallbackProbeSingle = (community: string, version: snmp.Version) => {
        const session = snmp.createSession(host, community, {
          timeout: Math.max(timeout, 1200),
          retries: Math.max(ctx.retries, 0),
          version,
          port: ctx.port,
        });
        const readOne = (oid: string) =>
          new Promise<string>((r) => {
            session.get([oid], (e, vars) => {
              if (e || !vars?.length) return r("");
              const value = vars[0]?.value;
              r(value === undefined || value === null ? "" : String(value));
            });
          });
        void (async () => {
          try {
            const sysName = await readOne(baseOids[0]);
            const sysDescr = await readOne(baseOids[1]);
            const sysObjectId = await readOne(baseOids[2]);
            let uptimeSeconds = 0;
            for (const profile of uptimeOidProfiles) {
              uptimeSeconds ||= parseSnmpTimeTicksSeconds(await readOne(profile.oid), profile.multiplier);
            }
            if (sysName || sysDescr || sysObjectId) {
              return resolve({ ok: true, sysName, sysDescr, sysObjectId, uptimeSeconds });
            }
            return tryNext();
          } catch {
            return tryNext();
          } finally {
            try {
              session.close();
            } catch {
              /* ignore */
            }
          }
        })();
      };
      const tryNext = () => {
        if (versionIdx >= versions.length) return resolve({ ok: false });
        if (idx >= communities.length) {
          idx = 0;
          versionIdx++;
          return tryNext();
        }
        const community = communities[idx++];
        const session = snmp.createSession(host, community, {
          timeout,
          retries: ctx.retries,
          version: versions[versionIdx],
          port: ctx.port,
        });
        session.get(oids, (err, varbinds) => {
          try {
            session.close();
          } catch {
            /* ignore */
          }
          if (err || !varbinds?.length) {
            const errMsg = String((err as { message?: string } | null)?.message || "").toLowerCase();
            const isTimeout = errMsg.includes("timeout");
            if (isTimeout || !err) return tryNext();
            return fallbackProbeSingle(community, versions[versionIdx]);
          }
          const sysName = varbinds[0]?.value ? String(varbinds[0].value) : "";
          const sysDescr = varbinds[1]?.value ? String(varbinds[1].value) : "";
          const sysObjectId = varbinds[2]?.value ? String(varbinds[2].value) : "";
          let uptimeSeconds = 0;
          uptimeOidProfiles.forEach((profile, i) => {
            uptimeSeconds ||= parseSnmpTimeTicksSeconds(varbinds[3 + i]?.value, profile.multiplier);
          });
          return resolve({ ok: true, sysName, sysDescr, sysObjectId, uptimeSeconds });
        });
      };
      tryNext();
    });
  })();
}

export function snmpGetMapFor(
  ctx: SnmpLiveContext,
  host: string,
  oids: string[],
  timeout = ctx.defaultTimeoutMs
): Promise<Record<string, number | string>> {
  return (async () => {
    const communities = await ctx.getCommunities();
    return await new Promise<Record<string, number | string>>((resolve) => {
      const versions = snmpVersionsFromLabel(ctx.versionLabel);
      let idx = 0;
      let versionIdx = 0;
      const tryNext = () => {
        if (versionIdx >= versions.length) return resolve({});
        if (idx >= communities.length) {
          idx = 0;
          versionIdx++;
          return tryNext();
        }
        const session = snmp.createSession(host, communities[idx++], {
          timeout,
          retries: ctx.retries,
          version: versions[versionIdx],
          port: ctx.port,
        });
        session.get(oids, (err, vars) => {
          try {
            session.close();
          } catch {
            /* ignore */
          }
          if (err || !vars?.length) return tryNext();
          const out: Record<string, number | string> = {};
          vars.forEach((v, i) => {
            const raw = v?.value;
            out[oids[i]] = typeof raw === "number" ? raw : String(raw ?? "");
          });
          resolve(out);
        });
      };
      tryNext();
    });
  })();
}

export function snmpWalkFor(
  ctx: SnmpLiveContext,
  host: string,
  baseOid: string,
  timeout = ctx.defaultTimeoutMs
): Promise<Record<string, string>> {
  return (async () => {
    const communities = await ctx.getCommunities();
    return await new Promise<Record<string, string>>((resolve) => {
      const versions = snmpVersionsFromLabel(ctx.versionLabel);
      let idx = 0;
      let versionIdx = 0;
      const tryNext = () => {
        if (versionIdx >= versions.length) return resolve({});
        if (idx >= communities.length) {
          idx = 0;
          versionIdx++;
          return tryNext();
        }
        const session = snmp.createSession(host, communities[idx++], {
          timeout,
          retries: ctx.retries,
          version: versions[versionIdx],
          port: ctx.port,
        });
        const out: Record<string, string> = {};
        session.subtree(
          baseOid,
          (varbinds) => {
            for (const vb of varbinds) {
              const suffix = vb.oid.startsWith(`${baseOid}.`) ? vb.oid.slice(baseOid.length + 1) : vb.oid;
              out[suffix] = String(vb.value ?? "");
            }
          },
          (err) => {
            try {
              session.close();
            } catch {
              /* ignore */
            }
            if (err) return tryNext();
            resolve(out);
          }
        );
      };
      tryNext();
    });
  })();
}
