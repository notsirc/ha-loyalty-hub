// §11.5: nearby cards, computed in the browser. The position is requested at most once when the
// panel opens and never leaves the browser (only the explicit "I'm in this shop now" button sends it).
import type { Card, HomeAssistant, UserPrefs } from "./types";

export interface Position { lat: number; lon: number }

/** Distance from a saved shop location that counts as "nearby". */
export const LOCATION_RADIUS_M = 250;
/** Margin added to the radius of a HA zone. */
export const ZONE_MARGIN_M = 50;

const EARTH_RADIUS_M = 6371008.8;

/** Great-circle distance in meters. */
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** True if the card has saved locations or linked zones. */
export const hasPlaces = (card: Card) => !!(card.locations?.length || card.zones?.length);

export function isNearby(card: Card, pos: Position | null | undefined, hass?: HomeAssistant): boolean {
  if (!pos) return false;
  for (const l of card.locations ?? []) {
    const lat = num(l?.lat);
    const lon = num(l?.lon);
    if (lat !== null && lon !== null && haversine(pos.lat, pos.lon, lat, lon) <= LOCATION_RADIUS_M) return true;
  }
  for (const z of card.zones ?? []) {
    const attrs = hass?.states?.[z]?.attributes;
    if (!attrs) continue;
    const lat = num(attrs.latitude);
    const lon = num(attrs.longitude);
    if (lat === null || lon === null) continue;
    const radius = Math.max(0, num(attrs.radius) ?? 100);
    if (haversine(pos.lat, pos.lon, lat, lon) <= radius + ZONE_MARGIN_M) return true;
  }
  return false;
}

/** Conditions of §11.5 that do not need the browser permission state. */
export function shouldRequestPosition(prefs: UserPrefs | null | undefined, cards: Card[]): boolean {
  if (!prefs || prefs.nearby === false) return false;
  if (typeof window === "undefined" || !window.isSecureContext) return false;
  if (typeof navigator === "undefined" || !navigator.geolocation) return false;
  return cards.some(hasPlaces);
}

async function permissionDenied(): Promise<boolean> {
  try {
    const status = await navigator.permissions?.query({ name: "geolocation" as PermissionName });
    return status?.state === "denied";
  } catch {
    return false;
  }
}

/**
 * One low-accuracy position request. Resolves to null on any error, denial or timeout (silently:
 * the list just keeps its normal order).
 */
export async function requestPosition(): Promise<Position | null> {
  if (!window.isSecureContext || !navigator.geolocation) return null;
  if (await permissionDenied()) return null;
  return new Promise((resolve) => {
    try {
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 },
      );
    } catch {
      resolve(null);
    }
  });
}
