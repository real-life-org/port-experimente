// Scenarios for the model of model.ts. Each returns plain facts; the rules
// under discussion are switched per variant so that the table shows what
// each rule buys. A measurement of the model, not of the library.
import { Carrier, RULES, change, device, headId, met, paths, receive, renew, send, share, takeOver, type Device, type Rules } from './model'

export type Row = Record<string, string | number | boolean>
const v = (r: Partial<Rules>): Rules => ({ ...RULES, ...r })
const settle = (c: Carrier, rules: Rules, devs: Device[], rounds = 6): void => { for (let i = 0; i < rounds; i++) for (const d of devs) receive(d, c, rules) }
const has = (d: Device, part: string): boolean => d.notices.some((n) => n.includes(part))
const reads = (d: Device, text: string): boolean => d.inbox.includes(text)

/** Phone and laptop of A are apart and both change the relationship's keys. */
function twoOwnDevices (rules: Rules): Row {
  const c = new Carrier(), [phone, laptop, b] = [device('phone'), device('laptop'), device('b')] as [Device, Device, Device]
  met([phone, laptop], [b], [phone, laptop], [b], rules)
  change(phone, rules, [phone, laptop]); change(laptop, rules, [phone, laptop])
  const same = headId(phone.own.log) === headId(laptop.own.log)
  send(phone, c, rules, 'message', 'from the phone'); send(laptop, c, rules, 'message', 'from the laptop')
  settle(c, rules, [b, phone, laptop])
  const before = reads(b, 'from the laptop')
  if (has(laptop, 'refused this device')) takeOver(phone, laptop, true)   // the loser gives up its continuation and takes the sibling's
  send(laptop, c, rules, 'message', 'again from the laptop'); settle(c, rules, [b, phone, laptop])
  return {
    'the two devices wrote the same entry': same,
    'the counterpart refused a continuation': b.peer.evidence.length > 0,
    'the counterpart shows a warning': has(b, 'second continuation'),
    'the laptop\'s first message arrived': before,
    'the laptop learned it lost': has(laptop, 'refused this device'),
    'after taking the phone\'s state the laptop is heard': reads(b, 'again from the laptop'),
  }
}

/** A lost device changes the keys before the owner does. */
function lostDeviceFirst (rules: Rules, tabletHolds: boolean): Row {
  const c = new Carrier(), [phone, tablet, b] = [device('phone'), device('tablet'), device('b')] as [Device, Device, Device]
  tablet.lost = true
  met([phone, tablet], [b], tabletHolds ? [phone, tablet] : [phone], [b])
  const could = change(tablet, rules, [tablet])
  if (could) { send(tablet, c, rules, 'message', 'from the lost device'); settle(c, rules, [b]) }
  change(phone, rules, [phone]); send(phone, c, rules, 'message', 'from the owner')
  settle(c, rules, [b, phone]); settle(c, rules, [tablet, b, phone])
  send(b, c, rules, 'message', 'for the owner'); settle(c, rules, [tablet, phone, b])
  return {
    'the lost device could change the keys': could,
    'the counterpart heard the lost device': reads(b, 'from the lost device'),
    'the counterpart heard the owner': reads(b, 'from the owner'),
    'the owner learned that its continuation was refused': has(phone, 'refused this device'),
    'the counterpart shows a warning': has(b, 'second continuation'),
    'the counterpart\'s next message is read by': reads(phone, 'for the owner') ? 'the owner' : reads(tablet, 'for the owner') ? 'the lost device' : 'nobody',
  }
}

/** A changed keys; B's phone acknowledged; B's laptop was offline. */
function counterpartsSecondDevice (rules: Rules, bSyncs: boolean): Row {
  const c = new Carrier(), [a, bPhone, bLaptop] = [device('a'), device('b-phone'), device('b-laptop')] as [Device, Device, Device]
  met([a], [bPhone, bLaptop], [a], [bPhone])
  const oldAddr = a.own.log[0]?.state.addr ?? ''
  change(a, rules, [a]); send(a, c, rules, 'message', 'one')
  settle(c, rules, [bPhone, a])
  if (bSyncs) share(bPhone, bLaptop, false)
  send(bLaptop, c, rules, 'message', 'from b\'s laptop'); settle(c, rules, [a])
  send(a, c, rules, 'message', 'two'); settle(c, rules, [bLaptop, a]); settle(c, rules, [bLaptop, a])
  send(a, c, rules, 'message', 'three'); settle(c, rules, [bLaptop, a])
  return {
    'b\'s laptop\'s message reached a': reads(a, 'from b\'s laptop'),
    'documents left at a\'s old address': c.waiting(oldAddr),
    'b\'s laptop read "two"': reads(bLaptop, 'two'),
    'b\'s laptop asked for the log': has(bLaptop, 'asked for it'),
    'b\'s laptop read "three"': reads(bLaptop, 'three'),
  }
}

