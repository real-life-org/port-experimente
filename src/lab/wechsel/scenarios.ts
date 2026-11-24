// Scenarios for the model of model.ts. Each returns plain facts; the rules
// under discussion are switched per variant so that the table shows what
// each rule buys. A measurement of the model, not of the library.
import { Carrier, RULES, change, changeAfterSync, device, handOver, headId, met, open, paths, receive, removeDevice, renew, send, settleInPerson, share, stockUp, takeOver, type Device, type Rules } from './model'

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

// ── One main device ─────────────────────────────────────────────────────────
// Only the main device holds the change secret. The secret says who may
// write the next entry and nothing else; everyday keys are drawn and reach
// the linked devices by syncing.
const MAIN = v({ deterministic: true, stateFromSecret: false })

/** A linked device is lost, unlocked. The main device changes the keys. */
function linkedDeviceLost (): Row {
  const c = new Carrier(), [phone, laptop, tablet, b] = [device('phone'), device('laptop'), device('tablet'), device('b')] as [Device, Device, Device, Device]
  tablet.lost = true
  met([phone, laptop, tablet], [b], [phone], [b], MAIN)
  const tabletChanges = change(tablet, MAIN, [])
  send(tablet, c, MAIN, 'message', 'tablet as the person'); settle(c, MAIN, [b, phone])
  const heardBefore = reads(b, 'tablet as the person')
  change(phone, MAIN, []); send(phone, c, MAIN, 'message', 'from the phone'); settle(c, MAIN, [b, phone])
  send(laptop, c, MAIN, 'message', 'laptop, before syncing'); settle(c, MAIN, [b, laptop, phone])
  share(phone, laptop, false)
  send(laptop, c, MAIN, 'message', 'laptop, after syncing'); settle(c, MAIN, [b, laptop, phone])
  send(tablet, c, MAIN, 'message', 'tablet, after the change'); settle(c, MAIN, [b, phone])
  send(b, c, MAIN, 'message', 'for the person'); settle(c, MAIN, [tablet, phone, b])
  return {
    'the lost linked device can change the keys': tabletChanges,
    'before the change the counterpart takes what it writes as the person': heardBefore,
    'after the change the counterpart takes what it writes': reads(b, 'tablet, after the change'),
    'after the change it reads what the counterpart writes': reads(tablet, 'for the person'),
    'the laptop is heard before it synced with the main device': reads(b, 'laptop, before syncing'),
    'the laptop is heard after it synced': reads(b, 'laptop, after syncing'),
    'the laptop holds a change secret': laptop.own.secrets.length > 0,
  }
}

/** The laptop meets someone while the main device is off, with and without prepared bindings. */
function newContactOnALinkedDevice (stock: number): Row {
  const c = new Carrier(), [phone, laptop, b] = [device('phone'), device('laptop'), device('b')] as [Device, Device, Device]
  renew([phone]); renew([b])
  stockUp(phone, laptop, stock)
  const first = open(laptop, [], MAIN); open(b, [], MAIN)
  laptop.peer.log = [...b.own.log]; b.peer.log = [...laptop.own.log]; laptop.own.owed = []; b.own.owed = []
  send(laptop, c, MAIN, 'message', 'hello'); settle(c, MAIN, [b, laptop])
  share(laptop, phone, false)                               // the main device comes back and learns of the relationship
  const changed = change(phone, MAIN, [])
  send(phone, c, MAIN, 'message', 'from the main device'); settle(c, MAIN, [b, phone])
  const second = open(device('x'), [], MAIN)                 // a device with neither a secret nor a stock
  return {
    'the relationship is opened': first,
    'the counterpart hears the laptop': reads(b, 'hello'),
    'the main device can change the keys later': changed,
    'the counterpart follows that change': changed && headId(b.peer.log) === headId(phone.own.log),
    'bindings left on the laptop': laptop.own.stock.length,
    'a device with neither secret nor stock opens': second,
  }
}

/** Self-binding: the laptop meets someone while the main device is off and
 *  binds the relationship to a key it draws itself. `lostWhen` says when the
 *  laptop gets into foreign hands, unlocked. A lost laptop hands nothing
 *  over: lost before the handover, the main device never hears of the
 *  relationship. An honest laptop forgets the key at the handover; lost
 *  after it, it holds nothing to write with. The two `copied` cases are
 *  another matter: the key was copied off the laptop before the handover
 *  and is used after it. */
