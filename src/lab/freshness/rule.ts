// The time rules of a shared-connect 0.1 link and its proposal, as three
// small functions. All times in seconds.

/** a code shown in person lives at most this long */
export const CODE_MAX = 600
/** a link sent in a message lives at most this long (seven days) */
export const LINK_MAX = 7 * 86400
/** how far two clocks may differ */
export const TOLERANCE = 60

/** an enactment that is not complete is kept this long after its link expired (thirty days) */
export const KEPT = 30 * 86400

/** How long a link lives from the moment it is shown, in whole seconds: the stated minutes, rounded to the second, at least
 *  a minute, at most the cap of the channel. Without a stated lifetime: ten minutes, whatever the channel. */
export const lifetime = (channel: 'displayed' | 'sent', minutes = 10): number => Math.min(Math.max(60, Math.round(minutes * 60)), channel === 'displayed' ? CODE_MAX : LINK_MAX)

/** A side keeps an enactment that is not complete until thirty days after the link expired. While it is kept the inviter's
 *  person can decide, and the documents of the enactment are taken; once the side's upkeep has run after that moment the
 *  enactment is gone, with the open question, and a document that arrives then finds nothing. Not so an enactment
 *  that opened a contact from a code (`../offline/OFFLINE.md`, X5): it is kept, with its contact, whatever time passes. */
export const kept = (now: number, exp: number): boolean => now < exp + TOLERANCE + KEPT

/** The responder reads the link and proposes only before the link's expiry, by its own clock, without tolerance. */
export const mayPropose = (now: number, exp: number): boolean => now < exp

/** What the inviter does with a proposal that reaches it at `now`, issued at `issuedAt`, on a link that expires at `exp`. */
export function proposal (issuedAt: number, now: number, exp: number): 'taken' | 'not-fresh' | 'expired-link' {
  if (now - issuedAt < -TOLERANCE) return 'not-fresh'       // issued in the future, by more than the clocks may differ
  if (now >= exp + TOLERANCE) return 'expired-link'         // the proposal has no age limit of its own: the link's expiry bounds it
  return 'taken'
}
