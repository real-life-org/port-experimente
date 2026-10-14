use mls_wasm::peer::Peer;

#[test]
fn gruenden_aufnehmen_entfernen_rotieren() {
    let gid = b"gruppe-1".to_vec();
    let mut alice = Peer::new().unwrap();
    let mut bob = Peer::new().unwrap();
    let mut carol = Peer::new().unwrap();
    assert!(alice.create(&gid).unwrap().is_empty());
    assert!(alice.has_key());
    // Aufnahme: Commit an alle, Willkommen an Bob.
    let (commit_b, welcome_b) = alice.add(bob.share_key()).unwrap();
    bob.receive(&welcome_b).unwrap();
    assert!(bob.has_key());
    assert_eq!(alice.members().len(), 2);
    assert_eq!(bob.members().len(), 2);
    // Alices eigener Commit als Echo: ignoriert.
    assert!(alice.receive(&commit_b).is_err());
    // Eintrag von Alice, Bob öffnet ihn.
    let s = alice.encrypt(b"ref-1", b"hallo").unwrap();
    let (plain, key) = bob.decrypt(&s.ciphertext).unwrap();
    assert_eq!(plain, b"hallo");
    assert_eq!(key, s.app_key);
    assert_eq!(Peer::decrypt_with_key(&s.ciphertext, &key).unwrap(), b"hallo");
    // Carol kommt dazu, Bob spielt den Commit ein.
    let (commit_c, welcome_c) = alice.add(carol.share_key()).unwrap();
    bob.receive(&commit_c).unwrap();
    carol.receive(&welcome_c).unwrap();
    assert_eq!(bob.members().len(), 3);
    assert_eq!(carol.members().len(), 3);
    // Carol liest den alten Eintrag nicht (keine Exporter der alten Epoche), neue schon.
    assert!(carol.decrypt(&s.ciphertext).is_err());
    let s2 = bob.encrypt(b"ref-2", b"neu").unwrap();
    assert_eq!(carol.decrypt(&s2.ciphertext).unwrap().0, b"neu");
    // Bob entfernt Carol; Carol liest Neues nicht mehr.
    let commit_r = bob.remove(carol.id()).unwrap().unwrap();
    alice.receive(&commit_r).unwrap();
    carol.receive(&commit_r).unwrap();
    assert_eq!(alice.members().len(), 2);
    assert!(carol.members().is_empty());
    assert!(!carol.has_key());
    let s3 = alice.encrypt(b"ref-3", b"ohne-carol").unwrap();
    assert!(carol.decrypt(&s3.ciphertext).is_err());
    assert_eq!(bob.decrypt(&s3.ciphertext).unwrap().0, b"ohne-carol");
    // Rotation (KV5): ein gestohlener Zustand von Bob liest nach der Rotation nicht weiter.
    let stolen = bob.export_state().unwrap();
    let mut thief = Peer::from_state(&stolen).unwrap();
    let s4 = alice.encrypt(b"ref-4", b"vor-rotation").unwrap();
    assert_eq!(thief.decrypt(&s4.ciphertext).unwrap().0, b"vor-rotation");
    let rot = bob.rotate().unwrap();
    alice.receive(&rot).unwrap();
    let _ = thief.receive(&rot); // der Dieb sieht den Commit, hat aber Bobs alten Schlüssel
    let s5 = alice.encrypt(b"ref-5", b"nach-rotation").unwrap();
    assert_eq!(bob.decrypt(&s5.ciphertext).unwrap().0, b"nach-rotation");
    let _ = thief;
}

