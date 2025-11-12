import { describe, it, expect, beforeEach } from "vitest";
import { ClarityType } from "@stacks/transactions";

interface ResponderLocation {
  lat: bigint;
  long: bigint;
  verified: boolean;
  "last-updated": bigint;
}

interface AlertRouting {
  "alert-id": bigint;
  "routed-to": string | null;
  distance: bigint;
  timestamp: bigint;
  "attempt-count": bigint;
  "search-radius": bigint;
}

const ERR_NOT_FOUND = 100n;
const ERR_UNAUTHORIZED = 101n;
const ERR_ALERT_CLOSED = 102n;
const ERR_INVALID_LOCATION = 103n;
const ERR_NO_RESPONDERS = 104n;
const ERR_RESPONDER_NOT_VERIFIED = 105n;
const ERR_DISTANCE_CALC_FAIL = 106n;
const ERR_REGISTRY_NOT_SET = 107n;
const ERR_ALREADY_ROUTED = 108n;
const ERR_INVALID_RADIUS = 109n;
const ERR_MAX_ROUTING_ATTEMPTS = 110n;

const DEFAULT_SEARCH_RADIUS = 50000n;
const MAX_ROUTING_ATTEMPTS = 5n;

class RoutingContractMock {
  private storage: Map<string, any> = new Map();
  private registryContract: string = "SP000000000000000000002Q6VF78";
  private verifiedResponders: string[] = [];
  private blockHeight: bigint = 100n;

  constructor() {
    this.reset();
  }

  reset() {
    this.storage.clear();
    this.registryContract = "SP000000000000000000002Q6VF78";
    this.verifiedResponders = [];
    this.blockHeight = 100n;
  }

  private setMap(mapName: string, key: string, value: any) {
    this.storage.set(`${mapName}:${key}`, value);
  }

  private getMap(mapName: string, key: string): any | undefined {
    return this.storage.get(`${mapName}:${key}`);
  }

  setRegistryContract(caller: string, newRegistry: string): { ok: boolean; value: boolean } {
    if (caller !== this.registryContract) return { ok: false, value: false };
    this.registryContract = newRegistry;
    return { ok: true, value: true };
  }

  registerResponderLocation(caller: string, lat: bigint, long: bigint): { ok: boolean; value: boolean } {
    if (lat < -900000000n || lat > 900000000n) return { ok: false, value: false };
    if (long < -1800000000n || long > 1800000000n) return { ok: false, value: false };
    const key = caller;
    const existing: any = this.getMap("responder-locations", key);
    const verified = existing ? existing.verified : false;
    this.setMap("responder-locations", key, {
      lat: lat,
      long: long,
      verified: verified,
      "last-updated": this.blockHeight
    });
    return { ok: true, value: true };
  }

  verifyResponder(caller: string, responder: string): { ok: boolean; value: boolean } {
    if (caller !== this.registryContract) return { ok: false, value: false };
    const data = this.getMap("responder-locations", responder);
    if (!data) return { ok: false, value: false };
    const verified = data.verified;
    if (!verified) {
      this.verifiedResponders.push(responder);
    }
    this.setMap("responder-locations", responder, {
      lat: data.lat,
      long: data.long,
      verified: true,
      "last-updated": data["last-updated"]
    });
    return { ok: true, value: true };
  }

  haversineDistance(lat1: bigint, long1: bigint, lat2: bigint, long2: bigint): { ok: boolean; value: bigint } {
    const l1 = Number(lat1) / 1e7;
    const lo1 = Number(long1) / 1e7;
    const l2 = Number(lat2) / 1e7;
    const lo2 = Number(long2) / 1e7;
    const dlat = (l2 - l1) * Math.PI / 180;
    const dlon = (lo2 - lo1) * Math.PI / 180;
    const a = Math.sin(dlat / 2)**2 + Math.cos(l1 * Math.PI / 180) * Math.cos(l2 * Math.PI / 180) * Math.sin(dlon / 2)**2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const dist = 6371e3 * c;
    return { ok: true, value: BigInt(Math.round(dist)) };
  }

