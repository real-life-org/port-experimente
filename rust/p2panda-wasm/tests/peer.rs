// Nativer Rauchtest der Hülle: gründen, aufnehmen, tauschen, entfernen.
use p2panda_core::Hash;
use p2panda_wasm::peer::Peer;

async fn deliver(to: &mut Peer, msgs: &[Vec<u8>]) -> Vec<Vec<u8>> {
    let mut app = vec![];
    for m in msgs {
        let r = to.receive(m).await.unwrap();
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        app.extend(r.application);
    }
    app
}

#[tokio::test]
async fn gruenden_aufnehmen_tauschen_entfernen() {
    let mut alice = Peer::new().unwrap();
    let mut bob = Peer::new().unwrap();
    let mut carol = Peer::new().unwrap();
    // Key-Bundles tauschen.
    let kb = [alice.key_bundle().await.unwrap(), bob.key_bundle().await.unwrap(), carol.key_bundle().await.unwrap()];
    for p in [&mut alice, &mut bob, &mut carol] {
        deliver(p, &kb).await;
    }
    let space = Hash::digest(b"pruefstand");
    let mut log = alice.create_space(space).await.unwrap();
    log.extend(alice.add(space, bob.id(), "write").await.unwrap());
    log.extend(alice.add(space, carol.id(), "write").await.unwrap());
    deliver(&mut bob, &log).await;
    deliver(&mut carol, &log).await;

    let hallo = bob.publish(space, b"hallo").await.unwrap();
    assert_eq!(deliver(&mut alice, &[hallo.clone()]).await, vec![b"hallo".to_vec()]);
    assert_eq!(deliver(&mut carol, &[hallo]).await, vec![b"hallo".to_vec()]);

    // Carol entfernen; danach liest sie nichts Neues.
    let rm = alice.remove(space, carol.id()).await.unwrap();
    deliver(&mut bob, &rm).await;
    deliver(&mut carol, &rm).await;
    let neu = bob.publish(space, b"nach-entfernen").await.unwrap();
    assert_eq!(deliver(&mut alice, &[neu.clone()]).await, vec![b"nach-entfernen".to_vec()]);
    let r = carol.receive(&neu).await.unwrap();
    assert!(r.application.is_empty(), "Carol liest nach Entfernung: {:?}", r.application);
}

/// S4b nativ: zwei Admins entfernen gleichzeitig verschiedene Personen.
///
/// BEFUND (p2panda-spaces 0.7.1, 03.10.2026): Nach dem Zusammenführen
/// verschlüsselt die Gruppe weiter mit einem Geheimnis, das einer der beiden
/// Entfernten kennt (jeder Admin hat bei seiner Entfernung ein neues Geheimnis
/// an die Mitglieder aus SEINER Sicht verteilt, also inklusive der Person, die
/// der andere gleichzeitig entfernt). Eine Reparatur verlangt p2panda nicht.
/// Aufnehmen heilt das nicht (kein neues Geheimnis); erst die nächste Entfernung.
/// Dieser Test hält das Verhalten fest und schlägt an, sobald es sich ändert.
#[tokio::test]
async fn befund_gleichzeitige_entfernungen_einer_liest_mit() {
    let mut alice = Peer::new().unwrap();
    let mut bob = Peer::new().unwrap();
    let mut carol = Peer::new().unwrap();
    let mut dave = Peer::new().unwrap();
    let mut eve = Peer::new().unwrap();
    let kb = [
        alice.key_bundle().await.unwrap(),
        bob.key_bundle().await.unwrap(),
        carol.key_bundle().await.unwrap(),
        dave.key_bundle().await.unwrap(),
        eve.key_bundle().await.unwrap(),
    ];
    for p in [&mut alice, &mut bob, &mut carol, &mut dave, &mut eve] {
        deliver(p, &kb).await;
    }
    let space = Hash::digest(b"s4b");
    let mut log = alice.create_space(space).await.unwrap();
    log.extend(alice.add(space, bob.id(), "manage").await.unwrap());
    log.extend(alice.add(space, carol.id(), "write").await.unwrap());
    log.extend(alice.add(space, dave.id(), "write").await.unwrap());
    for p in [&mut bob, &mut carol, &mut dave] {
        deliver(p, &log).await;
    }
    // Partition: {alice, carol} | {bob, dave}
    let rm_carol = alice.remove(space, carol.id()).await.unwrap();
    let rm_dave = bob.remove(space, dave.id()).await.unwrap();
    deliver(&mut carol, &rm_carol).await;
    deliver(&mut dave, &rm_dave).await;
    // Zusammenführen
    deliver(&mut alice, &rm_dave).await;
    deliver(&mut carol, &rm_dave).await;
    deliver(&mut bob, &rm_carol).await;
    deliver(&mut dave, &rm_carol).await;
    let members: Vec<_> = alice.members(space).await.unwrap().into_iter().map(|(id, _)| id).collect();
    assert_eq!(members.len(), 2, "Alice sieht {members:?}");
    for p in [&mut alice, &mut bob] {
        assert_eq!(p.repair().await.unwrap().0, 0, "Reparatur verlangt");
    }

    let reads = |r: &p2panda_wasm::peer::Processed| !r.application.is_empty();
    let mut mitleser = 0;
    for (wer, sender) in [("alice", &mut alice), ("bob", &mut bob)] {
        let m = sender.publish(space, wer.as_bytes()).await.unwrap();
        let c = carol.receive(&m).await.unwrap();
        let d = dave.receive(&m).await.unwrap();
        println!("{wer} schreibt: carol liest {}, dave liest {}", reads(&c), reads(&d));
        mitleser += reads(&c) as u32 + reads(&d) as u32;
    }
    assert!(mitleser > 0, "Befund behoben? Keiner der Entfernten liest mehr mit");

    // Aufnehmen erzeugt im Data Scheme kein neues Geheimnis: Dave liest weiter.
    let add_eve = alice.add(space, eve.id(), "write").await.unwrap();
    for p in [&mut bob, &mut carol, &mut dave, &mut eve] {
        deliver(p, &log).await;
        deliver(p, &rm_carol).await;
        deliver(p, &rm_dave).await;
        deliver(p, &add_eve).await;
    }
    let m = alice.publish(space, b"nach-aufnahme").await.unwrap();
    let c = carol.receive(&m).await.unwrap();
    let d = dave.receive(&m).await.unwrap();
    println!("nach Aufnahme von Eve: carol liest {}, dave liest {}", reads(&c), reads(&d));
    assert!(reads(&c) || reads(&d), "Aufnahme heilt bereits");

    // Erst die nächste Entfernung erzeugt ein Geheimnis ohne die Entfernten.
    let rm_eve = alice.remove(space, eve.id()).await.unwrap();
    for p in [&mut bob, &mut carol, &mut dave, &mut eve] {
        deliver(p, &rm_eve).await;
    }
    let m = alice.publish(space, b"nach-entfernung").await.unwrap();
    let c = carol.receive(&m).await.unwrap();
    let d = dave.receive(&m).await.unwrap();
    println!("nach Entfernung von Eve: carol liest {}, dave liest {}", reads(&c), reads(&d));
    assert!(!reads(&c) && !reads(&d), "auch nach der nächsten Entfernung liest ein Entfernter mit");
}