/** B writes while A's change is on its way; a lost device holds the old receive key and address. */
function writtenDuringTheChange (rules: Rules, lostFetchesFirst: boolean): Row {
  const c = new Carrier(), [phone, tablet, b] = [device('phone'), device('tablet'), device('b')] as [Device, Device, Device]
  tablet.lost = true
  met([phone, tablet], [b], [phone], [b])
  change(phone, rules, [phone])
  send(b, c, rules, 'message', 'written before b knew')
  for (const d of lostFetchesFirst ? [tablet, phone] : [phone, tablet]) receive(d, c, rules)
  send(phone, c, rules, 'message', 'news'); settle(c, rules, [b, phone])
  send(b, c, rules, 'message', 'written after b knew'); settle(c, rules, [tablet, phone, b])
  const who = (t: string): string => (reads(phone, t) ? 'the owner' : reads(tablet, t) ? 'the lost device' : 'nobody')
  return {
    '"written before b knew" is read by': who('written before b knew'),
    '"written after b knew" is read by': who('written after b knew'),
    'the lost device can still fetch at an address the owner uses': paths(phone, rules).some((st) => tablet.own.addr.has(st.addr)),
  }
}

/** A answers a request of B after the change; A's laptop, not yet told, answers too. */
function answerAfterTheChange (rules: Rules): Row {
  const c = new Carrier(), [phone, laptop, b] = [device('phone'), device('laptop'), device('b')] as [Device, Device, Device]
  met([phone, laptop], [b], [phone], [b])
  send(b, c, rules, 'request', 'will you join'); settle(c, rules, [phone, b])
  change(phone, rules, [phone]); send(phone, c, rules, 'answer', 'yes, from the phone'); settle(c, rules, [b, phone])
  send(laptop, c, rules, 'answer', 'yes, from the laptop'); settle(c, rules, [b, laptop, phone])
  return {
    'the phone\'s answer under the new key is taken': reads(b, 'yes, from the phone'),
    'the laptop\'s answer under the old key is taken': reads(b, 'yes, from the laptop'),
    'the laptop is told its state is stale': has(laptop, 'state is stale'),
    'the laptop sees that the counterpart holds an entry it does not know': has(laptop, 'does not know'),
  }
}

/** Someone without any key sends an entry for a position the counterpart already holds. */
function forgedEntry (): Row {
  const c = new Carrier(), [a, b] = [device('a'), device('b')] as [Device, Device]
  met([a], [b], [a], [b])
  change(a, RULES, [a]); send(a, c, RULES, 'message', 'news'); settle(c, RULES, [b, a])
  const real = a.own.log[1]
  if (!real) throw new Error('no change')
  const st = b.peer.log[1]?.state
  if (!st) throw new Error('b did not take the change')
  c.put({ from: 'x', kind: 'message', text: 'x', sigKey: 'none', sig: '', entries: [{ ...real, id: 'forged', proof: real.proof }], sealedTo: b.own.log[0]?.state.enc ?? '', to: b.own.log[0]?.state.addr ?? '' })
  settle(c, RULES, [b, a])
  return { 'the counterpart keeps it as evidence': b.peer.evidence.length > 0, 'the counterpart shows the warning of a second continuation': has(b, 'second continuation'), 'the counterpart still follows a': headId(b.peer.log) === headId(a.own.log) && st.sig === real.state.sig }
}

/** The whole sequence: the phone changes keys while the laptop is offline,
 *  the counterpart acknowledges, the laptop comes back, the two sync in
 *  both directions. */
function siblingComesBack (rules: Rules): Row {
  const c = new Carrier(), [phone, laptop, b] = [device('phone'), device('laptop'), device('b')] as [Device, Device, Device]
  met([phone, laptop], [b], [phone, laptop], [b])
  const old = phone.own.log[0]?.state.addr ?? ''
  const uses = (d: Device): string => paths(d, rules).map((st) => (st.addr === old ? 'old' : 'new')).sort().join('+')
  change(phone, rules, [phone]); send(phone, c, rules, 'message', 'news')
  const beforeAck = uses(phone)
  settle(c, rules, [b, phone])
  const afterAck = uses(phone), length = phone.own.log.length
  share(laptop, phone, true)
  const afterOldSibling = uses(phone), kept = phone.own.log.length === length
  share(phone, laptop, true)
  return {
    'the phone uses, before the acknowledgement': beforeAck,
    'the phone uses, after the acknowledgement': afterAck,
    'syncing from the laptop leaves the phone\'s newer log as it is': kept,
    'the phone uses, after syncing from the older laptop': afterOldSibling,
    'the laptop uses, after syncing from the phone': uses(laptop),
    'both devices are at the same head': headId(laptop.own.log) === headId(phone.own.log),
    'the laptop still holds the old address as material': laptop.own.addr.has(old),
  }
}