  routeAlertToNearest(
    caller: string,
    alertId: bigint,
    alertLat: bigint,
    alertLong: bigint,
    initialRadius: bigint
  ): { ok: boolean; value: string | bigint } {
    if (initialRadius < 0n) return { ok: false, value: ERR_INVALID_RADIUS };
    const alertKey = alertId.toString();
    const existing = this.getMap("alerts-routing", alertKey);
    if (this.registryContract === "SP000000000000000000002Q6VF78") return { ok: false, value: ERR_REGISTRY_NOT_SET };
    if (existing && existing["routed-to"]) return { ok: false, value: ERR_ALREADY_ROUTED };
    const attemptCount = existing ? existing["attempt-count"] : 0n;
    if (attemptCount >= MAX_ROUTING_ATTEMPTS) return { ok: false, value: ERR_MAX_ROUTING_ATTEMPTS };
    let searchRadius: bigint;
    if (initialRadius > 0n) {
      searchRadius = initialRadius;
    } else {
      searchRadius = existing ? existing["search-radius"] : DEFAULT_SEARCH_RADIUS;
    }
    if (searchRadius <= 0n) return { ok: false, value: ERR_INVALID_RADIUS };
    if (alertLat < -900000000n || alertLat > 900000000n) return { ok: false, value: ERR_INVALID_LOCATION };
    if (alertLong < -1800000000n || alertLong > 1800000000n) return { ok: false, value: ERR_INVALID_LOCATION };
    const responders = this.getVerifiedRespondersInRadius(alertLat, alertLong, searchRadius);
    const nearest = this.findNearest(alertLat, alertLong, responders);
    if (nearest.responder) {
      this.setMap("alerts-routing", alertKey, {
        "alert-id": alertId,
        "routed-to": nearest.responder,
        distance: nearest.distance,
        timestamp: this.blockHeight,
        "attempt-count": 0n,
        "search-radius": searchRadius
      });
      return { ok: true, value: nearest.responder };
    } else {
      this.setMap("alerts-routing", alertKey, {
        "alert-id": alertId,
        "routed-to": null,
        distance: 0n,
        timestamp: this.blockHeight,
        "attempt-count": attemptCount + 1n,
        "search-radius": searchRadius * 2n
      });
      return { ok: false, value: ERR_NO_RESPONDERS };
    }
  }

  private getVerifiedRespondersInRadius(centerLat: bigint, centerLong: bigint, radius: bigint): string[] {
    const result: string[] = [];
    for (const responder of this.verifiedResponders) {
      const data = this.getMap("responder-locations", responder);
      if (data) {
        const dist = this.haversineDistance(centerLat, centerLong, data.lat, data.long).value;
        if (dist <= radius) {
          result.push(responder);
        }
      }
    }
    return result;
  }

  private findNearest(alertLat: bigint, alertLong: bigint, responders: string[]): { responder: string | null; distance: bigint } {
    let best: { responder: string | null; distance: bigint } = { responder: null, distance: 999999999n };
    for (const r of responders) {
      const data = this.getMap("responder-locations", r);
      if (data) {
        const dist = this.haversineDistance(alertLat, alertLong, data.lat, data.long).value;
        if (dist < best.distance) {
          best = { responder: r, distance: dist };
        }
      }
    }
    return best;
  }

  getAlertRouting(alertId: bigint): AlertRouting | null {
    const data = this.getMap("alerts-routing", alertId.toString());
    if (!data) return null;
    return data;
  }

  resetRoutingForAlert(alertId: bigint): { ok: boolean; value: boolean } {
    const key = `alerts-routing:${alertId.toString()}`;
    if (!this.storage.has(key)) return { ok: false, value: false };
    this.storage.delete(key);
    return { ok: true, value: true };
  }

