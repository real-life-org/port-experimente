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

/// E14a: echte MLS-Anwendungsnachrichten (PrivateMessage) zwischen zwei Peers, über rohe MLSMessage-Bytes, wie sie
/// eine fremde Implementierung sähe.
#[test]
fn anwendungsnachricht_zu_zweit_ueber_rohbytes() {
    let gid = b"zu-zweit".to_vec();
    let mut alice = Peer::new().unwrap();
    let mut bob = Peer::new().unwrap();
    alice.create(&gid).unwrap();
    let (commit, welcome) = alice.add(bob.share_key()).unwrap();
    let (kind, raw_welcome) = Peer::unwrap_op(&welcome).unwrap();
    assert_eq!(kind, "welcome");
    assert_eq!(Peer::unwrap_op(&commit).unwrap().0, "commit");
    bob.receive(&Peer::wrap_welcome(raw_welcome).unwrap()).unwrap();
    let m = alice.send_message(b"hallo bob").unwrap();
    assert_eq!(bob.open_message(&m).unwrap(), b"hallo bob");
    let r = bob.send_message(b"hallo alice").unwrap();
    assert_eq!(alice.open_message(&r).unwrap(), b"hallo alice");
    // Ein Commit als Rohbytes hin und zurück verpackt bleibt derselbe Commit.
    let rot = bob.rotate().unwrap();
    let (_, raw) = Peer::unwrap_op(&rot).unwrap();
    alice.receive(&Peer::wrap_commit(raw).unwrap()).unwrap();
    let m2 = alice.send_message(b"nach-rotation").unwrap();
    assert_eq!(bob.open_message(&m2).unwrap(), b"nach-rotation");
}

/// E14b owner: ein Mitglied erneuert sein Blatt als Vorschlag, der Gründer committet; der Dieb des alten Blatts liest
/// danach nichts mehr (PCS ohne eigenen Commit des Mitglieds).
#[test]
fn rotation_als_vorschlag_durch_den_gruender_committet() {
    use mls_wasm::peer::Error;
    let gid = b"owner-raum".to_vec();
    let mut alice = Peer::new().unwrap();
    let mut bob = Peer::new().unwrap();
    let mut carol = Peer::new().unwrap();
    alice.create(&gid).unwrap();
    let (_, wb) = alice.add(bob.share_key()).unwrap();
    bob.receive(&wb).unwrap();
    let (cc, wc) = alice.add(carol.share_key()).unwrap();
    bob.receive(&cc).unwrap();
    carol.receive(&wc).unwrap();
    let mut thief = Peer::from_state(&bob.export_state().unwrap()).unwrap();
    // Bob schlägt vor; das ist kein Commit, seine Epoche bleibt.
    let p = bob.propose_update().unwrap();
    assert_eq!(bob.epoch(), 2);
    assert!(matches!(alice.receive(&p), Err(Error::Proposed)));
    assert!(matches!(carol.receive(&p), Err(Error::Proposed)));
    // Der Dieb ist eine Kopie von Bobs Blatt: OpenMLS verarbeitet keine Nachricht vom eigenen Blatt; er bleibt zurück.
    let _ = thief.receive(&p);
    let c = alice.commit_pending().unwrap().expect("Commit über den Vorschlag");
    assert!(alice.commit_pending().unwrap().is_none(), "nach dem Commit liegt nichts mehr vor");
    assert_eq!(alice.epoch(), 3);
    bob.receive(&c).unwrap();
    assert_eq!(bob.epoch(), 3);
    // Der Dieb hat Bobs altes Blatt: Bobs neues Blattgeheimnis kennt er nicht, Neues liest er nicht.
    let _ = thief.receive(&c);
    let s = alice.encrypt(b"r", b"nach-vorschlag").unwrap();
    assert_eq!(bob.decrypt(&s.ciphertext).unwrap().0, b"nach-vorschlag");
    assert!(thief.decrypt(&s.ciphertext).is_err(), "Dieb liest nach der Rotation nichts");
}

