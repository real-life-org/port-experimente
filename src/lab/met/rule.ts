// "Met" for a contact that came about by shared-connect 0.1: the rule as a
// small model. Each side states in its credential how the link reached it,
// the channel; from the two channels each side derives on its own whether
// the two met, and only a contact that met can be trusted.

/** how the link reached this side: `displayed` it showed the code in person, `scan` its camera read a code;
 *  `sent` it sent the link in a message, `link` it opened a link it was sent */
export type Channel = 'scan' | 'displayed' | 'link' | 'sent'
export const CHANNELS: readonly Channel[] = ['scan', 'displayed', 'link', 'sent']
/** a code shown and read in one place, as far as this side can tell */
export const inPerson = (c: Channel): boolean => c === 'scan' || c === 'displayed'

/** One enactment, seen from one side. `theirs`: the channel the counterpart's credential states; null where it
 *  states none (a party of another app). The own channel is what this device observed; the counterpart's is its
 *  report and adds no evidence, so it can only take "met" away. */
export const metInEnactment = (own: Channel, theirs: Channel | null): boolean => inPerson(own) && (theirs === null || inPerson(theirs))

/** where a tuple of a contact came from */
export type Origin = { enactment: { own: Channel, theirs: Channel | null } } | 'encounter' | 'introduction'
/** A contact met when any of its tuples came from an encounter, an introduction, or an enactment that met. */
export const contactMet = (tuples: Origin[]): boolean => tuples.some((t) => (typeof t === 'string' ? true : metInEnactment(t.enactment.own, t.enactment.theirs)))
/** the trust act (the anchor mapping switched on) is refused toward a contact that did not meet */
export const mayTrust = (tuples: Origin[]): boolean => contactMet(tuples)

/** The four enactments two honest parties of this protocol can have: who shows and how, who reads and how. */
export const HONEST: ReadonlyArray<{ inviter: 'displayed' | 'sent', responder: 'scan' | 'link' }> = [
  { inviter: 'displayed', responder: 'scan' }, { inviter: 'displayed', responder: 'link' },
  { inviter: 'sent', responder: 'scan' }, { inviter: 'sent', responder: 'link' },
]