/// Wiederaufnahme nach Entfernung (nativ). Vergleich zum Lauf in WebAssembly.
#[tokio::test]
async fn wiederaufnahme_nach_entfernung() {
    let mut a = Peer::new().unwrap();
    let mut b = Peer::new().unwrap();
    let mut c = Peer::new().unwrap();
    let kb = [a.key_bundle().await.unwrap(), b.key_bundle().await.unwrap(), c.key_bundle().await.unwrap()];
    for p in [&mut a, &mut b, &mut c] {
        deliver(p, &kb).await;
    }
    let space = Hash::digest(b"readd");
    let mut log = a.create_space(space).await.unwrap();
    log.extend(a.add(space, b.id(), "write").await.unwrap());
    log.extend(a.add(space, c.id(), "write").await.unwrap());
    deliver(&mut b, &log).await;
    deliver(&mut c, &log).await;
    for runde in 0..3 {
        let rm = a.remove(space, b.id()).await.unwrap();
        deliver(&mut b, &rm).await;
        deliver(&mut c, &rm).await;
        let add = a.add(space, b.id(), "write").await.unwrap();
        for m in &add {
            for (n, p) in [("b", &mut b), ("c", &mut c)] {
                let r = p.receive(m).await;
                assert!(r.is_ok(), "Runde {runde}, {n}: {:?}", r.err());
                assert!(r.unwrap().errors.is_empty(), "Runde {runde}, {n}: Verarbeitungsfehler");
            }
        }
    }
    let m = a.publish(space, b"wieder-da").await.unwrap();
    assert_eq!(deliver(&mut b, &[m]).await, vec![b"wieder-da".to_vec()]);
}

/// BEFUND (p2panda-spaces 0.7.1, 03.10.2026): Die Willkommensnachricht an ein
/// neues Mitglied trägt alle bisherigen Gruppengeheimnisse (für die Historie).
/// Jede Entfernung fügt eines hinzu. p2panda-core dekodiert Header aber nur mit
/// Byte-Folgen bis 512 Bytes (operation/any.rs: length_limit(512)). Nach einigen
/// Entfernungen kann die Gruppe deshalb niemanden mehr aufnehmen: Die
/// Empfänger lehnen die eigene Aufnahme-Nachricht ab.
/// Der Test sucht die erste Zahl von Entfernungen, ab der eine Aufnahme scheitert.
#[tokio::test]
async fn befund_aufnahme_scheitert_nach_mehreren_entfernungen() {
    let mut erste_fehlschlag = None;
    for entfernungen in 0..10usize {
        let mut a = Peer::new().unwrap();
        let mut others: Vec<Peer> = (0..entfernungen).map(|_| Peer::new().unwrap()).collect();
        let mut neu = Peer::new().unwrap();
        let mut kb = vec![a.key_bundle().await.unwrap(), neu.key_bundle().await.unwrap()];
        for o in &mut others {
            kb.push(o.key_bundle().await.unwrap());
        }
        deliver(&mut a, &kb).await;
        deliver(&mut neu, &kb).await;
        let space = Hash::digest(b"wachstum");
        let mut log = a.create_space(space).await.unwrap();
        for o in &others {
            log.extend(a.add(space, o.id(), "write").await.unwrap());
        }
        for o in &others {
            log.extend(a.remove(space, o.id()).await.unwrap());
        }
        log.extend(a.add(space, neu.id(), "write").await.unwrap());
        let mut fehler = None;
        for m in &log {
            if let Err(e) = neu.receive(m).await {
                fehler = Some((m.len(), e.0));
                break;
            }
        }
        let groesste = log.iter().map(|m| m.len()).max().unwrap();
        println!("{entfernungen} Entfernungen: größte Nachricht {groesste} B, Aufnahme {}", match &fehler {
            None => "ok".to_string(),
            Some((len, e)) => format!("scheitert ({len} B): {e}"),
        });
        if fehler.is_some() && erste_fehlschlag.is_none() {
            erste_fehlschlag = Some(entfernungen);
        }
    }
    assert!(erste_fehlschlag.is_some(), "Befund behoben? Aufnahme klappt nach jeder Zahl von Entfernungen");
}