  setBlockHeight(height: bigint) {
    this.blockHeight = height;
  }
}

describe("RoutingContract", () => {
  let contract: RoutingContractMock;
  let caller: string;
  let responder1: string;
  let responder2: string;
  let responder3: string;

  beforeEach(() => {
    contract = new RoutingContractMock();
    contract.reset();
    caller = "ST1CALLER";
    responder1 = "ST1RESPONDER1";
    responder2 = "ST1RESPONDER2";
    responder3 = "ST1RESPONDER3";
    contract.setRegistryContract("SP000000000000000000002Q6VF78", "ST1REGISTRY");
  });

  it("registers responder location correctly", () => {
    const result = contract.registerResponderLocation(responder1, 407123456n, -740123456n);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    const loc = contract.getMap("responder-locations", responder1);
    expect(loc).toBeDefined();
    expect(loc.lat).toBe(407123456n);
    expect(loc.long).toBe(-740123456n);
  });

  it("verifies responder only by registry", () => {
    contract.registerResponderLocation(responder1, 400000000n, -740000000n);
    const result1 = contract.verifyResponder("ST1FAKE", responder1);
    expect(result1.ok).toBe(false);
    const result2 = contract.verifyResponder("ST1REGISTRY", responder1);
    expect(result2.ok).toBe(true);
    const loc = contract.getMap("responder-locations", responder1);
    expect(loc.verified).toBe(true);
  });

  it("routes to nearest verified responder within radius", () => {
    contract.registerResponderLocation(responder1, 400000000n, -740000000n);
    contract.registerResponderLocation(responder2, 400200000n, -739800000n);
    contract.verifyResponder("ST1REGISTRY", responder1);
    contract.verifyResponder("ST1REGISTRY", responder2);

    const result = contract.routeAlertToNearest(caller, 1n, 400100000n, -739900000n, 100000n);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(responder1);
    const routing = contract.getAlertRouting(1n);
    expect(routing).not.toBeNull();
    expect(routing["routed-to"]).toBe(responder1);
  });

  it("expands search radius on failure and retries", () => {
    contract.registerResponderLocation(responder1, 500000000n, -750000000n);
    contract.verifyResponder("ST1REGISTRY", responder1);

    const result1 = contract.routeAlertToNearest(caller, 2n, 400000000n, -740000000n, 50000n);
    expect(result1.ok).toBe(false);
    expect(result1.value).toBe(ERR_NO_RESPONDERS);
    const routing1 = contract.getAlertRouting(2n);
    expect(routing1["attempt-count"]).toBe(1n);
    expect(routing1["search-radius"]).toBe(100000n);

    contract.registerResponderLocation(responder2, 400300000n, -740000000n);
    contract.verifyResponder("ST1REGISTRY", responder2);

    const result2 = contract.routeAlertToNearest(caller, 2n, 400000000n, -740000000n, 0n);
    expect(result2.ok).toBe(true);
    expect(result2.value).toBe(responder2);
  });

  it("fails after max routing attempts", () => {
    for (let i = 0; i < 6; i++) {
      const result = contract.routeAlertToNearest(caller, 3n, 300000000n, -700000000n, 10000n);
      expect(result.ok).toBe(false);
      if (i < 5) {
        expect(result.value).toBe(ERR_NO_RESPONDERS);
      } else {
        expect(result.value).toBe(ERR_MAX_ROUTING_ATTEMPTS);
      }
    }
    const routing = contract.getAlertRouting(3n);
    expect(routing["attempt-count"]).toBe(5n);
  });

  it("rejects invalid latitude and longitude", () => {
    const result1 = contract.registerResponderLocation(responder1, 1000000000n, -740000000n);
    expect(result1.ok).toBe(false);
    const result2 = contract.registerResponderLocation(responder1, 400000000n, -2000000000n);
    expect(result2.ok).toBe(false);
  });

  it("prevents routing if already routed", () => {
    contract.registerResponderLocation(responder1, 400000000n, -740000000n);
    contract.verifyResponder("ST1REGISTRY", responder1);
    contract.routeAlertToNearest(caller, 4n, 400000000n, -740000000n, 100000n);
    const result = contract.routeAlertToNearest(caller, 4n, 400000000n, -740000000n, 100000n);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_ALREADY_ROUTED);
  });

  it("resets routing for alert", () => {
    contract.registerResponderLocation(responder1, 400000000n, -740000000n);
    contract.verifyResponder("ST1REGISTRY", responder1);
    contract.routeAlertToNearest(caller, 5n, 400000000n, -740000000n, 100000n);
    const reset = contract.resetRoutingForAlert(5n);
    expect(reset.ok).toBe(true);
    expect(contract.getAlertRouting(5n)).toBeNull();
  });

  it("handles haversine edge cases", () => {
    const dist = contract.haversineDistance(0n, 0n, 0n, 0n);
    expect(dist.ok).toBe(true);
    expect(dist.value).toBe(0n);
  });

  it("routes to closest of multiple verified responders", () => {
    contract.registerResponderLocation(responder1, 400000000n, -740000000n);
    contract.registerResponderLocation(responder2, 420000000n, -720000000n);
    contract.registerResponderLocation(responder3, 405000000n, -735000000n);
    contract.verifyResponder("ST1REGISTRY", responder1);
    contract.verifyResponder("ST1REGISTRY", responder2);
    contract.verifyResponder("ST1REGISTRY", responder3);

    const result = contract.routeAlertToNearest(caller, 6n, 406000000n, -736000000n, 200000n);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(responder3);
  });

  it("ignores unverified responders", () => {
    contract.registerResponderLocation(responder1, 400000000n, -740000000n);
    contract.registerResponderLocation(responder2, 410000000n, -730000000n);
    contract.verifyResponder("ST1REGISTRY", responder1);

    const result = contract.routeAlertToNearest(caller, 7n, 405000000n, -735000000n, 100000n);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(responder1);
  });

  it("uses default radius when initial is zero", () => {
    contract.registerResponderLocation(responder1, 400000000n, -740000000n);
    contract.verifyResponder("ST1REGISTRY", responder1);
    const result = contract.routeAlertToNearest(caller, 8n, 400000000n, -740000000n, 0n);
    expect(result.ok).toBe(true);
    const routing = contract.getAlertRouting(8n);
    expect(routing["search-radius"]).toBe(DEFAULT_SEARCH_RADIUS);
  });

  it("rejects invalid search radius", () => {
    const result = contract.routeAlertToNearest(caller, 9n, 400000000n, -740000000n, -1000n);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_RADIUS);
  });

  it("handles block height in timestamp", () => {
    contract.setBlockHeight(200n);
    contract.registerResponderLocation(responder1, 400000000n, -740000000n);
    contract.verifyResponder("ST1REGISTRY", responder1);
    contract.routeAlertToNearest(caller, 10n, 400000000n, -740000000n, 100000n);
    const routing = contract.getAlertRouting(10n);
    expect(routing.timestamp).toBe(200n);
  });

  it("correctly computes multiple routing attempts with expanding radius", () => {
    contract.registerResponderLocation(responder1, 450000000n, -700000000n);
    contract.verifyResponder("ST1REGISTRY", responder1);

    for (let i = 0; i < 3; i++) {
      const result = contract.routeAlertToNearest(caller, 11n, 400000000n, -740000000n, 0n);
      expect(result.ok).toBe(false);
      expect(result.value).toBe(ERR_NO_RESPONDERS);
    }
    const routing = contract.getAlertRouting(11n);
    expect(routing["attempt-count"]).toBe(3n);
    expect(routing["search-radius"]).toBe(400000n);
  });
});