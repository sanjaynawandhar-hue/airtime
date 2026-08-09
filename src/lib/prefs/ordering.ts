import type { DeepLink, PlatformId } from "@/lib/core/types";

/**
 * The subscription preference is the one that earns its keep.
 *
 * Once a user marks Netflix and Prime, every card reorders its platform buttons
 * so the service they can actually watch on comes first, and titles they would
 * have to pay again for are visually demoted — DEMOTED, not hidden. Hiding a
 * rentable title would be us deciding what they are allowed to see; demoting it
 * tells them the truth about the offer and lets them decide.
 */

/** Lower sorts first. */
function offerWeight(link: DeepLink, subscribed: ReadonlySet<string>): number {
  const isSubscribed = subscribed.has(link.platform);

  // Included in a subscription the user already pays for — the whole point.
  if (isSubscribed && (link.offerType === "subscription" || link.offerType === "free")) {
    return 0;
  }
  // Free to everyone, or ad-supported.
  if (link.offerType === "free") return 1;
  if (link.offerType === "ads") return 2;
  // On a service they don't have, but at least it's a subscription not a rental.
  if (link.offerType === "subscription") return 3;
  // A cinema ticket is a real, immediate option — above a rental.
  if (link.offerType === "ticket") return 4;
  if (link.offerType === "listen") return 4;
  // They would pay again for these.
  if (link.offerType === "rent") return 5;
  return 6; // buy
}

export function orderLinks(
  links: readonly DeepLink[],
  subscribedServices: readonly string[],
): readonly DeepLink[] {
  const subscribed = new Set(subscribedServices);
  return [...links].sort((a, b) => {
    const weightDiff = offerWeight(a, subscribed) - offerWeight(b, subscribed);
    if (weightDiff !== 0) return weightDiff;
    // Verified availability (from a licensed source) ahead of search fallbacks.
    if (a.verified !== b.verified) return a.verified ? -1 : 1;
    return a.platformName.localeCompare(b.platformName);
  });
}

/**
 * True when this offer costs the user money on top of what they already pay.
 * The card uses it to demote, and to label the button honestly — "trending on
 * Netflix" and "rent on Prime for ₹149" are not the same offer and users
 * notice when a product pretends they are.
 */
export function isExtraCost(
  link: DeepLink,
  subscribedServices: readonly string[],
): boolean {
  if (link.offerType === "rent" || link.offerType === "buy") return true;
  if (link.offerType === "subscription") {
    return !subscribedServices.includes(link.platform);
  }
  return false;
}

export const OFFER_LABEL: Record<DeepLink["offerType"], string> = {
  subscription: "Included",
  rent: "Rent",
  buy: "Buy",
  free: "Free",
  ads: "Free with ads",
  ticket: "Book tickets",
  listen: "Listen",
};

export const PLATFORM_NAME: Record<PlatformId, string> = {
  netflix: "Netflix",
  prime: "Prime Video",
  jiohotstar: "JioHotstar",
  sonyliv: "SonyLIV",
  zee5: "ZEE5",
  appletv: "Apple TV+",
  youtube: "YouTube",
  "apple-music": "Apple Music",
  spotify: "Spotify",
  deezer: "Deezer",
  gaana: "Gaana",
  bookmyshow: "BookMyShow",
  tmdb: "TMDB",
  imdb: "IMDb",
};