function selfBound (lostWhen: 'never' | 'before the handover' | 'after the handover' | 'copied before, used before the counterpart knows' | 'copied before, used after the counterpart knows'): Row {
  const R = { ...MAIN, selfBind: true }
  const c = new Carrier(), [phone, laptop, b] = [device('phone'), device('laptop'), device('b')] as [Device, Device, Device]
  renew([phone]); renew([b])
  const opened = open(laptop, [], R); open(b, [], R)
  laptop.peer.log = [...b.own.log]; b.peer.log = [...laptop.own.log]; laptop.own.owed = []; b.own.owed = []
  send(laptop, c, R, 'message', 'hello'); settle(c, R, [b, laptop])
  const sigBefore = laptop.own.log[0]?.state.sig
  let handed = false, wrote = false
  const lose = (): void => { laptop.lost = true; wrote = change(laptop, R, []); if (wrote) { send(laptop, c, R, 'message', 'from the lost laptop'); settle(c, R, [b, phone]) } }
  const tell = (): void => { send(phone, c, R, 'message', 'from the main device'); settle(c, R, [b, phone]) }
  if (lostWhen === 'before the handover') lose()
  else {
    const copy = new Map(laptop.own.update)                                  // what someone who copied the key before the handover holds
    handed = handOver(laptop, phone, R)
    if (lostWhen === 'after the handover') { lose(); tell() }                // the laptop as the handover left it
    else if (lostWhen === 'copied before, used before the counterpart knows') { laptop.own.update = copy; lose(); tell() }
    else if (lostWhen === 'copied before, used after the counterpart knows') { tell(); laptop.own.update = copy; lose() }
    else tell()
  }
  const knows = phone.own.log.length > 0
  return {
    'the relationship is opened': opened,
    'the main device knows of the relationship': knows,
    'the handover binds it to the main device': handed,
    'the handover changes the everyday key': handed && phone.own.log[1]?.state.sig !== sigBefore,
    'the lost laptop wrote a continuation': wrote,
    'the counterpart follows': knows && headId(b.peer.log) === headId(phone.own.log) ? 'the owner' : reads(b, 'from the lost laptop') ? 'the lost laptop' : 'nobody new',
    'the relationship is contested at the counterpart': b.peer.contested,
    'the main device can change the keys afterwards': knows && headId(b.peer.log) === headId(phone.own.log) && change(phone, R, []),
  }
}

/** The counterpart has two devices; an old main device in foreign hands and
 *  the owner each write a continuation; one reaches B's phone first, the
 *  other B's laptop. Then B's devices sync. */
function counterpartSplit (settleRule: boolean): Row {
  const c = new Carrier(), [phone, old, bPhone, bLaptop] = [device('phone'), device('old main'), device('b-phone'), device('b-laptop')] as [Device, Device, Device, Device]
  old.lost = true
  met([phone, old], [bPhone, bLaptop], [phone, old], [bPhone], MAIN)
  renew([phone])                                            // the owner restored: a new secret the old main device never saw
  change(old, MAIN, []); change(phone, MAIN, [])
  send(old, c, MAIN, 'message', 'from the old main device'); receive(bPhone, c, MAIN)
  send(phone, c, MAIN, 'message', 'from the owner'); receive(bLaptop, c, MAIN)
  const split = headId(bPhone.peer.log) !== headId(bLaptop.peer.log)
  share(bPhone, bLaptop, false, settleRule); share(bLaptop, bPhone, false, settleRule)
  const same = headId(bPhone.peer.log) === headId(bLaptop.peer.log)
  return {
    'b\'s phone and laptop follow different continuations before they sync': split,
    'after syncing they follow the same one': same,
    'both show that there are two continuations': has(bPhone, 'two continuations of the counterpart') && has(bLaptop, 'two continuations of the counterpart'),
    'both hold the other continuation as evidence': bPhone.peer.evidence.length > 0 && bLaptop.peer.evidence.length > 0,
  }
}

/** A contested relationship: an old main device in foreign hands and the
 *  owner each write a continuation; `first` reaches the counterpart first.
 *  Then the two meet. */