/** With a change secret. The tablet is lost; the phone removes it: a new
 *  secret for the devices that stay, then one change of the relationship.
 *  `tablet` says what the lost device does, `laptop` what the sibling does. */
function removedWithASecret (tablet: 'locked' | 'changes first' | 'changes second', laptop: 'has the new secret' | 'offline, old secret' | 'removes the tablet too'): Row {
  const rules = v({ deterministic: true })
  const c = new Carrier(), [phone, lap, tab, b] = [device('phone'), device('laptop'), device('tablet'), device('b')] as [Device, Device, Device, Device]
  tab.lost = true
  met([phone, lap, tab], [b], [phone, lap, tab], [b], rules)
  renew(laptop === 'has the new secret' ? [phone, lap] : [phone])
  if (laptop === 'removes the tablet too') renew([lap])
  let tabletWrote = false
  if (tablet === 'changes first') { tabletWrote = change(tab, rules, []); send(tab, c, rules, 'message', 'from the lost device'); settle(c, rules, [b]) }
  change(phone, rules, []); send(phone, c, rules, 'message', 'from the phone'); settle(c, rules, [b, phone])
  if (tablet === 'changes second') { tabletWrote = change(tab, rules, []); send(tab, c, rules, 'message', 'from the lost device'); settle(c, rules, [b, phone]) }
  change(lap, rules, [])
  const sameAsPhone = headId(lap.own.log) === headId(phone.own.log)
  send(lap, c, rules, 'message', 'from the laptop'); settle(c, rules, [b, phone, lap])
  // worst case for what comes after: the lost device is handed the entry that stands at the counterpart
  if (b.peer.log.length > 1 && headId(b.peer.log) === headId(phone.own.log)) { tab.own.log = [...phone.own.log] }
  const again = b.peer.log.length > 1 && headId(b.peer.log) === headId(phone.own.log) ? change(tab, rules, []) : 'not applicable'
  return {
    'the lost device wrote a change': tabletWrote,
    'the counterpart follows': headId(b.peer.log) === headId(phone.own.log) ? 'the owner' : b.inbox.includes('from the lost device') ? 'the lost device' : 'another continuation',
    'the counterpart shows a warning': has(b, 'second continuation'),
    'the owner learned that its continuation was refused': has(phone, 'refused this device'),
    'the laptop wrote the same entry as the phone': sameAsPhone,
    'the laptop is heard': reads(b, 'from the laptop'),
    'the lost device can write the change after the owner\'s': again,
  }
}


export function measure (): Record<string, Row> {
  return {
    'two own devices change apart': twoOwnDevices(RULES),
    'two own devices change apart; the next state is derived, not drawn': twoOwnDevices(v({ deterministic: true })),
    'a lost device that holds an update key changes first': lostDeviceFirst(RULES, true),
    'the same; a refusal is answered to the address the counterpart holds': lostDeviceFirst(v({ replyToSender: false }), true),
    'a lost device without an update key': lostDeviceFirst(RULES, false),
    'the counterpart\'s second device is behind': counterpartsSecondDevice(RULES, false),
    'the same; documents carry no log heads': counterpartsSecondDevice(v({ heads: false }), false),
    'the same; the counterpart\'s devices synced first': counterpartsSecondDevice(RULES, true),
    'the same; a keeps the old receive path open after the acknowledgement': counterpartsSecondDevice(v({ graceAfterAck: true }), false),
    'the counterpart writes during the change; the owner fetches first': writtenDuringTheChange(RULES, false),
    'the same; the lost device fetches first': writtenDuringTheChange(RULES, true),
    'the same; the owner drops the old receive path at once': writtenDuringTheChange(v({ keepOldUntilAck: false }), false),
    'an answer after the change, from both own devices': answerAfterTheChange(RULES),
    'with a change secret: a device is removed, the lost one is locked': removedWithASecret('locked', 'has the new secret'),
    'with a change secret: the lost device is unlocked and changes after the owner': removedWithASecret('changes second', 'has the new secret'),
    'with a change secret: the lost device is unlocked and changes before the owner': removedWithASecret('changes first', 'has the new secret'),
    'with a change secret: the laptop was offline and changes on the old secret': removedWithASecret('locked', 'offline, old secret'),
    'with a change secret: phone and laptop each remove the tablet, apart': removedWithASecret('locked', 'removes the tablet too'),
    'an entry that is not a valid continuation arrives for a position already held': forgedEntry(),
    'a sibling that was offline during the change comes back': siblingComesBack(RULES),
    'the same; the old receive path stays open for a while': siblingComesBack(v({ graceAfterAck: true })),
  }
}