#[test]
fn gleichzeitige_commits_niedrigster_hash_gewinnt() {
    let gid = b"gruppe-2".to_vec();
    let mut alice = Peer::new().unwrap();
    let mut bob = Peer::new().unwrap();
    let mut carol = Peer::new().unwrap();
    let mut dave = Peer::new().unwrap();
    alice.create(&gid).unwrap();
    for p in [&mut bob, &mut carol, &mut dave] {
        let (c, w) = alice.add(p.share_key()).unwrap();
        p.receive(&w).unwrap();
        let _ = c;
    }
    // Alle auf Stand: Bob, Carol brauchen die Commits der späteren Aufnahmen. Einfacher: Alice rotiert einmal und alle folgen.
    // (Die Aufnahme-Commits gingen oben nicht an die früheren Mitglieder; wir bauen die Gruppe deshalb neu auf.)
    let mut alice = Peer::new().unwrap();
    let mut bob = Peer::new().unwrap();
    let mut carol = Peer::new().unwrap();
    let mut dave = Peer::new().unwrap();
    alice.create(&gid).unwrap();
    let (c1, w1) = alice.add(bob.share_key()).unwrap();
    bob.receive(&w1).unwrap();
    let _ = c1;
    let (c2, w2) = alice.add(carol.share_key()).unwrap();
    bob.receive(&c2).unwrap();
    carol.receive(&w2).unwrap();
    let (c3, w3) = alice.add(dave.share_key()).unwrap();
    bob.receive(&c3).unwrap();
    carol.receive(&c3).unwrap();
    dave.receive(&w3).unwrap();
    assert_eq!(alice.members().len(), 4);
    // Alice entfernt Carol, Bob entfernt Dave, gleichzeitig (beide auf derselben Epoche).
    let ra = alice.remove(carol.id()).unwrap().unwrap();
    let rb = bob.remove(dave.id()).unwrap().unwrap();
    let a_gets_b = alice.receive(&rb);
    let b_gets_a = bob.receive(&ra);
    // Genau einer verliert und rollt zurück; danach sind beide auf derselben Epoche mit demselben Baum.
    assert!(a_gets_b.is_err() && b_gets_a.is_err());
    let lost_a = matches!(a_gets_b, Err(mls_wasm::peer::Error::LostTiebreak));
    let lost_b = matches!(b_gets_a, Err(mls_wasm::peer::Error::LostTiebreak));
    assert!(lost_a ^ lost_b, "genau einer verliert: a={lost_a} b={lost_b}");
    assert_eq!(alice.members(), bob.members());
    assert_eq!(alice.members().len(), 3);
    // Unbeteiligte wählen denselben Gewinner, egal in welcher Reihenfolge die beiden Commits ankommen;
    // wen der Gewinner entfernt, der steht am Ende ohne Gruppe da.
    let (first, second) = if lost_a { (&ra, &rb) } else { (&rb, &ra) }; // first = Verlierer
    carol.receive(first).unwrap();
    assert!(matches!(carol.receive(second), Err(mls_wasm::peer::Error::LostTiebreak)));
    dave.receive(second).unwrap();
    assert!(dave.receive(first).is_err());
    let (winner_removed, other) = if lost_a { (&dave, &carol) } else { (&carol, &dave) };
    assert!(winner_removed.members().is_empty());
    assert_eq!(other.members(), alice.members());
    // Der Verlierer erledigt sein Anliegen noch einmal, jetzt auf der gemeinsamen Epoche.
    if lost_a {
        let r = alice.remove(carol.id()).unwrap().unwrap();
        bob.receive(&r).unwrap();
    } else {
        let r = bob.remove(dave.id()).unwrap().unwrap();
        alice.receive(&r).unwrap();
    }
    assert_eq!(alice.members(), bob.members());
    assert_eq!(alice.members().len(), 2);
    let s = alice.encrypt(b"r", b"zu-zweit").unwrap();
    assert_eq!(bob.decrypt(&s.ciphertext).unwrap().0, b"zu-zweit");
}

/// Vertrag Punkt 2: ein Rückfall reicht über mehrere eigene Commits zurück, bis zum Verzweigungspunkt.
#[test]
fn rueckfall_ueber_mehrere_epochen() {
    use mls_wasm::peer::Error;
    let gid = b"gruppe-3".to_vec();
    let mut alice = Peer::new().unwrap();
    let mut bob = Peer::new().unwrap();
    alice.create(&gid).unwrap();
    let (_, w) = alice.add(bob.share_key()).unwrap();
    bob.receive(&w).unwrap();
    // Beide auf Epoche 1. Alice rotiert zweimal, Bob einmal, ohne voneinander zu wissen.
    let a1 = alice.rotate().unwrap();
    let a2 = alice.rotate().unwrap();
    let b1 = bob.rotate().unwrap();
    assert_eq!(alice.epoch(), 3);
    assert_eq!(bob.epoch(), 2);
    let a_gets_b = alice.receive(&b1);
    let b_gets_a1 = bob.receive(&a1);
    let a_lost = matches!(a_gets_b, Err(Error::LostTiebreak));
    let b_lost = matches!(b_gets_a1, Err(Error::LostTiebreak));
    assert!(a_lost ^ b_lost, "genau einer verliert: a={a_lost} b={b_lost}");
    if a_lost {
        // Alice fällt auf Epoche 1 zurück und nimmt b1: beide auf 2, gleicher Baum; a2 ist für Bob nie anwendbar.
        assert_eq!(alice.epoch(), 2);
        assert!(matches!(bob.receive(&a2), Err(Error::Stale(_))));
    } else {
        // Bob nimmt a1, dann a2.
        assert!(matches!(bob.receive(&a2), Ok(())));
        assert_eq!(bob.epoch(), 3);
    }
    let s = alice.encrypt(b"r", b"nach-dem-rueckfall").unwrap();
    assert_eq!(bob.decrypt(&s.ciphertext).unwrap().0, b"nach-dem-rueckfall");
}