function contested (first: 'the owner' | 'the old main device'): Row {
  const c = new Carrier(), [phone, old, b] = [device('phone'), device('old main'), device('b')] as [Device, Device, Device]
  old.lost = true
  met([phone, old], [b], [phone, old], [b], MAIN)
  renew([phone])
  change(old, MAIN, []); change(phone, MAIN, [])
  const order = first === 'the owner' ? [phone, old] : [old, phone]
  for (const d of order) { send(d, c, MAIN, 'message', d === phone ? 'from the owner' : 'from the old main device'); settle(c, MAIN, [b, phone]) }
  const follows0 = headId(b.peer.log) === headId(phone.own.log) ? 'the owner' : 'the old main device'
  const marked = b.peer.contested
  send(b, c, MAIN, 'trust'); send(b, c, MAIN, 'message', 'a message while contested'); settle(c, MAIN, [old, phone, b])
  const trustHeld = has(b, 'held a trust'), msgTo = reads(phone, 'a message while contested') ? 'the owner' : reads(old, 'a message while contested') ? 'the old main device' : 'nobody'
  const metOk = settleInPerson(b, phone.own.log)
  send(b, c, MAIN, 'trust', 'trust after the meeting'); settle(c, MAIN, [old, phone, b])
  const warnings = b.notices.filter((n) => n.includes('second continuation')).length
  send(old, c, MAIN, 'message', 'again from the old main device'); settle(c, MAIN, [b, phone])
  return {
    'before the meeting the counterpart follows': follows0,
    'the relationship is marked contested': marked,
    'a statement of trust is held back': trustHeld,
    'a message while contested reaches': msgTo,
    'the meeting settles it': metOk && !b.peer.contested,
    'after the meeting the counterpart follows the owner': headId(b.peer.log) === headId(phone.own.log),
    'after the meeting trust reaches the owner': reads(phone, 'trust after the meeting'),
    'the old main device is heard after the meeting': reads(b, 'again from the old main device'),
    'the old main device can contest it again': b.peer.contested || b.notices.filter((n) => n.includes('second continuation')).length > warnings,
  }
}

/** First sync, then act: an old main device that was removed tries to change keys with the unchanged app. */
function removedMainDeviceActs (reachesAnOwnDevice: boolean): Row {
  const [phone, old, laptop, b] = [device('phone'), device('old main'), device('laptop'), device('b')] as [Device, Device, Device, Device]
  met([phone, old, laptop], [b], [phone, old], [b], MAIN)
  removeDevice(phone, 'old main'); share(phone, laptop, false)
  const result = changeAfterSync(old, MAIN, reachesAnOwnDevice ? [laptop] : [])
  return { 'the removed main device': result, 'it still holds a change secret': old.own.secrets.length > 0 }
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
    'one main device: a linked device is lost and the main device changes the keys': linkedDeviceLost(),
    'one main device: the laptop meets someone with a prepared binding': newContactOnALinkedDevice(2),
    'one main device: the laptop meets someone without a prepared binding': newContactOnALinkedDevice(0),
    'self-binding: the laptop meets someone, later hands the key over': selfBound('never'),
    'self-binding: the laptop is lost before the handover': selfBound('before the handover'),
    'self-binding: the laptop is lost after the handover': selfBound('after the handover'),
    'self-binding: the key was copied before the handover and is used before the counterpart knows of it': selfBound('copied before, used before the counterpart knows'),
    'self-binding: the key was copied before the handover and is used after the counterpart knows of it': selfBound('copied before, used after the counterpart knows'),
    'the counterpart has two devices and each took another continuation': counterpartSplit(false),
    'the same; the counterpart\'s devices settle on one by a fixed rule': counterpartSplit(true),
    'contested: the owner reached the counterpart first': contested('the owner'),
    'contested: the old main device reached the counterpart first': contested('the old main device'),
    'first sync, then act: a removed main device reaches an own device': removedMainDeviceActs(true),
    'first sync, then act: a removed main device reaches none': removedMainDeviceActs(false),
    'an entry that is not a valid continuation arrives for a position already held': forgedEntry(),
    'a sibling that was offline during the change comes back': siblingComesBack(RULES),
    'the same; the old receive path stays open for a while': siblingComesBack(v({ graceAfterAck: true })),
  }
}
