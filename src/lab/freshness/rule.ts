// The time rules of a shared-connect 0.1 link and its proposal, as three
// small functions. All times in seconds.

/** a code shown in person lives at most this long */
export const CODE_MAX = 600
/** a link sent in a message lives at most this long (seven days) */
export const LINK_MAX = 7 * 86400
/** how far two clocks may differ */
export const TOLERANCE = 60

/** How long a link lives from the moment it is shown. Without a stated lifetime: ten minutes, whatever the channel. */
export const lifetime = (channel: 'displayed' | 'sent', minutes = 10): number => Math.min(minutes * 60, channel === 'displayed' ? CODE_MAX : LINK_MAX)

/** The responder reads the link and proposes only before the link's expiry, by its own clock, without tolerance. */
export const mayPropose = (now: number, exp: number): boolean => now < exp

/** What the inviter does with a proposal that reaches it at `now`, issued at `issuedAt`, on a link that expires at `exp`. */
export function proposal (issuedAt: number, now: number, exp: number): 'taken' | 'not-fresh' | 'expired-link' {
  const age = now - issuedAt
  if (age <= -TOLERANCE) return 'not-fresh'                 // issued in the future, by more than the clocks may differ
  if (age >= CODE_MAX + TOLERANCE) return 'not-fresh'       // older than ten minutes
  if (now >= exp + TOLERANCE) return 'expired-link'
  return 'taken'
}
