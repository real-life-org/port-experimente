import { expect, test } from 'vitest'
import { sanOf } from '../src/lab/anmeldung/demo'

// Review #139: DEMO_HOST may be a DNS name; the demo certificate names it as DNS, not as IP.
test('das Demo-Zertifikat nennt IP-Adressen als IP und Namen als DNS', () => {
  expect(sanOf('10.185.49.152')).toBe('IP:10.185.49.152')
  expect(sanOf('::1')).toBe('IP:::1')
  expect(sanOf('anmeldung.example')).toBe('DNS:anmeldung.example')
})