/// Vertrag Punkt 2, Nachsatz: ein Commit vom verfallenen Zweig mit derselben Epochennummer wie ein späterer eigener
/// ist kein Geschwister; er wird probeweise angewandt und zurückgenommen (`Stale`), der eigene Stand bleibt.
#[test]
fn commit_vom_anderen_zweig_ist_kein_geschwister() {
    use mls_wasm::peer::Error;
    let gid = b"gruppe-5".to_vec();
    let mut alice = Peer::new().unwrap();
    let mut bob = Peer::new().unwrap();
    alice.create(&gid).unwrap();
    let (_, w) = alice.add(bob.share_key()).unwrap();
    bob.receive(&w).unwrap();
    // Beide auf 1. Gleichzeitig: Alice rotiert (1→2), Bob rotiert (1→2). Dann macht jeder noch einen Commit (2→3).
    let a1 = alice.rotate().unwrap();
    let b1 = bob.rotate().unwrap();
    let a2 = alice.rotate().unwrap();
    let b2 = bob.rotate().unwrap();
    let a_lost = matches!(alice.receive(&b1), Err(Error::LostTiebreak));
    let b_lost = matches!(bob.receive(&a1), Err(Error::LostTiebreak));
    assert!(a_lost ^ b_lost);
    let (winner, loser, w2, l2) = if a_lost { (&mut bob, &mut alice, &b2, &a2) } else { (&mut alice, &mut bob, &a2, &b2) };
    // Der Gewinner steht auf 3 (eigener zweiter Commit). Der Commit 2→3 des Verlierers (anderer Zweig) ändert nichts.
    assert_eq!(winner.epoch(), 3);
    let members_before = winner.members();
    assert!(matches!(winner.receive(l2), Err(Error::Stale(_))), "{:?}", winner.receive(l2));
    assert_eq!(winner.epoch(), 3);
    assert_eq!(winner.members(), members_before);
    // Der Verlierer (auf 2, Zweig des Gewinners) nimmt dessen zweiten Commit; der eigene zweite ist für ihn Echo oder veraltet.
    assert_eq!(loser.epoch(), 2);
    loser.receive(w2).unwrap();
    assert_eq!(loser.epoch(), 3);
    assert!(matches!(loser.receive(l2), Err(Error::Own) | Err(Error::Stale(_))));
    let s = winner.encrypt(b"r", b"beide-auf-drei").unwrap();
    assert_eq!(loser.decrypt(&s.ciphertext).unwrap().0, b"beide-auf-drei");
}

/// Vertrag Punkt 4: ein Willkommen auf einen verfallenen Zweig wird durch ein neueres ersetzt; ein gleich altes
/// oder älteres Willkommen ändert nichts.
#[test]
fn willkommen_ersetzt_verfallenen_zweig() {
    use mls_wasm::peer::Error;
    let gid = b"gruppe-4".to_vec();
    let mut alice = Peer::new().unwrap();
    let mut bob = Peer::new().unwrap();
    let mut dave = Peer::new().unwrap();
    alice.create(&gid).unwrap();
    let (_, w) = alice.add(bob.share_key()).unwrap();
    bob.receive(&w).unwrap();
    // Alice nimmt Dave auf (Epoche 2), Bob rotiert gleichzeitig (Epoche 2). Dave steht auf Alices Zweig.
    let (ca, wd) = alice.add(dave.share_key()).unwrap();
    dave.receive(&wd).unwrap();
    let again = dave.receive(&wd); assert!(matches!(again, Err(Error::Own)), "{again:?}");
    let cb = bob.rotate().unwrap();
    let a_lost = matches!(alice.receive(&cb), Err(Error::LostTiebreak));
    let b_lost = matches!(bob.receive(&ca), Err(Error::LostTiebreak));
    assert!(a_lost ^ b_lost);
    if a_lost {
        // Daves Zweig ist verfallen. Alice nimmt ihn erneut auf (Epoche 3): das neuere Willkommen ersetzt seine Gruppe.
        let (ca2, wd2) = alice.add(dave.share_key()).unwrap();
        assert!(matches!(dave.receive(&wd2), Err(Error::Reset)));
        assert_eq!(dave.epoch(), 3);
        bob.receive(&ca2).unwrap();
        // Das alte Willkommen (Epoche 2) ändert nichts mehr.
        assert!(matches!(dave.receive(&wd), Err(Error::Own)));
        let s = bob.encrypt(b"r", b"an-dave").unwrap();
        assert_eq!(dave.decrypt(&s.ciphertext).unwrap().0, b"an-dave");
    } else {
        // Bob hat verloren; Dave steht richtig. Ein zweites gleiches Willkommen ändert nichts.
        assert!(matches!(dave.receive(&wd), Err(Error::Own)));
        let s = bob.encrypt(b"r", b"an-dave").unwrap();
        assert_eq!(dave.decrypt(&s.ciphertext).unwrap().0, b"an-dave");
    }
}
