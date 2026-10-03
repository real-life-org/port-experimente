# Port-Notizen: Klartext

Null-Kandidat ohne Krypto und ohne Rechteprüfung. Er hat keine
Port-Anforderungen und dient nur als Gegenprobe für den Prüfstand.

Erwartung und Ergebnis: S1, S3, S5, S6 und S4c bestehen. Alle
Szenarien, die Schlüssel oder Rechteprüfung verlangen, fallen durch.
S4e fällt durch, weil die Ankunftsreihenfolge entscheidet. Genau das
muss jeder echte Kandidat vermeiden.

## Vorlage für echte Kandidaten

Jeder Kandidat beantwortet hier:

- **Ordnung:** Braucht er kausale Zustellung? Puffert er selbst?
- **Speicher:** Welchen Zustand muss die App dauerhaft halten, und in
  welcher Form (Bytes, Schema)?
- **Identität:** Welche Schlüssel braucht er, wie werden sie aus unserer
  Identität (did:key, Ed25519, X25519) abgeleitet oder abgebildet?
- **Transport:** Welche Nachrichtenarten, an wen (alle, einzelne)?
- **Autorität:** Wo werden Regeln ausgewertet; lassen sich unsere Regeln
  einhängen (P1)?
- **Schlüssel:** Wer erzeugt, verteilt, rotiert; was passiert bei
  gleichzeitigen Änderungen?
- **Historie:** Woher kommt der Zugriff auf alte Inhalte (P3)?
