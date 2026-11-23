// Scenarios for group.ts: person A with phone, laptop and a lost tablet,
// and a second member B, in one group.
import { GRULES, found, gdevice, keyOf, reads, rekey, say, sync, writersSeen, type GDevice, type GRules } from './group'

export type Row = Record<string, string | number | boolean>
function cast (holders: (ds: GDevice[]) => GDevice[]): { phone: GDevice, laptop: GDevice, tablet: GDevice, b: GDevice } {
  const [phone, laptop, tablet, b] = [gdevice('phone', 'A'), gdevice('laptop', 'A'), gdevice('tablet', 'A'), gdevice('b', 'B')] as [GDevice, GDevice, GDevice, GDevice]
  found([{ id: 'A', devices: [phone, laptop, tablet], holders: holders([phone, laptop, tablet]) }, { id: 'B', devices: [b], holders: [b] }])
  return { phone, laptop, tablet, b }
}
const all = (ds: GDevice[]): GDevice[] => ds
const notTablet = (ds: GDevice[]): GDevice[] => ds.slice(0, 2)

/** Phone and laptop write apart; then the tablet is lost and the phone changes the key. */
function removeADevice (rules: GRules, holders: (ds: GDevice[]) => GDevice[]): Row {
  const { phone, laptop, tablet, b } = cast(holders)
  say(phone, rules, 'from the phone'); say(laptop, rules, 'from the laptop')
  sync(phone, b); sync(laptop, b); sync(phone, laptop); sync(tablet, b)
  const writers = writersSeen(b, rules)
  // the laptop goes offline and writes; the tablet is lost; the phone changes the key
  say(laptop, rules, 'laptop, offline, before it knew')
  const changed = rekey(phone, rules, [])
  say(phone, rules, 'phone, after the change')
  say(tablet, rules, 'tablet, not knowing of the change')          // under the old key, beside the change
  sync(phone, b); sync(tablet, b)
  sync(tablet, phone); say(tablet, rules, 'tablet, after seeing the change', [...tablet.sig.keys()][0])   // the only key it holds: the old one
  sync(tablet, b); sync(laptop, b); sync(phone, b)
  const atB = reads(b, rules)
  return {
    'writers the other member saw for A before the change (two devices wrote)': writers,
    'the phone could change the key': changed,
    'the other member reads the phone after the change': atB.includes('phone, after the change'),
    'the other member takes what the tablet wrote beside the change': atB.includes('tablet, not knowing of the change'),
    'the other member takes what the tablet wrote after seeing the change': atB.includes('tablet, after seeing the change'),
    'the other member takes what the laptop wrote offline under the old key': atB.includes('laptop, offline, before it knew'),
    'the tablet reads what the phone wrote after the change': reads(tablet, rules).includes('phone, after the change'),
    'the laptop, without the new keys, reads it': reads(laptop, rules).includes('phone, after the change'),
  }
}

/** Phone and laptop both change the key while apart. */
function twoChangeApart (rules: GRules): Row {
  const { phone, laptop, b } = cast(notTablet)
  rekey(phone, rules, []); rekey(laptop, rules, [])
  say(phone, rules, 'phone under its new key'); say(laptop, rules, 'laptop under its new key')
  sync(phone, b); sync(laptop, b); sync(phone, laptop); sync(laptop, b)
  const atB = reads(b, rules)
  return {
    'everyone computes the same key for A': keyOf(b, rules, 'A') === keyOf(phone, rules, 'A') && keyOf(phone, rules, 'A') === keyOf(laptop, rules, 'A'),
    'the other member reads the phone': atB.includes('phone under its new key'),
    'the other member reads the laptop': atB.includes('laptop under its new key'),
  }
}

/** The lost tablet changes the key before the owner does. */
function lostDeviceFirst (rules: GRules, holders: (ds: GDevice[]) => GDevice[]): Row {
  const { phone, tablet, b } = cast(holders)
  const could = rekey(tablet, rules, [])
  if (could) say(tablet, rules, 'tablet as A')
  sync(tablet, b)
  sync(b, phone)
  const owner = rekey(phone, rules, [])
  say(phone, rules, 'the owner')
  sync(phone, b)
  const atB = reads(b, rules)
  return {
    'the lost device could change the key': could,
    'the other member takes the lost device as A': atB.includes('tablet as A'),
    'the owner could change the key afterwards': owner,
    'the other member reads the owner': atB.includes('the owner'),
  }
}

const v = (r: Partial<GRules>): GRules => ({ ...GRULES, ...r })
export function measure (): Record<string, Row> {
  return {
    'a device is removed by a change of the person\'s key': removeADevice(GRULES, notTablet),
    'the same; an entry counts by its place alone': removeADevice(v({ sealsWhatItSaw: false }), notTablet),
    'two own devices change apart': twoChangeApart(GRULES),
    'two own devices change apart; the next key is derived, not drawn': twoChangeApart(v({ derived: true })),
    'a lost device changes first; the key every device holds may write a change': lostDeviceFirst(v({ authorizedBy: 'current-key' }), all),
    'a lost device changes first; it holds the update key': lostDeviceFirst(GRULES, all),
    'a lost device without the update key': lostDeviceFirst(GRULES, notTablet),
  }
}