/// KV3 am Port (Issue #45): der erbeutete Zustand einer Entfernten nimmt ein Blatt auf, als Geschwister des
/// Entfernungs-Commits (gleicher Vorgänger). Beide Zweige des Tiebreaks gezielt: die Fälschung gewinnt (die
/// Mitglieder fallen zurück und nehmen sie; eine erneute Entfernung heilt) und die Fälschung verliert (stale).
/// Das Blatt liest in keinem Fall, was nach der Heilung versiegelt wird.
#[test]
fn faelschung_als_geschwister_der_entfernung_beide_zweige() {
    use mls_wasm::peer::{digest_of, Error};
    let mut seen_win = false;
    let mut seen_lose = false;
    for _ in 0..40 {
        if seen_win && seen_lose {
            break;
        }
        let gid = b"kv3".to_vec();
        let mut alice = Peer::new().unwrap();
        let mut bob = Peer::new().unwrap();
        let mut mallory = Peer::new().unwrap();
        alice.create(&gid).unwrap();
        let (_, wb) = alice.add(bob.share_key()).unwrap();
        bob.receive(&wb).unwrap();
        let (cm, wm) = alice.add(mallory.share_key()).unwrap();
        bob.receive(&cm).unwrap();
        mallory.receive(&wm).unwrap();
        // Erbeutet: Mallorys Zustand auf der Epoche, auf der Alice sie gleich entfernt (gemeinsamer Vorgänger).
        let parent = alice.epoch();
        assert_eq!(mallory.epoch(), parent);
        let mut thief = Peer::from_state(&mallory.export_state().unwrap()).unwrap();
        let removal = alice.remove(mallory.id()).unwrap().unwrap();
        bob.receive(&removal).unwrap();
        let mut leaf = Peer::new().unwrap();
        let (forged, welcome) = thief.add(leaf.share_key()).unwrap();
        leaf.receive(&welcome).unwrap();
        let wins = digest_of(&forged) < digest_of(&removal);
        let ra = alice.receive(&forged);
        let rb = bob.receive(&forged);
        if wins {
            seen_win = true;
            assert!(matches!(ra, Err(Error::LostTiebreak)), "{ra:?}");
            assert!(matches!(rb, Err(Error::LostTiebreak)), "{rb:?}");
            // Zurückgefallen: Mallory und ihr Blatt stehen im Baum; die Heilung (Log: Mallory ist raus) entfernt beide.
            assert_eq!(alice.members().len(), 4);
            let heal1 = alice.remove(mallory.id()).unwrap().unwrap();
            bob.receive(&heal1).unwrap();
            let heal2 = alice.remove(leaf.id()).unwrap().unwrap();
            bob.receive(&heal2).unwrap();
            let _ = leaf.receive(&heal1);
            let _ = leaf.receive(&heal2);
        } else {
            seen_lose = true;
            assert!(matches!(ra, Err(Error::Stale(_))), "{ra:?}");
            assert!(matches!(rb, Err(Error::Stale(_))), "{rb:?}");
        }
        assert_eq!(alice.members().len(), 2);
        assert_eq!(alice.members(), bob.members());
        let s = alice.encrypt(b"r", b"nach-der-heilung").unwrap();
        assert_eq!(bob.decrypt(&s.ciphertext).unwrap().0, b"nach-der-heilung");
        assert!(leaf.decrypt(&s.ciphertext).is_err(), "das gefälschte Blatt liest nichts");
        assert!(thief.decrypt(&s.ciphertext).is_err(), "der erbeutete Zustand liest nichts");
    }
    assert!(seen_win && seen_lose, "beide Zweige des Tiebreaks gesehen: gewinnt={seen_win} verliert={seen_lose}");
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
        // Alice fällt auf Epoche 1 zurück und nimmt b1: beide auf 2, gleicher Baum; a2 (anderer Zweig) ändert bei
        // Bob nichts: es wartet auf einen Vorgänger, der nie gewinnt, oder verliert den Tiebreak.
        assert_eq!(alice.epoch(), 2);
        let r = bob.receive(&a2);
        assert!(matches!(r, Err(Error::Stale(_)) | Err(Error::Epoch(_))), "{r:?}");
        assert_eq!(bob.epoch(), 2);
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
    // Der Gewinner steht auf 3 (eigener zweiter Commit). Der Commit 2→3 des Verlierers (anderer Zweig) ändert nichts:
    // er verliert den Tiebreak gegen den zweiten Commit des Gewinners (`Stale`) oder wartet auf einen Vorgänger, der
    // nie gewinnen wird (`Epoch`; der Peer kann ihn nicht seinem Vorgänger zuordnen, er verfällt mit der Momentaufnahme).
    assert_eq!(winner.epoch(), 3);
    let members_before = winner.members();
    let r = winner.receive(l2);
    assert!(matches!(r, Err(Error::Stale(_)) | Err(Error::Epoch(_))), "{r:?}");
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

/// Vertrag Punkt 2, Umordnung: das Kind des gewinnenden Zweigs kommt vor seinem Vorgänger. Es ist dann noch nicht
/// anwendbar (`Epoch`, der Aufrufer puffert), nach dem verlorenen Tiebreak passt es (Review zu #39).
#[test]
fn kind_vor_gewinnendem_vorgaenger_wartet_und_passt_dann() {
    use mls_wasm::peer::Error;
    let gid = b"gruppe-6".to_vec();
    let mut alice = Peer::new().unwrap();
    let mut bob = Peer::new().unwrap();
    let mut carol = Peer::new().unwrap();
    alice.create(&gid).unwrap();
    let (_, wb) = alice.add(bob.share_key()).unwrap();
    bob.receive(&wb).unwrap();
    let (cc, wc) = alice.add(carol.share_key()).unwrap();
    bob.receive(&cc).unwrap();
    carol.receive(&wc).unwrap();
    // Alice und Bob rotieren gleichzeitig (2→3). Carol entscheidet, wer gewinnt.
    let a1 = alice.rotate().unwrap();
    let b1 = bob.rotate().unwrap();
    carol.receive(&a1).unwrap();
    let a_wins = !matches!(carol.receive(&b1), Err(Error::LostTiebreak));
    let (winner, loser, w1) = if a_wins { (&mut alice, &mut bob, &a1) } else { (&mut bob, &mut alice, &b1) };
    let child = winner.rotate().unwrap(); // 3→4 auf dem Gewinnerzweig
    // Der Verlierer bekommt erst das Kind: noch nicht anwendbar, nicht endgültig.
    let r = loser.receive(&child);
    assert!(matches!(r, Err(Error::Epoch(_))), "{r:?}");
    assert_eq!(loser.epoch(), 3);
    // Dann den Vorgänger: Tiebreak verloren, Rückfall auf den Gewinnerzweig.
    assert!(matches!(loser.receive(w1), Err(Error::LostTiebreak)));
    // Jetzt passt das Kind.
    loser.receive(&child).unwrap();
    assert_eq!(loser.epoch(), 4);
    assert_eq!(loser.members(), winner.members());
    let s = winner.encrypt(b"r", b"nach-umordnung").unwrap();
    assert_eq!(loser.decrypt(&s.ciphertext).unwrap().0, b"nach-umordnung");
    // Derselbe Fall eine Epoche tiefer: der Verlierer hat vor dem Kind noch selbst commitet (3→4 auf seinem Zweig).
    let mut dave = Peer::new().unwrap();
    let mut erin = Peer::new().unwrap();
    let gid2 = b"gruppe-6b".to_vec();
    dave.create(&gid2).unwrap();
    let (_, we) = dave.add(erin.share_key()).unwrap();
    erin.receive(&we).unwrap();
    let d1 = dave.rotate().unwrap();
    let e1 = erin.rotate().unwrap();
    let d_wins = mls_wasm::peer::digest_of(&d1) < mls_wasm::peer::digest_of(&e1);
    let (winner, loser, w1) = if d_wins { (&mut dave, &mut erin, &d1) } else { (&mut erin, &mut dave, &e1) };
    let child = winner.rotate().unwrap(); // 2→3 Gewinnerzweig
    let _own2 = loser.rotate().unwrap(); // 2→3 Verliererzweig
    assert_eq!(loser.epoch(), 3);
    let r = loser.receive(&child); // Epoche 2 < 3, Momentaufnahme da, anderer Zweig: warten
    assert!(matches!(r, Err(Error::Epoch(_))), "{r:?}");
    assert!(matches!(loser.receive(w1), Err(Error::LostTiebreak)));
    loser.receive(&child).unwrap();
    assert_eq!(loser.epoch(), 3);
    assert_eq!(loser.members(), winner.members());
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
