# Port notes: plaintext

Null candidate without crypto and without permission checks. It has no
port requirements and serves only as a control for the bench.

Expectation and result: S1, S3, S5, S6 and S4c pass. Every scenario that
requires keys or permission checks fails. S4e fails because arrival order
decides. That is exactly what every real candidate must avoid.

## Template for real candidates

Every candidate answers here:

- **Ordering:** does it need causal delivery? Does it buffer itself?
- **Storage:** which state must the app keep durably, and in which form
  (bytes, schema)?
- **Identity:** which keys does it need, how are they derived from or
  mapped to our identity (did:key, Ed25519, X25519)?
- **Transport:** which message kinds, to whom (everyone, individuals)?
- **Authority:** where are rules evaluated; can our rules be plugged in
  (P1)?
- **Keys:** who generates, distributes, rotates; what happens on
  simultaneous changes?
- **History:** where does access to old content come from (P3)?
